# IONOS test runner

## Scope and rationale

- Register one repository-scoped Linux runner for the existing IRIS CI job on IONOS #5 main or #4 Open after inspecting live capacity and services.
- Keep one Ubuntu test job and its existing checks. Build and publication jobs remain outside this change.
- Use an isolated runner environment with bounded resources and no access to production service credentials.
- Do not add test cases. Validate workflow syntax and execute the existing CI against an exact source commit on the deployed runner.

## Plan

- [x] Inspect repository rules, remote main, worktrees, existing workflow, and runner inventory.
- [x] Inspect both authorized servers and select a host using current capacity and service evidence.
- [x] Install and register an isolated runner with resource limits and automatic startup.
- [x] Route the single CI job to the runner and adapt environment setup and cleanup for repeated jobs.
- [ ] Validate workflow syntax, fetch remote changes, inspect protection and rulesets, integrate and push.
- [ ] Dispatch the existing CI, verify the actual runner and all checks, and record final host/service state.

## Findings

- Initial base: IRIS-Build main c8bb2cc; IRIS source main 57f658d1a. No repository runner is registered.
- Current CI uses Node 24, pnpm 10.34.6, typecheck, lint, repository contracts, and full tests with DBus/Xvfb and concurrency 1.
- The private-source checkout uses a repository secret; runner credentials and checkout material must remain inside the isolated job environment.
- The first strict SSH attempt to #5 found no saved host key. #4 inspection is in progress. No server changes have been made.
- #5 is Ubuntu 24.04 x64 with four CPUs, 7.7 GiB RAM, 6.1 GiB available RAM, 148 GiB free root storage, and near-zero load. Existing application containers and system services are running.
- #4 SSH port 22 timed out. The 1Password SSH item confirms the configured address without an alternate port. Selected #5 using the verified available capacity.
- Use the official GitHub runner 2.338.0 Ubuntu Noble image, add only test prerequisites, persist the runner's own volume, and run with two CPUs, 4 GiB RAM/no additional swap, bounded processes and logs. No Docker socket, host network, ports, or production directories are exposed.
- Existing Linux Electron release tests already pass --no-sandbox; no source change is needed for container execution.
- Initial actionlint validation rejected the custom iris-ci label -> added the supported self-hosted-runner label configuration -> rerun syntax validation without suppressing checks.
- Runner ionos5-iris-ci (repository ID 21) is online, idle, and labeled self-hosted/Linux/X64/iris-ci. The runner operates as the container's unprivileged runner user.
- Docker inspection confirms two CPUs, 4 GiB memory and matching memory+swap limit, 512-process limit, no published ports, and one private named volume. Restart policy is unless-stopped; runner automatic updates remain enabled.
- No remote IRIS-Build commits were added after the task base. Main protection returns HTTP 404 and the ruleset list is empty. IRIS source advanced to a3033ad60; the acceptance run will use that exact current commit.

## Progress

- Loaded agent-mode v0.2.3 and the global/repository instructions. Used the user-requested single audit document under /agents.
- Fetched both repositories and inspected existing worktrees. The task worktree is /Users/user/.codex/worktrees/IRIS-Build/self-hosted-tests on codex/self-hosted-tests.
- Inspected the existing CI and GitHub permissions. Main has no branch protection; the initial ruleset listing is empty. Recheck before integration.
- Began read-only SSH inspection through the existing 1Password SSH agent.
- Connected to #5 using SSH trust-on-first-use for its previously unsaved host key. Confirmed resources, OS, Docker availability, and existing service state. Read only non-secret host metadata from the two authorized SSH items.
- Pulled the official runner 2.338.0 image and pinned its registry digest in runner/Dockerfile. Added the minimal Ubuntu test prerequisites and runner/compose.yml with bounded resources and private runner storage.
- Updated ci.yml to route only the existing verification job to iris-ci and clean the source workspace before and after each job. Corepack installs into the per-job temporary directory so Node/pnpm setup needs no host privilege.
- Copied only the public runner deployment files to /opt/iris-ci-runner on #5 and began building the image. Existing production services were not reconfigured.
- Image build and Docker Compose validation passed. Registered the runner with an hour-lived GitHub token passed through SSH standard input; no token was saved in local files or printed.
- Started the container with Docker Compose. GitHub reports online and the application reports Listening for Jobs.
- actionlint and git diff --check pass. The existing ci-quiet Node test file passes 3/3. No new tests were added.
