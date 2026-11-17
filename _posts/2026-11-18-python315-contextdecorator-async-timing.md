---
layout: post
title: "ContextDecorator 在异步函数上提前退出：Python 3.15 的修复"
date: 2026-11-18 06:04:00 +0800
categories: 踩坑修复
tags: Python 3.15 contextlib ContextDecorator FastAPI 异步编程
description: "课堂情绪识别平台的耗时统计里，async 接口全部显示零点几毫秒，和访问日志差了三个数量级。本文用最小脚本复现 ContextDecorator 提前退出的问题，讲清协程对象与协程执行的区别，对比四种修复写法，并说明 Python 3.15"
---

上个月我给课堂情绪识别平台补了一个接口耗时埋点。起因是有老师反馈"上传截图后页面要转好几秒"，我想先量清楚时间到底花在哪。做法很直接：写一个 `@timed` 装饰器，套在几个 FastAPI 接口上，把耗时写进日志和统计表。

第二天打开统计表，我愣住了：同步接口的耗时和访问日志对得上，所有 `async def` 接口却一律显示零点几毫秒。可那几个接口要调模型推理，访问日志里明明是三百到五百毫秒。

更不对劲的是，我顺手查了一下异常路径：接口在协程里抛错时，装饰器里那个 `except` 分支一次都没打印过。计时不准只是表象，错误也没被看到。

先给结论：问题不在 `perf_counter`，也不在异步上下文本身，而在 `contextlib` 的 `ContextDecorator`。在被装饰函数是协程函数时，它在 Python 3.15 之前会提前退出上下文管理器，只覆盖了"创建协程对象"这一步。3.15 修掉了这个问题（gh-125862）。下面按我当时的排查顺序写。

## 先排掉三个最容易误判的方向

耗时对不上时，人的第一反应往往是"计时工具坏了"。我先过了一遍三个可疑点：

1. **`time.perf_counter()` 不准**。同一台机器、同一个函数里，我把装饰器换到同步接口上测，结果和访问日志基本吻合。同一个时钟不可能只对 `async def` 失效，这条排除。
2. **uvicorn 多 worker，统计写混了**。把 worker 数临时设成 1，重启后再测，比例关系没变。而且日志里能对上请求路径，不是串数据。
3. **统计表聚合写错**。我把原始日志打印出来逐条核对，协程接口那条记录的数值本身就是零点几毫秒，问题发生在采集环节，不是展示环节。

三件事排除完，变量只剩下一个：同步函数正常，协程函数异常。边界画在"协程"上，那就该去看装饰器对协程函数到底做了什么。

## 20 行复现：上下文在协程开始前就关了

我把业务代码剥掉，写了一个最小复现。核心就是一个基于 `@contextmanager` 的计时器，直接拿来装饰 `async def`：

```python
import asyncio, sys, time
from contextlib import contextmanager

@contextmanager
def timed(label):
    t0 = time.perf_counter()
    try:
        yield
    except Exception:
        print(f"[{label}] 异常穿过上下文")
        raise
    finally:
        print(f"[{label}] 上下文关闭, 用时 {time.perf_counter()-t0:.6f}s")

@timed("async-handler")
async def handler():
    await asyncio.sleep(0.2)

async def main():
    r = handler()                       # 注意：这里只是拿到协程对象
    print("调用 handler() 后拿到的对象:", type(r).__name__)
    await r                             # 真正开始执行

print("Python", sys.version.split()[0])
asyncio.run(main())
```

本机装的是 Python 3.9.13（3.15 之前这段逻辑没有变），跑出来的结果是这样：

```text
[async-handler] 上下文关闭, 用时 0.000001s
调用 handler() 后拿到的对象: coroutine
```

两行输出的顺序就是答案：上下文在 `await` 之前就关闭了，而且用时约 1 微秒，和那 0.2 秒的 `sleep` 完全无关。

再补一个异常版：把 `handler()` 改成直接 `raise RuntimeError("db timeout")`，输出只有 `enter` 和 `exit`，装饰器里的 `except` 一行都没打印，调用方倒是正常抛出了 `db timeout`。这解释了我统计里"报错接口没有耗时记录"的现象。

## 根因：`with` 包住的是函数调用，不是函数执行

看懂了输出，根因其实一句话：`ContextDecorator.__call__` 生成的包装函数长这样——

```python
def inner(*args, **kwargs):
    with self._recreate_cm():
        return func(*args, **kwargs)
```

对同步函数来说，`func(...)` 执行完才返回，`with` 正好完整包住整个函数体。但对协程函数，`func(...)` 不执行函数体，只创建一个协程对象并立即返回；函数体要等到 `await` 才开始跑。于是执行顺序变成：

1. 进入上下文，`t0` 记下；
2. 创建协程对象，函数体一行都没跑；
3. 立刻退出上下文，打印一个接近 0 的耗时；
4. 调用方 `await` 时才真正执行 `sleep` 和业务逻辑，此时计时器早已关闭。

异常进不去也是同一个原因。协程体是在 `with` 块之外被 `await` 的，异常在上下文关闭之后才抛出，`__exit__` 根本没有机会看到它。所以基于这个装饰器做的错误率统计、慢请求标记，全都只统计了同步接口。

这不是 `contextmanager` 写错了，它本身就是同步上下文管理器。错在我把"创建对象"当成了"完成工作"，而协程和生成器都是延迟执行的。生成器函数同样中招：装饰一个 `yield` 函数时，上下文在第一次 `next()` 之前就退出了，实测同样是 0.000 秒。

## 四种改法对比，我选了最笨的那个

理清原理后，改法有好几种。我把当时考虑过的方案列成一张表：

| 写法 | 3.14 及以前对 async 函数 | 覆盖 `await` 期间 | 能否捕获协程内异常 | 改动成本 |
|---|---|---|---|---|
| `@contextmanager` 直接装饰 | 只覆盖协程对象的创建 | 否 | 否 | 最低，也最容易踩 |
| `AsyncContextDecorator` | 正确，且会 `await` | 是 | 是 | 需配套 `asynccontextmanager` |
| 手写 async 包装函数 | 正确 | 是 | 是 | 每个装饰器多几行 |
| 业务代码里手动 `AsyncExitStack` | 取决于放置位置 | 是（只要在协程内） | 是 | 侵入业务逻辑 |

第二个方案有个前提：`AsyncContextDecorator` 内部走的是 `async with`，所以上下文管理器必须用 `asynccontextmanager` 定义，拿同步的 `@contextmanager` 去套会直接报类型错误。第三个方案最啰嗦，但最可移植——团队里有人还在跑 3.12、3.13，我不想让统计口径依赖解释器版本。

最终我写了一个按函数类型分派的装饰器，思路和 3.15 的修复一致：

```python
import inspect, time
from contextlib import contextmanager
from functools import wraps

_records = []

def _record(label, seconds, status):
    _records.append({"label": label, "seconds": seconds, "status": status})

@contextmanager
def _timer(label):
    t0 = time.perf_counter()
    status = "ok"
    try:
        yield
    except BaseException:
        status = "error"
        raise
    finally:
        _record(label, time.perf_counter() - t0, status)

def timed(label):
    def deco(func):
        if inspect.iscoroutinefunction(func):
            @wraps(func)
            async def inner(*args, **kwargs):
                with _timer(label):
                    return await func(*args, **kwargs)
        elif inspect.isgeneratorfunction(func):
            @wraps(func)
            def inner(*args, **kwargs):
                with _timer(label):
                    yield from func(*args, **kwargs)
        else:
            @wraps(func)
            def inner(*args, **kwargs):
                with _timer(label):
                    return func(*args, **kwargs)
        return inner
    return deco
```

替换后重新压测，异步接口的耗时和访问日志对上了（本地实测 0.2 秒的 sleep 量出来约 0.200 秒），报错接口也有了带 `error` 标记的记录。这里用 `BaseException` 而不是 `Exception`，是因为协程取消抛的 `asyncio.CancelledError` 在 3.8 之后继承自 `BaseException`，用 `Exception` 会漏掉取消场景。

还有一个小细节值得写进团队规范：`functools.wraps` 只复制 `__name__`、`__doc__` 这些元数据，不会改变包装函数本身的协程属性。判断一个包装器能不能被 `await`，看的是包装函数是不是 `async def`，不是原函数。

## Python 3.15 改了什么，升级时注意什么

Python 3.15 的文档里写得很明确：`ContextDecorator` 和 `AsyncContextDecorator`（以及被当作装饰器使用的 `contextmanager()` 和 `asynccontextmanager()`）现在能检测生成器函数、协程函数和异步生成器函数，并在迭代或 `await` 过程中让上下文管理器保持打开；在此之前，上下文管理器会在生成器或协程对象被创建后立即退出。也就是说，上面那段最小复现代码在 3.15 上会得到正确的耗时，不需要改业务写法。

但升级前有两点要想清楚：

- **行为是变了，不是修了个无声的 bug**。如果某段代码之前"依赖"上下文提前退出（比如用它在创建流式响应对象后就释放某个资源），升到 3.15 后资源会一直持有到迭代结束。这类代码本身就可疑，但迁移时要搜一遍。
- **异常路径开始生效**。以前进不了 `__exit__` 的协程内异常，现在会穿过去。你的计时、审计、回滚代码如果只写了 `except Exception`，要补上 `BaseException` 的判断，否则取消和 `KeyboardInterrupt` 会被记成普通错误。

至于我自己的项目，短期内没有全量升级计划，所以保留了显式分派的写法。等依赖链都跟上 3.15，再把包装层删掉，回归标准库。

## 小结

这个坑的隐蔽之处在于：代码不报错、类型检查通过、同步接口一切正常，只有异步接口的数字悄悄错了，还错得很"合理"——零点几毫秒，看起来像是缓存命中。如果我没去核对访问日志，这套统计可能会一直用下去，最后拿它去优化根本不存在的瓶颈。

回头看，判断依据其实很简单：任何"包住一个函数"的装饰器，都要先问一句被包的是普通函数、协程函数还是生成器函数。三者的执行时机不同，上下文的生命周期就不能照抄。Python 3.15 把这个判断做进了标准库，但在升级完成之前，显式分派仍然是最稳的写法。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

