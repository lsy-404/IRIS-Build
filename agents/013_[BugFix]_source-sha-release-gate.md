# 构建源码变量与发布 gate

- 基线：IRIS-Build `origin/main` 为 `44299dfefba2dd10f1769ca54074e571e32dd240`。
- 请求：消除重复 source SHA 参数；无需继续 shell 工作时优雅退出。
- 证据：构建运行 `38349033624` 的 release-gate 收到 `SHELL_PUBLISH_PENDING` 后退出 1。待发布 context 属于运行 `38323567839`，artifact 未过期。
- 决策：保留源码打包脚本公开使用的 `IRIS_SOURCE_SHA`，将构建及发布 workflow 的同义 `SOURCE_SHA` 引用统一为它；dispatch 的 `source_sha` 与签名的 `INPUT_SOURCE_SHA` 协议字段保持原名。
- 决策：待发布 shell 是预期的暂停状态，gate 返回 `build=false` 并正常退出；所有直接依赖 gate 的构建 job 检查该输出，防止成功退出后意外继续发布。无待发布 shell 时返回 `build=true`，请求及凭据错误仍然失败。
- 范围：只修改 IRIS-Build；不启动签名或发布、不清除待发布资产；不新增测试案例，仅更新已变更的 gate 契约并运行现有验证。
- 结果：产品提交 `647df795187c3dbf00e9fe3f9d431e95a06c4b36` 已合入并推送 main；47 个现有发布脚本案例及 actionlint 通过，真实 GitHub 待发布状态下生产 gate CLI 退出 0、输出 `build=false`。
