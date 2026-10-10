#!/usr/bin/env bash
set -euo pipefail

workflow="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/workflows/build.yml"

if grep -nE 'IRIS_SIGNING|CSC_KEY_PASSWORD|codesign|signtool|certificate root|Restore signing certificate|Verify signing identity|Verify signed installers|Trust signing root' "$workflow"; then
  echo 'workflow must not restore, configure, or verify installer code signing' >&2
  exit 1
fi

ruby -r yaml -e '
  workflow = YAML.load_file(ARGV.fetch(0))
  jobs = workflow.fetch("jobs")
  steps = jobs.fetch("shell-build").fetch("steps")
  installer = steps.find { |step| step["name"] == "Build installer" }
  raise "missing installer build" unless installer
  raise "installer build configures code signing" if installer.fetch("env").keys.any? { |key| key.start_with?("IRIS_SIGNING") || key.start_with?("CSC_") }
  raise "signing-only step remains" if steps.any? { |step| step["name"].to_s.match?(/signing|sign root/i) }

  raise "build workflow must not publish a shell release" if jobs.key?("shell-release")

  macos = jobs.fetch("shell-build-macos")
  raise "macOS build must require shell-check and shell-build" unless macos.fetch("needs") == ["shell-check", "shell-build"]
  macos_installer = macos.fetch("steps").find { |step| step["name"] == "Build installer" }
  raise "missing macOS installer build" unless macos_installer
  raise "macOS installer build configures code signing" if macos_installer.fetch("env").keys.any? { |key| key.start_with?("IRIS_SIGNING") || key.start_with?("CSC_") }
' "$workflow"

echo 'installer builds hold no signing material'
