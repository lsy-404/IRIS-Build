#!/usr/bin/env bash
set -euo pipefail

workflow="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/workflows/build.yml"

ruby -r yaml -e '
  workflow = YAML.load_file(ARGV.fetch(0))
  jobs = workflow.fetch("jobs")
  text = File.read(ARGV.fetch(0))

  retired = %w[IRIS_PRO_PACKAGE pro:pack upload-pro-package.mjs build/pro-packages artifact.irp]
  found = retired.select { |token| text.include?(token) }
  raise "retired PRO dependency remains: #{found.join(", ")}" unless found.empty?

  def steps(job)
    job.fetch("steps")
  end

  def index_of(entries, name)
    index = entries.index { |entry| entry["name"] == name }
    raise "missing step: #{name}" unless index
    index
  end

  required_common = %w[IRIS_BUILD_DEPLOY_KEY IRIS_TAG_DEPLOY_KEY IRIS_RELEASE_UPLOAD_TOKEN]
  core = jobs.fetch("core")
  shell_check = jobs.fetch("shell-check")
  [[core, required_common], [shell_check, required_common + ["IRIS_RELEASE_KEY_TRANSFER_KEY"]]].each do |job, required|
    validation = steps(job).find { |step| step["name"] == "Validate inputs and secrets" }
    raise "missing release input validation" unless validation
    env = validation.fetch("env")
    required.each do |key|
      raise "missing validation secret #{key}" unless env[key] == "${{ secrets.#{key} }}"
      raise "validation does not require #{key}" unless validation.fetch("run").include?(key)
    end
  end

  [core, shell_check].each do |job|
    entries = steps(job)
    static = index_of(entries, "Run release static contract check")
    behavior = index_of(entries, "Run release behavior gate")
    raise "static contract check must run before behavior gate" unless static < behavior
    raise "static suite is not executed" unless entries.fetch(static).fetch("run").include?("pnpm run test:release-static")
    raise "behavior suite is not executed" unless entries.fetch(behavior).fetch("run").include?("pnpm run test:release-behavior")
  end

  shell_check_steps = steps(shell_check)
  fingerprint = shell_check_steps.find { |step| step["name"] == "Prepare release and core payload" }
  raise "shell fingerprint generation is missing" unless fingerprint.fetch("run").include?("shell-fingerprint")
  raise "release key generation is missing" unless shell_check_steps.any? { |step| step["name"] == "Generate release key" }

  shell_build = jobs.fetch("shell-build")
  matrix = shell_build.fetch("strategy").fetch("matrix").fetch("include")
  raise "shell matrix must retain three platforms" unless matrix.map { |entry| entry.fetch("os") }.sort == %w[macos-latest ubuntu-latest windows-latest]
  installer = steps(shell_build).find { |step| step["name"] == "Build installer" }
  raise "shell installer build is missing" unless installer
  raise "installer must decrypt release key" unless installer.fetch("run").include?("decrypt-key")

  [[core, "Generate core release key"], [shell_check, "Generate release key"]].each do |job, next_step|
    entries = steps(job)
    pack = entries.find { |step| step["run"].to_s.include?("pack-payload") }
    raise "payload packing is missing" unless pack
    raise "release key step must precede payload packing" unless index_of(entries, next_step) < entries.index(pack)
  end

  raise "core release tag is missing" unless steps(core).any? { |step| step["name"] == "Tag published core source" && step.fetch("run").include?("tag-build-commit.sh") }
  shell_release = jobs.fetch("shell-release")
  raise "shell release must require shell-check and shell-build" unless shell_release.fetch("needs") == ["shell-check", "shell-build"]
  release_run = steps(shell_release).find { |step| step["name"] == "Mirror GitHub Release" }.fetch("run")
  raise "release must verify immutable asset state" unless release_run.include?("state != \"uploaded\"")

  [core, shell_check, shell_build, shell_release].each do |job|
    raise "secrets cleanup is missing" unless steps(job).any? { |step| step["name"].to_s.start_with?("Wipe") && step.fetch("run", "").include?("rm -rf") }
  end
  puts "retired PRO dependencies are absent and release gates remain protected"
' "$workflow"
