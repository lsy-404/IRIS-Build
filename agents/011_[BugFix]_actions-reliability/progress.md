# Progress

- 2026-10-12：核对本地 worktree 后 fetch origin，基于 c2aa100 创建专用分支。
- 2026-10-12：POST cancel 38235169173 与 platform-kit 37365872547，均确认 completed/cancelled；旧运行 34748967732 的 cancel 与 force-cancel 被 GitHub 拒绝，原始元数据已保存。

- 保留公开隐藏构建→签名中心→固定公开签名Action→发布的现有链路。中心完成两架构签名后派发固定publisher；不新增PAT或任意callback配置。发布器一次性检查签名状态，未完成立即返回pending；门禁移到私有checkout和native matrix前，拒绝旧发布占用runner。76个发布/提交合同及2个CI隐私合同通过。移除未被调用的手写工作流镜像脚本，配置由actionlint和人工依赖/凭据审阅验证，协议由Node合同验证。旧0.5.88签名成功但R2产物已过24h保留期，须保存元数据后重建。幽灵run删除仍403，取消/强制取消409，GitHub服务端残留没有jobs或artifact。

- 公开CI报告夹具已隔离真实报告凭据；报告上报403/网络失败仅显示交付状态码，原始诊断仍隐藏。旧0.5.88密封context及元数据保存到工作目录后删除阻塞artifact，Windows/Linux有效安装包保留；当前不存在未过期context。签名未就绪合同变异能失败，恢复后79合同通过、4工作流actionlint通过。shell-build历史最长6m33s，job上限设30min。

- 当前source的build:release要求四平台notification reader，shell-check此前没有下载它们。已将native matrix扩展到shell输入，shell-check等待同run四平台产物并传入既有merge/digest校验；无共享旧来源或绕过verify-complete。另新增releaseOnly仅运行Windows发布flows的手动验证入口，常规core/定时/完整CI仍执行所有检查。两项配置改动均通过actionlint，实际运行继续验收。

- 同source完整CI各平台通过，载荷复核38306884088通过；CLI scope整理为full/native/release/payload，payload可复用同repo同代码digest的原生输入。首次完整构建暴露native matrix覆盖全局shell默认值，已显式Bash；安装包dist会重建本机组件，现也下载同run完整四平台输入，避免缺组件及重复编译。38307805730已取消并确认completed/cancelled，最终构建38308854123使用b30cf5ad固定源码，发布接力仍待实际验收。

- 最终公开构建38308854123成功：四平台原生组件、shell检查、Windows/Linux安装包和双架构macOS中间包全部通过。公开签名请求完成后，中心于21:42:47 UTC自动派发38312332093（workflow_dispatch），没有人工派发publisher；resolve、一次性签名就绪检查和macOS签名包校验均通过，等待发布及清理结束。

- 自动发布在版本服务commit遭遇400：线上仍要求已删除的冗余object_key。IRIS隔离生产分支基于与线上字节完全相同的b2b816566，只同步按摘要派生对象路径；静态资源差异已恢复原线上字节，最终部署eefc61ef保留配置与资源。复用原构建和签名产物的38315723184于22:19:52 UTC成功，版本服务提交、源码标签、GitHub镜像与临时产物清理全部成功。latest含12个uploaded资产、五平台0.5.88安装包和Core 26.1012.1；两源码标签均指向b30cf5ad，build-info同源且dirty=false，父构建artifact数量为0。

- 全账户137个未归档仓库复查，除本次公开签名外无近期活跃运行；两个仓库访问被GitHub限制。9月幽灵34748967732仍queued、job=0、artifact=0，服务端拒绝取消及删除，不能宣称删除成功。CASSIE基础构建25秒成功、Metrics每周图表6m9s成功；原5美元月度预算未调整。
