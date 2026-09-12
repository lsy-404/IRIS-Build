# 操作日志

- 2026-09-11：确认 GitHub CLI 登录账号为 `lsy-404`。
- 2026-09-11：盘点账号 owner repositories 的 Actions artifact 与 cache。
- 2026-09-11：读取 `IRIS-Build/.github/workflows/build.yml`，确认四个临时 artifact 的保留期为 1 天。
- 2026-09-11：创建本地任务 checkout `/Users/user/.codex/worktrees/IRIS-Build/storage-cleanup`。
- 2026-09-11：确认 `latest` Release 已包含当前构建的成品资产，作为长期保留位置。
- 2026-09-11：在 `shell-release` 成功发布后增加 artifact 回收步骤，并授予该 job `actions: write` 权限。
- 2026-09-11：`git diff --check` 与 Ruby YAML 解析通过；本机未安装 `actionlint`。
