---
layout: post
title: "项目｜鸿蒙双端：仿微信与仿 YouTube 的 ArkTS 实践"
date: 2026-10-17 11:20:00 +0800
categories: 项目
tags: 项目 HarmonyOS ArkTS
description: 两个 HarmonyOS NEXT 课程项目：微信客户端与 YouTube 客户端的界面与交互复刻，全部用 ArkTS / ArkUI 声明式开发。
---

学 HarmonyOS 最直接的方式，是**照着成熟产品做一遍**。这两个课程项目分别复刻了微信和 YouTube 的结构与交互，跑在 HarmonyOS NEXT 上。

## 之一：仿微信客户端

一共 11 个页面：

| 页面 | 说明 |
|---|---|
| 登录 / 注册 | 账号界面与表单校验 |
| 主界面 | 微信经典四栏：微信 / 通讯录 / 发现 / 我 |
| 聊天 | 单聊会话列表与气泡 |
| 朋友圈 | 信息流与图片九宫格 |
| 二维码名片 | 个人二维码页 |
| 视频号 | 列表 + 播放页 |
| 搜索 | 全局搜索 |

## 之二：仿 YouTube 客户端

| 页面 | 说明 |
|---|---|
| 首页推荐 | 视频信息流 |
| 搜索 / 通知 | 关键词搜索、订阅消息 |
| 探索 | 分类 / 新发现 / 排行榜 |
| 播放页 | 播放界面与相关推荐 |
| 历史 / 播放列表 | 观看记录与收藏 |
| 登录 / 注册 | 账号体系 |

## ArkTS 写下来的几个感受

**1. 声明式 UI 上手很快。**
写过 Vue / React 的话，`@State`、`@Prop`、`build()` 这套几乎无缝：状态变了界面自动更新，不用碰 DOM。

```ts
@Entry
@Component
struct Index {
  @State currentTab: number = 0

  build() {
    Column() {
      Tabs({ barPosition: BarPosition.End }) {
        TabContent() { HomeView() }.tabBar('微信')
        TabContent() { ContactsView() }.tabBar('通讯录')
        TabContent() { DiscoverView() }.tabBar('发现')
        TabContent() { MineView() }.tabBar('我')
      }
    }
  }
}
```

**2. 页面路由集中在 `main_pages.json`。**
所有页面必须先登记，好处是路由可枚举、不容易漏，坏处是加页面时容易忘。两个项目各 11 / 15 个页面，改多了会想念 Next.js 的文件路由。

**3. 组件比样式更值得花时间。**
同一个"列表项"，微信里是头像 + 昵称 + 摘要，YouTube 里是缩略图 + 标题 + 频道。把它们抽成 `@Component` 之后，页面代码会薄很多 —— 这也是 ArkUI 最舒服的地方。

## 运行方式

```text
DevEco Studio 打开项目根目录
→ 配置 HarmonyOS NEXT 模拟器或真机
→ 运行 entry 模块
```

两个仓库都是**课程设计性质的学习项目**，UI 参考原作，数据为本地模拟，与腾讯 / Google 无关：

- [sakurajh/Wechat_Project](https://github.com/sakurajh/Wechat_Project)
- [sakurajh/Youtube_HarmonyOS](https://github.com/sakurajh/Youtube_HarmonyOS)
