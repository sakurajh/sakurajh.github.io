---
layout: post
title: "用 FastAPI 写带权限的文件上传接口：路径穿越、类型校验与大小限制"
date: 2026-10-19 06:03:00 +0800
categories: 软件实战
tags: FastAPI 文件上传 接口安全 Python 权限控制 流式处理
description: "从教师上传试卷的真实需求出发，拆解 FastAPI 上传接口的鉴权、文件名处理、流式大小限制与内容校验，给出可以直接照抄的实现和常见错误对照表。"
---

去年给教研组做课堂情绪识别教学平台时，试卷导入是我最没当回事的接口：老师登录后传一份 PDF 或几张答题卡照片，后端存起来，学生端只能看结果。第一版只有二十来行，`UploadFile` 拿到手，`open(upload.filename, "wb")` 一写就返回成功。

后来我用 curl 做异常测试，把文件名改成 `../../config.py`，才意识到这个接口能把文件写到上传目录之外；再换一个学生账号调用，居然也能成功。真正的问题不是一个笔误，而是我把“文件已经收到”当成了“上传已经完成”。之后我按鉴权、命名、限流、验真四件事重写了它，下面这套代码是项目里正在用的简化版。

## 先把“上传成功”拆成四个条件

我现在要求接口同时满足四个条件才返回成功：调用者是当前班级的教师；文件大小不超过上限；扩展名和文件内容都在白名单里；最终路径一定落在上传根目录内。

这四个条件缺一不可，因为它们的失败方式完全不同。只做鉴权，老师传一个超大压缩包就能把磁盘写满；只做大小限制，学生依然能覆盖别人的试卷；只看扩展名，把脚本改成 `.png` 就能绕过；只检查路径，又挡不住伪装成图片的恶意内容。

还要先接受一个现实：上传接口是系统里少数让外部字节直接落到本机磁盘的入口。普通 JSON 接口的输入会被反序列化成受控结构，上传接口收到的却是一段完全不信任的二进制。把它当普通接口写，问题只是暂时还没被发现。

## 文件名只当展示，落盘名自己生成

路径穿越的根源不是 `open`，而是把调用方给的字符串当成了系统路径。`upload.filename` 来自 multipart 表单，可以写成 `../../../etc/passwd`，也可以是 Windows 下的 `..\..\config.ini`，甚至夹杂空字节。

我的做法是：扩展名只用来做白名单判断，真正的落盘名用 UUID 重新生成，原始文件名只存数据库，展示时再转义。这样即使原始名字再离谱，也不会参与磁盘定位。

```python
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException

ALLOWED_SUFFIX = {".pdf", ".png", ".jpg", ".jpeg"}
UPLOAD_ROOT = Path("data/uploads").resolve()


def make_target(original_name: str) -> Path:
    suffix = Path(original_name).suffix.lower()
    if suffix not in ALLOWED_SUFFIX:
        raise HTTPException(status_code=415, detail="只接受 PDF/PNG/JPEG")

    month_dir = UPLOAD_ROOT / datetime.now().strftime("%Y%m")
    month_dir.mkdir(parents=True, exist_ok=True)

    target = (month_dir / f"{uuid4().hex}{suffix}").resolve()
    try:
        target.relative_to(UPLOAD_ROOT)
    except ValueError:
        # UUID 生成的名字正常不会越界，这里留作兜底
        raise HTTPException(status_code=400, detail="非法路径")
    return target
```

这里有几个刻意的选择。用 `resolve()` 而不是 `absolute()`，因为它会展开 `..` 和符号链接，判断才有意义。用 `relative_to` 而不是字符串 `startswith`，因为 `/data/uploads2` 也以 `/data/uploads` 开头，字符串比较会放过它。按月份分目录则是运维考虑：单目录堆几十万文件后，备份和排查都会变慢。

我没有用 `secure_filename` 处理完就直接落盘。它解决的是“名字是否适合展示”，不是“路径是否在根目录内”。把这两件事分开，逻辑才不会互相依赖。原始文件名进数据库之后，前端渲染时也要转义，否则一个带标签的文件名又能变成存储型 XSS。

## 鉴权和大小限制：别等文件收完才拒绝

鉴权我写成依赖，挂在路由上。认证负责“你是谁”，授权负责“你能不能传”，两者都通过才进入业务函数：

```python
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")


async def current_teacher(token: str = Depends(oauth2_scheme)) -> User:
    user = await decode_and_load_user(token)  # 项目里已有的 JWT 校验
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录已失效")
    if user.role != "teacher":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "只有教师可以上传试卷")
    return user
```

这里有个容易忽略的细节：FastAPI 处理带表单的路由时，会先解析 multipart 请求体，再执行依赖函数。也就是说，鉴权依赖能挡住业务逻辑和落盘，但字节已经进了临时文件。攻击者不带合法 token 反复发大文件，依赖挡得住写入，挡不住带宽和临时磁盘的消耗。

所以大小限制不能只写在依赖里。我做了两层：反向代理限制请求体大小，接口内部再流式计数。代理层负责尽早切断连接，应用层保证绕过代理直接访问时也不会失控。也不能只信 `Content-Length`，分块传输可以不带这个头，声明的长度也可能和实际不符。

如果接口允许多文件，我会再限制一次数量，比如一次最多五张。多文件和单文件的风险不一样：每个文件都不大，但数量可以堆出问题。

## 流式写入与内容校验

真正写盘时，我不用 `shutil.copyfileobj(upload.file, out)` 一把梭。它写起来舒服，但中途不知道已经收了多少字节，只能在结束后才发现超限。下面的写法边读边计数，一超限就抛错，并清掉半截文件：

```python
from fastapi import HTTPException, UploadFile

CHUNK_SIZE = 1024 * 1024
MAX_BYTES = 20 * 1024 * 1024


async def save_with_limit(upload: UploadFile, target: Path) -> int:
    total = 0
    try:
        with target.open("xb") as out:  # xb：目标已存在就失败，避免覆盖
            while chunk := await upload.read(CHUNK_SIZE):
                total += len(chunk)
                if total > MAX_BYTES:
                    raise HTTPException(status_code=413, detail="文件超过 20 MB")
                out.write(chunk)
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    return total
```

`xb` 而不是 `wb`，是让“同名覆盖”变成显式错误。UUID 碰撞概率极低，但让文件系统兜底比让代码假设安全更可靠。捕获 `BaseException` 而不是只捕获 `Exception`，是为了在客户端断开、任务被取消时也能删掉半截文件。同步写盘会短暂阻塞事件循环，内部工具可以接受；并发上传很高时，可以放进 `anyio.to_thread.run_sync`，或者把接口写成同步 `def` 交给线程池。

写完还不算完，因为 `Content-Type` 和扩展名都由客户端决定。一个 `.png` 完全可以是 HTML 或一段脚本。我在落盘后读文件头，用魔数判断真实类型，失败就删掉刚写的文件：

```python
MAGIC = (
    (b"%PDF-", "application/pdf"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
)


def sniff_mime(path: Path) -> str:
    with path.open("rb") as f:
        head = f.read(16)
    for magic, mime in MAGIC:
        if head.startswith(magic):
            return mime
    path.unlink(missing_ok=True)
    raise HTTPException(status_code=415, detail="文件内容与扩展名不符")
```

魔数校验只是低成本的第一道门：它能挡住改扩展名的明显攻击，挡不住构造合法文件头再拼接恶意内容的文件。要更稳，可以再用 Pillow 的 `Image.verify()` 校验图片结构，PDF 交给专门解析器。但不管用哪种，都不要把它当病毒扫描，上传目录也永远不要挂到静态文件目录下直接对外提供。

还有个实现细节值得提醒：如果打算在写入前读文件头，读完必须 `seek(0)`，否则后续保存会从第十七个字节开始，文件看着上传成功，实际已经损坏。我早期为了省一次读盘就这么干过，排查了半天才发现问题出在校验函数。后来统一改成落盘后校验，虽然多读一次文件头，但状态少了一个，出问题更容易解释。

## 下载接口同样要鉴权

很多人上传做得严，下载却直接 `FileResponse(path)`，路径从查询参数来，权限完全没有。知道 URL 就能下载别人的试卷，前面的鉴权等于白做。

我的下载路由只接收数据库记录 id，路径从记录里取，不接收任何文件系统路径：

```python
@router.get("/papers/{paper_id}/file")
async def download_paper(
    paper_id: int,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    paper = await db.get(Paper, paper_id)
    if paper is None:
        raise HTTPException(status_code=404)
    if user.role != "teacher" and paper.class_id not in user.class_ids:
        raise HTTPException(status_code=403)

    return FileResponse(
        paper.storage_path,
        media_type=paper.mime,
        filename=paper.original_name,
        headers={"X-Content-Type-Options": "nosniff"},
    )
```

关键不在 `FileResponse` 本身，而在两点：可下载的前提是数据库里存在这条记录，并且当前用户对记录所属班级有权限。前者避免任意路径读取，后者避免“URL 藏得深就是安全”的错觉。`filename` 只影响响应头，不参与磁盘定位；`nosniff` 则告诉浏览器不要猜类型。

另外，上传目录放在应用包之外，数据库只存相对路径，运行时再和根目录拼接。这样换机器部署不用改一库绝对路径，清理任务也能在同一个根目录里先校验再删。

| 环节 | 我最初的做法 | 实际后果 | 现在的做法 |
|---|---|---|---|
| 文件名 | 直接用上传文件名拼接 | 可写到任意目录 | UUID 重命名，原名只入库 |
| 大小 | 文档里写“最大 20 MB” | 磁盘和带宽失控 | 代理层与应用层双重限制 |
| 类型 | 只看 Content-Type | 改扩展名即可绕过 | 后缀白名单加魔数校验 |
| 鉴权 | 登录即可上传 | 学生也能覆盖试卷 | 角色与班级双重检查 |
| 下载 | 查询参数传路径 | 知道 URL 就能读文件 | 按记录 id 查并校验归属 |

## 小结

这次改造之后，我给自己留了一份检查顺序：上传入口先问“谁能调”，再问“多大”，然后问“是不是它声称的类型”，最后问“落在哪”。它们分别对应鉴权依赖、双层大小限制、魔数或解析器校验、UUID 命名与根目录校验。

最容易被低估的是这几个等号：鉴权不等于限流，扩展名不等于内容，URL 不等于权限。上传接口看起来只是收一个文件，实际上同时处理网络、磁盘、内容解析和访问控制四个边界。分开写、分开测，代码不会长多少，出问题时却能立刻知道该看哪一层。

