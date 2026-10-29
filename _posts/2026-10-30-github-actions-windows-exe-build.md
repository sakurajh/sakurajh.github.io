---
layout: post
title: "GitHub Actions 打包 Windows exe：中文编码与产物上传"
date: 2026-10-30 06:03:00 +0800
categories: 软件实战
tags: GitHub Actions PyInstaller CI/CD Windows 打包发布
description: "md-workflow-manager 每次发版都要手动 PyInstaller 打包、改文件名、传 Release，漏一步就得重来。这篇记录我把它搬上 GitHub Actions 的过程：为什么必须用 windows-latest、中文"
---

我的 md-workflow-manager 是个 tkinter 小工具，用户下载的是 exe，不是源码。发版流程一直靠手：开虚拟环境、跑 PyInstaller、把 `dist` 里的 exe 改成带版本号的名字、在 GitHub 上新建 Release 再把文件拖上去。工具本身不大，整套动作十来分钟，但出过两次事故。

一次是忘了加 `--noconsole`，用户双击后命令行黑框跟着弹出来；另一次更麻烦，我在本地改完代码只打了 tag，忘记重新打包，Release 里的 exe 其实是上一个版本的。两次事故的共同点很清楚：产物是手工做的，它和源码之间没有任何约束，全凭我记得。

所以我把它搬上了 GitHub Actions，让「打 tag」这一个动作同时产出源码版本和可执行文件。这篇写的是过程中真正卡住我的几件事，不是一份照着抄就能跑的教程。

## 一、为什么必须是 windows-latest

第一反应是用 ubuntu runner，毕竟便宜又快。但这个念头很快被打掉：PyInstaller 不支持交叉编译，它产出的可执行文件要嵌入当前平台的 bootloader 和目标平台的依赖。在 Linux 上打 Windows exe 只能靠 Wine，遇到 `pywin32`、`winreg` 这类直接调 Win32 API 的模块基本必挂。我的工具要读写注册表、调系统对话框，属于这类。

主机的差异直接反映在计费上：

| 项 | windows-latest | ubuntu-latest |
|---|---|---|
| 能否原生产出 exe | 能 | 不能，需 Wine |
| 调用 Win32 API 的依赖 | 原生支持 | 大量失败 |
| 分钟计费倍率 | 约 2 倍 | 1 倍 |
| 公共仓库 | 免费 | 免费 |

私有仓库要按倍率算额度，但发版频率低，这点成本可以接受。真正劝退我的是「在 Wine 里调试 PyInstaller」这种时间黑洞。

## 二、workflow 的骨架

我的触发条件是推 tag，同时保留手动触发，方便发版失败后单独补跑：

```yaml
name: build-windows-exe

on:
  push:
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip

      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt pyinstaller

      - name: Build
        env:
          PYTHONUTF8: "1"
          PYTHONIOENCODING: "utf-8"
        run: pyinstaller --noconfirm --clean app.spec

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: md-workflow-manager-win64
          path: dist/*.exe
          if-no-files-found: error

      - name: Publish release
        uses: softprops/action-gh-release@v2
        with:
          files: dist/*.exe
```

几个地方值得解释。`permissions: contents: write` 不能省：仓库默认给 `GITHUB_TOKEN` 的是只读权限，不声明这一行，最后一步会以 `Resource not accessible by integration` 收场。`if-no-files-found: error` 是我特意加的，默认行为是警告后继续，结果就是构建目录空着也能「成功」，比直接报错更难查。

`cache: pip` 只缓存依赖下载，不缓存 `dist` 和 `build`。PyInstaller 的中间产物和解释器版本、依赖树强相关，缓存它省不了多少时间，却容易把上一次的残留打进新 exe。发版讲究可复现，我宁可每次从干净目录开始。

文件名里的版本号我交给 tag 推导，不再手写。手写版本号是「产物和源码对不上」的另一个源头：改代码时记得改，打完包又忘了改回来，最后 Release 里躺着一个 1.4.0 名字、1.3.2 内容的 exe。做法是把 tag 去掉 `v` 前缀后塞进环境变量，PyInstaller 在 spec 里读它拼文件名，构建日志里也打印一遍，出问题能直接对账。同时我会在 `pyproject.toml` 里维护同一个版本号，测试里断言两者一致，这样「改版本」变成了一次提交，而不是两份手工记录。

## 三、中文编码出问题的地方有三处

日志乱码是我踩得最久的一个坑。现象很迷惑：同一个 `print("开始打包")`，本地跑得好好的，到了 Actions 页面变成一串问号，偶尔还直接抛 `UnicodeEncodeError`。

原因要分三层看，它们经常被混为一谈：

1. **终端代码页**：Windows 控制台默认用系统 ANSI 代码页（简中是 CP936）。本地运行时 Python 连着控制台，属于「交互式终端」；CI 里 `run` 的输出被重定向到管道和日志文件，属于「非交互」，Python 这时用的不是控制台编码，而是 locale 编码，两者不一致就出问题。
2. **解释器的 IO 编码**：`stdout`、`open()` 的默认编码都由它决定。
3. **压缩包里的文件名编码**：这是另一回事，exe 和 zip 里的中文名在不同解压工具下表现不同。

我的处理是同时固定前两层：

```yaml
env:
  PYTHONUTF8: "1"
  PYTHONIOENCODING: "utf-8"
```

`PYTHONUTF8=1` 打开 Python 的 UTF-8 模式，让 `open()`、`sys.stdout` 等默认走 UTF-8，不看系统 locale；`PYTHONIOENCODING` 再把流编码钉死一次。只设后者也能救 `print`，但脚本里 `open("配置.txt")` 这类隐式编码的读写仍会按 locale 走，所以我两个都留着。

这么做的代价要提前想清楚：UTF-8 模式会让「读一个 GBK 编码的老文件」从静默乱码变成直接抛异常。对我来说这是好事——乱码比报错难查得多。相应地，我把所有源文件统一成 UTF-8，读文件时显式写 `encoding="utf-8"`，不留隐式默认。

第三层我干脆绕开：artifact 名、Release 资产名、版本号全部用纯 ASCII，比如 `md-workflow-manager-1.4.0-win64.exe`。中文名本身能上传，但用户下载后用什么工具解压不受我控制，与其解释乱码，不如不让它出现。

## 四、PyInstaller 在 CI 里的路径差异

本地打包时，当前目录就是项目根目录，所有相对路径都「碰巧」对。CI 里工作目录变成了 `D:\a\md-workflow-manager\md-workflow-manager`，任何写死盘符的路径都会失效，而且是在打包成功、运行才崩的那种失效。

我的做法是把配置收进 spec 文件，路径基于 spec 自身位置算：

```python
# app.spec
from pathlib import Path

ROOT = Path(SPECPATH)

a = Analysis(
    ["app.py"],
    pathex=[str(ROOT)],
    datas=[(str(ROOT / "assets"), "assets")],
    hiddenimports=["pystray._win32"],
    excludes=["tkinter.test", "unittest"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas,
    name="md-workflow-manager",
    console=False,
    icon=str(ROOT / "assets" / "app.ico"),
)
```

`SPECPATH` 是 PyInstaller 注入的 spec 目录，比自己拼 `os.getcwd()` 可靠。`datas` 用列表套元组，比命令行 `--add-data` 少一层分隔符问题——那个参数在 Windows 上要求 `源;目标`，写成冒号会被当成路径的一部分，本地和 CI 都是 Windows 反倒不容易发现写错了。

运行时取资源更不能拼路径，exe 解压后的目录和源码目录不是一回事：

```python
import sys
from pathlib import Path

BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
ICON = BASE / "assets" / "app.ico"
```

另外两个高发问题。第一，图标文件被 `.gitignore` 排除：本地明明有，CI checkout 下来没有，PyInstaller 直接报 `icon file not found` 失败。押 tag 前我会先 `git ls-files assets/` 看一眼。第二，动态 import 的模块静态分析不到，比如 pystray 的后端、某些插件的 driver，本地因为环境里装过所以能跑，exe 里就 `ModuleNotFoundError`。这类只能靠 `hiddenimports` 或 `collect-all` 补。

把这些现象归到一起，就是一张排查表：

| 现象 | 根因 | 处理 |
|---|---|---|
| 日志中文变问号或 `UnicodeEncodeError` | 重定向后的 stdout 用 locale 编码 | 设 `PYTHONUTF8=1` 与 `PYTHONIOENCODING=utf-8` |
| `Artifact with the name ... already exists` | v4 的 artifact 不可变，同名不能二次上传 | 每个 job 用唯一名字，矩阵里拼上变量 |
| `Resource not accessible by integration` | `GITHUB_TOKEN` 默认只读 | 声明 `permissions: contents: write` |
| `icon file not found` | 资源文件被 gitignore 排除 | 先 `git ls-files` 确认，路径走 `SPECPATH` |
| exe 启动即 `ModuleNotFoundError` | 动态 import 未被静态分析 | 补 `hiddenimports` / `collect-all` |

## 五、产物上传与重跑的边界

`upload-artifact` v4 把产物改成了不可变的：同名 artifact 第二次上传会直接报错。这和 v3 的「追加合并」行为相反，网上很多老教程还停留在 v3。我只有一个 job，所以没撞上；如果以后拆成多架构矩阵，每个 job 的 `name` 必须带上矩阵变量。

Release 那边，`softprops/action-gh-release` 会按 tag 找 Release，没有就新建，所以失败重跑不会产生第二个 Release。但同名资产会被覆盖，意味着「重跑一次」等于「用新构建替换旧文件」。在这一点上，我把版本号放进 exe 文件名，让同名覆盖不会悄悄发生在两个不同版本之间。

artifact 和 Release 我两个都传，因为用途不同。artifact 是构建过程的副本，默认保留 90 天，私有仓库还占配额，我设成 7 天就够——它主要用来在 Release 上传失败时先保住产物，以及排查「构建成功但用户装不上」时对比文件。Release 才是长期归档，用户从这里下载，所以清单要干净：一个 exe，必要时加一个 SHA256 校验文件。把日志、spec、中间产物一起塞进 Release，只会让用户不知道该点哪个。

还有一件 CI 解决不了的事：代码签名。未签名的 exe 首次运行会被 SmartScreen 拦一道，用户要手动点「仍要运行」。CI 只保证「产物来自这个 tag」，不保证「系统信任这个程序」，这两件事别混在一起谈。

## 六、小结

现在的发版流程是：改版本号提交 → 打 tag 推送 → 等 Actions 跑完 → 在 Release 里下载 exe，在一台没装过 Python 的机器上双击试跑。本地仍然保留手动打包，只用于开发时快速验证，不再产出对外文件。

回头看，把打包搬进 CI 真正买到的不是那十分钟，而是三条可验证的约束：

1. tag 对应的源码和 exe 来自同一次构建，不存在「忘了重新打包」；
2. 构建环境是干净的 Windows runner，不再依赖我本机装过什么；
3. 编码、路径、权限这些隐性前提都写进了 workflow，换机器不会失效。

代价也很实在：调 workflow 本身要花时间，Windows runner 计费更高，失败时要多看一眼日志。所以我的判断标准是——只要这个东西会以 exe 形式发给别人，就值得上一次 CI；只在本地跑一跑的小脚本，反而没必要。

