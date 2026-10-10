#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ruby -r yaml -e '
  build_path, publish_path = ARGV
  build_text = File.read(build_path)
  publish_text = File.read(publish_path)
  build = YAML.load(build_text)
  publish = YAML.load(publish_text)

  allowed = {
    "actions/checkout" => "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    "actions/setup-node" => "a0853c24544627f65ddf259abe73b1d18a591444",
    "actions/upload-artifact" => "ea165f8d65b6e75b540449e92b4886f43607fa02",
    "actions/download-artifact" => "d3f86a106a0bac45b974a628896c90dbdf5c8093",
  }

  [build_text, publish_text].each do |text|
    text.scan(/^\s*(?:-\s*)?uses:\s*(\S+)/).flatten.each do |ref|
      name, sha = ref.split("@", 2)
      raise "action is not pinned by a known sha: #{ref}" unless allowed[name] == sha
    end
  end

  def steps(job)
    job.fetch("steps")
  end

  def named(job, name)
    steps(job).find { |step| step["name"] == name } || raise("missing step: #{name}")
  end

  def position(job, name)
    steps(job).index { |step| step["name"] == name } || raise("missing step: #{name}")
  end

  jobs = build.fetch("jobs")
  macos = jobs.fetch("shell-build-macos")

  jobs.each do |name, job|
    next if name == "core"
    dump = job.to_yaml
    %w[publish-shell-assets upload-payload tag-build-commit].each { |token| raise "#{name} must not run #{token}" if dump.include?(token) }
    raise "#{name} must not mirror a release" if dump.include?("gh release")
    raise "#{name} must not delete artifacts" if dump.include?("actions/artifacts")
  end

  jobs.each do |name, job|
    steps(job).each do |step|
      next unless step.to_yaml.include?("SIGNING_API_KEY")
      raise "SIGNING_API_KEY leaks into #{name}" unless name == "shell-build-macos" && ["Submit arm64 for signing", "Submit x64 for signing"].include?(step["name"])
    end
  end
  raise "both submit steps must carry the signing key" unless ["Submit arm64 for signing", "Submit x64 for signing"].all? { |n| named(macos, n).fetch("env").key?("SIGNING_API_KEY") }

  uploads = steps(macos).select { |step| step["uses"].to_s.start_with?("actions/upload-artifact@") }
  context = uploads.select { |step| step.dig("with", "name") == "shell-release-context" }
  raise "exactly one context upload is required" unless context.length == 1
  raise "context retention must be 3 days" unless context.first.dig("with", "retention-days") == 3
  raise "shell-build-macos must upload nothing but the release context" unless uploads.length == 1
  raise "shell-build-macos must not stage installers" if macos.to_yaml.include?("stage-installers")

  seal_steps = {
    "shell-check" => ["Validate inputs and secrets"],
    "shell-build-macos" => ["Record shell release context"],
  }
  jobs.each do |name, job|
    steps(job).each do |step|
      next unless step.to_yaml.include?("IRIS_CONTEXT_SEAL_KEY")
      raise "IRIS_CONTEXT_SEAL_KEY leaks into #{name}/#{step["name"]}" unless (seal_steps[name] || []).include?(step["name"])
    end
  end

  core = jobs.fetch("core")
  raise "core must read actions" unless core.fetch("permissions") == { "actions" => "read", "contents" => "write" }
  core_gate = named(core, "Wait for the pending shell release to publish")
  raise "core gate must run the release tools" unless core_gate.fetch("run") == "node .release-tools/scripts/publish-shell.mjs gate"
  raise "core release tools must pin the workflow commit" unless named(core, "Checkout release tools").dig("with", "ref") == "${{ github.sha }}"
  raise "core gate needs the release tools and Node first" unless position(core, "Checkout release tools") < position(core, "Wait for the pending shell release to publish") && position(core, "Setup Node.js") < position(core, "Wait for the pending shell release to publish")
  raise "core gate must precede every private checkout and version reservation" unless position(core, "Wait for the pending shell release to publish") < position(core, "Checkout exact private source") && position(core, "Wait for the pending shell release to publish") < position(core, "Reserve core version")

  payload = steps(jobs.fetch("shell-check")).select { |step| step.dig("with", "name") == "core-payload" }
  raise "core-payload must be kept for one day" unless payload.length == 1 && payload.first.dig("with", "retention-days") == 1

  shell_check = jobs.fetch("shell-check")
  raise "shell-check must read actions" unless shell_check.fetch("permissions") == { "actions" => "read", "contents" => "read" }
  gate = named(shell_check, "Wait for the previous shell release to publish")
  raise "gate must run the release tools" unless gate.fetch("run") == "node .release-tools/scripts/publish-shell.mjs gate"
  raise "release tools must be checked out before the gate" unless position(shell_check, "Checkout release tools") < position(shell_check, "Wait for the previous shell release to publish")
  raise "gate must precede version resolution" unless position(shell_check, "Wait for the previous shell release to publish") < position(shell_check, "Prepare release and core payload")

  triggers = publish.fetch(true) { publish.fetch("on") }
  raise "unexpected triggers" unless triggers.keys.sort == %w[workflow_dispatch workflow_run]
  raise "workflow_run must follow Build IRIS completion" unless triggers.fetch("workflow_run") == { "workflows" => ["Build IRIS"], "types" => ["completed"] }
  raise "top-level permissions must be empty" unless publish.fetch("permissions") == {}
  raise "publish workflow must not cancel pending work at the workflow level" if publish.key?("concurrency")

  pjobs = publish.fetch("jobs")
  expected_permissions = {
    "resolve" => { "actions" => "read", "contents" => "read" },
    "await-signing" => { "contents" => "read" },
    "verify-macos" => { "contents" => "read" },
    "publish" => { "actions" => "write", "contents" => "write" },
  }
  raise "unexpected job set" unless pjobs.keys.sort == expected_permissions.keys.sort
  expected_permissions.each { |name, perms| raise "permissions of #{name} deviate" unless pjobs.fetch(name).fetch("permissions") == perms }
  pjobs.each { |name, job| raise "#{name} must start by rejecting reruns" unless steps(job).first["name"] == "Reject workflow reruns" }
  q = "\x27"
  resolve_if = pjobs.fetch("resolve").fetch("if")
  raise "manual publish must come from the default branch" unless resolve_if.include?("github.event_name == #{q}workflow_dispatch#{q} && github.ref == format(#{q}refs/heads/{0}#{q}, github.event.repository.default_branch)")
  ["await-signing", "publish"].each do |name|
    hold = pjobs.fetch(name).fetch("if")
    raise "#{name} must honour the publish hold" unless hold.include?("vars.IRIS_SHELL_PUBLISH_HOLD != #{q}true#{q}") && hold.include?("inputs.release_held")
  end
  seal_publish = pjobs.each_with_object([]) { |(name, job), found| steps(job).each { |step| found << "#{name}/#{step["name"]}" if step.to_yaml.include?("IRIS_CONTEXT_SEAL_KEY") } }
  raise "seal key placement deviates" unless seal_publish.sort == ["publish/Read release context", "publish/Validate secrets"]
  signed_upload = steps(pjobs.fetch("verify-macos")).select { |step| step.dig("with", "name") == "signed-macos" }
  raise "signed images must be kept for one day" unless signed_upload.length == 1 && signed_upload.first.dig("with", "retention-days") == 1
  raise "publish needs" unless pjobs.fetch("publish").fetch("needs") == %w[resolve verify-macos]
  raise "verify-macos runner" unless pjobs.fetch("verify-macos").fetch("runs-on") == "macos-15"
  raise "publish concurrency" unless pjobs.fetch("publish").fetch("concurrency") == { "group" => "iris-publish-shell", "cancel-in-progress" => false }

  order = ["Read release context", "Assemble release", "Check what is already published", "Publish to license service", "Tag published shell and core source", "Mirror GitHub Release", "Delete transient build artifacts"]
  positions = order.map { |name| position(pjobs.fetch("publish"), name) }
  raise "publish steps out of order" unless positions == positions.sort

  [build_text, publish_text].each do |text|
    text.scan(/scripts\/(?:publish-shell|submit-macos)\.mjs/) { raise "release scripts must run from the clean tools checkout" unless Regexp.last_match.pre_match.end_with?(".release-tools/") }
  end
  raise "release tools checkout must pin the workflow commit" unless named(shell_check, "Checkout release tools").dig("with", "ref") == "${{ github.sha }}"
' "$root/.github/workflows/build.yml" "$root/.github/workflows/publish-shell.yml"

echo 'shell signing workflow contracts are satisfied'
