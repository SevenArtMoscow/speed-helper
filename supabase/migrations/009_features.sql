-- Новые возможности (по пожеланиям владельца):
--  • смена: оплата «в час» или «за смену», время «до выполнения задачи» (без окончания), регион «Москва / Московская область»;
--  • отложенные смены (закладки исполнителя);
--  • необязательные отзывы (можно пропустить);
--  • админ чата («старший» с правом работать с откликами) получает уведомления об откликах и может их принимать;
--  • личные чаты показываются по текущей роли (подрядчик не видит чаты «как исполнитель» и наоборот);
--  • «Мои исполнители» подрядчика, активные задания в профиле исполнителя;
--  • рейтинг исполнителей (месяц / всё время) с очками.

-- ----- колонки и таблицы -----
alter table shifts add column if not exists until_done boolean not null default false;
alter table shifts add column if not exists pay_type text not null default 'shift' check (pay_type in ('shift','hour'));
alter table shifts add column if not exists region text not null default 'msk' check (region in ('msk','mo'));

create table if not exists shift_favs (
  user_id bigint not null references users(id) on delete cascade, shift_id bigint not null references shifts(id) on delete cascade,
  created_at timestamptz not null default now(), primary key (user_id, shift_id));
create table if not exists review_skips (
  user_id bigint not null references users(id) on delete cascade, shift_id bigint not null references shifts(id) on delete cascade,
  to_user bigint not null references users(id) on delete cascade, primary key (user_id, shift_id, to_user));

-- ----- регион -----
create or replace function _region_of(lat double precision, lng double precision) returns text language sql immutable as $$
  select case when lat is null or lng is null then 'msk'
    when 6371 * 2 * asin(sqrt(sin(radians(lat - 55.7558) / 2) ^ 2 + cos(radians(55.7558)) * cos(radians(lat)) * sin(radians(lng - 37.6173) / 2) ^ 2)) > 30 then 'mo' else 'msk' end $$;
update shifts set region = _region_of(lat, lng);

-- ----- сумма и время -----
create or replace function _shift_hours(s shifts) returns numeric language sql immutable as $$
  select case when s.until_done then 8::numeric
    else greatest(1, extract(epoch from (case when s.end_time > s.start_time then s.end_time - s.start_time else s.end_time - s.start_time + interval '24 hours' end)) / 3600) end $$;
-- оценка суммы за смену: для почасовой — ставка × часы (для «до выполнения задачи» — 8 часов)
create or replace function _shift_total(s shifts) returns int language sql immutable as $$
  select case when s.pay_type = 'hour' then round(s.pay * _shift_hours(s))::int else s.pay end $$;

create or replace function _shift_ended(s shifts) returns boolean language sql stable as $$
  select case when s.until_done then (s.date + 1)::timestamp <= localtimestamp
    else (s.date::timestamp + s.start_time + case when s.end_time > s.start_time then s.end_time - s.start_time else s.end_time - s.start_time + interval '24 hours' end) <= localtimestamp end $$;

create or replace function _shift_json(s shifts, me bigint, olat double precision default null, olng double precision default null) returns jsonb language plpgsql stable as $$
declare j jsonb; a applications;
begin
  j := jsonb_build_object('id', s.id, 'contractor_id', s.contractor_id, 'title', s.title, 'category_id', s.category_id, 'category_name', (select name from categories where id = s.category_id),
    'description', s.description, 'address', s.address, 'lat', s.lat, 'lng', s.lng, 'date', s.date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'),
    'pay', s.pay, 'people', s.people, 'requirements', to_jsonb(s.requirements), 'status', s.status, 'hidden', s.hidden,
    'until_done', s.until_done, 'pay_type', s.pay_type, 'region', s.region, 'total', _shift_total(s),
    'saved', exists (select 1 from shift_favs v where v.shift_id = s.id and v.user_id = me),
    'contractor', _contractor_json(s.contractor_id), 'accepted_count', (select count(*) from shift_members m where m.shift_id = s.id and m.role <> 'owner'));
  if olat is not null and s.lat is not null then
    j := j || jsonb_build_object('distance_km', 6371 * 2 * asin(sqrt(sin(radians(s.lat - olat) / 2) ^ 2 + cos(radians(olat)) * cos(radians(s.lat)) * sin(radians(s.lng - olng) / 2) ^ 2)));
  end if;
  select * into a from applications where shift_id = s.id and worker_id = me;
  if found then j := j || jsonb_build_object('my_status', a.status, 'my_application_id', a.id); end if;
  return j;
end $$;

-- ----- лента: регион вместо радиуса, «любая» = Москва + область; отложенные в ленту не попадают -----
create or replace function api_feed(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare f jsonb := coalesce(a->0, '{}'); off int := coalesce((f->>'offset')::int, 0); lim int := least(coalesce((f->>'limit')::int, 20), 200);
  geo text := coalesce(f->>'geo', 'any'); minpay int := coalesce(_int(f->>'min_pay'), 0);
  cats int[] := coalesce(array(select jsonb_array_elements_text(coalesce(f->'categories','[]'))::int), '{}'); res jsonb; v_total int;
begin
  with base as (
    select s.id, s.date as d, s.start_time as st
    from shifts s
    where s.status = 'open' and not s.hidden and s.contractor_id <> me and s.date >= current_date and not _shift_ended(s)
      and not exists (select 1 from applications x where x.shift_id = s.id and x.worker_id = me)
      and (coalesce((f->>'include_skipped')::boolean, false) or not exists (select 1 from skips k where k.shift_id = s.id and k.user_id = me))
      and (coalesce((f->>'include_saved')::boolean, false) or not exists (select 1 from shift_favs v where v.shift_id = s.id and v.user_id = me))
      and (geo not in ('msk','mo') or s.region = geo)
      and (coalesce(f->>'date','any') = 'any' or (f->>'date' = 'today' and s.date = current_date) or (f->>'date' = 'tomorrow' and s.date = current_date + 1) or (f->>'date' = 'weekend' and extract(isodow from s.date) in (6,7)))
      and _shift_total(s) >= minpay and (cardinality(cats) = 0 or s.category_id = any(cats))
      and (f->>'similar_to' is null or s.category_id = (select category_id from shifts where id = (f->>'similar_to')::bigint))
  ), filt as (select *, count(*) over () as tot from base),
  page as (select * from filt order by d, st, id desc limit lim offset off)
  select coalesce(jsonb_agg(_shift_json(s, me) order by p.d, p.st, p.id desc), '[]'), coalesce((select max(tot) from filt), 0)
    into res, v_total from page p join shifts s on s.id = p.id;
  return jsonb_build_object('items', res, 'total', v_total, 'next', case when off + lim < v_total then off + lim end);
end $$;

-- ----- создание и изменение смены -----
create or replace function api_createShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; k text := a->>1; s shifts; r jsonb;
  cat int := _int(p->>'category_id'); d date := _date(p->>'date'); st time := _time(p->>'start'); en time := _time(p->>'end'); pay int := _int(p->>'pay'); ppl int := _int(p->>'people');
  ud boolean := coalesce((p->>'until_done')::boolean, false); pt text := coalesce(nullif(p->>'pay_type', ''), 'shift'); reg text; lat float := (p->>'lat')::float; lng float := (p->>'lng')::float;
begin
  if not exists (select 1 from contractor_profiles where user_id = me) then perform _fail('profile_required', 'Сначала заполните профиль подрядчика'); end if;
  if k is not null then select result into r from idempotency_keys where user_id = me and key = k; if found then return r; end if; end if;
  if length(trim(coalesce(p->>'title',''))) < 3 then perform _fail('invalid', 'Укажите название смены'); end if;
  if cat is null or not exists (select 1 from categories where id = cat and active) then perform _fail('invalid', 'Выберите категорию'); end if;
  if length(trim(coalesce(p->>'address',''))) < 3 then perform _fail('invalid', 'Укажите адрес'); end if;
  if lat is not null and lng is not null and not (lat between 54.2 and 57.0 and lng between 34.7 and 40.3) then perform _fail('invalid', 'Мы работаем только в Москве и Московской области'); end if;
  if d is null then perform _fail('invalid', 'Укажите дату'); end if;
  if d < current_date then perform _fail('invalid', 'Дата не может быть в прошлом'); end if;
  if pt not in ('shift','hour') then perform _fail('invalid', 'Некорректный тип оплаты'); end if;
  if st is null then perform _fail('invalid', 'Укажите время начала'); end if;
  if ud then en := '23:59'; else
    if en is null then perform _fail('invalid', 'Укажите время окончания или «до выполнения задачи»'); end if;
    if st = en then perform _fail('invalid', 'Время начала и окончания совпадает'); end if;
  end if;
  if (case when ud then (d + 1)::timestamp else d::timestamp + st + case when en > st then en - st else en - st + interval '24 hours' end end) <= localtimestamp then perform _fail('invalid', 'Время смены уже прошло — выберите другое время или дату'); end if;
  if coalesce(pay, 0) not between 1 and 1000000 then perform _fail('invalid', 'Укажите оплату (до 1 000 000 ₽)'); end if;
  if coalesce(ppl, 0) not between 1 and 500 then perform _fail('invalid', 'Укажите количество людей (1–500)'); end if;
  reg := case when p->>'region' in ('msk','mo') then p->>'region' else _region_of(lat, lng) end;
  insert into shifts(contractor_id, title, category_id, description, address, lat, lng, date, start_time, end_time, pay, people, requirements, until_done, pay_type, region)
  values (me, trim(p->>'title'), cat, coalesce(p->>'description',''), trim(p->>'address'), lat, lng, d,
    st, en, pay, ppl, coalesce(array(select jsonb_array_elements_text(coalesce(p->'requirements','[]'))), '{}'), ud, pt, reg) returning * into s;
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

create or replace function api_updateShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare s shifts; o shifts; p jsonb := a->1; acc int; changed boolean; ap record;
begin
  select * into s from shifts where id = (a->>0)::bigint for update;
  if not found or s.contractor_id <> me then perform _fail('forbidden', 'Только владелец смены'); end if;
  if s.status not in ('open','full') then perform _fail('closed', 'Смену уже нельзя изменить'); end if;
  o := s;
  select count(*) into acc from shift_members where shift_id = s.id and role <> 'owner';
  if p ? 'pay' then s.pay := _int(p->>'pay'); end if;
  if p ? 'pay_type' then if p->>'pay_type' not in ('shift','hour') then perform _fail('invalid', 'Некорректный тип оплаты'); end if; s.pay_type := p->>'pay_type'; end if;
  if p ? 'people' then s.people := _int(p->>'people'); end if;
  if p ? 'start' then s.start_time := _time(p->>'start'); end if;
  if p ? 'end' then s.end_time := _time(p->>'end'); end if;
  if p ? 'until_done' then s.until_done := coalesce((p->>'until_done')::boolean, false); end if;
  if s.until_done then s.end_time := '23:59'; end if;
  if p ? 'description' then s.description := coalesce(p->>'description', ''); end if;
  if p ? 'requirements' then s.requirements := coalesce(array(select jsonb_array_elements_text(p->'requirements')), '{}'); end if;
  if coalesce(s.pay, 0) not between 1 and 1000000 then perform _fail('invalid', 'Укажите оплату (до 1 000 000 ₽)'); end if;
  if coalesce(s.people, 0) not between 1 and 500 then perform _fail('invalid', 'Укажите количество людей (1–500)'); end if;
  if s.start_time is null or s.end_time is null then perform _fail('invalid', 'Укажите время начала и окончания'); end if;
  if not s.until_done and s.start_time = s.end_time then perform _fail('invalid', 'Время начала и окончания совпадает'); end if;
  if s.people < acc then perform _fail('invalid', format('Уже принято %s чел. — нельзя указать меньше', acc)); end if;
  changed := (s.pay, s.pay_type, s.people, s.start_time, s.end_time, s.until_done, s.requirements) is distinct from (o.pay, o.pay_type, o.people, o.start_time, o.end_time, o.until_done, o.requirements);
  update shifts set pay = s.pay, pay_type = s.pay_type, people = s.people, start_time = s.start_time, end_time = s.end_time, until_done = s.until_done, description = s.description, requirements = s.requirements,
    status = case when acc >= s.people then 'full' else 'open' end where id = s.id returning * into s;
  if changed then
    for ap in select worker_id from applications where shift_id = s.id and status in ('pending','accepted') loop
      perform _notify(ap.worker_id, 'shift_updated', format('Условия смены обновлены: «%s»', s.title), '#/w/shift/' || s.id); end loop;
  end if;
  insert into audit_log(actor, action, meta) values (me, 'shift.update', jsonb_build_object('id', s.id));
  return _shift_json(s, me);
end $$;

-- ----- отклик: отложенная смена снимается с закладок, админы чата получают уведомление -----
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
  if _shift_ended(s) then perform _fail('closed', 'Время смены уже прошло'); end if;
  insert into applications(shift_id, worker_id) values (s.id, me) on conflict (shift_id, worker_id) do nothing returning * into n;
  if n.id is null then select * into n from applications where shift_id = s.id and worker_id = me; return to_jsonb(n) || '{"duplicate":true}'; end if;
  perform _notify(s.contractor_id, 'new_application', format('Новый отклик: %s — «%s»', wname, s.title), '#/c/shift/' || s.id);
  insert into notifications(user_id, type, text, link)
    select m.user_id, 'new_application', format('Новый отклик: %s — «%s»', wname, s.title), '#/c/shift/' || s.id
    from shift_members m where m.shift_id = s.id and m.role = 'senior' and 'applications' = any(m.perms) and m.user_id <> me;
  delete from skips where user_id = me and shift_id = s.id;
  delete from shift_favs where user_id = me and shift_id = s.id;
  return to_jsonb(n);
end $$;

-- ----- отложенные смены -----
create or replace function api_toggleShiftFav(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare sid bigint := (a->>0)::bigint;
begin
  if not exists (select 1 from shifts where id = sid) then perform _fail('not_found', 'Смена не найдена'); end if;
  delete from shift_favs where user_id = me and shift_id = sid;
  if found then return 'false'; end if;
  insert into shift_favs(user_id, shift_id) values (me, sid);
  delete from skips where user_id = me and shift_id = sid;
  return 'true';
end $$;

create or replace function api_savedShifts(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(_shift_json(s, me) order by v.created_at desc), '[]')
  from shift_favs v join shifts s on s.id = v.shift_id
  where v.user_id = me and s.status = 'open' and not s.hidden and not _shift_ended(s)
    and not exists (select 1 from applications x where x.shift_id = s.id and x.worker_id = me) $$;

-- ----- отзывы можно пропустить -----
create or replace function api_pendingReviews(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('shift', _shift_json(s, me), 'to_user', t.uid, 'to_role', case when t.uid = s.contractor_id then 'contractor' else 'worker' end,
    'to_name', coalesce((select name from contractor_profiles where user_id = t.uid), (select name from worker_profiles where user_id = t.uid)),
    'to_avatar', coalesce((select avatar from worker_profiles where user_id = t.uid), (select avatar from contractor_profiles where user_id = t.uid)))), '[]')
  from shifts s join shift_members me_m on me_m.shift_id = s.id and me_m.user_id = me
  cross join lateral (select case when me = s.contractor_id then m2.user_id else s.contractor_id end as uid from shift_members m2 where m2.shift_id = s.id and (me <> s.contractor_id and m2.role = 'owner' or me = s.contractor_id and m2.role <> 'owner')) t
  where s.status = 'completed' and not exists (select 1 from reviews r where r.shift_id = s.id and r.from_user = me and r.to_user = t.uid)
    and not exists (select 1 from review_skips k where k.shift_id = s.id and k.user_id = me and k.to_user = t.uid) $$;

-- skipReview(shift_id, to_user?) — без to_user пропускаются все оценки по смене
create or replace function api_skipReview(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare sid bigint := (a->>0)::bigint; r jsonb;
begin
  for r in select x from jsonb_array_elements(api_pendingReviews(me, '[]')) x where (x->'shift'->>'id')::bigint = sid and (a->>1 is null or (x->>'to_user')::bigint = (a->>1)::bigint) loop
    insert into review_skips(user_id, shift_id, to_user) values (me, sid, (r->>'to_user')::bigint) on conflict do nothing;
  end loop;
  return 'true';
end $$;

-- ----- личные чаты — по текущей роли -----
create or replace function api_myDialogs(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('app_id', x.id, 'last', _msg_json(l), 'info', api_dmInfo(me, jsonb_build_array(x.id))) order by l.id desc), '[]')
  from applications x join shifts s on s.id = x.shift_id
  join lateral (select * from messages m where m.scope = 'dm:' || x.id order by m.id desc limit 1) l on true
  where case a->>0 when 'contractor' then s.contractor_id = me when 'worker' then x.worker_id = me else (x.worker_id = me or s.contractor_id = me) end $$;

-- ----- мои исполнители (подрядчик) -----
create or replace function api_myWorkers(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(_worker_json(x.uid) || jsonb_build_object('together', x.n) order by x.n desc, x.last desc), '[]')
  from (select ap.worker_id as uid, count(*) as n, max(ap.updated_at) as last from applications ap join shifts s on s.id = ap.shift_id
        where s.contractor_id = me and ap.status in ('accepted','completed') group by ap.worker_id) x
  join worker_profiles w on w.user_id = x.uid $$;

-- ----- профиль исполнителя: активные задания (видны ему самому, подрядчику с его откликом и участникам общих команд) -----
create or replace function api_workerPage(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare wid bigint := (a->>0)::bigint; rel boolean; act jsonb; cnt int;
begin
  if not exists (select 1 from worker_profiles where user_id = wid) then perform _fail('not_found', 'Исполнитель не найден'); end if;
  rel := exists (select 1 from applications x join shifts s on s.id = x.shift_id where x.worker_id = wid and s.contractor_id = me);
  -- число активных заданий видно всем; список — только самому исполнителю и тем, кто связан со сменой (её подрядчик или участник команды)
  select count(*), coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'date', s.date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'), 'until_done', s.until_done) order by s.date, s.start_time)
      filter (where me = wid or s.contractor_id = me or exists (select 1 from shift_members mm where mm.shift_id = s.id and mm.user_id = me)), '[]')
    into cnt, act
  from applications x join shifts s on s.id = x.shift_id
  where x.worker_id = wid and x.status = 'accepted' and s.status in ('open','full') and not _shift_ended(s);
  return jsonb_build_object('worker', _worker_json(wid, rel), 'reviews', _reviews_as(wid, 'worker'), 'is_fav', exists (select 1 from favorites where user_id = me and target_id = wid),
    'active_count', cnt,
    'active', act);
end $$;

-- ----- рейтинг исполнителей: 10 очков за проведённую смену + 2 очка за каждую звезду отзывов (за период) -----
create or replace function api_leaderboard(me bigint, a jsonb) returns jsonb language sql stable as $$
  with p as (select case when a->>0 = 'all' then 'all' else 'month' end as per,
                    case when a->>0 = 'all' then '-infinity'::timestamptz else date_trunc('month', now()) end as since),
  done as (
    select ap.worker_id as uid, count(*) as n from applications ap join shifts s on s.id = ap.shift_id, p
    where ap.status = 'completed' and s.completed_at >= p.since
      and not exists (select 1 from shift_members m where m.shift_id = ap.shift_id and m.user_id = ap.worker_id and m.attended is false) group by ap.worker_id),
  rv as (
    select r.to_user as uid, sum(r.stars) as st, avg(r.stars) as av, count(*) as n from reviews r join shifts s on s.id = r.shift_id, p
    where s.contractor_id <> r.to_user and r.created_at >= p.since group by r.to_user),
  sc as (
    select w.user_id as uid, w.name, w.avatar, coalesce(d.n, 0) as shifts, coalesce(rv.st, 0) as stars, round(rv.av, 1) as av, coalesce(d.n, 0) * 10 + coalesce(rv.st, 0) * 2 as score
    from worker_profiles w left join done d on d.uid = w.user_id left join rv on rv.uid = w.user_id
    where coalesce(d.n, 0) > 0 or coalesce(rv.n, 0) > 0),
  ranked as (select *, rank() over (order by score desc, shifts desc, uid) as rk from sc)
  select jsonb_build_object('period', (select per from p),
    'top', coalesce((select jsonb_agg(jsonb_build_object('rank', t.rk, 'user_id', t.uid, 'name', t.name, 'avatar', t.avatar, 'score', t.score, 'shifts', t.shifts, 'rating', t.av) order by t.rk, t.uid)
                     from (select * from ranked order by rk, uid limit 20) t), '[]'),
    'me', (select jsonb_build_object('rank', r.rk, 'score', r.score, 'shifts', r.shifts, 'rating', r.av) from ranked r where r.uid = me),
    'participants', (select count(*) from ranked)) $$;

-- ----- удаление аккаунта: + закладки и пропуски отзывов -----
create or replace function api_deleteAccount(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare s shifts; ap record;
begin
  if exists (select 1 from users where id = me and is_admin) then perform _fail('forbidden', 'Аккаунт администратора удалить нельзя'); end if;
  for s in select * from shifts where contractor_id = me and status in ('open','full') loop
    perform api_cancelShift(me, jsonb_build_array(s.id));
  end loop;
  for ap in select id from applications where worker_id = me and status in ('pending','accepted') loop
    perform api_withdraw(me, jsonb_build_array(ap.id));
  end loop;
  delete from shift_members where user_id = me and role <> 'owner' and shift_id in (select id from shifts where status in ('open','full'));
  delete from worker_profiles where user_id = me;
  delete from contractor_profiles where user_id = me;
  delete from favorites where user_id = me or target_id = me;
  delete from skips where user_id = me;
  delete from shift_favs where user_id = me;
  delete from review_skips where user_id = me or to_user = me;
  delete from notifications where user_id = me;
  update messages set text = '[сообщение удалено]', pinned = false where user_id = me;
  update reviews set text = null where from_user = me;
  update users set first_name = null, username = null, roles = '{}', terms_accepted_at = null, deleted_at = now() where id = me;
  insert into audit_log(actor, action, meta) values (me, 'account.delete', '{}');
  return 'true';
end $$;

-- ----- диспетчер -----
create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','mySkips','unskipAll','apply','undoApply','withdraw','myApplications',
    'toggleFav','favorites','favIds','contractorPage','workerPage','createShift','myShifts','contractorStats','updateShift','cancelShift','completeShift','applicants','decide',
    'team','myTeams','setSenior','removeMember','setAttendance','messages','sendMessage','pinMessage','dmInfo','myDialogs','pendingReviews','submitReview','skipReview',
    'toggleShiftFav','savedShifts','myWorkers','leaderboard',
    'notifications','markRead','report','track','logError','acceptTerms','deleteAccount',
    'adminStats','adminUsers','adminBlock','adminVerify','adminShifts','adminHideShift','adminReports','adminResolveReport','adminCategories','adminSaveCategory','adminAudit'];
begin
  if not (fn = any(allowed)) then perform _fail('not_implemented', 'Неизвестный метод: ' || fn); end if;
  execute format('select public.%I($1,$2)', lower('api_' || fn)) into r using me, coalesce(args, '[]'::jsonb);
  return r;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
