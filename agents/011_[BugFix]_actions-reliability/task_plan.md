# Actions reliability

- [x] 核对并取消当前空等和 platform-kit 陈旧重跑
- [ ] GitHub 服务端清理旧排队记录（取消409、删除403；无job及artifact，元数据已保存）
- [x] 复现发布接力断点，设计显式交接及短时门禁
- [x] 保留签名、来源校验及发布前置检查，修复交接
- [x] 契约先失败后通过，校验工作流及脚本
- [x] 同步最新 main、整合并恢复待发布版本，验证实际工作流

- [x] 将发布门禁前移到私有 checkout / native matrix 前
- [x] 联调中心持久签名回传与一次性 publisher 状态检查
