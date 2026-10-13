# 发现

- `SOURCE_SHA` 和 `IRIS_SOURCE_SHA` 在 build.yml 与 publish-shell.yml 指向同一值；IRIS 的 `scripts/write-build-info.mjs` 只读取 `IRIS_SOURCE_SHA`。
- gate 的三个直接依赖为 core、shell-check、notification-readers；其他 shell job 会随依赖跳过。
- 现有 gate 验证要求待发布状态抛错；本次退出契约变更后需修改原有案例。
- GitHub Actions 文档允许通过 job outputs 与 needs 条件控制后续 job。
- 查询 `IRIS_SHELL_PUBLISH_HOLD` 得到 404，未配置此变量。
- 查找 IRIS-Build `.github/scripts` 与 `.gitignore` 得到不存在；发布脚本由 workflow 检出 IRIS 后提供。
- 修改后的 47 个既有发布脚本案例通过，涉及两个 workflow 的 actionlint 通过，Node 语法检查与 diff 格式检查通过。
- 当前真实 GitHub artifacts 通过生产 CLI 检查：退出码 0，`build=false`，stderr 为空，summary 指向待发布运行 `38323567839`。
- 整合前再次 fetch，远端 main 未出现新提交；main 无 branch protection、适用 branch rules 或 rulesets。
