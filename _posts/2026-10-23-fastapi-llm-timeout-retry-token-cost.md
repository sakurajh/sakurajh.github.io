---
layout: post
title: "给 FastAPI 接大模型：超时、重试和 token 成本该怎么管"
date: 2026-10-23 06:01:00 +0800
categories: 软件实战
tags: FastAPI 大模型 超时重试 token计费 Python
description: "课堂答疑接口上线后频繁 504，模型账单却多扣了几笔。这篇拆开一次大模型调用链，讲清超时该分几层设、哪些错误才能重试、上下文和 max_tokens 如何放大成本，并给出一段可直接复用的 httpx 封装。"
---

上个月我在 `python-emotion-system` 的课堂答疑页接了一个大模型接口：学生上传的试卷解析成文本后，可以就某道题追问。演示时一切正常，到了真实课堂，老师反馈"点完答疑按钮一直转圈，最后报 504"。我翻日志才发现，同一个问题其实被后端发了三次，模型那边三次都生成了完整回答，而浏览器只等到一个超时页面。功能看起来只是"慢"，账单却实打实地多花了钱。

这件事让我重新梳理了从浏览器到模型服务商的整条链路。下面是我最后落下来的做法，重点不在某个模型，而在接口层怎么兜住超时、重试和成本这三件事。

## 一、先认清一次调用到底有几段

很多人写大模型接口时只有一行 `client.post(...)`，出问题却说不清卡在哪。实际上一次请求至少经过三段，每段都有自己的时间上限：

1. 浏览器到我的 FastAPI 接口，受前端 `fetch` 超时、网关（Nginx）`proxy_read_timeout`、uvicorn worker 三者的最小值约束；
2. 我的接口到模型服务商，受 HTTP 客户端超时约束；
3. 模型服务商内部排队与生成，我只能通过响应状态码和 `usage` 间接观察。

第一段最容易被忽略：前端等了 60 秒才放弃，但网关 30 秒就断开，浏览器拿到的是 504，后端其实还在等模型。等模型返回时连接已经没人接收，日志里只留下一条"写响应失败"。所以我先把网关的超时调到比后端整体预算略大，前端再比网关大一点，让超时按照"前端 > 网关 > 后端总预算"的顺序逐级触发，这样报错会来自我自己写的业务代码，而不是一层看不懂的网关页。

## 二、超时不是一个数字，是四个

用 `requests` 时很多人不写 `timeout`，默认就是不设上限，模型一慢，worker 就被挂住。换成 `httpx` 之后至少有四个维度可以分别控制：

| 超时类型 | 管的是哪一段 | 设得过分小的后果 | 设得过分大的后果 |
|---|---|---|---|
| `connect` | 建立 TCP/TLS 连接 | 网络稍抖就失败 | 网络不通时白等 |
| `read` | 等下一块响应数据 | 正常生成长回答被腰斩 | 卡死的连接长期占用 worker |
| `write` | 发送请求体 | 长上下文上传中断 | 几乎不会成为瓶颈 |
| `pool` | 等待连接池空位 | 并发稍高就排队失败 | 请求堆积，延迟雪崩 |

我的做法是：`connect` 给一个较短的值，因为连不上就是连不上，多等没有意义；`read` 给一个能覆盖"最长一次正常生成"的值，因为读超时一旦触发，服务商那边很可能已经算完并计费了；`pool` 必须设，否则高并发下请求会在池子里无声排队。

关键在于 `read` 超时的语义：它不代表"模型没开始干活"，只代表"我没再收到数据"。这两者的区别，直接决定了重试能不能做。

## 三、哪些错误能重试，哪些一重试就多花钱

我最初的错误就出在这里：把所有异常都当成"网络抖动"，`while` 循环重试三次。结果是读超时后重发，模型又生成一遍，token 又扣一遍。后来我给自己定了一张表：

| 情况 | 是否自动重试 | 原因 |
|---|---|---|
| 连接失败、连接超时 | 可以 | 请求没到达服务端，不会产生计费 |
| 429 限流 | 可以，且遵守 `Retry-After` | 服务端明确表示没处理，退避后重发合理 |
| 5xx 网关错误 | 有限次重试 | 多数是上游临时故障，但要设上限 |
| 读超时 | 不要自动重试 | 请求可能已执行并计费，重发就是双倍成本 |
| 400 / 401 / 403 / 422 | 不重试 | 参数、鉴权、权限问题，重试只会重复报错 |
| 内容审核拒绝 | 不重试 | 同样的输入结果不会变 |

读超时这一行是整张表的重点。如果业务确实需要"再试一次"，我更倾向于把这个决定交还给用户：前端显示"生成超时，是否重新生成"，而不是后端偷偷重发。用户知道自己在为什么付第二次钱，也知道第一次可能已经生成了内容。

重试本身还要满足三个前提：幂等、退避、上限。退避用指数增长并加一点随机抖动，避免多个请求在同一时刻一起重发，把刚恢复的服务再打垮。

## 四、token 成本被什么放大了

解决了超时，账单问题才浮出水面。我把每轮调用的 `usage` 都记下来之后，发现三个放大器：

**第一，多轮对话整段重发。** 每一轮都把历史消息全部发一遍，第 n 轮要付前面所有轮次的输入 token。十轮对话的总输入量不是十份，而是接近五十五份。这不是模型的问题，是调用方式的问题。我的处理是只保留最近几轮，加上一份滚动摘要，把早期内容压缩成一段话。

**第二，system prompt 和长文档重复上传。** 我把整份试卷的解析文本塞进了每一轮请求。试卷内容不变，却每轮都按输入计费。后来改成首次调用生成结构化摘要，后续只带摘要和当前题目；如果服务商支持前缀缓存，就把稳定部分放在最前面，让缓存真正命中。

**第三，流式响应默认不返回 usage。** 这一点很隐蔽：为了打字机效果开了 `stream: true`，结果响应里没有 `usage` 字段，账单一度完全对不上。OpenAI 兼容接口需要在请求里显式打开统计选项，否则只能靠估算。

还有一个容易误判的点：`max_tokens` 设得大并不会直接多扣钱，它是上限不是定量。但它会拉长生成时间，让请求更容易撞上读超时；而输出 token 的单价通常高于输入，所以把回答长度约束在业务真正需要的范围内，既省钱也更快。

## 五、一个可以直接抄的封装

下面这段是我现在项目里用的调用封装，核心是三件事：只重试"没到达服务端"的错误、把每次 `usage` 落库、在调用前检查当日预算。

```python
import asyncio
import random
import time

import httpx

RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class LLMTimeout(Exception):
    pass


class LLMBudgetExceeded(Exception):
    pass


async def chat(
    client: httpx.AsyncClient,
    messages: list[dict],
    *,
    model: str,
    max_tokens: int = 800,
    budget: "TokenBudget",
) -> str:
    if budget.exceeded():
        raise LLMBudgetExceeded("今日 token 预算已用完")

    delay = 0.8
    for attempt in range(3):
        started = time.perf_counter()
        try:
            resp = await client.post(
                "/chat/completions",
                json={
                    "model": model,
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "stream": False,
                },
            )
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
            # 连接没建立，请求没到达服务端，重试不会重复计费
            if attempt == 2:
                raise LLMTimeout(f"连接模型服务失败: {exc}") from exc
        except httpx.ReadTimeout as exc:
            # 读超时可能已经生成并计费，绝不自动重发
            raise LLMTimeout("模型响应超时，请手动重新生成") from exc
        else:
            if resp.status_code in RETRYABLE_STATUS and attempt < 2:
                retry_after = resp.headers.get("Retry-After")
                wait = float(retry_after) if retry_after else delay
                await asyncio.sleep(wait + random.uniform(0, 0.3))
                delay *= 2
                continue
            resp.raise_for_status()

            data = resp.json()
            usage = data.get("usage") or {}
            budget.record(usage)
            budget.log(
                model=model,
                prompt=usage.get("prompt_tokens", 0),
                completion=usage.get("completion_tokens", 0),
                elapsed=round(time.perf_counter() - started, 3),
            )
            return data["choices"][0]["message"]["content"]

        await asyncio.sleep(delay + random.uniform(0, 0.3))
        delay *= 2

    raise LLMTimeout("重试次数已用尽")
```

配套的客户端是这样构造的，超时四个维度都显式给值，不依赖库的默认行为：

```python
timeout = httpx.Timeout(connect=5.0, read=45.0, write=15.0, pool=5.0)
client = httpx.AsyncClient(
    base_url=settings.llm_base_url,
    timeout=timeout,
    limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
)
```

`TokenBudget` 我做得很简单：一个按日期分组的计数表，`record` 累加输入输出 token，`exceeded` 对比当日上限，`log` 写一条结构化日志。它不精确到分，但能在有人写死循环或者上下文失控时，第一时间把接口拦住，而不是等第二天看账单才发现。

## 六、上线前我会再确认的几件事

第一，超时链路是否逐级放大：前端、网关、后端预算必须满足从大到小的关系，否则用户看到的永远是网关错误页。

第二，日志里能不能回答"这次调用花了多少 token、等了多久、重试了几次"。这三项缺一项，出问题就只能猜。

第三，前端是否把"超时"和"失败"区分开。超时是"可能有结果也可能没有"，失败是"确定没成"，两者给用户的提示不一样，背后的计费风险也不一样。

第四，是否给历史对话设了长度上限。摘要不是可选项，是控制成本的必需品。

## 小结

把大模型接进后端，麻烦的从来不是那一行 POST，而是它周围的工程约束：超时要分段设置，`read` 超时不能随便重试，重试必须幂等且有退避上限，token 成本要从上下文长度和 `usage` 记录两头管。我这次的教训很直白——用户屏幕上的一次超时，在账单上可能是三次生成。把这些问题在接口层一次性收住，后面接什么模型、换什么服务商，改动都会小很多。

