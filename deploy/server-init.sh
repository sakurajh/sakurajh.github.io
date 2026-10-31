#!/usr/bin/env bash
# ============================================================
# 阿里云 ECS 初始化脚本（Ubuntu 24.04）
# 在服务器上以 root 执行：bash server-init.sh
# 作用：装 Nginx + rsync，建站点目录，开防火墙
# ============================================================
set -euo pipefail

SITE_DIR="/var/www/blog"

echo "==> 1/5 更新软件源"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

echo "==> 2/5 安装 Nginx / rsync / certbot"
apt-get install -y -qq nginx rsync certbot python3-certbot-nginx

echo "==> 3/5 建站点目录 $SITE_DIR"
mkdir -p "$SITE_DIR"
# 让 www-data 能读，rsync 用 root 写
chown -R www-data:www-data "$SITE_DIR"
chmod -R 755 "$SITE_DIR"

echo "==> 4/5 放行防火墙（如果启用了 ufw）"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  echo "    ufw 已放行 22/80/443"
else
  echo "    ufw 未启用，跳过（阿里云安全组记得放行 80/443）"
fi

echo "==> 5/5 启动 Nginx"
systemctl enable --now nginx
systemctl reload nginx

echo
echo "============================================================"
echo "初始化完成。接下来："
echo "1. 把 deploy/nginx-blog.conf 里的域名改成你的，然后："
echo "   cp nginx-blog.conf /etc/nginx/sites-available/blog.conf"
echo "   ln -sf /etc/nginx/sites-available/blog.conf /etc/nginx/sites-enabled/"
echo "   rm -f /etc/nginx/sites-enabled/default"
echo "   nginx -t && systemctl reload nginx"
echo "2. 在 GitHub 配好 Secrets 后触发一次部署，先确认 $SITE_DIR 有文件"
echo "3. 备案通过、域名解析过来之后申请证书："
echo "   certbot --nginx -d 你的域名 -d www.你的域名"
echo "============================================================"
echo "当前 Nginx 状态："
systemctl --no-pager --lines=0 status nginx | head -3
