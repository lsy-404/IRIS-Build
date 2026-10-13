#!/usr/bin/env bash
set -euo pipefail

runner_env_file="${1:?Pass the repository environment file}"
docker compose --env-file "$runner_env_file" run --rm -T runner bash -ec '
  IFS= read -r registration_token
  ./config.sh --unattended --url "https://github.com/$RUNNER_REPOSITORY" --token "$registration_token" --name "$RUNNER_NAME" --labels ci --work _work
'
docker compose --env-file "$runner_env_file" up -d
