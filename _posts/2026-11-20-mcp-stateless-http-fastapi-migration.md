---
layout: post
title: "MCP 2026-07-28 无状态规范：用 FastAPI 重写本地工具服务"
date: 2026-11-20 06:05:00 +0800
categories: 软件实战
tags: MCP FastAPI 无状态 JSON-RPC AI工具链
description: "我给博客自动化写了个本地 MCP 工具服务，因两个窗口共享不了审核状态被迫迁移。MCP 2026-07-28 版取消了 initialize 握手和协议级会话，这篇记录我用 FastAPI 重写成无状态 HTTP 端点、用签名句柄外置状态，"
---

我给自己的博客自动化写了一条流水线：每天清晨把文章发到 CSDN 和 Jekyll 站点，再往 history.json 追加一条记录。跑稳之后，我想把"发之前检查一遍"也自动化——标题是否在 20–45 字、tags 是否 4–6 个、正文够不够 2000 字、文末那行引用块有没有漏。于是我写了一个很小的 MCP 服务，两个工具：`validate_article` 读源文件做检查，`search_notes` 在我自己的笔记目录里按关键词检索。最早挂在 stdio 上，编辑器里配一行命令就能用，确实省事。

问题是在我用顺手之后才冒出来的。我习惯同时开两个编辑器窗口，一个改文章，一个查笔记。第一个窗口调 `validate_article` 拿到 `reviewId`，第二个窗口调 `apply_fix` 时得能找回那次审核的结果——可 stdio 是每个客户端各拉起一个进程，我把"最近一次审核"存在进程内的字典里，另一个窗口永远看不见。再往后我想让手机浏览器也能连上，stdio 这条路彻底走不通了。

我去翻 MCP 的规范变更记录，看到 2026-07-28 这一版把协议从"有状态连接"改成了"无状态核心"：`initialize` 握手删了，协议级会话删了，每个请求自己带全上下文。和我的痛点正好对上。这篇按我周末改代码的顺序写：旧写法卡在哪、新规范删了什么、一个无状态端点长什么样、状态被我挪到了哪、迁移时又踩了哪些坑。

## 旧写法卡在哪

把三个问题摆出来就清楚了。

第一是进程内状态。stdio 的模型是"一个客户端一个进程"，看起来隔离得很干净，代价是所有缓存都跟着进程走。我在字典里存 reviewId 到审核结果的映射，第二个窗口读不到，进程一重启全丢。

第二是粘滞会话。旧规范里 Streamable HTTP 靠 `Mcp-Session-Id` 头串起多次请求，服务端要按这个 id 记住上下文。我原本想用 nginx 挂两个副本分摊请求，结果是必须按会话做粘滞路由，不然同一个客户端的请求落到另一副本就"不认识"了。为一个只有两个工具的本地服务维护粘滞路由，纯属自找麻烦。

第三是列表接口随连接变化。`tools/list` 的结果理论上可以和具体连接相关，客户端就没法放心缓存；对靠提示缓存省成本的模型来说，工具清单每天变顺序，缓存命中率会很难看。

还有一个不算"卡住"但很烦的细节：stdio 模式下 stdout 就是协议通道。我早期图省事，在工具里直接 print 调试信息，客户端那边解析 JSON 立刻报错，排查了半天才意识到调试输出得走 stderr。这类"传输层和数据层共用一根管子"的设计，用久了总会咬人一次。

## 新规范删了什么

2026-07-28 版的核心思路一句话：把隐式状态全部改成显式数据。我把对自己有影响的条目整理成一张表：

| 环节 | 2025-11-25 | 2026-07-28 |
|---|---|---|
| 连接建立 | `initialize` / `notifications/initialized` 握手 | 取消握手，每个请求在 `_meta` 里带 `protocolVersion` 与 `clientCapabilities` |
| 会话 | `Mcp-Session-Id` 头加粘滞路由 | 取消协议级会话，跨调用状态改为服务端签发的显式句柄 |
| 能力发现 | 由 `initialize` 返回 | 必须实现 `server/discover` |
| 列表接口 | 可随连接变化 | `tools/list` 等不再随连接变化，返回 `ttlMs` 与 `cacheScope` |
| 变更通知 | HTTP GET 流加 `resources/subscribe` | `subscriptions/listen` 单条长响应流 |
| 心跳与日志 | `ping`、`logging/setLevel` | 删除；日志级别随请求 `_meta` 传入 |
| 断流恢复 | `Last-Event-ID` 续传 | 不续传，客户端用新 id 重发 |
| 结果形状 | 无统一字段 | 必须是 `resultType: complete` 或 `input_required` |

对我影响最大的是最后一行和"断流不续传"这一条。前者意味着返回结构有了统一入口，客户端不用再靠猜；后者意味着请求可能被重发，工具就得幂等。这个约束比握手本身重要得多。

## 一个无状态端点长什么样

既然没有会话，服务端就是一个普通的 JSON-RPC 分发器。我用 FastAPI 写了个最小的：

```python
import json
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

SPEC = "2026-07-28"
app = FastAPI()

# 顺序固定，客户端缓存和提示缓存都受益
TOOLS = sorted([
    {"name": "validate_article", "description": "检查 front matter、字数与引用块",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}},
                     "required": ["path"]}},
    {"name": "search_notes", "description": "在笔记目录按关键词检索",
     "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}},
                     "required": ["q"]}},
], key=lambda t: t["name"])

def reply(mid, result):
    return JSONResponse({"jsonrpc": "2.0", "id": mid,
        "result": {"resultType": "complete", **result,
                   "_meta": {"io.modelcontextprotocol/serverInfo":
                             {"name": "blog-tools", "version": "1.0"}}}})

@app.post("/mcp")
async def mcp(req: Request):
    msg = await req.json()
    mid, method = msg.get("id"), msg["method"]
    meta = msg.get("params", {}).get("_meta", {})

    # 版本在每个请求里自己带，不再靠握手协商
    if meta.get("io.modelcontextprotocol/protocolVersion") != SPEC:
        return JSONResponse({"jsonrpc": "2.0", "id": mid, "error": {
            "code": -32022, "message": "UnsupportedProtocolVersion"}})

    if method == "server/discover":
        return reply(mid, {"protocolVersions": [SPEC],
                           "capabilities": {"tools": {}}})
    if method == "tools/list":
        return reply(mid, {"tools": TOOLS, "ttlMs": 60000,
                           "cacheScope": "public"})
    if method == "tools/call":
        args = msg["params"].get("arguments", {})
        return reply(mid, call_tool(msg["params"]["name"], args))
    return JSONResponse({"jsonrpc": "2.0", "id": mid, "error": {
        "code": -32601, "message": "Method not found"}})
```

几个点值得解释。`server/discover` 是必须实现的方法，客户端可以先问"你支持哪些版本"，也可以拿它当旧服务器的兼容探测。`tools/list` 里带 `ttlMs` 和 `cacheScope`，是告诉客户端"这份清单一分钟内可以放心缓存、允许共享缓存"。版本不匹配返回 -32022，而不是让连接直接断掉——毕竟已经没有连接可以断了。

规范还要求在 POST 上带 `Mcp-Method`、`Mcp-Name` 这类请求头，目的是让中间的代理和网关不用解析正文就能做路由和审计。我原来在 nginx 里用 lo 日志排错过一次请求，如果当时有这两个头，会省不少事。

`ttlMs` 和 `cacheScope` 里的 `cacheScope` 也不是摆设：写 `public` 意味着共享缓存可以存这份工具清单，因为我的工具集合对所有客户端都一样；如果以后做按用户裁剪工具的版本，就得改成 `private`。这个字段实际上是在逼你回答一个问题——这份数据到底能不能共享？以前这个问题没有地方写，只能靠注释。

至于 `subscriptions/listen`，我这套工具目前没有"服务端主动告诉客户端清单变了"的需求，所以没有实现。但我注意到它替换掉的是 HTTP GET 流加 `resources/subscribe` 那一套：现在是单条长响应流，客户端在发起时声明自己关心哪些类型的变化，服务端在流上打 `subscriptionId` 标签。对代理来说，一条 POST 响应流比一条 GET 长连接好管得多。

## 状态放哪：签名句柄

无状态不等于无状态需求。我的 `apply_fix` 确实需要知道"上次审核发现了什么"，解决办法不是把状态藏在服务端，而是把它变成一个可验证的参数。审核完不发 `reviewId`，直接发一个自包含的签名句柄：

```python
import base64, hashlib, hmac, json, os, time

SECRET = os.environ["MCP_HANDLE_SECRET"].encode()

def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def mint_handle(review: dict, ttl: int = 600) -> str:
    body = _b64e(json.dumps({"r": review, "exp": int(time.time()) + ttl},
                            separators=(",", ":")).encode())
    sig = hmac.new(SECRET, body.encode(), hashlib.sha256).digest()[:16]
    return f"{body}.{_b64e(sig)}"

def read_handle(token: str) -> dict:
    body, sig = token.split(".", 1)
    want = hmac.new(SECRET, body.encode(), hashlib.sha256).digest()[:16]
    if not hmac.compare_digest(want, _b64d(sig)):
        raise ValueError("句柄被改过")
    data = json.loads(_b64d(body))
    if data["exp"] < time.time():
        raise ValueError("句柄过期")
    return data["r"]
```

这样任何一个副本收到 `apply_fix` 都能独立验签、独立还原审核结果，不需要 Redis，也不需要粘滞路由。TTL 设 10 分钟，过期就重新审核一次，成本很低。签名用 HMAC 而不是随便拼个校验和，是因为句柄在客户端手里，客户端能改，必须防篡改。等以后真要多实例共享更重的状态，再换 Redis 也不影响协议形状——句柄只是工具参数，换后端对上层透明。

其实这套东西和签名 JWT 是一个思路，只是我没引依赖，几十行就够用。代价要认：句柄里塞不下大对象，塞得越大请求体越重；过期后没有"续期"概念，只能重新生成。对我这种审核结果只有几条提示的场景刚好，换成需要携带几万行上下文的工具，就该老老实实上共享存储，再给句柄留个引用键。

## 迁移顺序与踩坑

我是按这个顺序改的，中间有一处返工：

1. 先加 `server/discover`，让新旧客户端都能探到版本；
2. 把所有内存状态列成清单，我只有两个：审核缓存和一次性 token，全部换成句柄；
3. 把写操作改成幂等：`apply_fix` 比较源文件的内容哈希，已应用过就原样返回上次结果；
4. 固定 `tools/list` 顺序并返回 `ttlMs`；
5. 删掉对 `ping` 的依赖，原来的保活探针改成定时调 `server/discover`；
6. 错误码对齐，资源不存在从 -32002 改成 -32602。

返工在第 3 步。我一开始只把句柄验签做了，忘了"断流不续传、客户端要重发"这件事，结果本地弱网测试时 `apply_fix` 被应用了两次，第二遍把刚写进去的修复标记又改了回去。修法不是加重试锁，而是让操作本身幂等：用内容哈希判断是否已应用，重发一百次结果都一样。这也顺带解决了另一个问题：编辑器的超时重试不会再产生副作用。

还有一处可以提：规范里的多轮请求模式（`input_required`）替代了旧的"服务器反向发请求"。我把它用在了 `apply_fix` 需要确认"覆盖已有改动"的场景——服务器返回 `resultType: "input_required"` 和待确认的 `inputRequests`，客户端带上 `inputResponses` 重试原请求。对工具作者来说，这比反向发起 `elicitation` 更好理解：所有交互都发生在一次请求的生命周期里。

## 小结

改完之后，我的工具服务就是一个 uvicorn 进程，挂在 nginx 后面可以起多个副本，两个编辑器窗口、手机浏览器拿到的审核结果完全一致；状态不再藏在某个进程的字典里，而是作为参数随请求流动。代价也很具体：每个工具都得先想清楚"重发一次会怎样"。

回头看，这版规范删掉的东西比加上的更有价值。无状态不是砍功能，是把隐式的、藏在连接里的状态，换成显式的、能验证的数据。对我这种一个人维护的小工具，它把"要不要做粘滞路由""缓存放哪"这些本来不该操心的事，从问题清单里划掉了。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

