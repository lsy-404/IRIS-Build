# 001 Actions storage cleanup

- [x] 确认当前 GitHub 账号、仓库与 Actions 存储来源
- [x] 盘点各仓库 artifact 与 cache 大小、状态和时间
- [x] 检查 IRIS-Build 工作流的 artifact 生命周期
- [x] 修改成功发布后的临时 artifact 回收逻辑
- [x] 校验工作流 YAML 与变更差异
- [ ] 提交并推送工作流修复
- [ ] 清理线上旧 artifact，保留必要的最新状态
- [ ] 复核 GitHub API 中的存储占用与工作流状态
