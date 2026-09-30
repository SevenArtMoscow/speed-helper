# SPEED HELPER — архитектура (первичная)

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

## Что серверная часть ещё не делает (в SQL нет, работает только локальный движок)
`withdraw, toggleFav, favorites, favIds, contractorPage, workerPage, contractorStats, updateShift, team, myTeams, setSenior, removeMember, setAttendance, pinMessage, dmInfo, myDialogs, pendingReviews, admin*`.
Диспетчер `public.api` возвращает `not_implemented` для них. Порядок: contractorStats/updateShift/team → избранное → админка → документы.

## Не сделано вообще (по ТЗ)
Документы исполнителя с выдачей доступа; Speed Score и «Рейтинг месяца»; ИИ-помощник на LLM (сейчас правила в `parseShiftText`);
отправка уведомлений в Telegram (воркер); Sentry; бэкапы; нагрузочные тесты; staging-среда.

## Развёртывание Supabase
1. Проект Supabase на аккаунте **владельцев** (ТЗ §45).
2. SQL Editor: выполнить `001_schema.sql`, затем `002_api.sql`.
3. Secrets: `TG_BOT_TOKEN`, `JWT_SECRET`; `supabase functions deploy tg-auth`.
4. В `js/config.js` указать `SUPABASE_URL` и `SUPABASE_ANON_KEY` (публичный).
5. Владельцу: `update users set is_admin = true where tg_id = <его Telegram ID>`.
6. В BotFather задать URL мини-приложения.
