---
layout: post
title: "Tachyon 采样分析器：用 Python 3.15 诊断 FastAPI 慢请求"
date: 2026-11-16 06:05:00 +0800
categories: 软件实战
tags: Python 3.15 Tachyon 性能分析 FastAPI asyncio 火焰图
description: "Python 3.15 标准库新增 profiling.sampling（代号 Tachyon）。我把它用在自己的 FastAPI 情绪识别平台上，讲清 run 与 attach 的取舍、wall 和 cpu 模式怎么对比、Windows "
---

上周三下午四点，我的课堂情绪识别平台又挨了一次投诉：同一份识别结果，上午十点返回只要半秒，下午上课高峰要三四秒。服务本身没崩，日志里全是 200，只有浏览器那边一直转圈。这套东西是 FastAPI 起的：一路 MJPEG 推流、一路人脸框结果回传、再加一个大模型答疑接口，跑在教研室那台 Windows 服务器上。

我先怀疑大模型接口，因为它本来就慢；又怀疑 MJPEG 的 async generator 把连接堆住了。但怀疑不能当结论。以前遇到这种问题我会挂 cProfile，可它要给每次函数调用插桩，在正在服务的进程上根本不敢开。升级到 Python 3.15 之后，标准库里多了 `profiling.sampling`，代号 Tachyon，文档第一句就写着可以 attach 到运行中的 Python 进程、不改代码、不重启。这正好对上我的需求，于是拿它把这次慢请求从头查了一遍。

## Tachyon 和 cProfile 到底差在哪

cProfile 是确定性分析器：它接管函数调用，精确记录每一次调用和返回，所以你拿到的是准确的调用次数。代价是每个函数调用都要过一遍钩子，进程会明显变慢，而且它必须由你来启动进程。顺带一提，3.15 把 cProfile 收编成了 `profiling.tracing`，旧名字还能用，行为和原来是一套东西。

Tachyon 反过来：按固定间隔（默认 1 kHz）从进程外部读一次调用栈，数哪个函数出现得多，再乘以采样间隔估算时间。它不往目标进程里塞代码，目标进程照常全速跑，这也是它敢用在线上服务上的原因。代价是数字都是统计估计：文档里写得很直白，10 秒、10 kHz 大约十万个样本时，5% 的误差在 ±0.5% 左右，样本一少就会晃。

| 工具 | 工作方式 | 能否挂到线上进程 | 时间数据 | 额外依赖 |
|---|---|---|---|---|
| cProfile / profiling.tracing | 插桩，记录每次调用 | 不能，要自己启动 | 精确 | 标准库 |
| Tachyon（profiling.sampling） | 外部周期采样 | 能，按 PID attach | 统计估计 | 标准库（3.15 新增） |
| py-spy | 外部周期采样 | 能 | 统计估计 | 需要单独安装 |

我要回答的不是"这个函数被调了多少次"，而是"这三秒到底花在等大模型，还是花在堵事件循环"，统计采样就够，还不用碰线上进程。

## 先在本地用 run 模式复现

直接对着服务采样容易把启动阶段也算进去，所以我先写了一个只依赖标准库的小脚本，把两类慢请求复刻出来：一种是同步 CPU 活直接写进 async 函数，另一种是 `await asyncio.sleep` 这种纯等待，另外再加一个线程池任务，模拟 anyio 帮我跑同步函数的情况。

```python
# slow_probe.py —— Python 3.15，无第三方依赖
import asyncio, hashlib

def decode_frames(n: int) -> int:
    h = hashlib.sha256()
    for i in range(n):
        h.update(i.to_bytes(8, "little"))
    return len(h.hexdigest())

async def llm_answer(q: str) -> str:
    await asyncio.sleep(0.4)          # 等下游，属于等待
    return q[:10]

async def endpoint_bad(q: str) -> str:
    decode_frames(150_000)             # 同步 CPU 活，堵住整个事件循环
    return await llm_answer(q)

def thread_pool_job() -> None:
    decode_frames(80_000)              # 被 anyio 扔进线程池的那种同步函数

async def main() -> None:
    loop = asyncio.get_running_loop()
    while True:
        await endpoint_bad("怎么让表情识别更稳")
        await loop.run_in_executor(None, thread_pool_job)

asyncio.run(main())
```

采两条样本，分别要墙钟视图和 CPU 视图：

```bash
# 墙钟：所有等待都记在调用者头上，看端到端时间分布
python -m profiling.sampling run --async-aware --async-mode=all -d 15 \
       --flamegraph -o wall.html slow_probe.py

# CPU：只采真正在核上跑的时刻，把 await 和 sleep 滤掉
python -m profiling.sampling run --async-aware -d 15 --mode=cpu \
       --flamegraph -o cpu.html slow_probe.py
```

`--async-aware` 是我踩过之后才加上的。第一次采出来，火焰图上密密麻麻全是事件循环内部的帧，我自己的 `endpoint_bad` 只是窄窄一条。原因是协程的物理调用栈和逻辑调用链不是一回事，await 之后栈早就回不到调用方了。加上这个参数，Tachyon 会按 asyncio 的任务结构重建栈，才看得出"这个协程在等谁"。

还有一个细节：默认只采主线程。我的同步解析函数被 anyio 扔进线程池，主线程上根本看不到它，前几次采样我一度以为那些时间凭空消失了。线上 attach 时我固定加 `-a`（采全部线程），不然会漏掉一半真相。

## 线上用 attach，而不是 run

`run` 是"我启动一个 Python 进程，顺便采样"。这对 uvicorn 不适用：我平时用 `uvicorn app:app --workers 2` 起服务，真正处理请求的是子进程，而 `run` 默认只盯它自己拉起来的那个进程。要么加 `--subprocesses` 让它跟着子进程一起采，要么干脆别用 run，直接 attach 到具体 worker。

线上我是这么做的：

```bash
# 1. 先在任务管理器里找到真正在干活的 python 进程 PID
# 2. 管理员权限开的终端里，挂 30 秒，采全部线程
python -m profiling.sampling attach -a -d 30 --flamegraph -o live.html 48216

# 3. 如果进程完全没响应，别再等采样，先看它此刻停在哪儿
python -m profiling.sampling dump 48216 --all-threads
```

`attach` 一定要带 `-d`。它默认"采到目标进程结束"，对一个常驻服务来说就是永远不结束，我第一次忘了加，只能 Ctrl-C。

Windows 上这一步有三个坑，我全撞了：一是挂别人的进程需要管理员权限，普通终端会直接报读取失败；二是分析器和目标进程必须是同一个次版本，3.15 的分析器挂不上 3.14 的服务；三是非阻塞采样偶尔会读到撕裂的栈，协程切换特别密的时候，火焰图里会出现现实里不存在的调用路径。看到明显不合逻辑的栈，可以加 `--blocking`，代价是目标进程每次采样都被暂停一下，文档也提醒别同时开高频采样，间隔最好不低于 1 毫秒。

`dump` 是这次真正定案的工具。当时有个请求卡了二十多秒，我不想等采样，直接 dump 了一把，输出里每个线程都标了状态：`on CPU`、`has GIL`、`waiting for GIL`、`idle`。卡住的那个线程停在 `socket.recv` 附近、状态是 idle，另外几个线程在 `waiting for GIL`。这一眼就说明：不是我的代码在算，是有人在等网络，同时还有纯 Python 代码长时间占着解释器。

## 四种模式怎么看，怎么验证优化有效

Tachyon 的 `--mode` 决定采哪些样本。我后来固定按这个顺序看：

| 模式 | 采什么 | 我用来回答什么问题 |
|---|---|---|
| wall（默认） | 所有样本，含等待 | 端到端时间到底花在哪个调用上 |
| cpu | 只采在核上执行的时刻 | 哪段是真计算，哪些只是 IO 等待 |
| gil | 只采持有 GIL 的时刻 | 谁在独占解释器，把别的线程饿着 |
| exception | 只采有活跃异常的时刻 | 异常当流程控制时，错误处理吃掉多少时间 |

判读方法很朴素：同一个函数在 wall 里很宽、在 cpu 里几乎消失，那它就是 IO 等待，优化方向是连接池、超时、异步化，而不是抠算法；两个模式里都很宽，才是真正吃 CPU 的热点。我在自己的服务上看到的正是前者：wall 图里大模型调用那一支占了很大一块，cpu 图里它几乎不见；而 `decode_frames` 这类同步函数在 cpu 图里稳定出现，说明它确实在烧 CPU，而且因为写在 async 函数里，等待期间整个事件循环都被它卡住。

改完代码我没有凭感觉宣布"快了"，而是用差分火焰图对照：先把基线采成二进制，改完再采一次，让它和基线做差。

```bash
# 改代码前留基线
python -m profiling.sampling run --binary -o baseline.bin -d 15 slow_probe.py

# 改完再采一次和基线对比，宽窄变化的是相对耗时
python -m profiling.sampling run --diff-flamegraph baseline.bin -o diff.html -d 15 slow_probe.py
```

二进制格式还有个好处：同一份样本可以反复 `replay` 成火焰图、pstats 或 heatmap，不用为了换个看法重新采一遍。

## 小结

这次排查之后，我把 Tachyon 当成了默认的第一把工具，理由不是它新，而是它把"能不能在线上用"这件事解决了：外部采样、不改代码、不重启，attach 完就退出。cProfile（也就是 `profiling.tracing`）仍然有用，当你需要精确调用次数、或者脚本只跑几十毫秒、采样凑不够样本时，它才是正确选择；统计采样天生估不准 1% 级别的差异。

真正要记住的几条：线上 attach 记得 `-d` 和 `-a`；Windows 下要管理员权限，分析器和被采进程必须同为 3.15；协程多时加 `--async-aware`，栈明显不合理再考虑 `--blocking`；优化前后都用差分火焰图说话。至于数字，采样结果是估计，我在汇报里也只说"这段从墙钟图上的主要分支退到了边缘"，不拿它当精确计时的证据。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

