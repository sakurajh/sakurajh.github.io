---
layout: post
title: "用 tkinter 和 pyserial 给 STM32 写一个串口调试上位机"
date: 2026-10-18 23:31:00 +0800
categories: 项目
tags: Python pyserial tkinter STM32 串口通信
description: "调试 STM32 时串口助手只能看文本，采样数据既不能筛选也不能存。这篇从零搭一个最小可用的上位机：读线程、自定义帧格式、tkinter 批量刷新，最后打成单文件 exe，代码可以直接抄。"
---

上个月给一块 STM32F103 的小板子调 MPU6050，需要连着看三路采样值。串口助手能把 `printf` 出来的东西显示出来，但它有三个我忍不了的地方：数据是纯文本，想算个滑动平均得先复制粘贴进 Excel；加了时间戳和通道号之后每行变得很长，滚动起来眼睛跟不上；偶发丢帧的时候只能靠一行行肉眼比对，根本判断不了是数据错了还是显示错了。

于是一个晚上写了个不到 300 行的上位机。这篇文章把它拆开讲，重点只有三个地方：读串口为什么必须放子线程、帧怎么分、界面怎么刷新才不卡。

## 目录结构

```
serial-monitor/
├── main.py            # 入口：装配 worker 和窗口
├── serial_worker.py   # 读串口线程 + 分帧循环
├── protocol.py        # crc8 与结构体打包
└── requirements.txt
```

`requirements.txt` 只有一行 `pyserial`。tkinter 是标准库，不用装。

## 第一步：把读串口放进子线程

这是整个项目最容易写错的地方。tkinter 的 `mainloop()` 是一个单线程事件循环，所有控件操作都必须在这个线程里完成。如果直接在按钮回调里写 `while True: ser.readline()`，mainloop 就再也拿不到 CPU，窗口几秒内变成"未响应"。

反过来，在子线程里直接 `text.insert()` 同样不行。tkinter 内部没有对控件加锁，跨线程改控件在 Windows 上往往不报错，但会表现为偶发的界面不刷新、滚动条卡死，甚至进程直接退出。这类问题比崩溃更难查，因为它不复现。

所以我给自己定的规矩是：**子线程只碰 queue，主线程只碰控件**。

```python
# serial_worker.py
import queue
import threading
import serial

from protocol import unpack_frame


class SerialWorker:
    """只负责 IO：解析好的帧丢进 rx，错误丢进 err"""

    def __init__(self, rx: queue.Queue, err: queue.Queue):
        self.rx = rx
        self.err = err
        self._ser = None
        self._stop = threading.Event()
        self._thread = None

    def open(self, port: str, baud: int = 115200):
        self._ser = serial.Serial(
            port=port, baudrate=baud,
            bytesize=8, parity='N', stopbits=1,
            timeout=0.05,          # 关键：不能是 None
        )
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        buf = bytearray()
        while not self._stop.is_set():
            try:
                chunk = self._ser.read(256)
            except serial.SerialException as e:
                self.err.put(f'串口断开：{e}')
                return
            if not chunk:
                continue
            buf.extend(chunk)
            while True:
                frame = unpack_frame(buf)   # 不够一帧返回 None
                if frame is None:
                    break
                self.rx.put(frame)

    def close(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)
        if self._ser and self._ser.is_open:
            self._ser.close()
```

`timeout=0.05` 是这段代码里唯一必须解释的参数。pyserial 的 `read()` 在 timeout 为 `None` 时会一直阻塞到读够字节数，这时 `_stop` 设了也没用，关窗口的瞬间线程还卡在 read 上，进程退不掉，任务管理器里留一个僵尸。给个短超时，read 每 50ms 就返回一次空字节串，循环重新检查 `_stop`，退出才是干净的。

## 第二步：帧怎么分

一开始我用 `printf("%d,%d\n", ch, val)` 加换行分隔，图省事。问题出在两处：某天我想在帧里塞一个二进制状态字，分帧就全乱了；另外一旦因为干扰丢了一个字节，后面所有行都错位，而且错得很像"对的"，肉眼几乎发现不了。

改成带包头、长度和校验的帧：

```
0xAA 0x55 | len(1) | payload(len) | crc8(1)
```

payload 固定 3 字节：`channel(int8) + value(int16 小端，单位 0.01)`。

```python
# protocol.py
import struct

HEAD = b'\xaa\x55'


def crc8(data: bytes) -> int:
    """CRC-8/ATM：poly=0x07, init=0x00"""
    crc = 0x00
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def pack_frame(ch: int, value: float) -> bytes:
    payload = struct.pack('<Bh', ch, int(round(value * 100)))
    return HEAD + bytes([len(payload)]) + payload + bytes([crc8(payload)])


def unpack_frame(buf: bytearray):
    """从缓冲区头部切一帧出来；不够一帧返回 None，脏字节直接丢"""
    while True:
        start = buf.find(HEAD)
        if start < 0:
            buf.clear()          # 全是垃圾，清空重来
            return None
        if start:
            del buf[:start]      # 丢掉包头之前的噪声
        if len(buf) < 4:
            return None          # 连头部都还没收全
        length = buf[2]
        total = 3 + length + 1
        if len(buf) < total:
            return None          # 半包，等下一次 read 补齐
        payload = bytes(buf[3:3 + length])
        crc = buf[3 + length]
        del buf[:total]
        if crc8(payload) != crc:
            continue             # 校验错，继续往后找包头
        return struct.unpack('<Bh', payload) if length == 3 else None
```

这段里真正重要的是两个 `return None`：一个在"长度不够"时返回，一个在"包头还没来"时返回。而且 `buf` 必须留在函数外面（`_loop` 里的那个 `bytearray`），因为一次 `read(256)` 拿到的可能是 1.7 帧，也可能只有半帧。我最早的版本把 buf 写在函数内部，半包永远拼不起来——表现就是连上之后三分钟内必然丢一段数据。

STM32 那边对应着发就行，HAL 库版本：

```c
uint8_t crc8(const uint8_t *data, uint8_t len)
{
    uint8_t crc = 0x00;
    while (len--) {
        crc ^= *data++;
        for (uint8_t i = 0; i < 8; i++)
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
    }
    return crc;
}

void report_sample(int8_t ch, int16_t raw)
{
    uint8_t payload[3] = { (uint8_t)ch, (uint8_t)(raw & 0xFF), (uint8_t)((raw >> 8) & 0xFF) };
    uint8_t frame[7] = { 0xAA, 0x55, sizeof(payload) };
    memcpy(&frame[3], payload, sizeof(payload));
    frame[6] = crc8(payload, sizeof(payload));
    HAL_UART_Transmit(&huart1, frame, sizeof(frame), 10);
}
```

这里唯一容易错的是 `frame[7]` 的下标：包头 2 + 长度 1 + payload 3 + 校验 1。我第一版写成 `uint8_t frame[5]`，编译不报错，运行时把栈上的相邻变量踩掉，查了两个小时。

## 第三步：界面怎么刷新才不卡

布局本身没什么好讲的：一个 Combobox 选串口、一个按钮开关、一个 Text 显示。有讲究的是刷新策略。

如果每收到一帧就 `insert` 一次，115200 下数据一密，mainloop 的时间几乎全花在 Text 重排上，窗口拖都拖不动。我的做法是每 30ms 从队列里批量取一次，一次最多 200 条：

```python
def _poll(self):
    lines = []
    for _ in range(200):
        try:
            ch, value = self.rx.get_nowait()
        except queue.Empty:
            break
        lines.append(f'CH{ch}  {value:8.2f}')
    if lines:
        self.text.configure(state='normal')
        self.text.insert('end', '\n'.join(lines) + '\n')
        # 只保留最近 2000 行，否则重排会越来越慢
        if int(self.text.index('end-1c').split('.')[0]) > 2000:
            self.text.delete('1.0', '500.0')
        self.text.see('end')
        self.text.configure(state='disabled')
    self.after(30, self._poll)
```

`after(30)` 是在 mainloop 里排一个定时回调，语义就是"30 毫秒后让主线程再跑一次这个函数"，它不占线程也不阻塞事件处理。这比 `threading.Timer` 好：后者又开一个线程，等于把最开始的问题绕回来了。

另外 `Text` 设成 `state='disabled'` 后用户不能编辑，但 `insert` 之前必须临时切回 `normal`，忘了就是"插不进去还不报错"。

## 打包成 exe

```bash
pyinstaller -F -w -n SerialMonitor --icon app.ico \
  --hidden-import serial.tools.list_ports main.py
```

`-F` 打单文件，`-w` 去掉黑色控制台窗口。加 `--hidden-import` 是因为我用 `serial.tools.list_ports.comports()` 枚举串口，PyInstaller 的静态分析抓不到这种间接 import，不打这个参数，生成的 exe 一运行就 `ModuleNotFoundError`。

单文件 exe 每次启动会先把自己解压到临时目录，所以启动比源码慢一点。这是个可以接受的交换：发给实验室同学一个文件就能用，不用教他们装 Python 和驱动。

## 三种分帧方式的取舍

| 分帧方式 | 优点 | 缺点 | 适合 |
|---|---|---|---|
| 换行分隔文本 | 一行 printf 就能用，最省事 | 二进制里出现 0x0A 就误判；解析要 atof | 只打日志、不带结构化数据 |
| 定长帧 | 解析最快，不用搜包头 | 改一个字段两端都得改；丢一字节就永久错位 | 固定结构的高频采样 |
| 包头 + 长度 + CRC | 能自恢复，能识别坏帧 | 多二十行代码，要处理半包 | 长时间运行、有干扰的现场 |

我最后选第三种，理由不是"更专业"，而是板子和电脑之间那根杜邦线经常被碰。第二种方案里，碰一下之后必须重启程序才能恢复，这个代价比多写二十行代码高得多。

## 调试时最常遇到的几种情况

| 现象 | 大概率原因 | 处理 |
|---|---|---|
| 打开串口报 PermissionError | 串口助手或调试器还占着这个口 | 关掉占用它的程序 |
| 收到一堆乱码 | 两端波特率不一致，或 STM32 时钟树配错 | 都设 115200，核对 HSE 与 PLL |
| 前几帧正常，后面全错位 | 半包没处理，把半帧当整帧切了 | 按长度字段判断是否收全 |
| 拔掉 USB 后程序卡死 | 子线程在 read 上抛异常没捕获 | 捕获 SerialException，向队列发错误 |

最后一条我真踩过：线被碰掉时 `_ser.read()` 抛 `SerialException`，如果 `_loop` 里没有 try，线程会静默死掉，界面还显示"已连接"，然后一直等一个再也不会来的数据。

## 小结

整个工具不到 300 行，但把几件事说清楚了：

- 串口 IO 一定放子线程，线程和数据的边界画清：子线程只往 queue 里放，主线程只从 queue 里取；
- 分帧要有长度和校验，缓冲区放在循环外，半包要能等下一次 read；
- 界面刷新要合并，`after()` 批处理比"来一帧刷一次"稳。

再往下能加的东西不少：把数据写成 CSV、用 matplotlib 画实时曲线、命令下发也走同一套帧格式。但先把这三件事做对，这个工具已经能天天用了。

