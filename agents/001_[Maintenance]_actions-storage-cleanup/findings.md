# 调查记录

## 现象

GitHub Pro 账号 `lsy-404` 的 Actions artifact 存储接近配额。`IRIS-Build` 工作流高频运行，每次成功构建会留下四个跨 job artifact。

## 证据

- 当前账号为 GitHub Pro；GitHub 文档显示 Pro 的 Actions artifact 与 Packages 共享 1 GB 免费存储，cache 为每仓库独立配额。
- `lsy-404/IRIS-Build` API 盘点到约 22.35 GB artifact 元数据，其中约 19.51 GB 已过期；仍未过期的近期构建产物约 2.84 GB。
- `lsy-404/IRIS` 约 12.16 GB artifact 全部已过期。
- cache 最大仓库为 `epilogue`，约 1.33 GB；各仓库 cache 未达到 GitHub 默认 10 GB 仓库上限，非本次账号 artifact 告警主因。
- `.github/workflows/build.yml` 的跨 job artifact 设置 `retention-days: 1`，但成功运行完成后仍会继续占用这一天；高频 dispatch 使多个成功运行同时有效。
- `IRIS-Build` 的 `latest` Release 已在 2026-09-11 07:48 UTC 更新，包含 payload、UI、build-info、Windows/macOS/Linux 安装包及更新元数据；因此成功运行的 artifact 可视为临时传输物。

## 结论

成功发布完成后可删除当前运行的跨 job artifact；失败运行仍按 1 天保留，满足诊断需要。Release 资产作为 IRIS 成品的保留位置。线上清理先删除旧成功运行和已过期 artifact，不触碰 Release 资产或源码。

## 操作问题

- 首次 `git add agents` 被仓库 `.gitignore` 忽略；审计记录仍保留在本地 `/agents`，提交时需显式强制加入该目录。
- 首轮批量删除在达到执行时限前完成了 `IRIS-Build` 的清理，但 `IRIS` 仍有 46 个 artifact；随后对剩余条目单独重试，最终清理成功。
- 只读查询 Packages 时，当前 GitHub CLI token 缺少 `read:packages` scope；未扩大 token 权限，Packages 共享池占用无法从 CLI 单独核实。
