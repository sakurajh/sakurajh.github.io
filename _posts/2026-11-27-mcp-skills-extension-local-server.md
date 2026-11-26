---
layout: post
title: "Skills over MCP 实践：给本地 MCP 服务器挂一个 SKILL.md"
date: 2026-11-27 06:04:00 +0800
categories: 软件实战
tags: MCP Skills over MCP Python AI Agent 工具链 协议规范
description: "工具只能告诉模型能调用什么，流程和经验却无处安放。本文按 SEP-2640 规范，用 Python 标准库给本地 MCP 服务器实现 skills/list、skills/get 与 resources/read，把 MD 运行检查流程做成"
---

## 每天六点的那条流水线，卡在“顺序”上

我这套每日发布脚本已经跑了几个月：早上六点，脚本读运行手册、按星期选档位、写文章、发 CSDN、推博客站，最后把结果写进 `last-run.json`。另一条线是 md-workflow-manager，我把一次完整的 MD 运行拆成拓扑检查、能量最小化、NVT、NPT、生产五段。两套东西都挂在本地 MCP 服务器上，模型能列出所有工具，参数也基本写得对。

问题出在顺序和经验。它知道有 `run_gmx` 这个工具，却不知道要先看 `em.mdp` 的能量收敛，再决定 NVT 跑多久；也不知道我的笔记本散热有限，长跑要优先单线程加 GPU，而不是把 8 核全开。这些内容以前每次都得我在对话里重新说一遍。

我试过往每个工具的 `description` 里塞操作步骤，结果说明越写越长，模型反而更容易漏掉中间环节。原因不难理解：`description` 是跟着单个工具走的，而“先做什么、再做什么、哪些参数不能碰”是跨工具的流程。把一个跨工具的流程切碎塞进各个工具，等于把一条线剪成几段，再指望模型自己拼回去。

11 月 24 日，Anthropic 把 Skills over MCP 放进 Claude 与 Claude Code 的公开测试，VentureBeat 和 CryptoBriefing 都做了报道。规范本身（SEP-2640，状态 Final）写在 modelcontextprotocol.io 的扩展页里，核心语义很克制：一个 skill 就是“一个目录 + `SKILL.md` + 若干支持文件”，客户端先用 `skills/list` 拿元数据和完整的文件清单，再用 `resources/read` 按需读取正文。看完规范我意识到，这正是我缺的那一层——工具负责“能做什么”，skill 负责“按什么顺序做、别踩哪些坑”。

## 一、四种原语，各回答一个问题

MCP 原本的工具、资源、提示词三种原语，加上新的 skill，分工其实很清晰。我把它们放在一张表里对照，写代码时就不容易放错位置：

| 原语 | 回答的问题 | 进入上下文的方式 | 我的实际用法 |
|---|---|---|---|
| tools | 能调用哪些函数、参数是什么 | 调用时返回结果 | `run_gmx`、`md_check` 这类动作 |
| resources | 有哪些可读的内容 | 客户端按需读取 | 运行日志、参数文件原文 |
| prompts | 用户能手动选哪些模板 | 用户显式选用 | 几乎没用，太依赖人工 |
| skills | 多个工具按什么顺序用、有哪些禁令 | 模型或用户选中后整包加载 | MD 检查流程、发布前检查清单 |

关键差别在“时机”。工具列表在连接时就全部进上下文，所以描述必须短；skill 列表只带 `name` 和 `description`，正文和参考文件要等真正选中才读取。规范甚至明确规定：host 不得在连接、列表或批准阶段提前拉取文件内容。这条约束的含义是，一个服务器挂几十个 skill，也不会把模型的上下文撑爆，因为大多数时候只加载其中一个。

## 二、规范里几条容易忽略的硬约束

第一次读扩展页时，我以为只要放一个 `SKILL.md` 就算完事，实际动手才发现约束不少，而且每一条都有理由：

- `SKILL.md` 必须以 YAML frontmatter 开头，至少包含 `name` 和 `description`，并且它所在目录的最后一段必须等于 `name`。这条是为了让 URI 和身份对得上，避免两个服务器用同名 skill 互相覆盖。
- 清单必须覆盖 `SKILL.md` 和全部支持文件，每一项带 `uri`、`sha256:` 摘要和字节大小；一个条目的清单不能跨页拆分。host 用它做完整性校验，而不是信任服务器说了算。
- 批准绑定的是整份清单。文件被改、被加、被删，之前的批准就失效，必须重新征求用户同意。
- 单个 skill 建议不超过 512 个文件、16 MiB。超过这个量级，人也没法维护。
- 未知的 skill 或文件返回 `-32602`；摘要、大小、frontmatter 对不上属于 host 侧的校验失败，处理方式是拒绝内容并刷新条目，而不是当成协议错误。

协议消息我整理成第二张表，方便对着规范写实现：

| 方法 | 作用 | 关键约束 |
|---|---|---|
| `skills/list` | 列出技能条目，含 frontmatter 和完整清单 | 条目原子，支持 `cursor` 分页 |
| `skills/get` | 按 URI 取单个条目或刷新 | 必须支持未出现在列表里的 URI |
| `resources/read` | 读取 `SKILL.md` 或支持文件 | 只允许读清单内 URI，读后校验大小与摘要 |
| `resources/directory/read` | 列目录直接子项 | 可选，声明 `directoryRead: true` 才能调 |

## 三、用标准库写一个只做 skill 的服务器

官方页写得很直白：SDK 和 host 的支持还在实现中。所以我没有等客户端库，直接按规范写一个最小服务器。stdin/stdout 传输本身就是逐行 JSON-RPC，用标准库足够，也更方便看清摘要到底怎么算。

```python
# md_skill_server.py —— 最小 MCP stdio 服务器，同时提供工具与一个 skill
import hashlib, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "skills"
REQUIRED = ["topol.top", "em.mdp", "nvt.mdp", "npt.mdp", "md.mdp"]
TOOLS = [{
    "name": "md_check",
    "description": "检查 GROMACS 运行目录里的拓扑与 mdp 文件是否齐备",
    "inputSchema": {"type": "object",
                    "properties": {"dir": {"type": "string"}},
                    "required": ["dir"]},
}]

def frontmatter(path):
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise ValueError(f"{path} 缺少 frontmatter")
    block = text.split("---", 2)[1]
    pairs = (line.split(":", 1) for line in block.strip().splitlines() if ":" in line)
    return {k.strip(): v.strip() for k, v in pairs}

def skill_entry(skill_dir):
    md = skill_dir / "SKILL.md"
    fm = frontmatter(md)
    if fm.get("name") != skill_dir.name:
        raise ValueError("目录名必须等于 frontmatter 的 name")
    files = sorted(p for p in skill_dir.rglob("*") if p.is_file())
    return {
        "uri": f"skill://{skill_dir.name}/SKILL.md",
        "frontmatter": fm,
        "resources": [{
            "uri": f"skill://{skill_dir.name}/{p.relative_to(skill_dir).as_posix()}",
            "digest": "sha256:" + hashlib.sha256(p.read_bytes()).hexdigest(),
            "size": p.stat().st_size,
        } for p in files],
    }

def all_skills():
    return [skill_entry(d) for d in sorted(ROOT.iterdir())
            if d.is_dir() and (d / "SKILL.md").exists()]

def send(rid, result, cache=False):
    if cache:
        result = {"resultType": "complete", "ttlMs": 300000,
                  "cacheScope": "public", **result}
    print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result},
                     ensure_ascii=False), flush=True)

def fail(rid, code, message):
    print(json.dumps({"jsonrpc": "2.0", "id": rid,
                      "error": {"code": code, "message": message}},
                     ensure_ascii=False), flush=True)

for line in sys.stdin:
    if not line.strip():
        continue
    req = json.loads(line)
    method, rid, params = req.get("method", ""), req.get("id"), req.get("params") or {}
    if method.startswith("notifications/"):
        continue
    elif method == "initialize":
        send(rid, {
            "protocolVersion": "2026-07-28",
            "capabilities": {"resources": {},
                             "extensions": {"io.modelcontextprotocol/skills": {}}},
            "serverInfo": {"name": "md-skill-server", "version": "0.1.0"},
        })
    elif method == "skills/list":
        send(rid, {"skills": all_skills()}, cache=True)
    elif method == "skills/get":
        uri = params.get("uri")
        hit = next((e for e in all_skills() if e["uri"] == uri), None)
        if hit is None:
            fail(rid, -32602, f"unknown skill: {uri}")
        else:
            send(rid, {"skill": hit}, cache=True)
    elif method == "resources/read":
        rel = params.get("uri", "").removeprefix("skill://")
        path = (ROOT / rel).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            fail(rid, -32602, f"invalid uri: {params.get('uri')}")
        else:
            send(rid, {"contents": [{"uri": params["uri"],
                                     "mimeType": "text/markdown",
                                     "text": path.read_text(encoding="utf-8")}]},
                 cache=True)
    elif method == "tools/list":
        send(rid, {"tools": TOOLS})
    elif method == "tools/call":
        if params.get("name") != "md_check":
            fail(rid, -32602, f"unknown tool: {params.get('name')}")
            continue
        d = Path(params.get("arguments", {}).get("dir", ""))
        missing = [f for f in REQUIRED if not (d / f).exists()]
        text = ("缺少: " + ", ".join(missing)) if missing else "齐备"
        send(rid, {"content": [{"type": "text", "text": text}]})
    else:
        fail(rid, -32601, f"method not found: {method}")
```

这份实现里有两个刻意的选择。第一，`initialize` 时我声明了 `resources` 能力，并在 `extensions` 里挂上 `io.modelcontextprotocol/skills`，这是规范要求的门槛：客户端只有看到声明，才会发 `skills/list`。第二，`resources/read` 里先 `resolve()` 再用 `is_relative_to(ROOT)` 做前缀检查，否则 `skill://../../.ssh/id_rsa` 这种 URI 会把整个服务变成任意文件读取器。协议再新，路径穿越还是老问题。

## 四、SKILL.md 怎么写才有用

目录结构很简单，一个 skill 一个文件夹：

```text
skills/
└── md-run-check/
    ├── SKILL.md
    └── references/
        └── checklist.md
```

`SKILL.md` 的正文我按“顺序 + 禁令”来写，因为这两样正是模型最容易漏的：

```markdown
---
name: md-run-check
description: 检查一次 GROMACS 运行目录是否齐备，并核对能量最小化与温压耦合参数。
---

# MD 运行目录检查

1. 调用 `md_check` 工具，传入运行目录，把缺失项原文贴给用户。
2. 读 `references/checklist.md`，逐条核对收敛判据与耦合参数。
3. 任何一项不通过就停止，不要继续后续步骤。

## 禁令

- 不要替用户修改参数文件，只报告差异。
- 长跑优先单线程加 GPU，不要按核数开满。
```

`description` 是模型决定“要不要选它”的唯一依据，所以我把触发场景写进去，而不是写“这是一个 MD 检查 skill”这种正确但无用的句子。正文里的禁令也值得单独强调：skill 内容是服务器作者写的，但对 host 来说仍是不可信输入，规范要求 host 在加载前解析 frontmatter、按清单校验每个文件，并且执行类权限必须逐 skill 获得用户批准。

## 五、验证与踩坑

不需要真客户端，几行脚本就能把协议跑通：

```python
import json, subprocess

reqs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "skills/list", "params": {}}]
p = subprocess.run(["python", "md_skill_server.py"],
                   input="".join(json.dumps(r) + "\n" for r in reqs),
                   capture_output=True, text=True, encoding="utf-8")
for line in p.stdout.splitlines():
    msg = json.loads(line)
    if msg.get("id") == 2:
        for s in msg["result"]["skills"]:
            print(s["uri"], "->", s["frontmatter"]["description"])
            print("  清单文件数:", len(s["resources"]))
```

实际调试中踩到的坑，按疼的程度排序：

1. **摘要必须按原始字节算**。我第一版用 `read_text()` 读出来再编码算 SHA-256，Windows 上换行被统一成 `\r\n`，和服务器声明的大小、摘要全对不上。改成 `read_bytes()` 后一次通过。规范强调“按服务器实际提供的字节计算”，就是这个意思。
2. **目录名和 `name` 必须一致**。我一开始目录叫 `md-check`、frontmatter 写 `md_run_check`，客户端能列出来，但按 URI 取时就对不上。规范把“父目录最后一段等于 name”写成 MUST，不是洁癖。
3. **`skills/list` 和 `skills/get` 的职责要分清**。列表条目本身已经是完整的，客户端不需要再调 `skills/get` 补元数据；但 `skills/get` 仍必须支持列表里没有的 URI，因为用户可能直接粘一个地址过来。
4. **别把 `resources/read` 当成授权**。规范明确写了，读 `SKILL.md` 不等于激活 skill，激活要走 host 自己的加载路径。我在服务器里就没有做任何“读即生效”的副作用。
5. **目录 URI 没有结尾斜杠**，`directoryRead` 默认是 `false`。我的扩展声明是空对象，意味着不支持目录读取，客户端也就不会发那个可选方法——少实现一个方法，少一类错误。

## 六、接到我自己的流程上

现在我的服务器目录下并排放着两个 skill：`md-run-check` 和 `blog-publish-check`（发布前核对 front matter、字数、引用块、三个平台同步状态）。新增一个 skill 就是新增一个文件夹，服务器启动时扫描目录自动发现，不需要改代码。这样做的好处是流程和工具同版本发布：工具参数改了，对应的 skill 正文跟着改，换机器只要同步仓库。

更重要的是加载时机。以前模型连接后就背下所有工具描述，流程得靠我提醒；现在列表阶段只看到两个名字和一句描述，真正要做 MD 检查时才把正文和 `checklist.md` 读进来。上下文省下来了，流程也终于有了一个可校验、可版本化的落点。

小结：MCP 从“把函数暴露给模型”走到“把做法连同文件一起交付”，变化不在协议多复杂，而在它承认了一件事——知道怎么用，和能调用，本来就是两回事。把口头流程固化成 `SKILL.md`，顺手还能用摘要把“文件被偷偷改过”挡在门外。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

