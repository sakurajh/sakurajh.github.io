#!/usr/bin/env bash
# ============================================================
# 备案通过后：把站点从 IP 预览切到正式域名 + 自动 HTTPS
# 用法：sudo bash switch-domain.sh sakurajh.xyz
# 前置：域名已解析到本机 IP（A 记录），80 端口可从外网访问
# ============================================================
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "用法: sudo bash switch-domain.sh 你的域名.com"
  exit 1
fi

CONF=/etc/nginx/sites-available/blog.conf
WEBROOT=/var/www/blog

echo "==> 目标域名: $DOMAIN"

echo "==> 1/5 检查 DNS 是否已指向本机"
MYIP=$(curl -s --max-time 10 https://api.ipify.org || echo "")
RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || echo "")
echo "    本机公网 IP : ${MYIP:-未知}"
echo "    域名解析 IP : ${RESOLVED:-解析失败}"
if [[ -z "$RESOLVED" ]]; then
  echo "    ✗ 域名还未解析，请先在 DNS 添加 A 记录指向 $MYIP 后再运行"
  exit 1
fi
if [[ "$RESOLVED" != "$MYIP" ]]; then
  echo "    ! 解析到的 IP 与本机不一致，确认无误后继续（10 秒后继续，Ctrl+C 取消）"
  sleep 10
fi

echo "==> 2/5 备份当前 Nginx 配置"
cp "$CONF" "${CONF}.bak.$(date +%Y%m%d%H%M%S)"

echo "==> 3/5 改写 server_name"
python3 - "$CONF" "$DOMAIN" <<'PY'
import re
import sys

conf, domain = sys.argv[1], sys.argv[2]
with open(conf, encoding="utf-8") as f:
    text = f.read()

names = f"www.{domain} {domain}"
text = re.sub(r"server_name\s+[^;]+;", f"server_name {names};", text, count=1)

with open(conf, "w", encoding="utf-8") as f:
    f.write(text)
print("    server_name ->", names)
PY

echo "==> 4/5 校验并重载 Nginx"
nginx -t
systemctl reload nginx

echo "==> 5/5 申请 Let's Encrypt 证书并开启 HTTPS 跳转"
if ! command -v certbot >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx
fi
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --redirect || {
    echo "    ✗ 证书申请失败（常见原因：80 端口不通 / 解析未生效 / 短时间重复申请）"
    echo "    稍后手动重试： certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect"
    exit 1
  }

echo
echo "============================================================"
echo "切换完成 ✅"
echo "  访问: https://$DOMAIN"
echo "  证书自动续期由 systemd timer 管理，可用 'certbot renew --dry-run' 验证"
echo
echo "还需要做的一步（在 GitHub 仓库里）："
echo "  Settings → Secrets and variables → Actions → Variables"
echo "  把 ECS_DOMAIN 改成 $DOMAIN，然后重新触发 Deploy to Aliyun ECS"
echo "  （脚本会自动把页面里的绝对地址从 http://IP 改成 https://域名）"
echo "============================================================"
