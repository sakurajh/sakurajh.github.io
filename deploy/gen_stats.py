#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 nginx access 日志生成一个静态统计页面（无外部依赖）
输出: /var/www/stats/index.html
用法: python3 gen_stats.py
"""
import collections
import datetime
import glob
import gzip
import html
import os

LOG_DIR = "/var/log/nginx"
LOG_PATTERNS = ["blog.access.log", "blog.access.log.1", "blog.access.log.*.gz"]
OUT_FILE = "/var/www/stats/index.html"

ASSET_EXT = (".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
             ".webp", ".woff", ".woff2", ".ttf", ".map", ".webmanifest", ".json")

# 不算“内容页”的路径前缀/精确路径
SKIP_PREFIX = ("/stats", "/assets/")
SKIP_EXACT = ("/manifest.webmanifest", "/search.json", "/robots.txt", "/sitemap.xml")


def is_content(path):
    low = path.lower()
    if low.endswith(ASSET_EXT):
        return False
    if low.startswith(SKIP_PREFIX):
        return False
    if low in SKIP_EXACT:
        return False
    return True

# 视为“机器人”的 UA 关键词（粗筛，不计入 UV）
BOT_KEYS = ("bot", "spider", "crawler", "curl", "wget", "python-requests",
            "headlesschrome", "scrapy", "httpclient", "go-http-client")


def iter_lines():
    files = []
    for pat in LOG_PATTERNS:
        files.extend(glob.glob(os.path.join(LOG_DIR, pat)))
    # 去重 + 按修改时间从新到旧
    files = sorted(set(files), key=lambda p: os.path.getmtime(p), reverse=True)
    for path in files:
        opener = gzip.open if path.endswith(".gz") else open
        try:
            with opener(path, "rt", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    yield line
        except Exception:
            continue


def parse(line):
    """解析 combined 格式；返回 dict 或 None"""
    try:
        # IP - - [time] "METHOD PATH PROTO" STATUS BYTES "referer" "ua"
        head, rest = line.split("[", 1)
        ts_str, rest = rest.split("]", 1)
        ip = head.split()[0]
        quoted = rest.split('"')
        if len(quoted) < 6:
            return None
        req = quoted[1]
        status_bytes = quoted[2].split()
        referer = quoted[3]
        ua = quoted[5]
        status = int(status_bytes[0])
        try:
            size = int(status_bytes[1])
        except (IndexError, ValueError):
            size = 0
        parts = req.split()
        path = parts[1] if len(parts) > 1 else "-"
        ts = datetime.datetime.strptime(ts_str.split()[0], "%d/%b/%Y:%H:%M:%S")
        return {"ip": ip, "ts": ts, "path": path, "status": status,
                "size": size, "referer": referer, "ua": ua}
    except Exception:
        return None


def is_bot(ua):
    ua = (ua or "").lower()
    return any(k in ua for k in BOT_KEYS)


def fmt_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} TB"


def main():
    today = datetime.date.today()
    d7 = today - datetime.timedelta(days=6)

    pv_today = uv_today = 0
    pv_7 = 0
    pv_total = 0
    bytes_total = 0
    ips_today = set()
    ips_7 = set()
    pages_today = collections.Counter()
    pages_7 = collections.Counter()
    referers = collections.Counter()
    statuses = collections.Counter()
    hourly = collections.Counter()
    recent = []

    for line in iter_lines():
        r = parse(line)
        if not r:
            continue
        if r["status"] >= 400 and r["status"] != 404:
            pass  # 仍然统计，稍后按状态码分组
        pv_total += 1
        bytes_total += r["size"]
        statuses[r["status"]] += 1

        d = r["ts"].date()
        bot = is_bot(r["ua"])

        if d >= d7:
            pv_7 += 1
            if not bot:
                ips_7.add(r["ip"])
            if is_content(r["path"]):
                pages_7[r["path"]] += 1

        if d == today:
            pv_today += 1
            if not bot:
                ips_today.add(r["ip"])
            if is_content(r["path"]):
                pages_today[r["path"]] += 1
            hourly[r["ts"].hour] += 1
            if len(recent) < 200:
                recent.append(r)

        if r["referer"] and r["referer"] != "-":
            ref = r["referer"]
            if "sakurajh.xyz" not in ref and "sakura.work.gd" not in ref and "47.96.185.219" not in ref:
                referers[ref] += 1

    recent = recent[:25]

    def row(cells, tag="td"):
        return "<tr>" + "".join(f"<{tag}>{c}</{tag}>" for c in cells) + "</tr>"

    max_hour = max(hourly.values()) if hourly else 1
    bars = ""
    for h in range(24):
        v = hourly.get(h, 0)
        pct = int(v / max_hour * 100) if max_hour else 0
        bars += (f'<div class="bar" title="{h:02d}:00 — {v} 次">'
                 f'<i style="height:{max(pct,2)}%"></i><b>{h}</b></div>')

    top_pages = "".join(row([html.escape(p), f"{c:,}"]) for p, c in pages_7.most_common(12)) or row(["暂无数据", "-"])
    top_ref = "".join(row([html.escape(r[:70]), f"{c:,}"]) for r, c in referers.most_common(10)) or row(["暂无外链", "-"])
    status_rows = "".join(row([s, f"{c:,}"]) for s, c in sorted(statuses.items())) or row(["-", "-"])
    recent_rows = "".join(
        row([r["ts"].strftime("%H:%M:%S"), html.escape(r["path"][:56]),
             r["status"], "机器人" if is_bot(r["ua"]) else "访客"])
        for r in recent) or row(["暂无", "-", "-", "-"])

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>访问统计 · 赵华的博客</title>
<style>
*{{box-sizing:border-box}}
body{{margin:0;padding:28px 20px 60px;background:#f6f7fb;color:#0f172a;
  font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6}}
.wrap{{max-width:1080px;margin:0 auto}}
h1{{font-size:20px;margin:0 0 4px}}
.muted{{color:#64748b;font-size:12.5px}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin:20px 0}}
.card{{background:#fff;border:1px solid #e5e9f0;border-radius:14px;padding:16px 18px;
  box-shadow:0 10px 24px -18px rgba(15,23,42,.5)}}
.card .k{{color:#64748b;font-size:12px;letter-spacing:.5px}}
.card .v{{font-size:26px;font-weight:800;margin-top:4px;
  background:linear-gradient(96deg,#4f46e5,#0891b2);-webkit-background-clip:text;background-clip:text;color:transparent}}
.panel{{background:#fff;border:1px solid #e5e9f0;border-radius:14px;padding:18px 20px;margin-bottom:18px;
  box-shadow:0 10px 24px -20px rgba(15,23,42,.5)}}
.panel h2{{font-size:14px;margin:0 0 14px;color:#334155}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
td{{padding:7px 6px;border-bottom:1px solid #f1f5f9;vertical-align:top}}
tr:last-child td{{border-bottom:none}}
td:last-child{{text-align:right;color:#64748b;white-space:nowrap}}
.chart{{display:flex;align-items:flex-end;gap:2px;height:120px}}
.bar{{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}}
.bar i{{display:block;width:100%;background:linear-gradient(180deg,#6366f1,#a5b4fc);border-radius:3px 3px 0 0;min-height:2px}}
.bar b{{font-size:9px;color:#94a3b8;font-weight:400;margin-top:4px}}
.grid2{{display:grid;grid-template-columns:1fr 1fr;gap:18px}}
@media(max-width:760px){{.grid2{{grid-template-columns:1fr}}}}
.badge{{display:inline-block;padding:1px 7px;border-radius:6px;background:#eef2ff;color:#4f46e5;font-size:11px}}
</style></head>
<body><div class="wrap">
<h1>访问统计 <span class="badge">本站私有</span></h1>
<div class="muted">生成于 {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} · 数据来源：nginx access log · 不含外部统计服务</div>

<div class="cards">
  <div class="card"><div class="k">今日 PV</div><div class="v">{pv_today:,}</div></div>
  <div class="card"><div class="k">今日 UV</div><div class="v">{len(ips_today):,}</div></div>
  <div class="card"><div class="k">近 7 天 PV</div><div class="v">{pv_7:,}</div></div>
  <div class="card"><div class="k">近 7 天 UV</div><div class="v">{len(ips_7):,}</div></div>
  <div class="card"><div class="k">累计 PV</div><div class="v">{pv_total:,}</div></div>
  <div class="card"><div class="k">累计流量</div><div class="v">{fmt_size(bytes_total)}</div></div>
</div>

<div class="panel"><h2>今日各时段访问</h2><div class="chart">{bars}</div></div>

<div class="grid2">
  <div class="panel"><h2>热门页面（近 7 天）</h2><table>{top_pages}</table></div>
  <div class="panel"><h2>外部来源（近 7 天）</h2><table>{top_ref}</table></div>
</div>

<div class="grid2">
  <div class="panel"><h2>状态码分布</h2><table>{status_rows}</table></div>
  <div class="panel"><h2>最近访问</h2><table>{recent_rows}</table></div>
</div>

<div class="muted" style="margin-top:8px">
  UV 按 IP 去重并已粗略排除常见爬虫 UA；热门页面已过滤静态资源。
</div>
</div></body></html>
"""

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    tmp = OUT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(doc)
    os.replace(tmp, OUT_FILE)
    print(f"生成完成: {OUT_FILE}  (PV 今日 {pv_today}, 7 天 {pv_7}, 累计 {pv_total})")


if __name__ == "__main__":
    main()
