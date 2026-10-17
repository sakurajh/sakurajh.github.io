---
layout: post
title: "项目｜情绪识别教学系统：一次 FastAPI 全栈实践"
date: 2026-10-17 10:40:00 +0800
categories: 项目
tags: 项目 FastAPI OpenCV 大模型
description: 摄像头实时情绪识别 + 在线考试（试卷 OCR 导入）+ 学情画像 + AI 助手，一个完整的教学平台。
---

这是我做过的功能最"全"的一个 Web 项目：从学生打开摄像头的那一刻，到教师看得懂的一份学情报告，整条链路都在里面。

## 五个模块

**① 实时情绪识别**
浏览器摄像头把视频流推给后端，OpenCV 做人脸检测与表情分析，情绪分布实时回传前端图表。教师端可以看到整堂课的情绪曲线。

**② 在线考试**
教师可视化出题、发布考试；学生在线作答、提交、查看成绩。最麻烦的是**试卷导入** —— 支持 Word / PDF，用 PyMuPDF 拆页、RapidOCR 识别、python-docx 解析，把纸质卷子变成题库。

**③ 学情画像**
按学生检索历史数据，AI 生成个性化学习报告，教师端还提供班级整体分析。

**④ AI 助手**
接入火山方舟的豆包模型（OpenAI 兼容接口），支持多轮对话答疑。

**⑤ 管理与权限**
学生 / 教师 / 管理员三角色，密码用 SHA-256 哈希存储，后台有用户管理与平台统计。

## 技术栈

| 层次 | 选型 |
|---|---|
| Web 框架 | FastAPI + Jinja2 |
| 数据库 | MySQL + SQLAlchemy ORM |
| 计算机视觉 | OpenCV（采集 / 人脸 / 情绪） |
| 文档解析 | PyMuPDF · python-docx · RapidOCR |
| 大模型 | 火山方舟 · 豆包 |
| 实时通信 | MJPEG 视频流 + fetch 轮询图表 |

## 一个必须记住的教训：密钥不能写进代码

项目早期，我把 API Key 和数据库账号密码直接写死在 `main.py` 里，仓库又是公开的 —— 等于把钥匙挂在门上。

后来全部改成环境变量读取：

```python
ARK_API_KEY = os.environ.get("ARK_API_KEY", "")
DB_USER = os.environ.get("DB_USER", "")
DB_PASS = os.environ.get("DB_PASS", "")
```

并补了一份 `.env.example`。**但要注意：改成环境变量只解决了"当前代码"，Git 历史里的旧提交依然能翻到密钥。** 所以真正的补救是去控制台把 Key 吊销换新、把数据库密码改掉。

> 结论：任何出现在代码里的密钥，都要按"已经泄露"处理。

## 值得复用的几个做法

1. **试卷导入做成"尽力而为"**：OCR 失败不阻塞流程，允许人工修正识别结果
2. **情绪数据只存聚合结果**：不落原始画面，避免隐私问题
3. **AI 报告有缓存**：同一学生短时间内重复请求不再烧 token

项目地址：[sakurajh/python-emotion-system](https://github.com/sakurajh/python-emotion-system)
