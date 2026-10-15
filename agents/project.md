# IRIS-Build 项目索引
> 最后更新：2026-10-15

## 项目目标

通过 GitHub Actions 从私有 `IRIS` 源码构建并发布 IRIS core payload 与各平台 shell 安装包。

## 技术栈

- GitHub Actions
- Node.js 24
- Electron 多平台打包
- GitHub Releases 与外部 license service 发布流程

## 模块结构

- `.github/workflows/build.yml`：core、shell-check、Linux shell-build、Windows source submission、macOS signing-source build
- `.github/workflows/publish-shell.yml`：等待两份 macOS 与一份 Windows 请求完成，按平台验证并发布 shell 资产
- `scripts/`：签名请求提交、发布上下文、中心产物验证与 shell 发布脚本
- `runner/`：通用 Ubuntu runner 的隔离容器、共享磁盘与资源池；各仓库独立注册，IRIS 接入单个 CI 测试作业、core 主构建及 Linux x64 通知读取器构建
- `.github/scripts/`：安装、构建、发布、版本与工作流报告脚本

## 相关约束

- 构建中间 artifact 用于跨 job 传递；失败构建需要短期保留以便诊断。
- 成功发布后的中间 artifact 不再承担发布职责。

通知原生资产：core 构建同次运行的四个平台 job 生成五个目标资产，经 source digest 校验后交给统一 core。中间资产保留一天供诊断。
