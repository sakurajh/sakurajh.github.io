# -*- coding: utf-8 -*-
"""把 URL 列表提交给 IndexNow（Bing / Edge / Yandex / Seznam / Naver 共用）"""
import json
import os
import sys
import urllib.request

KEY = "2841f6f35f5267a30752bdc675745393"
HOST = "www.sakura.work.gd"
ENDPOINT = "https://api.indexnow.org/indexnow"


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "urls.txt"
    with open(path, encoding="utf-8") as f:
        urls = [line.strip() for line in f if line.strip()]
    if not urls:
        print("没有需要提交的 URL")
        return

    payload = {
        "host": HOST,
        "key": KEY,
        "keyLocation": "https://%s/%s.txt" % (HOST, KEY),
        "urlList": urls[:10000],
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT,
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print("IndexNow 提交成功: HTTP %s，共 %d 条" % (resp.status, len(urls)))
    except urllib.error.HTTPError as e:
        print("IndexNow 返回 HTTP %s: %s" % (e.code, e.read().decode("utf-8", "ignore")[:300]))
        sys.exit(1)
    except Exception as e:
        print("IndexNow 提交失败: %s" % e)
        sys.exit(1)


if __name__ == "__main__":
    main()
