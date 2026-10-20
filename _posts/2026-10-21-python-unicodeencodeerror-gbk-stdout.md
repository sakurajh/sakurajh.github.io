---
layout: post
title: "Python 在定时任务里输出 emoji，UnicodeEncodeError 从哪来"
date: 2026-10-21 06:02:00 +0800
categories: 踩坑修复
tags: Python UnicodeEncodeError Windows 字符编码 定时任务
description: "一个 tkinter 工具在 Windows 计划任务里只留半截日志就退出，报错 UnicodeEncodeError: 'gbk' codec。本文从控制台编码、PEP 528 查到子进程解码，给出不靠 chcp 的修法。"
---

`md-workflow-manager` 是我给自己写的一个 Markdown 流程工具：界面上点几下，它就把一批笔记整理好、提交到集群、再把结果收回来生成报告。因为经常要跑 overnight，我给它加了一个无人值守入口——Windows 任务计划程序每天早上调用一个批处理，把控制台输出重定向到 `logs/run.log`。

奇怪的事情从第三天开始：任务计划程序里显示“上次运行结果：0x1”，日志却只有半行时间戳，后面什么都没有。手动双击同一个批处理，窗口里能跑完；换成 Git Bash 执行同一条命令，又失败。我一开始怀疑工作目录、虚拟环境、Python 路径，挨个打印排查，最后把 stderr 单独接到一个文件，才看到真正的报错：

```text
UnicodeEncodeError: 'gbk' codec can't encode character '\u2705' in position 0: illegal multibyte sequence
```

`\u2705` 是 ✅。进度输出里有一行 `print("✅ 仿真任务已提交")`，就是它把整个任务干掉了。中文一个字都没错，错的是一个表情符号。

## 复现：同一段代码，换个终端就崩

我把问题压缩成一个三行的脚本：

```python
# probe.py
print("开始")
print("✅ 完成")
print("后续步骤")
```

在 cmd 窗口里直接 `python probe.py`，三行都正常；加上重定向 `python probe.py > out.txt 2>&1`，立刻抛 `UnicodeEncodeError`；在 Git Bash 里直接运行，同样崩。为了确认不是猜测，我在入口加了一行诊断：

```python
import sys, locale
print("stdout:", sys.stdout.encoding,
      "stderr:", sys.stderr.encoding,
      "locale:", locale.getpreferredencoding(False))
```

失败环境里三个值都是 `cp936`，而 cmd 前台是 `utf-8`。同一份代码、同一个解释器，差别只在“输出接到哪里”。

| 运行方式 | stdout 接到哪 | 实际编码 | 结果 |
|---|---|---|---|
| cmd / PowerShell 前台 | Windows 控制台 | UTF-8 | 正常 |
| Git Bash（mintty） | 伪终端，被当作管道 | cp936 | 崩溃 |
| `> run.log 2>&1` | 普通文件 | cp936 | 崩溃 |
| 计划任务 + 重定向 | 普通文件 | cp936 | 崩溃 |
| 重定向下设置 `PYTHONUTF8=1` | 普通文件 | UTF-8 | 正常 |

这张表是整件事的关键：不是“Windows 上的 Python 不支持 emoji”，而是**输出目标变了，Python 选用的编码也跟着变了**。

## 根因：控制台是 UTF-8，管道不是

要讲清楚得区分三层编码，它们经常被混为一谈：

1. **源码编码**：Python 3 的源文件默认按 UTF-8 解析（PEP 3120），`✅` 在内存里是一个 Unicode 码点，没有问题。
2. **字符串编码**：`print` 时，`sys.stdout` 这个 `TextIOWrapper` 要把码点编码成字节，用哪种编码由它启动时决定。
3. **落盘/传输编码**：文件、管道、子进程各自还有自己的约定。

从 Python 3.6 起，PEP 528 让 Windows 控制台的 stdio 走宽字符 API，编码固定为 UTF-8，所以前台 `print("✅")` 看起来天经地义。但这条特殊通道只对**真正的 Windows 控制台句柄**生效。一旦 stdout 被重定向到文件或管道，Python 就退回普通文本流，编码取 `locale.getpreferredencoding(False)`，在中文 Windows 上就是 ANSI 代码页 cp936。

Git Bash 的 mintty 是一个伪终端，不是 Windows 控制台，所以 Python 同样走管道分支；计划任务里的重定向更是标准的文件输出。两个“看起来不一样”的环境，其实踩的是同一个分支。

这也解释了为什么中文没出事：常用汉字在 GBK 里都有对应码位，`print("仿真完成")` 能正常编码。✅、✓、部分箭头和 emoji 不在 cp936 的字符集里，编码器找不到映射，就抛 `UnicodeEncodeError`。所以“把 emoji 换成 OK”能暂时过关，但下次日志里出现一个用户输入的特殊符号，问题还会回来。

更麻烦的是错误信息本身也会丢。异常抛出后，解释器要把 traceback 写到 stderr，而 traceback 会带上出错的那行源码，里面正好有 ✅；stderr 也是 cp936，于是写日志时再抛一次，最后只剩 `lost sys.stderr` 之类的残片。stdout 在重定向下又是块缓冲，崩溃时缓冲区未必来得及 flush。日志看起来“空的”，不是没报错，而是报错也没能完整写出来。

同一个默认编码还影响另外两个地方，只是症状不同：

- `open(path)` 不写 `encoding` 时，读写都按 cp936。读一个 UTF-8 的配置文件，可能直接 `UnicodeDecodeError`，也可能读出乱码；写出去的日志，别的工具按 UTF-8 打开又是乱码。
- `subprocess.run(..., text=True)` 不写 `encoding` 时，父进程也用 cp936 解码子进程输出。子进程如果是 Python 且输出 UTF-8，父进程这边就会解码失败；反过来，父进程按 UTF-8 解一个 GBK 工具的输出，也会得到乱码。

顺带说一句：这跟“中文路径”没关系。Windows 的文件 API 本身是 Unicode 的，`open(r"D:\报告\输出.md")` 能不能打开，取决于路径存在与否，不取决于控制台代码页。路径是路径，内容是内容，混在一起排查很容易跑偏。

## 先把问题缩小到出口

出问题后我不再先怀疑业务代码，而是按固定顺序确认三件事。

第一，在**失败的那个环境**里打印 `sys.stdout.encoding` 和 `sys.stderr.encoding`。同一个脚本在 cmd 里是 `utf-8`，在计划任务里是 `cp936`，这一条就能把“代码逻辑问题”排除掉大半。不要在能跑的环境里验证编码，那只能证明能跑的环境没问题。

第二，用 `repr()` 看清到底是哪个字符编不出去。`UnicodeEncodeError` 的报错里会给出码点，比如 `\u2705`；把它和日志模板对照，通常就是某个 emoji 或特殊符号。直接看终端可能只显示一个方框，`repr` 不会骗人。

第三，分别验证三条出口：`print` 到重定向文件、`open()` 读写一个含中文的文件、`subprocess` 捕获一个输出 UTF-8 的子进程。三条里坏一条，就说明是边界编码问题，而不是某段业务逻辑。

这个顺序的好处是每一步都能独立证伪，不会在“是不是路径有中文”“是不是 venv 没激活”这些旁支上浪费一整天。

## 修复：入口统一，边界显式

我的修法分三层，原则只有一句：**不要让任何一处依赖“当前系统的默认编码”**。

第一层是进程入口，把 stdio 固定成 UTF-8，并允许替换无法编码的字符：

```python
import sys


def ensure_utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if stream is None:          # pythonw 下可能没有控制台流
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


if __name__ == "__main__":
    ensure_utf8_stdio()
    main()
```

`reconfigure` 是 Python 3.7 起提供的，3.8/3.9 都能用；`errors="replace"` 的意思是遇到实在编不出的字符就写一个替代符，而不是让整批任务退出。日志里少一个表情可以接受，少一次仿真结果不行。放在入口而不是散落在各个 `print` 前面，是为了保证之后新增的任何输出都不会再触发同类崩溃。

第二层是日志，明确用 UTF-8 写文件，不再依赖 stdout：

```python
import logging

handler = logging.FileHandler(log_path, encoding="utf-8")
handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))

logging.basicConfig(level=logging.INFO, handlers=[handler])
log = logging.getLogger("md-flow")
log.info("✅ 仿真任务已提交")
```

这里显式建 `FileHandler`，是因为 Python 3.8 的 `basicConfig` 还没有 `encoding` 参数（3.9 才加），直接传会被忽略或报错。`FileHandler` 自己带 `encoding` 已经很多年了，指定之后，无论外部 locale 是什么，文件都是 UTF-8。

第三层是所有跨进程、跨文件的边界，读写都写死编码：

```python
import os
import subprocess
import sys
from pathlib import Path

config = Path(cfg_path).read_text(encoding="utf-8")


def run_child(args: list[str]) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONUTF8": "1"}
    return subprocess.run(
        [sys.executable, "-X", "utf8", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        check=False,
    )


git_log = subprocess.run(
    ["git", "log", "-1", "--pretty=%s"],
    capture_output=True,
    text=True,
    encoding="utf-8",
    errors="replace",
    check=False,
).stdout.strip()
```

给 Python 子进程同时设 `PYTHONUTF8=1` 和 `-X utf8`，是为了让它自己的 stdio 和 `open()` 默认也走 UTF-8，父子两端对“字节代表什么”有同一个约定。`-X utf8` 保证这一次启动立即生效，环境变量则会继续传给子进程再拉起的孙进程，两个都写上是为了整条调用链不出现例外。对于 git 这类非 Python 子进程，控制不了它内部，但可以明确父进程按 UTF-8 解码，并用 `errors="replace"` 兜底，避免一个坏字节让整段日志解析失败。

最后是计划任务的启动脚本。批处理本身保持纯 ASCII，避免另一个编码坑：

```bat
@echo off
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
".venv\Scripts\python.exe" main.py >> logs\run.log 2>&1
```

`PYTHONUTF8=1` 开启 PEP 540 的 UTF-8 模式，`PYTHONIOENCODING` 再明确一次 stdio 编码。两个变量都在 Python 启动前设置，因为解释器启动时就把 stdio 编码定下来了，进程内再改环境变量对当前流无效。批处理里不要写中文注释：如果文件存成 UTF-8 而 cmd 按 GBK 解析，命令本身就可能被拆坏。

改完之后，同一个任务在 cmd 前台、Git Bash、计划任务三处都跑通，`run.log` 用 VS Code 打开，中文和 ✅ 都正常。我又故意在日志里加了几种符号做回归，没有再出现退出码 0x1。

## 为什么 chcp 65001 不是主方案

网上最常见的建议是“先 `chcp 65001`”。我试过，结论是它解决不了这个场景：

- 计划任务根本没有交互式控制台，`chcp` 改的是当前控制台的输出代码页，不是进程的 ANSI 代码页；
- 重定向到文件时，Python 取的是 ANSI 代码页（`GetACP`），`chcp` 不会改变它；
- Python 在启动时缓存 stdio 的编码，进程跑起来之后再 `chcp`，`sys.stdout.encoding` 不会跟着变；
- 前台控制台在 Python 3.6+ 本来就按 UTF-8 走，`chcp` 至多是重复劳动；
- 系统设置里的“Beta: 使用 Unicode UTF-8 提供全球语言支持”影响面更大，可能让依赖 GBK 的老程序出问题，不适合为一个小工具去改。

所以 `chcp` 最多是交互式调试时的辅助，真正稳定的做法还是把编码写进代码和启动环境。

## 小结

这次踩坑的表面是“Python 打印 emoji 崩了”，本质是**输出目标从控制台变成管道后，stdio 的编码从 UTF-8 退回 ANSI 代码页**。中文能过、emoji 不能过，只是因为 GBK 的字符集边界刚好卡在那里；日志为空，则是 traceback 自己也写不出去。

我现在给所有带无人值守入口的 Python 工具固定三件事：入口 `reconfigure` 把 stdout/stderr 设为 UTF-8 且 `errors="replace"`；日志用 `FileHandler(encoding="utf-8")`；所有 `open`、`read_text`、`subprocess` 显式写编码，并让子进程也用 UTF-8。做完这三步，编码问题就不再取决于今天从哪个终端启动、有没有控制台、系统装的是不是中文版 Windows。

