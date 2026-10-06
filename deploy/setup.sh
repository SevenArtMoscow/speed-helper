#!/usr/bin/env bash
# Установка и обновление SPEED HELPER на Ubuntu 22.04/24.04 (Timeweb Cloud). Запуск от root:
#   curl -fsSL https://raw.githubusercontent.com/SevenArtMoscow/speed-helper/main/deploy/setup.sh -o setup.sh && TG_BOT_TOKEN=<токен> ADMIN_TG_IDS=<id,id> bash setup.sh
# Повторный запуск безопасен: обновляет код, настройки сервера и nginx, перезапускает сервис; данные и server/.env не трогает.
set -euo pipefail

DOMAIN="${DOMAIN:-speedhelper.ru}"
REPO="${REPO:-https://github.com/SevenArtMoscow/speed-helper.git}"
BRANCH="${BRANCH:-main}"
DIR=/opt/speedhelper
ENV="$DIR/server/.env"
export DEBIAN_FRONTEND=noninteractive
[ "$(id -u)" -eq 0 ] || { echo "Запустите от root"; exit 1; }

echo "==> Пакеты"
apt-get update -q
apt-get install -yq curl git nginx postgresql certbot python3-certbot-nginx ufw fail2ban unattended-upgrades cron
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

echo "==> Пользователь и код"
id speedhelper >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin speedhelper
# папка принадлежит пользователю speedhelper — root-у git без safe.directory откажет («dubious ownership»)
if [ -d "$DIR/.git" ]; then git -c safe.directory="$DIR" -C "$DIR" fetch -q origin "$BRANCH"; git -c safe.directory="$DIR" -C "$DIR" reset -q --hard "origin/$BRANCH"
else git clone -q -b "$BRANCH" "$REPO" "$DIR"; fi
echo "    версия: $(git -c safe.directory="$DIR" -C "$DIR" log --oneline -1)"
(cd "$DIR/server" && (npm ci --omit=dev --silent 2>/dev/null || npm install --omit=dev --silent))

echo "==> Настройки (server/.env)"
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
# параметры, добавленные позже: дописываем пустыми, если их ещё нет
add_env() { grep -q "^$1=" "$ENV" || printf '%s=%s\n' "$1" "$2" >> "$ENV"; }
add_env OPERATOR_NAME ""     # оператор персональных данных — показывается в политике и соглашении
add_env OPERATOR_CONTACT ""  # контакт для обращений по данным (e-mail или @username)
add_env SUPPORT_URL ""       # ссылка на поддержку, например https://t.me/ваш_аккаунт
add_env BACKUP_REMOTE ""     # куда копировать бэкапы БД (rsync), например user@host:/backups/speedhelper
chmod 600 "$ENV"; chown -R speedhelper:speedhelper "$DIR"

echo "==> Своп и сеть"
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -qw vm.swappiness=10 || true; echo 'vm.swappiness=10' > /etc/sysctl.d/99-speedhelper.conf

echo "==> PostgreSQL (настройка под объём памяти)"
PGV="$(ls /etc/postgresql | sort -V | tail -1)"
MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
SB=$(( MEM_MB / 4 )); [ "$SB" -gt 2048 ] && SB=2048; [ "$SB" -lt 128 ] && SB=128
PGCONF="/etc/postgresql/$PGV/main/conf.d/speedhelper.conf"; mkdir -p "$(dirname "$PGCONF")"
cat > "$PGCONF.new" <<EOF
shared_buffers = ${SB}MB
effective_cache_size = $(( MEM_MB / 2 ))MB
work_mem = 8MB
maintenance_work_mem = 128MB
max_connections = 60
log_min_duration_statement = 500
log_checkpoints = on
EOF
if ! cmp -s "$PGCONF.new" "$PGCONF" 2>/dev/null; then mv "$PGCONF.new" "$PGCONF"; systemctl restart postgresql; else rm -f "$PGCONF.new"; fi

echo "==> Защита сервера (fail2ban, автообновления безопасности, журналы)"
cat > /etc/fail2ban/jail.d/speedhelper.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable -q --now fail2ban && systemctl restart fail2ban
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
mkdir -p /etc/systemd/journald.conf.d && printf '[Journal]\nSystemMaxUse=500M\nMaxRetentionSec=1month\n' > /etc/systemd/journald.conf.d/speedhelper.conf && systemctl restart systemd-journald

echo "==> Резервные копии БД, мониторинг"
install -m 755 "$DIR/deploy/backup.sh" /usr/local/bin/speedhelper-backup
install -m 755 "$DIR/deploy/healthcheck.sh" /usr/local/bin/speedhelper-health
install -m 755 "$DIR/deploy/restore.sh" /usr/local/bin/speedhelper-restore
mkdir -p /var/backups/speedhelper && chown postgres /var/backups/speedhelper
rm -f /etc/cron.d/speedhelper-backup
printf '30 3 * * * root /usr/local/bin/speedhelper-backup >> /var/log/speedhelper-backup.log 2>&1\n' > /etc/cron.d/speedhelper-backup
printf '* * * * * root /usr/local/bin/speedhelper-health >> /var/log/speedhelper-health.log 2>&1\n' > /etc/cron.d/speedhelper-health
printf '/var/log/speedhelper-*.log {\n  weekly\n  rotate 4\n  compress\n  missingok\n  notifempty\n}\n' > /etc/logrotate.d/speedhelper

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
Environment=NODE_OPTIONS=--max-old-space-size=1536
LimitNOFILE=65535
MemoryMax=3G
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q speedhelper

echo "==> nginx"
cat > /etc/nginx/conf.d/speedhelper.conf <<'EOF'
# общие настройки SPEED HELPER (создаёт deploy/setup.sh)
server_tokens off;
limit_req_zone $binary_remote_addr zone=speedhelper_api:10m rate=30r/s;
EOF
PROXY='    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 35s;'
GZIP='  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml text/html;
  gzip_min_length 512;'
CERT="/etc/letsencrypt/live/$DOMAIN"
if [ -f "$CERT/fullchain.pem" ]; then
  # сертификат уже выпущен — пишем сразу полный HTTPS-конфиг (при обновлении сайт не остаётся без HTTPS)
  SSLINC=""
  [ -f /etc/letsencrypt/options-ssl-nginx.conf ] && SSLINC="  include /etc/letsencrypt/options-ssl-nginx.conf;"
  [ -f /etc/letsencrypt/ssl-dhparams.pem ] && SSLINC="$SSLINC
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
  cat > /etc/nginx/sites-available/speedhelper <<EOF
# создаёт deploy/setup.sh — ручные правки будут перезаписаны при обновлении
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN www.$DOMAIN;
  location / { return 301 https://$DOMAIN\$request_uri; }
}
server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name www.$DOMAIN;
  ssl_certificate $CERT/fullchain.pem;
  ssl_certificate_key $CERT/privkey.pem;
$SSLINC
  return 301 https://$DOMAIN\$request_uri;
}
server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name $DOMAIN;
  ssl_certificate $CERT/fullchain.pem;
  ssl_certificate_key $CERT/privkey.pem;
$SSLINC
  add_header Strict-Transport-Security "max-age=31536000" always;
  client_max_body_size 4m;
$GZIP
  location /api/ {
    limit_req zone=speedhelper_api burst=60 nodelay;
    limit_req_status 429;
$PROXY
  }
  location / {
$PROXY
  }
}
EOF
else
  cat > /etc/nginx/sites-available/speedhelper <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN www.$DOMAIN;
  client_max_body_size 4m;
$GZIP
  location / {
$PROXY
  }
}
EOF
fi
ln -sf /etc/nginx/sites-available/speedhelper /etc/nginx/sites-enabled/speedhelper
rm -f /etc/nginx/sites-enabled/default
nginx -t -q && systemctl reload nginx

ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null

echo "==> HTTPS (Let's Encrypt) — домен должен уже смотреть на IP этого сервера"
if [ ! -f "$CERT/fullchain.pem" ]; then
  certbot --nginx -n --agree-tos --register-unsafely-without-email --redirect -d "$DOMAIN" -d "www.$DOMAIN" \
    || certbot --nginx -n --agree-tos --register-unsafely-without-email --redirect -d "$DOMAIN" \
    || echo "!! Сертификат не выпущен: проверьте A-записи домена и запустите: certbot --nginx -d $DOMAIN"
else
  echo "    сертификат на месте, продлевается автоматически"
fi

if grep -q '^TG_BOT_TOKEN=$' "$ENV"; then
  echo
  echo "!! Впишите токен бота и Telegram ID владельцев в $ENV (nano $ENV), затем: systemctl restart speedhelper"
else
  systemctl restart speedhelper
  sleep 4
  curl -fsS http://127.0.0.1:3000/api/health && echo "  <- сервер работает"
fi
echo
for k in OPERATOR_NAME OPERATOR_CONTACT; do
  grep -q "^$k=.\+" "$ENV" || echo "!! Не заполнено $k в $ENV — без этого в политике конфиденциальности останется пометка «укажите оператора»"
done
echo "Логи: journalctl -u speedhelper -f   |   Бэкап вручную: speedhelper-backup   |   Восстановление: speedhelper-restore <файл.dump>"
