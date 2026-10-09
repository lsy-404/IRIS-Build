# 操作记录

- 在固定目录 clone bare 仓库，fetch 最新主分支并检查 worktree list。
- 创建 codex/voidcarve-release-runtime worktree，基线 d04514b。
- 读取正式工作流、GitHub 失败日志、项目审计和 main 保护规则。
- 初次初始化审计目录提示 FileExistsError；确认仓库已跟踪 agents，保留所有已有记录，沿用既有索引而非覆盖初始化。

- 四个 Node setup 统一到 24；actionlint 完整工作流检查通过，git diff --check 通过。

- Node 24 工作流提交 43ab6522e80d610316bead5826a3237b03d5315c 已推送；完整 shell 构建 38003073650 已启动，精确 IRIS 源码为 331e405beaf9af25d6ec2cc7cc46530d137e1a34。

- 完整工作流 38003073650 全部成功：shell-check、Windows/macOS/Linux 构建矩阵、许可证服务上传、源提交打标和 GitHub Release 镜像。
- 实际发布为 Shell 0.5.81 / Core 26.1009.11；五个平台安装包、四个更新清单及 core/UI 均为 uploaded。
- shell-v0.5.81 与 core-v26.1009.11 注解标签解析后均指向 331e405beaf9af25d6ec2cc7cc46530d137e1a34。
- 下载 GitHub Release 的 mac-arm64 DMG 和 build-info.json；公开元数据与构建产物 SHA256 完全相同，coreVersion=26.1009.11、commit=331e405b、dirty=false。
- 只读挂载公开 DMG：内部版本为 0.5.81，CFBundleIconFile=icon.icns，ICNS SHA256=eeab55ebf3849e3be62c9203f5f8d9babdd0df92db834a29b282e002457138f8，与源资产完全一致。
- 实际安装包图标已导出供可视核对；检查用磁盘映像已卸载。未替换本机应用，当前安装版本仍为 0.5.80。
