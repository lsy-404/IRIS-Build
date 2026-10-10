# 操作记录

- 新建分支 release-signing；先写测试（模块缺失时导入失败），再实现脚本与工作流。
- build.yml：shell-check 增加 actions: read、发布门；矩阵去掉 macos-latest；新增 shell-build-macos；删除 shell-release；中间 artifact 保留 3 天。
- publish-shell.yml：resolve、await-signing、verify-macos、publish 四个 job；publish 受 IRIS_SHELL_PUBLISH_HOLD 变量暂停，可由 workflow_dispatch 带 release_held 放行。
- 检查：node --test test/*.test.mjs 全部通过；bash test/*.sh 通过；actionlint 通过。
- 回退验证：分别破坏幂等键、run_attempt 校验、架构去重、请求 id 去重、retry_after 夹取、响应头摘要校验、上下文 artifact 最后删除、runtime 标志、版本取代判断，对应测试均失败；工作流契约脚本对密钥泄漏、未固定 SHA、顺序错误、脚本路径错误均失败。
- 未推送、未触发 workflow、未部署。

# 设计要点

- 本仓库公开：artifact、日志和本目录都不得含 token、请求 id 或私有地址。上下文 artifact 只含公开安全字段与已加密的密钥信封。
- submit-macos.mjs 自包含（仅用 Node 内置模块）；publish-shell.mjs 可导入 submit-macos.mjs 的上下文校验。
- IRIS 源码会被复制覆盖到本仓库检出目录，所以固定脚本和发布脚本都从独立的 .release-tools 检出（github.sha）运行。
- 中心在创建请求时要求源 run 处于 in_progress，且未完成的 run 超过 1 小时会使请求失败；因此 macOS 提交放在 Run A 的最后一个 job。
- 签名产物在中心保留 24 小时，之后下载返回 410（终态）；发布必须在签名成功后 24 小时内完成。
- publish job 使用 job 级并发组 iris-publish-shell：core 构建同样触发 workflow_run，workflow 级并发组会让新的排队 run 取消排队中的 shell 发布。
- upload-shell-assets 在最终发布调用之前先写 shell-release-meta，所以预检以许可证服务当前提供的 release_id 与已定稿的兼容标签为准，meta 相同但未被提供时重新执行发布（Worker 对相同元组幂等）。
- stage-installers 与 upload-shell-assets 无需修改；macOS 构建不再暂存或上传未签名安装包。

# 中心信任

中心按规则信任源 workflow（默认分支、run_attempt 1、workflow_path、actor、required_job 等），不再钉死 blob；改动 build.yml 或 submit-macos.mjs 无需更新或重新部署中心。


# 发布串行化与上下文保护

- core 构建在版本预留前运行 gate，等待未发布的 shell 上下文，避免公证等待期内的 core 构建抢先预留并发布更高的 core 版本。
- 上下文 artifact 中的密钥信封用仓库机密 IRIS_CONTEXT_SEAL_KEY（至少 32 字符）以 AES-256-GCM 封装，绑定 run、源提交与 release_id；该机密只出现在 shell-check 的校验步骤、记录上下文步骤以及发布 job 的校验与读取上下文步骤。
- core-payload 与签名镜像 artifact 保留 1 天；cleanup-artifacts 同时删除已结束发布 run 遗留的 signed-macos。
- 暂停（IRIS_SHELL_PUBLISH_HOLD）时不再等待签名与下载镜像，放行的手动运行才会取回。手动运行只接受默认分支。
