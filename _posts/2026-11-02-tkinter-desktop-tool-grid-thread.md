---
layout: post
title: "用 tkinter 写桌面小工具：grid 布局、线程通信与打包"
date: 2026-11-02 06:02:00 +0800
categories: 软件实战
tags: tkinter Python 桌面开发 多线程 PyInstaller
description: "桌面小工具看着简单，真写起来全是细节：布局在高 DPI 下错位、点一下按钮界面假死、打包成 exe 后图标和资源找不到。这篇以我的显卡切换工具为例，把 tkinter 的 grid 权重、queue 加 after 的线程通信、DPI 声明"
---

上周把自己天天用的小工具发给同学，他打开后点了一下「切换」按钮，问：为什么窗口白了一下，像卡死了？我让他等两秒，确实恢复了。这个问题我自己早就习惯，久到忘了它本来是个 bug。工具叫 gpu-switch-helper，本质是给几条要手动敲、还要管理员权限的命令加个壳：一个窗口、三个按钮、一个日志框。另一边的 md-workflow-manager 也踩过同一套坑。

趁着改这两处，我把 tkinter 写桌面工具的几个关键点重新捋了一遍：布局、线程、高 DPI、打包。它们都不难，但如果按「先跑起来再说」的写法来，最后一定会返工。

## 一、先把需求砍到最小

这类工具的界面需求其实只有四条：按钮能点、日志能看、执行中不能重复点、窗口拉大时日志跟着变大。没有动画、没有图表、没有主题切换。

所以我没有上 Qt，也没有套一个本地网页。tkinter 是标准库自带的，装好 Python 就能 import；打包时不用额外带一整套 GUI 运行库，产出的 exe 更小，发给别人也不用教他装依赖。代价是控件样式偏旧、复杂布局写起来啰嗦，但这四条需求根本用不到那些能力。

| 方案 | 额外依赖 | 适合的场景 | 不适合的场景 |
| --- | --- | --- | --- |
| tkinter | 无，标准库 | 单窗口工具、内部脚本加壳 | 复杂动画、精细视觉 |
| PyQt / PySide | 需要安装，打包要带运行库 | 多窗口、表格、专业界面 | 只想点几个按钮 |
| 本地网页 + 浏览器 | 要起服务或嵌入 WebView | 界面要频繁改、多人共用 | 离线单机小工具 |

选型的判断标准不是「哪个更强」，而是「界面复杂度值不值得引入运行时」。我这两个工具都是给自己和同学用，显然不值得。

## 二、布局：用 grid 的权重，而不是坐标

最早我是用 place 写的，每个按钮都算好 x、y。本机 150% 缩放下看着正常，换到同学的 100% 缩放屏幕上，按钮挤成一团，日志框还盖住了半个按钮。原因是 place 接收的是像素，而像素在不同缩放下对应的物理尺寸不一样。

改成 grid 并交给 Tk 自己算之后，这类问题就消失了：

```python
import tkinter as tk
from tkinter import ttk

root = tk.Tk()
root.title("GPU Switch")
root.minsize(420, 300)

# 只有第 0 列，占满整行；第 2 行（日志）吃掉剩余高度
root.columnconfigure(0, weight=1)
root.rowconfigure(2, weight=1)

bar = ttk.Frame(root, padding=8)
bar.grid(row=0, column=0, sticky="ew")
for i in range(3):
    bar.columnconfigure(i, weight=1)   # 三个按钮等宽

buttons = []
for i, text in enumerate(("切到核显", "切到独显", "刷新状态")):
    b = ttk.Button(bar, text=text)
    b.grid(row=0, column=i, sticky="ew", padx=4)
    buttons.append(b)

log = tk.Text(root, height=10, state="disabled", wrap="word")
log.grid(row=2, column=0, sticky="nsew", padx=8, pady=(0, 8))
```

几个参数值得解释。`columnconfigure(0, weight=1)` 的意思是：窗口变宽时，多出来的宽度按权重分给第 0 列。没有这一行，窗口拉伸时控件会贴在左上角不动。`sticky="ew"` 让按钮在格子里横向铺满，否则它只占自己文字需要的宽度。日志框用 `sticky="nsew"`，四个方向都贴紧，同时给它所在的行 `weight=1`，它才会跟着窗口一起长高。`minsize` 是下限，防止用户把窗口拖到按钮都放不下。

`Text` 控件默认是可编辑的，用户点到日志里就能改字，看起来很不专业。加上 `state="disabled"` 之后只读，但写入前必须先切回 `normal`，写完再切回来，这个顺序不能反。`wrap="word"` 是按词换行，日志里有长路径时不会横向溢出。我还给每个按钮的 `grid` 加了 `padx=4` 而不是在按钮内部塞空格，间距交给布局管理器，换字体也不容易错位。

## 三、耗时操作必须离开主线程

白屏两秒的原因很直接：Tk 的事件循环是单线程的，按钮的 `command` 回调就在主线程里执行。回调里调了 `subprocess.run`，整个进程就停在那里等子进程返回，期间窗口既不能重绘也不能响应鼠标，Windows 很快会把它标成「未响应」。

把命令丢进后台线程能解决卡顿，但立刻会引出第二个问题：后台线程不能直接改控件。Tcl 解释器是绑定在创建它的那个线程上的，跨线程调用轻则界面错乱，重则直接崩掉，而且崩的位置很随机，极难排查。稳妥的做法是让子线程只负责干活，把结果放进队列，主线程定时取：

```python
import queue
import subprocess
import threading
import tkinter as tk


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.msgs = queue.Queue()
        self.busy = False
        self.after(100, self._drain)     # 主线程每 100ms 取一次

    def _append(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _set_busy(self, busy):
        self.busy = busy
        state = "disabled" if busy else "normal"
        for b in self.buttons:
            b.configure(state=state)

    def _drain(self):
        try:
            while True:
                kind, text = self.msgs.get_nowait()
                if kind == "log":
                    self._append(text)
                elif kind == "error":
                    self._append("失败：" + text)
                    self._set_busy(False)
                elif kind == "done":
                    self._set_busy(False)
        except queue.Empty:
            pass
        self.after(100, self._drain)     # 取完再排下一次

    def run_cmd(self, cmd):
        if self.busy:
            return
        self._set_busy(True)
        self._append("$ " + " ".join(cmd))
        threading.Thread(target=self._worker, args=(cmd,), daemon=True).start()

    def _worker(self, cmd):
        try:
            p = subprocess.run(
                cmd, capture_output=True, text=True, timeout=30,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            out = (p.stdout or "") + (p.stderr or "")
            self.msgs.put(("log", out.strip() or "(无输出)"))
        except Exception as e:
            self.msgs.put(("error", str(e)))
        finally:
            self.msgs.put(("done", ""))
```

这段代码里有几个决定是我有意做的。

第一，**后台线程里没有出现任何控件操作**，包括读控件状态。它只往 `self.msgs` 里放元组，所有界面更新都发生在 `_drain` 里，而 `_drain` 是通过 `after` 由主线程调用的。`after(100)` 不是 `sleep`，它把回调挂进事件循环，期间窗口照常响应，所以界面不会假死。

第二，**`busy` 标志防重入**。只禁用按钮还不够，键盘快捷键、托盘菜单都可能再次触发命令。先判断 `busy` 再置位，比在每个入口处都记得禁按钮可靠。

第三，**`daemon=True` 和 `timeout=30` 是一对保险**。用户直接关窗口时，主线程退出，守护线程不会拖着进程不放；命令本身卡住时，`timeout` 会抛异常，走 `except` 分支回到界面，而不是永远停在「执行中」。

第四，**`CREATE_NO_WINDOW` 是 Windows 专属的参数**。不加它，调用 `nvidia-smi` 这类控制台程序时，屏幕上会闪一个黑窗口，虽然只有一瞬间，但每次点按钮都闪一下，体验很差。这个常量在非 Windows 上不存在，所以跨平台的话要用 `getattr(subprocess, "CREATE_NO_WINDOW", 0)` 兜一下。

顺便说清楚三种「把结果送回界面」的做法，我试过前面两种才换到第三种：

| 做法 | 现象 | 结论 |
| --- | --- | --- |
| 子线程里直接 `label.config(...)` | 平时正常，偶尔崩在 `Tcl_AsyncDelete` | 不可用 |
| 子线程里调用 `root.after(0, ...)` | 多数时候能跑，但本质仍是跨线程 | 不推荐 |
| 子线程 `put` + 主线程 `after` 轮询 | 行为稳定，顺序可控 | 采用这个 |

## 四、150% 缩放：DPI 声明和 tk scaling 要一起做

布局改成 grid 之后，按钮位置对了，但字是糊的。Windows 默认把不认识 DPI 的程序按 96 DPI 渲染，再整体放大到 150%，相当于对一张图做拉伸，边缘自然发虚。

解决办法是在创建 `Tk()` **之前**声明 DPI 感知：

```python
import ctypes
import tkinter as tk

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(1)
except (AttributeError, OSError):
    pass    # Win7 没有 shcore，或已经设置过

root = tk.Tk()
root.tk.call("tk", "scaling", root.winfo_fpixels("1i") / 72)
```

声明之后窗口不再被系统拉伸，字变清晰了，但会发现字变小了。因为 Tk 仍然按 96 DPI 的逻辑单位画，而实际一个英寸里的像素更多了。所以第二句要按真实 DPI 重新算 scaling：`winfo_fpixels("1i")` 返回一英寸有多少像素，除以 72 就是「一个点等于几个像素」，把它交给 Tk，字体和控件才会按比例放大。

两个顺序都不能错。DPI 声明必须在 `Tk()` 之前，窗口已经创建后再声明，系统不会回头重绘；`scaling` 要在创建控件之前设，否则已经建好的字体不会跟着变。如果只想统一调整某类字体，也可以拿 `tkinter.font.nametofont("TkDefaultFont")` 改 size，但那只是字体变了，控件内边距还是按旧比例算，混在一起容易对不齐，不如整体设 scaling。

## 五、打包：单文件 exe 的路径和图标

本地跑通之后用 PyInstaller 打包：

```bash
pyinstaller --noconfirm --onefile --noconsole ^
  --name GpuSwitch --icon assets\app.ico ^
  --add-data "assets;assets" app.py
```

`--onefile` 把所有东西塞进一个 exe，方便发给别人；`--noconsole` 去掉黑色控制台窗口，对 GUI 程序是必须的；`--add-data` 的 Windows 写法是「源路径;目标路径」，中间是分号，Linux 和 macOS 要用冒号，这一点很多人第一次打包都会写错。

单文件模式有个必须理解的行为：运行时 PyInstaller 会把内容解压到一个临时目录，程序里用 `__file__` 拼出来的路径指向的其实是那个临时目录，而不是 exe 所在目录。所以读图标、读配置模板都要走统一的资源路径函数：

```python
import os
import sys


def res_path(name: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, name)
```

`sys._MEIPASS` 只在打包后的进程里存在，源码运行时没有这个属性，所以用 `getattr` 给一个回退值。窗口图标、托盘图标、默认配置都该用 `res_path` 读，而不是写死相对路径。

还有两个坑值得提前知道。第一，`--noconsole` 之后 `print` 没有地方可去，某些环境下 `sys.stdout` 甚至是 `None`，直接 `print` 会抛异常。调试信息应该写日志文件，路径放在 `%LOCALAPPDATA%` 下，而不是 exe 旁边——Program Files 里普通用户没有写权限。第二，`--icon` 只影响 exe 文件本身的图标，窗口左上角的图标要在代码里用 `iconbitmap(res_path("app.ico"))` 再设一次，两处是独立的。

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 打包后图标找不到 | 相对路径指向临时目录 | 用 `sys._MEIPASS` 拼资源路径 |
| `--add-data` 后程序仍读不到文件 | 用了 `assets/...` 斜杠或漏了目标名 | Windows 写 `"assets;assets"` |
| 想改 ttk 元素细节，照抄 `element_configure` | tkinter 的 Style 没有这个方法，3.8 上直接 AttributeError | 用 `style.configure`、`style.map` 或换主题 |
| 双击 exe 一闪而过 | 启动时报错但无控制台 | 临时用带控制台的版本跑一次看 traceback |
| 杀毒软件误报 | 单文件解压执行的行为特征 | 不追求绝对避免，交付时说明来源 |

最后一行是我自己的取舍：单文件方便，但确实更容易被拦。如果是给实验室同学内部用，我会附上源码和打包命令，对方不放心就自己打一个；如果要求更稳，就改成 `--onedir` 目录分发，牺牲一点整洁换更少的误报。

## 六、小结

这个小工具最终不到三百行，但它把 tkinter 最容易翻车的几处都过了一遍。回头看，白屏、错位、字糊、打包丢资源，没有一个是 tkinter 的 bug，全是我在最初图省事时留下的：在主线程里跑子进程、用像素算布局、没声明 DPI、用相对路径读文件。

如果让我给一条顺序建议，那就是先把「耗时操作永远不碰界面」这条线画死——用队列和 `after` 把计算与绘制分开，后面加功能时就不会再被卡顿和随机崩溃反复折腾。布局和缩放是体验问题，可以慢慢调；线程边界是正确性问题，最好一次做对。

