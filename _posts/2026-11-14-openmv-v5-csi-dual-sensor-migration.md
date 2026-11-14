---
layout: post
title: "OpenMV V5 的 CSI 模块：从 sensor 迁移到彩色+热成像双摄"
date: 2026-11-14 11:00:00 +0800
categories: 硬件设计
tags: OpenMV CSI 热成像 MicroPython 嵌入式视觉
description: "十月做的 OpenMV 颜色追踪要加一路热成像，才发现旧的 sensor 模块只能控制一个隐藏实例。这篇记录迁移到 V5 CSI 模块的过程，包括对象化配置、帧缓冲数量、cid 选传感器和几个调试习惯。"
---

十月我给小车做了一套颜色追踪：OpenMV 负责找色块，结果从串口转成 WebSocket 丢给网页，当时那篇《把 OpenMV 的识别结果接到网页上》写的就是这件事。单摄一直挺稳，直到我想给它加一路热成像，用来看电机和电池有没有异常发热。

问题出在接口上。`sensor` 模块是一组模块级函数，所有调用都作用在一个隐藏的传感器实例上。OpenMV 文档里对这个限制写得很直接：它只适合单摄板子，对有两个摄像头的板子支持有限。彩色加热成像、彩色加事件相机这类板子，每路传感器都需要独立的曝光、增益、像素格式和窗口配置，模块级函数做不到。

V5.0.0 固件换了新接口：`csi` 模块把每个物理传感器变成一个对象。V5.0.0 是 2026 年 7 月发布的，现在 v5.0.1 的文档里 `sensor` 已经被标记为传统接口，新代码应该用 `CSI`。

## 为什么必须对象化

`csi.CSI()` 构造出来的是一个具体传感器的句柄，像素格式、帧尺寸、窗口、曝光、增益、白平衡、镜像翻转、帧缓冲数量全挂在对象上。单摄板子只建一个对象；双摄板子建两个，靠构造参数 `cid` 区分，`cid=-1` 表示主摄。

这个区别在单摄项目里感觉不明显，一旦上双摄就绕不过去：热成像的像素格式、帧率和彩色摄像头完全不同，不可能共用一个隐藏实例。举个具体的：彩色摄像头在室内需要较长曝光，热成像模块输出固定尺寸的灰度图，两者对 `auto_exposure` 和 `pixformat` 的要求根本不同。共用一个隐藏实例时，后配置的那路会把前一路的设置覆盖掉，画面表现就是彩色图忽明忽暗。换句话说，V5 不只是把函数改了个名字，而是把"配置属于谁"这件事说清楚了。

## 迁移前后对照

我先把单摄脚本迁过去验证。方法名基本一一对应，只是从 `sensor.xxx()` 变成 `csi0.xxx()`。对照表如下：

| 旧接口（sensor） | 新接口（csi） |
|---|---|
| `sensor.reset()` | `csi0 = csi.CSI()` 加 `csi0.reset()` |
| `sensor.set_pixformat(sensor.RGB565)` | `csi0.pixformat(csi.RGB565)` |
| `sensor.set_framesize(sensor.QVGA)` | `csi0.framesize(csi.QVGA)` |
| `sensor.skip_frames(time=2000)` | `csi0.snapshot(time=2000)` |
| `sensor.snapshot()` | `csi0.snapshot()` |
| `sensor.set_auto_gain(False)` | `csi0.auto_gain(False)` |

迁移后的颜色追踪主循环：

```python
import csi
import time

csi0 = csi.CSI()          # cid 默认 -1，选主摄
csi0.reset()              # 硬复位，给传感器一个已知起点
csi0.pixformat(csi.RGB565)
csi0.framesize(csi.QVGA)
csi0.snapshot(time=2000)  # 先跑 2 秒，等自动白平衡和增益稳定

csi0.auto_gain(False)
csi0.auto_whitebal(False)  # 调色块阈值前，这两个必须关

thresholds = [(30, 100, 15, 127, 15, 127)]  # LAB 红色范围
clock = time.clock()

while True:
    clock.tick()
    img = csi0.snapshot()
    for blob in img.find_blobs(thresholds, pixels_threshold=200):
        img.draw_rectangle(blob.rect)
        img.draw_cross((blob.cx, blob.cy))
    print(clock.fps())
```

`skip_frames` 换成 `snapshot(time=2000)` 这一步值得说清楚：新接口的 `snapshot` 接受 `time` 和 `frames` 两个参数，表示先采集这么长时间或这么多帧再返回，等待期间返回 `None`。它和 `skip_frames` 的语义一样——不是暂停，而是持续采帧丢弃，让自动曝光收敛。

还有一个容易忽略的变化：V5 的 Image 模块全面改用 MicroPython 的参数解析器，函数调用不再接受错误的关键字或位置参数。以前某些写错的调用可能被悄悄忽略，现在会直接报参数错误。迁移阶段这是好事，能逼出所有想当然的调用；但也意味着从旧博客抄来的代码不能无脑跑。

顺带说一句构造参数。`csi.CSI()` 除了 `cid`，还有 `delays` 和 `fflush` 两个不常用的开关。`delays=False` 会关掉驱动在复位、切换模式后的等待，适合把一串配置攒在一起最后统一等一次；`fflush=False` 关掉帧缓冲的自动清理，给排队中的帧去掉时间上限。这两个默认值就是大多数人想要的行为，迁移时一般不用动，但读文档时别被它们绕晕。

## 帧缓冲：别在改分辨率时把帧率改没了

我第一次迁移后帧率掉得厉害。原因不在算法，而在我加了一句 `framebuffers(1)` 想省内存。

`framebuffers()` 控制驱动程序接收图像用几块缓冲，取值 1、2、3，或者 4 及以上进入视频 FIFO 模式。要注意：每次调用 `pixformat`、`framesize`、`window` 都会触发重新分配，代码里如果顺序不对，前面的设置会被重算。

| 缓冲数 | 行为 | 适合场景 |
|---|---|---|
| 1 | 单缓冲，采集和处理共用一块内存，处理时没有新帧可收 | 内存极紧的单张拍照 |
| 2 | 双缓冲，处理当前帧时 DMA 可以写下一帧 | 常规追踪循环 |
| 3 | 三缓冲，处理时间波动大时更顺 | 图像处理偶尔变慢 |
| 4 及以上 | 视频 FIFO，掉帧时清掉除当前帧外的旧缓冲 | 连续存 SD 卡 |

内存可以自己算：QVGA（320×240）RGB565 每像素 2 字节，一帧约 150 KB，三缓冲就是 450 KB 左右。H7 Plus 这类带外部 SDRAM 的板子不心疼，但小内存板子就要权衡。我的做法是追踪循环用双缓冲，录视频时才开 FIFO。

调分辨率或窗口之后，如果帧率不对，先打印 `csi0.framebuffers()` 看实际值，不要假设它还是你设的那个数。

## 窗口和自定义帧尺寸不是一回事

除了 `framesize` 的预设尺寸，还有两条路：`window((w, h))` 在当前分辨率上取一个居中子区域，也可以传 `(x, y, w, h)` 指定位置；`framesize((w, h))` 则是直接要一个自定义输出尺寸。两者的区别在数据通路——窗口是在传感器输出的整幅图上裁，适合"我只看画面中间一块"的追踪；自定义帧尺寸是让传感器按新尺寸出图，读出的像素本来就少。

文档里有两个硬约束值得记住：自定义帧尺寸要满足 DMA 的对齐规则，通常是 8 像素和 16 字节的整数倍；传感器读出窗口越小，帧率越高，但视野也越小。我一开始用 `framesize((400, 300))` 想要一个 4:3 的小画面，实际构图和预期对不上，后来改成 `window((400, 400))` 才对准取景框。这个坑不涉及代码报错，纯粹是没分清"裁剪"和"重设输出"。

## 双摄：cid 和软复位

回到最初的需求，加一路热成像。代码结构变成两个对象：

```python
rgb = csi.CSI()          # 主摄
rgb.reset()
rgb.pixformat(csi.RGB565)
rgb.framesize(csi.QVGA)

ir = csi.CSI(cid=csi.LEPTON)  # 按芯片 ID 选择热成像
ir.reset(hard=False)          # 和主摄共用 RESET 引脚，不能硬复位
ir.pixformat(csi.GRAYSCALE)
ir.framesize(csi.QQVGA)

while True:
    color_img = rgb.snapshot()
    ir_img = ir.snapshot()
    # 彩色图找色块，灰度图看温度分布
```

`reset(hard=False)` 是关键细节。文档写得很明确：辅助传感器如果和主摄共用 RESET 引脚，硬复位会把主摄一起复位掉，所以第二次及以后只能软复位。我第一次没注意，现象是热成像一初始化，彩色图也跟着黑一下。

另一个参数是 `stream`。IDE 预览一次只能显示一路，`stream=True` 指定哪路作为预览源。部署到小车上没有 IDE，这个参数不影响采集，但调试双摄时别把"预览里没变"误判成"另一路没工作"。

还要接受一个物理事实：两次 `snapshot()` 是顺序执行的，彩色和热成像不是同一时刻曝光。做双光融合时，这个时间差要么用同步触发解决，要么在算法上容忍。

## 三个保留下来的调试习惯

第一，先开 `colorbar(True)`。彩色条能正常显示，说明传感器、数据总线和 ISP 链路是通的，问题只可能在阈值或算法。这比一上来就怀疑镜头和光照省时间。

第二，调色块前一定关自动增益和自动白平衡。文档专门提醒过，只关增益不关白平衡，颜色照样会漂。我现在的顺序固定为：等稳定、关 AGC、关 AWB、再取阈值。

第三，排查"卡帧"用非阻塞采样。`snapshot(blocking=False)` 在没准备好新帧时返回 `None`，配合 `readable()` 可以判断到底是没帧、还是处理太慢：

```python
if csi0.readable():
    img = csi0.snapshot(blocking=False)
else:
    img = None  # 这一轮先做别的事
```

如果非阻塞模式经常拿不到帧，先回头看帧缓冲是不是设成了单缓冲。

## 小结

如果手上已经有旧脚本，我建议按这个顺序迁：先把所有 `sensor.xxx` 换成 `csi0.xxx`，跑通主循环；再检查 `skip_frames` 是否都换成了 `snapshot(time=...)`；然后确认调阈值前关了 AGC 和 AWB；最后才加第二路传感器。这个顺序的好处是每一步只有一个变量，出问题能定位。反过来先写双摄再回头调单摄，一旦画面不对，分不清是接口迁移错了还是 `cid` 选错了。

这次迁移的结论很朴素：新项目直接用 `csi`，`sensor` 只当兼容层看；单摄迁移就是换方法名，双摄迁移重点是 `cid` 和软复位；帧缓冲数量要和分辨率、处理耗时一起考虑，改配置后打印实际值确认。OpenMV 的硬件设计明显在往多传感器方向走，早点把配置绑到对象上，后面加第二路传感器时就不用重写主循环。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

