---
layout: post
title: "FastAPI 0.162 修了省略布尔表单字段的默认值：文件互传接口迁移复盘"
date: 2026-11-06 06:02:00 +0800
categories: 软件实战
tags: FastAPI Python 表单校验 Pydantic Web开发
description: "把局域网文件互传页从 Flask 迁到 FastAPI 后，不勾「覆盖同名文件」的请求直接返回 422。这篇从浏览器不提交未选中 checkbox 讲起，说明 FastAPI 0.162.0 对省略布尔表单字段默认值处理的调整，以及我最后怎"
---

上周我写了个局域网文件互传页 file-bridge，手机扫码就能往电脑传文件。当时用的是 Flask，一个 `app.py` 加一个模板就够用。这两周我想给它加个上传进度条和并发上传，Flask 的同步视图处理起来别扭，索性把后端换成了 FastAPI：`async def` 视图、`UploadFile` 流式读、自动生成的 `/docs`，都比原来顺手。

迁移本身不复杂，真正让我卡住的是一行看起来最不起眼的参数：`overwrite: bool`。前端那个「覆盖同名文件」的复选框，只要用户不勾，后端就直接回 422，连文件都没开始读。我一开始以为是前端把字段拼错了，抓包看了半天，才发现问题不在前端，而在我对「表单里没出现的字段」这件事的理解。

## 一、复现：不勾复选框，请求里就没有这个键

最小复现是这样的：一个只有文件框和一个复选框的 HTML 表单，`<input type="checkbox" name="overwrite" value="on">`，用户不勾选就直接提交。用浏览器开发者工具看请求体，内容大致是：

```text
------WebKitFormBoundaryxxxx
Content-Disposition: form-data; name="file"; filename="a.txt"
Content-Type: text/plain

hello
------WebKitFormBoundaryxxxx--
```

注意，整个请求体里根本没有 `overwrite` 这个键。这不是浏览器偷懒，而是 HTML 表单的既定语义：**未选中的复选框不会被当作成功控件提交**。也就是说，浏览器不会传 `overwrite=false`，它选择什么都不传。

而我的接口声明是：

```python
@app.post("/api/upload")
async def upload(
    file: Annotated[UploadFile, File(...)],
    overwrite: Annotated[bool, Form()] = False,
):
    ...
```

按直觉，没传就应该用默认值 `False`。但在我用的那个版本上，请求直接回了 422，响应体是 FastAPI 常见的校验错误：

```json
{
  "detail": [
    {
      "type": "missing",
      "loc": ["body", "overwrite"],
      "msg": "Field required",
      "input": null
    }
  ]
}
```

这里就是第一个容易搞错的点：`type` 是 `missing`，不是 `bool_parsing`。说明校验器根本没拿到这个值，而不是拿到了一个无法转成布尔的字符串。`loc` 指向 `body` 而不是 `query`，也确认了它走的是表单体这条路径。

## 二、根因：布尔字段在表单里的默认值语义被绕过了

要讲清这个坑，得把表单数据的传递链拆成三段。

第一段是浏览器。表单提交的是一组键值对，`FormData` 本质上就是多值字典，一个键可以出现零次、一次或多次。复选框没勾，就是零次。

第二段是 Starlette 的 `FormData`。它把请求体解析成类似 `MultiDict` 的结构，取一个不存在的键会得到 `None`。单看这一层，「缺键」和「值为空」已经能分开了：缺键是 `None`，显式传真假值则是字符串。

第三段是 Pydantic 的校验。`bool` 类型在宽松模式下能接受 `"true"`、`"false"`、`"1"`、`"0"`、`"on"`、`"off"`、`"yes"`、`"no"` 这些字符串，这也是为什么 checkbox 的默认值 `"on"` 能直接被解析成 `True`。但如果传进来的是 `None`，它既不是合法的布尔字符串，也不等于「字段没有提供」，于是校验器只能报错。

问题就出在第二段到第三段的交接：一个声明了默认值的布尔字段，本应在缺键时直接取默认值，可当时的实现没有把「缺键」这个信号正确交给默认值逻辑，而是把它当成了一次需要校验的输入。结果就是：字段声明了 `= False`，但缺键时依然要求必填。这跟 Pydantic 模型里 `overwrite: bool = False` 的行为是不一致的——模型里缺字段一定取默认值，不会报 missing。

FastAPI 的发布说明也印证了这一点。0.161.1 这一版的变更条目写的是「Restore default handling for omitted boolean form fields」，即恢复省略布尔表单字段时的默认值处理；紧接着 0.162.0（2026-10-23）的说明更明确：省略的 `bool` 和 `bool | None` 表单字段，现在会使用声明时的默认值，或者按缺字段报错，与其它字段和 Pydantic 的行为保持一致。

换句话说，这次调整不是加了个新特性，而是把一个不一致修回来了。**「缺键」应该走默认值或必填校验，「有键但值不合法」才该走类型错误**，这两件事以前在布尔字段上被混成了一件。

## 三、为什么不能简单地把 None 当成 False

看到这里，最省事的想法是：那我在校验前把 `None` 统一转成 `False` 不就行了？我在代码里试过，很快就放弃了，因为它会把 `bool | None` 这个类型废掉。

设想一个真实需求：file-bridge 里除了单文件上传，还有个「批量导入」入口。用户可能希望这次导入**覆盖**同名文件，也可能希望**保留**已有文件，还可能**什么都没选，跟随全局设置**。这是三种状态，不是两种。如果缺键一律当 `False`，那「用户明确选了不覆盖」和「用户压根没表态」就分不开了，后端也就没法回退到全局配置。

这也是为什么 0.162.0 的说明里专门把 `bool | None` 和 `bool` 并列：前者缺键时得到 `None`，后者缺键时得到声明的默认值。类型本身就是语义，靠后处理去猜，迟早会在某个分支上猜错。

我把常见的几种声明方式整理成了下面这张表，迁移时对着它选就行：

| 声明写法 | 字段缺省时 | 传 `"on"` | 传 `"false"` | 适用场景 |
|---|---|---|---|---|
| `overwrite: Annotated[bool, Form()] = False` | `False` | `True` | `False` | 普通开关，默认安全值 |
| `overwrite: Annotated[bool, Form()]` | 422 缺字段 | `True` | `False` | 必须由调用方明确表态 |
| `overwrite: Annotated[bool \| None, Form()] = None` | `None` | `True` | `False` | 三态，需要区分「没传」 |
| `overwrite: Annotated[bool, Form()] = True` | `True` | `True` | `False` | 默认覆盖，慎用 |

表格里第二行值得单独说一句：不写默认值不是「默认 False」，而是必填。Pydantic 里 `bool` 没有隐式默认值，`Form()` 也一样。我见过有人把 `Form()` 和 `Form(False)` 当成同义写法，上线后才发现前者对缺字段直接 422。

## 四、我的最终写法：默认值、显式传值、回归测试三件事

最后我没有只靠「升级到 0.162.0 就好了」收尾。版本修复解决的是框架行为，接口本身该表达清楚的语义还是得自己写清楚。落地下来是三件事。

第一，服务端保留默认值，并且选安全的一侧。覆盖文件是破坏性操作，默认必须是 `False`，这样即使客户端漏传，最坏结果也只是多一次 409，而不是悄悄覆盖掉别人的文件。文件名清洗也顺手收紧：只取 `Path(...).name`，把任何目录部分丢掉，避免 `../` 之类的输入落到上传目录之外。

```python
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

BASE = Path(__file__).parent
FILES = BASE / "files"
FILES.mkdir(exist_ok=True)

app = FastAPI()


def safe_name(raw: str) -> str:
    name = Path(raw).name
    if name in {"", ".", ".."}:
        raise HTTPException(status_code=400, detail="非法文件名")
    return name


@app.post("/api/upload")
async def upload(
    file: Annotated[UploadFile, File(...)],
    overwrite: Annotated[bool, Form()] = False,
):
    target = FILES / safe_name(file.filename or "")
    if target.exists() and not overwrite:
        raise HTTPException(status_code=409, detail="同名文件已存在")

    tmp = target.with_suffix(target.suffix + ".part")
    with tmp.open("wb") as out:
        while chunk := await file.read(1 << 20):
            out.write(chunk)
    tmp.replace(target)
    return {"name": target.name, "overwritten": overwrite}
```

先写 `.part` 临时文件、读完再 `replace`，是为了让「传输中断」不会留下一个看起来完整、实际截断的文件。这个细节和布尔字段无关，但迁移时一起补上了，因为异步读取的分块边界比同步版本更容易在中途断开。

第二，前端不依赖「缺键」这个隐式语义。既然页面已经用 `fetch` 做进度条了，那就显式把布尔值拼进 `FormData`：

```javascript
const fd = new FormData();
fd.append("file", input.files[0]);
fd.append("overwrite", document.querySelector("#ow").checked ? "true" : "false");

await fetch("/api/upload", { method: "POST", body: fd });
```

这样做的好处很实际：抓包时能直接看到 `overwrite=false`，日志里也能区分「客户端明确说不覆盖」和「客户端版本太老没传这个字段」。后者在灰度期间特别有用——如果哪台设备还在走缺省路径，我一眼就能从日志里发现。

第三，用测试把行为钉住。框架小版本的默认值行为改过一次，就说明这类语义值得写进回归测试，而不是靠记忆：

```python
import app as appmod
from fastapi.testclient import TestClient

client = TestClient(appmod.app)


def post(name: str, data: dict[str, str] | None = None):
    return client.post(
        "/api/upload",
        files={"file": (name, b"hello", "text/plain")},
        data=data or {},
    )


def test_omitted_overwrite_defaults_false(tmp_path, monkeypatch):
    monkeypatch.setattr(appmod, "FILES", tmp_path)
    r = post("a.txt")
    assert r.status_code == 200
    assert r.json()["overwritten"] is False


def test_duplicate_upload_conflicts(tmp_path, monkeypatch):
    monkeypatch.setattr(appmod, "FILES", tmp_path)
    assert post("a.txt").status_code == 200
    assert post("a.txt").status_code == 409


def test_explicit_overwrite_true(tmp_path, monkeypatch):
    monkeypatch.setattr(appmod, "FILES", tmp_path)
    assert post("a.txt").status_code == 200
    r = post("a.txt", {"overwrite": "true"})
    assert r.status_code == 200
    assert r.json()["overwritten"] is True
```

三个用例分别覆盖「缺键取默认」「缺键不覆盖」「显式覆盖」。`tmp_path` 加 `monkeypatch` 是为了不往真实的 `files/` 目录里写测试垃圾——我第一次跑测试时忘了这一步，结果本地多出一堆 `a.txt`，还把后续用例的 409 判断带偏了。

## 五、升级到 0.162 前后要检查的几处

如果你手上也有 FastAPI 项目，尤其是从旧版本升上来的，我建议按下面几项过一遍，而不是只看 `pip list` 里的版本号变了：

| 检查项 | 为什么要查 |
|---|---|
| 所有 `Form(...)` 里的 `bool` / `bool \| None` | 默认值语义在这一轮有调整，缺字段的请求结果可能变化 |
| 以依赖注入方式声明的表单参数 | 依赖里的 `Form` 参数走同一条校验路径，容易漏掉 |
| `/docs` 里的 `required` 标记 | 有默认值的字段不应出现在必填列表里，升级后可以对照确认 |
| 依赖「缺字段就 422」的前端逻辑 | 如果前端靠 422 判断字段是否存在，升级后可能收不到预期错误 |
| 用 TestClient 写过的表单用例 | 补一条「完全不传该字段」的用例，锁住默认值行为 |

其中第四条是我踩得最隐蔽的一处。file-bridge 早期有个很土的判断：前端把 422 当成「后端不支持覆盖」的信号，从而隐藏复选框。升级之后缺字段不再报错，这个信号就消失了，前端反而把复选框显示了出来。代码没报错，行为却变了，这种问题只能靠列清单去查。

另外提醒一句，`bool | None` 在 OpenAPI 里会生成可空的布尔 schema，但 HTML 表单控件本身没有「未选择」这个值，浏览器只会不提交。所以三态设计在前端一定要有对应的表达方式，比如单选按钮组加一个「跟随默认」，或者干脆让调用方用 JSON 接口而不是表单。表单适合「有/没有」，不适合「有/无/未知」。

## 小结

这件事表面上是升级一个补丁版本，实际是把「表单字段缺失」和「字段值非法」这两种情况重新分开。我的结论有三条：布尔表单字段的省略语义要显式设计，不要靠猜；默认值永远选破坏性小的那一侧；凡是框架修过的行为，都用一条测试固定下来。file-bridge 现在跑在 0.162.x 上，上传、覆盖、冲突三种路径都能从日志和测试里对上，比迁移之前踏实多了。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

