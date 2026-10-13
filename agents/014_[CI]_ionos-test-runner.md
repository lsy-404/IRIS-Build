# IONOS test runner

## Scope and rationale

- Register one repository-scoped Linux runner for the existing IRIS CI job on IONOS #5 main or #4 Open after inspecting live capacity and services.
- Keep one Ubuntu test job and its existing checks. Build and publication jobs remain outside this change.
- Use an isolated runner environment with bounded resources and no access to production service credentials.
- Do not add test cases. Validate workflow syntax and execute the existing CI against an exact source commit on the deployed runner.
- The user expanded scope to a shared CI host for multiple projects, with a larger default workspace and swap allowance. Prepare common deployment defaults and separate repository registrations; keep the ongoing acceptance run intact.

## Plan

- [x] Inspect repository rules, remote main, worktrees, existing workflow, and runner inventory.
- [x] Inspect both authorized servers and select a host using current capacity and service evidence.
- [x] Install and register an isolated runner with resource limits and automatic startup.
- [x] Route the single CI job to the runner and adapt environment setup and cleanup for repeated jobs.
- [x] Validate workflow syntax, fetch remote changes, inspect protection and rulesets, integrate and push.
- [x] Dispatch the existing CI, verify the actual runner and all checks, and record final host/service state.
- [x] Reserve a larger shared CI workspace and increase the default swap allowance while preserving production headroom.
- [ ] Generalize the runner deployment for multiple repository registrations and connect the additional repositories selected by the user.

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
- GitHub owner lsy-404 is a personal User account. An organization-level registration cannot serve these personal repositories; share the host/image/resource budget using separate repository-scoped runner registrations.
- The host has an ext4 root filesystem with approximately 143 GiB free and an existing 16 GiB swap file. The initial container memory+swap limit equaled RAM and therefore disallowed swap; expanded scope requires increasing that limit.

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
- Git's global /agents ignore rule rejected initial staging -> explicitly staged only this task's audit and existing project/task index files with -f -> commit succeeded.
- Committed 207cd01, fetched again, confirmed no new remote base commits, and fast-forwarded the clean main worktree. Pushed main after confirming it is unprotected and has no rulesets.
- Manually dispatched ci.yml only with source SHA a3033ad60b147d6ae25a13f3cc1597496486299b. Acceptance run 38428337554 is in progress; GitHub reports the self-hosted runner online and busy.
- Actual execution passed dependency setup, typecheck/lint, and repository contracts. The full test process advanced into real flow tests. Memory OOM counters and container restart count remained zero; the container reclaimed cache at its 4 GiB limit.
- Queried organization runner endpoints before confirming account type -> HTTP 404 because lsy-404 is a personal account -> use per-repository registration on the common CI host.
- Asked which additional repositories should be connected first. Common disk/swap preparation can proceed independently of that selection.
- IRIS acceptance run 38428337554 succeeded on ionos5-iris-ci in 11m55s. Every step, including full tests, source cleanup, and checkout post-actions, passed.
- Raised the existing container's memory+swap limit live to 16 GiB (4 GiB RAM plus up to 12 GiB swap), reusing the host's existing swap file without affecting the completed test.
- Generalized Compose to per-repository names and bind-backed private volumes on a shared 100 GiB filesystem. Added a common ci.slice so additional registrations share the same total CPU/RAM/swap ceiling instead of multiplying production-host limits.
- Added a registration wrapper that consumes an hour-lived repository token through stdin and uses the common ci label. Each repository keeps its own runner credentials and cache directory.
- Verified completed-job cleanup: the source workspace contains zero entries and the temporary build tools/npm directory are absent. OOM counters remained zero, and existing application services remained active.
- Created and mounted the separate 100 GiB CI filesystem and enabled the shared ci.slice. Kernel values confirm the 4 GiB RAM, 12 GiB swap, and two-CPU aggregate caps.
- Stopped only the idle runner, copied its 2.4 GiB home/cache to the private directory on the CI filesystem, byte-compared its registration and credential files, and restarted it using the common deployment profile. GitHub reports the same runner ID online and idle.
- Initial mkfs discarded unused backing-file allocation -> preserve the actual 100 GiB reservation with a fresh fallocate and X-fstrim.notrim -> future setup uses mkfs -E nodiscard. Verified the notrim behavior from the installed util-linux manpage.
- The host does not have rg installed -> used grep for its local fstrim documentation. No packages were added to the production host for this probe.
- The post-migration runner is online; its private home is on the 98 GiB usable CI filesystem and its cgroup permits 4 GiB memory plus 12 GiB swap. Credential private-key permissions remain 600.
