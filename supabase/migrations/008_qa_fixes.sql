-- Исправления по итогам полного QA.
--  1) рейтинг и отзывы считаются отдельно для роли подрядчика и роли исполнителя (раньше у человека с двумя ролями они смешивались);
--  2) смены, время которых уже прошло, не попадают в ленту и на них нельзя откликнуться; нельзя создать смену с уже прошедшим временем;
--  3) принятие отклика при полной команде отвечает «Все места заняты», а не «Смена закрыта»;
--  4) отмена отклика (↺) убирает уведомление подрядчику, чтобы он не получал дубль при повторном отклике;
--  5) отклики, не рассмотренные к завершению смены, получают уведомление;
--  6) чат: при открытии грузятся последние 300 сообщений, закреплённое сообщение запрашивается отдельно (messages(scope, 0, 'pin'));
--  7) «проведено смен» у исполнителя не включает смены, где он отмечен «не пришёл».

-- ----- 1. рейтинг по ролям -----
create or replace function _rating_as(uid bigint, as_role text) returns jsonb language sql stable as $$
  select jsonb_build_object('rating', round(avg(r.stars)::numeric, 1), 'reviews', count(*))
  from reviews r join shifts s on s.id = r.shift_id
  where r.to_user = uid and ((s.contractor_id = uid) = (as_role = 'contractor')) $$;

create or replace function _contractor_json(cid bigint) returns jsonb language sql stable as $$
  select jsonb_build_object('id', c.user_id, 'name', c.name, 'company', c.company, 'avatar', c.avatar, 'about', c.about, 'city', c.city, 'verified', c.verified,
    'shifts_done', (select count(*) from shifts s where s.contractor_id = c.user_id and s.status = 'completed')) || _rating_as(c.user_id, 'contractor')
  from contractor_profiles c where c.user_id = cid $$;

create or replace function _worker_json(uid bigint, with_phone boolean default false) returns jsonb language sql stable as $$
  select jsonb_build_object('user_id', w.user_id, 'name', w.name, 'avatar', w.avatar, 'city', w.city, 'age', w.age, 'skills', to_jsonb(w.skills), 'percent', _percent(w),
    'verified', _percent(w) >= 80,
    'shifts_done', (select count(*) from applications a where a.worker_id = w.user_id and a.status = 'completed'
                    and not exists (select 1 from shift_members m where m.shift_id = a.shift_id and m.user_id = a.worker_id and m.attended is false)),
    'about', w.about, 'experience', w.experience, 'license', to_jsonb(w.license), 'medbook', w.medbook, 'selfemployed', w.selfemployed, 'night', w.night, 'tools', w.tools)
    || case when with_phone then jsonb_build_object('phone', w.phone) else '{}'::jsonb end || _rating_as(w.user_id, 'worker')
  from worker_profiles w where w.user_id = uid $$;

create or replace function _reviews_as(uid bigint, as_role text) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('at', (extract(epoch from r.created_at) * 1000)::bigint,
    'from_name', coalesce((select name from contractor_profiles where user_id = r.from_user), (select name from worker_profiles where user_id = r.from_user))) order by r.id desc), '[]')
  from (select rv.* from reviews rv join shifts s on s.id = rv.shift_id where rv.to_user = uid and ((s.contractor_id = uid) = (as_role = 'contractor')) order by rv.id desc limit 10) r $$;

-- ----- 2. прошедшие смены -----
create or replace function _shift_ended(s shifts) returns boolean language sql stable as $$
  select (s.date::timestamp + s.start_time + case when s.end_time > s.start_time then s.end_time - s.start_time else s.end_time - s.start_time + interval '24 hours' end) <= localtimestamp $$;

create or replace function api_feed(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare f jsonb := coalesce(a->0, '{}'); olat double precision := coalesce((f->>'lat')::float, 55.7558); olng double precision := coalesce((f->>'lng')::float, 37.6173);
  off int := coalesce((f->>'offset')::int, 0); lim int := least(coalesce((f->>'limit')::int, 20), 200); rad float := (f->>'radius_km')::float;
  cats int[] := coalesce(array(select jsonb_array_elements_text(coalesce(f->'categories','[]'))::int), '{}'); res jsonb; v_total int;
begin
  with base as (
    select s.id, s.date as d, s.start_time as st,
      case when s.lat is null then null else 6371 * 2 * asin(sqrt(sin(radians(s.lat - olat) / 2) ^ 2 + cos(radians(olat)) * cos(radians(s.lat)) * sin(radians(s.lng - olng) / 2) ^ 2)) end as dist
    from shifts s
    where s.status = 'open' and not s.hidden and s.contractor_id <> me and s.date >= current_date and not _shift_ended(s)
      and not exists (select 1 from applications x where x.shift_id = s.id and x.worker_id = me)
      and (coalesce((f->>'include_skipped')::boolean, false) or not exists (select 1 from skips k where k.shift_id = s.id and k.user_id = me))
      and (coalesce(f->>'date','any') = 'any' or (f->>'date' = 'today' and s.date = current_date) or (f->>'date' = 'tomorrow' and s.date = current_date + 1) or (f->>'date' = 'weekend' and extract(isodow from s.date) in (6,7)))
      and s.pay >= coalesce((f->>'min_pay')::int, 0) and (cardinality(cats) = 0 or s.category_id = any(cats))
      and (f->>'similar_to' is null or s.category_id = (select category_id from shifts where id = (f->>'similar_to')::bigint))
  ), filt as (select *, count(*) over () as tot from base where rad is null or dist is null or dist <= rad),
  page as (select * from filt order by d, st, id desc limit lim offset off)
  select coalesce(jsonb_agg(_shift_json(s, me, olat, olng) order by p.d, p.st, p.id desc), '[]'), coalesce((select max(tot) from filt), 0)
    into res, v_total from page p join shifts s on s.id = p.id;
  return jsonb_build_object('items', res, 'total', v_total, 'next', case when off + lim < v_total then off + lim end);
end $$;

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
  delete from skips where user_id = me and shift_id = s.id;
  return to_jsonb(n);
end $$;

create or replace function api_mySkips(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(_shift_json(s, me) || jsonb_build_object('skipped_at', (extract(epoch from k.created_at) * 1000)::bigint) order by k.created_at desc), '[]')
  from skips k join shifts s on s.id = k.shift_id
  where k.user_id = me and s.status = 'open' and not s.hidden and s.date >= current_date and not _shift_ended(s)
    and not exists (select 1 from applications x where x.shift_id = s.id and x.worker_id = me) $$;

create or replace function api_createShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; k text := a->>1; s shifts; r jsonb;
  cat int := _int(p->>'category_id'); d date := _date(p->>'date'); st time := _time(p->>'start'); en time := _time(p->>'end'); pay int := _int(p->>'pay'); ppl int := _int(p->>'people');
begin
  if not exists (select 1 from contractor_profiles where user_id = me) then perform _fail('profile_required', 'Сначала заполните профиль подрядчика'); end if;
  if k is not null then select result into r from idempotency_keys where user_id = me and key = k; if found then return r; end if; end if;
  if length(trim(coalesce(p->>'title',''))) < 3 then perform _fail('invalid', 'Укажите название смены'); end if;
  if cat is null or not exists (select 1 from categories where id = cat and active) then perform _fail('invalid', 'Выберите категорию'); end if;
  if length(trim(coalesce(p->>'address',''))) < 3 then perform _fail('invalid', 'Укажите адрес'); end if;
  if d is null then perform _fail('invalid', 'Укажите дату'); end if;
  if d < current_date then perform _fail('invalid', 'Дата не может быть в прошлом'); end if;
  if st is null or en is null then perform _fail('invalid', 'Укажите время начала и окончания'); end if;
  if st = en then perform _fail('invalid', 'Время начала и окончания совпадает'); end if;
  if (d::timestamp + st + case when en > st then en - st else en - st + interval '24 hours' end) <= localtimestamp then perform _fail('invalid', 'Время смены уже прошло — выберите другое время или дату'); end if;
  if coalesce(pay, 0) not between 1 and 1000000 then perform _fail('invalid', 'Укажите оплату (до 1 000 000 ₽)'); end if;
  if coalesce(ppl, 0) not between 1 and 500 then perform _fail('invalid', 'Укажите количество людей (1–500)'); end if;
  insert into shifts(contractor_id, title, category_id, description, address, lat, lng, date, start_time, end_time, pay, people, requirements)
  values (me, trim(p->>'title'), cat, coalesce(p->>'description',''), trim(p->>'address'), (p->>'lat')::float, (p->>'lng')::float, d,
    st, en, pay, ppl, coalesce(array(select jsonb_array_elements_text(coalesce(p->'requirements','[]'))), '{}')) returning * into s;
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

-- страницы подрядчика/исполнителя: актуальные смены без прошедших, отзывы только по своей роли
create or replace function api_contractorPage(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin
  if not exists (select 1 from contractor_profiles where user_id = (a->>0)::bigint) then perform _fail('not_found', 'Подрядчик не найден'); end if;
  return jsonb_build_object('contractor', _contractor_json((a->>0)::bigint),
    'shifts', coalesce((select jsonb_agg(_shift_json(s, me) order by s.date, s.start_time) from shifts s where s.contractor_id = (a->>0)::bigint and s.status = 'open' and not s.hidden and s.date >= current_date and not _shift_ended(s)), '[]'),
    'reviews', _reviews_as((a->>0)::bigint, 'contractor'), 'is_fav', exists (select 1 from favorites where user_id = me and target_id = (a->>0)::bigint));
end $$;

create or replace function api_workerPage(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin
  if not exists (select 1 from worker_profiles where user_id = (a->>0)::bigint) then perform _fail('not_found', 'Исполнитель не найден'); end if;
  return jsonb_build_object('worker', _worker_json((a->>0)::bigint, exists (select 1 from applications x join shifts s on s.id = x.shift_id where x.worker_id = (a->>0)::bigint and s.contractor_id = me)),
    'reviews', _reviews_as((a->>0)::bigint, 'worker'), 'is_fav', exists (select 1 from favorites where user_id = me and target_id = (a->>0)::bigint));
end $$;

create or replace function api_favorites(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin
  if a->>0 = 'worker' then
    return (select coalesce(jsonb_agg(_worker_json(f.target_id)), '[]') from favorites f join worker_profiles w on w.user_id = f.target_id where f.user_id = me);
  end if;
  return (select coalesce(jsonb_agg(_contractor_json(f.target_id) || jsonb_build_object('open_shifts', (select count(*) from shifts s where s.contractor_id = f.target_id and s.status = 'open' and not s.hidden and s.date >= current_date and not _shift_ended(s)))), '[]')
          from favorites f join contractor_profiles c on c.user_id = f.target_id where f.user_id = me);
end $$;

-- ----- 3. принятие отклика -----
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
    if s.status = 'full' then perform _fail('full', 'Все места заняты'); end if;
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

-- ----- 4. отмена отклика -----
create or replace function api_undoApply(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare ap applications; s shifts;
begin
  select * into ap from applications where shift_id = (a->>0)::bigint and worker_id = me and status = 'pending';
  if not found then return 'false'; end if;
  delete from applications where id = ap.id;
  select * into s from shifts where id = ap.shift_id;
  delete from notifications where user_id = s.contractor_id and type = 'new_application' and not read and link = '#/c/shift/' || s.id
    and text = format('Новый отклик: %s — «%s»', (select name from worker_profiles where user_id = me), s.title);
  return 'true';
end $$;

-- ----- 5. завершение смены -----
create or replace function api_completeShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare s shifts; ap record;
begin
  select * into s from shifts where id = (a->>0)::bigint for update;
  if not found or s.contractor_id <> me then perform _fail('forbidden', 'Нет доступа'); end if;
  if s.status not in ('open','full') then return _shift_json(s, me); end if;
  update shifts set status = 'completed', completed_at = now() where id = s.id returning * into s;
  for ap in update applications set status = 'rejected', updated_at = now() where shift_id = s.id and status = 'pending' returning worker_id loop
    perform _notify(ap.worker_id, 'shift_closed', format('Смена завершена: «%s». Ваш отклик не был рассмотрен', s.title), '#/w/mine'); end loop;
  for ap in update applications set status = 'completed', updated_at = now() where shift_id = s.id and status = 'accepted' returning worker_id loop
    perform _notify(ap.worker_id, 'shift_completed', format('Смена завершена: «%s». Оцените подрядчика', s.title), '#/review/' || s.id); end loop;
  insert into audit_log(actor, action, meta) values (me, 'shift.complete', jsonb_build_object('id', s.id));
  return _shift_json(s, me);
end $$;

-- ----- 6. чат -----
create or replace function api_messages(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _assert_chat(me, a->>0);
  if a->>2 = 'pin' then return (select coalesce(jsonb_agg(_msg_json(m)), '[]') from messages m where m.scope = a->>0 and m.pinned); end if;
  if coalesce((a->>1)::bigint, 0) = 0 then
    return (select coalesce(jsonb_agg(_msg_json(m) order by m.id), '[]') from (select * from messages where scope = a->>0 order by id desc limit 300) m);
  end if;
  return (select coalesce(jsonb_agg(_msg_json(m) order by m.id), '[]') from messages m where m.scope = a->>0 and m.id > (a->>1)::bigint);
end $$;

-- новые функции не должны быть доступны напрямую: только через public.api
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
