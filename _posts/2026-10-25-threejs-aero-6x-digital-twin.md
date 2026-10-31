---
layout: post
title: "AERO-6X 六轴机械臂数字孪生：关节联动、爆炸分层与实时剖面"
date: 2026-10-25 10:07:00 +0800
categories: 项目
tags: Three.js 数字孪生 WebGL 机械臂 前端
description: "从只能看结构的静态演示，到六轴关节可驱动、爆炸分层可调、外壳透视和实时剖面的数字孪生。记录 AERO-6X 在 Three.js 里的状态拆分、Group 层级、裁剪面与标注投影，以及把依赖本地化后双击即用的做法。"
---

上一篇里我做了个六轴机械臂的结构工作台，能转、能拆、能剖，但它不会动。学弟看完问了一句："能不能让每个关节转起来，看看大臂和小臂怎么联动？"这个问题把我从"结构展示"推到了"数字孪生"。

这里说的数字孪生不是产线级仿真，而是一个能在浏览器里讲清运动关系的交互模型：六个关节可以独立驱动，爆炸图按总成分层，外壳能透视或剥离，剖面能实时切，点击标注还能看材料和规格。今天放上来的版本把 Three.js、Tailwind 运行时和字体全部本地化，下载后双击就能离线跑。

<video controls preload="metadata" poster="https://www.sakurajh.xyz/assets/images/aero-6x/robot-arm-default.jpg" src="https://www.sakurajh.xyz/aero-6x-digital-twin/demo/aero-6x-demo.mp4" style="width:100%;border-radius:6px;background:#070b14"></video>

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:8px">53 秒演示：关节驱动 → 自动巡航 → 爆炸分层 → 透明外壳 → Z 轴剖面 → 部件检视 → 复位</p>


## 一、先把数字孪生拆成三层

最容易写乱的地方，是把模型、运动状态和界面混在一个函数里。我把它拆成三层：

- 模型层：底座、J1 回转台、J2 肩部、J3 肘部、J4 小臂、J5 腕部、J6 法兰和夹爪，各是一个 `Group`，子级继承父级的旋转。
- 状态层：`joints`、`explodeFactor`、`shellMode`、`sectionEnabled`、`selectedPartId` 等，所有 UI 只改这一层。
- 表现层：HUD、滑块读数、标注点、检视器卡片，只负责把状态画出来。

六轴的旋转轴和范围如下：

| 关节 | 旋转轴 | 作用 | 滑杆范围 |
|---|---|---|---|
| J1 | Y | 腰部回转 | −180° ~ 180° |
| J2 | Z | 肩部俯仰 | −95° ~ 95° |
| J3 | Z | 肘部俯仰 | −120° ~ 120° |
| J4 | X | 小臂回转 | −180° ~ 180° |
| J5 | Z | 腕部摆动 | −125° ~ 125° |
| J6 | X | 末端法兰旋转 | −360° ~ 360° |

![AERO-6X 默认视图](https://www.sakurajh.xyz/assets/images/aero-6x/robot-arm-default.jpg)

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:-6px">1600×900 下的默认视图：左侧检视器，右侧四个控制标签页。</p>

模型层里每个可拾取零件还带一份元数据：名称、材料、所属层级、峰值扭矩和重复定位精度。它不是渲染必需的，但决定了点选之后检视器里能显示什么。把元数据和几何分开，改文案不用动模型，换模型也不用重写信息卡。

这样分层以后，加一个视角预设不需要碰模型，改一个显示模式也不用重写 UI；反过来，模型换一套几何，状态和界面仍然能复用。

## 二、六轴联动：转 Group，不要逐个转 mesh

![六轴关节驱动](https://www.sakurajh.xyz/assets/images/aero-6x/robot-arm-joints.jpg)

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:-6px">J1 转到 70°、J3 转到 75° 后的姿态，右侧滑杆与模型实时联动。</p>
关节运动的核心只有几行：

```js
function applyJointKinematics() {
  const deg2rad = Math.PI / 180;
  j1Group.rotation.y = state.joints.j1 * deg2rad;
  j2Group.rotation.z = state.joints.j2 * deg2rad;
  j3Group.rotation.z = state.joints.j3 * deg2rad;
  j4Group.rotation.x = state.joints.j4 * deg2rad;
  j5Group.rotation.z = state.joints.j5 * deg2rad;
  j6Group.rotation.x = state.joints.j6 * deg2rad;

  const strokeOffset = 0.05 + (state.joints.grip / 100) * 0.23;
  const baseL = explodableItems.find(it => it.mesh === fingerLeftGroup);
  const baseR = explodableItems.find(it => it.mesh === fingerRightGroup);
  if (baseL && baseR) {
    baseL.basePos.z = strokeOffset;
    baseR.basePos.z = -strokeOffset;
  }
  applyExplodedState();
}
```

关键是旋转的是 `Group`，不是某个外壳 mesh。J2 一转，挂在它下面的大臂、肘部、小臂和腕部都会跟着走；如果逐个转 mesh，零件之间的父子关系就会散掉，看起来像一堆零件在原地打转。夹爪的手指没有用旋转，而是改 `basePos` 的 z 偏移，再把结果交给爆炸函数，保证"开合"和"爆炸"能同时存在。

这里有个顺序问题：关节和爆炸都会改零件位置，所以必须先更新关节，再调用 `applyExplodedState()`。否则爆炸位移会基于上一帧的关节姿态，拖滑杆时零件会跳一下。数字孪生和普通动画的区别也在这里：动画可以随便摆姿势，孪生要保证每个零件的父子关系和装配基准始终一致。

自动巡航和归零姿态也复用同一套状态。巡航时动画循环用正弦函数连续写入六个关节角和夹爪行程，本质上还是改 `state.joints`；归零姿态则把关节角清零、夹爪回到 50%，再走一次 `applyJointKinematics()`。所以巡航、手动滑杆和归零不会各写一套旋转逻辑，停下来时状态也是连续的。

## 三、爆炸图：目标值加帧插值

![100% 爆炸图](https://www.sakurajh.xyz/assets/images/aero-6x/robot-arm-exploded.jpg)

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:-6px">100% 爆炸：外壳、减速器和末端按各自方向分离，虚线保留装配基准。</p>
爆炸不是把零件随机推远，而是给每个可分离件一个 `explodeVec`，再乘上总体系和分组权重：

```js
function applyExplodedState() {
  const f = state.explodeFactor;
  explodableItems.forEach((item) => {
    let mult = 1.0;
    if (item.explodeType === 'shell') mult = state.expShellMult;
    else if (item.explodeType === 'gear') mult = state.expGearMult;
    else if (item.explodeType === 'gripper') mult = state.expGripperMult;

    const eff = f * mult;
    item.mesh.position.copy(item.basePos)
      .addScaledVector(item.explodeVec, eff);

    if (item.guideLine) {
      const showLine = state.showExplodeLines && eff > 0.02 && item.mesh.visible;
      item.guideLine.visible = showLine;
      if (showLine) {
        const p = item.guideLine.geometry.attributes.position.array;
        p[0] = item.basePos.x; p[1] = item.basePos.y; p[2] = item.basePos.z;
        p[3] = item.mesh.position.x; p[4] = item.mesh.position.y; p[5] = item.mesh.position.z;
        item.guideLine.geometry.attributes.position.needsUpdate = true;
        item.guideLine.computeLineDistances();
      }
    }
  });
}
```

外壳、减速器、末端三组有独立的分离权重。这不是装饰：外壳是径向拆、减速器是轴向拆、末端是沿法兰方向拆，统一乘一个系数，某些零件就会穿模。引导虚线的两个端点也要每帧跟着更新，否则爆炸后线还停在原位，看起来像零件被"粘"在空气里。

需要说明的是，当前动画循环用的是固定插值系数 `0.12`：

```js
state.explodeFactor += (state.targetExplodeFactor - state.explodeFactor) * 0.12;
```

它在 60 帧下很顺，但在低帧率设备上会明显变慢，因为每帧只追 12%，帧数少了收敛就慢。如果重写这一段，我会换成 `1 - Math.exp(-k * delta)`，让收敛速度和帧率无关。这也是我在录演示时把等待时间拉长的原因：不是模型卡，是插值在软件渲染下走得慢。

## 四、透明外壳：材质和图层分开管

![22% 透明外壳](https://www.sakurajh.xyz/assets/images/aero-6x/robot-arm-xray.jpg)

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:-6px">22% 透视：外壳成为玻璃态，电机、减速器和线束保持不透明。</p>
外壳有四种模式：实体、22% 透视、线框和剥离。实现上只改外壳材质和图层可见性，不碰内部零件：

```js
function applyShellAndLayerState() {
  const mode = state.shellMode;
  const opacity = state.shellOpacity;

  shellMaterials.forEach((mat) => {
    if (mode === 'solid') {
      mat.wireframe = false;
      mat.transparent = opacity < 0.99;
      mat.opacity = opacity;
      mat.depthWrite = opacity > 0.65;
    } else if (mode === 'xray') {
      mat.wireframe = false;
      mat.transparent = true;
      mat.opacity = opacity;
      mat.depthWrite = false;
    } else if (mode === 'wireframe') {
      mat.wireframe = true;
      mat.transparent = true;
      mat.opacity = Math.max(0.35, opacity);
      mat.depthWrite = false;
    }
    mat.needsUpdate = true;
  });

  const showShell = (mode !== 'hidden') && (opacity > 0.01);
  layerGroups.shells.forEach(m => { m.visible = showShell; });
  layerGroups.motors.forEach(m => { m.visible = state.visMotors; });
  layerGroups.gears.forEach(m => { m.visible = state.visGears; });
  layerGroups.skeleton.forEach(m => { m.visible = state.visSkeleton; });
  layerGroups.cables.forEach(m => { m.visible = state.visCables; });
}
```

| 模式 | 外壳透明度 | 线框 | 适用场景 |
|---|---|---|---|
| 实体 | 100% | 否 | 看外观和标注 |
| 透视 | 22% | 否 | 看电机、减速器和线束 |
| 线框 | 55% | 是 | 看外壳拓扑和分件 |
| 剥离 | 0% | 否 | 只看骨架与内部件 |

透视时把 `depthWrite` 关掉，能减少多层外壳互相遮挡产生的排序闪烁；内部零件的 `visible` 则由四个图层开关单独控制。这样"外壳透明"和"内部件显隐"是两条独立的链路，不会出现打开电机就顺带把外壳也改掉的情况。

透明度滑杆也不是直接去改 `scene` 里的所有材质，而是只遍历 `shellMaterials`。因为每个外壳件在建模时就登记过，内部电机和减速器用的是另一组材质；如果图省事遍历全场景，拖到 22% 时连电机也变透明，透视就失去意义了。

## 五、剖面：一个平面挂到所有材质

![Z 轴剖面](https://www.sakurajh.xyz/assets/images/aero-6x/robot-arm-section.jpg)

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:-6px">Z 轴剖面：裁剪面切掉近侧壳体，配合剖面辅助面观察内腔。</p>
剖面用的是 Three.js 的局部裁剪面。先算方向和偏移，再把同一个平面挂到场景里所有需要被切的材质上：

```js
function applySectionState() {
  const enabled = state.sectionEnabled;
  const axis = state.sectionAxis;
  const sign = state.sectionFlip ? 1 : -1;
  const offset = state.sectionOffset;

  if (axis === 'x') clippingPlane.normal.set(sign, 0, 0);
  else if (axis === 'y') clippingPlane.normal.set(0, sign, 0);
  else clippingPlane.normal.set(0, 0, sign);

  clippingPlane.constant = -sign * offset;

  const activePlanes = enabled ? [clippingPlane] : [];
  allClipMaterials.forEach((mat) => {
    mat.clippingPlanes = activePlanes;
    mat.needsUpdate = true;
  });

  sectionHelperGroup.visible = enabled && state.showSectionHelper;
  if (enabled) {
    sectionHelperGroup.position.set(0, 3.0, 0);
    if (axis === 'x') {
      sectionHelperGroup.position.x = offset;
      sectionHelperGroup.rotation.y = Math.PI / 2;
    } else if (axis === 'y') {
      sectionHelperGroup.position.y = offset;
      sectionHelperGroup.rotation.x = Math.PI / 2;
    } else {
      sectionHelperGroup.position.z = offset;
    }
  }
}
```

裁剪面必须挂到 `allClipMaterials`，也就是包括外壳、电机、减速器和骨架在内的全部材质。只挂外壳的话，切完会看到一个空心壳，内部零件完好地悬在空中，反而更假。方向翻转只是把法线取反，同时把 `constant` 一起变号，这样滑杆的正负和屏幕上切掉的一侧才能对得上。

## 六、标注与检视：把 3D 点投到 2D

六个总成标注不是 3D 精灵，而是普通的 DOM 按钮。每帧把锚点的局部坐标转到世界坐标，再投影到屏幕：

```js
function updateAnnotations() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const worldPos = new THREE.Vector3();

  annotationPins.forEach((pin) => {
    if (!state.showAnnotations) { pin.el.style.display = 'none'; return; }

    worldPos.copy(pin.localOffset);
    pin.anchorObj.localToWorld(worldPos);
    worldPos.project(camera);

    if (worldPos.z > 1.0 || worldPos.z < -1.0) {
      pin.el.style.display = 'none';
      return;
    }
    const x = (worldPos.x * 0.5 + 0.5) * w;
    const y = (-worldPos.y * 0.5 + 0.5) * h;
    pin.el.style.display = 'flex';
    pin.el.style.left = `${x}px`;
    pin.el.style.top = `${y}px`;
  });
}
```

用 DOM 的好处是文字始终清晰、能直接点击，也能被键盘访问；代价是每帧都要同步位置。点击标注或模型后，`selectPart()` 会把材料、层级、峰值扭矩等字段写进左下角的检视器。页面里的扭矩、负载和 ±0.02 mm 是演示用的标称字段，不是对实物的实测，这一点我在 README 里也写明了。

模型的点击用 Raycaster，命中后先过滤不可见物体，再判断命中点是否在裁剪面的保留侧。如果剖面已经切掉了这一块，但射线还打在被切掉的几何上，用户就会选中一个屏幕上根本不存在的零件。这一步和裁剪面共用同一个 `clippingPlane.distanceToPoint()`，所以透视、剖面和点选不会互相矛盾。

### 交付：依赖本地化，双击就能跑

![部件检视器](https://www.sakurajh.xyz/assets/images/aero-6x/robot-arm-inspector.jpg)

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:-6px">点击“04 肘部”标注后，检视器显示材料、层级与峰值扭矩字段。</p>
这个页面最初从 CDN 加载 Three.js r128、Tailwind 运行时和 Google Fonts。为了让实验室的离线机器和博客读者都能直接打开，我把三样都放进了 `vendor/`：Three.js 和 Tailwind 运行时是本地 JS，Inter 和 JetBrains Mono 只保留拉丁字形，中文回退到系统字体。改完后用 `file://` 打开，监听网络面板确认没有外部请求，控制台也没有应用报错。

交付物是一个 53 秒的功能演示、一个约 16 秒的模式 GIF，以及仓库里的 `index.html` 和 `vendor/`。演示是在 1600×900 下逐项操作录的：关节滑杆、自动巡航、100% 爆炸、22% 透视、Z 轴剖面、部件检视和一键复位。

- 在线演示：<https://www.sakurajh.xyz/aero-6x-digital-twin/>
- 源码与离线包：<https://github.com/sakurajh/aero-6x-digital-twin>
- 完整演示视频：<https://www.sakurajh.xyz/aero-6x-digital-twin/demo/aero-6x-demo.mp4>

下一步我想把关节运动换成带加减速的轨迹规划，再补一个"示教点位"功能：把几个姿态存下来，按顺序回放。这样它会更像真正的数字孪生，而不只是一个能拖滑杆的模型。

