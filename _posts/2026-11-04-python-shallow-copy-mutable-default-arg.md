---
layout: post
title: "Python 列表被改了两次：浅拷贝与可变默认参数的连锁坑"
date: 2026-11-04 06:02:00 +0800
categories: 踩坑修复
tags: Python 浅拷贝 可变默认参数 copy模块 踩坑
description: "批量发布脚本里三篇文章的标签越攒越多，改成浅拷贝后发现嵌套的 project 字段仍然是同一个对象。这篇从一次真实的串数据排查出发，讲清默认参数只求值一次、浅拷贝与深拷贝的边界，以及 None 哨兵和 default_factory 的正确"
---

上周给每日发布管线加了一个"批量预演"模式：不出网，只把三篇文章的元数据在本地拼出来看一眼。跑完第一遍就觉得不对——第三篇的标签栏里居然出现了第一篇的标题，回头翻第一篇，它的标签也变成了九个。三篇文章像是共用了一个标签列表。

我先怀疑是模板渲染时把循环变量带出去了，又在 front matter 解析里加了一段打印，结果发现更直接：三个 meta 字典里的 `tags` 根本就是同一个 list 对象。问题不在渲染，在我自己写的两个地方：一个用了可变对象做默认参数，一个把浅拷贝当成了深拷贝。

## 现象：三篇文章共用一个 tags 列表

把当时那段代码简化出来，大概是这样：

```python
def build_meta(title, tags=[]):
    tags.append("自动化")
    tags.append("CSDN")
    return {"title": title, "tags": tags}

for t in ["第一篇", "第二篇", "第三篇"]:
    meta = build_meta(t)
    print(meta["title"], meta["tags"])
```

跑出来的结果不是每篇两个标签，而是层层叠加：

```
第一篇 ['自动化', 'CSDN']
第二篇 ['自动化', 'CSDN', '自动化', 'CSDN']
第三篇 ['自动化', 'CSDN', '自动化', 'CSDN', '自动化', 'CSDN']
```

看到这个输出，基本可以断定 `tags` 没有被重新创建，而是被反复 `append` 到了同一个列表上。写的时候我脑子里想的是"每次调用给一个空列表当起点"，Python 实际做的却是"函数定义时造一个列表，之后所有调用都拿它当起点"。

这两句话的差别，就是这类 bug 的全部来源。

## 为什么默认参数只求值一次

Python 执行 `def` 语句的时候，会先把参数列表里的默认值表达式求值，得到一个对象，然后把这个对象塞进函数对象的 `__defaults__` 元组里。之后每次调用，只要实参没传，就从这个元组里取出同一个对象绑定给形参。

也就是说，`tags=[]` 里的 `[]` 只执行了一次，位置是"定义函数那一刻"，不是"每次调用"。函数对象长这样：

```python
def build_meta(title, tags=[]):
    tags.append("CSDN")
    return tags

print(build_meta.__defaults__)   # (['CSDN'],)
```

`__defaults__` 里躺着的就是那个列表。它和函数对象同寿命，调用之间不会重置。所以问题不是"Python 没清空"，而是"压根没有新建"。

这条规则本身没有问题，它对不可变默认值是安全的：`None`、`0`、`""`、只含不可变元素的元组，都不存在被原地修改的可能。危险的是 list、dict、set，以及任何自定义的可变对象——包括那种只在内部持有一个列表的小配置类。判断标准可以简化成一句：这个默认值有没有可能被原地改。会，就不能直接写在参数表里。

## 第一次修复：浅拷贝只解决第一层

明白了原理，第一版修复很自然：把默认值换成 `None`，函数内部再建容器。

```python
DEFAULT_TAGS = ["自动化", "CSDN"]

def build_meta(title, tags=None):
    tags = list(DEFAULT_TAGS) if tags is None else tags
    tags.append(title)
    return {"title": title, "tags": tags}
```

这段没问题，顶层列表每次都是新的。但我当时顺手把同样的思路用在了配置字典上，写成 `dict(base)`，以为"复制一下"就独立了：

```python
import copy

base = {"tags": ["CSDN"], "project": {"name": "csdn-auto", "flags": []}}

a = dict(base)     # 浅拷贝
b = dict(base)
a["project"]["flags"].append("draft")

print(b["project"]["flags"])   # ['draft']
```

`a` 和 `b` 是两个不同的字典，往 `a` 里加键不会影响 `b`；但 `a["project"]` 和 `b["project"]` 指向的还是同一个内层字典。浅拷贝只复制第一层的引用，嵌套对象一律原样带过去。所以给 `a` 的 project 打标记，`b` 也看见了。

这里最容易混淆的是"拷贝的动词"有太多写法：`dict(d)`、`d.copy()`、`copy.copy(d)`、`lst[:]`、`lst.copy()`，看起来各不相同，语义全是浅拷贝。真正递归复制的只有 `copy.deepcopy`。

列表套列表时更直观。`matrix[:]` 复制出来的是外层列表，每一行还是原来那一行：

```python
row = [0, 0]
grid = [row, row]
g2 = grid[:]
g2[0][0] = 1
print(grid)        # [[1, 0], [1, 0]]，两行其实是同一个对象
```

对自定义对象，`copy.copy` 默认走 `__reduce_ex__` 那套机制，拷出来的是一个新实例，但实例属性里引用的列表、字典仍然共享。想让语义可控，就在类里显式实现 `__copy__` 和 `__deepcopy__`，把"哪些字段要跟着复制"写死在代码里，而不是寄希望于默认行为刚好符合预期。

| 操作 | 典型写法 | 第一层容器 | 嵌套对象 | 我一般用在哪 |
|---|---|---|---|---|
| 直接赋值 | `b = a` | 共享 | 共享 | 只读传参、不想复制时 |
| 浅拷贝 | `a.copy()`、`dict(a)`、`a[:]` | 新建 | 共享 | 元素都是不可变对象 |
| 深拷贝 | `copy.deepcopy(a)` | 新建 | 新建 | 要独立修改嵌套结构 |
| 逐层手工构造 | `{"tag": list(a["tag"])}` | 新建 | 只复制你写出来的那层 | 结构已知、只想隔离一处 |

选哪一种，不该看哪个更"完整"，而要看"我准备改哪一层"。只改第一层的键，浅拷贝就够；要改嵌套的列表或字典，就得深拷贝，或者明确地把那一层也复制出来。不加判断地全用 `deepcopy`，代价是对象图越大越慢；而且遇到文件句柄、线程锁、数据库连接这类没有合理复制语义的对象，它会直接抛 `TypeError`。

## 确认两个变量是不是同一个对象

排查这类问题，比读代码更快的办法是打 `id`。`id()` 返回对象在内存里的身份，两个变量指向同一个对象，`id` 必然相等：

```python
import copy

base = {"project": {"flags": []}}
shallow = dict(base)
deep = copy.deepcopy(base)

print(id(base["project"]) == id(shallow["project"]))   # True
print(id(base["project"]) == id(deep["project"]))      # False
```

这比打印内容可靠得多：内容相同不代表是同一个对象，内容不同却可能是同一个对象被改过。加一行 id 对比，就能立刻把"渲染出错"和"数据共享"两类问题分开。注意要比较的对象都得在存活状态下比较，CPython 里对象被回收后 id 可能被复用，拿一个已经释放的 id 去比没有意义。

顺带说一句，`__defaults__` 也可以在运行中的进程里查。线上服务如果怀疑某个函数被"污染"了，打印一次 `f.__defaults__` 就能看到默认列表里到底攒了多少东西。

## 更隐蔽的一处：类属性和 dataclass 字段

同样的共享逻辑，在类里还有一个变体。类体里写的可变属性，属于类对象本身：

```python
class Publisher:
    tags = []          # 类属性，所有实例共享

    def __init__(self, name):
        self.name = name

p1, p2 = Publisher("a"), Publisher("b")
p1.tags.append("x")
print(p2.tags)         # ['x']
```

实例上找不到 `tags` 时，会沿类查找，拿到的是类属性指向的那个列表；`append` 原地修改，改的就是类上的列表，于是所有实例都看得见。正确做法是在 `__init__` 里写 `self.tags = []`，让每个实例拥有自己的列表。

用 dataclass 的时候，这条规则会以更明确的方式提醒你：

```python
from dataclasses import dataclass, field

@dataclass
class Article:
    title: str
    tags: list = field(default_factory=list)
```

如果直接写 `tags: list = []`，dataclass 会拒绝生成，抛出 `ValueError: mutable default <class 'list'> for field tags is not allowed`。原因是它生成 `__init__` 时，默认值同样只求值一次，和函数默认参数一模一样。`default_factory=list` 传进去的是一个可调用对象，每次实例化调用一次，返回新的空列表，这才是"每次新建"。

## 我最后改成了什么样

回到发布管线，最终版本把默认值、拷贝层级和入口校验三件事拆开了：

```python
import copy

BASE_META = {
    "tags": ["自动化"],
    "project": {"name": "csdn-auto", "flags": []},
}

def build_meta(title, tags=None, project=None):
    meta = copy.deepcopy(BASE_META)     # 嵌套结构整体隔离
    if tags is not None:
        meta["tags"] = list(tags)       # 传进来的列表也复制一份
    if project is not None:
        meta["project"].update(project)
    meta["tags"].append(title)
    return meta
```

`deepcopy` 只在这里做一次，因为后面的处理流程会改 `tags` 也会改 `project.flags`；传进来的 `tags` 也复制一份，避免调用方之后又往自己的列表里加东西，反过来影响已经生成的 meta。预演模式下再打一组 id 对比，确认三篇互不相同，这个坑才算关掉。

## 把"不是同一个对象"写成断言

手打 id 只能证一次，下次有人再改这块代码，共享又可能悄悄回来。我的做法是把它变成一条测试，用 `is` 断言对象身份，而不是用 `==` 比较内容：

```python
def test_meta_isolated():
    a = build_meta("第一篇")
    b = build_meta("第二篇")

    assert a["tags"] is not b["tags"]
    assert a["project"] is not b["project"]
    assert "第一篇" not in b["tags"]

    defaults = build_meta.__defaults__
    assert defaults is None or not any(
        isinstance(d, (list, dict, set)) for d in defaults
    )
```

为什么用 `is not` 而不是 `!=`：两个变量共享同一个对象时，内容当然相等，`!=` 永远通不过。更麻烦的是，值相等本身也在变——如果函数内部先把列表清空再用，共享对象在断言那一刻看起来完全正常，测试就漏过去了。身份断言不看值，只看"是不是同一个"，正好对应这次故障的本质。

最后一个断言是防守性的：确认函数的默认值里没有被塞进任何容器，含义就是"每次调用新建容器"这条约定，后面改代码的人绕不过去。

最后收成三条规则，之后写工具脚本时我一直照这个来：

1. 函数默认参数只用 `None` 或不可变值，容器一律在函数体里新建，需要多个值时用 `default_factory`。
2. 判断拷贝够不够，先问"我要改哪一层"；浅拷贝只管第一层，嵌套结构要单独处理。
3. 类属性、模块级常量和 dataclass 字段里的可变对象，同样遵守"谁修改谁新建"。只读共享没有错，错的是把一个共享对象当成私有对象去改。

