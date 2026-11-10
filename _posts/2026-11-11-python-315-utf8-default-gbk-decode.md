---
layout: post
title: "Python 3.15 默认 UTF-8 后，GBK 日志读取崩了：PEP 686 根因"
date: 2026-11-11 06:03:00 +0800
categories: 踩坑修复
tags: Python 3.15 PEP 686 字符编码 UnicodeDecodeError Windows
description: "升级到 Python 3.15 后，负责归档周报的脚本在部分 GBK 文本上抛出 UnicodeDecodeError。本文记录从字节排查、环境探针到定位 PEP 686 的过程，并给出不关闭 UTF-8 模式的兼容写法与取舍。"
---

上周我把本机的 Python 从 3.14 换到 3.15，顺手把每周归档周报的小脚本也换了过去。脚本做的事很简单：扫描一个目录里的 txt 和 csv，按日期切段，生成 markdown 汇总。3.14 上它跑了几个月没出过事，换到 3.15 的第一次运行，26 个文件里有 3 个直接抛 `UnicodeDecodeError`，而且报错位置都在某一行的中间。

先说结论：这不是文件坏了，也不是我的循环写错了，是 Python 3.15 按 PEP 686 把默认编码改成了 UTF-8。理解这一点之后，修复只花了十几分钟；但如果不理解，很容易把方向查到“文件损坏”上去，白绕一大圈。

## 现象：同目录文件，只有一部分崩

报错大致是这样：

```text
UnicodeDecodeError: 'utf-8' codec can't decode byte 0xb5 in position 47: invalid start byte
```

失败的是 9 月的手工记录和两张从 Excel 导出的表；成功的是我近期用 VS Code 保存的文件。相同目录、相同后缀、相同读取代码，差别只在文件内容。这基本排除了路径、权限和循环逻辑。

## 第一次误判：以为文件被截断

我首先怀疑写入时断电，文件尾部不完整。用二进制方式看了一眼出错位置附近：

```python
from pathlib import Path

data = Path("logs/2026-09-week2.txt").read_bytes()
print(len(data), data[40:60])
print("BOM:", data[:3])
```

输出里出现了 `0xb5 0xc4` 这样的连续字节，没有 BOM，也不是 `\x00` 填充。`0xb5` 在 GBK 的汉字编码里很常见，通常作为第二个字节出现；在 UTF-8 里它却不是合法的起始字节。这已经把嫌疑指向“文件是 GBK，读取却按 UTF-8”。

## 三行探针，把默认值摊开

真正让我确认的是这段环境探针：

```python
import sys, locale
print(sys.version)
print("utf8_mode =", sys.flags.utf8_mode)
print("preferred =", locale.getpreferredencoding(False))

text = open("logs/2026-09-week2.txt").read()
```

3.14 下输出 `utf8_mode = 0`、`preferred = cp936`；3.15 下变成 `utf8_mode = 1`、`preferred = utf-8`。同一台机器、同一个中文 Windows，只有解释器变了。

关键在于我的代码根本没用 `encoding=`。`open()`、`Path.read_text()`，以及我传给 `csv`、`json` 模块的文本流，都会落到“默认编码”上。以前这个默认值跟着系统 locale 走，中文 Windows 上通常是 cp936；从 3.15 开始，PEP 686 让它固定为 UTF-8。官方文档写得很明确：Python 3.15 于 2026 年 10 月 9 日发布，I/O 默认编码改为 UTF-8，不再依赖系统环境。

所以“3.14 能跑”不是因为我写对了，而是因为系统默认值恰好和文件编码一致。升级把这份巧合拿掉了。

再补一层背景：中文 Windows 的“ANSI”代码页就是 cp936（GBK 的超集）。记事本另存为 ANSI、Excel 里选“CSV（逗号分隔）”，落盘的都是这种编码；只有选“CSV UTF-8”才会写成带 BOM 的 UTF-8。我那份 9 月的手工记录是在旧笔记本上用记事本写的，两张表是从 Excel 按老习惯导出的，所以它们天然是 GBK。而 VS Code 默认按 UTF-8 保存，新文件自然没事。三类文件混在一个目录里，平时看不出差别，一旦默认编码从 cp936 切到 UTF-8，老的先崩。

## 第二个坑：用 locale 猜编码也失效了

我原来的兜底逻辑是：先试 UTF-8，失败就 `locale.getpreferredencoding(False)` 拿到“系统编码”再读一次。这个逻辑在 3.15 上彻底失效——UTF-8 模式下它返回的也是 `utf-8`，于是两次都用同一个编码，第二次必然再失败。这解释了为什么我的 try/except 看起来写了兜底却没有生效。

这类“读默认值”的代码比显式写死更隐蔽：它没有语法错误，测试环境也可能一直通过，只有换了运行环境才暴露。

## 修复：显式编码，加有序回落

我不打算关掉 UTF-8 模式，而是把“文件到底是什么编码”这件事在代码里说清楚。对来源混杂的历史文件，我用一个小的有序回落函数；对新生成的文件，直接显式 `encoding="utf-8"`。

```python
from pathlib import Path

def read_text_any(path: str) -> tuple[str, str]:
    raw = Path(path).read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig"), "utf-8-sig"
    for enc in ("utf-8", "gbk"):
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            continue
    raise ValueError(f"无法识别的文本编码: {path}")

# 新文件：编码是契约的一部分，写死
Path("out/summary.md").write_text(md, encoding="utf-8", newline="\n")
```

几点取舍：

1. 先判 BOM。Excel 导出的 UTF-8 CSV 常带 BOM，用 `utf-8` 读会在第一列字段名里留下 `\ufeff`，导致按列名取值失败；`utf-8-sig` 能吃掉它。
2. 回落顺序是 UTF-8 → GBK。GBK 字节恰好构成合法 UTF-8 序列的概率不高，但不是零，所以这个函数只用于人工归档，不用于需要严格校验的数据管道。
3. 大文件不要整块 `read_bytes()`。我这里最大也就几百 KB，图省事；日志上 GB 的场景要改成流式读取，失败后再回退，否则内存翻倍。
4. 不用 `errors="replace"` 当默认修复。它确实不抛异常，但会把所有无法解码的字节变成 `�`，数据静默损坏，比直接报错更难查。

| 做法 | 能读 GBK | 风险 |
|---|---|---|
| 不写 encoding，靠默认值 | 3.14 能，3.15 不能 | 行为随解释器版本变化 |
| 写死 `encoding="gbk"` | 能 | 换成 UTF-8 文件立刻崩 |
| `errors="replace"` | 不崩 | 静默丢字符，数据失真 |
| UTF-8 → GBK 有序回落 | 两类都能读 | 极少数文件可能误判 |
| `PYTHONUTF8=0` | 恢复旧默认 | 全局副作用，子进程和 CI 不一致 |

## 把漏网的 encoding 一次性找出来

修完这三处不算完，同样的问题可能藏在别的模块里。靠肉眼 grep `open(` 很容易漏掉链式调用，我写了个基于 `ast` 的小扫描器，把当前目录下所有 Python 文件里的文本读写调用列出来，只报没有 `encoding=` 关键字的：

```python
import ast
from pathlib import Path

SUSPECT = {"open", "read_text", "write_text", "read_csv", "to_csv"}

for path in Path("src").rglob("*.py"):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        name = fn.id if isinstance(fn, ast.Name) else getattr(fn, "attr", "")
        if name in SUSPECT and not any(k.arg == "encoding" for k in node.keywords):
            print(f"{path}:{node.lineno}: {name}() 没有声明 encoding")
```

这只是启发式检查：`read_csv` 的 `encoding` 有时确实可以省略，`open(..., "rb")` 也不该要求编码。扫描结果要人工过一遍，但比翻遍整个仓库快得多。我扫出 11 处，其中 6 处是二进制模式可以忽略，剩下 5 处逐个补上显式编码。

## 用测试钉住这个行为

修完还要防止回退。我给读取函数补了一个参数化测试，直接把字节写进临时文件，覆盖 UTF-8、GBK、带 BOM 三种来源：

```python
import pytest
from pathlib import Path
from archive import read_text_any

@pytest.mark.parametrize("payload", [
    "周报归档".encode("utf-8"),
    "周报归档".encode("gbk"),
    b"\xef\xbb\xbf" + "周报归档".encode("utf-8"),
])
def test_read_text_any(tmp_path: Path, payload: bytes):
    p = tmp_path / "sample.txt"
    p.write_bytes(payload)
    text, enc = read_text_any(str(p))
    assert text == "周报归档"
    assert enc in {"utf-8", "gbk", "utf-8-sig"}
```

测试里用 `write_bytes` 而不是 `write_text`，是因为要绕开被测函数自己的编码逻辑，构造出确定的输入。如果哪天有人把 `utf-8-sig` 分支删了，这个用例会立刻失败，而不是等到半年后再处理一堆 `\ufeff` 开头的字段名。



最省事的做法是设 `PYTHONUTF8=0`，或者用 `python -X utf8=0` 启动，让 3.15 退回旧行为。我只在排查时这么用过一次，没有写进任何脚本或系统环境变量。原因是：这会把“我这台机器能跑”重新变成一个环境假设，而问题本身是代码没有声明编码。更麻烦的是，`PYTHONUTF8` 只影响当前解释器进程，通过 subprocess 启动的子进程、CI runner、别人电脑上的 Python 都可能不遵守，最后又回到“只有我这儿正常”。

反过来，显式 `encoding` 跨版本、跨平台都成立：Windows 上读 GBK 文件、Linux 上读 UTF-8 文件、Docker 里 `LANG=C` 的镜像，行为一致。升级大版本时，这类“默认值审计”比逐个修报错更省时间——`open`、`subprocess` 的 `text=True`、`csv`、`json` 的读写、日志 handler，凡是依赖 locale 的地方都值得检查一遍。

还有一个容易被忽略的地方：UTF-8 模式不只管 `open()`。`subprocess.run(..., text=True)` 在没指定编码时也会按 UTF-8 解码子进程输出；如果子进程是老的 Windows 工具、吐的是 GBK，升级后同样会炸。我在另一个调用 `tasklist` 的脚本里就遇到过，最后显式传了 `encoding="gbk", errors="replace"`。这里用 `replace` 是可以接受的，因为那只是展示用的进程名，不需要严格保真；但数据落盘时仍然不能用它。

最后验证：同一批 26 个文件，用 `-X utf8=1` 和 `-X utf8=0` 各跑一遍，再加上修复后的读取函数，26 个全部成功，GBK 文件里抽查的中文也没有乱码。升级本身没有错，错的是我把“默认值”当成了“约定”。

顺便说一句，3.15 里变掉的不止编码：`argparse` 的 `suggest_on_error` 默认值也改成了开启。这类变化不会报错，只会悄悄改变程序行为，所以升级后先把现有测试和几条主流程跑一遍，比通读 changelog 更快发现问题。

## 小结

这次问题的根因不在某一行代码，而在解释器的默认值：Python 3.15 按 PEP 686 把文本 I/O 的默认编码统一成 UTF-8，中文 Windows 上原本靠 cp936 兜着的旧文件立刻暴露出来。排查顺序是“看字节 → 看环境 → 看版本变更”，修复原则是显式声明编码，而不是把整个解释器的行为改回去。如果你也在升级 3.15，先给所有不带 `encoding` 的读写做一次 grep，能省掉大部分这类报错。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

