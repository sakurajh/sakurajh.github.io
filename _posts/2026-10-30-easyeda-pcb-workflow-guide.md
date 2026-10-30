---
layout: post
title: "EasyEDA PCB 快速设计工作流：从零到打样的避坑指南"
date: 2026-10-30 20:58:00 +0800
categories: 硬件开发
tags: EasyEDA PCB 嘉立创EDA 电路设计 NFC 工作流
description: "在嘉立创EDA专业版里画PCB，从装饰纪念卡到NFC功能板，踩了十几个坑之后总结出的完整工作流。坐标系统、层ID映射、图像描摹、底层镜像、丝印避坑、批量绘制——照着走，不用再试错。"
---

最近在嘉立创EDA（EasyEDA Pro）里连着画了几块板子——西电黑金纪念卡、红金NFC校园卡、六层立体校徽浮雕挂件。从一开始到处试错，到后来基本能一遍画对，中间踩的坑和总结的流程，整理成这篇工作流指南。

这篇不是 API 文档，而是**实战避坑手册**——记录的是那些官方文档里没写、但会让你卡半天的细节。

## 一、核心概念：先搞清楚再动手

### 坐标系统

PCB 域的单位是 **mil**（千分之一英寸），不是毫米：

```
1 mm = 39.37 mil
mm(v) = Math.round(v * 39.37 * 100) / 100
```

坐标原点在**左下角**，x 向右，y 向上。设计稿用 mm，API 用 mil，所有坐标必须转换。

**最容易踩的坑**：文字字号需要 **×1.25 补偿**。EDA 的字形实际只占字号的 0.7 倍，不补偿的话字会比设计稿小 30%。

### 六层板层 ID 映射

这是画多层板的基础，记不住就存下来：

| 视觉层 | 铜层 ID | 阻焊 ID | 丝印 ID |
|---|---|---|---|
| L1 顶层 | **1** (TOP) | **5** | 3 |
| L2 内层1 | **15** (INNER_1) | — | — |
| L3 内层2 | **16** (INNER_2) | — | — |
| L4 内层3 | **17** (INNER_3) | — | — |
| L5 内层4 | **18** (INNER_4) | — | — |
| L6 底层 | **2** (BOTTOM) | **6** | 4 |
| 板框 | **11** (BOARD_OUTLINE) | — | — |

金色效果的原理：**铜箔层画图案 + 阻焊层开窗同样图案 + 沉金工艺**。开窗处露出金色，没开窗的地方是阻焊颜色（绿/红/黑）。

## 二、标准流程（7 步）

### Step 1：环境检查

```bash
for port in $(seq 49620 49629); do
  resp=$(curl -s http://127.0.0.1:$port/health)
  if echo "$resp" | grep -q '"easyeda-bridge"'; then break; fi
done
# 确认文档类型必须是 3（PCB）
```

### Step 2：建工程 + PCB

```javascript
const projUuid = await eda.dmt_Project.createProject('名称', '代号');
await eda.dmt_Project.openProject(projUuid);
const pcbUuid = await eda.dmt_Pcb.createPcb();
await eda.dmt_EditorControl.openDocument(pcbUuid);
```

这步合计耗时超过 30 秒，单次请求会超时——给 90 秒 timeout。

### Step 3：画板框（必须严格闭合）

**这是最大的坑**。板框首尾不重合的话，EDA 不把它当板子外形，3D 里板子会变成一个小圆饼（挂孔那个圆）。

```javascript
// 四角圆弧采样后，必须手动回到起点
pts.push([pts[0][0], pts[0][1]]); // ← 这行不能少
```

### Step 4：逐层绘制

分批写入，每批 ≤40 个图元。顺序：内层 → 顶层铜箔 → 底层铜箔 → 阻焊开窗。

### Step 5：图像描摹（校徽/签名/Logo）

```javascript
const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
const cp = await eda.pcb_MathPolygon.convertImageToComplexPolygon(
  blob, 480, 480, 0.55, 0.35, 0.5, 1.5, true, false
);
await eda.pcb_PrimitiveImage.create(x, y, cp, layer, w, h, 0, false, false);
```

图片预处理用 PIL：灰度 → 二值化 → 裁白边 → 缩放。**极性别搞反**：笔迹=黑(0)，背景=白(255)。反了会描出白底方块。

描摹参数用 `(0.55, 0.35, 0.5, 1.5)`——试过 `(0.6, 0.3, 0.45, 2.0)` 会内部报错。

### Step 6：过孔

```javascript
await eda.pcb_PrimitiveVia.create('', x, y, drill, pad, 0);
```

参数别多传，传多了报"参数不正确"。

### Step 7：保存 + 验证

## 三、避坑速查表

### 致命错误

| 问题 | 症状 | 解决 |
|---|---|---|
| 板框不闭合 | 3D 板子变小圆饼 | 首尾点重合 |
| 文档类型不对 | 所有 API 返回 null | 先 `openDocument` 确认 type=3 |
| 底层不镜像 | 背面图案跑到板外 | L6 的 x 用 `板宽 - x` |
| 图片极性反 | 描出白底方块 | 笔迹=黑，背景=白 |
| getAll 带 layer 参数 | 返回 null | 用 `getAll()` 再自行 filter |

### 常见错误

| 问题 | 解决 |
|---|---|
| 文字比设计稿小 30% | `size × 1.25` |
| 填充矩形位置偏 | 'R' 的 y 是**顶边**不是底边 |
| 折线缺一条边 | 手动加回到起点的线段 |
| 描摹报 null | 用参数 (0.55, 0.35, 0.5, 1.5) |
| 'L' 模式填充失败 | 'L' 只能用于 Polyline |
| 操作超时 | 分批，每批 ≤40 个 |
| 丝印被金块"吃掉" | 文字放在阻焊区（红色/绿色底），不能压在开窗（金色）上 |

### 丝印文字的规则

这是做装饰板最容易忽略的：**PCB 制造时丝印油墨不会印在裸露的铜箔/沉金表面上**。

所以丝印文字必须放在阻焊层（红色/绿色底色区域）上，不能压在金色开窗区域。如果建筑/图案是金色的，文字要放到旁边的红色空位。

对于密集布局（建筑间距 <1mm），用**碰撞检测**自动找空位：默认放上方，检测到重叠就依次换到下→右→左→右上→右下。

## 四、底层镜像的原理

PCB 的底层（BOTTOM）在 2D 视图和 3D 背面视图中是**镜像显示**的——就像把板子翻过来看。

如果你在数据坐标 (x=551) 放一个图案，在顶层看是在左边，但在底层的 2D 视图里会跑到右边（镜像了）。

修正方法：底层图案的 x 坐标用 `板宽mil - x` 来补偿。比如板宽 80mm = 3150mil，顶层 x=551，底层就用 x=3150-551=2599。

**但要小心**：校徽这类左右对称的图案，镜像后 x 的数学结果恰好等于原值，看起来"没问题"但实际上位置偏了。这时候要用 3D 预览确认，不能只看 2D。

## 五、加速技巧

### 批量写入

```javascript
const data = JSON.stringify(items); // ≤40个
const code = `const items = ${data}; /* 逐个创建 */ return ok;`;
await exec(code, 60000);
```

### 贴片元件封装（画建筑/装饰）

把建筑画成贴片电阻/电容的样子（两端焊盘+中间本体），道路用走线，就是"元器件建筑群"风格：

```javascript
function smd(cx, cy, w, h) {
  const pad = Math.min(w*0.35, 1.2);
  return [
    fillRect(cx-w/2, cy-h/2, pad, h, 0.05),      // 左焊盘
    fillRect(cx+w/2-pad, cy-h/2, pad, h, 0.05),  // 右焊盘
    fillRect(cx-w/2+pad, cy-h/2+1, w-2*pad, h-2, 0.05), // 本体
  ];
}
```

### 自动化脚本结构

```
project.mjs → 建工程+PCB
outline.mjs → 板框+挂孔
layers.mjs  → 逐层绘制（分批）
images.mjs  → 校徽/签名描摹
vias.mjs    → 过孔
save.mjs    → 保存+统计
```

**每个脚本开头都先 `openDocument(pcbUuid)` 确认文档类型。** 文档状态经常被切走。

## 六、打样参数速查

| 项目 | 装饰卡 | 功能板 | 六层免费券 |
|---|---|---|---|
| 尺寸 | 86×54mm | 自定义 | ≤100×100mm |
| 层数 | 2 | 2 | 6 |
| 板厚 | 1.6mm | 1.6mm | 1.6mm |
| 阻焊 | 红/黑 | 绿 | 绿 |
| 表面处理 | **沉金** | HASL/沉金 | 沉金 |
| DRC | 可跳过 | 需通过 | 可跳过 |

装饰板的 DRC 会报"孤岛铜/无网络"——正常现象，不影响打样。

## 七、经验总结

画完三块板之后，最大的体会是：

1. **先跑通最小流程**（板框+一个矩形+保存），确认每一步都 OK 再批量画。不要一上来就写几百个图元。
2. **每步都要验证**。用 `getCurrentRenderedAreaImage` 抓画布看效果，比猜靠谱得多。
3. **文档状态是最大的坑**。EDA 会在你不知道的时候切走文档，操作前必须确认 type=3。
4. **底层坐标要镜像**，但对称图案看不出来错——用 3D 预览确认。
5. **丝印不能压金块**。做装饰板时，文字和金色图案必须分开在不同区域。

现在这些流程和避坑规则已经整理成了 skill，下次画板直接照着走。完整的 skill 文件在我的 [GitHub](https://github.com/sakurajh) 上开源了，有兴趣可以看看。
