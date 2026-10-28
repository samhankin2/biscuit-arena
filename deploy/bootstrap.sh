#!/bin/bash
#
# cloud-init bootstrap for the Arnott's Biscuit Arena instance.
# Runs as root on a fresh Ubuntu 24.04 (aarch64 or x86_64) OCI instance.
# Installs Node 24 + Caddy, clones the app, starts it as a systemd service,
# and points Caddy at arena.<public-ip>.sslip.io for a free TLS certificate.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

exec > >(tee -a /var/log/biscuit-bootstrap.log) 2>&1

echo "== bootstrap start $(date) =="

apt-get update -y
apt-get install -y curl ca-certificates gnupg ufw rsync git python3 apt-transport-https

echo "== node 24 =="
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node --version

echo "== caddy =="
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
caddy version

echo "== application =="
rm -rf /opt/biscuit-arena
git clone --depth 1 https://github.com/samhankin2/biscuit-arena.git /opt/biscuit-arena

getent group arena >/dev/null || groupadd --system arena
id -u arena >/dev/null 2>&1 || useradd --system --gid arena --home /opt/biscuit-arena --shell /usr/sbin/nologin arena
mkdir -p /var/lib/biscuit-arena
chown -R arena:arena /var/lib/biscuit-arena

install -m 0644 /opt/biscuit-arena/deploy/arena.service /etc/systemd/system/arena.service
systemctl daemon-reload
systemctl enable --now arena
sleep 3
systemctl --no-pager --lines=5 status arena || true

echo "== firewall =="
ufw allow 22/tcp || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw --force enable || true

# Oracle's Ubuntu image installs an iptables REJECT rule ahead of the ufw chains,
# so ufw alone does not open 80/443. Insert the accepts before that rule and
# persist them across reboots.
for PORT in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 4 -p tcp --dport "$PORT" -j ACCEPT
  fi
done
if command -v netfilter-persistent >/dev/null 2>&1; then
  sudo netfilter-persistent save || true
else
  sudo sh -c 'mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4' || true
fi

echo "== https =="
# The public IP is not always present in the instance metadata, so fall back to
# the address the instance uses for outbound traffic.
PUBIP="$(curl -fsS -H 'Authorization: Bearer Oracle' http://169.254.169.254/opc/v2/instance/ \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("publicIp") or d.get("ipMetadata",{}).get("publicIp") or "")' 2>/dev/null || true)"
if [ -z "$PUBIP" ]; then
  PUBIP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me/ip || true)"
fi
PUBIP="$(echo "$PUBIP" | tr -d '[:space:]')"
if [ -z "$PUBIP" ]; then
  echo "could not determine the public IP" >&2
  exit 1
fi
HOST="arena.${PUBIP}.sslip.io"
cat > /etc/caddy/Caddyfile <<EOF
${HOST} {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		-Server
	}
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl enable caddy
caddy validate --config /etc/caddy/Caddyfile
systemctl restart caddy
echo "hostname: ${HOST}"

echo "== health =="
systemctl is-active --quiet arena && echo "arena service: active"
curl -fsS http://127.0.0.1:3000/api/health
echo
echo "== bootstrap done $(date) =="
