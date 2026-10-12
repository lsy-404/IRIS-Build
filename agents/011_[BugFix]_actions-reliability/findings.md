# Findings

[空等] -> gate 默认轮询 14400 秒；成功构建 38084132849 的 shell-release-context 仍存在，版本 0.5.88 未发布。当前空等运行及 platform-kit 重跑已成功取消。
[旧排队] -> 34748967732 无 job、无 artifact；cancel 和 force-cancel 均返回 HTTP 409。元数据已保存到本任务 outputs，等待删除授权或其他可行取消路径。
[接力] -> shell 构建由 core 使用 GITHUB_TOKEN repository_dispatch 派发；shell 完成后没有对应 publisher，core 的 publisher 仅检查了 core 运行。需采用受支持的显式 workflow_dispatch 交接，并处理 dispatch 时父运行尚未结束的竞态。

[删除失败] -> 用户已明确授权删除 34748967732；GitHub DELETE 返回403，页面不提供删除入口，页面 Cancel 同样显示 Failed to cancel workflow。这是 provider 侧陈旧记录，未分配任何 runner。
[验证] -> 门禁单次检查及发布接力父运行120秒等待契约先出现4个失败，修改后77项 Node契约全绿；三个仓库 actionlint 均通过。
[签名扩展] -> 用户追加改善签名流程；中心签名完成后用持久通知派发固定 publisher，发布器改一次性探测，不保留3小时轮询。

- 保留公开隐藏构建→签名中心→固定公开签名Action→发布的现有链路。中心完成两架构签名后派发固定publisher；不新增PAT或任意callback配置。发布器一次性检查签名状态，未完成立即返回pending；门禁移到私有checkout和native matrix前，拒绝旧发布占用runner。76个发布/提交合同及2个CI隐私合同通过。移除未被调用的手写工作流镜像脚本，配置由actionlint和人工依赖/凭据审阅验证，协议由Node合同验证。旧0.5.88签名成功但R2产物已过24h保留期，须保存元数据后重建。幽灵run删除仍403，取消/强制取消409，GitHub服务端残留没有jobs或artifact。

- 公开CI报告夹具已隔离真实报告凭据；报告上报403/网络失败仅显示交付状态码，原始诊断仍隐藏。旧0.5.88密封context及元数据保存到工作目录后删除阻塞artifact，Windows/Linux有效安装包保留；当前不存在未过期context。签名未就绪合同变异能失败，恢复后79合同通过、4工作流actionlint通过。shell-build历史最长6m33s，job上限设30min。
