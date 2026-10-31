#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在 nginx 站点配置里插入 /stats/ 位置块（幂等），并做语法校验"""
import subprocess
import sys

CONF = "/etc/nginx/sites-available/blog.conf"
BLOCK = """
    # 访问统计（Basic Auth 保护，仅自己可见）
    location /stats/ {
        alias /var/www/stats/;
        index index.html;
        auth_basic "Private Stats";
        auth_basic_user_file /etc/nginx/.htpasswd_stats;
        add_header Cache-Control "no-store";
    }
"""

with open(CONF, encoding="utf-8") as f:
    src = f.read()

if "location /stats/" in src:
    print("已存在 /stats/ 配置，跳过插入")
else:
    idx = src.rstrip().rfind("}")
    src = src[:idx] + BLOCK + "}\n"
    with open(CONF + ".bak", "w", encoding="utf-8") as f:
        f.write(src)
    with open(CONF, "w", encoding="utf-8") as f:
        f.write(src)
    print("已插入 /stats/ 配置")

test = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
print(test.stderr.strip())
if test.returncode != 0:
    print("语法检查失败，回滚")
    subprocess.run(["cp", CONF + ".bak", CONF])
    sys.exit(1)

subprocess.run(["systemctl", "reload", "nginx"])
print("nginx 已重载")
