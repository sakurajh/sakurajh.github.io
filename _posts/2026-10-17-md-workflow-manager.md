---
layout: post
title: "项目｜MD Workflow Manager：把分子动力学流程装进一个桌面软件"
date: 2026-10-17 10:20:00 +0800
categories: 项目
tags: 项目 Python 科学计算 GROMACS
description: 接入 CHARMM-GUI 输出，一键跑完能量最小化 → NVT/NPT 平衡 → 生产模拟，界面在 Windows，计算在 WSL2。
---

分子动力学（MD）模拟的流程是标准化的，但每一步都要手敲命令：`grompp` 生成 tpr、`mdrun` 跑轨迹、检查日志、再进下一步。一个体系动辄几个小时，中途参数写错就得重来。

MD Workflow Manager 做的事情很直接：**选一个 CHARMM-GUI 输出的文件夹，剩下的交给它。**

![MD Workflow Manager 界面](/assets/img/proj-md-workflow.png)

## 核心能力

- **一键接入 CHARMM-GUI**：选中输出目录，自动识别力场、结构文件、各阶段的 mdp
- **全原子 / 粗粒化自动区分**：读 `topol.top` 里的力场判断（CHARMM36 → 全原子，Martini → 粗粒化），粗粒化自动换 20 fs 步长
- **四页签流程**：环境配置 → 输入检测 → 参数配置 → 运行日志
- **实时进度与预估**：当前阶段、阶段内进度、总体进度、剩余时间
- **可取消、可续跑**：失败后修好参数，从失败阶段继续
- **自动装 GROMACS**：检测不到 gmx 时，自动下载 micromamba、建 conda 环境、装 conda-forge 版 GROMACS，全程不需要管理员权限

## 一个有意思的架构决定：界面在 Windows，计算在 Linux

GROMACS 在 Linux 上性能最好，但大多数人手上是 Windows。

所以这个软件把两件事拆开了：**GUI 跑在 Windows（打包成 exe），计算通过 WSL2 在 Linux 里执行**。中间层处理了路径转换（`C:\xxx` ↔ `/mnt/c/xxx`）、命令包装、输出流解析。用户看到的是一个 Windows 软件，实际干活的是一台 Linux。

这也带来一个隐藏福利：GPU 加速可用 —— WSL2 能直通显卡；如果没有可用 GPU 设备，会自动回退 CPU 重跑当前阶段并记录警告，不中断流程。

## 工程细节

| 问题 | 解法 |
|---|---|
| CHARMM-GUI 下载的是压缩包 | 直接导入 tgz / tar.gz / zip，自动解压定位 |
| 想先熟悉软件再跑真模拟 | dry-run 模式：不调用 gmx 也能走完整个流程 |
| 环境到底行不行？ | 「环境自测」用最小水体系真跑一遍 grompp + mdrun |
| 断网 / 国内源慢 | conda 通道可切清华镜像 |
| 想在服务器上用 | 提供 `--cli` 控制台模式，可 nohup / tmux 后台跑 |

## 体会

写这个项目最大的收获不是 GROMACS 本身，而是**怎么把一个"专家流程"翻译成"界面语言"**：哪些参数该暴露、哪些该藏起来、出错时用户到底需要看到什么。后面这一点尤其重要 —— 报错只写 "grompp failed" 是没用的，得告诉他第几个阶段、哪一行 mdp、缺了什么。

项目地址：[sakurajh/md-workflow-manager](https://github.com/sakurajh/md-workflow-manager)
