-- Предстартовое укрепление безопасности (второй разбор, перед рекламой и ростом трафика):
--  1. фото профиля — только картинка data:image (jpeg/png/webp/svg) до ~75 КБ: раньше туда можно было записать любой текст до 400 КБ,
--     и одна «тяжёлая» аватарка раздувала ответ ленты на десятки мегабайт (её получает каждый, кто видит смену);
--  2. ссылки и @username в имени, компании и названии смены запрещены: эти поля уходят в уведомления бота,
--     а Telegram делает ссылки кликабельными — канал для фишинга от имени нашего бота;
--  3. ключ идемпотентности — до 100 символов (раньше до 64 КБ на запрос: таблица ключей могла забить диск);
--  4. критерии отзыва — не больше 8 пунктов с оценкой 1–5 (раньше значение было произвольным и выводилось на страницу);
--  5. избранное — только существующие пользователи и не больше 500: рассылка «новая смена» не превращается в спам по всей базе;
--  6. смены заблокированного пользователя скрываются из ленты, на них нельзя откликнуться (при разблокировке возвращаются);
--  7. журнал событий: не больше 1000 событий и 100 ошибок в час на пользователя (диск не забить даже в пределах лимитов запросов);
--  8. чат: догрузка новых сообщений — не больше 500 за запрос.

-- ----- проверки -----
create or replace function _avatar_ok(v text) returns boolean language sql immutable as $$
  select v is null or (char_length(v) <= 100000 and v ~ '^data:image/(jpeg|png|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$') $$;

-- ссылка, адрес сайта, ссылка на Telegram или @username
create or replace function _has_link(v text) returns boolean language sql immutable as $$
  select coalesce(v, '') ~* '(https?:|www\.|t\.me|telegram\.(me|dog)|tg:|@[a-z0-9_]{4,}|[a-zа-я0-9-]{2,}\.(ru|рф|su|com|net|org|me|io|info|biz|xyz|top|site|online|link|shop|store|app|pro|cc|club|to|ly|gl)([/:?#]|\s|$))' $$;

create or replace function _key_ok(k text) returns boolean language sql immutable as $$ select k is null or char_length(k) between 1 and 100 $$;

create or replace function _bigint(v text) returns bigint language sql immutable as $$
  select case when v ~ '^\s*\d{1,18}\s*$' then trim(v)::bigint end $$;

-- ----- 1–2. анкеты -----
alter function api_saveWorker(bigint, jsonb) rename to _api_saveworker_core;
create or replace function api_saveWorker(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0;
begin
  if not _avatar_ok(p->>'avatar') then perform _fail('invalid', 'Фото не подходит — выберите другое изображение'); end if;
  if _has_link(p->>'name') then perform _fail('invalid', 'В имени не должно быть ссылок и контактов'); end if;
  return _api_saveworker_core(me, a);
end $$;

alter function api_saveContractor(bigint, jsonb) rename to _api_savecontractor_core;
create or replace function api_saveContractor(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0;
begin
  if not _avatar_ok(p->>'avatar') then perform _fail('invalid', 'Фото не подходит — выберите другое изображение'); end if;
  if _has_link(p->>'name') or _has_link(p->>'company') then perform _fail('invalid', 'В имени и названии компании не должно быть ссылок и контактов'); end if;
  return _api_savecontractor_core(me, a);
end $$;

-- ----- 2–3. публикация смены (проверка номера — как в 017) -----
create or replace function api_createShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  if not _phone_ok(me) then perform _fail('phone_unverified', 'Подтвердите номер телефона через Telegram, чтобы публиковать смены'); end if;
  if not _key_ok(a->>1) then perform _fail('invalid', 'Некорректный запрос — обновите приложение'); end if;
  if _has_link(a->0->>'title') then perform _fail('invalid', 'В названии смены не должно быть ссылок и контактов — их можно указать в описании'); end if;
  return _api_createshift_core(me, a);
end $$;

-- ----- 3. сообщения -----
alter function api_sendMessage(bigint, jsonb) rename to _api_sendmessage_core;
create or replace function api_sendMessage(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  if not _key_ok(a->>2) then perform _fail('invalid', 'Некорректный запрос — обновите приложение'); end if;
  return _api_sendmessage_core(me, a);
end $$;

-- ----- 4. отзыв -----
alter function api_submitReview(bigint, jsonb) rename to _api_submitreview_core;
create or replace function api_submitReview(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare c jsonb := coalesce(a->0->'criteria', '{}');
begin
  -- case — чтобы разбор ключей шёл только для объекта разумного размера
  if (case when jsonb_typeof(c) <> 'object' or length(c::text) > 600 then true
           else (select count(*) from jsonb_object_keys(c)) > 8
             or exists (select 1 from jsonb_each(c) e where char_length(e.key) > 40
                        or not case when jsonb_typeof(e.value) = 'number' then (e.value)::numeric in (1, 2, 3, 4, 5) else false end) end) then
    perform _fail('invalid', 'Некорректные критерии оценки');
  end if;
  return _api_submitreview_core(me, a);
end $$;

-- ----- 5. избранное -----
create or replace function api_toggleFav(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare t bigint := _bigint(a->>0);
begin
  delete from favorites where user_id = me and target_id = t;
  if found then return 'false'; end if;
  if t is null or t = me or not exists (select 1 from users where id = t and deleted_at is null) then perform _fail('not_found', 'Пользователь не найден'); end if;
  if (select count(*) from favorites where user_id = me) >= 500 then perform _fail('limit', 'В избранном уже 500 человек — сначала уберите кого-нибудь'); end if;
  insert into favorites(user_id, target_id) values (me, t) on conflict do nothing;
  return 'true';
end $$;

-- ----- 6. блокировка скрывает смены -----
alter table shifts add column if not exists hidden_by_block boolean not null default false;
alter function api_adminBlock(bigint, jsonb) rename to _api_adminblock_core;
create or replace function api_adminBlock(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare r jsonb := _api_adminblock_core(me, a); uid bigint := (r->>'id')::bigint;
begin
  if (r->>'blocked')::boolean then
    update shifts set hidden = true, hidden_by_block = true where contractor_id = uid and status in ('open','full') and not hidden;
  else
    update shifts set hidden = false, hidden_by_block = false where contractor_id = uid and hidden_by_block;
  end if;
  return r;
end $$;
-- уже заблокированные до этой миграции
update shifts s set hidden = true, hidden_by_block = true from users u
  where u.id = s.contractor_id and u.blocked and s.status in ('open','full') and not s.hidden;

-- ----- 7. журнал событий -----
create index if not exists events_user_time_idx on events (user_id, created_at);
create or replace function api_track(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  -- слишком длинное, пустое или сверх часового лимита событие молча пропускаем: аналитика не должна ломать приложение
  if length(coalesce(a->>0, '')) between 1 and 64 and length(coalesce((a->1)::text, '')) <= 2000
     and (select count(*) from (select 1 from events where user_id = me and created_at > now() - interval '1 hour' limit 1000) x) < 1000 then
    insert into events(user_id, event, props) values (me, a->>0, a->1);
  end if;
  return 'true'::jsonb;
end $$;
create or replace function api_logError(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  if length(coalesce((a->0)::text, '')) <= 6000
     and (select count(*) from (select 1 from events where user_id = me and event = 'error' and created_at > now() - interval '1 hour' limit 100) x) < 100 then
    insert into events(user_id, event, props) values (me, 'error', a->0);
  end if;
  return 'true'::jsonb;
end $$;

-- ----- 8. чат -----
create or replace function api_messages(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _assert_chat(me, a->>0);
  if a->>2 = 'pin' then return (select coalesce(jsonb_agg(_msg_json(m)), '[]') from messages m where m.scope = a->>0 and m.pinned); end if;
  if coalesce((a->>1)::bigint, 0) = 0 then
    return (select coalesce(jsonb_agg(_msg_json(m) order by m.id), '[]') from (select * from messages where scope = a->>0 order by id desc limit 300) m);
  end if;
  return (select coalesce(jsonb_agg(_msg_json(m) order by m.id), '[]') from (select * from messages where scope = a->>0 and id > (a->>1)::bigint order by id limit 500) m);
end $$;

-- новые и переименованные функции закрыты от прямого вызова: приложение ходит только через public.api
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
