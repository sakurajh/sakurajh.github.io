---
layout: post
title: "Python 3.15 的 sentinel()：三层配置合并区分没传与 null"
date: 2026-11-13 06:06:00 +0800
categories: 软件实战
tags: Python 3.15 PEP 661 sentinel 配置合并 argparse CLI
description: "Python 3.15 按 PEP 661 内置了 sentinel()。我用它重写了 gpu-switch-helper 的三层配置合并，讲清为什么 None 当哨兵会把缺省和显式清空混成一件事，以及哨兵在 pickle、日志和类型标注上"
---

上个月我在自己的 gpu-switch-helper 上加了一层配置：内置默认值、`%APPDATA%/gpumode/settings.json`、命令行参数，三层按优先级覆盖。功能看着很简单，直到有一天我把笔记本合盖再打开，屏幕还挂在核显上，窗口拖动一顿一顿的。查日志才发现，`fallback` 的定时器根本没被装上。

原因很尴尬：我启动命令时没写 `--timeout`，argparse 给的是 `None`，合并函数把这个 `None` 当成用户的真实意图写进了最终配置，顺手把 JSON 里的 30 秒覆盖成了空。而下游的 `if cfg["timeout"]:` 判断为假，就不去 arm 定时器了。

问题不在那行 `if`，在于我从一开始就让 `None` 同时承担了两个含义：**"用户没说话"** 和 **"用户说这里要清空"**。Python 3.15 在 2026 年 10 月发布后，`sentinel()` 成了一个内置函数（PEP 661），正好是为这类场景准备的。我把整个合并层重写了一遍，过程里踩到的几个细节值得记下来。

## 一、三层配置合并，None 天生不够用

配置合并的本质是：从低优先级往高优先级叠，某一层"没提到这个键"就不该参与覆盖。麻烦在于 Python 里没有"没提到"这个值——字典找不到键是 `KeyError`，`dict.get` 又用 `None` 表示缺失，于是 `None` 被迫兼职。

我的旧写法是这样的：

```python
DEFAULTS = {"mode": "auto", "timeout": 30, "fallback": True}

def merge_config(file_cfg: dict, cli_cfg: dict) -> dict:
    merged = dict(DEFAULTS)
    merged.update({k: v for k, v in file_cfg.items() if v is not None})
    merged.update({k: v for k, v in cli_cfg.items() if v is not None})
    return merged
```

这段代码有两个方向的错。第一个方向是"该表达的表达不出来"：`cli_cfg` 里没写的参数也是 `None`，被 `if v is not None` 过滤掉，看起来"没说话"这件事被处理了，但这是靠**约定**成立的。只要哪天需要"命令行显式清空 JSON 里的某项"，就完全没有语法可用——用户写 `--timeout null`，argparse 交上来的就是 `None`，合并层分不清他是想清空还是压根没提，最后两件事被迫同义。

第二个方向是"该保留的被扔掉"：`file_cfg` 里合法的 JSON `null` 也命中了同一个过滤条件，被当成缺失丢掉。我最初在 settings.json 里写 `"fallback": null` 想表示"这一项不启用"，结果合并后拿到的是内置默认的 `True`，自认为关掉了，实际一直开着。这种反向错误比前一种更阴，因为程序不报错、配置看着也对，只有行为不对。

这跟 Pydantic 里 `model_dump(exclude_unset=True)` 的存在理由是同一件事：在序列化层面，`None` 和"未设置"本来就是两种状态，靠一个值硬扛，迟早要在某个分支上还债。

## 二、我试过的几种"假哨兵"

在 3.15 之前，这类场景我都是用别的对象硬顶，每个都有代价。

| 方案 | 能区分缺省与 null | 优点 | 实际问题 |
|---|---|---|---|
| `None` | 否 | 零成本、类型自然 | 与合法 null 冲突，下游到处写 `if x:` 兜底 |
| `object()` | 是 | 零依赖 | `repr` 是一串内存地址，日志里没法看 |
| `Ellipsis` | 是 | 现成单例、可 pickle | 借用 `...` 的语义，半年后自己都要想一下 |
| 字符串 `"__UNSET__"` | 是 | 日志友好 | 用户真传这个字符串就撞车，类型也不对 |
| `enum.Enum` 成员 | 是 | 类型清晰、可迭代 | 得单独写个类，`repr` 是 `<Cfg.Unset: ...>` |
| `sentinel()`（3.15） | 是 | `repr` 干净、可拷贝、可 pickle | 需要 3.15+ |

那个 `object()` 的坑我很熟：`repr` 打出来是 `<object object at 0x0000023A...>`，每次运行地址都不一样，日志一比对全是噪音。`Ellipsis` 好一点，但我在 review 别人的代码时见过 `value is ...`，第一反应永远是"这里是不是少写了什么"。

## 三、sentinel() 给的是什么

`sentinel` 现在是内置的，不需要 import；我显式 `from builtins import sentinel` 是为了让静态检查工具和后来读代码的人一眼看出这不是自定义函数。

```python
from builtins import sentinel

UNSET = sentinel("UNSET")

print(repr(UNSET))            # UNSET
print(UNSET is copy.copy(UNSET))  # True

import pickle
print(pickle.loads(pickle.dumps(UNSET)) is UNSET)  # True
```

它的行为可以归成四条：

1. **`repr` 就是你给的名字**。`sentinel("UNSET")` 打印出来就是 `UNSET`，不会再看到内存地址，日志里一搜就能定位。
2. **相等性退回身份比较**。哨兵没有自定义 `__eq__`，所以判断只用 `is`，这也是 PEP 里推荐的写法。
3. **拷贝保留身份**。`copy.copy` 之后还是同一个对象，不会分裂出第二个"看起来一样的 UNSET"。
4. **可以 pickle**。这一点容易误解：它并不是把对象本身序列化进去，而是按"模块名 + 名字"还原。所以哨兵必须定义在**模块顶层**，且变量名和名字一致——如果你在函数内部临时 `sentinel("TMP")`，反序列化时按名字找不到它，就会失败。

还有一条是我翻 issue 才注意到的：内置的 `sentinel` 不允许子类化，`typing_extensions` 里那个 `Sentinel` 作为过渡版本是可以继承的。我不需要子类，但如果你习惯用自定义类带方法，这点要提前想清楚。

## 四、把合并层改成"跳过 UNSET"

改完之后，argparse 的 `default` 全部换成 `UNSET`，同时给需要"显式清空"的参数留一个把字符串 `null` 解析成 `None` 的入口：

```python
import argparse
from builtins import sentinel

UNSET = sentinel("UNSET")


def nullable(text: str):
    # 命令行里写 null / none / 空串，表示"这一项显式清空"
    return None if text.strip().lower() in {"", "null", "none"} else text


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="gpumode")
    p.add_argument("--mode", choices=["auto", "igpu", "dgpu"], default=UNSET)
    p.add_argument("--timeout", type=nullable, default=UNSET)
    p.add_argument("--fallback", action=argparse.BooleanOptionalAction,
                   default=UNSET)
    return p


def merge_config(*layers: dict) -> dict:
    merged: dict = {}
    for layer in layers:                 # 从低优先级到高优先级
        for key, value in layer.items():
            if value is UNSET:           # 这一层没说话，直接跳过
                continue
            merged[key] = value
    return merged
```

调用侧变成 `merge_config(DEFAULTS, file_cfg, vars(args))`。注意这里不再有"过滤掉 None"的动作：**`None` 现在是一种真实取值，会被写进结果**，由下游解释成"这一项关掉"。`UNSET` 才是被跳过的那个。

三层配置在各种情况下拿到的值，改前改后的差别是这样的：

| 场景 | 旧写法（None 当哨兵） | 新写法（UNSET 当哨兵） |
|---|---|---|
| 命令行没写 `--timeout` | `None`，把 JSON 里的 30 覆盖掉 | `UNSET`，保留 30 |
| 命令行写 `--timeout null` | 无法表达，和上一行同义 | `None`，明确清空 |
| JSON 里写 `"timeout": null` | 被当成缺失丢弃 | `None`，正常传入下游 |
| 三层都没有这一项 | `None` | 键不存在，下游用默认值兜底 |
| 日志里打印当前值 | 分不清是没设还是设空了 | `UNSET` / `None` 一眼可辨 |

`BooleanOptionalAction` 和 `UNSET` 搭配也顺：`--fallback` 得到 `True`，`--no-fallback` 得到 `False`，都没写则是 `UNSET`。以前用 `default=None` 时，"关掉 fallback"和"没提 fallback"在 argparse 层就已经糊在一起了。

合并逻辑改完一定要用测试钉住，否则以后有人"顺手"把 `is UNSET` 改成 `not value`，一切又会静悄悄地坏回去。我加的几条用例：

```python
import unittest

class MergeConfigTest(unittest.TestCase):
    def test_unset_is_skipped(self):
        cli = {"timeout": UNSET}
        cfg = merge_config({"timeout": 30}, cli)
        self.assertEqual(cfg["timeout"], 30)

    def test_explicit_none_clears(self):
        cli = {"timeout": None}
        cfg = merge_config({"timeout": 30}, cli)
        self.assertIn("timeout", cfg)
        self.assertIsNone(cfg["timeout"])

    def test_layer_without_key_is_untouched(self):
        cfg = merge_config({"timeout": 30}, {})
        self.assertEqual(cfg["timeout"], 30)
```

第二条最重要：`assertIn` 和 `assertIsNone` 一起写，才能同时确认"键还在"和"值被清空"。只写 `assertIsNone` 的话，键缺失时 `cfg.get("timeout")` 也是 `None`，测试照样绿，等于什么都没验证。

## 五、顺手用 frozendict 做配置快照的键

改的过程中我发现缓存也有问题。切换 GPU 模式后要把当前配置存一份快照做去重，我原来的键是 `tuple(sorted(cfg.items()))`，遇到嵌套的 `styles` 字典就崩，因为 `dict` 不可哈希。

3.15 同时内置了 `frozendict`（PEP 814），正好补这个位置：

```python
from builtins import frozendict

snapshot = frozendict({
    "mode": cfg["mode"],
    "timeout": cfg["timeout"],
    "fallback": cfg["fallback"],
})
cache_key = (snapshot, settings_path.stat().st_mtime_ns)
```

两个行为值得说清楚：一是比较时**忽略键的插入顺序**，`frozendict(a=1, b=2)` 和 `frozendict(b=2, a=1)` 相等且哈希相同，这正好是我要的"配置内容一样就算同一份"；二是 `isinstance(snapshot, dict)` 是 `False`，它不是 `dict` 的子类。我代码里有几处 `isinstance(x, dict)` 的判断因此漏掉了快照对象，改成 `isinstance(x, collections.abc.Mapping)` 才对。值里如果有 `list`，哈希依然会失败，得先转成 `tuple`。

## 六、什么时候不该用它

哨兵解决的是"进程内部区分未设置"，不是给外部协议用的。我给自己定了两条线：配置文件里永远写真正的 `null`，不把哨兵序列化出去；HTTP 接口的请求体里也照旧用可空字段加 `exclude_unset`，不把内部约定漏到 API 契约上。哨兵一旦跨进程，就从"一个明确的状态"退化成了"对方看不懂的怪值"。

另一条经验是别把它铺得太开。我最初想给每个配置项都包一层 `Optional`，写了两天发现大部分字段根本不需要区分——`mode` 这种有明确默认值的项，"没提"和"提了默认值"结果一样，加哨兵只会让类型签名变丑。真正值得用的只有三类：会被命令行覆盖的项、能被显式关掉的开关、以及要在日志里追问"这个值到底从哪一层来的"的项。剩下的就老老实实用默认值。

还有一点：老版本环境我仍然用 `object()` 兜底，只是把它的 `__repr__` 换掉太麻烦，宁可日志难看一点，也不为了统一而引入 `typing_extensions` 的额外依赖。

## 小结

`None` 是值，`UNSET` 是状态，这两件事混在一个变量里时，bug 往往不在崩溃处，而在"看起来一切正常、只是某个功能悄悄没生效"的地方——我那次就是定时器没装上，屏幕卡了才发现。3.15 的 `sentinel()` 把这件事做成了一个内置能力：`repr` 干净、拷贝保身份、按名字 pickle 还原，代价是必须定义在模块顶层。配合 `frozendict`，配置从"合并"到"做缓存键"这一条链路都能保持不可变与可哈希，省掉不少手工转换。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

