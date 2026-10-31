---
layout: post
title: "Three.js 单文件离线机械臂工作台：爆炸图、透明外壳与剖面"
date: 2026-10-24 14:25:00 +0800
categories: 项目
tags: Three.js WebGL 机械臂 前端 esbuild
description: "从结构教学演示的需求出发，用 Three.js 程序化生成六轴机械臂的 48 个零件，把爆炸图、透明外壳与 X/Y/Z 剖面统一到同一个状态机，再用 esbuild 内联 Three.js 和 CSS，打成一个断网也能双击运行的 HTML，"
---

上周给学弟讲实验室那台六轴机械臂，我指着肩部那圈橙色问他："这是电机还是关节？"他犹豫了半天。我想打开 SolidWorks 转个角度，结果装配体在老机器上加载了好一会儿；就算打开了，也没法当场把外壳拆开，让他看到里面的减速器和传动轴。

这次之后我一直觉得，讲结构这件事，CAD 不是最合适的载体：文件重、依赖软件、发给别人还不一定打得开。我想要的是一个打开浏览器就能转、能拆、能剖的教具，最好断网也能用——实验室的工控机经常不联网。

于是有了这个项目：六轴机械臂结构工作台。48 个可点选零件、8 个总成，支持完整装配、爆炸图、透明外壳和 X/Y/Z 剖面，最后打成一个双击就能运行的 `index.html`。文末是在线演示和 33 秒录屏。

<video controls preload="metadata" poster="https://www.sakurajh.xyz/assets/images/robot-arm-workbench/robot-arm.jpg" src="https://www.sakurajh.xyz/robot-arm-structure-workbench/demo/robot-arm-demo.mp4" style="width:100%;border-radius:4px;background:#0b0f11"></video>

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:8px">33 秒演示：旋转观察 → 零件拾取 → 总成聚焦 → 爆炸图 → 透明外壳 → Z 轴剖面 → 一键复位</p>


## 一、先定边界：不做 CAD，只做教具

![六轴机械臂完整装配视图](https://www.sakurajh.xyz/assets/images/robot-arm-workbench/robot-arm.jpg)

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:-6px">完整装配模式。左侧是 8 个总成，右侧切换四种查看方式。</p>

动手前我把范围写死：模型程序化生成，不导入 GLB/STEP；不做关节运动仿真和物理仿真；不做后端和账号；最终产物是一个 HTML，运行时不发任何网络请求。

这个取舍很关键。如果一开始就想着"导入真实 CAD 模型"，光模型轻量化、材质、坐标系对齐就够耗一周，而且教学演示并不需要工程级尺寸精度。程序化模型反而有好处：每个零件的 ID、中文名、所属总成、爆炸方向都在代码里，点选和讲解可以精确到"肩部减速器"这种粒度，而不是"某个 mesh"。

模型按 8 个总成组织：固定底座、一轴回转台、二轴肩关节、大臂总成、三轴肘关节、四轴小臂总成、五轴腕关节、六轴末端夹具。每个总成是一个 `Group`，零件挂在下面；外壳零件在注册时单独记进 `shellMeshes`，后面透明模式要用。48 个零件都带 `userData.partId`，Raycaster 命中后就能反查到名称、总成和说明。

配色也没有散落在各处。整机只有五种基础材质：象牙白外壳、橙色关节环、深色金属、银色电机、黑色夹具。每个零件注册时克隆一份，所以 48 个零件仍然只有五套参数要维护，改配色不会牵一发动全身，同时又能单独改某个零件的透明度而不影响同材质的其他零件。

## 二、四个模式共用一个状态机

最容易写乱的地方，是四个模式各自改场景。爆炸图改了零件位置，透明模式改了材质，剖面模式又改了裁剪面，切换时如果没人负责清理，就会留下"半爆炸 + 透明 + 还在剖"的混合状态。我把它收成一个纯函数 reducer：

```js
export const initialViewState = Object.freeze({
  mode: 'assembly', explosion: 0, shellTransparency: 0,
  clipAxis: 'x', clipPosition: 0, selectedPart: null
});

export function reduceViewState(state, action) {
  switch (action.type) {
    case 'SET_MODE': return { ...state, mode: modes.has(action.mode) ? action.mode : 'assembly' };
    case 'SET_EXPLOSION': return { ...state, explosion: clamp(action.value) };
    case 'SET_SHELL_TRANSPARENCY': return { ...state, shellTransparency: clamp(action.value) };
    case 'SET_CLIP_AXIS': return { ...state, clipAxis: axes.has(action.axis) ? action.axis : 'x' };
    case 'SET_CLIP_POSITION': return { ...state, clipPosition: clamp(action.value, -1, 1) };
    case 'SELECT_PART': return { ...state, selectedPart: action.partId ?? null };
    case 'RESET': return createViewState();
    default: return state;
  }
}
```

这样做有三个直接收益：所有越界值在入口就被夹住；"一键复位"只是 dispatch 一个 `RESET`，不用逐个模块清理；状态机不碰 DOM 和 Three.js，单元测试不需要 WebGL。

UI 层只负责把按钮和滑块翻译成 action，显示控制器只负责把 state 落到场景，两边都不保存自己的状态。这样从爆炸图直接切到剖面图，也不会出现"爆炸位移没归零"的残留；选中零件与当前模式解耦，切模式时说明面板不会被清空。

四个模式的分工如下：

| 模式 | 实际改动 | 可调参数 |
|---|---|---|
| 完整装配 | 不改几何，只做拾取与相机聚焦 | 无 |
| 爆炸图 | 零件位置 = 基准位置 + 爆炸向量 × 比例 | 爆炸距离 0–100% |
| 透明外壳 | 外壳材质的透明度与 `depthWrite` | 外壳透明度 0–100% |
| 剖面图 | 所有材质的 `clippingPlanes` | X/Y/Z 轴、剖切位置 |

## 三、爆炸图：按装配方向走，不要随机散开

![机械臂爆炸图](https://www.sakurajh.xyz/assets/images/robot-arm-workbench/robot-arm-exploded.jpg)

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:-6px">爆炸图 65%：总成沿各自的装配方向分离，底座保持不动。</p>

随机给每个零件加一个方向，看起来也会"炸开"，但看不出装配关系。我的做法是给 8 个总成各定一个方向，例如回转台沿 Z 向后、肩关节沿 X 向左、大臂向上、肘关节向前、腕部和夹具向右，然后零件的爆炸向量 = 总成向量 + 自己的小偏移。底座固定不动，作为参照。

每帧只做一次插值，用指数阻尼让运动与帧率无关：

```js
const target = basePosition.clone();
if (state.mode === 'exploded') {
  target.addScaledVector(part.explodeVector, explosion);
}
part.object.position.lerp(target, 1 - Math.exp(-12 * delta));
```

`1 - Math.exp(-12 * delta)` 这一项，在 60 帧和 120 帧下衰减速度一致；如果直接写 `lerp(target, 0.2)`，高刷屏上会明显更快。滑块拖动时只改比例，位移仍然由这条插值追上去，所以既有即时反馈，又不会瞬移。滑杆对外显示 0–100%，状态里存 0–1，单位转换只发生在 UI 边界，测试和渲染都用同一套数值，不会出现"65 还是 0.65"的歧义。

## 四、透明外壳：内部必须保持实体

![机械臂透明外壳](https://www.sakurajh.xyz/assets/images/robot-arm-workbench/robot-arm-shell.jpg)

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:-6px">透明外壳 75%：外壳变透明，内部电机、减速器和传动轴保持不透明。</p>

透明模式失败最常见的样子，是整机一起变半透明，内部电机也跟着淡掉，最后什么都看不清。我在建模阶段就把外壳材质单独登记，切换时只动这一组：

```js
const transparent = state.mode === 'shell' && transparency > 0;
for (const material of shellMaterials) {
  if (material.transparent !== transparent) {
    material.transparent = transparent;
    material.needsUpdate = true;
  }
  material.opacity = 1 - transparency;
  material.depthWrite = !transparent;
}
for (const material of internalMaterials) material.opacity = 1;
```

两个细节值得说。第一，每个零件的材质在注册时都 `clone()` 过，所以改外壳不会把内部零件一起染色；第二，透明时把 `depthWrite` 关掉，能减少多层外壳互相遮挡产生的闪烁，但内部材质始终 `opacity = 1`，电机、减速器和传动轴仍然是不透明的实体。`needsUpdate` 只在"是否透明"翻转时置位，拖滑块改透明度不需要反复重编译材质。

## 五、剖面图：裁剪面要挂到所有材质上

![机械臂 Z 轴剖面](https://www.sakurajh.xyz/assets/images/robot-arm-workbench/robot-arm-section.jpg)

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:-6px">Z 轴剖面：裁剪面切掉近侧外壳，露出内部传动结构。</p>

剖面用的是 Three.js 的局部裁剪面。渲染器先打开 `localClippingEnabled`，然后根据当前轴创建一个平面，法线取正轴的反方向，常数由滑杆位置映射到模型尺度：

```js
plane.normal.set(...axisNormals[state.clipAxis]); // x:[−1,0,0] y:[0,−1,0] z:[0,0,−1]
plane.constant = state.clipPosition * 4;

const assigned = activeClipAxis ? [plane] : [];
for (const material of materials) {
  material.clippingPlanes = assigned;
  material.clipShadows = Boolean(activeClipAxis);
}
```

这里踩过一个坑：一开始我只把裁剪面挂给外壳，结果切开后内部零件完好无损地悬在空中，看起来像一个空心壳。裁剪必须覆盖场景里所有材质，包括内部电机和传动轴，切面才是真实的。另外 `clipShadows` 要跟着开，否则地面阴影还是完整的；剖面辅助线用 `PlaneHelper` 画出来，同时把它的 `raycast` 置空，避免点选时命中辅助线。

## 六、单文件与离线验证

构建用 esbuild 把 `main.js`、Three.js 和 OrbitControls 打成一个 IIFE，再把 CSS 和 JS 内联进模板。注意 `replace` 要传函数而不是字符串，否则压缩后的代码里出现 `$&` 这类片段时会被当成替换模式：

```js
const result = await build({
  entryPoints: ['src/main.js'], bundle: true, minify: true,
  format: 'iife', target: ['es2020'], write: false
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = template
  .replace('/* INLINE_CSS */', () => css)
  .replace('/* INLINE_JS */', () => js);
```

"离线可用"不能只靠断网试一次。浏览器测试会把**只有 `index.html`** 的临时目录用 `file://` 打开，监听所有请求并断言没有 http(s) 外部请求，同时收集 `pageerror` 和控制台错误；WebGL2 降级则用 `addInitScript` 让 `getContext('webgl2')` 返回 `null`，检查提示文案是否出现、有没有未捕获异常。测试结果：13 项单元测试、16 项真实浏览器测试全部通过。

| 检查项 | 验证方式 |
|---|---|
| 单文件 | 临时目录只复制 `index.html`，`file://` 打开 |
| 无外链 | 监听 request，断言不存在 http(s) 请求 |
| 四种模式 | 断言爆炸位移、外壳 0.25 / 内部 1、Z 轴裁剪生效 |
| 窄屏 | 390×844 下展开底部面板，复位按钮可达 |
| WebGL 降级 | 屏蔽 `webgl2` 上下文，断言提示可见且无报错 |
| 空闲性能 | 断言无动画时停止 RAF，交互后恢复 |

![窄屏下的底部抽屉](https://www.sakurajh.xyz/assets/images/robot-arm-workbench/robot-arm-narrow.jpg)

<p style="text-align:center;color:#8b9795;font-size:13px;margin-top:-6px">390×844 窄屏：面板折叠为底部抽屉，3D 视口保持可见。</p>


最后一项是我比较在意的：场景只在有动画或相机变化时渲染，静止时不空转。对教学演示这种"打开后放着讲"的场景，长期占用 GPU 没有意义。

拾取也做了同样的边界处理：`pointerup` 时如果指针移动超过 5 像素，就判定为拖拽旋转而不是点击，避免转完相机误选零件；点空白处则清空选中。高亮不是换材质，而是记录每个 mesh 原来的自发光颜色，选中时改成橙色，换选或复位时原样恢复，这样不会破坏外壳透明和剖面模式下的材质状态。

### 演示与使用

完整流程是：完整装配下旋转观察 → 点击零件看说明 → 左侧总成聚焦 → 爆炸图拉到 65% → 透明外壳拉到 75% → Z 轴剖面 → 一键复位。我录了一段 33 秒的无声演示，可以直接看操作节奏。

- 在线演示：<https://www.sakurajh.xyz/robot-arm-structure-workbench/>
- 源码与单文件下载：<https://github.com/sakurajh/robot-arm-structure-workbench>
- 演示视频：<https://www.sakurajh.xyz/robot-arm-structure-workbench/demo/robot-arm-demo.mp4>

如果只是想在课上或组会上讲结构，直接下载仓库里的 `index.html` 双击即可，不需要 Node.js、服务器或网络。模型是按教学示意生成的，不宣称工程级尺寸和装配精度；如果要继续做，我会先加关节运动学和 GLB 导入，让"看结构"和"看运动"能放在同一个页面里。

