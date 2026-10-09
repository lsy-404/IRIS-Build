# 事实记录

- 最新 main 为 d04514b，无 AGENTS.md 或 README.md；已有 agents 记录，任务编号按现有索引递增。
- shell 构建 38001965825 类型检查通过后在 lint 失败：dependency-cruiser 不支持 Node 20.20.2，要求 ^22||^24||>=26。
- IRIS 源码 CI 使用 Node 24，本地全部正式发布检查在 Node 24.16.0 下通过。
- 四个 setup 位于 core、shell-check、shell-build、shell-release，原值均为 20。
- main 无保护，rules=[]；actionlint 已安装，原始工作流 schema 检查通过。
