#!/usr/bin/env bash
# Установка SPEED HELPER на чистый Ubuntu 22.04/24.04 (Timeweb Cloud). Запуск от root:
#   curl -fsSL https://raw.githubusercontent.com/SevenArtMoscow/speed-helper/main/deploy/setup.sh -o setup.sh && bash setup.sh
# Повторный запуск безопасен: обновляет код и перезапускает сервис, данные и .env не трогает.
set -euo pipefail

DOMAIN="${DOMAIN:-speedhelper.ru}"
REPO="${REPO:-https://github.com/SevenArtMoscow/speed-helper.git}"
BRANCH="${BRANCH:-main}"
DIR=/opt/speedhelper
export DEBIAN_FRONTEND=noninteractive

echo "==> Пакеты"
apt-get update -q
apt-get install -yq curl git nginx postgresql certbot python3-certbot-nginx ufw
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

echo "==> Пользователь и код"
id speedhelper >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin speedhelper
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" reset -q --hard "origin/$BRANCH"
else git clone -q -b "$BRANCH" "$REPO" "$DIR"; fi
(cd "$DIR/server" && npm ci --omit=dev --silent 2>/dev/null || npm install --omit=dev --silent)

echo "==> База данных"
ENV="$DIR/server/.env"
if [ ! -f "$ENV" ]; then
  DBPASS="$(openssl rand -hex 16)"
  sudo -u postgres psql -qc "create role speedhelper login password '$DBPASS'" 2>/dev/null || sudo -u postgres psql -qc "alter role speedhelper password '$DBPASS'"
  sudo -u postgres psql -qc "create database speedhelper owner speedhelper" 2>/dev/null || true
  # миграции создают роли anon/authenticated (совместимость с Supabase)
  sudo -u postgres psql -qc "alter role speedhelper createrole"
  cat > "$ENV" <<EOF
PORT=3000
DATABASE_URL=postgres://speedhelper:$DBPASS@127.0.0.1:5432/speedhelper
TG_BOT_TOKEN=${TG_BOT_TOKEN:-}
JWT_SECRET=$(openssl rand -hex 32)
APP_URL=https://$DOMAIN
ADMIN_TG_IDS=${ADMIN_TG_IDS:-}
EOF
fi
chmod 600 "$ENV"; chown -R speedhelper:speedhelper "$DIR"

echo "==> Резервные копии БД (ежедневно, хранятся 14 дней)"
mkdir -p /var/backups/speedhelper && chown postgres /var/backups/speedhelper
cat > /etc/cron.d/speedhelper-backup <<'EOF'
30 3 * * * postgres pg_dump -Fc speedhelper > /var/backups/speedhelper/db-$(date +\%F).dump && find /var/backups/speedhelper -name '*.dump' -mtime +14 -delete
EOF

echo "==> Сервис"
cat > /etc/systemd/system/speedhelper.service <<EOF
[Unit]
Description=SPEED HELPER (mini app + bot)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=speedhelper
WorkingDirectory=$DIR/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q speedhelper

echo "==> nginx"
cat > /etc/nginx/sites-available/speedhelper <<EOF
server {
  listen 80;
  server_name $DOMAIN www.$DOMAIN;
  client_max_body_size 4m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
EOF
ln -sf /etc/nginx/sites-available/speedhelper /etc/nginx/sites-enabled/speedhelper
rm -f /etc/nginx/sites-enabled/default
nginx -t -q && systemctl reload nginx

ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null

echo "==> HTTPS (Let's Encrypt) — домен должен уже смотреть на IP этого сервера"
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  certbot --nginx -n --agree-tos --register-unsafely-without-email --redirect -d "$DOMAIN" -d "www.$DOMAIN" \
    || certbot --nginx -n --agree-tos --register-unsafely-without-email --redirect -d "$DOMAIN" \
    || echo "!! Сертификат не выпущен: проверьте A-записи домена и запустите: certbot --nginx -d $DOMAIN"
fi

if grep -q '^TG_BOT_TOKEN=$' "$ENV"; then
  echo
  echo "!! Впишите токен бота и Telegram ID владельца в $ENV (nano $ENV), затем: systemctl restart speedhelper"
else
  systemctl restart speedhelper
  sleep 3
  curl -fsS http://127.0.0.1:3000/api/health && echo "  <- сервер работает"
fi
echo "Логи: journalctl -u speedhelper -f"
