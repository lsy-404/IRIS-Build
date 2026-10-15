# Progress

- 已从 `origin/main` 的 `253a936` 创建隔离 worktree `codex/windows-signing`。
- 新源 run 38811075767 的三份签名请求已全部通过；Windows run 38817656982 成功上传输出且完成清理，两个新 Mac 最终 DMG / App 的本机 Get-Sign 均为 PASS，版本 0.6.0。publisher 38818388989 通过 readiness 和 macOS 验证后，在 Windows 下载前因 INVALID_INPUT 停止：共享 signingInputs 合同要求完整三平台上下文，而该 job 漏传四个 Mac 请求字段。补齐已有 resolve 输出到该 job 环境，不改变签名报告校验；后续用同一已签名源新建发布运行，无需重签或重建来源。
- 已读取全局 Agent Mode 与 IRIS-Build 项目索引、macOS 签名发布设计记录。
- 已检查现有 build/publish 工作流、提交工具、release context 校验和签名中心 Windows schema。

- build.yml 新增 `shell-build-windows`，构建 Electron unpacked app，提交 source.zip（`app/` 与 `source.json`），保留由锁定依赖安装出的 app-builder Windows binary 供签名后重建 blockmap。
- 密封发布上下文现在严格绑定三份签名请求；发布 pipeline 加入 Windows status/download/report 校验、Windows 原生 Authenticode/timestamp/subject 校验，以及签名后 installer SHA-512、latest.yml 和 blockmap 生成。
- 更新两个既有发布 fixture 与静态 workflow 检查，没有增加测试用例。`node --test test/submit-macos.test.mjs test/publish-shell.test.mjs` 通过 76/76；`actionlint`、两个既有 workflow shell checks、Node 语法检查与 `git diff --check` 通过。
- 已提交聚焦实现，提交信息为 `Add Windows signing handoff to shell release`。

- 主任务修复最终摘要重复 finalize、完整证书 DN 归一化及原生票据校验有限重试；既有 76 条 Node 发布案例再次通过。
- Windows 未打包应用携带原 installer ICO 供固定签名配方使用。

- 源 run 38799647399 已成功；两个 Mac 最终包由本机 Get-Sign 检查镜像内 IRIS 0.6.0 均为 PASS、DefaultPassed、Distribution Passed、VerifiedStapled。Windows 请求在授权阶段失败并耗尽重试，自动 publisher run 38806661257 明确拒绝发布 SIGNING_FAILED windows execution_did_not_complete。
- 保留该未发布候选完整 context.json 至签名发布工作目录 retired-iris-0.6.0-second-candidate，经过既有 validateContext 校验，SHA-256 为 884dd832b21fb74c0b76d2bd06afb647212cd0c5c82de64013b062f0355d967d；仅移除它的旧 GitHub context artifact 12004975998，解除待发布 gate，不改已发布版本。
- 使用同一已审核源 b9e3cd327c93976deb97586616545909a09093d8 和版本 0.6.0 重新提交源 run 38811075767，供修复后的固定 Windows 签名配方验收。真实新发布及更新元数据仍待完成。
