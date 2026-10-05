# SPEED HELPER

Telegram Mini App для поиска краткосрочных смен и исполнителей. Техническое задание v1.0.

- **Прод:** один VPS (Timeweb Cloud, Ubuntu): `server/` — Node.js (мини-апп + API + Telegram-бот) и PostgreSQL. Установка — [deploy/setup.sh](deploy/setup.sh), см. ниже.
- Локально без сервера: `python3 -m http.server 8765` → http://localhost:8765 (данные в localStorage). Каждая вкладка = отдельный пользователь; Telegram ID 1 = админ.
- Карты и адреса — бесплатно ([js/maps.js](js/maps.js)): карта OpenFreeMap через MapLibre GL (без ключа), подсказки и проверка адресов — «Подсказки» DaData: ключ `DADATA_KEY` в [js/config.js](js/config.js) (API-ключ из кабинета https://dadata.ru, бесплатно ~10 000 запросов в день). Без ключа подрядчик ставит точку на карте вручную.
- Архитектура: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). `legacy/` — прежний прототип v5.8.

## Развёртывание на VPS
1. DNS: A-записи `speedhelper.ru` и `www` → IP сервера.
2. На сервере от root:
   ```
   curl -fsSL https://raw.githubusercontent.com/SevenArtMoscow/speed-helper/main/deploy/setup.sh -o setup.sh
   TG_BOT_TOKEN=<токен> ADMIN_TG_IDS=<ваш Telegram ID> bash setup.sh
   ```
   Скрипт ставит PostgreSQL, Node 22, nginx, HTTPS (Let's Encrypt), сервис `speedhelper`, ежедневные бэкапы БД в `/var/backups/speedhelper`.
3. В @BotFather: `/mybots → Bot Settings → Configure Mini App → Enable` → URL `https://speedhelper.ru` (кнопку меню сервер ставит сам).
4. Обновление кода: `bash setup.sh` ещё раз (данные и `.env` сохраняются). Логи: `journalctl -u speedhelper -f`.
