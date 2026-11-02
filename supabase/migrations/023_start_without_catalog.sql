-- ТЗ ред. 2 от 30.10.2026 («старт без каталога»). Удаление аккаунта по решению владельца не меняется.
--  1. Регистрация: отдельное подтверждение 18+ и принятие соглашения проверяются сервером; точный возраст исполнителя — от 18 лет.
--  2. Телефон подрядчика: только подтверждённый номер, смена номера сбрасывает подтверждение, черновик смены на сервере.
--  3. Фото необязательно, его можно удалить.
--  4. Поле «медкнижка» удаляется полностью, вместе с сохранёнными значениями.
--  5. Дополнительные данные хранятся только по согласию (документ №3), согласие можно отозвать.
--  6. Анкету исполнителя видит только подрядчик, на чью смену есть отклик. Телефон в анкету не входит.
--  7. Журнал согласий: кто, какой документ и версию, когда, принял или отозвал.

-- ===== журнал и состояние согласий =====
alter table users add column if not exists terms_version text;
alter table users add column if not exists age_confirmed_at timestamptz;
alter table users add column if not exists extra_consent text[] not null default '{}';
alter table users add column if not exists extra_consent_version text;

-- записи только добавляются; сохраняется ровно то, что перечислено в документе №3 (без initData и токенов)
create table if not exists consent_log (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  doc text not null check (doc in ('age18', 'terms', 'additional')),
  version text not null,
  action text not null check (action in ('accept', 'revoke', 'decline')),
  categories text[],
  created_at timestamptz not null default now());
create index if not exists consent_log_user_idx on consent_log (user_id, id);
alter table consent_log enable row level security;
revoke all on consent_log from anon, authenticated;

create or replace function _doc_version(d text) returns text language sql stable as $$
  select version from legal_versions where doc = d order by published_at desc, version desc limit 1 $$;

-- условия приняты: подтверждены 18+ и действующая редакция соглашения (тестовые пользователи симулятора — без проверки)
create or replace function _terms_ok(uid bigint) returns boolean language sql stable as $$
  select exists (select 1 from users u where u.id = uid and (u.is_fake
    or (u.terms_accepted_at is not null and u.age_confirmed_at is not null and u.terms_version = _doc_version('terms')))) $$;

create or replace function api_acceptTerms(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; v text := _doc_version('terms');
begin
  if p->'age18' is distinct from 'true'::jsonb or p->'terms' is distinct from 'true'::jsonb then
    perform _fail('invalid', 'Подтвердите, что вам исполнилось 18 лет, и примите Пользовательское соглашение');
  end if;
  if _terms_ok(me) then return 'true'; end if;
  update users set terms_accepted_at = now(), terms_version = v, age_confirmed_at = now(), deleted_at = null where id = me;
  insert into consent_log(user_id, doc, version, action) values (me, 'age18', '1', 'accept'), (me, 'terms', v, 'accept');
  insert into audit_log(actor, action, meta) values (me, 'terms.accept', jsonb_build_object('version', v));
  return 'true';
end $$;

-- ===== категории дополнительных данных (документ №3) =====
create or replace function _extra_cats() returns text[] language sql immutable as $$
  select array['photo', 'phone', 'about', 'experience', 'skills', 'license', 'selfemployed', 'preferences'] $$;

-- какие категории можно хранить; тестовым пользователям — все, иначе симулятор потеряет смысл
create or replace function _extra_allowed(uid bigint) returns text[] language sql stable as $$
  select case when u.is_fake then _extra_cats() else u.extra_consent end from users u where u.id = uid $$;

-- какие категории фактически заполнены
create or replace function _extra_filled(uid bigint) returns text[] language sql stable as $$
  select coalesce(array_agg(distinct c), '{}') from (
    select unnest(array[case when w.avatar is not null then 'photo' end, case when coalesce(w.phone, '') <> '' then 'phone' end,
      case when coalesce(w.about, '') <> '' then 'about' end, case when coalesce(w.experience, '') <> '' then 'experience' end,
      case when cardinality(w.skills) > 0 then 'skills' end, case when cardinality(w.license) > 0 then 'license' end,
      case when w.selfemployed then 'selfemployed' end, case when w.night or w.tools then 'preferences' end]) as c
    from worker_profiles w where w.user_id = uid
    union all
    select unnest(array[case when k.avatar is not null then 'photo' end, case when coalesce(k.about, '') <> '' then 'about' end])
    from contractor_profiles k where k.user_id = uid) x where c is not null $$;

create or replace function _clear_extra(uid bigint, cats text[]) returns void language sql as $$
  update worker_profiles set
    avatar = case when 'photo' = any(cats) then null else avatar end, phone = case when 'phone' = any(cats) then null else phone end,
    about = case when 'about' = any(cats) then null else about end, experience = case when 'experience' = any(cats) then null else experience end,
    skills = case when 'skills' = any(cats) then '{}' else skills end, license = case when 'license' = any(cats) then '{}' else license end,
    selfemployed = case when 'selfemployed' = any(cats) then false else selfemployed end,
    night = case when 'preferences' = any(cats) then false else night end, tools = case when 'preferences' = any(cats) then false else tools end,
    updated_at = now() where user_id = uid;
  update contractor_profiles set avatar = case when 'photo' = any(cats) then null else avatar end, about = case when 'about' = any(cats) then null else about end,
    updated_at = now() where user_id = uid $$;

-- разбор списка категорий из запроса: только известные, без повторов
create or replace function _extra_parse(j jsonb) returns text[] language plpgsql stable as $$
declare r text[];
begin
  if jsonb_typeof(j) is distinct from 'array' then perform _fail('invalid', 'Некорректный список данных'); end if;
  r := array(select distinct x from jsonb_array_elements_text(j) x);
  if not (r <@ _extra_cats()) then perform _fail('invalid', 'Некорректный список данных'); end if;
  return r;
end $$;

-- согласие: отдельным действием, только на выбранные категории; добавляется к уже данному
create or replace function api_giveExtraConsent(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; cats text[]; v text := _doc_version('additional');
begin
  if p->'agreed' is distinct from 'true'::jsonb then perform _fail('invalid', 'Отметьте согласие'); end if;
  cats := _extra_parse(p->'categories');
  if cardinality(cats) = 0 then perform _fail('invalid', 'Не выбраны дополнительные данные'); end if;
  update users set extra_consent = array(select distinct x from unnest(extra_consent || cats) x order by 1), extra_consent_version = v where id = me;
  insert into consent_log(user_id, doc, version, action, categories) values (me, 'additional', v, 'accept', cats);
  return api_me(me, a);
end $$;

-- отзыв: данные стираются из профиля и выдачи, аккаунт остаётся. Без списка — все категории.
-- decline — отказ от данных, заполненных до появления этого согласия (его не давали, поэтому и отзывать нечего)
create or replace function api_revokeExtraConsent(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare cats text[] := case when a->0 is null or a->0 = 'null'::jsonb then _extra_cats() else _extra_parse(a->0) end;
  held text[]; other text[]; u users;
begin
  select * into u from users where id = me;
  held := array(select x from unnest(cats) x where x = any(u.extra_consent));
  other := array(select x from unnest(cats) x where x <> all(u.extra_consent) and x = any(_extra_filled(me)));
  perform _clear_extra(me, cats);
  update users set extra_consent = array(select x from unnest(extra_consent) x where x <> all(cats) order by 1) where id = me;
  if cardinality(held) > 0 then insert into consent_log(user_id, doc, version, action, categories) values (me, 'additional', coalesce(u.extra_consent_version, _doc_version('additional')), 'revoke', held); end if;
  if cardinality(other) > 0 then insert into consent_log(user_id, doc, version, action, categories) values (me, 'additional', _doc_version('additional'), 'decline', other); end if;
  return api_me(me, a);
end $$;

create or replace function _consents_json(uid bigint) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('doc', c.doc, 'version', c.version, 'action', c.action, 'categories', to_jsonb(c.categories), 'at', (extract(epoch from c.created_at) * 1000)::bigint) order by c.id), '[]')
  from consent_log c where c.user_id = uid $$;
create or replace function api_myConsents(me bigint, a jsonb) returns jsonb language sql stable as $$ select _consents_json(me) $$;
create or replace function api_adminConsents(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare uid bigint := _bigint(a->>0);
begin
  if not exists (select 1 from users where id = me and is_admin) then perform _fail('forbidden', 'Нет доступа'); end if;
  if not exists (select 1 from users where id = uid) then perform _fail('not_found', 'Пользователь не найден'); end if;
  return jsonb_build_object('log', _consents_json(uid), 'extra_consent', (select to_jsonb(extra_consent) from users where id = uid));
end $$;

-- ===== 4. медкнижка: старые значения удаляются вместе с полем =====
create or replace function _percent(w worker_profiles) returns int language sql immutable as $$
  select (case when w.name <> '' then 15 else 0 end) + (case when w.city <> '' then 10 else 0 end) + 15 /*age*/ + (case when w.avatar is not null then 10 else 0 end)
   + (case when coalesce(w.phone,'') <> '' then 5 else 0 end) + (case when coalesce(w.about,'') <> '' then 5 else 0 end) + (case when coalesce(w.experience,'') <> '' then 10 else 0 end)
   + (case when cardinality(w.skills) > 0 then 10 else 0 end) + (case when cardinality(w.license) > 0 then 5 else 0 end)
   + (case when w.selfemployed then 5 else 0 end) + (case when w.night then 5 else 0 end) + (case when w.tools then 5 else 0 end) $$;

create or replace function _worker_json(uid bigint, with_phone boolean default false) returns jsonb language sql stable as $$
  select jsonb_build_object('user_id', w.user_id, 'name', w.name, 'avatar', w.avatar, 'city', w.city, 'age', w.age, 'skills', to_jsonb(w.skills), 'percent', _percent(w),
    'verified', _percent(w) >= 80, 'pro', _is_pro(w.user_id),
    'shifts_done', (select count(*) from applications a where a.worker_id = w.user_id and a.status = 'completed'
                    and not exists (select 1 from shift_members m where m.shift_id = a.shift_id and m.user_id = a.worker_id and m.attended is false)),
    'about', w.about, 'experience', w.experience, 'license', to_jsonb(w.license), 'selfemployed', w.selfemployed, 'night', w.night, 'tools', w.tools)
    || case when with_phone then jsonb_build_object('phone', w.phone,
         'phone_ok', coalesce((select u.phone_verified from users u where u.id = w.user_id) = right(regexp_replace(coalesce(w.phone, ''), '\D', '', 'g'), 10), false))
       else '{}'::jsonb end
    || _rating_as(w.user_id, 'worker')
  from worker_profiles w where w.user_id = uid $$;

-- ===== 1, 3, 5. анкеты: возраст от 18, фото можно удалить, дополнительные поля только по согласию =====
-- Фото: ключа нет — оставляем как есть, null — удаляем. Поля без согласия не сохраняются, даже если их прислал старый клиент.
create or replace function _api_saveworker_core(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; age int := _int(p->>'age'); ok text[] := _extra_allowed(me); old_av text; av text;
begin
  if length(trim(coalesce(p->>'name',''))) < 2 then perform _fail('invalid', 'Укажите имя'); end if;
  if length(trim(coalesce(p->>'city',''))) = 0 then perform _fail('invalid', 'Укажите город'); end if;
  if coalesce(age, 0) not between 18 and 90 then perform _fail('invalid', 'Укажите точный возраст: целое число от 18 лет'); end if;
  select avatar into old_av from worker_profiles where user_id = me;
  av := case when not ('photo' = any(ok)) then null when p ? 'avatar' then p->>'avatar' else old_av end;
  insert into worker_profiles(user_id, name, city, age, avatar, phone, about, experience, skills, license, selfemployed, night, tools)
  values (me, trim(p->>'name'), trim(p->>'city'), age, av,
    case when 'phone' = any(ok) then nullif(trim(coalesce(p->>'phone', '')), '') end,
    case when 'about' = any(ok) then p->>'about' end,
    case when 'experience' = any(ok) then p->>'experience' end,
    case when 'skills' = any(ok) then coalesce(array(select left(trim(x), 60) from jsonb_array_elements_text(coalesce(p->'skills','[]')) x where trim(x) <> '' limit 30), '{}') else '{}' end,
    case when 'license' = any(ok) then coalesce(array(select distinct x from jsonb_array_elements_text(coalesce(p->'license','[]')) x where x in ('A','B','C','D','E')), '{}') else '{}' end,
    'selfemployed' = any(ok) and coalesce((p->>'selfemployed')::boolean, false),
    'preferences' = any(ok) and coalesce((p->>'night')::boolean, false),
    'preferences' = any(ok) and coalesce((p->>'tools')::boolean, false))
  on conflict (user_id) do update set name = excluded.name, city = excluded.city, age = excluded.age, avatar = excluded.avatar, phone = excluded.phone, about = excluded.about,
    experience = excluded.experience, skills = excluded.skills, license = excluded.license, selfemployed = excluded.selfemployed, night = excluded.night, tools = excluded.tools, updated_at = now();
  update users set roles = array(select distinct unnest(roles || 'worker'::text)) where id = me;
  return api_me(me, a);
end $$;

alter table worker_profiles drop column if exists medbook;

alter table contractor_profiles alter column phone drop not null;
-- в профиле подрядчика остаётся только подтверждённый номер: другим пользователям он не показывается
update contractor_profiles c set phone = (select phone_verified from users u where u.id = c.user_id);

create or replace function _api_savecontractor_core(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; ok text[] := _extra_allowed(me); old_av text; av text;
begin
  if length(trim(coalesce(p->>'name',''))) < 2 then perform _fail('invalid', 'Укажите имя'); end if;
  if length(trim(coalesce(p->>'city',''))) = 0 then perform _fail('invalid', 'Укажите город'); end if;
  select avatar into old_av from contractor_profiles where user_id = me;
  av := case when not ('photo' = any(ok)) then null when p ? 'avatar' then p->>'avatar' else old_av end;
  insert into contractor_profiles(user_id, name, company, city, phone, about, avatar)
  values (me, trim(p->>'name'), p->>'company', trim(p->>'city'), (select phone_verified from users where id = me), case when 'about' = any(ok) then p->>'about' end, av)
  on conflict (user_id) do update set name = excluded.name, company = excluded.company, city = excluded.city, about = excluded.about, avatar = excluded.avatar, updated_at = now();
  update users set roles = array(select distinct unnest(roles || 'contractor'::text)) where id = me;
  return api_me(me, a);
end $$;

-- отклик: исполнитель младше 18 (анкета заполнена до этого обновления) сначала указывает точный возраст
alter function api_apply(bigint, jsonb) rename to _api_apply_core;
create or replace function api_apply(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  if exists (select 1 from worker_profiles where user_id = me and age < 18) then perform _fail('profile_required', 'Сервис только для тех, кому исполнилось 18 лет: проверьте возраст в профиле'); end if;
  return _api_apply_core(me, a);
end $$;

-- ===== 2. телефон подрядчика =====
-- номер подтверждён (кодом или контактом в Telegram). В анкету исполнителя он больше не копируется: телефон там только добровольный и по согласию.
create or replace function _set_phone_verified(uid bigint, ph text, via text) returns void language plpgsql as $$
begin
  update users set phone_verified = ph, phone_verified_at = now() where id = uid;
  update contractor_profiles set phone = ph where user_id = uid;
  insert into audit_log(actor, action, meta) values (uid, 'phone.verify', jsonb_build_object('via', via));
end $$;

-- контакт привязывается к аккаунту того же пользователя Telegram и только после принятия условий
create or replace function bot_verify_phone(tg bigint, phone text) returns text language plpgsql as $$
declare uid bigint; digits text := regexp_replace(coalesce(phone, ''), '\D', '', 'g'); ph text;
begin
  if length(digits) < 10 then return 'invalid'; end if;
  if not (digits ~ '^[78]\d{10}$') then return 'foreign'; end if;
  ph := right(digits, 10);
  select id into uid from users where tg_id = tg;
  if uid is null or not _terms_ok(uid) then return 'no_user'; end if;
  if exists (select 1 from users where phone_verified = ph and id <> uid) then return 'taken'; end if;
  perform _set_phone_verified(uid, ph, 'telegram');
  return 'ok';
end $$;

-- смена номера: подтверждение сбрасывается, новый номер подтверждается заново
create or replace function api_phoneReset(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  update users set phone_verified = null, phone_verified_at = null where id = me;
  update contractor_profiles set phone = null where user_id = me;
  insert into audit_log(actor, action, meta) values (me, 'phone.reset', '{}');
  return api_me(me, a);
end $$;

-- черновик смены: хранится на сервере, чтобы пережить переход в бота и повторное открытие приложения
create table if not exists shift_drafts (
  user_id bigint primary key references users(id) on delete cascade,
  data jsonb not null, updated_at timestamptz not null default now());
alter table shift_drafts enable row level security;
revoke all on shift_drafts from anon, authenticated;

create or replace function api_saveShiftDraft(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  if jsonb_typeof(a->0) is distinct from 'object' or length((a->0)::text) > 16000 then perform _fail('invalid', 'Слишком большой черновик'); end if;
  insert into shift_drafts(user_id, data) values (me, a->0) on conflict (user_id) do update set data = excluded.data, updated_at = now();
  return 'true';
end $$;
create or replace function api_getShiftDraft(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce((select data from shift_drafts where user_id = me), 'null'::jsonb) $$;
create or replace function api_deleteShiftDraft(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin delete from shift_drafts where user_id = me; return 'true'; end $$;

-- ===== требования смены: без медицинских документов =====
create or replace function _no_med(j jsonb) returns jsonb language sql immutable as $$
  select case when jsonb_typeof(j) = 'array' then coalesce((select jsonb_agg(x) from jsonb_array_elements(j) x where coalesce(x #>> '{}', '') !~* 'мед\.?\s*книж'), '[]'::jsonb) else j end $$;
update shifts set requirements = array(select x from unnest(requirements) x where x !~* 'мед\.?\s*книж')
  where exists (select 1 from unnest(requirements) x where x ~* 'мед\.?\s*книж');

create or replace function api_createShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  if not _phone_ok(me) then perform _fail('phone_unverified', 'Подтвердите номер телефона через Telegram, чтобы публиковать смены'); end if;
  if not _key_ok(a->>1) then perform _fail('invalid', 'Некорректный запрос — обновите приложение'); end if;
  if _has_link(a->0->>'title') then perform _fail('invalid', 'В названии смены не должно быть ссылок и контактов — их можно указать в описании'); end if;
  r := _api_createshift_core(me, case when a->0 ? 'requirements' then jsonb_set(a, '{0,requirements}', _no_med(a->0->'requirements')) else a end);
  delete from shift_drafts where user_id = me;
  return r;
end $$;

alter function api_updateShift(bigint, jsonb) rename to _api_updateshift_core;
create or replace function api_updateShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  return _api_updateshift_core(me, case when a->1 ? 'requirements' then jsonb_set(a, '{1,requirements}', _no_med(a->1->'requirements')) else a end);
end $$;

-- ===== 6. старт без каталога: анкету видит только тот, кому она направлена =====
-- сам исполнитель, администратор, а также подрядчик (или админ чата с правом на отклики) той смены, на которую есть действующий отклик
create or replace function _worker_visible(me bigint, wid bigint) returns boolean language sql stable as $$
  select me = wid or exists (select 1 from users where id = me and is_admin)
    or exists (select 1 from applications x where x.worker_id = wid and not x.withdrawn and _can_manage(x.shift_id, me, 'applications')) $$;

-- чужая и несуществующая анкета неотличимы: перебор номеров ничего не даёт. Телефон в анкету не входит.
create or replace function api_workerPage(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare wid bigint := _bigint(a->>0); act jsonb; cnt int;
begin
  if wid is null or not exists (select 1 from worker_profiles where user_id = wid) or not _worker_visible(me, wid) then perform _fail('not_found', 'Исполнитель не найден'); end if;
  select count(*), coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'date', s.date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'), 'until_done', s.until_done) order by s.date, s.start_time)
      filter (where me = wid or s.contractor_id = me), '[]')
    into cnt, act
  from applications x join shifts s on s.id = x.shift_id
  where x.worker_id = wid and x.status = 'accepted' and s.status in ('open','full') and not _shift_ended(s);
  return jsonb_build_object('worker', _worker_json(wid, me = wid), 'reviews', _reviews_as(wid, 'worker'), 'is_fav', exists (select 1 from favorites where user_id = me and target_id = wid),
    'active_count', cnt, 'active', act);
end $$;

-- отзывы об исполнителе — там же, где его анкета. На открытой странице подрядчика автор-исполнитель обезличен: имя и фото не уходят всем подряд.
create or replace function _reviews_page(uid bigint, rl text, lim int, off int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'stars', r.stars, 'criteria', r.criteria, 'text', r.text, 'at', (extract(epoch from r.created_at) * 1000)::bigint,
    'from_user', case when m.hide then null else r.from_user end, 'from_role', case when r.from_user = s.contractor_id then 'contractor' else 'worker' end,
    'from_name', case when m.hide then 'Исполнитель' else coalesce(case when r.from_user = s.contractor_id then (select coalesce(nullif(company, ''), name) from contractor_profiles where user_id = r.from_user)
                               else (select name from worker_profiles where user_id = r.from_user) end, 'Удалённый пользователь') end,
    'from_avatar', case when m.hide then null when r.from_user = s.contractor_id then (select avatar from contractor_profiles where user_id = r.from_user) else (select avatar from worker_profiles where user_id = r.from_user) end,
    'shift_id', s.id, 'shift_title', s.title) order by r.id desc), '[]')
  from (select rv.* from reviews rv join shifts sh on sh.id = rv.shift_id where rv.to_user = uid and ((sh.contractor_id = uid) = (rl = 'contractor')) order by rv.id desc limit lim offset off) r
  join shifts s on s.id = r.shift_id
  cross join lateral (select r.from_user <> s.contractor_id and uid <> _me() and not exists (select 1 from users where id = _me() and is_admin) as hide) m $$;

create or replace function api_userReviews(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare uid bigint := _bigint(a->>0); rl text := case when a->>1 = 'contractor' then 'contractor' else 'worker' end; off int := greatest(coalesce(_int(a->>2), 0), 0);
begin
  if (rl = 'contractor' and not exists (select 1 from contractor_profiles where user_id = uid))
     or (rl = 'worker' and (not exists (select 1 from worker_profiles where user_id = uid) or not _worker_visible(me, uid))) then
    perform _fail('not_found', 'Профиль не найден'); end if;
  return jsonb_build_object('role', rl, 'user_id', uid,
    'name', case when rl = 'contractor' then (select coalesce(nullif(company, ''), name) from contractor_profiles where user_id = uid) else (select name from worker_profiles where user_id = uid) end,
    'avatar', case when rl = 'contractor' then (select avatar from contractor_profiles where user_id = uid) else (select avatar from worker_profiles where user_id = uid) end,
    'total', (_rating_as(uid, rl)->>'reviews')::int, 'rating', _rating_as(uid, rl)->'rating', 'items', _reviews_page(uid, rl, 20, off));
end $$;

-- избранное не открывает анкеты: исполнителя можно добавить и увидеть только при действующем отклике
create or replace function api_toggleFav(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare t bigint := _bigint(a->>0);
begin
  delete from favorites where user_id = me and target_id = t;
  if found then return 'false'; end if;
  if t is null or t = me or not exists (select 1 from users where id = t and deleted_at is null) then perform _fail('not_found', 'Пользователь не найден'); end if;
  if not exists (select 1 from contractor_profiles where user_id = t) and not _worker_visible(me, t) then perform _fail('not_found', 'Пользователь не найден'); end if;
  if (select count(*) from favorites where user_id = me) >= 500 then perform _fail('limit', 'В избранном уже 500 человек — сначала уберите кого-нибудь'); end if;
  insert into favorites(user_id, target_id) values (me, t) on conflict do nothing;
  return 'true';
end $$;

create or replace function api_favorites(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin
  if a->>0 = 'worker' then
    return (select coalesce(jsonb_agg(_worker_json(f.target_id)), '[]') from favorites f join worker_profiles w on w.user_id = f.target_id where f.user_id = me and _worker_visible(me, f.target_id));
  end if;
  return (select coalesce(jsonb_agg(_contractor_json(f.target_id) || jsonb_build_object('open_shifts', (select count(*) from shifts s where s.contractor_id = f.target_id and s.status = 'open' and not s.hidden and s.date >= current_date and not _shift_ended(s)))), '[]')
          from favorites f join contractor_profiles c on c.user_id = f.target_id where f.user_id = me);
end $$;

-- состав команды: подрядчику и админу чата с правом на отклики — как раньше; исполнителю фото других исполнителей не передаётся
create or replace function api_team(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare s shifts; sid bigint := (a->>0)::bigint; mine shift_members; full_view boolean;
begin
  select * into mine from shift_members where shift_id = sid and user_id = me;
  if not found then perform _fail('forbidden', 'Вы не в команде этой смены'); end if;
  select * into s from shifts where id = sid;
  full_view := _can_manage(sid, me, 'applications');
  return jsonb_build_object('shift', _shift_json(s, me), 'my_role', mine.role, 'my_perms', to_jsonb(mine.perms),
    'members', (select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object('name', coalesce(case when m.role = 'owner' then (select name from contractor_profiles where user_id = m.user_id) end, (select name from worker_profiles where user_id = m.user_id)),
        'avatar', case when m.role = 'owner' then (select avatar from contractor_profiles where user_id = m.user_id)
                       when full_view or m.user_id = me then (select avatar from worker_profiles where user_id = m.user_id) end) order by m.joined_at), '[]') from shift_members m where m.shift_id = sid),
    'pinned', (select _msg_json(x) from messages x where x.scope = 'shift:' || sid and x.pinned limit 1));
end $$;

-- рейтинг исполнителей без открытых анкет: остальные участники обезличены, себя видно как обычно, администратору видно всё
create or replace function api_leaderboard(me bigint, a jsonb) returns jsonb language sql stable as $$
  with p as (select case when a->>0 = 'all' then 'all' else 'month' end as per,
                    case when a->>0 = 'all' then '-infinity'::timestamptz else date_trunc('month', now()) end as since,
                    coalesce((select is_admin from users where id = me), false) as adm),
  done as (
    select ap.worker_id as uid, count(*) as n from applications ap join shifts s on s.id = ap.shift_id, p
    where ap.status = 'completed' and s.completed_at >= p.since
      and not exists (select 1 from shift_members m where m.shift_id = ap.shift_id and m.user_id = ap.worker_id and m.attended is false) group by ap.worker_id),
  rv as (
    select r.to_user as uid, sum(r.stars) as st, avg(r.stars) as av, count(*) as n from reviews r join shifts s on s.id = r.shift_id, p
    where s.contractor_id <> r.to_user and r.created_at >= p.since group by r.to_user),
  sc as (
    select w.user_id as uid, w.name, w.avatar, coalesce(d.n, 0) as shifts, coalesce(rv.st, 0) as stars, round(rv.av, 1) as av, coalesce(d.n, 0) * 10 + coalesce(rv.st, 0) * 2 as score
    from worker_profiles w join users u on u.id = w.user_id left join done d on d.uid = w.user_id left join rv on rv.uid = w.user_id, p
    where (coalesce(d.n, 0) > 0 or coalesce(rv.n, 0) > 0) and (not u.is_fake or p.adm)),
  ranked as (select *, rank() over (order by score desc, shifts desc, uid) as rk from sc)
  select jsonb_build_object('period', (select per from p),
    'top', coalesce((select jsonb_agg(jsonb_build_object('rank', t.rk, 'score', t.score, 'shifts', t.shifts, 'rating', t.av,
         'user_id', case when t.uid = me or (select adm from p) then t.uid end,
         'name', case when t.uid = me or (select adm from p) then t.name else 'Исполнитель' end,
         'avatar', case when t.uid = me or (select adm from p) then t.avatar end) order by t.rk, t.uid)
                     from (select * from ranked order by rk, uid limit 20) t), '[]'),
    'me', (select jsonb_build_object('rank', r.rk, 'score', r.score, 'shifts', r.shifts, 'rating', r.av) from ranked r where r.uid = me),
    'participants', (select count(*) from ranked)) $$;

-- ===== профиль: согласия, версии документов, черновик =====
create or replace function api_me(me bigint, a jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('id', u.id, 'tg_id', u.tg_id, 'first_name', u.first_name, 'username', u.username, 'roles', to_jsonb(u.roles), 'is_admin', u.is_admin, 'is_support', u.is_support,
    'worker', _worker_json(u.id, true), 'contractor', (select to_jsonb(c) || _contractor_json(u.id) from contractor_profiles c where c.user_id = u.id),
    'unread', (select count(*) from notifications n where n.user_id = u.id and not n.read),
    'unread_worker', (select count(*) from notifications n where n.user_id = u.id and not n.read and coalesce(_nrole(n), 'worker') = 'worker'),
    'unread_contractor', (select count(*) from notifications n where n.user_id = u.id and not n.read and coalesce(_nrole(n), 'contractor') = 'contractor'),
    'phone_verified', _phone_ok(u.id), 'phone_number', u.phone_verified,
    'terms_accepted', _terms_ok(u.id), 'had_terms', u.terms_accepted_at is not null,
    'extra_consent', to_jsonb(u.extra_consent),
    'extra_pending', case when u.is_fake then '[]'::jsonb else to_jsonb(array(select x from unnest(_extra_filled(u.id)) x where x <> all(u.extra_consent))) end,
    'draft_pending', coalesce((select d.data->>'pending' = 'true' from shift_drafts d where d.user_id = u.id), false),
    'pro', _is_pro(u.id), 'pro_until', (select (extract(epoch from expires_at) * 1000)::bigint from subscriptions where user_id = u.id and expires_at > now()))
  from users u where u.id = me $$;

-- при удалении аккаунта вместе с номером стираются состояние согласий и черновик; записи журнала согласий остаются (п. 8.6 Политики)
create or replace function _users_clear_phone() returns trigger language plpgsql as $$
begin
  new.phone_verified := null; new.phone_verified_at := null;
  new.terms_version := null; new.age_confirmed_at := null; new.extra_consent := '{}'; new.extra_consent_version := null;
  delete from phone_codes where user_id = new.id;
  delete from shift_drafts where user_id = new.id;
  return new;
end $$;

-- ===== обслуживание: + брошенные черновики =====
create or replace function maintenance() returns jsonb language plpgsql as $$
declare e int; i int; n int; o int; sv int; pc int; dr int;
begin
  delete from events where created_at < now() - interval '60 days'; get diagnostics e = row_count;
  delete from idempotency_keys where created_at < now() - interval '3 days'; get diagnostics i = row_count;
  delete from notifications where tg_sent and created_at < now() - interval '60 days'; get diagnostics n = row_count;
  delete from phone_codes where created_at < now() - interval '7 days'; get diagnostics pc = row_count;
  delete from shift_drafts where updated_at < now() - interval '30 days'; get diagnostics dr = row_count;
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
  return jsonb_build_object('events', e, 'idempotency', i, 'notifications', n, 'overdue_reminders', o, 'saved_gone', sv, 'phone_codes', pc, 'drafts', dr);
end $$;

-- ===== диспетчер: новые методы; пока условия не приняты, доступно только необходимое для их принятия =====
create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','mySkips','unskipAll','apply','undoApply','withdraw','myApplications',
    'toggleFav','favorites','favIds','contractorPage','workerPage','createShift','myShifts','contractorStats','updateShift','cancelShift','completeShift','applicants','decide',
    'team','myTeams','teamChats','setSenior','removeMember','setAttendance','messages','sendMessage','pinMessage','dmInfo','myDialogs','pendingReviews','submitReview','skipReview','userReviews',
    'toggleShiftFav','savedShifts','myWorkers','leaderboard','searchContractors','mySubscription','boostShift','supportInbox','phoneVerifyCode','phoneReset',
    'saveShiftDraft','getShiftDraft','deleteShiftDraft','giveExtraConsent','revokeExtraConsent','myConsents',
    'notifications','markRead','report','track','logError','acceptTerms','deleteAccount',
    'adminStats','adminUsers','adminBlock','adminVerify','adminShifts','adminHideShift','adminReports','adminResolveReport','adminCategories','adminSaveCategory','adminAudit','adminGrantPro','adminRevokePro','adminConsents'];
begin
  if not (fn = any(allowed)) then perform _fail('not_implemented', 'Неизвестный метод: ' || fn); end if;
  if not (fn = any(array['me','categories','acceptTerms','deleteAccount','track','logError'])) and not _terms_ok(me) then
    perform _fail('terms_required', 'Сначала подтвердите возраст и примите Пользовательское соглашение');
  end if;
  execute format('select public.%I($1,$2)', lower('api_' || fn)) into r using me, coalesce(args, '[]'::jsonb);
  return r;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
