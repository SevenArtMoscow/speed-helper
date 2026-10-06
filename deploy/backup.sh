#!/usr/bin/env bash
# Ежедневная резервная копия БД (cron 03:30). Хранится 14 дней в /var/backups/speedhelper.
# Если в server/.env задан BACKUP_REMOTE (например user@host:/backups/speedhelper), копия дополнительно отправляется туда по rsync/ssh.
# Ручной запуск: speedhelper-backup
set -euo pipefail
DIR=/var/backups/speedhelper
ENV=/opt/speedhelper/server/.env
FILE="$DIR/db-$(date +%F).dump"
mkdir -p "$DIR"; chown postgres "$DIR"

sudo -u postgres pg_dump -Fc speedhelper > "$FILE.tmp"
# проверка, что копия читается (иначе бэкап бесполезен)
if ! sudo -u postgres pg_restore --list "$FILE.tmp" >/dev/null 2>&1; then
  rm -f "$FILE.tmp"; echo "$(date -Is) ОШИБКА: копия БД повреждена" >&2
  exit 1
fi
mv "$FILE.tmp" "$FILE"
find "$DIR" -name '*.dump' -mtime +14 -delete
echo "$(date -Is) копия создана: $FILE ($(du -h "$FILE" | cut -f1))"

REMOTE="$(grep -m1 '^BACKUP_REMOTE=' "$ENV" 2>/dev/null | cut -d= -f2- || true)"
if [ -n "$REMOTE" ]; then
  if rsync -az --delete-after -e "ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15" "$DIR/" "$REMOTE/"; then echo "$(date -Is) копия отправлена в $REMOTE"
  else echo "$(date -Is) ОШИБКА отправки копии в $REMOTE" >&2; exit 1; fi
fi
