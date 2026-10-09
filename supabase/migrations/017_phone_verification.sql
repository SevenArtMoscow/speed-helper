-- Защита от массовой регистрации и подставных подрядчиков:
--  • номер телефона подтверждается через Telegram (человек сам делится контактом с ботом; бот сверяет, что контакт его собственный);
--  • один подтверждённый номер — один аккаунт (уникальный индекс): чтобы завести второй аккаунт, нужна вторая SIM-карта;
--  • публиковать смены может только подрядчик с подтверждённым номером (админы и тестовые пользователи — без проверки);
--  • один Telegram-аккаунт = один аккаунт приложения уже гарантирует users.tg_id unique.
-- Подтверждённый номер хранится отдельно от номера в профиле и другим пользователям не показывается.

alter table users add column if not exists phone_verified text;            -- 10 цифр после +7
alter table users add column if not exists phone_verified_at timestamptz;
create unique index if not exists users_phone_verified_uq on users (phone_verified) where phone_verified is not null;

create or replace function _phone_ok(uid bigint) returns boolean language sql stable as $$
  select exists (select 1 from users u where u.id = uid and (u.phone_verified is not null or u.is_admin or u.is_fake)) $$;

-- Вызывается ботом (не из приложения), когда человек поделился своим контактом.
-- Ответ: ok | taken (номер уже у другого аккаунта) | no_user (ещё не заходил в приложение) | foreign (не российский) | invalid
create or replace function bot_verify_phone(tg bigint, phone text) returns text language plpgsql as $$
declare uid bigint; digits text := regexp_replace(coalesce(phone, ''), '\D', '', 'g'); ph text;
begin
  if length(digits) < 10 then return 'invalid'; end if;
  if not (digits ~ '^[78]\d{10}$') then return 'foreign'; end if;
  ph := right(digits, 10);
  select id into uid from users where tg_id = tg;
  if uid is null then return 'no_user'; end if;
  if exists (select 1 from users where phone_verified = ph and id <> uid) then return 'taken'; end if;
  update users set phone_verified = ph, phone_verified_at = now() where id = uid;
  return 'ok';
end $$;

-- Публикация смены: сначала проверка номера, затем прежняя логика (она переименована, чтобы не дублировать длинную функцию).
alter function api_createShift(bigint, jsonb) rename to _api_createshift_core;
create or replace function api_createShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  if not _phone_ok(me) then perform _fail('phone_unverified', 'Подтвердите номер телефона через Telegram, чтобы публиковать смены'); end if;
  return _api_createshift_core(me, a);
end $$;

create or replace function api_me(me bigint, a jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('id', u.id, 'tg_id', u.tg_id, 'first_name', u.first_name, 'username', u.username, 'roles', to_jsonb(u.roles), 'is_admin', u.is_admin,
    'worker', _worker_json(u.id, true), 'contractor', (select to_jsonb(c) || _contractor_json(u.id) from contractor_profiles c where c.user_id = u.id),
    'unread', (select count(*) from notifications n where n.user_id = u.id and not n.read),
    'unread_worker', (select count(*) from notifications n where n.user_id = u.id and not n.read and coalesce(_nrole(n), 'worker') = 'worker'),
    'unread_contractor', (select count(*) from notifications n where n.user_id = u.id and not n.read and coalesce(_nrole(n), 'contractor') = 'contractor'),
    'phone_verified', _phone_ok(u.id),
    'terms_accepted', u.terms_accepted_at is not null,
    'pro', _is_pro(u.id), 'pro_until', (select (extract(epoch from expires_at) * 1000)::bigint from subscriptions where user_id = u.id and expires_at > now()))
  from users u where u.id = me $$;

-- удаление аккаунта стирает подтверждённый номер (право на удаление данных) и освобождает его для нового аккаунта
create or replace function _users_clear_phone() returns trigger language plpgsql as $$
begin new.phone_verified := null; new.phone_verified_at := null; return new; end $$;
drop trigger if exists users_clear_phone on users;
create trigger users_clear_phone before update on users for each row
  when (new.deleted_at is not null and old.deleted_at is distinct from new.deleted_at) execute function _users_clear_phone();
