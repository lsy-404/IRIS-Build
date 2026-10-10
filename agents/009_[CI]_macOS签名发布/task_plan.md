# macOS 签名发布

目标：shell 发布的 macOS DMG（arm64、x64）必须先经签名中心签名并公证，才能发布到许可证服务、R2 和 GitHub Release 镜像；不再发布 ad-hoc 签名的构建。

- [x] build.yml：macOS 构建移出矩阵，新增 shell-build-macos 作为最后一个构建 job，只提交签名请求，不发布任何资产。
- [x] build.yml：shell-check 在版本解析前等待上一个 shell 发布完成（gate）。
- [x] build.yml：删除 shell-release job；core 路径保持不变。
- [x] scripts/submit-macos.mjs：准备、提交、记录发布上下文、清理（自包含，仅用 Node 内置模块）。
- [x] publish-shell.yml：workflow_run 触发（含 workflow_dispatch 兜底），解析、等待签名、macOS 验证、发布。
- [x] scripts/publish-shell.mjs：gate、resolve、context、await、fetch、assemble、preflight、cleanup-artifacts。
- [x] 测试：submit-macos、publish-shell 的 node 测试；三个工作流契约脚本。
- [ ] 推送 main（中心按规则信任，无需 pin）。
