# Progress

- 已从 `origin/main` 的 `253a936` 创建隔离 worktree `codex/windows-signing`。
- 已读取全局 Agent Mode 与 IRIS-Build 项目索引、macOS 签名发布设计记录。
- 已检查现有 build/publish 工作流、提交工具、release context 校验和签名中心 Windows schema。

- build.yml 新增 `shell-build-windows`，构建 Electron unpacked app，提交 source.zip（`app/` 与 `source.json`），保留由锁定依赖安装出的 app-builder Windows binary 供签名后重建 blockmap。
- 密封发布上下文现在严格绑定三份签名请求；发布 pipeline 加入 Windows status/download/report 校验、Windows 原生 Authenticode/timestamp/subject 校验，以及签名后 installer SHA-512、latest.yml 和 blockmap 生成。
- 更新两个既有发布 fixture 与静态 workflow 检查，没有增加测试用例。`node --test test/submit-macos.test.mjs test/publish-shell.test.mjs` 通过 76/76；`actionlint`、两个既有 workflow shell checks、Node 语法检查与 `git diff --check` 通过。
- 已提交聚焦实现，提交信息为 `Add Windows signing handoff to shell release`。
