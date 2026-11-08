---
layout: post
title: "Python 3.15 的 lazy import：给 CLI 工具把重依赖挪出启动路径"
date: 2026-11-09 06:03:00 +0800
categories: 软件实战
tags: Python 3.15 PEP 810 惰性导入 CLI 性能优化
description: "Python 3.15 落地 PEP 810 显式惰性导入。我把自己 CLI 工具里的 PIL、yaml 等重依赖改成 lazy import，讲清它到底推迟了什么、错误时机怎么变、以及怎么验证没改坏行为。"
---

周五晚上我在给 md-workflow-manager 补一个命令行入口，想在 Git 的 pre-commit 里跑 `mdwm check post.md`，把 front matter 缺失、标题超长这类问题挡在提交之前。功能写完，随手敲了个 `mdwm --help`，光标在终端里顿了一下才出帮助信息。这台笔记本不算新，但一个只打印帮助文本的命令不该有这种停顿。

用 `python -X importtime -m mdwm --help 2> importtime.log` 看了一眼，原因很直白：PIL、yaml、还有我自己写的渲染模块，全都在解析参数之前就被加载了。`--help` 走的是 argparse 生成帮助文本然后退出的路径，一行图像代码都没执行，却先把图像库的初始化做完了。

Python 3.15 在 2026 年 10 月发布，带进来 PEP 810 的显式惰性导入。我把入口文件里那几行重依赖改成了 `lazy`，顺手把过程中想明白的几件事记下来。

## `lazy` 推迟的到底是什么

一条 `import` 语句在 CPython 里干三件事：找到模块、执行模块的顶层代码、把名字绑定到当前命名空间。平时说的"导入慢"，慢在第二步——很多库在顶层就把共享库、常量表、子模块全初始化了，`PIL` 和 `yaml` 都属于这一类。

`lazy` 只改一件事：把这行 import 的"执行"推迟到第一次真正使用这个名字的时候。语法上它是个软关键字，写在模块顶层：

```python
lazy import yaml
lazy from PIL import Image
```

第一次读取 `yaml` 或 `Image` 这个名字时，模块才被真正导入，PEP 里把这个动作叫 reification。注意 `lazy from PIL import Image` 并不会只加载 `Image` 这一小块，它到第一次使用时仍然要执行整个 `PIL` 包的 `__init__`，只是把时间点挪后了。

这也解释了为什么它对 CLI 特别有用：命令行工具的入口模块往往把"所有命令可能用到的依赖"都写在文件顶部，但一次调用只会走其中一条命令。`--help`、参数校验、`--version` 这些高频路径被无关的重依赖拖住了。

## 把命令分成轻路径和重路径

改造前我先列了一张表，按"这条命令会不会用到"来决定哪些导入保持原样、哪些标 `lazy`。

| 模块 | 用在哪条命令 | 处理 | 理由 |
|---|---|---|---|
| argparse、pathlib、sys | 所有命令 | 普通导入 | 每条路径都要用，推迟没有收益 |
| yaml | check | `lazy import` | 只有解析 front matter 时才需要 |
| PIL | export | `lazy from` | 初始化重，只有导出缩略图用 |
| mdwm.render | export | `lazy from` | 本地模块，但会连带拉起 PDF 相关依赖 |
| logging 配置 | 所有命令 | 普通导入 | 出错时要有日志，不能等 |

判断标准只有一条：这条导入所在的代码，是不是"每次运行都会经过"。入口、参数解析、日志、配置读取属于必经路径，保持普通导入；具体命令的实现依赖，标 `lazy`。

改完的入口文件大概是这样：

```python
# mdwm/cli.py
import argparse
import sys
from pathlib import Path

lazy import yaml
lazy from PIL import Image
lazy from mdwm.render import export_pdf
lazy from mdwm.check import check_article


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mdwm")
    parser.add_argument("path", type=Path)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="校验文章格式")
    sub.add_parser("export", help="导出 PDF 与缩略图")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "check":
        report = check_article(args.path)
        for line in report.errors:
            print(line, file=sys.stderr)
        return 1 if report.errors else 0
    export_pdf(args.path, Image)
    return 0
```

`main` 里没有出现任何 `import`，`check` 分支第一次调用 `check_article` 时，`mdwm.check` 和它内部的 `yaml` 才被加载；走 `--help` 时这些名字一次都没被读到，模块就不会执行。

## 三个必须知道的语义差异

第一是错误时机。普通导入失败，异常发生在解释器加载入口模块时，进程根本进不到 `main`；惰性导入失败，异常发生在你第一次碰这个名字的地方，PEP 明确说错误会带着链式 traceback 抛出来。对 CLI 来说这通常可以接受——错误出现在对应命令里反而更好定位。但如果你的工具在启动时做"依赖自检"，指望 `try: import xxx except ImportError` 来给友好提示，那这层逻辑就失效了：导入语句本身不会抛错。要么把自检改成 `importlib.util.find_spec`，要么在真正使用前包一层。

第二是作用域。`lazy` 只能写在模块顶层，函数和类体里不行。这不影响你原来的写法：函数体内的 `import` 本来就是用的时候才执行，本身就是惰性的。所以 PEP 810 不是"函数内导入"的替代品，它解决的是"我想把导入写在顶部、又不想在启动时付钱"这个场景。

第三是可见性和副作用。`dir()` 不会触发 reification，靠反射做插件扫描的代码不会被误加载；但 `from x import *` 仍然是急切导入。更要小心的是顶层副作用：有的库在 import 时注册 codec、设置环境变量、决定绘图后端，甚至按导入顺序初始化全局状态。比如绘图库会根据环境变量挑后端，编码相关的模块会在导入时注册别名，这些动作不会等你准备好才发生。改成 `lazy` 之后它们的发生时间变了，两段本来有先后依赖的初始化可能被翻转。遇到这类库，我会保持普通导入，而不是为了省一点启动时间赌顺序。

还有一个常见误解是把 `lazy` 当成循环导入的解药。它确实能让 A、B 两个模块在导入阶段不互相卡住，但只要两边在第一次使用时都立刻访问对方，reification 还是会在同一时刻发生。真正的解法仍然是拆出公共模块或把依赖注入进来。

## 3.15 之前我是怎么凑合的

在 PEP 810 落地之前，这类问题只有一种写法：把重依赖塞进具体的命令函数里。

```python
def cmd_check(args):
    import yaml
    meta = yaml.safe_load(args.path.read_text(encoding="utf-8"))
    ...
```

这个办法在任何 Python 版本上都能跑，但它有几个长期成本。入口文件顶部看不出这个模块真正依赖什么，读代码的人要翻到每个函数里才能拼出依赖集合；类型检查器要看这些名字，还得在 `TYPE_CHECKING` 块里再写一遍导入，两处很容易对不上；命令一多，同一组导入会在好几个函数里重复出现。`lazy` 的价值就在于把这些导入放回顶部，让依赖关系重新变得可见，同时保留"用到才执行"的语义。换句话说，它不是新造了一种写法，而是把原本只能靠位置换来的延迟，变成了可以声明在顶部的属性。

## 怎么确认没改坏行为

改完之后我做了三件事，都不依赖猜。

先跑两遍测试。一遍是默认的惰性模式，一遍用 `python -X lazy_imports=none -m pytest -q` 强制回到急切导入。后者能帮你区分"测试失败是因为这次改动"还是"本来就有的导入期副作用被推迟了"。

再对比导入轨迹。用 `python -X importtime -m mdwm --help 2> after.log` 抓一次，和改造前的日志比，看 `--help` 路径上少加载了哪些模块。这里不贴具体数字，因为每台机器的磁盘和 Python 构建都不一样，你自己跑出来的才算数。

还可以把"帮助路径不加载重依赖"这件事写成测试。它比看日志更稳定，也能防止以后有人在 `main` 里随手加一行重导入：

```python
import subprocess
import sys


def test_help_does_not_load_yaml():
    code = (
        "import runpy, sys\n"
        "sys.argv = ['mdwm', '--help']\n"
        "try:\n"
        "    runpy.run_module('mdwm', run_name='__main__')\n"
        "except SystemExit:\n"
        "    pass\n"
        "assert 'yaml' not in sys.modules, 'yaml loaded by --help'\n"
    )
    subprocess.run([sys.executable, "-c", code], check=True)
```

测试必须放在子进程里跑，因为 pytest 自己的进程可能已经被别的测试导入了这些模块，`sys.modules` 里是否干净不可靠。子进程里跑一个全新的解释器，才是在验证真实用户敲命令时的那条路径。

最后把每条子命令都手动走一遍，尤其是失败路径：缺文件、缺依赖、格式错误。惰性导入把异常挪到了使用点，失败提示的语气和退出码要重新看一遍，别出现"堆栈里全是我没见过的模块"这种情况。

## 什么时候用不了

`lazy` 是 Python 3.15 才有的语法，老解释器解析到这行会直接报错，而不是"不认识就退回急切导入"。所以它值不值得用，取决于你的部署面：只在自己机器和 CI 上跑、已经统一到 3.15 的工具，可以放心写；如果还要兼容 3.12、3.13 的用户，入口文件就不能出现 `lazy`，只能继续用函数内导入，或者在需要的地方通过 `importlib` 显式加载。我的 pre-commit 钩子跟着本机解释器走，才敢直接改。给别人的库加这个语法之前，先看清楚 `requires-python`，这比启动快一点重要得多。

## 小结

PEP 810 给的是一个很克制的工具：只加了一个软关键字、只允许写在模块顶层、还能用 `-X lazy_imports=none` 一键退回急切模式。它对 CLI、脚本和小工具的价值最大——这些程序经常只走一条命令，却要为整个依赖图买单。真正要动脑子的是判断哪些导入属于必经路径、哪些库的导入副作用不能推迟，以及把依赖自检从 `try/except ImportError` 改成显式探测。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

