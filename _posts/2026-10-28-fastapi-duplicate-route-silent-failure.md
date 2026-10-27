---
layout: post
title: "FastAPI 同一个路由注册了两次：改了代码却不生效的排查"
date: 2026-10-28 06:01:00 +0800
categories: 踩坑修复
tags: FastAPI Starlette 路由注册 Python 接口调试
description: "重构接口返回结构后，服务端代码明明改了，前端拿到的还是旧字段。重启、清缓存、删 __pycache__ 全试过都没用，最后发现同一个 path 在 app 和 Router 里各注册了一次，Starlette 只认先注册的那个。这篇讲清成因"
---

上个月给情绪记录项目改接口。原来的 `GET /api/emotion/history` 直接返回一个列表，前端自己算总数、自己分页；数据一多，前端每次都要把几百条记录全拿下来。我决定把返回结构改成 `{total, page, items}`，后端分页，前端只负责渲染。

改动不大：把查询函数加个 `offset/limit`，返回值包一层字典。改完保存，`uvicorn --reload` 打了重载日志，我用 curl 打了一次接口，返回的还是那个裸列表。我以为是重载没生效，手动重启；又怀疑是浏览器缓存了 GET，换了 Postman；再怀疑 `__pycache__` 里的旧字节码，把目录删了重跑。折腾了快一个小时，前端那边一直在问“你确定改了吗”。

代码确实改了，但服务器上跑的不是它。问题出在同一个路径被注册了两次，而后注册的那份根本没机会执行。

## 一、先排掉三个“看起来很像”的原因

这类“改了不生效”的问题，最容易把人带偏的是几个常见解释。我按顺序验了一遍，结论都是否定的，但验证方式值得记下来，因为后面每次遇到同类现象都能用。

| 猜测 | 怎么验证 | 结果 |
|---|---|---|
| 热重载没触发 | 新增一个 `GET /api/_ver` 返回时间戳 | 时间戳是新的，重载正常 |
| 浏览器/客户端缓存 | 用 curl 加 `-H "Cache-Control: no-cache"` 直接打 | 返回结构仍旧 |
| `__pycache__` 旧字节码 | 删掉所有 `__pycache__` 后重启 | 无变化 |
| 前端用了本地 mock | 看 DevTools 的 Response 与服务器日志 | 请求确实到了后端 |

四个都排除之后，剩下的可能性只有一种：后端确实收到请求了，也确实执行了某个处理函数，但那个函数不是我以为的那个。这时候再盯着业务代码看已经没意义了，得去看“这个路径到底绑了几个函数”。

## 二、把 app.routes 打出来

FastAPI 的应用对象上有一个 `routes` 列表，所有注册过的路由都在里面，包括你自己写的和框架内置的 `/docs`、`/openapi.json`。把它按“路径 + 方法”分组，重复的自然就浮出来了。

```python
from collections import defaultdict
import main  # 你的 FastAPI 实例所在模块

seen = defaultdict(list)
for route in main.app.routes:
    path = getattr(route, "path", "")
    methods = getattr(route, "methods", None)
    if not methods or not path.startswith("/api"):
        continue
    seen[(path, frozenset(methods))].append(route.endpoint)

for (path, methods), endpoints in seen.items():
    if len(endpoints) > 1:
        print("重复:", path, sorted(methods))
        for ep in endpoints:
            print("   ", ep.__module__ + "." + ep.__name__)
```

输出很直接：`/api/emotion/history` 出现了两次，一个来自 `main.py` 里的 `@app.get`，一个来自 `routers/emotion.py` 里的 `@router.get`，后者被 `app.include_router(emotion_router, prefix="/api")` 挂进来。而我改的是 Router 里那一份，执行的是 `main.py` 里那一份——那是两个月前写的第一版，改结构时忘了它还在。

这里有个细节值得注意：**重复注册不会抛异常，也不会打警告**。FastAPI 只是往列表里追加，两个函数都合法、都能被调用，只是永远只有第一个能匹配上。`app.routes` 和 `app.router.routes` 指向的是同一个列表，`include_router` 也不是把子路由“挂”成树，而是逐个复制进这个扁平列表，所以打印出来的顺序，就是真实的匹配顺序。

顺带说一个副作用：Swagger 会把两个同路径的操作都渲染出来。我当时代码里一处写了 `tags=["情绪"]`，另一处没写，于是同一个路径在文档里出现了两次、分组还不同，看着更像两个不同接口，进一步误导了排查方向。

## 三、十几行的最小复现

为了让团队里其他人相信这不是环境或配置问题，我把它压成了一个单文件示例：

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient

app = FastAPI()

@app.get("/api/demo")
def old_handler():
    return {"version": "old", "items": []}

@app.get("/api/demo")
def new_handler():
    return {"version": "new", "total": 0, "items": []}

client = TestClient(app)
print(client.get("/api/demo").json())   # {'version': 'old', 'items': []}
```

输出是 `old`，把两个函数调换位置就变成 `new`。这段代码同时说明了三件事：注册阶段不报错、后注册者永远得不到执行、代码顺序即优先级。`TestClient` 不需要真正监听端口，所以它很适合放进回归用例里，当作一条“这个错误应该被拦住”的证据。

## 四、为什么是“第一个”生效

要理解这个，得往下看一层。FastAPI 的 `app` 并不是自己处理请求，它把请求交给 Starlette 的 `Router`，而 `Router` 内部的匹配逻辑简化后是这样：

```python
async def app(self, scope, receive, send):
    partial = None
    for route in self.routes:
        match, child_scope = route.matches(scope)
        if match == Match.FULL:
            await route.handle(scope, receive, send)
            return                      # 命中即返回，后面的路由不再看
        if match == Match.PARTIAL and partial is None:
            partial = route
    # 全部走完都没命中，才处理 405 / 重定向
```

顺序遍历、首个命中即返回。这意味着：路径和方法都相同的两个路由，排在后面的那个是**死代码**——它存在于 `app.routes` 里，出现在 `/docs` 里（Swagger 会把同路径的两个操作都列出来，看起来像两个接口），但永远不会被调用。这也解释了为什么我当时在 Swagger 里看到两行 `/api/emotion/history`，却没往重复注册上想，以为是 FastAPI 把操作拆成了两个标签页。

那顺序由什么决定。`@app.get` 在模块导入时就完成注册；`include_router` 则在被调用的那一刻把子路由批量追加进列表。所以顺序取决于**代码执行的先后**，而不是文件里的书写位置。常见的三种重复来源：

1. 老代码留在 `main.py`，新逻辑搬进 Router，两处都没删；
2. `include_router` 被调了两次（比如在 `create_app()` 和模块级各调一次），整组路由翻倍；
3. 多个 Router 用了同一个 `prefix`，各自的路径又重名。

## 五、几种“看着像重复”的相邻坑

排查过程中我还顺手确认了几个容易混淆的变体，它们的表现和重复注册很像，但根因不同，处理方式也不一样。

| 现象 | 根因 | 判断依据 |
|---|---|---|
| 405 Method Not Allowed | 路径命中，但没有任何路由声明该 HTTP 方法 | 响应头里的 `Allow` 列出实际支持的方法 |
| 422 参数校验失败 | `/history/{item_id}` 注册在 `/history/latest` 之前，`latest` 被当成 id 去校验 | 看报错字段名，是路径参数而不是查询参数 |
| 307 重定向后 401 | 请求带了尾斜杠，`redirect_slashes` 默认开启并返回 307，客户端跨域跟随重定向时丢掉 `Authorization` | 响应里出现 307，且目标地址少了斜杠 |
| 请求打到旧逻辑 | 同一路径注册两次，先注册者生效 | `app.routes` 里同路径同方法出现多次 |

第三行那个 307 值得多说一句。Starlette 默认 `redirect_slashes=True`，`/api/emotion/history/` 会被重定向到不带斜杠的地址。307 会保留方法和请求体，看起来没问题，但浏览器的 fetch 在跟随**跨域**重定向时会剥掉 `Authorization` 头，于是 token 没了、接口返回 401，而你在后端只看到一个没带凭证的请求。我的做法是前端请求统一不带尾斜杠，路由也不要两个都定义。

## 六、两道防线

知道根因之后，改起来只要删掉 `main.py` 里那份旧实现。但这类问题会复发，尤其多人协作、代码搬来搬去的时候。我加了两道很轻的防线。

第一道是启动自检，在 `create_app()` 最后调用一次，重复直接抛错，让服务起不来——比让它带病运行强得多。

```python
# app/route_guard.py
from collections import defaultdict
from fastapi import FastAPI

def assert_no_duplicate_routes(app: FastAPI, prefix: str = "/api") -> None:
    seen = defaultdict(list)
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None)
        if not methods or not path.startswith(prefix):
            continue
        seen[(path, frozenset(methods))].append(route.endpoint)

    dup = {k: v for k, v in seen.items() if len(v) > 1}
    if not dup:
        return
    lines = []
    for (path, methods), eps in dup.items():
        owners = [f"{ep.__module__}.{ep.__name__}" for ep in eps]
        lines.append(f"{path} {sorted(methods)} <- {owners}")
    raise RuntimeError("检测到重复路由:\n" + "\n".join(lines))
```

第二道是一个测试用例，把同一份检查跑在 CI 里。它本身没有新逻辑，价值在于“提交前就会被拦下”，而不是等线上发现改代码不生效。

```python
def test_no_duplicate_api_routes():
    from app.route_guard import assert_no_duplicate_routes
    from main import app
    assert_no_duplicate_routes(app)
```

自检要注意两点。一是把范围限定在业务前缀（比如 `/api`），否则框架内置的 `/openapi.json`、`/docs` 之类会干扰判断；二是别在测试环境直接 `raise` 导致整个 suite 挂掉——如果项目里有很多历史重复，先 `print` 出清单，清完再改成抛错。

## 小结

这次踩的坑，本质是“配置型的错误伪装成了代码错误”。我一开始所有的排查动作都指向“新代码没跑起来”，而真实情况是“新代码根本没被选中”。两者的表现都是返回旧结构，但验证路径完全不同：前者查进程、查重载、查缓存，后者只需要把 `app.routes` 打出来看一眼。

现在我的习惯是，凡是“改了没反应”且确认请求确实打到后端，先花十秒枚举路由和方法的组合，再去看业务逻辑。这个动作成本极低，却能排掉一整类静默失效——路由重复、前缀拼错、方法声明错、路径参数抢占，全都能在这一步暴露出来。

