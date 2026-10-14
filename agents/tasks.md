# IRIS-Build 任务追踪
> 准则版本: v0.2.3

## 任务列表

| 编号 | 任务名称 | 任务描述 | 变更动机 | 状态 |
| :--: | :------: | :------: | :------: | :--: |
| 001 | [Maintenance] Actions storage cleanup | 清理历史 Actions artifact，并在成功发布后回收临时 artifact | GitHub Pro Actions artifact 存储接近配额 | ✅ 已完成 |

| 007 | [Refactor] pnpm迁移 | 源码依赖安装和 CI 使用 pnpm | 用户要求自有仓库全部替换 | 🔄 进行中 |
| 008 | [CI] 发布运行时统一 | 统一发布运行时并核对安装包发布 | Node 20 已不被现有检查工具支持 | ✅ 已完成 |
| 009 | [CI] macOS签名发布 | shell 发布的 macOS DMG 先经签名中心签名并公证，再发布全部平台资产 | 发布不得再带 ad-hoc 签名的 macOS 安装包 | 🔄 进行中 |

| 010 | [Feature] 通知原生资产交接 | 同次 core 构建生成五个平台读取器并交接完整资产 | 正式 core 需要完整 native 资产，复用现有 source SSH 与同仓库 artifacts 权限 | ✅ 已完成（main ba036e1 已推送；实际平台构建由后续既有 core 构建验收） |

| 011 | [BugFix] actions-reliability | 修复 shell 发布交接及无效轮询，处理陈旧运行 | 用户要求处理全仓库 Actions 异常 | ✅ 发布修复完成；旧记录清理受GitHub阻断 |

| 012 | [CI] 测试轻量化 | IRIS CI 仅保留 ubuntu-24.04 单作业，去掉多平台、构建、性能作业与定时任务 | Rosmontis 要求测试严格控制在轻量化 Ubuntu 以减少 usage | ✅ 已完成 |

| 013 | [BugFix] source-sha-release-gate | 统一构建源码 SHA，待发布 shell 时正常跳过构建 | 重复源码变量和预期等待状态造成失败 | ✅ 已完成 |

| 014 | [CI] IONOS runner pool | 在现有 IONOS 主机部署通用自托管资源池并接入现有测试 CI | 用户要求较大空间和 swap，后续供多个仓库使用 | ✅ 已完成（IRIS-Build 完整 CI 通过；其他仓库后续接入） |

| 015 | [CI] Self-hosted core builds | 将 core 主构建及 Linux x64 原生产物接入通用资源池 | 用户要求 core build 使用自托管 runner | 🔄 签名修复已部署，正在验收最新 main 的完整 workflow |
