# -*- coding: utf-8 -*-
"""生成需要提交给搜索引擎的 URL 列表（基于 _posts 文件名推导 permalink）"""
import glob
import os
import re

BASE = "https://www.sakurajh.xyz"
PAGES = ["archive", "categories", "projects", "about"]

urls = [BASE + "/"]
for p in PAGES:
    urls.append("%s/%s.html" % (BASE, p))

paths = sorted(glob.glob("_posts/*.md")) + sorted(glob.glob("_posts/*.html"))
for path in paths:
    name = os.path.splitext(os.path.basename(path))[0]
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})-(.+)", name)
    if not m:
        continue
    y, mo, d, slug = m.groups()
    urls.append("%s/%s/%02d/%02d/%s.html" % (BASE, y, int(mo), int(d), slug))

# 去重保序
seen = set()
out = []
for u in urls:
    if u not in seen:
        seen.add(u)
        out.append(u)

print("\n".join(out))
