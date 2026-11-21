---
layout: post
title: "Python 3.15 惰性导入 + take_bytes 重写 STM32 串口上位机"
date: 2026-11-22 06:04:00 +0800
categories: 项目
tags: Python 3.15 串口调试 STM32 pyserial tkinter
description: "用 Python 3.15 重写自用的 STM32 串口调试上位机：PEP 810 惰性导入把 matplotlib 推迟到点按钮时加载，bytearray.take_bytes 零拷贝拆帧，frozendict 固化配置、默认 UTF-8"
---

上周在调一块 STM32F103 的板子，串口一直往外吐 `T=23.5,H=41` 这样的行，我打开桌面上那个用了一年多的 tkinter 上位机，点了图标之后窗口要愣一下才出来。等它出来，串口缓冲里已经压了两三百毫秒的旧数据，我得先清一下再看新帧。这个工具功能没问题，问题都集中在两处：启动时把用不到的东西也加载了，拆帧时每来一行就复制一次字节。

Python 3.15 在 2026 年 10 月 9 日发布，正好给了两个对症的东西：PEP 810 的显式惰性导入，和 `bytearray.take_bytes()`。我把这个上位机重写了一遍，顺手把配置改成不可变对象。这篇把目录、核心代码和运行方式完整写出来，能直接抄。

## 一、启动慢的根子：顶部 import 了什么

旧版本文件开头是这样的：

```python
import tkinter as tk
import serial
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
```

问题出在 matplotlib。它自己不算慢，但它会顺着依赖链拉进 numpy、一堆后端模块和字体缓存扫描。而我打开这个工具，十次里有九次只是看串口打印，画曲线是偶尔才用的功能。也就是说，每次启动都在为一个大概率不用的功能付账。

传统解法是把 import 挪进函数里，或者用 `importlib.import_module` 按需加载。这两种写法我都试过，结果是文件里到处都是条件导入，IDE 跳转也变差，过两个月自己都找不到某个模块在哪引入。Python 3.15 的 `lazy` 关键字解决的就是这个尴尬：import 语句仍然留在文件顶部，但模块真的被用到时才加载。

## 二、lazy import：声明在顶部，加载在用时

重写后的 `app.py` 开头：

```python
# app.py —— 启动必需的保持立即导入，可能用不到的用 lazy 推迟
lazy import matplotlib
lazy from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg

import queue
import threading
import tkinter as tk
import serial                 # 连串口就要用，没必要推迟

from core.config import CONFIG
from core.frame import LineFramer
```

`lazy` 是软关键字，`lazy import x` 和 `lazy from m import n` 都支持。解释器此时不会读文件、编译、执行模块顶层代码，而是先造一个轻量代理对象；第一次访问这个名字（比如调用 `matplotlib.figure.Figure`）时才真正加载。

我选它而不是把 import 塞进函数，有三个实际原因：

1. **作用域干净**。所有依赖在文件顶部一眼可见，函数体只谈逻辑。
2. **失败位置仍然可诊断**。模块不存在时，异常推迟到首次使用才抛，回溯里会同时给出"谁访问了这个名字"和"最初那条 import 在哪"，比函数内 import 的堆栈更好读。
3. **可以按模块粒度开关**。调试期我想确认某个依赖是否真被用到，用 `python -X lazy_imports=all app.py` 全局开启惰性导入，或者用 `sys.set_lazy_imports_filter()` 只对自己的包生效，第三方库保持立即加载。

限制也要说清楚，不然很容易踩：

- `lazy` 只能出现在模块作用域。写在函数体、类体、`try/except/finally` 里会直接 `SyntaxError`。
- 星号导入和 future 导入不能惰性：`lazy from m import *`、`lazy from __future__ import ...` 都不行。
- 对"每次运行都必然用到"的模块用 lazy 是负收益：多一层代理，错误还延后。所以我把 `tkinter` 和 `serial` 留在立即导入那一边。
- 按需加载只影响启动阶段执行模块的耗时，不改变打包体积。PyInstaller 做静态分析时仍然会看到 `lazy import matplotlib`，照样把它打进 exe。

## 三、拆帧：用 take_bytes 省掉每次的字节复制

串口读回来的数据不是一行一行整齐到达的：一次 `read()` 可能拿到半帧，也可能一次拿到三帧。所以我在应用层维护一个 `bytearray` 缓冲，按分隔符切。3.15 之前切一帧的典型写法是：

```python
n = buf.find(b"\n") + 1
frame = bytes(buf[:n])   # 复制一次
del buf[:n]              # 再搬一次剩余数据
```

3.15 新增的 `bytearray.take_bytes(n=None)` 把这两步合成一步：返回前 n 个字节的 `bytes`，同时把缓冲区裁掉这一段，不需要额外拷贝。官方文档给的场景就是按分隔符拆缓冲区。我的 `core/frame.py`：

```python
class LineFramer:
    def __init__(self, delimiter: bytes = b"\n", max_frame: int = 512):
        self._buf = bytearray()
        self._delim = delimiter
        self._max = max_frame

    def feed(self, data: bytes) -> list[bytes]:
        self._buf.extend(data)
        frames = []
        while (i := self._buf.find(self._delim)) != -1:
            n = i + len(self._delim)
            frames.append(self._buf.take_bytes(n))   # 返回 bytes 并消费缓冲区
        if len(self._buf) > self._max:
            # 没有分隔符的噪声不能无限涨，清掉半帧
            self._buf.clear()
        return frames
```

几个设计点值得解释：

- **为什么不直接用 `serial.readline()`**。它内部同样在缓冲，但超时语义和"半帧"处理不够直观，多帧粘包时还要自己再拆。自己持有一个 framer，规则完全可见，也方便单元测试。
- **`take_bytes` 会消费缓冲区**，所以拿到返回值后不要指望 `_buf` 里还有那一帧。这是它省掉拷贝的代价，用的时候要清楚。若还要在 3.14 上跑，把这一行换成 `bytes(self._buf[:n]); del self._buf[:n]` 即可。
- **上限保护是必须的**。如果板子某次复位后输出全是二进制乱码、一个换行都没有，缓冲会一直涨。`max_frame` 触发时清空，丢一帧总比内存被吃光好。

## 四、配置用 frozendict，编码交给默认 UTF-8

旧代码里配置是个普通 dict，被界面线程和串口线程同时读，有一次我在设置面板里改波特率，顺手把新值写回了这个全局 dict，正在跑的读线程下一轮就用上新值，立刻读出一堆乱码。根因不是线程同步没做好，而是这份配置本来就不该可变。

3.15 把 `frozendict` 做成了内置类型（PEP 814），`core/config.py` 变成：

```python
CONFIG = frozendict(
    baudrate=115200,
    delimiter=b"\n",
    max_frame=512,
    encoding="utf-8",
)

def dump_config(path: str) -> None:
    with open(path, "w") as f:          # 3.15 起默认就是 UTF-8
        json.dump(CONFIG, f, ensure_ascii=False, indent=2)
```

`frozendict` 直接继承 `object`，不是 `dict` 的子类；创建后赋值会抛 `TypeError`；键值都可哈希时它自身可哈希，可以当缓存键；保留插入顺序，但相等比较不看顺序。`json`、`copy`、`pickle` 等标准库已经适配，所以上面直接 `json.dump` 没问题。需要注意的是，代码里如果有 `isinstance(x, dict)` 的判断，得改成 `isinstance(x, (dict, frozendict))` 或 `collections.abc.Mapping`。

编码这块是 PEP 686：3.15 起 `open()` 不写 `encoding` 时默认 UTF-8，不再跟系统区域走。以前在 Windows 上把中文日志写进文件、再到别处打开出现乱码的情况，根源就是一边 GBK 一边 UTF-8。现在我仍然显式写 `encoding="utf-8"`，一是兼容性，二是如果哪天要和只认 GBK 的老工具交换文件，改这一处就够了。

## 五、目录、串口线程与运行

最终目录很小，一个窗口程序加三个核心模块：

```text
serial-debugger/
├─ app.py                  # tkinter 界面、按钮、队列消费
├─ core/
│  ├─ config.py            # frozendict 配置
│  ├─ frame.py             # LineFramer 拆帧
│  └─ link.py              # pyserial 封装与读线程
├─ tests/
│  └─ test_frame.py        # 跨包、粘包、超长帧
└─ requirements.txt        # pyserial>=3.5
```

读串口必须放后台线程，否则 `read()` 一阻塞，窗口就假死。但 tkinter 控件只能在主线程碰，所以线程只往 `queue.Queue` 里放数据，界面用 `after()` 定时取：

```python
def _pump(self):
    while self._running:
        try:
            data = self._port.read(self._port.in_waiting or 1)
        except serial.SerialException as e:
            self._log(f"串口断开: {e}")
            break
        for frame in self._framer.feed(data):
            self._queue.put(frame)

def _drain(self):
    while not self._queue.empty():
        frame = self._queue.get()
        self._text.insert("end", frame.decode(CONFIG["encoding"], "replace"))
    self.after(50, self._drain)
```

这里的 `after(50)` 是 50 毫秒轮询一次队列，比每来一帧就 `update()` 界面稳定，也不会因为数据密集时刷屏把 UI 拖死。`read()` 的 timeout 设成 0.05 秒，这样点"断开"时线程能在一轮内看到停止标志。

测试用 3.15 的推导式解包（PEP 798）写起来很顺：

```python
import unittest
from core.frame import LineFramer

class FrameTest(unittest.TestCase):
    def test_split_across_chunks(self):
        chunks = [b"T=23.5,H=", b"41\nT=24.0,H=42\n"]
        framer = LineFramer()
        frames = [*fs for fs in (framer.feed(c) for c in chunks)]
        self.assertEqual(frames, [b"T=23.5,H=41\n", b"T=24.0,H=42\n"])
```

`[*fs for fs in ...]` 等于把每个返回的列表摊平，省掉一层 `itertools.chain`。运行方式：

```bash
pip install pyserial
python app.py                 # 打开界面
python -m unittest discover -s tests
```

## 六、新旧写法对照与代价

| 需求 | 3.14 及以前的写法 | 3.15 写法 | 代价或限制 |
|---|---|---|---|
| 启动只加载要用的模块 | 函数内 import、`importlib` | `lazy import` / `lazy from` | 仅模块作用域；首次使用才报错 |
| 从缓冲区取一帧 | `bytes(buf[:n])` + `del` | `buf.take_bytes(n)` | 会消费缓冲区；3.15 才有 |
| 配置对象只读 | `MappingProxyType` | `frozendict` | 不是 dict 子类，`isinstance` 要改 |
| 中文日志编码 | 每个 `open` 写 UTF-8 | 默认 UTF-8 | 对接老工具仍需显式 `encoding="gbk"` |
| 展平多批帧 | `chain.from_iterable` | `[*fs for fs in ...]` | 语法新，团队里可能有版本差异 |

这套改法不是没有代价。第一，整个工具现在绑定 3.15，如果公司电脑还停在 3.12/3.13，就得保留 `take_bytes` 的回退分支，或者干脆别用这两个语法。第二，惰性导入把错误推迟了，"启动正常、点按钮才崩"比"一启动就崩"更难在开发时发现，所以我加了一个 `--smoke` 参数，启动时故意访问一次所有 lazy 名字，CI 里跑它。第三，`take_bytes` 会改变缓冲区，如果以后要在解析器外面复用同一段数据，就得先复制，省拷贝的前提是数据所有权清晰。

至于为什么不换成 Web 前端或者 Electron：这个工具的价值就是插上 USB 转串口、双击、五百毫秒内看到数据，单进程 tkinter 加 pyserial 已经够用，引入浏览器内核只会让启动更慢。新语法也是同样的判断——只在真的"可能用不到"的地方加 `lazy`，在热点路径上只换真正省事的 API。

## 小结

这次重写没有加任何新功能，只是把启动时的加载和拆帧时的复制两件事按 Python 3.15 的方式重新组织：`lazy` 让 matplotlib 留到点"画曲线"再加载，`bytearray.take_bytes` 把"切片 + 删除"合成一次操作，`frozendict` 从类型层面堵住配置被误改，默认 UTF-8 让中文日志不再看系统脸色。目录、线程模型和测试都保持在最小规模，周末半天能跑通。真正要记住的是边界：惰性导入管的是启动耗时不是包体积，省拷贝的 API 一定伴随着所有权转移，新语法用在刀刃上才有收益。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

