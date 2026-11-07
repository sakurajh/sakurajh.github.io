---
layout: post
title: "从零写一个 MCP stdio Server：用 Python 校验博客文章格式"
date: 2026-11-08 06:03:00 +0800
categories: 项目
tags: MCP Python JSON-RPC 自动化 AI工具
description: "自动发完博客，我想让 AI 客户端核对标题长度、tags 数和正文汉字数，可模型总是数不准。这篇记录只用标准库的 MCP stdio Server：两个只读工具、JSON-RPC 最小闭环和客户端配置，以及本地工具为何不走远程 HTTP。"
---

早上六点，csdn-auto 的发布脚本跑完，history.json 里多了一行记录。我打开 AI 客户端，让它看看当天那篇文章：标题是不是在 20 到 45 个字符之间，tags 够不够 4 个，正文有没有到 2000 个汉字。它读完文件，回我一句“标题看起来偏长，字数应该差不多”。这种回答没法用——我要的是能直接决定“发还是改”的结论，不是感觉。

问题不在模型笨。字符数、标签个数、代码块是否成对，这些是确定性规则；让语言模型用眼睛去数，本来就是在用它的短板。我把这套检查逻辑写进脚本，再让脚本以工具的形式暴露给客户端，模型只负责决定“查哪一篇”和解释结果，判断标准始终落在代码里。这就是 MCP（Model Context Protocol）要解决的问题：客户端不必为每个本地能力写死集成，服务端按统一协议描述自己有哪些工具。

正好这几天在翻 MCP 的新规范。2026-07-28 那版把远程 Streamable HTTP 往无状态方向推，请求要带 `Mcp-Method` 和 `Mcp-Name` 两个头，方便网关按方法和工具名做路由、限流（来源：blog.modelcontextprotocol.io）。这是给多客户端、可横向扩容的远程服务准备的。我这个场景恰好相反：工具只读本机一个文章目录，客户端就在同一台电脑上，没有第二个用户，也没有跨机器调用的需求。所以我没有跟风写 HTTP 端点，而是用了最朴素的 stdio 传输。

## 一、先定边界：只做两个只读工具

项目想要小，第一件事是砍功能。我最后只留了两个工具：

- `list_articles`：列出文章目录下的 Markdown 文件和标题，方便客户端先知道有哪些文章；
- `check_article`：传入文件名，返回标题长度、tags 数量、正文汉字数，以及代码块、表格、文末引用块是否齐全。

我没有给它加“修改文章”或“发布文章”的权限。原因很实际：MCP 客户端会自己决定什么时候调用工具，参数也由模型生成。只读工具最坏的结果是读错文件，写工具最坏的结果是改坏一篇已经排好版的稿子。检查类需求用只读就能闭环，没必要放大权限。

目录结构也很短，没有框架、没有依赖：

```text
article-mcp/
├─ server.py        # 全部逻辑，约 150 行
└─ articles/        # 被检查的 Markdown 目录（只读）
```

`server.py` 只使用 `json`、`os`、`re`、`sys`、`pathlib` 这些标准库，Windows 上装好 Python 就能跑，不需要 `pip install` 任何东西。对每天定时执行的小工具来说，少一个依赖就少一种半夜挂掉的可能。

## 二、协议最小闭环：一行一个 JSON

MCP 的消息层是 JSON-RPC 2.0。走 stdio 时，客户端把服务端作为子进程拉起，然后往它的标准输入里一行一行写 JSON；服务端把回复写到标准输出，同样一行一个。这里有一条硬规则：**stdout 只能出现协议消息**。调试日志、启动信息一律走 stderr，否则客户端解析到一半遇到一行中文，整个会话就断了。

握手只需要三步。客户端先发 `initialize`，服务端回协议版本、能力和自己的名字；客户端再发一条 `notifications/initialized` 通知，这条没有 `id`，不需要回复；之后就能 `tools/list` 和 `tools/call`。下面是我写的分发骨架：

```python
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(os.environ.get("ARTICLES_DIR", "./articles")).resolve()
PROTOCOL_FALLBACK = "2025-06-18"

def log(*args):
    print(*args, file=sys.stderr, flush=True)

def reply(mid, result):
    return {"jsonrpc": "2.0", "id": mid, "result": result}

TOOLS = [
    {
        "name": "list_articles",
        "description": "列出文章目录下的 Markdown 文件及其标题",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "check_article",
        "description": "检查标题长度、tags 数量、正文汉字数、代码块、表格和文末引用块",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "文章文件名，例如 2026-11-08-xxx.md"}
            },
            "required": ["name"],
        },
    },
]

def handle(msg):
    method = msg.get("method")
    mid = msg.get("id")
    params = msg.get("params") or {}
    if mid is None:          # 通知没有 id，直接忽略
        return None
    if method == "initialize":
        return reply(mid, {
            "protocolVersion": params.get("protocolVersion", PROTOCOL_FALLBACK),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "article-mcp", "version": "0.1.0"},
        })
    if method == "ping":
        return reply(mid, {})
    if method == "tools/list":
        return reply(mid, {"tools": TOOLS})
    if method == "tools/call":
        return reply(mid, call_tool(params.get("name"), params.get("arguments") or {}))
    return {"jsonrpc": "2.0", "id": mid,
            "error": {"code": -32601, "message": f"未知方法 {method}"}}

def main():
    log(f"article-mcp 已启动，只读目录：{ROOT}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            out = handle(json.loads(line))
        except Exception as exc:
            out = {"jsonrpc": "2.0", "id": None,
                   "error": {"code": -32700, "message": str(exc)}}
        if out:
            print(json.dumps(out, ensure_ascii=False), flush=True)
```

协议版本用日期表示。我这里的处理是回显客户端发来的版本，客户端没给才退回一个写死的日期版本。对本机自用来说这样够用；如果要对外提供，应该按规范维护一份支持列表，遇到不认识的版本明确拒绝，而不是含糊地接受。

## 三、把“检查文章”写成工具

检查逻辑分两步：先拆 front matter，再看正文。文章用的是很简单的 `---` 包围的键值对，没有必要为此引入 PyYAML；手写二十行解析，反而更容易控制 `tags` 这种以方括号表示的数组。

有个细节值得单独说：**工具报错和协议报错要分开**。文件名不存在、路径越界，这类是工具执行失败，应该作为正常结果返回，把 `isError` 置为 `true`，让模型看到原因后自己纠正；只有 JSON 解析失败、未知方法这类消息层问题，才用 JSON-RPC 的 `error` 字段。如果工具一失败就让进程退出，客户端下一次调用就找不到服务端了。

```python
CJK = re.compile(r"[\u4e00-\u9fff]")
FOOTER = "> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh"

def parse_front_matter(text):
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    meta = {}
    for line in parts[1].strip().splitlines():
        key, sep, value = line.partition(":")
        if not sep:
            continue
        value = value.strip()
        if value.startswith("[") and value.endswith("]"):
            value = [v.strip().strip("\"'") for v in value[1:-1].split(",") if v.strip()]
        else:
            value = value.strip("\"'")
        meta[key.strip()] = value
    return meta, parts[2]

def safe_path(name):
    path = (ROOT / name).resolve()
    if ROOT not in path.parents:
        raise ValueError("只允许访问 ARTICLES_DIR 下的文件")
    return path

def check_article(name):
    path = safe_path(name)
    meta, body = parse_front_matter(path.read_text(encoding="utf-8"))
    problems = []
    title = meta.get("title", "")
    if not 20 <= len(title) <= 45:
        problems.append(f"标题 {len(title)} 个字符，应在 20–45 之间")
    tags = meta.get("tags") or []
    if isinstance(tags, str):
        tags = [t for t in re.split(r"[,，\s]+", tags) if t]
    if not 4 <= len(tags) <= 6:
        problems.append(f"tags 有 {len(tags)} 个，应为 4–6 个")
    for key in ("summary", "slug", "category"):
        if not meta.get(key):
            problems.append(f"front matter 缺少 {key}")
    cjk = len(CJK.findall(body))
    if cjk < 2000:
        problems.append(f"正文汉字 {cjk} 个，少于 2000")
    if body.count(chr(96) * 3) < 2:
        problems.append("没有成对的代码块")
    if not re.search(r"^\|[\s:|-]+\|\s*$", body, re.M):
        problems.append("没有表格分隔行")
    if FOOTER not in body:
        problems.append("缺少文末引用块")
    report = f"{path.name}：正文 {cjk} 个汉字"
    return report + "\n" + ("\n".join("- " + p for p in problems) if problems else "检查通过")

def call_tool(name, args):
    try:
        if name == "list_articles":
            text = "\n".join(
                f"{p.name}\t{parse_front_matter(p.read_text(encoding='utf-8'))[0].get('title', '(无标题)')}"
                for p in sorted(ROOT.glob("*.md"), reverse=True)
            ) or "目录下没有 Markdown 文件"
        elif name == "check_article":
            text = check_article(args.get("name", ""))
        else:
            raise ValueError(f"未知工具 {name}")
        return {"content": [{"type": "text", "text": text}], "isError": False}
    except Exception as exc:
        return {"content": [{"type": "text", "text": str(exc)}], "isError": True}

if __name__ == "__main__":
    main()
```

`safe_path` 那几行不是形式主义。模型生成的参数不可控，如果直接把名字拼进路径，一个 `../` 就能读到文章目录之外的文件。先 `resolve()` 再判断父目录，是把“能读什么”固定在启动时配置的 `ARTICLES_DIR` 里，而不是寄希望于模型每次都传对。

## 四、接进客户端与一次冒烟测试

客户端配置因软件而异，但核心都是“命令 + 参数 + 环境变量”。以常见的 `mcpServers` 写法为例：

```json
{
  "mcpServers": {
    "article-check": {
      "command": "python",
      "args": ["F:/tools/article-mcp/server.py"],
      "env": {
        "ARTICLES_DIR": "F:/tools/article-mcp/articles"
      }
    }
  }
}
```

这里有个 Windows 上很容易踩的坑：从图形界面启动的客户端，环境变量不一定和你在终端里一样，`python` 可能根本不在 PATH 里。稳妥的写法是把 `command` 换成 Python 的绝对路径。另一个坑是工作目录——服务端用相对路径找 `articles` 时，取决于客户端从哪里拉起进程，所以我把目录放进 `ARTICLES_DIR`，启动时就 `resolve()` 成绝对路径。

不装客户端也能验证。在项目目录里用管道喂三条消息，就能看到完整往返：

```bash
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check_article","arguments":{"name":"2026-11-08-mcp-stdio-article-check-server.md"}}}' \
| python server.py
```

我拿当天的这篇文章跑了一遍，返回的是：

```text
2026-11-08-mcp-stdio-article-check-server.md：正文 2284 个汉字
检查通过
```

顺手又试了两个坏输入：参数传 `../server.py`，返回 `isError: true` 和“只允许访问 ARTICLES_DIR 下的文件”；方法名写成 `nope`，拿到的则是 JSON-RPC 的 `-32601`。这两条走的不是同一条路——工具出错，会话还在，模型能看到原因；协议层出错，则是另一回事。

写这篇时还遇到一个小插曲：检查代码里本来要统计三个反引号的数量，结果这三个反引号把 Markdown 代码块提前截断了，后面的内容全跑到块外。最后改成 `chr(96) * 3` 才正常。一个检查格式的工具，自己先被格式坑了一次，也算合理。静态检查只能看“有没有”，看不出渲染出来是什么样，所以它输出的是问题清单，不是最终裁决，最后一眼还是要人看。

## 五、stdio 还是 Streamable HTTP

写完之后我又回头看了眼规范里的那条变化。把两者放在一起对比，选择就很清楚了：

| 维度 | stdio | Streamable HTTP |
|---|---|---|
| 连接方式 | 客户端拉起子进程，管道通信 | 独立 HTTP 端点 |
| 鉴权 | 沿用操作系统用户权限 | 需要额外做认证与授权 |
| 状态 | 进程内状态天然可用 | 新版规范强调无状态，跨请求状态要外置 |
| 适用场景 | 本机文件、命令、个人工具 | 多客户端共享、远程部署 |
| 调试 | 管道喂 JSON，看 stderr | 网关日志、抓包 |

2026-07-28 版规范要求远程请求带 `Mcp-Method` 和 `Mcp-Name`，本质上是让网关不解析 JSON 体也能知道“这是哪个方法、调的哪个工具”。这对平台方是好事，但它服务的是规模化部署。我的工具只读一个本机目录，没有多租户，也没有横向扩容的问题，硬上 HTTP 只会多出端口、鉴权和 CORS 三件事。

更重要的是一层设计上的分离：工具逻辑（解析 front matter、数汉字、查引用块）和传输方式（stdio 还是 HTTP）没有耦合。哪天真的需要让另一台机器上的客户端调用，我只需要把 `handle()` 外面换一层 HTTP 入口，`check_article` 一行都不用改。先按最小场景把逻辑跑通，再谈传输，这个顺序比一开始就搭一个“通用平台”靠谱得多。

## 六、小结

这个项目最后大约一百五十行，没有依赖，启动方式是让客户端拉起一个 Python 进程。它解决的不是什么大问题：让我在发布前用一句话拿到确定性的检查结果，而不是听模型说“应该差不多”。但它把两件事分清楚了——模型负责理解和调度，代码负责规则和判断。

如果继续加，我会先加一个读取 `history.json` 的只读工具，用来回答“今天发过没有”，仍然不碰写操作。权限边界守住了，工具多一点也不会失控。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

