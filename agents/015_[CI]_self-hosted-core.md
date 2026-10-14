# Self-hosted core builds

## Scope and rationale

- Move the existing core build and Linux x64 notification-reader job to the common IONOS runner pool. Keep native Windows, macOS, and ARM64 builds on their existing matching hosts.
- Preserve release inputs, gates, artifact contracts, and publication behavior. Do not add workflows or test cases to IRIS source.
- Adapt tools and cleanup for the persistent unprivileged container. Verify real compilation on the host without reserving or publishing a new production release solely for runner acceptance.
- The user subsequently requested a complete production core workflow from latest main. Execute the existing release path, including its normal publication steps, and verify actual self-hosted execution rather than treating a skipped job as acceptance.

## Plan

- [x] Fetch remote defaults, inspect existing worktrees, and prepare an isolated task checkout.
- [x] Inspect core dependencies and the current runner's installed tools.
- [x] Add the missing build prerequisites and update the two job targets and persistent-workspace cleanup.
- [x] Validate the workflow with actionlint and inspect the focused diff.
- [x] Build and deploy the updated image while the runner is idle.
- [x] Execute existing core build checks and Linux native compilation against an exact source commit in the isolated container.
- [x] Fetch again, inspect branch protection/rulesets, integrate the focused changes, and push.
- [x] Dispatch the complete core workflow using current IRIS main and current IRIS-Build main.
- [ ] Resolve any workflow blocker within the authorized release path and confirm the core job actually runs on IONOS #5.
- [ ] Verify all required jobs and publication steps pass, inspect final cleanup, and record the live run.

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
- Committed f81be20, fetched again with no new remote-base changes, rechecked main protection and rulesets, and fast-forwarded the clean main checkout. Pushed the verified implementation to origin/main.
- Live acceptance begins from IRIS source main 784cd98de2439d8bcfd2afbf2ff44e125699e05f and IRIS-Build main a849e6e4f6583219d972f2b8a68e226ceea2aec5. The existing runner (ID 21) is online and idle. Unrelated IRIS .iris/mcp.json edits remain untouched.
- The supplied billing failure is IRIS model-data.yml run 38384327653, publish job 115252234604, with ubuntu-24.04 labels and no started steps. It is distinct from the independently dispatched IRIS-Build core workflow.
- A job annotations request returned 404 because annotations belong to its check run -> resolved the job's check_run_url for the correct read. No account billing settings were changed.
- Complete core run 38478472026 was dispatched at 22:32:24 UTC from a849e6e with source 784cd98de. It failed at startup with zero jobs. REST exposed no check runs -> inspected its public Actions summary -> GitHub rejected dtolnay/rust-toolchain under the repository's selected-actions policy (only owned/GitHub/actions/* repositories are allowed).
- Replaced the disallowed action with the official rustup bootstrap and the existing stable toolchain commands. Repository security policy stays intact; no additional workflows or test cases are introduced.
- actionlint and diff validation passed; committed and pushed 900f50d after a fresh fetch and protection/ruleset check.
- Unexpired shell-release-context artifact 11780521775 belongs to successful shell build 38323567839 and expires on October 16. The existing release gate deliberately blocks newer builds until that shell publishes; recent run 38469622008 is success with core skipped and therefore is not acceptance.
- No IRIS_SHELL_PUBLISH_HOLD variable is set. The previous shell publisher 38326199630 failed signing-readiness, so begin a fresh normal publisher dispatch for the required pending build, preserving its provenance and publication checks rather than bypassing the gate.
- Fresh shell publisher 38479360595 ran its hosted resolve/readiness jobs successfully but failed the signing check with SIGNING_FAILED arm64 execution_did_not_complete; macOS verification and publication were skipped.
- Retried full core workflow 38479632657 at 900f50d with source 784cd98de. Its release-gate passed, but core job 115578818428 and native jobs were skipped because of the pending shell. The overall success status does not mean core executed; runner_id is null for core.
- Correlated ARM64 signing request 45f3ca38-1a86-4839-ae0d-a18e6e13014e to signing-exec-public run 38325978085. Its Execute signing request step failed with disk image operation failed: stapling. The corresponding x64 request's final public execution 38326065902 succeeded. Neither signature diagnosis depended on the supplied private model-data billing failure.
- Inspected the signing coordinator without modifying it: the failed finalization is terminal and the existing automatic retry path only covers unclaimed dmg_sign execution. No normal replay/resume action was found for this failed finalization; did not weaken signing verification or alter its state.
- Preserved all eight unexpired GitHub artifacts for shell build 38323567839 in /srv/ci-runners/.archives/IRIS-Build/38323567839 on #5, with root-only access. Every archive matches its GitHub SHA-256 digest and passes ZIP CRC validation; manifest.json records the original identifiers and names. No original artifact has been deleted.
- Requested the user's choice between cancelling the obsolete 0.5.89 candidate and rebuilding latest main, or retaining it and repairing signing first. Candidate cancellation is pending explicit approval; full core workflow acceptance remains open.
- The user subsequently requested completion of the repair. The signing administrator console confirms the old ARM64 and x64 shell projects retain 0 bytes; failure cleanup is immediate and successful download retention is 24 hours, so this candidate cannot be resumed from its signing objects.
- Repaired the shared app/DMG executor with bounded transient ticket retries and numeric diagnostics; the center now retries credential-free finalization with fresh generations. Existing signature, notarization, Gatekeeper, source and credential checks remain required. Mainline 234 tests, production-policy 180 tests, 26 native/runner tests, type checks and deployment dry-runs passed.
- Published fixed executor tag runner-token-2026-10-14-1 and deployed focused Worker b591d6c8-ad76-4683-bcae-f2672f080b35 using the already-approved production policy; organization/tag signing remains outside the deployment.
- Rechecked all eight root-only archives and their manifest on #5. Removed only the obsolete GitHub shell-release-context artifact 11780521775; its 912-byte archive remains preserved with the other seven archives. No other GitHub artifact was deleted; the current listing retains the two installer artifacts while shorter-lived artifacts have already expired. This retires the irrecoverable candidate through the existing release gate rather than bypassing that gate.
- Current IRIS main is 1b7ad06967437653c47111755672def1041dcab0. Dispatched a new complete core workflow for that exact source on Build main 149af15; live acceptance is in progress.

## Result

- Core and Linux x64 notification-reader jobs now select the common self-hosted pool. Windows, macOS, and Linux ARM64 native jobs retain their matching hosted machines.
- Exact-source core compilation, renderer compilation, native protocol/build/digest checks, and existing release static/behavior checks all pass on IONOS #5 within the unchanged aggregate resource budget.
- The active runner uses the updated image, is online, and accepts jobs. Future production core workflows retain the existing release gates and publication steps.
- Live workflow acceptance is currently blocked by the failed old shell candidate. Full core run 38479632657 has core skipped, so actual GitHub core execution on #5 is not yet confirmed.
