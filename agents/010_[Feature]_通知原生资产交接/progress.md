Fetched origin/main 08e241a; created fixed-location worktree codex/proactive-native-assets. Added native matrix, core needs and download/input handoff. actionlint accepted the workflow; existing Node tests passed.

Workflow actionlint passed after source SHA validation and one-day artifact retention. Existing Node tests: 87 passed. Native consumers receive the four same-run artifacts only after all producers succeed; publisher credentials and signing stages remain the existing ones.

Delivered main ba036e1a4ea4a310b36d9b37c27c8909d20723e5 and verified remote ref. The workflow only runs on the existing dispatch/manual inputs; this change did not dispatch it. Runtime platform construction and notification consent are not claimed as locally verified.

Repository selected-actions API confirmed GitHub-owned/actions/* only. Removed disallowed third-party toolchain action; existing runner rustup installs stable and Linux target. All remaining workflow uses are actions/*; actionlint and existing 87 Node tests passed. No action policy/credentials were changed. Actual next automatic build remains pending; failed runs are not rerun against old workflow.

Delivered policy-compatible workflow main ce0b7db4554b03d8be9a996199fbb7b04be3b114 and verified remote ref. The observed automatic runs still used workflow head 2c03a15 and failed before jobs; these do not validate the new workflow. Next normal source push must supply a new automatic build; no publication workflow was manually dispatched.
