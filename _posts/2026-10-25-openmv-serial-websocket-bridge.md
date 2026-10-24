---
layout: post
title: "把 OpenMV 的识别结果接到网页上：串口转 WebSocket 的最小闭环"
date: 2026-10-25 06:02:00 +0800
categories: 项目
tags: OpenMV WebSocket Python 串口通信 asyncio
description: "OpenMV 在本机识别色块，但想在浏览器里实时看到框。本文用 Python 搭一个串口转 WebSocket 的桥，讲清协议怎么定、慢客户端怎么丢帧、前端怎么画，以及端口占用等实际坑。"
---

上周调 OpenMV 的巡线，摄像头架在车上，笔记本离得很远。OpenMV IDE 里能看画面和色块框，但一旦把串口交给主控，IDE 就得断开，等于画面和实际运行状态二选一。我想要的其实很简单：板子照常跑自己的程序，笔记本浏览器里开一个页面，实时看到识别出的矩形框。不用装 Qt，不用写桌面程序，换台电脑打开网页就能看。

一开始我试着让浏览器直接读串口，很快就放弃了。Web Serial 只能用在那几个 Chromium 内核的浏览器里，页面必须是 localhost 或 HTTPS，而且串口在 Windows 上同一时刻只能被一个进程打开，OpenMV IDE 开着就抢不过来。更麻烦的是刷新页面之后端口要重新授权，调试时刷新是家常便饭。

最后的做法是把问题拆成两半：OpenMV 只管往串口写识别结果，Python 起一个小进程把串口数据转成 WebSocket 广播出去，网页只负责连上和画框。整个项目四个文件，加起来一百多行，跑起来就再没换过方案。

## 为什么不直接在浏览器里读串口

把识别结果送到浏览器，常见有三条路，我实际都试过，差别比想象中大。

| 方案 | 依赖 | 能否在画面上叠加框 | 页面刷新/断线 | 适合的场景 |
|---|---|---|---|---|
| Web Serial | Chromium 内核浏览器、HTTPS 或 localhost | 能，但要自己解析字节流 | 需要重新点选端口授权 | 临时调试，只在一台机器上 |
| MJPEG 推流 | OpenMV 端持续输出 JPEG、带宽较高 | 不能，得在 OpenMV 端把框画进图里 | 推流进程断了要重开 | 只想看画面，不需要结构化数据 |
| 串口转 WebSocket | Python + pyserial + websockets | 能，拿到的是坐标 | 前端自动重连即可 | 长期运行、多台设备看同一份数据 |

我选第三条，核心理由是它保留了"结构化数据"这个属性。坐标是数字，网页想画框就画框，想画热力图就画热力图，想存下来做回放也行。MJPEG 把框烧进像素里，前端就再也拿不到坐标了，改一次样式要重新烧一次固件。Web Serial 虽然也是结构化数据，但它的授权模型和"同一时间只能有一个进程持有串口"这两点，让它在有 IDE 参与调试时很难用。

另外一个现实原因是解耦。桥接进程和网页之间走的是本机 WebSocket，同局域网里换一台机器，把地址里的 127.0.0.1 换掉就能看。OpenMV 那边完全不知道浏览器存在，它只是往串口写一行行文本。

## 协议：一行一个 JSON

协议定得好，后面两头都省事。我用的规则只有一条：**一行一个 UTF-8 JSON，以换行结尾**。

选行分隔而不是固定长度或二进制包头，是因为它自带同步能力。串口刚打开时双方状态不一致，读到的第一行很可能是半截，解析失败的丢掉就行，下一行自然从换行符之后开始，不需要额外的握手和对齐逻辑。我在串口助手里也能直接看明文，调阈值时不用另写解析工具。

代价是要防一行过长。如果波特率不匹配或者线接触不良，读到的可能是连续乱码，没有一个换行，缓存会一直涨。所以桥接进程里我限制单行最大长度，超过就直接丢，重新找下一个换行。

OpenMV 端用 MicroPython，把坐标归一化到 0 到 1，这样网页不用知道分辨率：

```python
import sensor, image, time, json
from pyb import UART

sensor.reset()
sensor.set_pixformat(sensor.RGB565)
sensor.set_framesize(sensor.QVGA)
sensor.skip_frames(time=2000)

uart3 = UART(3, 115200)
thresholds = [(30, 100, 15, 127, 15, 127)]  # L A B 阈值，按现场光调
clock = time.clock()
frame = 0

while True:
    clock.tick()
    img = sensor.snapshot()
    blobs = img.find_blobs(thresholds, pixels_threshold=200,
                           area_threshold=200, merge=True)
    frame += 1
    if frame % 2:
        continue  # 每两帧发一次，给串口留余量

    w, h = img.width(), img.height()
    rects = []
    for b in blobs[:5]:
        rects.append({
            "x": round(b.x() / w, 3),
            "y": round(b.y() / h, 3),
            "w": round(b.w() / w, 3),
            "h": round(b.h() / h, 3),
        })
    uart3.write(json.dumps({"blobs": rects}) + "\n")
```

两处有意的克制。第一，最多只发 5 个框，色块一多，JSON 变长，串口带宽会被吃掉；真正的目标不会超过几个，多出来的对调试没有价值。第二，每两帧发一次。串口 115200 大约每秒能传一万多字节，一帧几 KB 的图传不了，但一行一百多字节的结果绰绰有余；限流是为了以后加字段时不至于把链路塞满。归一化还有个副作用：以后换 QQVGA 或 VGA，前端一行代码都不用改。

## 桥接进程：一个线程读串口，一个循环广播

桥接进程里最容易写错的是线程和事件循环的边界。pyserial 的 `readline` 是阻塞的，放进 asyncio 里会把整个循环卡住；但把整条链路都写成线程又很难处理多客户端广播。我的分工是：**一个后台线程只负责读串口并解析，事件循环只负责分发**。

从线程往事件循环塞数据必须用 `loop.call_soon_threadsafe`，不能直接操作 `asyncio.Queue`。队列本身不是线程安全的，直接 put 在调试时看似正常，压力一上来就会出现丢消息或者队列内部状态错乱。另外我给这个分发队列设了上限，满了就丢新帧——实时监控里，丢一帧的代价远小于积压十秒后突然把过期画面一股脑推给前端。

```python
import asyncio, json, threading
import serial, websockets

PORT, BAUD = "COM5", 115200
clients = set()          # 每个客户端一个 asyncio.Queue
loop = None

def reader(q):
    ser = serial.Serial(PORT, BAUD, timeout=1)
    while True:
        raw = ser.readline()
        if not raw or len(raw) > 2048:
            continue
        try:
            msg = json.loads(raw.decode("utf-8", "ignore"))
        except ValueError:
            continue
        if isinstance(msg.get("blobs"), list):
            loop.call_soon_threadsafe(enqueue, q, msg)

def enqueue(q, msg):
    if q.full():
        return
    q.put_nowait(msg)

async def pump(ws, q):
    while True:
        await ws.send(await q.get())

async def handler(ws, path=None):
    q = asyncio.Queue(maxsize=16)
    clients.add(q)
    task = asyncio.create_task(pump(ws, q))
    try:
        await ws.recv()          # 只为感知断开，客户端不发数据
    except websockets.ConnectionClosed:
        pass
    finally:
        clients.discard(q)
        task.cancel()

async def main():
    global loop
    loop = asyncio.get_running_loop()
    q = asyncio.Queue(maxsize=4)
    threading.Thread(target=reader, args=(q,), daemon=True).start()

    async def fanout():
        while True:
            msg = await q.get()
            for cq in clients:
                if cq.full():
                    cq.get_nowait()
                cq.put_nowait(msg)

    async with websockets.serve(handler, "127.0.0.1", 8765):
        await fanout()

asyncio.run(main())
```

这里有几个决定值得说明。每个客户端单独一个队列，再加一个发送协程，是为了慢客户端不拖累别人：某个页面卡住导致 TCP 发送缓冲区满，`ws.send` 会挂起，但它挂起的只是自己那条协程，广播循环照常把帧分给别人。队列满了丢最旧的一帧（`get_nowait` 再 put），保证画面永远是最新的，延迟不会越积越大。`handler` 里 `await ws.recv()` 看着多余，其实是为了让协程一直活着并在客户端关闭时立刻收到异常；如果不读，服务端要等到下一次发送失败才知道对方走了。`path=None` 是为了兼容 websockets 12 之后只传一个参数的处理器签名，写成这样新旧版本都能跑。

监听地址写 `127.0.0.1` 而不是 `0.0.0.0`，默认只对本机开放。想让局域网其他设备看，再手动改成 0.0.0.0，同时清楚这个端口没有任何鉴权，别放在不可信的网段里。

## 前端：把归一化坐标画成框

网页其实只有一个 canvas 和一段连接逻辑。坐标是 0 到 1 的比例，乘上画布宽高就是像素位置，和摄像头分辨率完全解耦。

```html
<!doctype html>
<meta charset="utf-8">
<title>OpenMV 识别结果</title>
<canvas id="view" width="640" height="480"></canvas>
<script>
const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
let ws;

function connect() {
  ws = new WebSocket("ws://127.0.0.1:8765");
  ws.onmessage = (ev) => {
    const { blobs } = JSON.parse(ev.data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 2;
    for (const b of blobs) {
      ctx.strokeRect(b.x * canvas.width, b.y * canvas.height,
                     b.w * canvas.width, b.h * canvas.height);
    }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
connect();
</script>
```

`onclose` 里重连，是因为桥接进程重启、笔记本休眠唤醒之后连接都会断，不重连就得手动刷新。没有做退避，一秒一次在本机场景下够用，也不会把日志刷爆。每次收到消息先清空画布再画，省掉维护上一帧状态的麻烦；如果以后要显示轨迹，就得改成渐变擦除或者独立图层，那是另一件事。

这个页面是"透明底"的画框层，不显示摄像头原图。这样做的好处是它可以直接叠在任意背景上，也能和 MJPEG 画面并排放在两个元素里对齐。真要画面加框，再加一个 `<img>` 指向 MJPEG 地址即可，但那时候两路数据的时间戳对不齐，框会略微滞后于画面，这是分开传输的固有代价，需要的话得在 OpenMV 端直接画框。

## 跑起来

目录结构很小：

```
openmv-web-bridge/
├── firmware/main.py     # 烧进 OpenMV 的程序
├── bridge.py            # 串口转 WebSocket
├── web/index.html       # 画框页面
└── requirements.txt     # pyserial, websockets
```

步骤只有四步：把 `firmware/main.py` 存到 OpenMV 的 SD 卡或闪存里运行；**关掉 OpenMV IDE**，否则 COM 口被占用，桥接进程会报 `PermissionError`；`pip install pyserial websockets` 后执行 `python bridge.py`；用浏览器打开 `web/index.html`。注意 `bridge.py` 里的 `PORT` 要改成设备管理器里实际的 COM 号，插不同 USB 口这个号会变。

## 几个我踩到的坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `PermissionError: could not open port` | OpenMV IDE 或串口助手占着端口，Windows 不允许多进程同时打开 | 关掉 IDE 和串口助手，再启动桥接 |
| 页面一直不显示框，控制台报连接失败 | 桥接进程没起来，或端口不是 8765 | 先 `curl http://127.0.0.1:8765` 确认进程活着（返回 426 也算正常） |
| 框的位置整体偏移 | 网页没按原始分辨率放缩，或 OpenMV 端忘了归一化 | 检查是否除以了 `img.width()`、`img.height()` |
| 偶发一整行丢失 | 波特率两端不一致，或串口线太长干扰 | 两边统一 115200，线尽量短，共地 |
| 长时间运行后页面越来越卡 | 客户端队列积压 | 确认队列有上限且满了丢旧帧，不要改成无界队列 |

还有一个和代码无关的坑：如果以后把页面放到 HTTPS 站点上，浏览器会因为混合内容拒绝连接 `ws://`。要么页面也用 HTTP，要么给桥接进程配证书走 `wss://`。我目前就是本机 HTTP 打开，不折腾证书。

## 小结

这个项目的价值不在代码量，而在把两件本来耦合的事切开了：OpenMV 只负责识别和输出结构化结果，浏览器只负责呈现，中间那层桥接进程可以随便换、随便改，两边都不用重新烧固件。协议用最朴素的一行一个 JSON，换来的是可读、可自同步、可人工排查；线程负责阻塞 IO、事件循环负责广播，是这个规模下最省心的分工。

下一步我打算在这条链路上加一个录制开关，把每帧结果和毫秒时间戳写进 JSONL，巡线跑完直接回放找丢线的位置。桥接层已经把数据变成干净的文本流了，加这个功能不需要动 OpenMV 一行代码。

