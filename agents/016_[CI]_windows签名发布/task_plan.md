# Windows shell 签名发布

目标：把 Windows x64 源构建交给公开签名中心，验证中心重打包与嵌套签名证明，再将经 Windows 原生验签的安装包加入原有 shell 发布。

- [x] 检查中心的 Windows project/manifest/report 与下载协议
- [x] 拆分 Windows 源构建 job，提交 app/ 和 source.json 并将请求绑定到密封发布上下文
- [x] 将 Windows 请求纳入发布 readiness/fetch/验签/发布 gate，并重建签名后二进制的 updater 元数据
- [x] 更新项目索引与任务状态，运行适用的既有检查并审阅差异
- [x] 提交聚焦变更并汇报父任务
