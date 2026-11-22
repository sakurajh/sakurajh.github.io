---
layout: post
title: "用 frozendict 和 sentinel 重写 FastAPI 配置与 PATCH"
date: 2026-11-23 06:04:00 +0800
categories: 软件实战
tags: Python 3.15 frozendict sentinel FastAPI 不可变数据结构
description: "配置被请求处理函数顺手改掉、PATCH 分不清「没传」和「传了 null」，这两个问题我用 Python 3.15 新内置的 frozendict 与 sentinel 在类型层面解决，附可直接套用的代码和选型对比表。"
---

上周给 travel-journal 加「按用户偏好排序行程」的功能，本地测试全绿，部署后第二天早上发现所有用户拿到的默认每页条数从 20 变成了 50。排查了半天，原因很朴素：配置是模块级的一个 `dict`，有个处理函数为了临时调试写了 `settings["page_size"] = 50`，忘了删。同一个进程里后续所有请求都读到被改过的值，测试没发现是因为测试进程跑完就退了。

同一周还踩了另一个坑：PATCH 接口里用户想把备注清空，前端发 `{"note": null}`；但另一些请求根本没带 `note` 字段，后端也把备注清了。因为函数签名里 `note: str | None = None`，「没传」和「传了 null」被压成了同一个值。

两个事故的共性，都是「本来该不可变的东西被当成了可变」和「缺失状态没有自己的表示」。Python 3.15 刚好把 `frozendict` 和 `sentinel` 收进了内置类型，我干脆把这两处都重写了。

## 一、frozendict 冻结的是哪一层

`frozendict` 是 3.15 新增的内置类型，关键事实有三条：它不是 `dict` 的子类，直接继承 `object`；它没有 `update`、`pop`、`__setitem__` 这些修改方法；只有当所有键和值都可哈希时，`hash(frozendict)` 才成立。另外 `fd |= other` 不会原地改，而是生成一个新的冻结字典。

最容易被忽略的是「只冻顶层」。嵌套的普通 `dict`、`list` 仍然可变，而且因为不可哈希，会让整个 `frozendict` 的 `hash()` 失败：

```python
from functools import lru_cache
import yaml

def _freeze(node):
    if isinstance(node, dict):
        return frozendict({k: _freeze(v) for k, v in node.items()})
    if isinstance(node, list):
        return tuple(_freeze(v) for v in node)   # list 转 tuple 才能哈希
    return node

@lru_cache(maxsize=1)
def get_settings() -> frozendict:
    with open("config/app.yaml", encoding="utf-8") as f:
        return _freeze(yaml.safe_load(f))
```

这里必须显式递归，不能指望 `frozendict(raw)` 一把冻到底。我最初就偷了这个懒，结果 `hash(get_settings())` 在嵌套的 `filters` 上报 `TypeError: unhashable type: 'dict'`，缓存键自然也用不了。

还有两个细节值得记住。其一，`frozendict` 保留插入顺序，但比较不看顺序：`frozendict(x=1, y=2)` 和 `frozendict(y=2, x=1)` 相等，哈希也相同。这正好适合配置场景——YAML 里键的顺序经常被人手工调整，语义没变就不该触发缓存失效。其二，`fromkeys` 也有，但别拿可变对象当默认值，`frozendict.fromkeys(["a", "b"], [])` 里三个键共享同一个列表，通过任何一个引用都能改到全部内容，而且带列表的值不可哈希，这张表根本进不了缓存键。

## 二、配置对象替换后，两处代码要跟着改

第一处是类型判断。`isinstance(cfg, dict)` 对 `frozendict` 返回 `False`，因为两者没有继承关系。项目里凡是做 `dict` 判断的地方，要么改成 `isinstance(cfg, (dict, frozendict))`，要么更稳妥地改成 `isinstance(cfg, collections.abc.Mapping)`。我选了后者，顺便把只读配置和请求里传进来的普通字典统一对待。

第二处是缓存键。以前为了把配置塞进 `lru_cache`，得先 `json.dumps(cfg, sort_keys=True)` 拼字符串，既慢又容易因为浮点数格式不一致出问题。现在 `frozendict` 本身可哈希，直接当键：

```python
@lru_cache(maxsize=128)
def render_itinerary(settings: frozendict, days: int) -> list[dict]:
    page = settings["page_size"]
    ...
```

还有一个顺手的收益：3.15 的标准库已经支持 `frozendict`，`json.dumps`、`copy`、`pickle` 都能直接处理它，不需要先 `dict(cfg)` 转一层。配置写进日志、写进 Redis 缓存都少了一次拷贝。

第三处是我没预料到的：依赖注入。原来 `Depends(get_settings)` 返回什么类型都无所谓，现在我在函数签名上写了 `frozendict`，静态检查器会帮我盯住每个处理函数。有一次同事想在某条路由里「临时覆盖」一个配置项，写了 `settings = dict(settings)`，检查器没报错，但代码评审时这行特别显眼——因为它明确表达了「我知道我不该改，所以我先复制一份再改」。这种意图外露，比任何规范文档都管用。

## 三、sentinel 把「没传」变成独立状态

`sentinel(name)` 返回一个唯一对象，默认 `repr` 就是名字本身，和任何东西比较都只等于自己，所以约定用 `is` 判断。它还能直接写进类型标注，比如 `str | UNSET`，静态检查器能认。

PATCH 接口的正确语义是三态：字段没出现、字段出现且为 `null`、字段出现且有值。我用 sentinel 把第一态单独拎出来，仓储层的入参不再用 `None` 兜底：

```python
from datetime import date

UNSET = sentinel("UNSET")          # 放在模块顶层，后面才能 pickle

def build_trip_update(
    *,
    title: str | UNSET = UNSET,
    note: str | None | UNSET = UNSET,
    start_date: date | UNSET = UNSET,
) -> dict[str, object]:
    assigns: dict[str, object] = {}
    if title is not UNSET:
        assigns["title"] = title
    if note is not UNSET:
        assigns["note"] = note      # 显式传 null 时才会走到这里
    if start_date is not UNSET:
        assigns["start_date"] = start_date
    return assigns
```

路由层则依赖 Pydantic 的 `exclude_unset=True`：请求里没出现的字段不会进字典，于是落到 `UNSET` 默认值；显式传 `null` 的字段会带着 `None` 进来。一行 glue 代码就完成了区分：

```python
@app.patch("/trips/{trip_id}")
def patch_trip(trip_id: int, body: TripPatch):
    assigns = build_trip_update(**body.model_dump(exclude_unset=True))
    if not assigns:
        raise HTTPException(400, "没有需要更新的字段")
    repo.update(trip_id, **assigns)
    return {"updated": sorted(assigns)}
```

注意 `**` 解包要求字典的键和参数名一致，所以 `TripPatch` 的字段名、`build_trip_update` 的形参名、数据库列名要在项目里统一，这一点比用 `setattr` 动态拼装要多写几行，但换来的是类型检查和 IDE 跳转。

仓储层拿到 `assigns` 之后拼 SQL 也干净了：有键才进 `SET`，`None` 就老实写 `NULL`，不会出现「没传字段被写进语句」的情况。我把这套逻辑用一个参数化测试钉死，三行断言覆盖三种状态：

```python
def test_patch_tristate():
    assert build_trip_update() == {}
    assert build_trip_update(note=None) == {"note": None}
    assert build_trip_update(note="阳台有猫") == {"note": "阳台有猫"}
```

测试跑在 CI 里，以后谁把默认值改回 `None`，第一个断言立刻红。这比在 PR 里写「注意 PATCH 语义」有效得多。

日志方面也顺带受益。`sentinel("UNSET")` 打印出来就是 `UNSET`，而不是一串内存地址；structlog 把入参序列化时，一眼能看出这个请求到底没传备注，还是显式传了空值。之前用 `object()` 兜底时，日志里全是 `object object at 0x...` 这种没法辨认的东西，事后排查只能靠猜。

## 四、为什么不用 None、object() 或 Ellipsis

这几个都是老办法，我用下来的问题如下：

| 方案 | 能区分「没传」 | repr 可读性 | 可用于类型标注 | 主要问题 |
|---|---|---|---|---|
| `None` | 不能 | `None` | 能 | 本身就是合法业务值，PATCH 里会误清空 |
| `object()` | 能 | `<object object at 0x...>` | 不能 | 日志里认不出是谁，报错信息难读 |
| `Ellipsis` | 能 | `Ellipsis` | 部分场景 | 和 numpy、切片、可变参数语义混在一起 |
| `sentinel("UNSET")` | 能 | `UNSET` | 能（`str \| UNSET`） | 需 Python 3.15+ |

`frozendict` 与常见只读方案的差别也列一下，选型时直接看这张表：

| 特性 | `dict` | `MappingProxyType` | `frozendict` |
|---|---|---|---|
| 能否修改 | 能 | 不能 | 不能 |
| 是否可哈希 | 否 | 否 | 键值都可哈希时 |
| `isinstance(x, dict)` | 真 | 假 | 假 |
| 与原字典关系 | 自身 | 活视图，原字典变它也变 | 独立副本 |
| 嵌套自动冻结 | — | 否 | 否 |

`MappingProxyType` 是视图不是快照，原字典被改它跟着变，放在配置场景反而危险；`frozendict` 至少能保证「传出去的这一份不会被别人改」。

顺便说一句 `@dataclass(frozen=True)`。它冻结的是属性赋值，字段本身如果是 `dict`，内容照样能改，`hash` 也不算；而且每个配置类都要定义一堆字段，加一个配置项就得改类、改测试、改文档。`frozendict` 是通用容器，配置项增减不需要动类型定义，代价是失去了字段名的静态补全。我的取舍是：配置这种「结构随需求长、字段几十个」的场景用 `frozendict`，真正稳定的领域对象才用冻结 dataclass。

## 五、迁移时真正会绊人的三个点

第一，嵌套结构要一次性冻完。只冻顶层等于没冻，`hash` 和序列化会在深层报错，而且报错位置和真正写代码的地方离得很远。

第二，`sentinel` 的 pickle 有前提：必须放在模块全局作用域，变量名和 sentinel 的 `name` 一致，或者放在类作用域里且名字是限定名。函数里临时定义的 sentinel 拿到 Celery 或 multiprocessing 里会直接序列化失败，这个坑在本地单进程调试时完全看不出来。

第三，别把 sentinel 直接塞进 JSON 响应。它不是 JSON 类型，`json.dumps` 会抛 `TypeError`。我的做法是在输出层显式判断，遇到 `UNSET` 就跳过字段，和 PATCH 的语义保持一致。

如果团队还没统一升到 3.15，不建议为了这两个类型强行改运行环境。可以先在 `pyproject.toml` 里写 `requires-python = ">=3.11"`，用第三方 `frozendict` 包和自定义哨兵类过渡；等 CI 镜像都换了 3.15，再删掉兼容层。类型带来的约束是长期的，迁移节奏是短期的，别本末倒置。

## 小结

`frozendict` 解决的是「谁都能改我的配置」，`sentinel` 解决的是「缺失和空值长得一样」。两者都不是语法糖，而是把原来靠约定和注释维持的约束交给了类型系统：改配置会当场抛 `TypeError`，没传字段不会再被误当成清空。我这次改动总共不到一百行，但把两类最难复现的线上问题变成了本地第一次运行就会暴露的错误，这笔账很划算。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

