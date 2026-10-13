# Self-hosted core builds

## Scope and rationale

- Move the existing core build and Linux x64 notification-reader job to the common IONOS runner pool. Keep native Windows, macOS, and ARM64 builds on their existing matching hosts.
- Preserve release inputs, gates, artifact contracts, and publication behavior. Do not add workflows or test cases to IRIS source.
- Adapt tools and cleanup for the persistent unprivileged container. Verify real compilation on the host without reserving or publishing a new production release solely for runner acceptance.

## Plan

- [x] Fetch remote defaults, inspect existing worktrees, and prepare an isolated task checkout.
- [x] Inspect core dependencies and the current runner's installed tools.
- [x] Add the missing build prerequisites and update the two job targets and persistent-workspace cleanup.
- [x] Validate the workflow with actionlint and inspect the focused diff.
- [x] Build and deploy the updated image while the runner is idle.
- [x] Execute existing core build checks and Linux native compilation against an exact source commit in the isolated container.
- [ ] Fetch again, inspect branch protection/rulesets, integrate the focused changes, and push.

## Findings

- IRIS-Build base is a49bc392d1f6dbdc68477b42a6be0504513e8bef. Its only self-hosted job is ci.yml verify; build.yml core is still ubuntu-latest.
- The native matrix has separate Linux x64 and ARM64 entries. The IONOS host is x64, so only the matching x64 entry moves to the pool.
- The runner has curl and GCC, but no gh, rustup, cargo, or musl-gcc. Core publication uses gh; native compilation needs a Rust toolchain and musl-tools.
- Core pnpm setup currently installs globally into protected system directories. It must use a per-job temporary prefix, as the existing self-hosted test job already does.
- Current core cleanup removes only selected directories; a persistent runner also needs the full source workspace removed before and after execution.
- IRIS source remote main is 784cd98de2439d8bcfd2afbf2ff44e125699e05f at the initial inspection. Source remains untouched.

## Progress

- Loaded the existing agent-mode instructions and applied the user override for a single audit file.
- Fetched both remotes, inspected worktrees, and created /Users/user/.codex/worktrees/IRIS-Build/self-hosted-core on codex/self-hosted-core.
- Queried the active runner's executable inventory without reading secrets. Inspected the exact-source checkout, release steps, and native build entry point.
- Read the pinned Rust action source and confirmed it bootstraps rustup when absent. Replaced the implicit hosted-only rustup assumption with this maintained action while retaining stable and the existing target selection.
- An attempted read of release helpers from IRIS-Build found they do not exist there -> inspected them from the exact IRIS source instead, matching the workflow's source-script copy step.
- Added gh and musl-tools to the common image; switched only core and native Linux x64 to self-hosted labels. Added full workspace cleanup and per-job pnpm installation.
- actionlint and git diff --check passed. No tests were added. The live runner is idle, and its UID/GID are both 1001 -> corrected the touched registration documentation's group value.
- Built ci-runner:2.338.0 with image ID 370462bffe69d7aa1f21cbbc3b54e70c174ab4707039e9597aa431f40b2c6849. Added prerequisites only inside the isolated image.
- Confirmed the GitHub runner was online and idle, paused its listener, and started a temporary acceptance container using the same Compose resource limits and repository volume. Native matching-host jobs and production services were not stopped.
- Archived exact source 784cd98de2439d8bcfd2afbf2ff44e125699e05f into a private acceptance directory, excluding local dirty files. Node 24.21.0, gh, and musl-gcc are available in the new image.
- Per-job pnpm setup, frozen dependency installation, Rust bootstrap, stable toolchain selection, and Linux musl target installation passed. Existing native protocol checks and real compilation are in progress; output is held in private local logs.
- Native protocol tests, the Linux x64 release binary build, digest verification, renderer typechecking, and core main compilation passed on the exact source snapshot.
- Acceptance container inspection confirms two CPUs, 4 GiB RAM, 16 GiB total RAM+swap, ci.slice membership, and no OOM events. Existing application services remain active.
- Core release behavior checks use concurrency 1, matching the pool's existing test convention and the actual acceptance command. Current remote main still equals the task base; main is unprotected and rulesets are empty.
- Renderer compilation, release static checks, and release behavior checks all passed. The acceptance command exited 0 and produced the compiled main entry, renderer HTML, and a 4,234,544-byte Linux x64 native binary. No production version reservation or publication command was invoked for this acceptance run.
- Cleared only the created acceptance source, temporary pnpm installation, and helper. Removed the temporary container and recreated the registered runner with the new image; its existing identity and isolated repository home were retained.
- GitHub reports ionos5-iris-ci online and idle; its log confirms Listening for Jobs. Private successful logs contain zero entries, no acceptance source remains, and gh/musl-gcc are present in the active container.
- All final OOM counters are zero. The common resource slice and existing application services are active. Other IRIS-Build worktrees are clean, with no inactive uncommitted files requiring recovery.
