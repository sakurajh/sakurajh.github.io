---
layout: post
title: "用 PyInstaller 把 Python 脚本打包成单文件 exe：图标、路径与中文目录的完整清单"
date: 2026-10-19 11:14:00 +0800
categories: 软件实战
tags: PyInstaller Python exe打包 桌面工具 路径处理
description: "把实验室用的 Python 小工具发给同学，源码和依赖都不想暴露，于是用 PyInstaller 打单文件 exe。这篇记录图标、控制台、资源路径、中文目录和杀毒误报的完整处理，附可直接抄的构建脚本与排查表。"
---

上个月把实验室用的一个小工具发给同学，功能很简单：读几个 CSV、按规则改名、再导出一份汇总。为了不让他装 Python 和一堆依赖，我用 PyInstaller 打了单文件 exe。在我电脑上双击就开，发过去却一闪而过；后来换到一台带中文用户名的机器，又出现读不到资源、写配置失败的问题。这篇文章把那次打包从头到尾的坑整理成一份清单，重点不是命令本身，而是命令背后那些只在别人机器上才暴露的路径和编码问题。

先说一个容易误解的前提：PyInstaller 并不是把 Python 编译成机器码，而是把解释器、字节码和依赖收集起来，运行时先解压再启动。理解这一点，后面那些临时目录、首次启动慢、杀毒软件误报的现象就都能解释通，而不是每次遇到都当成玄学。

## 单文件还是单目录

PyInstaller 最常被问的是 `-F` 和 `-D` 怎么选。两者不是“新旧”关系，而是分发方式和运行方式的交换：

| 方式 | 产物 | 启动与维护 | 适合 |
|---|---|---|---|
| `-F` 单文件 | 一个 exe | 每次启动先把内容解压到临时目录，冷启动会慢一点 | 发给别人、工具体积不大 |
| `-D` 单目录 | exe + 依赖目录 | 启动快，文件多，升级时整目录替换 | 内部长期使用、依赖较多 |

我选 `-F`，理由很实际：同学只需要接收一个文件，不用理解“要把整个文件夹一起拷走”。代价是每次启动都要解压一遍，对一个一天开几次的工具来说可以接受。如果工具要常驻托盘、依赖几十兆的资源，我会改用 `-D`，避免每次启动都做一次解压。

## 构建命令和几个不能省的参数

我最开始只写了 `pyinstaller -F main.py`，能跑，但图标是默认的、控制台会弹、pyserial 的串口枚举也失败。后来固定成下面这条命令：

```powershell
pyinstaller -F -w -n LabTool `
  --icon app.ico `
  --add-data "assets;assets" `
  --hidden-import serial.tools.list_ports `
  main.py
```

几个参数值得逐个说清楚：

- `-F` 打单文件；`-w` 去掉控制台窗口。调试阶段不要加 `-w`，否则异常信息没地方看。
- `-n` 指定产物名，避免默认拿入口文件名，和快捷方式、版本信息对不上。
- `--add-data "源;目标"` 把资源打进去。Windows 用分号分隔，macOS/Linux 用冒号，这是跨平台构建时最容易漏的一处。
- `--hidden-import` 解决动态导入。像 `serial.tools.list_ports.comports()` 这种在运行时才 import 的模块，静态分析抓不到，不补就会在别人机器上报 `ModuleNotFoundError`。
- 依赖里带数据文件的包，可以用 `--collect-all 包名` 一并收进去，但不要无脑全加，产物会明显变大。

我还会在构建前删掉 `build` 和 `dist`。PyInstaller 有缓存，改过资源或依赖后如果不清理，偶尔会打出旧内容，排查起来很浪费时间。把命令写进 `build.bat`，比每次翻聊天记录可靠：

```bat
@echo off
rmdir /s /q build dist 2>nul
pyinstaller -F -w -n LabTool --icon app.ico --add-data "assets;assets" --hidden-import serial.tools.list_ports main.py
```

## 图标、版本信息和虚拟环境

图标不只是 `--icon` 一行。Windows 上如果 ico 里只有一种尺寸，任务栏和文件列表会各取所需地拉伸，看起来发糊。我一般准备一个包含 16、32、48、256 四种尺寸的 ico，`--icon` 指过去就行。版本信息则没有命令行参数，需要写一个 version file，再用 `--version-file` 传进去。它不是必需项，但发给别人后，右键属性里能看到产品名和版本号，对方报问题时至少能确认自己拿的是哪一版，而不是对着一个光秃秃的 `LabTool.exe` 猜。

还有虚拟环境这一条。我第一次打包用的是系统 Python，机器上装了几十个包，PyInstaller 把能扫到的都带了进去，产物一百多兆。后来养成习惯：每个要交付的工具单独建一个干净 venv，只装运行必需的依赖，在 venv 里构建。产物小了，`ModuleNotFoundError` 也少了，因为扫描范围和实际运行环境终于一致了。

## 资源路径：`__file__` 在单文件里不是你以为的位置

单文件 exe 启动时会把内容解压到一个临时目录，`__file__` 指向的是临时目录里的文件，不是 exe 旁边。读只读资源要用 `sys._MEIPASS`，写配置和日志则要落在 exe 所在目录或 `%APPDATA%`，不能用临时目录：

```python
import sys
from pathlib import Path

def resource_path(rel: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base / rel

def writable_path(name: str) -> Path:
    # 单文件模式下，exe 所在目录才是长期可写的位置
    return Path(sys.executable).resolve().parent / name
```

这段代码解决的是两类完全不同的问题。`resource_path` 用来读图标、模板、内置字典这类打包进 exe 的只读文件；`writable_path` 用来写日志、缓存、用户配置。很多人把两者都写成 `Path(__file__).parent`，开发时正常，打包后日志写进了临时目录，程序一退出就没了。另一个常见错误是往 `sys._MEIPASS` 里写文件，临时目录可能被系统清理，也可能没有写权限。

`sys.executable` 在打包后指向 exe 本身；在源码运行时指向 `python.exe`。如果一段代码要同时支持两种运行方式，可以用 `getattr(sys, "frozen", False)` 判断当前是不是打包产物，再决定路径策略。

## 中文目录、工作目录和子进程

中文路径本身在 Python 3 里不是问题，真正出问题的是把路径交给子进程、C 库或控制台的时候。比如主程序调用一个随包附带的小工具：

```python
import subprocess
import sys
from pathlib import Path

exe_dir = Path(sys.executable).resolve().parent
result = subprocess.run(
    [str(exe_dir / "helper.exe"), "--input", "试卷.pdf"],
    cwd=str(exe_dir),
    capture_output=True,
    text=True,
    encoding="utf-8",
    errors="replace",
)
```

这里显式指定 `cwd` 和 `encoding`，是因为双击 exe、从快捷方式启动、从另一个程序调起时，当前工作目录可能不同。依赖 `os.getcwd()` 去找同目录的文件，在别人机器上很容易失败。显式传 `cwd` 后，相对路径的基准就固定了。`encoding="utf-8"` 则是为了避免子进程输出走 Windows 控制台代码页，中文变成乱码后连报错都看不懂。

文件读写同样建议显式写 `encoding="utf-8"`；如果生成的 CSV 要给 Excel 直接双击打开，可以用 `utf-8-sig` 带 BOM，避免表头中文乱码。

## 打包后最常见的问题

下面这张表基本覆盖了我这些年遇到的打包问题，按出现频率排：

| 现象 | 大概率原因 | 处理 |
|---|---|---|
| 双击后一闪而过 | 异常没被捕获，且用了 `-w` | 先打无 `-w` 的调试版；把异常写进日志文件 |
| 找不到图标或模板 | `--add-data` 没加，或路径用了 `__file__` | 用 `resource_path`，检查 `sys._MEIPASS` |
| 换机器提示缺 DLL | 目标机缺运行库或系统组件 | 在干净 Windows 虚拟机里测试，必要时安装对应运行库 |
| 中文路径下读写失败 | 子进程或文件编码不一致 | 显式 `encoding`，用 `Path` 拼接，不拼字符串 |
| 杀毒软件报毒 | 单文件自解压行为容易被误判 | 提交误报、给 exe 签名，或改用 `-D` 目录模式 |
| 配置重启后丢失 | 写到了 `_MEIPASS` 临时目录 | 改写到 exe 所在目录或 `%APPDATA%` |

最后一条我踩过两次。第一次以为是配置没保存，第二次才发现文件确实写了，只是写进了临时目录；程序退出后目录被清掉，看起来就像“设置没生效”。

## 上线前的最小检查

打包命令跑通不等于能交付。我现在至少会做这几件事：在一台没装 Python 的干净 Windows 虚拟机上双击运行；把 exe 放到带空格和中文的路径下再试一次；从快捷方式和从命令行各启动一次，确认工作目录不敏感；用一个只读目录模拟 `Program Files`，确认需要写的文件都落在可写位置；最后保留一个带控制台的调试版本，方便对方出问题时抓日志。

此外我会把构建环境一并记下来：Python 版本、PyInstaller 版本、`requirements.txt`，和产物放在同一个交付目录。隔几个月同学说“新电脑上打不开”，没有这份记录，就只能靠猜是系统组件缺失还是依赖漂移。exe 看起来只是一个文件，背后仍然是一整套版本组合，记录它比事后复现省事得多。

## 小结

单文件 exe 的价值是降低交付成本，但它把路径、编码、依赖这些平时被开发环境掩盖的问题一次性放大了。我的经验是：`-F` 负责分发，`-D` 负责长期维护；只读资源走 `sys._MEIPASS`，可写数据走 `sys.executable` 所在目录；子进程显式传 `cwd` 和 `encoding`；构建命令写进脚本，交付前一定在干净机器上试一次。把这些固定下来，打包就不再是“在我电脑上能跑”的玄学。

