---
layout: post
title: "我的学习仓库地图：STM32、51 单片机、OpenMV、JavaWeb、MySQL"
date: 2026-10-17 11:40:00 +0800
categories: 项目
tags: 项目 嵌入式 学习笔记
description: 把散在 GitHub 上的学习仓库整理成一张地图：每个仓库是什么、包含哪些实验、适合怎么用。
---

除了几个完整项目，我 GitHub 上还有一批"学习型仓库"。它们不像项目那样有完整的产品形态，但每个都按主题整理过，复习的时候比翻硬盘靠谱。这篇把它们串起来。

## 嵌入式方向

### [STM32 实验合集](https://github.com/sakurajh/Stm32) —— 30 个实验

STM32F103，正点原子风格的工程结构（`HARDWARE/` + `USER/`），从跑马灯一路到 UCOSII：

| 阶段 | 实验 |
|---|---|
| 基础外设 | 跑马灯 · 按键 · 串口 · 外部中断 · 看门狗 |
| 定时器 | 定时器中断 · PWM · 输入捕获 · 电容触摸 |
| 显示交互 | 数码管 · USMART 调试组件 |
| 模拟量 | ADC · DMA |
| 总线通信 | IIC · SPI · 红外遥控 |
| 传感器 | DS18B20 · DHT11 |
| USB | 虚拟串口 · 读卡器 · 串口 IAP |
| RTOS | UCOSII 任务调度 · 信号量邮箱 · 消息队列 |

### [51 单片机实验](https://github.com/sakurajh/single-chip-microcomputer)

STC89C52 的一套练习：LED、数码管、LCD1602、矩阵键盘密码锁、DS1302 时钟、蜂鸣器放音乐、红外遥控、直流电机调速、AD/DA 转换…… 按日期组织，每个目录一个 Keil 工程。

### [OpenMV 机器视觉](https://github.com/sakurajh/Openmv-Project)

摄像头视觉的几个经典任务：红色色块追踪、圆形 / 矩形识别、数字模板匹配、小车巡线、串口通信。里面还放了一个「自动计算 LAB 阈值」的脚本 —— 光照变了先跑它拿阈值，比手调试错快得多。

### [STM32 Keil 工程练习](https://github.com/sakurajh/Stm32-Project)

工程模板与练习存档，主要是记 Keil 的配置方式。

## Web 方向

### [JavaWeb 学习仓库](https://github.com/sakurajh/Java-Web)

按学习路线整理的完整仓库：

```text
HTML / CSS / JavaScript → Vue → Ajax
→ MySQL（多表查询 / 事务 / 索引）
→ Maven → MyBatis → Spring IOC&DI → AOP → 事务管理
→ SpringBoot（quickstart / mybatis-crud）
→ tlias 综合案例
```

目录按「课程日期 + 知识主题」命名（`01.`、`02.` …），可以按编号顺序看。

### [MySQL 实验脚本](https://github.com/sakurajh/MySql)

课程实验的 SQL 脚本，建表、查询、事务、索引都有，附带示例数据集。

### [HTML/CSS 练习](https://github.com/sakurajh/html) · [Java 基础练习](https://github.com/sakurajh/java)

前者是前端入门的手写练习（选择器、盒模型、Flex 布局、页面仿写）；后者是 Java 语法、面向对象、集合与 Swing 的练习代码，文件名保留了学习时的顺序（`Demo1`、`Test1`…），方便按进度回顾。

## 为什么保留这些"练习仓库"

有人会把课程代码清理掉，我倾向于留着，原因有三个：

1. **可回溯**：某个知识点忘了，翻当时的练习比看教程快
2. **可对比**：能看到自己从 `Demo1.java` 到能写完整项目的变化
3. **可复用**：像 STM32 的工程结构、OpenMV 的调参脚本，新项目直接抄

全部仓库见：[github.com/sakurajh](https://github.com/sakurajh?tab=repositories)，也可以在我的[项目页](/projects.html)按分类筛。
