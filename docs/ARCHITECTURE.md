# SPEED HELPER — архитектура

## Прод (VPS)
```
Telegram ──► https://speedhelper.ru (nginx, Let's Encrypt) ──► server/server.js (Node, systemd: speedhelper)
               GET  /*          статика мини-приложения
               POST /api/auth   initData → проверка HMAC (токен бота) → upsert users(tg_id) → JWT (sub = users.id, 7 дней)
               POST /api/rpc    {fn,args} + JWT → begin; set_config('request.jwt.claims'); select public.api(fn,args)
                                  ▼
                               PostgreSQL: те же миграции supabase/migrations/* (+ server/migrations/000_roles.sql), применяются при старте
             server/bot.js     long polling: /start, /help, кнопка меню «Открыть»; рассылка notifications (каждые 3 с)
```
Ссылка из уведомления открывает нужный экран: `https://speedhelper.ru/?r=/c/shift/5` → `#/c/shift/5`.
Секреты (`TG_BOT_TOKEN`, `JWT_SECRET`, `DATABASE_URL`) — только в `server/.env` на сервере.

## Вариант с Supabase (не используется в проде)
```
Telegram Mini App (статика: GitHub Pages / Netlify / Cloudflare)
   │  1. initData ──► Edge Function tg-auth: проверка HMAC, upsert users(tg_id), выдача JWT (sub = users.id)
   │  2. все действия ──► POST /rest/v1/rpc/api {fn, args} + JWT
   ▼
PostgreSQL (Supabase): таблицы закрыты RLS без политик; вся логика — в SECURITY DEFINER функциях api_*
   │                      идемпотентность: unique(shift_id, worker_id), idempotency_keys, блокировка строки смены при принятии
   ├── Storage (аватары/документы — приватный бакет, доступ по подписанным ссылкам)  [следующий этап]
   └── Уведомления: таблица notifications → воркер шлёт через Telegram Bot API                [следующий этап]
```

## Что уже есть
- **Фронтенд** (`index.html`, `js/`, `css/`): весь путь по ТЗ — роли, анкеты (+ % заполненности, «Проверенный исполнитель» от 80%), свайпы/список/карта, фильтры (дата, оплата, радиус, категории),
  отклики, «Мои смены», избранное, создание/изменение/отмена/завершение смены, отклики с подтверждением, личный чат, команда смены и общий чат (цвета ролей, закреп, старшие с отдельными правами, явка),
  отзывы (5 звёзд + критерии), уведомления, жалобы, админ-панель, события аналитики, журнал ошибок.
- **Бэкенд** (`supabase/`): схема БД, серверные функции для основной цепочки, проверка initData.
- **Локальный движок** (`js/local-backend.js`): те же правила на localStorage — для разработки без Supabase. Демо-данных нет.

## Серверная часть
Все методы клиента реализованы в `002_api.sql` + `003_api_more.sql` (SQL прогнан на PostgreSQL сквозным тестом: вход, анкеты, смена, отклик, принятие, чаты, завершение, отзыв, админка).
Уведомления: `notifications` → Edge Function `tg-notify` (Bot API). Пользователь получит сообщение, только если хоть раз нажал Start у бота.

## Не сделано вообще (по ТЗ)
Документы исполнителя с выдачей доступа; Speed Score и «Рейтинг месяца»; ИИ-помощник на LLM (сейчас правила в `parseShiftText`); Sentry; бэкапы; нагрузочные тесты; staging-среда.

## Развёртывание Supabase
1. Проект Supabase на аккаунте **владельцев** (ТЗ §45).
2. SQL Editor: выполнить `001_schema.sql`, `002_api.sql`, `003_api_more.sql` по порядку.
3. Secrets: `TG_BOT_TOKEN`, `JWT_SECRET`; `supabase functions deploy tg-auth tg-notify`; для рассылки ещё `APP_URL`, `CRON_SECRET` и pg_cron-задача раз в минуту, вызывающая `tg-notify` с заголовком `x-cron-secret`.
4. В `js/config.js` указать `SUPABASE_URL` и `SUPABASE_ANON_KEY` (публичный).
5. Владельцу: `update users set is_admin = true where tg_id = <его Telegram ID>`.
6. В BotFather задать URL мини-приложения.
