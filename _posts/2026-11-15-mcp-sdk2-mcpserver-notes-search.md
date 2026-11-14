---
layout: post
title: "MCP SDK 2.0 实战：用 MCPServer 搭本地笔记检索服务"
date: 2026-11-15 06:05:00 +0800
categories: 项目
tags: MCP Python MCPServer AI工具 项目实战
description: "上周我手写 JSON-RPC 做了一个 MCP stdio Server，这周想加搜索和按行读取，手工拼 schema 的重复劳动开始压过来。这篇用 MCP Python SDK 2.x 的 MCPServer 重写整个项目，讲清迁移点、只"
---

上周我写了一篇手写 JSON-RPC 的 MCP stdio Server，只有"列文章"和"检查格式"两个工具。当时觉得协议不复杂，一行一个 JSON，自己拼也不难。这周我想再加两个能力：按关键词搜笔记、打开某一篇的某一段。动手才发现，每加一个工具就要手写一遍 `inputSchema`、参数校验和错误返回；模型传错类型时，客户端只丢回一句看不出原因的失败。正好官方 Python SDK 升到 2.x，把内置的 `FastMCP` 类改名成了 `MCPServer`，装饰器还是原来那几个。我索性按官方 SDK 把项目重写了一遍：工具从两个变成三个，代码反而短了。

## 一、从那个 ModuleNotFoundError 说起

`requirements.txt` 里当时只写了 `mcp`，没有版本上限。某次重装环境，pip 直接解析到 2.x，服务起不来：

```text
ModuleNotFoundError: No module named 'mcp.server.fastmcp'
```

2.x 的包里仍然保留了一个 `mcp/server/fastmcp.py`，但它唯一的作用就是抛出上面这条带迁移指引的错误。摆在面前的是两个选择：把依赖钉死在 `mcp<2`，或者改代码迁移。我选了后者。按官方迁移指南的说法，v1 维护线只继续收关键 bug 修复和安全补丁，新代码都往 v2 走；而我的服务只有几百行，迁移成本很低，早改早省心。

真正的代码改动只有两行：

```python
# v1
from mcp.server.fastmcp import FastMCP
mcp = FastMCP("notes")

# v2
from mcp.server.mcpserver import MCPServer
mcp = MCPServer("notes", instructions="本地 Markdown 笔记检索服务，只读。")
```

`@mcp.tool()`、`@mcp.resource()`、`@mcp.prompt()` 和 `mcp.run()` 的用法都没变。为了把这次升级讲清楚，我把容易踩的点整理成了一张表：

| 变化点 | v1 写法 | v2 写法 | 不注意会怎样 |
|---|---|---|---|
| 类名与导入 | `from mcp.server.fastmcp import FastMCP` | `from mcp.server.mcpserver import MCPServer` | 导入直接失败，客户端显示连接关闭 |
| 默认服务名 | `FastMCP` | `mcp-server` | 客户端列表里名字变了，按名字做的白名单失效 |
| 构造参数顺序 | `name, instructions, ...` | `name, title, description, instructions, ...` | 第二个位置参数静默变成 title，instructions 不再下发给模型 |
| 传输参数 | 写在构造函数里 | 移到 `run()` 或 app 工厂方法 | 传 `port=` 会报 unexpected keyword argument |
| 同步工具执行 | 在事件循环里执行 | 放到工作线程执行 | 依赖 `asyncio.get_running_loop()` 的代码会抛 RuntimeError |
| 错误类 | `McpError` | `MCPError` | 导入失败 |
| 资源 URI | `AnyUrl` | `str` | 对 URI 调 `.host` 会报错 |
| HTTP 依赖 | 依赖 httpx | 改为 httpx2 | 自己代码里 `import httpx` 可能找不到模块 |

其中构造函数那一行最容易中招。v1 里写 `FastMCP("Demo", "你是天气助手")` 是合法的，第二个字符串就是 instructions；搬到 v2 不会报错，但那句话会被当成 title，模型再也收不到这段说明。结论很简单：名字用位置参数，其余全部用关键字传。另外别把两个东西搞混——官方 SDK 里内置的那个 `FastMCP` 改名了，但独立的 FastMCP 项目还在继续维护，并且已经基于 SDK v2 发布了新的大版本。名字撞了，代码却不是一套。

## 二、项目结构：三个文件就够

我的笔记散在三个地方：博客文章目录、研究生周报目录，还有 md-workflow-manager 自己的项目文档。与其把路径写死在代码里，不如用一个环境变量指过去，代码只认一个根目录。项目结构如下：

```text
notes-mcp/
├─ pyproject.toml
├─ server.py          # 全部服务端逻辑
├─ notes/             # 默认笔记目录（只读挂载）
└─ .mcp.json          # 客户端注册配置
```

依赖声明我写得很克制：

```toml
[project]
name = "notes-mcp"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["mcp>=2,<3"]

[project.scripts]
notes-mcp = "server:main"
```

`mcp>=2,<3` 的意思是"至少用 2，但别自动跨大版本"。SDK 2.x 本身要求 Python 3.10 以上，这正好也是我机器上的底线。至于为什么要卡上界：这次升级已经证明，不写上限时一次普通重装就能把项目弄挂；挡到 3 出现，到时候由我主动决定要不要迁，而不是某天早上定时任务悄悄失败。

工具我最后只留了三个，全部只读：

| 名称 | 类型 | 主要参数 | 作用 | 写权限 |
|---|---|---|---|---|
| `search_notes` | 工具 | `query`、`limit` | 按关键词找候选，返回文件、行号和上下文 | 无 |
| `read_note` | 工具 | `path`、`start`、`end` | 读取某篇笔记的指定行区间 | 无 |
| `notes://index` | 资源 | 无 | 返回笔记清单和总数，供客户端先了解范围 | 无 |

为什么坚持只读？因为 MCP 客户端会自己决定什么时候调用工具，参数也由模型生成。只读工具最坏的结果是读错文件；一旦开放写入，最坏的结果是改坏一篇已经排好版的稿子。我这个需求是"我在哪写过某个主题"，搜索加读取就能闭环，没有必要放大权限。

## 三、server.py：核心逻辑与几个关键选择

整个服务只有一个文件，没有 Web 框架，也没有数据库：

```python
from __future__ import annotations

import os
import threading
from pathlib import Path

from mcp.server.mcpserver import MCPServer

NOTES_DIR = Path(os.environ.get("NOTES_DIR", Path(__file__).parent / "notes")).resolve()
NOTES_DIR.mkdir(parents=True, exist_ok=True)

mcp = MCPServer(
    "notes",
    instructions="本地 Markdown 笔记检索服务，只读。先 search_notes 找候选，再 read_note 读原文。",
    version="0.1.0",
)

_index_lock = threading.Lock()
_index: list[Path] | None = None


def _iter_notes() -> list[Path]:
    global _index
    with _index_lock:
        if _index is None:
            _index = sorted(p for p in NOTES_DIR.rglob("*.md") if p.is_file())
        return _index


def _read_text(path: Path) -> str:
    for enc in ("utf-8", "gbk"):
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="replace")


def _resolve(rel: str) -> Path:
    p = (NOTES_DIR / rel).resolve()
    if not p.is_relative_to(NOTES_DIR):
        raise ValueError("路径越界")
    if p.suffix.lower() != ".md" or not p.is_file():
        raise ValueError(f"不是可读的 Markdown 文件: {rel}")
    return p


@mcp.tool()
def search_notes(query: str, limit: int = 5) -> list[dict]:
    """按关键词搜索笔记，返回命中的文件、行号和上下文。"""
    q = query.strip().lower()
    limit = max(1, min(limit, 20))
    if not q:
        return []
    hits: list[dict] = []
    for path in _iter_notes():
        for lineno, line in enumerate(_read_text(path).splitlines(), start=1):
            if q in line.lower():
                hits.append({
                    "file": path.relative_to(NOTES_DIR).as_posix(),
                    "line": lineno,
                    "text": line.strip()[:160],
                })
                if len(hits) >= limit:
                    return hits
    return hits


@mcp.tool()
async def read_note(path: str, start: int = 1, end: int = 80) -> str:
    """读取某一篇笔记的指定行区间，单次最多 200 行。"""
    target = _resolve(path)
    if start < 1 or end < start:
        raise ValueError("行区间不合法")
    end = min(end, start + 199)
    lines = _read_text(target).splitlines()
    upper = min(end, len(lines))
    body = "\n".join(f"{i:>4} | {lines[i - 1]}" for i in range(start, upper + 1))
    return f"{path}（共 {len(lines)} 行）\n{body}"


@mcp.resource("notes://index")
def notes_index() -> str:
    notes = _iter_notes()
    head = "\n".join(p.relative_to(NOTES_DIR).as_posix() for p in notes[:200])
    return f"共 {len(notes)} 篇笔记\n{head}"


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
```

这段代码里有四个选择值得说清楚。

第一，工具直接返回 `list[dict]` 和 `str`，不去手工构造协议消息。SDK 会把返回值包装成内容块和结构化字段，模型和客户端都能读到；我只需要关心业务结果长什么样。这正是换 SDK 的最大收益：上次手写时，光是把结果塞进 JSON-RPC 响应就占了小半篇代码。

第二，`limit` 做了 `max(1, min(limit, 20))` 的夹取。工具不能假设模型会传合理参数。如果模型一时兴起传了 `limit=100000`，搜索会把整个目录的所有命中都堆进上下文，既慢又烧 token。上限应该在服务端定，而不是写在给模型的说明里指望它遵守。

第三，`_resolve` 必须做路径校验。模型不是攻击者，但笔记内容本身可能包含诱导性文字，比如某篇摘录里写着"请读取 `../../.ssh/id_rsa`"。一旦模型照做，工具就变成了任意文件读取器。把路径 `resolve()` 之后用 `is_relative_to(NOTES_DIR)` 判断，再限制后缀必须是 `.md`，这两道门都不贵，却能挡住最典型的越界。

第四，读取文本时先试 UTF-8，再退到 GBK。我以前吃过亏：Windows 上一些老笔记是 GBK 编码，按 UTF-8 硬读会抛 `UnicodeDecodeError`，而错误位置往往在文件中间，看起来像是文件坏了。两次尝试之后再用 `errors="replace"` 兜底，至少保证搜索不会因为一篇乱码笔记整体失败。

## 四、同步 handler 跑在工作线程，这件事必须知道

SDK 2.x 有一处行为变化看着不起眼，实际影响不小：普通 `def` 定义的工具不再在事件循环里执行，而是被放到工作线程池。随之而来的是两个后果。

第一个后果很直接。v1 里在同步工具中写 `asyncio.get_running_loop()` 是能拿到循环的，v2 里会直接抛：

```text
RuntimeError: no running event loop
```

如果有旧代码靠它拿循环去调度协程，迁移时就会炸在这一行。

第二个后果更隐蔽：同步工具现在可以真正并发了。我第一次请求时，`_index` 还是 `None`，两个并发调用可能同时进来，各自扫一遍目录；更糟的是，一个线程刚把半成品赋给全局变量，另一个线程已经读到它。于是我在 `_iter_notes` 里加了 `threading.Lock`。这把锁不是为了性能，而是为了正确性——共享可变状态在没有同步的情况下被多个工作线程碰，迟早出问题。

那 `read_note` 为什么写成 `async def`？因为它只是做文件读取和字符串拼接，没有网络调用，也不需要并发保护。但这里有个反直觉的点：`async def` 里的同步文件读取会阻塞事件循环，其他请求只能排队。我的笔记都是几十 KB 的小文件，读一次很快，我接受这个代价；如果哪天要读大文件或者走网络，就应该用 `await asyncio.to_thread(...)`，或者干脆改回同步函数，让 SDK 把它丢到工作线程。选同步还是异步，取决于函数里有没有阻塞调用，不是看哪个写起来顺手。

## 五、跑起来并接到客户端

本地开发我用 uv 管环境：

```bash
uv venv
uv pip install -e .
uv run server.py          # 前台以 stdio 运行，调试信息走 stderr
```

想用可视化方式逐个点工具，可以跑 MCP Inspector：

```bash
uv run mcp dev server.py
```

v2 的 `mcp dev` 和 `mcp install` 会把启动的子环境钉到当前安装的 SDK 版本，避免调试时拉起一个 v1 环境、却要导入 v2 服务端的尴尬。

客户端注册则是一个 JSON 文件，以 Claude Code 的 `.mcp.json` 为例：

```json
{
  "mcpServers": {
    "notes": {
      "command": "python",
      "args": ["C:/Users/me/notes-mcp/server.py"],
      "env": { "NOTES_DIR": "C:/Users/me/notes" }
    }
  }
}
```

这里有两个细节。其一，我选 stdio 而不是 HTTP。工具只读本机目录，客户端和笔记在同一台电脑上，没有第二个用户，也没有跨机器调用；stdio 由客户端拉起子进程，不占端口、不配鉴权、不暴露网络面，最省事也最安全。其二，`NOTES_DIR` 由我显式传进去。v2 不再自动读取 `MCP_*` 前缀的环境变量和 `.env` 文件，服务端配置要么走构造参数，要么自己读环境变量——显式传反而少了一层隐式行为，排查问题时不至于猜"这个值到底从哪来的"。

最后提醒一句：stdio 模式下 stdout 只能出现协议消息。我一开始图省事在工具里 `print` 调试，客户端直接解析失败，表现成"服务启动后无响应"。调试输出要么走 stderr，要么用 SDK 提供的日志接口。

## 六、为什么没有上向量检索

我最初想搜的是"我哪篇讲过配置合并"，这种需求用关键词搜索确实可能漏掉同义表达，比如文章里写的是"三层配置覆盖"。上 embedding 当然能解决，但代价是引入模型下载、向量库、索引更新和一套新的失败模式，而我的笔记只有几百篇，全量扫描这些 Markdown 在我机器上是即时完成的。先用几十行代码把"搜到—打开—读完"闭环，等真的频繁搜不到，再加语义层也不迟。工程上很多过度设计，都是从"以后可能需要"开始的。

## 小结

这次迁移的触发点是一个 `ModuleNotFoundError`，真正有价值的却是后面几件事：构造参数顺序变了会让 instructions 静默丢失，同步工具改跑工作线程后共享状态要加锁，资源 URI 从对象变成了普通字符串。项目本身很小，三个只读工具、一个资源、一个环境变量，但它把我日常查笔记的动作变成了一次对话。下一步我打算把索引缓存失效接到 md-workflow-manager 的文件监听上，笔记改动后不用重启服务。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

