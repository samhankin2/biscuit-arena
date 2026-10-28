#!/usr/bin/env bash
#
# One-shot setup for the Arnott's Biscuit Arena on an Ubuntu VPS
# (Oracle Cloud Always Free tier image works as-is).
#
# Usage:  sudo bash deploy/install-vps.sh [path-to-project]
#
# What it does:
#   1. installs Node.js 24 (the app uses the built-in node:sqlite module)
#   2. installs Caddy (free HTTPS via Let's Encrypt)
#   3. copies the app to /opt/biscuit-arena, data to /var/lib/biscuit-arena
#   4. registers and starts the systemd service on 127.0.0.1:3000
#   5. opens ports 22/80/443 in ufw
#
set -euo pipefail

SOURCE_DIR="${1:-$(pwd)}"
APP_DIR="/opt/biscuit-arena"
DATA_DIR="/var/lib/biscuit-arena"
SERVICE_USER="arena"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash $0 $SOURCE_DIR" >&2
  exit 1
fi

if [ ! -f "$SOURCE_DIR/server.js" ]; then
  echo "server.js not found in '$SOURCE_DIR'. Pass the project folder as the first argument." >&2
  exit 1
fi

echo "==> Installing base packages and Node.js 24"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg apt-transport-https ufw rsync
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node --version

echo "==> Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
caddy version

echo "==> Creating service user and directories"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"

echo "==> Copying application files to $APP_DIR"
rsync -a --delete \
  --exclude 'node_modules' --exclude 'data/*.db*' --exclude '.git' --exclude 'server.log' --exclude 'server.err' \
  "$SOURCE_DIR"/ "$APP_DIR"/

echo "==> Installing systemd service"
install -m 0644 "$APP_DIR/deploy/arena.service" /etc/systemd/system/arena.service
systemctl daemon-reload
systemctl enable arena
systemctl restart arena
sleep 2
systemctl --no-pager --lines=10 status arena || true

echo "==> Opening firewall ports"
ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw --force enable || true
ufw status || true

echo
echo "==> Local check"
curl -fsS http://127.0.0.1:3000/api/health && echo
echo
echo "Next steps:"
echo "  1. Point a hostname at this VPS (A record), then edit /etc/caddy/Caddyfile:"
echo "       ${APP_DIR}/deploy/Caddyfile  ->  /etc/caddy/Caddyfile"
echo "     e.g.  printf 'arena.yourdomain.com { reverse_proxy 127.0.0.1:3000 }\\n' > /etc/caddy/Caddyfile"
echo "     then:  systemctl reload caddy"
echo "  2. Open ports 80 and 443 in the Oracle Cloud console (Networking > Security Lists)"
echo "     AND on the instance if it uses iptables:"
echo "       iptables -I INPUT -p tcp --dport 80 -j ACCEPT; iptables -I INPUT -p tcp --dport 443 -j ACCEPT"
echo "  3. Point the QR code at https://arena.yourdomain.com"
echo
echo "Logs:    journalctl -u arena -f"
echo "Backup:  sudo cp $DATA_DIR/arena.db ~/arena-backup-$(date +%F).db"
