-- Чаты по откликам, служба поддержки, подтверждение номера кодом.
--  1. Личный чат с подрядчиком появляется сразу после отклика (статус «Ожидание») — до первого сообщения и до решения подрядчика.
--  2. Отказ от смены (отзыв отклика, отклонение, исключение из команды, отмена смены) отправляет чат в архив: переписка сохраняется
--     и читается, но писать в такой чат нельзя. Отозванный отклик с перепиской не удаляется, а остаётся отменённым (withdrawn) —
--     при повторном отклике на ту же смену он оживает вместе с чатом.
--  3. Служба поддержки внутри приложения: чат support:<id пользователя>. Сотрудники поддержки (users.is_support, задаются SUPPORT_TG_IDS)
--     отвечают в приложении или прямо в Telegram ответом на сообщение бота (бот пересылает обращения, см. server/bot.js).
--  4. Подтверждение номера кодом (SMS или Telegram Gateway): код создаёт и отправляет сервер, здесь — хранение хеша, лимиты, проверка.
--     У исполнителя в карточке видно, что указанный телефон подтверждён.

alter table applications add column if not exists withdrawn boolean not null default false;
alter table users add column if not exists is_support boolean not null default false;
-- сообщения пользователей в поддержку, ещё не пересланные сотрудникам в Telegram (у остальных сообщений — true)
alter table messages add column if not exists support_fwd boolean not null default true;
create index if not exists messages_support_fwd_idx on messages (id) where not support_fwd;

create or replace function _is_support(uid bigint) returns boolean language sql stable as $$
  select coalesce((select is_support from users where id = uid), false) $$;

-- ===== 1–2. отклик, отзыв, архив =====
create or replace function api_apply(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare s shifts; ex applications; n applications; wname text;
begin
  select name into wname from worker_profiles where user_id = me;
  if wname is null then perform _fail('profile_required', 'Сначала заполните профиль исполнителя'); end if;
  select * into s from shifts where id = (a->>0)::bigint for share; if not found then perform _fail('not_found', 'Смена не найдена'); end if;
  select * into ex from applications where shift_id = s.id and worker_id = me;
  -- сам отозванный отклик можно подать заново (чат оживает); остальные — как раньше, повтор возвращает существующий
  if found and not (ex.status = 'cancelled' and ex.withdrawn) then return to_jsonb(ex) || '{"duplicate":true}'; end if;
  if s.contractor_id = me then perform _fail('own_shift', 'Нельзя откликнуться на свою смену'); end if;
  if s.status <> 'open' or s.hidden then perform _fail('closed', 'Смена уже закрыта'); end if;
  if _shift_ended(s) then perform _fail('closed', 'Время смены уже прошло'); end if;
  if ex.id is not null then
    update applications set status = 'pending', withdrawn = false, created_at = now(), updated_at = now() where id = ex.id returning * into n;
  else
    insert into applications(shift_id, worker_id) values (s.id, me) on conflict (shift_id, worker_id) do nothing returning * into n;
    if n.id is null then select * into n from applications where shift_id = s.id and worker_id = me; return to_jsonb(n) || '{"duplicate":true}'; end if;
  end if;
  perform _notify(s.contractor_id, 'new_application', format('Новый отклик: %s — «%s»', wname, s.title), '#/c/shift/' || s.id);
  insert into notifications(user_id, type, text, link)
    select m.user_id, 'new_application', format('Новый отклик: %s — «%s»', wname, s.title), '#/c/shift/' || s.id
    from shift_members m where m.shift_id = s.id and m.role = 'senior' and 'applications' = any(m.perms) and m.user_id <> me;
  delete from skips where user_id = me and shift_id = s.id;
  delete from shift_favs where user_id = me and shift_id = s.id;
  return to_jsonb(n);
end $$;

-- отклик в ожидании: без переписки — удаляется (как раньше), с перепиской — становится отменённым, чат уходит в архив
create or replace function _drop_pending(ap applications) returns boolean language plpgsql as $$
begin
  if exists (select 1 from messages where scope = 'dm:' || ap.id) then
    update applications set status = 'cancelled', withdrawn = true, updated_at = now() where id = ap.id;
    return false;
  end if;
  delete from applications where id = ap.id;
  return true;
end $$;

create or replace function api_withdraw(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare ap applications; s shifts;
begin
  select * into ap from applications where id = (a->>0)::bigint and worker_id = me; if not found then perform _fail('not_found', 'Не найдено'); end if;
  select * into s from shifts where id = ap.shift_id for update;
  if ap.status = 'pending' then
    if _drop_pending(ap) then return '{"removed":true}'; end if;
    select * into ap from applications where id = ap.id;
    return to_jsonb(ap) || '{"archived":true}';
  end if;
  if ap.status = 'accepted' then
    update applications set status = 'cancelled', updated_at = now() where id = ap.id returning * into ap;
    delete from shift_members where shift_id = s.id and user_id = me;
    if s.status = 'full' then update shifts set status = 'open' where id = s.id; end if;
    perform _notify(s.contractor_id, 'member_left', format('%s отказался от смены «%s»', (select name from worker_profiles where user_id = me), s.title), '#/c/shift/' || s.id);
  end if;
  return to_jsonb(ap);
end $$;

create or replace function api_undoApply(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare ap applications; s shifts;
begin
  select * into ap from applications where shift_id = (a->>0)::bigint and worker_id = me and status = 'pending';
  if not found then return 'false'; end if;
  perform _drop_pending(ap);
  select * into s from shifts where id = ap.shift_id;
  delete from notifications where user_id = s.contractor_id and type = 'new_application' and not read and link = '#/c/shift/' || s.id
    and text = format('Новый отклик: %s — «%s»', (select name from worker_profiles where user_id = me), s.title);
  return 'true';
end $$;

-- чат в архиве: отклик отозван/отклонён/отменён или смена завершена/отменена
create or replace function _dm_archived(ap applications, s shifts) returns boolean language sql stable as $$
  select ap.status in ('rejected', 'cancelled') or s.status in ('completed', 'cancelled') $$;

-- личные чаты: отклики «в ожидании» и «принятые» видны сразу (даже без сообщений), остальные — если была переписка (в архиве)
create or replace function api_myDialogs(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(d.j order by d.t desc), '[]') from (
    select jsonb_build_object('app_id', x.id, 'last', case when l.id is null then null else _msg_json(l) end, 'info', api_dmInfo(me, jsonb_build_array(x.id)),
        'archived', _dm_archived(x, s),
        'unread', exists (select 1 from notifications n where n.user_id = me and not n.read and n.type = 'message' and n.link = '#/chat/' || x.id)) as j,
      coalesce(l.created_at, x.updated_at) as t
    from applications x join shifts s on s.id = x.shift_id
    left join lateral (select * from messages m where m.scope = 'dm:' || x.id order by m.id desc limit 1) l on true
    where case a->>0 when 'contractor' then s.contractor_id = me when 'worker' then x.worker_id = me else (x.worker_id = me or s.contractor_id = me) end
      and (l.id is not null or x.status in ('pending', 'accepted'))
    order by coalesce(l.created_at, x.updated_at) desc limit 300) d $$;

-- ===== 3. поддержка: доступ к чату, вид сообщений =====
create or replace function _assert_chat(me bigint, scope text) returns void language plpgsql stable as $$
declare ap applications; uid bigint;
begin
  if scope like 'shift:%' then
    if not exists (select 1 from shift_members where shift_id = substr(scope, 7)::bigint and user_id = me) then perform _fail('forbidden', 'Вы не в команде смены'); end if;
  elsif scope like 'dm:%' then
    select * into ap from applications where id = substr(scope, 4)::bigint;
    if not found then perform _fail('not_found', 'Не найдено'); end if;
    if me <> ap.worker_id and me <> (select contractor_id from shifts where id = ap.shift_id) then perform _fail('forbidden', 'Нет доступа'); end if;
  elsif scope like 'support:%' then
    -- свой чат с поддержкой; сотрудник поддержки видит любые обращения
    uid := _bigint(substr(scope, 9));
    if uid is null then perform _fail('invalid', 'Некорректный чат'); end if;
    if uid <> me and not _is_support(me) then perform _fail('forbidden', 'Нет доступа'); end if;
  else perform _fail('invalid', 'Некорректный чат'); end if;
end $$;

create or replace function _msg_json(m messages) returns jsonb language sql stable as $$
  select case when m.scope like 'support:%' then
    to_jsonb(m) - 'support_fwd' || jsonb_build_object('at', (extract(epoch from m.created_at) * 1000)::bigint,
      'name', case when m.user_id = _bigint(substr(m.scope, 9))
                   then coalesce((select w.name from worker_profiles w where w.user_id = m.user_id), (select c.name from contractor_profiles c where c.user_id = m.user_id), (select u.first_name from users u where u.id = m.user_id), 'Пользователь')
                   else 'Поддержка SPEED HELPER' end,
      'role', case when m.user_id = _bigint(substr(m.scope, 9)) then 'user' else 'support' end)
  else
    to_jsonb(m) - 'support_fwd' || jsonb_build_object('at', (extract(epoch from m.created_at) * 1000)::bigint,
    'name', coalesce((select c.name from contractor_profiles c where c.user_id = m.user_id and (m.scope like 'dm:%' and m.user_id = (select s.contractor_id from applications x join shifts s on s.id = x.shift_id where x.id = substr(m.scope,4)::bigint) or m.scope like 'shift:%' and exists (select 1 from shift_members sm where sm.shift_id = substr(m.scope,7)::bigint and sm.user_id = m.user_id and sm.role = 'owner'))),
                     (select w.name from worker_profiles w where w.user_id = m.user_id), 'Пользователь'),
    'role', case when m.scope like 'shift:%' then coalesce((select sm.role from shift_members sm where sm.shift_id = substr(m.scope,7)::bigint and sm.user_id = m.user_id), 'worker')
                 else case when m.user_id = (select s.contractor_id from applications x join shifts s on s.id = x.shift_id where x.id = substr(m.scope,4)::bigint) then 'owner' else 'worker' end end)
  end $$;

-- сообщение в поддержку (от пользователя) или ответ поддержки (от сотрудника)
create or replace function _support_send(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare sc text := a->>0; uid bigint := _bigint(substr(a->>0, 9)); t text := trim(coalesce(a->>1, '')); k text := a->>2; r jsonb; m messages;
begin
  perform _assert_chat(me, sc);
  if t = '' or length(t) > 2000 then perform _fail('invalid', 'Некорректное сообщение'); end if;
  if k is not null then select result into r from idempotency_keys where user_id = me and key = k; if found then return r; end if; end if;
  if uid <> me then
    -- ответ поддержки: пользователь получает уведомление в приложении и сообщение от бота
    insert into messages(scope, user_id, text) values (sc, me, t) returning * into m;
    perform _notify(uid, 'support', 'Ответ поддержки: ' || left(t, 300), '#/support');
  else
    if (select count(*) from (select 1 from messages where scope = sc and user_id = me and created_at > now() - interval '1 hour' limit 30) x) >= 30 then
      perform _fail('limit', 'Слишком много сообщений подряд — мы уже получили ваше обращение и скоро ответим');
    end if;
    insert into messages(scope, user_id, text, support_fwd) values (sc, me, t, false) returning * into m;   -- бот перешлёт сотрудникам поддержки
  end if;
  r := _msg_json(m);
  if k is not null then insert into idempotency_keys(user_id, key, result) values (me, k, r) on conflict do nothing; end if;
  return r;
end $$;

-- отправка сообщения: поддержка — отдельно; в архивный личный чат писать нельзя
create or replace function api_sendMessage(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare sc text := coalesce(a->>0, ''); ap applications; s shifts;
begin
  if not _key_ok(a->>2) then perform _fail('invalid', 'Некорректный запрос — обновите приложение'); end if;
  if sc like 'support:%' then return _support_send(me, a); end if;
  if sc like 'dm:%' then
    select * into ap from applications where id = _bigint(substr(sc, 4));
    if found then
      select * into s from shifts where id = ap.shift_id;
      if (me = ap.worker_id or me = s.contractor_id) and (ap.status in ('rejected', 'cancelled') or s.status = 'cancelled') then
        perform _fail('closed', 'Чат в архиве: отклик отменён или отклонён. Переписку можно читать, но писать в неё нельзя');
      end if;
    end if;
  end if;
  return _api_sendmessage_core(me, a);
end $$;

-- обращения для сотрудника поддержки: последние диалоги, «ждёт ответа» — если последнее сообщение от пользователя
create or replace function api_supportInbox(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin
  if not _is_support(me) then perform _fail('forbidden', 'Нет доступа'); end if;
  return coalesce((select jsonb_agg(x.j order by x.lid desc) from (
    select l.id as lid, jsonb_build_object('user_id', u.id, 'username', u.username,
        'name', coalesce((select name from worker_profiles where user_id = u.id), (select name from contractor_profiles where user_id = u.id), u.first_name, 'Пользователь'),
        'avatar', coalesce((select avatar from worker_profiles where user_id = u.id), (select avatar from contractor_profiles where user_id = u.id)),
        'roles', to_jsonb(u.roles), 'last', jsonb_build_object('text', l.text, 'at', (extract(epoch from l.created_at) * 1000)::bigint, 'mine', l.user_id <> u.id),
        'waiting', l.user_id = u.id) as j
    from (select distinct on (scope) * from messages where scope like 'support:%' order by scope, id desc) l
    join users u on u.id = _bigint(substr(l.scope, 9))
    order by l.id desc limit 200) x), '[]');
end $$;

-- ответ сотрудника из Telegram (вызывает бот, только для SUPPORT_TG_IDS): ok | no_user | invalid
create or replace function bot_support_reply(agent_tg bigint, agent_name text, uid bigint, t text) returns text language plpgsql as $$
declare aid bigint;
begin
  t := trim(coalesce(t, ''));
  if t = '' or length(t) > 2000 then return 'invalid'; end if;
  if not exists (select 1 from users where id = uid and deleted_at is null) then return 'no_user'; end if;
  insert into users(tg_id, first_name, is_support) values (agent_tg, left(coalesce(agent_name, ''), 64), true)
    on conflict (tg_id) do update set is_support = true returning id into aid;
  insert into messages(scope, user_id, text) values ('support:' || uid, aid, t);
  perform _notify(uid, 'support', 'Ответ поддержки: ' || left(t, 300), '#/support');
  return 'ok';
end $$;

-- ===== 4. подтверждение номера кодом =====
create table if not exists phone_codes (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  phone text not null,                                   -- 10 цифр после +7
  salt text not null, code_hash text not null,           -- sha256(salt || код): сам код в базе не хранится
  attempts int not null default 0, used boolean not null default false,
  created_at timestamptz not null default now(), expires_at timestamptz not null);
create index if not exists phone_codes_user_idx on phone_codes (user_id, created_at);
create index if not exists phone_codes_phone_idx on phone_codes (phone, created_at);
create index if not exists phone_codes_time_idx on phone_codes (created_at);
alter table phone_codes enable row level security;
revoke all on phone_codes from anon, authenticated;

-- номер подтверждён (кодом или контактом в Telegram); пустой телефон в анкете исполнителя заполняется подтверждённым
create or replace function _set_phone_verified(uid bigint, ph text, via text) returns void language plpgsql as $$
begin
  update users set phone_verified = ph, phone_verified_at = now() where id = uid;
  update worker_profiles set phone = '+7' || ph where user_id = uid and coalesce(phone, '') = '';
  insert into audit_log(actor, action, meta) values (uid, 'phone.verify', jsonb_build_object('via', via));
end $$;

-- выдача кода (вызывает сервер, код генерирует он же): проверки и лимиты. Ответ: {phone}
create or replace function phone_code_issue(me bigint, raw text, s text, h text) returns jsonb language plpgsql as $$
declare d text := regexp_replace(coalesce(raw, ''), '\D', '', 'g'); prev timestamptz;
begin
  if not exists (select 1 from users where id = me and not blocked) then perform _fail('unauthorized', 'Нужно войти'); end if;
  if d ~ '^[78]\d{10}$' then d := right(d, 10); end if;
  if d !~ '^9\d{9}$' then perform _fail('invalid', 'Укажите мобильный номер России: +7 9XX XXX-XX-XX'); end if;
  if exists (select 1 from users where phone_verified = d and id <> me) then perform _fail('taken', 'Этот номер уже подтверждён в другом аккаунте. Один номер — один аккаунт'); end if;
  if exists (select 1 from users where id = me and phone_verified = d) then perform _fail('conflict', 'Этот номер уже подтверждён'); end if;
  select max(created_at) into prev from phone_codes where user_id = me;
  if prev > now() - interval '60 seconds' then
    perform _fail('rate', format('Новый код можно запросить через %s с', greatest(1, ceil(60 - extract(epoch from now() - prev))::int)));
  end if;
  if (select count(*) from phone_codes where user_id = me and created_at > now() - interval '1 day') >= 5 then
    perform _fail('limit', 'Слишком много кодов за сутки — попробуйте завтра или подтвердите номер через Telegram'); end if;
  if (select count(*) from phone_codes where phone = d and created_at > now() - interval '1 day') >= 5 then
    perform _fail('limit', 'На этот номер уже отправлено много кодов — попробуйте завтра'); end if;
  -- общий потолок: защита от «накрутки» платных SMS
  if (select count(*) from phone_codes where created_at > now() - interval '1 hour') >= 300 then
    perform _fail('limit', 'Сервис подтверждения сейчас перегружен — попробуйте позже или подтвердите номер через Telegram'); end if;
  update phone_codes set used = true where user_id = me and not used;   -- прежние коды больше не действуют
  insert into phone_codes(user_id, phone, salt, code_hash, expires_at) values (me, d, s, h, now() + interval '10 minutes');
  return jsonb_build_object('phone', d);
end $$;

-- проверка кода. Неверный код — не исключение, а ответ {ok:false}: иначе откат транзакции стёр бы счётчик попыток
create or replace function api_phoneVerifyCode(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare c phone_codes; code text := regexp_replace(coalesce(a->>0, ''), '\D', '', 'g');
begin
  select * into c from phone_codes where user_id = me and not used order by id desc limit 1 for update;
  if not found or c.expires_at < now() then perform _fail('expired', 'Код устарел или не запрашивался — запросите новый'); end if;
  if encode(sha256(convert_to(c.salt || code, 'UTF8')), 'hex') <> c.code_hash then
    update phone_codes set attempts = attempts + 1, used = attempts + 1 >= 5 where id = c.id;
    return jsonb_build_object('ok', false, 'left', greatest(0, 4 - c.attempts),
      'message', case when c.attempts + 1 >= 5 then 'Неверный код. Попытки закончились — запросите новый код' else format('Неверный код. Осталось попыток: %s', 4 - c.attempts) end);
  end if;
  if exists (select 1 from users where phone_verified = c.phone and id <> me) then perform _fail('taken', 'Этот номер уже подтверждён в другом аккаунте'); end if;
  update phone_codes set used = true where id = c.id;
  perform _set_phone_verified(me, c.phone, 'code');
  return jsonb_build_object('ok', true, 'phone', c.phone);
end $$;

-- подтверждение контактом в Telegram (бот): то же, что раньше, плюс общая функция подтверждения
create or replace function bot_verify_phone(tg bigint, phone text) returns text language plpgsql as $$
declare uid bigint; digits text := regexp_replace(coalesce(phone, ''), '\D', '', 'g'); ph text;
begin
  if length(digits) < 10 then return 'invalid'; end if;
  if not (digits ~ '^[78]\d{10}$') then return 'foreign'; end if;
  ph := right(digits, 10);
  select id into uid from users where tg_id = tg;
  if uid is null then return 'no_user'; end if;
  if exists (select 1 from users where phone_verified = ph and id <> uid) then return 'taken'; end if;
  perform _set_phone_verified(uid, ph, 'telegram');
  return 'ok';
end $$;

-- удаление аккаунта стирает и коды подтверждения (в них номер)
create or replace function _users_clear_phone() returns trigger language plpgsql as $$
begin new.phone_verified := null; new.phone_verified_at := null; delete from phone_codes where user_id = new.id; return new; end $$;

-- ===== профиль: подтверждённый номер, роль поддержки =====
create or replace function api_me(me bigint, a jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('id', u.id, 'tg_id', u.tg_id, 'first_name', u.first_name, 'username', u.username, 'roles', to_jsonb(u.roles), 'is_admin', u.is_admin, 'is_support', u.is_support,
    'worker', _worker_json(u.id, true), 'contractor', (select to_jsonb(c) || _contractor_json(u.id) from contractor_profiles c where c.user_id = u.id),
    'unread', (select count(*) from notifications n where n.user_id = u.id and not n.read),
    'unread_worker', (select count(*) from notifications n where n.user_id = u.id and not n.read and coalesce(_nrole(n), 'worker') = 'worker'),
    'unread_contractor', (select count(*) from notifications n where n.user_id = u.id and not n.read and coalesce(_nrole(n), 'contractor') = 'contractor'),
    'phone_verified', _phone_ok(u.id), 'phone_number', u.phone_verified,
    'terms_accepted', u.terms_accepted_at is not null,
    'pro', _is_pro(u.id), 'pro_until', (select (extract(epoch from expires_at) * 1000)::bigint from subscriptions where user_id = u.id and expires_at > now()))
  from users u where u.id = me $$;

-- карточка исполнителя: телефон помечен подтверждённым, если совпадает с подтверждённым номером аккаунта
create or replace function _worker_json(uid bigint, with_phone boolean default false) returns jsonb language sql stable as $$
  select jsonb_build_object('user_id', w.user_id, 'name', w.name, 'avatar', w.avatar, 'city', w.city, 'age', w.age, 'skills', to_jsonb(w.skills), 'percent', _percent(w),
    'verified', _percent(w) >= 80, 'pro', _is_pro(w.user_id),
    'shifts_done', (select count(*) from applications a where a.worker_id = w.user_id and a.status = 'completed'
                    and not exists (select 1 from shift_members m where m.shift_id = a.shift_id and m.user_id = a.worker_id and m.attended is false)),
    'about', w.about, 'experience', w.experience, 'license', to_jsonb(w.license), 'medbook', w.medbook, 'selfemployed', w.selfemployed, 'night', w.night, 'tools', w.tools)
    || case when with_phone then jsonb_build_object('phone', w.phone,
         'phone_ok', coalesce((select u.phone_verified from users u where u.id = w.user_id) = right(regexp_replace(coalesce(w.phone, ''), '\D', '', 'g'), 10), false))
       else '{}'::jsonb end
    || _rating_as(w.user_id, 'worker')
  from worker_profiles w where w.user_id = uid $$;

-- ===== обслуживание: + старые коды подтверждения =====
create or replace function maintenance() returns jsonb language plpgsql as $$
declare e int; i int; n int; o int; sv int; pc int;
begin
  delete from events where created_at < now() - interval '60 days'; get diagnostics e = row_count;
  delete from idempotency_keys where created_at < now() - interval '3 days'; get diagnostics i = row_count;
  delete from notifications where tg_sent and created_at < now() - interval '60 days'; get diagnostics n = row_count;
  delete from phone_codes where created_at < now() - interval '7 days'; get diagnostics pc = row_count;
  insert into notifications(user_id, type, text, link)
    select s.contractor_id, 'shift_overdue', format('Смена «%s» прошла. Завершите её и оцените исполнителей', s.title), '#/c/shift/' || s.id
    from shifts s
    where s.status in ('open','full') and _shift_ended(s) and s.date >= current_date - 14
      and exists (select 1 from shift_members m where m.shift_id = s.id and m.role <> 'owner')
      and not exists (select 1 from notifications x where x.user_id = s.contractor_id and x.type = 'shift_overdue' and x.link = '#/c/shift/' || s.id);
  get diagnostics o = row_count;
  with gone as (
    delete from shift_favs v using shifts s
    where s.id = v.shift_id and (s.status <> 'open' or s.hidden or _shift_ended(s))
    returning v.user_id, s.title, s.status)
  insert into notifications(user_id, type, text, link)
    select user_id, 'saved_gone', format('Отложенная смена «%s» %s', title, case when status = 'full' then 'уже набрана' when status = 'cancelled' then 'отменена' else 'больше недоступна' end), '#/w/fav' from gone;
  get diagnostics sv = row_count;
  return jsonb_build_object('events', e, 'idempotency', i, 'notifications', n, 'overdue_reminders', o, 'saved_gone', sv, 'phone_codes', pc);
end $$;

-- ===== диспетчер: + supportInbox, phoneVerifyCode (код отправляет сервер — метод phoneSendCode в server.js) =====
create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','mySkips','unskipAll','apply','undoApply','withdraw','myApplications',
    'toggleFav','favorites','favIds','contractorPage','workerPage','createShift','myShifts','contractorStats','updateShift','cancelShift','completeShift','applicants','decide',
    'team','myTeams','teamChats','setSenior','removeMember','setAttendance','messages','sendMessage','pinMessage','dmInfo','myDialogs','pendingReviews','submitReview','skipReview','userReviews',
    'toggleShiftFav','savedShifts','myWorkers','leaderboard','searchContractors','mySubscription','boostShift','supportInbox','phoneVerifyCode',
    'notifications','markRead','report','track','logError','acceptTerms','deleteAccount',
    'adminStats','adminUsers','adminBlock','adminVerify','adminShifts','adminHideShift','adminReports','adminResolveReport','adminCategories','adminSaveCategory','adminAudit','adminGrantPro','adminRevokePro'];
begin
  if not (fn = any(allowed)) then perform _fail('not_implemented', 'Неизвестный метод: ' || fn); end if;
  execute format('select public.%I($1,$2)', lower('api_' || fn)) into r using me, coalesce(args, '[]'::jsonb);
  return r;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
