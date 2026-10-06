#!/usr/bin/env bash
# Восстановление БД из резервной копии:  speedhelper-restore /var/backups/speedhelper/db-ГГГГ-ММ-ДД.dump
# Перед восстановлением делается страховочная копия текущей БД; сервис на это время останавливается.
set -euo pipefail
FILE="${1:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "Использование: speedhelper-restore <файл.dump>"; echo "Доступные копии:"; ls -1t /var/backups/speedhelper/*.dump 2>/dev/null | head -10; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Запустите от root"; exit 1; }
sudo -u postgres pg_restore --list "$FILE" >/dev/null || { echo "Файл не является корректной копией PostgreSQL"; exit 1; }

echo "Будет восстановлена БД из: $FILE"
echo "Все данные, добавленные после создания этой копии, будут потеряны."
read -r -p "Введите ВОССТАНОВИТЬ для продолжения: " ans
[ "$ans" = "ВОССТАНОВИТЬ" ] || { echo "Отменено"; exit 1; }

SAFE="/var/backups/speedhelper/before-restore-$(date +%F-%H%M).dump"
systemctl stop speedhelper
sudo -u postgres pg_dump -Fc speedhelper > "$SAFE" && echo "Страховочная копия: $SAFE"
sudo -u postgres pg_restore --clean --if-exists --no-owner --no-privileges -d speedhelper < "$FILE" || true
sudo -u postgres psql -qd speedhelper -c "grant all on all tables in schema public to speedhelper; grant all on all sequences in schema public to speedhelper;" >/dev/null 2>&1 || true
systemctl start speedhelper
sleep 4
curl -fsS http://127.0.0.1:3000/api/health && echo "  <- сервис работает, база восстановлена"
