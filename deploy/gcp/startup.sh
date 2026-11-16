#!/usr/bin/env bash
set -euo pipefail

# Google Compute Engine startup script for a Debian 12 VM.
# It contains no credentials. Add secrets to /etc/baxberi/baxberi.env over SSH.
exec > >(tee -a /var/log/baxberi-startup.log | logger -t baxberi-startup) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gnupg nginx certbot python3-certbot-nginx coturn

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

if ! id baxberi >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin baxberi
fi

install -d -o root -g baxberi -m 0750 /opt/baxberi
if [ ! -d /opt/baxberi/app/.git ]; then
  git clone --depth 1 --branch main https://github.com/OrxanMukhtar/baxberi.git /opt/baxberi/app
fi
npm --prefix /opt/baxberi/app ci --omit=dev
chown -R root:baxberi /opt/baxberi/app
find /opt/baxberi/app -type d -exec chmod 0750 {} \;
find /opt/baxberi/app -type f -exec chmod 0640 {} \;

install -d -o root -g root -m 0700 /etc/baxberi
if [ ! -e /etc/baxberi/baxberi.env ]; then
  install -o root -g root -m 0600 /dev/null /etc/baxberi/baxberi.env
fi

cat >/etc/systemd/system/baxberi.service <<'UNIT'
[Unit]
Description=Baxberi Node.js application
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=baxberi
Group=baxberi
WorkingDirectory=/opt/baxberi/app
EnvironmentFile=/etc/baxberi/baxberi.env
ExecStart=/usr/bin/node /opt/baxberi/app/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/nginx/sites-available/baxberi <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
ln -sfn /etc/nginx/sites-available/baxberi /etc/nginx/sites-enabled/baxberi
rm -f /etc/nginx/sites-enabled/default
nginx -t

# coturn stays disabled until its secret, DNS name, public/private IP mapping,
# and Let's Encrypt certificate have been configured in turnserver.conf.
systemctl disable --now coturn 2>/dev/null || true
systemctl daemon-reload
systemctl enable nginx
systemctl restart nginx
