# IRIS-Build 项目索引
> 最后更新：2026-10-09

## 项目目标

通过 GitHub Actions 从私有 `IRIS` 源码构建并发布 IRIS core payload 与各平台 shell 安装包。

## 技术栈

- GitHub Actions
- Node.js 24
- Electron 多平台打包
- GitHub Releases 与外部 license service 发布流程

## 模块结构

- `.github/workflows/build.yml`：core、shell-check、shell-build、shell-release 构建及发布编排
- `.github/scripts/`：安装、构建、发布、版本与工作流报告脚本

## 相关约束

- 构建中间 artifact 用于跨 job 传递；失败构建需要短期保留以便诊断。
- 成功发布后的中间 artifact 不再承担发布职责。
