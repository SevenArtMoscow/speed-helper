-- ТЗ от 05.11.2026: форма смены без названия и категории, срок выплаты в форме и карточке.
-- Поля «название» и «категория» в базе остаются: на название опираются списки, чаты и уведомления, поэтому оно собирается из начала описания.
-- Категория необязательна, старые значения не меняются и автоматически не назначаются.
-- Срок выплаты — обещание подрядчика: оплату через приложение он не запускает и выплату не подтверждает.

alter table shifts alter column category_id drop not null;
alter table shifts add column if not exists payout_kind text;
alter table shifts add column if not exists payout_date date;
-- у старых смен срок не указан (оба поля пустые); конкретная дата есть только у варианта «Указать дату»
alter table shifts add constraint shift_payout_ok check (
  (payout_kind is null and payout_date is null)
  or (payout_kind = 'date' and payout_date is not null)
  or (payout_kind in ('after_shift', 'same_day', 'next_day', 'week', 'month') and payout_date is null));

-- короткое начало описания для заголовков: не длиннее 60 знаков, обрезается по слову
create or replace function _shift_title_from(d text) returns text language sql immutable as $$
  select case when length(t) <= 60 then t
    else coalesce(nullif(rtrim(regexp_replace(left(t, 58), '\s+\S*$', ''), ' ,.;:-–—'), ''), left(t, 58)) || '…' end
  from (select btrim(regexp_replace(coalesce(d, ''), '\s+', ' ', 'g')) as t) x $$;

-- день окончания: ночная смена заканчивается на следующий день; у «до выполнения задачи» окончание заранее неизвестно
create or replace function _shift_end_day(d date, st time, en time, ud boolean) returns date language sql immutable as $$
  select case when ud then null when en <= st then d + 1 else d end $$;

-- Срок выплаты обязателен. Конкретная дата — не раньше окончания смены, а если окончание неизвестно — не раньше даты начала.
-- Относительные сроки отсчитываются от окончания и заранее не пересчитываются в дату
create or replace function _payout_check(kind text, pd date, d date, st time, en time, ud boolean) returns void language plpgsql as $$
declare lim date := coalesce(_shift_end_day(d, st, en, ud), d);
begin
  if kind is null then perform _fail('invalid', 'Выберите срок выплаты'); end if;
  if kind not in ('date', 'after_shift', 'same_day', 'next_day', 'week', 'month') then perform _fail('invalid', 'Некорректный срок выплаты'); end if;
  if kind = 'date' then
    if pd is null then perform _fail('invalid', 'Укажите дату выплаты'); end if;
    if pd < lim then perform _fail('invalid', case when ud then 'Дата выплаты не может быть раньше даты смены' else 'Дата выплаты не может быть раньше окончания смены' end); end if;
    if pd > lim + 366 then perform _fail('invalid', 'Дата выплаты — не позже чем через год после смены'); end if;
  end if;
end $$;

-- ----- создание: описание вместо названия, категория по желанию, срок выплаты -----
-- Прежние версии приложения присылают название и категорию: они по-прежнему принимаются
create or replace function _api_createshift_core(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; k text := a->>1; s shifts; r jsonb;
  cat int := _int(p->>'category_id'); d date := _date(p->>'date'); st time := _time(p->>'start'); en time := _time(p->>'end'); pay int := _int(p->>'pay'); ppl int := _int(p->>'people');
  ud boolean := coalesce((p->>'until_done')::boolean, false); pt text := coalesce(nullif(p->>'pay_type', ''), 'shift'); reg text; lat float := (p->>'lat')::float; lng float := (p->>'lng')::float;
  ttl text := btrim(coalesce(p->>'title', '')); descr text := btrim(coalesce(p->>'description', ''));
  pk text := nullif(btrim(coalesce(p->>'payout_kind', '')), ''); pd date := _date(p->>'payout_date');
begin
  if not exists (select 1 from contractor_profiles where user_id = me) then perform _fail('profile_required', 'Сначала заполните профиль подрядчика'); end if;
  if k is not null then select result into r from idempotency_keys where user_id = me and key = k; if found then return r; end if; end if;
  if ttl <> '' and length(ttl) < 3 then perform _fail('invalid', 'Укажите название смены'); end if;
  if descr = '' then descr := ttl; end if;
  if length(descr) < 3 then perform _fail('invalid', 'Опишите, что нужно сделать'); end if;
  if ttl = '' then ttl := _shift_title_from(descr); end if;
  if cat is not null and not exists (select 1 from categories where id = cat and active) then perform _fail('invalid', 'Выберите категорию'); end if;
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
  perform _payout_check(pk, pd, d, st, en, ud);
  if pk <> 'date' then pd := null; end if;
  reg := case when p->>'region' in ('msk','mo') then p->>'region' else _region_of(lat, lng) end;
  insert into shifts(contractor_id, title, category_id, description, address, lat, lng, date, start_time, end_time, pay, people, requirements, until_done, pay_type, region, payout_kind, payout_date)
  values (me, ttl, cat, descr, trim(p->>'address'), lat, lng, d,
    st, en, pay, ppl, coalesce(array(select jsonb_array_elements_text(coalesce(p->'requirements','[]'))), '{}'), ud, pt, reg, pk, pd) returning * into s;
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

-- ----- изменение: описание и срок выплаты. Срок проверяется заново при каждой правке: новое время может перенести окончание на следующий день -----
create or replace function _api_updateshift_core(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare s shifts; o shifts; p jsonb := a->1; acc int; changed boolean; ap record; descr text;
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
  if p ? 'description' then
    descr := btrim(coalesce(p->>'description', ''));
    if descr <> '' and length(descr) < 3 then perform _fail('invalid', 'Опишите, что нужно сделать'); end if;
    if descr <> btrim(o.description) then s.description := descr; if descr <> '' then s.title := _shift_title_from(descr); end if; end if;
  end if;
  if p ? 'payout_kind' then
    s.payout_kind := nullif(btrim(coalesce(p->>'payout_kind', '')), '');
    s.payout_date := case when s.payout_kind = 'date' then _date(p->>'payout_date') end;
  end if;
  if p ? 'requirements' then s.requirements := coalesce(array(select jsonb_array_elements_text(p->'requirements')), '{}'); end if;
  if coalesce(s.pay, 0) not between 1 and 1000000 then perform _fail('invalid', 'Укажите оплату (до 1 000 000 ₽)'); end if;
  if coalesce(s.people, 0) not between 1 and 500 then perform _fail('invalid', 'Укажите количество людей (1–500)'); end if;
  if s.start_time is null or s.end_time is null then perform _fail('invalid', 'Укажите время начала и окончания'); end if;
  if not s.until_done and s.start_time = s.end_time then perform _fail('invalid', 'Время начала и окончания совпадает'); end if;
  if s.people < acc then perform _fail('invalid', format('Уже принято %s чел. — нельзя указать меньше', acc)); end if;
  -- у старых смен срока может не быть: их можно править и без него, но выбранный срок всегда должен быть верным
  if s.payout_kind is not null or p ? 'payout_kind' then perform _payout_check(s.payout_kind, s.payout_date, s.date, s.start_time, s.end_time, s.until_done); end if;
  changed := (s.pay, s.pay_type, s.people, s.start_time, s.end_time, s.until_done, s.requirements, s.payout_kind, s.payout_date)
    is distinct from (o.pay, o.pay_type, o.people, o.start_time, o.end_time, o.until_done, o.requirements, o.payout_kind, o.payout_date);
  update shifts set pay = s.pay, pay_type = s.pay_type, people = s.people, start_time = s.start_time, end_time = s.end_time, until_done = s.until_done,
    title = s.title, description = s.description, requirements = s.requirements, payout_kind = s.payout_kind, payout_date = s.payout_date,
    status = case when acc >= s.people then 'full' else 'open' end where id = s.id returning * into s;
  if changed then
    for ap in select worker_id from applications where shift_id = s.id and status in ('pending','accepted') loop
      perform _notify(ap.worker_id, 'shift_updated', format('Условия смены обновлены: «%s»', s.title), '#/w/shift/' || s.id); end loop;
  end if;
  insert into audit_log(actor, action, meta) values (me, 'shift.update', jsonb_build_object('id', s.id));
  return _shift_json(s, me);
end $$;

-- ----- смена для приложения: срок выплаты и момент завершения (от него считается срок у «до выполнения задачи») -----
create or replace function _shift_json(s shifts, me bigint, olat double precision default null, olng double precision default null) returns jsonb language plpgsql stable as $$
declare j jsonb; a applications;
begin
  j := jsonb_build_object('id', s.id, 'contractor_id', s.contractor_id, 'title', s.title, 'category_id', s.category_id, 'category_name', (select name from categories where id = s.category_id),
    'description', s.description, 'address', s.address, 'lat', s.lat, 'lng', s.lng, 'date', s.date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'),
    'pay', s.pay, 'people', s.people, 'requirements', to_jsonb(s.requirements), 'status', s.status, 'hidden', s.hidden,
    'until_done', s.until_done, 'pay_type', s.pay_type, 'region', s.region, 'total', _shift_total(s), 'ended', _shift_ended(s),
    'payout_kind', s.payout_kind, 'payout_date', s.payout_date, 'completed_at', s.completed_at,
    'boosted', coalesce(s.boosted_until > now(), false),
    'saved', exists (select 1 from shift_favs v where v.shift_id = s.id and v.user_id = me),
    'contractor', _contractor_json(s.contractor_id), 'accepted_count', (select count(*) from shift_members m where m.shift_id = s.id and m.role <> 'owner'));
  if olat is not null and s.lat is not null then
    j := j || jsonb_build_object('distance_km', 6371 * 2 * asin(sqrt(sin(radians(s.lat - olat) / 2) ^ 2 + cos(radians(olat)) * cos(radians(s.lat)) * sin(radians(s.lng - olng) / 2) ^ 2)));
  end if;
  select * into a from applications where shift_id = s.id and worker_id = me;
  if found then j := j || jsonb_build_object('my_status', a.status, 'my_application_id', a.id); end if;
  return j;
end $$;

-- ----- лента: смены без категории попадают в общую выдачу и не пропадают при фильтре по видам работ -----
create or replace function api_feed(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare f jsonb := coalesce(a->0, '{}'); off int := coalesce((f->>'offset')::int, 0); lim int := least(coalesce((f->>'limit')::int, 20), 200);
  geo text := coalesce(f->>'geo', 'any'); minpay int := coalesce(_int(f->>'min_pay'), 0);
  cats int[] := coalesce(array(select jsonb_array_elements_text(coalesce(f->'categories','[]'))::int), '{}'); res jsonb; v_total int;
  sim_cat int := (select category_id from shifts where id = _bigint(f->>'similar_to'));
begin
  with base as (
    select s.id, s.date as d, s.start_time as st, coalesce(s.boosted_until > now(), false) as bst, _is_pro(s.contractor_id) as pro
    from shifts s
    where s.status = 'open' and not s.hidden and s.contractor_id <> me and s.date >= current_date and not _shift_ended(s)
      and not exists (select 1 from applications x where x.shift_id = s.id and x.worker_id = me)
      and (coalesce((f->>'include_skipped')::boolean, false) or not exists (select 1 from skips k where k.shift_id = s.id and k.user_id = me))
      and (coalesce((f->>'include_saved')::boolean, false) or not exists (select 1 from shift_favs v where v.shift_id = s.id and v.user_id = me))
      and (geo not in ('msk','mo') or s.region = geo)
      and (coalesce(f->>'date','any') = 'any' or (f->>'date' = 'today' and s.date = current_date) or (f->>'date' = 'tomorrow' and s.date = current_date + 1) or (f->>'date' = 'weekend' and extract(isodow from s.date) in (6,7)))
      and _shift_total(s) >= minpay and (cardinality(cats) = 0 or s.category_id is null or s.category_id = any(cats))
      and (f->>'similar_to' is null or (s.id <> _bigint(f->>'similar_to') and (sim_cat is null or s.category_id = sim_cat)))
  ), filt as (select *, count(*) over () as tot from base),
  page as (select * from filt order by bst desc, d, pro desc, st, id desc limit lim offset off)
  select coalesce(jsonb_agg(_shift_json(s, me) order by p.bst desc, p.d, p.pro desc, p.st, p.id desc), '[]'), coalesce((select max(tot) from filt), 0)
    into res, v_total from page p join shifts s on s.id = p.id;
  return jsonb_build_object('items', res, 'total', v_total, 'next', case when off + lim < v_total then off + lim end);
end $$;
