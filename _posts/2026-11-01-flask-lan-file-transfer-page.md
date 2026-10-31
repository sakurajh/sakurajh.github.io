---
layout: post
title: "Flask 做一个局域网文件互传页：扫码即传与文件名安全的处理"
date: 2026-11-01 06:02:00 +0800
categories: 项目
tags: Flask Python 局域网传输 Web开发 文件上传
description: "手机往电脑传照片、电脑往手机传文档，微信会压缩、数据线又要来回插。这篇记录我用 Flask 写的一个局域网互传页：同一 Wi-Fi 下扫码打开，上传下载都不装客户端。重点讲清 0.0.0.0 绑定、文件名清洗、令牌防护和 Werkzeug "
---

每次开组会前都要把图片和 PDF 从手机挪到笔记本上。用微信文件传输助手，图片会被压一道，几百兆的建模文件又传不上去；插数据线得先解锁手机、在电脑上点"允许访问"，讲台上手忙脚乱的时候最烦这一套。实验室的台式机和手机明明就在同一个 Wi-Fi 里，却没有任何现成的东西能把文件直接递过去。

我想要的东西很简单：电脑上跑一个脚本，屏幕上出现一个二维码，手机扫一下就是一个网页，选文件、上传；电脑刷新列表就能下载。不装客户端、不注册账号、不依赖外网。周末花了一个下午写完，叫它 file-bridge。

## 一、先把"互传"拆成最小闭环

一个能用的互传页其实只有三类操作：手机上传、电脑看列表并下载、电脑上传后手机再下载。上传和下载是对称的，真正要设计的只有两件事：**文件存在哪**，以及**怎么防止别人乱动**。

我没有选 SMB 共享，是因为 Windows 上开共享要动防火墙和账户策略，室友的 Mac 连不上还得再折腾。也没选自己写 socket 传文件，那等于把 HTTP 的断点、编码、浏览器兼容全部重做一遍。Flask 自带的开发服务器虽然不能上生产，但在这个只跑几十分钟、只有两三台设备访问的场景里完全够用，而且 `send_from_directory` 已经把路径穿越这类事情处理掉了。

目录结构如下，整个项目一个 `app.py` 加一个模板就够了：

```text
file-bridge/
├── app.py
├── templates/
│   └── index.html
└── files/            # 运行后自动创建，收到的文件都在这
```

启动方式：

```bash
python -m venv .venv
.venv\Scripts\activate
pip install flask qrcode pillow
python app.py
```

## 二、服务端：上传、列表、下载

下面这段是完整的后端，可以直接跑。几个关键点我在代码后面解释。

```python
import os
import socket
import time
import secrets
from pathlib import Path

import qrcode
from flask import Flask, abort, jsonify, render_template, request, send_from_directory

BASE = Path(__file__).parent
UPLOAD_DIR = BASE / "files"
UPLOAD_DIR.mkdir(exist_ok=True)

MAX_SIZE = 200 * 1024 * 1024          # 单次请求上限 200MB
TOKEN = secrets.token_urlsafe(8)      # 每次启动换一个

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_SIZE


def safe_name(raw: str) -> str:
    """只保留文件名本身，并加上时间前缀避免覆盖。"""
    name = Path(raw).name
    name = name.replace("\\", "_").replace("/", "_")   # 非 Windows 上反斜杠不是分隔符
    stem, suffix = os.path.splitext(name)
    stem = "".join(ch for ch in stem if ch.isalnum() or ch in "-_")[:40] or "file"
    return f"{int(time.time())}_{stem}{suffix.lower()}"


@app.before_request
def guard():
    if request.path.startswith("/static/"):
        return
    token = request.args.get("t") or request.headers.get("X-Bridge-Token")
    if token != TOKEN:
        abort(403)


@app.get("/")
def index():
    return render_template("index.html", token=TOKEN)


@app.post("/api/upload")
def upload():
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify(ok=False, msg="没有收到文件"), 400
    target = UPLOAD_DIR / safe_name(f.filename)
    f.save(target)
    return jsonify(ok=True, name=target.name, size=target.stat().st_size)


@app.get("/api/list")
def list_files():
    rows = []
    for p in sorted(UPLOAD_DIR.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if p.is_file():
            rows.append({"name": p.name, "size": p.stat().st_size})
    return jsonify(rows)


@app.get("/api/download/<path:name>")
def download(name):
    return send_from_directory(UPLOAD_DIR, name, as_attachment=True)


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))    # 不真正发包，只让内核选出出口网卡
        return s.getsockname()[0]
    finally:
        s.close()


if __name__ == "__main__":
    url = f"http://{lan_ip()}:8000/?t={TOKEN}"
    print("扫码或直接打开：", url)
    qrcode.make(url).show()
    app.run(host="0.0.0.0", port=8000, threaded=True)
```

先说 `host="0.0.0.0"`。Flask 默认监听 `127.0.0.1`，这个地址只接受本机连接，手机在另一个设备上，访问过去永远是连接超时。绑到 `0.0.0.0` 才是"本机所有网卡都听"，手机才能通过电脑的局域网 IP 连进来。我第一次调试时忘了改，排查了十几分钟才发现不是防火墙的问题。

再说 `safe_name`。浏览器提交过来的 `filename` 是客户端说了算的，直接拼路径就会出问题：一个叫 `../../app.py` 的文件能把内容写到项目根目录。`Path(raw).name` 只取最后一段，Windows 上反斜杠本身就是分隔符所以会被一起切掉，但在 Linux 上它只是普通字符，所以我又显式替换了一次。后面用 `isalnum()` 过滤字符，注意这个方法是 Unicode 感知的，中文文件名会原样保留，不会被清成空字符串；只有奇怪的控制字符会丢掉。后缀统一转小写，是为了避免 `.JPG` 和 `.jpg` 在列表里看起来像两个东西。

`send_from_directory` 而不是自己拼 `open()` 也是同样的道理：它内部会做规范化并检查结果是否仍在目标目录内，这类安全判断交给库比自己写靠谱。

还有一个细节是 `as_attachment=True`。不加这个参数，浏览器遇到图片和 PDF 会直接在标签页里打开，手机上想存下来还得再长按一次；加上之后响应头里是 `Content-Disposition: attachment`，浏览器一律走下载。中文文件名也不用自己编码，Werkzeug 会按 RFC 5987 生成 `filename*=UTF-8''...`，主流浏览器都能正确还原。我最初手动拼了一个 `filename="中文名.pdf"`，在安卓浏览器里直接变成一串百分号，就是这个原因。

## 三、令牌：它防的是谁，不防谁

上面用了一个启动时随机生成的 `TOKEN`，URL 里带着 `?t=...`，手机扫码时直接把这个地址带过去。必须把话说明白：**这只是一个能力令牌，不是身份认证**。任何拿到这个链接的人都能上传下载，它防的是同一网段里随手乱点的人、以及网页上被别的站点诱导发起的请求，防不住看到过二维码的人。

所以它的定位应该是"临时会话口令"：每次启动重新生成，只活一次会议的时间；用完 Ctrl+C，链接立刻失效。真正要长期开放的话，就得换成账号密码或者反向代理上加认证，那已经超出这个脚本的范围了。

顺带解决了另一个问题：如果只靠 URL 里的令牌，那么通过 `<img>`、表单跨站提交都能绕过同源策略发请求，令牌校验挡住了没有正确令牌的请求，这就是 `before_request` 统一拦截的价值——不用在每个接口里重复写判断，`/static/` 放行是因为样式表不带敏感数据。

## 四、页面：进度条为什么用 XHR 不用 fetch

手机端页面只有两个按钮，但上传大文件时如果没有任何反馈，用户会以为卡死了，反复点。这时候要注意：`fetch` 不支持上传进度事件，要看进度只能用 `XMLHttpRequest` 的 `upload.onprogress`。这是一个很实际的取舍，不是怀旧。

```html
<form id="up">
  <input type="file" name="file" multiple>
  <button>上传</button>
</form>
<progress id="bar" value="0" max="100"></progress>

<script>
const TOKEN = "{{ token }}";
const form = document.getElementById("up");
const bar = document.getElementById("bar");

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const files = [...form.file.files];
  let left = files.length;
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("X-Bridge-Token", TOKEN);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) bar.value = (ev.loaded / ev.total) * 100;
    };
    xhr.onload = () => { if (--left === 0) location.reload(); };
    xhr.onerror = () => { alert(file.name + " 上传失败"); };
    xhr.send(fd);
  }
});
</script>
```

这里我是一次发一个文件而不是并行发。并行看着快，但手机端并发上传会把带宽切成几份，每个请求都在慢慢爬，进度条反而更难判断；串行的话，一个完成再发下一个，逻辑也简单。

## 五、几处必须踩过才知道的坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 手机打不开页面，电脑本机正常 | 只绑定了 127.0.0.1 | 改成 `host="0.0.0.0"` |
| 手机连不上，但服务已启动 | Windows 防火墙拦了入站 | 首次启动时在弹窗里允许"专用网络"，不要点取消 |
| 上传大文件后页面卡住 | Werkzeug 默认单线程，上传期间其他请求排队 | `app.run(threaded=True)` |
| 超过上限时报 413 空白页 | `MAX_CONTENT_LENGTH` 触发 | 前端先判断 `file.size`，或自定义 413 处理器 |
| 中文名变成 `file.jpg` | 用了 `secure_filename` 的默认逻辑 | 自己实现白名单过滤，保留中文 |
| 两台设备时间不同导致排序奇怪 | 按文件修改时间排序 | 只做展示，不影响正确性 |

防火墙那条值得多说一句。Windows 第一次运行监听端口的程序会弹一个对话框，很多人顺手点了"取消"，之后再也弹不出来，症状就是本机能开、手机死活连不上。可以去"允许应用通过防火墙"里手动勾上 Python，比反复改代码高效。

关于内存，`request.files` 并不是把整个文件读进内存。Werkzeug 在请求体超过一定大小时会把它落到临时文件上，`f.save()` 实际是把临时文件搬到 `files/` 目录，所以几百兆的文件也不会把进程撑爆。真正会出问题的是 `MAX_CONTENT_LENGTH` 设得过大又不做前端拦截——请求体在解析阶段就已经写进磁盘临时目录了，系统盘空间紧张时，会先写满临时目录再报错，看起来像"上传失败"但根因在磁盘。

另外一个容易被忽略的点是：这个服务默认对整个局域网开放，如果电脑连着公司或学校的大网，同一网段的人拿到链接就能传东西进来。所以我在 `app.py` 里没有做任何端口转发、也没写开机自启——它的使用姿势就是"需要时开，用完关"。

## 六、小结

这个工具拢共两百行左右，没有任何依赖外网的服务，却把"手机和电脑之间递文件"这件小事解决得比较干净。回头看我踩的坑，几乎没有一个是 Flask 本身的问题，全都集中在三处：**监听地址选错**、**信任了客户端给的文件名**、**对开发服务器的并发能力有错误预期**。

如果你也想做一个，我建议从这个最小版本开始，先跑通一次真实的两端传输，再考虑加密码、加删除按钮、加手机端拍照直传。功能越加越多的时候，别忘了它最初只是为了替代一次扫码登录微信的麻烦。

