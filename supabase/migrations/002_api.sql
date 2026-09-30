-- SPEED HELPER: серверная бизнес-логика. Единая точка входа public.api(fn, args).
-- Личность берётся из JWT (claim sub = users.id), который выдаёт Edge Function tg-auth ПОСЛЕ проверки Telegram initData.
-- Клиенту нельзя передать чужой user id. Формат JSON совпадает с js/local-backend.js.
-- Ошибки: raise exception '<текст>' using hint = '<код>' (invalid, forbidden, closed, conflict, full, profile_required, own_shift, blocked, unauthorized).

create or replace function _fail(code text, msg text) returns void language plpgsql as $$ begin raise exception '%', msg using hint = code; end $$;

create or replace function _me() returns bigint language plpgsql stable as $$
declare v bigint; b boolean;
begin
  v := nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::bigint;
  if v is null then perform _fail('unauthorized', 'Нужно войти'); end if;
  select blocked into b from users where id = v;
  if b is null then perform _fail('unauthorized', 'Нужно войти'); end if;
  if b then perform _fail('blocked', 'Аккаунт заблокирован'); end if;
  return v;
end $$;

create or replace function _notify(uid bigint, typ text, txt text, lnk text) returns void language sql as $$
  insert into notifications(user_id, type, text, link) values (uid, typ, txt, lnk) $$;

create or replace function _rating(uid bigint) returns jsonb language sql stable as $$
  select jsonb_build_object('rating', round(avg(stars)::numeric, 1), 'reviews', count(*)) from reviews where to_user = uid $$;

create or replace function _percent(w worker_profiles) returns int language sql immutable as $$
  select (case when w.name <> '' then 15 else 0 end) + (case when w.city <> '' then 10 else 0 end) + 10 /*age*/ + (case when w.avatar is not null then 10 else 0 end)
   + (case when coalesce(w.phone,'') <> '' then 5 else 0 end) + (case when coalesce(w.about,'') <> '' then 5 else 0 end) + (case when coalesce(w.experience,'') <> '' then 10 else 0 end)
   + (case when cardinality(w.skills) > 0 then 10 else 0 end) + (case when cardinality(w.license) > 0 then 5 else 0 end)
   + (case when w.medbook then 5 else 0 end) + (case when w.selfemployed then 5 else 0 end) + (case when w.night then 5 else 0 end) + (case when w.tools then 5 else 0 end) $$;

create or replace function _contractor_json(cid bigint) returns jsonb language sql stable as $$
  select jsonb_build_object('id', c.user_id, 'name', c.name, 'company', c.company, 'avatar', c.avatar, 'about', c.about, 'city', c.city, 'verified', c.verified,
    'shifts_done', (select count(*) from shifts s where s.contractor_id = c.user_id and s.status = 'completed')) || _rating(c.user_id)
  from contractor_profiles c where c.user_id = cid $$;

create or replace function _worker_json(uid bigint, with_phone boolean default false) returns jsonb language sql stable as $$
  select jsonb_build_object('user_id', w.user_id, 'name', w.name, 'avatar', w.avatar, 'city', w.city, 'age', w.age, 'skills', to_jsonb(w.skills), 'percent', _percent(w),
    'verified', _percent(w) >= 80, 'shifts_done', (select count(*) from applications a where a.worker_id = w.user_id and a.status = 'completed'),
    'about', w.about, 'experience', w.experience, 'license', to_jsonb(w.license), 'medbook', w.medbook, 'selfemployed', w.selfemployed, 'night', w.night, 'tools', w.tools)
    || case when with_phone then jsonb_build_object('phone', w.phone) else '{}'::jsonb end || _rating(w.user_id)
  from worker_profiles w where w.user_id = uid $$;

create or replace function _shift_json(s shifts, me bigint, olat double precision default null, olng double precision default null) returns jsonb language plpgsql stable as $$
declare j jsonb; a applications;
begin
  j := jsonb_build_object('id', s.id, 'contractor_id', s.contractor_id, 'title', s.title, 'category_id', s.category_id, 'category_name', (select name from categories where id = s.category_id),
    'description', s.description, 'address', s.address, 'lat', s.lat, 'lng', s.lng, 'date', s.date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'),
    'pay', s.pay, 'people', s.people, 'requirements', to_jsonb(s.requirements), 'status', s.status, 'hidden', s.hidden,
    'contractor', _contractor_json(s.contractor_id), 'accepted_count', (select count(*) from shift_members m where m.shift_id = s.id and m.role <> 'owner'));
  if olat is not null and s.lat is not null then
    j := j || jsonb_build_object('distance_km', 6371 * 2 * asin(sqrt(sin(radians(s.lat - olat) / 2) ^ 2 + cos(radians(olat)) * cos(radians(s.lat)) * sin(radians(s.lng - olng) / 2) ^ 2)));
  end if;
  select * into a from applications where shift_id = s.id and worker_id = me;
  if found then j := j || jsonb_build_object('my_status', a.status, 'my_application_id', a.id); end if;
  return j;
end $$;

create or replace function _can_manage(sid bigint, uid bigint, perm text) returns boolean language sql stable as $$
  select exists (select 1 from shifts where id = sid and contractor_id = uid)
      or exists (select 1 from shift_members where shift_id = sid and user_id = uid and role = 'senior' and perm = any(perms)) $$;

-- ---------------- методы ----------------
create or replace function api_me(me bigint, a jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('id', u.id, 'tg_id', u.tg_id, 'first_name', u.first_name, 'username', u.username, 'roles', to_jsonb(u.roles), 'is_admin', u.is_admin,
    'worker', _worker_json(u.id, true), 'contractor', (select to_jsonb(c) || _contractor_json(u.id) from contractor_profiles c where c.user_id = u.id),
    'unread', (select count(*) from notifications n where n.user_id = u.id and not n.read))
  from users u where u.id = me $$;

create or replace function api_categories(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from categories c where c.active $$;

create or replace function api_saveWorker(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; av text;
begin
  if length(trim(coalesce(p->>'name',''))) < 2 then perform _fail('invalid', 'Укажите имя'); end if;
  if length(trim(coalesce(p->>'city',''))) = 0 then perform _fail('invalid', 'Укажите город'); end if;
  if coalesce((p->>'age')::int, 0) not between 16 and 90 then perform _fail('invalid', 'Укажите возраст (16–90)'); end if;
  select avatar into av from worker_profiles where user_id = me;
  if coalesce(p->>'avatar', av) is null then perform _fail('invalid', 'Добавьте фото'); end if;
  insert into worker_profiles(user_id, name, city, age, avatar, phone, about, experience, skills, license, medbook, selfemployed, night, tools)
  values (me, trim(p->>'name'), trim(p->>'city'), (p->>'age')::int, coalesce(p->>'avatar', av), p->>'phone', p->>'about', p->>'experience',
    coalesce(array(select jsonb_array_elements_text(coalesce(p->'skills','[]'))), '{}'), coalesce(array(select jsonb_array_elements_text(coalesce(p->'license','[]'))), '{}'),
    coalesce((p->>'medbook')::boolean, false), coalesce((p->>'selfemployed')::boolean, false), coalesce((p->>'night')::boolean, false), coalesce((p->>'tools')::boolean, false))
  on conflict (user_id) do update set name = excluded.name, city = excluded.city, age = excluded.age, avatar = excluded.avatar, phone = excluded.phone, about = excluded.about,
    experience = excluded.experience, skills = excluded.skills, license = excluded.license, medbook = excluded.medbook, selfemployed = excluded.selfemployed, night = excluded.night, tools = excluded.tools, updated_at = now();
  update users set roles = array(select distinct unnest(roles || 'worker')) where id = me;
  return api_me(me, a);
end $$;

create or replace function api_saveContractor(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; ph text := right(regexp_replace(coalesce(p->>'phone',''), '\D', '', 'g'), 10);
begin
  if length(trim(coalesce(p->>'name',''))) < 2 then perform _fail('invalid', 'Укажите имя'); end if;
  if length(trim(coalesce(p->>'city',''))) = 0 then perform _fail('invalid', 'Укажите город'); end if;
  if length(ph) < 10 then perform _fail('invalid', 'Укажите телефон'); end if;
  insert into contractor_profiles(user_id, name, company, city, phone, about, avatar) values (me, trim(p->>'name'), p->>'company', trim(p->>'city'), ph, p->>'about', p->>'avatar')
  on conflict (user_id) do update set name = excluded.name, company = excluded.company, city = excluded.city, phone = excluded.phone, about = excluded.about, avatar = coalesce(excluded.avatar, contractor_profiles.avatar), updated_at = now();
  update users set roles = array(select distinct unnest(roles || 'contractor')) where id = me;
  return api_me(me, a);
end $$;

-- Лента: фильтры дата / оплата / радиус / категории, пагинация offset+limit
create or replace function api_feed(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare f jsonb := coalesce(a->0, '{}'); olat double precision := coalesce((f->>'lat')::float, 55.7558); olng double precision := coalesce((f->>'lng')::float, 37.6173);
  off int := coalesce((f->>'offset')::int, 0); lim int := least(coalesce((f->>'limit')::int, 20), 200); rad float := (f->>'radius_km')::float;
  cats int[] := coalesce(array(select jsonb_array_elements_text(coalesce(f->'categories','[]'))::int), '{}'); res jsonb; tot int;
begin
  with base as (
    select s.id, s.date as d, s.start_time as st,
      case when s.lat is null then null else 6371 * 2 * asin(sqrt(sin(radians(s.lat - olat) / 2) ^ 2 + cos(radians(olat)) * cos(radians(s.lat)) * sin(radians(s.lng - olng) / 2) ^ 2)) end as dist
    from shifts s
    where s.status = 'open' and not s.hidden and s.contractor_id <> me and s.date >= current_date
      and not exists (select 1 from applications x where x.shift_id = s.id and x.worker_id = me)
      and (coalesce((f->>'include_skipped')::boolean, false) or not exists (select 1 from skips k where k.shift_id = s.id and k.user_id = me))
      and (coalesce(f->>'date','any') = 'any' or (f->>'date' = 'today' and s.date = current_date) or (f->>'date' = 'tomorrow' and s.date = current_date + 1) or (f->>'date' = 'weekend' and extract(isodow from s.date) in (6,7)))
      and s.pay >= coalesce((f->>'min_pay')::int, 0) and (cardinality(cats) = 0 or s.category_id = any(cats))
      and (f->>'similar_to' is null or s.category_id = (select category_id from shifts where id = (f->>'similar_to')::bigint))
  ), filt as (select *, count(*) over () as tot from base where rad is null or dist is null or dist <= rad),
  page as (select * from filt order by d, st, id desc limit lim offset off)
  select coalesce(jsonb_agg(_shift_json(s, me, olat, olng) order by p.d, p.st, p.id desc), '[]'), coalesce((select max(tot) from filt), 0)
    into res, tot from page p join shifts s on s.id = p.id;
  return jsonb_build_object('items', res, 'total', tot, 'next', case when off + lim < tot then off + lim end);
end $$;

create or replace function api_getShift(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare s shifts; begin select * into s from shifts where id = (a->>0)::bigint; if not found then perform _fail('not_found', 'Смена не найдена'); end if; return _shift_json(s, me); end $$;

create or replace function api_skip(me bigint, a jsonb) returns jsonb language sql as $$ insert into skips values (me, (a->>0)::bigint) on conflict do nothing returning to_jsonb(true) $$;
create or replace function api_unskip(me bigint, a jsonb) returns jsonb language sql as $$ with d as (delete from skips where user_id = me and shift_id = (a->>0)::bigint returning 1) select to_jsonb(true) $$;

-- Отклик идемпотентен: unique(shift_id, worker_id) + возврат существующей записи
create or replace function api_apply(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare s shifts; ex applications; n applications; wname text;
begin
  select name into wname from worker_profiles where user_id = me;
  if wname is null then perform _fail('profile_required', 'Сначала заполните профиль исполнителя'); end if;
  select * into s from shifts where id = (a->>0)::bigint for share; if not found then perform _fail('not_found', 'Смена не найдена'); end if;
  select * into ex from applications where shift_id = s.id and worker_id = me;
  if found then return to_jsonb(ex) || '{"duplicate":true}'; end if;
  if s.contractor_id = me then perform _fail('own_shift', 'Нельзя откликнуться на свою смену'); end if;
  if s.status <> 'open' or s.hidden then perform _fail('closed', 'Смена уже закрыта'); end if;
  insert into applications(shift_id, worker_id) values (s.id, me) on conflict (shift_id, worker_id) do nothing returning * into n;
  if n.id is null then select * into n from applications where shift_id = s.id and worker_id = me; return to_jsonb(n) || '{"duplicate":true}'; end if;
  perform _notify(s.contractor_id, 'new_application', format('Новый отклик: %s — «%s»', wname, s.title), '#/c/shift/' || s.id);
  delete from skips where user_id = me and shift_id = s.id;
  return to_jsonb(n);
end $$;

create or replace function api_undoApply(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin delete from applications where shift_id = (a->>0)::bigint and worker_id = me and status = 'pending'; return to_jsonb(found); end $$;

create or replace function api_myApplications(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object('shift', _shift_json(s, me)) order by x.updated_at desc), '[]') from applications x join shifts s on s.id = x.shift_id where x.worker_id = me $$;

create or replace function api_createShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; k text := a->>1; s shifts; r jsonb;
begin
  if not exists (select 1 from contractor_profiles where user_id = me) then perform _fail('profile_required', 'Сначала заполните профиль подрядчика'); end if;
  if k is not null then select result into r from idempotency_keys where user_id = me and key = k; if found then return r; end if; end if;
  if length(trim(coalesce(p->>'title',''))) < 3 then perform _fail('invalid', 'Укажите название смены'); end if;
  if not exists (select 1 from categories where id = (p->>'category_id')::int and active) then perform _fail('invalid', 'Выберите категорию'); end if;
  if length(trim(coalesce(p->>'address',''))) < 3 then perform _fail('invalid', 'Укажите адрес'); end if;
  if (p->>'date')::date < current_date then perform _fail('invalid', 'Дата не может быть в прошлом'); end if;
  if coalesce((p->>'pay')::int, 0) <= 0 then perform _fail('invalid', 'Укажите оплату'); end if;
  if coalesce((p->>'people')::int, 0) not between 1 and 500 then perform _fail('invalid', 'Укажите количество людей'); end if;
  insert into shifts(contractor_id, title, category_id, description, address, lat, lng, date, start_time, end_time, pay, people, requirements)
  values (me, trim(p->>'title'), (p->>'category_id')::int, coalesce(p->>'description',''), trim(p->>'address'), (p->>'lat')::float, (p->>'lng')::float, (p->>'date')::date,
    (p->>'start')::time, (p->>'end')::time, (p->>'pay')::int, (p->>'people')::int, coalesce(array(select jsonb_array_elements_text(coalesce(p->'requirements','[]'))), '{}')) returning * into s;
  insert into shift_members(shift_id, user_id, role) values (s.id, me, 'owner');
  if coalesce((p->>'notify_favorites')::boolean, false) then
    insert into notifications(user_id, type, text, link) select f.target_id, 'new_shift_from_fav', format('Новая смена: «%s»', s.title), '#/w/shift/' || s.id
    from favorites f join worker_profiles w on w.user_id = f.target_id where f.user_id = me;
  end if;
  insert into audit_log(actor, action, meta) values (me, 'shift.create', jsonb_build_object('id', s.id));
  r := _shift_json(s, me);
  if k is not null then insert into idempotency_keys(user_id, key, result) values (me, k, r) on conflict do nothing; end if;
  return r;
end $$;

create or replace function api_myShifts(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(_shift_json(s, me) || jsonb_build_object('pending_count', (select count(*) from applications x where x.shift_id = s.id and x.status = 'pending')) order by s.date desc, s.start_time desc), '[]')
  from shifts s where s.contractor_id = me $$;

create or replace function api_applicants(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin
  if not _can_manage((a->>0)::bigint, me, 'applications') then perform _fail('forbidden', 'Нет доступа'); end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object('worker', _worker_json(x.worker_id)) order by x.created_at desc), '[]') from applications x where x.shift_id = (a->>0)::bigint);
end $$;

-- Принятие/отказ: блокировка строки смены => нельзя принять больше, чем нужно людей, даже при гонке запросов
create or replace function api_decide(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare ap applications; s shifts; d text := a->>1; cnt int;
begin
  select * into ap from applications where id = (a->>0)::bigint; if not found then perform _fail('not_found', 'Заявка не найдена'); end if;
  select * into s from shifts where id = ap.shift_id for update;
  if not _can_manage(s.id, me, 'applications') then perform _fail('forbidden', 'Нет доступа'); end if;
  if d not in ('accepted','rejected') then perform _fail('invalid', 'Некорректное решение'); end if;
  if ap.status = d then return to_jsonb(ap); end if;
  if ap.status <> 'pending' then perform _fail('conflict', 'Заявка уже обработана'); end if;
  if d = 'accepted' then
    if s.status <> 'open' then perform _fail('closed', 'Смена закрыта'); end if;
    select count(*) into cnt from shift_members where shift_id = s.id and role <> 'owner';
    if cnt >= s.people then perform _fail('full', 'Все места заняты'); end if;
    insert into shift_members(shift_id, user_id, role) values (s.id, ap.worker_id, 'worker') on conflict do nothing;
    if cnt + 1 >= s.people then update shifts set status = 'full' where id = s.id; end if;
    perform _notify(ap.worker_id, 'accepted', format('Вас приняли: «%s». Вы в команде смены', s.title), '#/team/' || s.id);
  else perform _notify(ap.worker_id, 'rejected', format('Отклик отклонён: «%s»', s.title), '#/w/mine'); end if;
  update applications set status = d, updated_at = now() where id = ap.id returning * into ap;
  insert into audit_log(actor, action, meta) values (me, 'application.' || d, jsonb_build_object('id', ap.id));
  return to_jsonb(ap);
end $$;

create or replace function api_cancelShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare s shifts; ap record;
begin
  select * into s from shifts where id = (a->>0)::bigint for update;
  if not found or s.contractor_id <> me then perform _fail('forbidden', 'Нет доступа'); end if;
  if s.status in ('cancelled','completed') then return _shift_json(s, me); end if;
  update shifts set status = 'cancelled' where id = s.id returning * into s;
  for ap in update applications set status = 'cancelled', updated_at = now() where shift_id = s.id and status in ('pending','accepted') returning worker_id loop
    perform _notify(ap.worker_id, 'shift_cancelled', format('Смена отменена: «%s»', s.title), '#/w/mine'); end loop;
  insert into audit_log(actor, action, meta) values (me, 'shift.cancel', jsonb_build_object('id', s.id));
  return _shift_json(s, me);
end $$;

create or replace function api_completeShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare s shifts; ap record;
begin
  select * into s from shifts where id = (a->>0)::bigint for update;
  if not found or s.contractor_id <> me then perform _fail('forbidden', 'Нет доступа'); end if;
  if s.status not in ('open','full') then return _shift_json(s, me); end if;
  update shifts set status = 'completed', completed_at = now() where id = s.id returning * into s;
  update applications set status = 'rejected', updated_at = now() where shift_id = s.id and status = 'pending';
  for ap in update applications set status = 'completed', updated_at = now() where shift_id = s.id and status = 'accepted' returning worker_id loop
    perform _notify(ap.worker_id, 'shift_completed', format('Смена завершена: «%s». Оцените подрядчика', s.title), '#/review/' || s.id); end loop;
  insert into audit_log(actor, action, meta) values (me, 'shift.complete', jsonb_build_object('id', s.id));
  return _shift_json(s, me);
end $$;

create or replace function _assert_chat(me bigint, scope text) returns void language plpgsql stable as $$
declare ap applications;
begin
  if scope like 'shift:%' then
    if not exists (select 1 from shift_members where shift_id = substr(scope, 7)::bigint and user_id = me) then perform _fail('forbidden', 'Вы не в команде смены'); end if;
  elsif scope like 'dm:%' then
    select * into ap from applications where id = substr(scope, 4)::bigint;
    if not found then perform _fail('not_found', 'Не найдено'); end if;
    if me <> ap.worker_id and me <> (select contractor_id from shifts where id = ap.shift_id) then perform _fail('forbidden', 'Нет доступа'); end if;
  else perform _fail('invalid', 'Некорректный чат'); end if;
end $$;

create or replace function _msg_json(m messages) returns jsonb language sql stable as $$
  select to_jsonb(m) || jsonb_build_object('at', (extract(epoch from m.created_at) * 1000)::bigint,
    'name', coalesce((select c.name from contractor_profiles c where c.user_id = m.user_id and (m.scope like 'dm:%' and m.user_id = (select s.contractor_id from applications x join shifts s on s.id = x.shift_id where x.id = substr(m.scope,4)::bigint) or m.scope like 'shift:%' and exists (select 1 from shift_members sm where sm.shift_id = substr(m.scope,7)::bigint and sm.user_id = m.user_id and sm.role = 'owner'))),
                     (select w.name from worker_profiles w where w.user_id = m.user_id), 'Пользователь'),
    'role', case when m.scope like 'shift:%' then coalesce((select sm.role from shift_members sm where sm.shift_id = substr(m.scope,7)::bigint and sm.user_id = m.user_id), 'worker')
                 else case when m.user_id = (select s.contractor_id from applications x join shifts s on s.id = x.shift_id where x.id = substr(m.scope,4)::bigint) then 'owner' else 'worker' end end) $$;

create or replace function api_messages(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _assert_chat(me, a->>0);
  return (select coalesce(jsonb_agg(_msg_json(m) order by m.id), '[]') from messages m where m.scope = a->>0 and m.id > coalesce((a->>1)::bigint, 0)); end $$;

create or replace function api_sendMessage(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare m messages; t text := trim(coalesce(a->>1,'')); k text := a->>2; r jsonb;
begin
  perform _assert_chat(me, a->>0);
  if t = '' or length(t) > 2000 then perform _fail('invalid', 'Некорректное сообщение'); end if;
  if k is not null then select result into r from idempotency_keys where user_id = me and key = k; if found then return r; end if; end if;
  insert into messages(scope, user_id, text) values (a->>0, me, t) returning * into m;
  insert into notifications(user_id, type, text, link)
  select r2.uid, 'message', 'Новое сообщение в чате', case when a->>0 like 'shift:%' then '#/team/' || substr(a->>0, 7) else '#/chat/' || substr(a->>0, 4) end
  from (select user_id as uid from shift_members where a->>0 like 'shift:%' and shift_id = substr(a->>0, 7)::bigint
        union select x.worker_id from applications x where a->>0 like 'dm:%' and x.id = substr(a->>0, 4)::bigint
        union select s.contractor_id from applications x join shifts s on s.id = x.shift_id where a->>0 like 'dm:%' and x.id = substr(a->>0, 4)::bigint) r2
  where r2.uid <> me and not exists (select 1 from notifications n where n.user_id = r2.uid and n.type = 'message' and not n.read and n.link = case when a->>0 like 'shift:%' then '#/team/' || substr(a->>0, 7) else '#/chat/' || substr(a->>0, 4) end);
  r := _msg_json(m);
  if k is not null then insert into idempotency_keys(user_id, key, result) values (me, k, r) on conflict do nothing; end if;
  return r;
end $$;

create or replace function api_submitReview(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; s shifts; sid bigint := (p->>'shift_id')::bigint; tu bigint := (p->>'to_user')::bigint;
begin
  select * into s from shifts where id = sid; if not found then perform _fail('not_found', 'Смена не найдена'); end if;
  if s.status <> 'completed' then perform _fail('closed', 'Оценка доступна после завершения смены'); end if;
  if me = tu or not exists (select 1 from shift_members where shift_id = sid and user_id = me) or not exists (select 1 from shift_members where shift_id = sid and user_id = tu) then perform _fail('forbidden', 'Нет доступа'); end if;
  if me <> s.contractor_id and tu <> s.contractor_id then perform _fail('forbidden', 'Исполнитель оценивает только подрядчика'); end if;
  if coalesce((p->>'stars')::int, 0) not between 1 and 5 then perform _fail('invalid', 'Поставьте оценку'); end if;
  insert into reviews(shift_id, from_user, to_user, stars, criteria, text) values (sid, me, tu, (p->>'stars')::int, coalesce(p->'criteria','{}'), left(p->>'text', 1000)) on conflict do nothing;
  if not found then return '{"duplicate":true}'; end if;
  perform _notify(tu, 'review', 'Вам поставили оценку', case when tu = s.contractor_id then '#/c/profile' else '#/w/profile' end);
  return '{"ok":true}';
end $$;

create or replace function api_notifications(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(n) || jsonb_build_object('at', (extract(epoch from n.created_at) * 1000)::bigint) order by n.id desc), '[]') from (select * from notifications where user_id = me order by id desc limit 100) n $$;
create or replace function api_markRead(me bigint, a jsonb) returns jsonb language sql as $$ with u as (update notifications set read = true where user_id = me and not read returning 1) select to_jsonb(true) $$;
create or replace function api_report(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; begin
  if length(trim(coalesce(p->>'reason',''))) < 3 then perform _fail('invalid', 'Опишите причину'); end if;
  insert into reports(reporter, target_type, target_id, reason) values (me, p->>'target_type', (p->>'target_id')::bigint, left(p->>'reason', 1000)); return 'true'; end $$;
create or replace function api_track(me bigint, a jsonb) returns jsonb language sql as $$ insert into events(user_id, event, props) values (me, a->>0, a->1) returning 'true'::jsonb $$;
create or replace function api_logError(me bigint, a jsonb) returns jsonb language sql as $$ insert into events(user_id, event, props) values (me, 'error', a->0) returning 'true'::jsonb $$;

-- Диспетчер. Список методов — белый список; не реализованное на сервере возвращает not_implemented.
create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','apply','undoApply','myApplications','createShift','myShifts',
    'applicants','decide','cancelShift','completeShift','messages','sendMessage','submitReview','notifications','markRead','report','track','logError'];
begin
  if not (fn = any(allowed)) then perform _fail('not_implemented', 'Метод ещё не реализован на сервере: ' || fn); end if;
  execute format('select public.%I($1,$2)', 'api_' || fn) into r using me, coalesce(args, '[]'::jsonb);
  return r;
end $$;
revoke all on function public.api(text, jsonb) from public, anon;
grant execute on function public.api(text, jsonb) to authenticated;

-- ВАЖНО: внутренние функции (api_*, _*) нельзя вызывать напрямую через REST — иначе можно подставить чужой user id.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
