#!/usr/bin/env bash
# Мониторинг (cron, раз в минуту): проверяет сервис, при двух сбоях подряд перезапускает его и пишет админам в Telegram.
# Раз в сутки предупреждает о нехватке диска и о скором окончании сертификата.
ENV=/opt/speedhelper/server/.env
STATE=/run/speedhelper-health
get() { grep -m1 "^$1=" "$ENV" 2>/dev/null | cut -d= -f2-; }
TOKEN="$(get TG_BOT_TOKEN)"; ADMINS="$(get ADMIN_TG_IDS)"; DOMAIN="$(get APP_URL | sed 's#https\?://##')"
notify() { [ -n "$TOKEN" ] || return 0; for id in ${ADMINS//,/ }; do curl -s -m 10 "https://api.telegram.org/bot$TOKEN/sendMessage" --data-urlencode "chat_id=$id" --data-urlencode "text=$1" >/dev/null || true; done; }
# не чаще раза в сутки на один вид предупреждения
daily() { local f="/var/tmp/speedhelper-warn-$1"; if [ -z "$(find "$f" -mmin -1440 2>/dev/null)" ]; then touch "$f"; return 0; fi; return 1; }

if curl -fsS -m 8 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  if [ -f "$STATE.down" ]; then rm -f "$STATE.down"; notify "✅ SPEED HELPER снова работает"; fi
  rm -f "$STATE.fail"
else
  n=$(( $(cat "$STATE.fail" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STATE.fail"
  if [ "$n" -ge 2 ]; then
    systemctl restart speedhelper
    echo "$(date -Is) сервис не отвечал, перезапущен"
    if [ ! -f "$STATE.down" ]; then touch "$STATE.down"; notify "🛑 SPEED HELPER не отвечал — сервис перезапущен. Если сообщение повторится: journalctl -u speedhelper -n 80"; fi
    rm -f "$STATE.fail"
  fi
fi

use="$(df --output=pcent / | tail -1 | tr -dc 0-9)"
if [ "${use:-0}" -ge 85 ] && daily disk; then notify "⚠️ Диск сервера заполнен на ${use}%. Проверьте /var/backups/speedhelper и журналы."; fi
if [ -n "$DOMAIN" ] && [ -f "/etc/letsencrypt/live/$DOMAIN/cert.pem" ]; then
  end="$(date -d "$(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$DOMAIN/cert.pem" | cut -d= -f2)" +%s)"
  days=$(( (end - $(date +%s)) / 86400 ))
  if [ "$days" -le 14 ] && daily cert; then notify "⚠️ Сертификат HTTPS заканчивается через ${days} дн. Проверьте: certbot renew --dry-run"; fi
fi
if [ -f /var/run/reboot-required ] && daily reboot; then notify "ℹ️ Серверу нужна перезагрузка после обновлений безопасности (reboot)."; fi
