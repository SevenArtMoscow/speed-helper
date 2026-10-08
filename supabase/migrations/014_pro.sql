-- Подписка SPEED HELPER PRO (990 ₽ в месяц) — «задел на будущее»:
--  • таблица subscriptions: кто, до какого числа, как получена (admin — выдал администратор; payment — оплата, подключим позже);
--  • значок PRO и золотая рамка у профилей, приоритет PRO-исполнителей в списке откликов, PRO-подрядчики выше в ленте;
--  • «Поднять в топ»: смена на 6 часов выше всех в ленте, 3 раза в месяц для PRO-подрядчика;
--  • администратор может выдать/снять PRO (для команды, акций и тестов); оплата подключается отдельно (см. docs/PRO.md).

create table if not exists subscriptions (
  user_id bigint primary key references users(id) on delete cascade, plan text not null default 'pro',
  started_at timestamptz not null default now(), expires_at timestamptz not null, source text not null default 'admin', note text);
create table if not exists boosts (id bigint generated always as identity primary key, user_id bigint not null references users(id) on delete cascade, shift_id bigint not null references shifts(id) on delete cascade, created_at timestamptz not null default now());
create index if not exists boosts_user_idx on boosts (user_id, created_at);
alter table shifts add column if not exists boosted_until timestamptz;

create or replace function _is_pro(uid bigint) returns boolean language sql stable as $$ select exists (select 1 from subscriptions where user_id = uid and expires_at > now()) $$;

-- профили: признак PRO
create or replace function _contractor_json(cid bigint) returns jsonb language sql stable as $$
  select jsonb_build_object('id', c.user_id, 'name', c.name, 'company', c.company, 'avatar', c.avatar, 'about', c.about, 'city', c.city, 'verified', c.verified, 'pro', _is_pro(c.user_id),
    'shifts_done', (select count(*) from shifts s where s.contractor_id = c.user_id and s.status = 'completed')) || _rating_as(c.user_id, 'contractor')
  from contractor_profiles c where c.user_id = cid $$;

create or replace function _worker_json(uid bigint, with_phone boolean default false) returns jsonb language sql stable as $$
  select jsonb_build_object('user_id', w.user_id, 'name', w.name, 'avatar', w.avatar, 'city', w.city, 'age', w.age, 'skills', to_jsonb(w.skills), 'percent', _percent(w),
    'verified', _percent(w) >= 80, 'pro', _is_pro(w.user_id),
    'shifts_done', (select count(*) from applications a where a.worker_id = w.user_id and a.status = 'completed'
                    and not exists (select 1 from shift_members m where m.shift_id = a.shift_id and m.user_id = a.worker_id and m.attended is false)),
    'about', w.about, 'experience', w.experience, 'license', to_jsonb(w.license), 'medbook', w.medbook, 'selfemployed', w.selfemployed, 'night', w.night, 'tools', w.tools)
    || case when with_phone then jsonb_build_object('phone', w.phone) else '{}'::jsonb end || _rating_as(w.user_id, 'worker')
  from worker_profiles w where w.user_id = uid $$;

create or replace function api_me(me bigint, a jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('id', u.id, 'tg_id', u.tg_id, 'first_name', u.first_name, 'username', u.username, 'roles', to_jsonb(u.roles), 'is_admin', u.is_admin,
    'worker', _worker_json(u.id, true), 'contractor', (select to_jsonb(c) || _contractor_json(u.id) from contractor_profiles c where c.user_id = u.id),
    'unread', (select count(*) from notifications n where n.user_id = u.id and not n.read), 'terms_accepted', u.terms_accepted_at is not null,
    'pro', _is_pro(u.id), 'pro_until', (select (extract(epoch from expires_at) * 1000)::bigint from subscriptions where user_id = u.id and expires_at > now()))
  from users u where u.id = me $$;

-- смена: в топе ли сейчас
create or replace function _shift_json(s shifts, me bigint, olat double precision default null, olng double precision default null) returns jsonb language plpgsql stable as $$
declare j jsonb; a applications;
begin
  j := jsonb_build_object('id', s.id, 'contractor_id', s.contractor_id, 'title', s.title, 'category_id', s.category_id, 'category_name', (select name from categories where id = s.category_id),
    'description', s.description, 'address', s.address, 'lat', s.lat, 'lng', s.lng, 'date', s.date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'),
    'pay', s.pay, 'people', s.people, 'requirements', to_jsonb(s.requirements), 'status', s.status, 'hidden', s.hidden,
    'until_done', s.until_done, 'pay_type', s.pay_type, 'region', s.region, 'total', _shift_total(s), 'ended', _shift_ended(s),
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

-- лента: сначала «в топе», затем по дате; в пределах дня смены PRO-подрядчиков выше
create or replace function api_feed(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare f jsonb := coalesce(a->0, '{}'); off int := coalesce((f->>'offset')::int, 0); lim int := least(coalesce((f->>'limit')::int, 20), 200);
  geo text := coalesce(f->>'geo', 'any'); minpay int := coalesce(_int(f->>'min_pay'), 0);
  cats int[] := coalesce(array(select jsonb_array_elements_text(coalesce(f->'categories','[]'))::int), '{}'); res jsonb; v_total int;
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
      and _shift_total(s) >= minpay and (cardinality(cats) = 0 or s.category_id = any(cats))
      and (f->>'similar_to' is null or s.category_id = (select category_id from shifts where id = (f->>'similar_to')::bigint))
  ), filt as (select *, count(*) over () as tot from base),
  page as (select * from filt order by bst desc, d, pro desc, st, id desc limit lim offset off)
  select coalesce(jsonb_agg(_shift_json(s, me) order by p.bst desc, p.d, p.pro desc, p.st, p.id desc), '[]'), coalesce((select max(tot) from filt), 0)
    into res, v_total from page p join shifts s on s.id = p.id;
  return jsonb_build_object('items', res, 'total', v_total, 'next', case when off + lim < v_total then off + lim end);
end $$;

-- отклики: PRO-исполнители первыми
create or replace function api_applicants(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin
  if not _can_manage((a->>0)::bigint, me, 'applications') then perform _fail('forbidden', 'Нет доступа'); end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object('worker', _worker_json(x.worker_id)) order by _is_pro(x.worker_id) desc, x.created_at desc), '[]') from applications x where x.shift_id = (a->>0)::bigint);
end $$;

-- ----- подписка -----
create or replace function api_mySubscription(me bigint, a jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('active', _is_pro(me), 'price', 990,
    'expires_at', (select (extract(epoch from expires_at) * 1000)::bigint from subscriptions where user_id = me and expires_at > now()),
    'source', (select source from subscriptions where user_id = me and expires_at > now()),
    'boosts_limit', 3, 'boosts_used', (select count(*) from boosts where user_id = me and created_at >= date_trunc('month', now()))) $$;

-- поднять смену в топ ленты на 6 часов (только PRO-подрядчик, 3 раза в месяц)
create or replace function api_boostShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare s shifts; used int;
begin
  select * into s from shifts where id = (a->>0)::bigint for update;
  if not found or s.contractor_id <> me then perform _fail('forbidden', 'Только владелец смены'); end if;
  if not _is_pro(me) then perform _fail('pro_required', 'Поднятие в топ доступно с подпиской PRO'); end if;
  if s.status <> 'open' or s.hidden or _shift_ended(s) then perform _fail('closed', 'Поднять можно только открытую смену'); end if;
  select count(*) into used from boosts where user_id = me and created_at >= date_trunc('month', now());
  if used >= 3 then perform _fail('limit', 'Лимит поднятий на этот месяц исчерпан (3)'); end if;
  update shifts set boosted_until = now() + interval '6 hours' where id = s.id returning * into s;
  insert into boosts(user_id, shift_id) values (me, s.id);
  insert into audit_log(actor, action, meta) values (me, 'shift.boost', jsonb_build_object('id', s.id));
  return _shift_json(s, me);
end $$;

-- ----- администратор: выдать / снять PRO -----
create or replace function api_adminGrantPro(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare uid bigint := (a->>0)::bigint; days int := least(greatest(coalesce(_int(a->>1), 30), 1), 366); e timestamptz;
begin perform _admin(me);
  if not exists (select 1 from users where id = uid) then perform _fail('not_found', 'Пользователь не найден'); end if;
  insert into subscriptions(user_id, expires_at, source, note) values (uid, now() + make_interval(days => days), 'admin', 'выдано администратором')
    on conflict (user_id) do update set expires_at = greatest(subscriptions.expires_at, now()) + make_interval(days => days), source = 'admin' returning expires_at into e;
  perform _notify(uid, 'pro', format('Вам подключена подписка PRO до %s', to_char(e, 'DD.MM.YYYY')), '#/pro');
  insert into audit_log(actor, action, meta) values (me, 'pro.grant', jsonb_build_object('user', uid, 'days', days));
  return jsonb_build_object('expires_at', (extract(epoch from e) * 1000)::bigint); end $$;

create or replace function api_adminRevokePro(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin perform _admin(me);
  update subscriptions set expires_at = now() where user_id = (a->>0)::bigint;
  insert into audit_log(actor, action, meta) values (me, 'pro.revoke', jsonb_build_object('user', a->0)); return 'true'; end $$;

create or replace function api_adminUsers(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me);
  return (select coalesce(jsonb_agg(to_jsonb(u) || jsonb_build_object('name', coalesce((select name from worker_profiles where user_id = u.id), (select name from contractor_profiles where user_id = u.id), u.first_name),
    'verified', coalesce((select verified from contractor_profiles where user_id = u.id), false), 'pro', _is_pro(u.id)) order by u.is_fake, u.id desc), '[]')
    from (select * from users order by is_fake, id desc limit 500) u); end $$;

-- удаление аккаунта: подписка стирается вместе с остальными данными
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
  delete from subscriptions where user_id = me;
  delete from review_skips where user_id = me or to_user = me;
  delete from notifications where user_id = me;
  update messages set text = '[сообщение удалено]', pinned = false where user_id = me;
  update reviews set text = null where from_user = me;
  update users set first_name = null, username = null, roles = '{}', terms_accepted_at = null, deleted_at = now() where id = me;
  insert into audit_log(actor, action, meta) values (me, 'account.delete', '{}');
  return 'true';
end $$;

create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','mySkips','unskipAll','apply','undoApply','withdraw','myApplications',
    'toggleFav','favorites','favIds','contractorPage','workerPage','createShift','myShifts','contractorStats','updateShift','cancelShift','completeShift','applicants','decide',
    'team','myTeams','teamChats','setSenior','removeMember','setAttendance','messages','sendMessage','pinMessage','dmInfo','myDialogs','pendingReviews','submitReview','skipReview','userReviews',
    'toggleShiftFav','savedShifts','myWorkers','leaderboard','mySubscription','boostShift',
    'notifications','markRead','report','track','logError','acceptTerms','deleteAccount',
    'adminStats','adminUsers','adminBlock','adminVerify','adminShifts','adminHideShift','adminReports','adminResolveReport','adminCategories','adminSaveCategory','adminAudit','adminGrantPro','adminRevokePro'];
begin
  if not (fn = any(allowed)) then perform _fail('not_implemented', 'Неизвестный метод: ' || fn); end if;
  execute format('select public.%I($1,$2)', lower('api_' || fn)) into r using me, coalesce(args, '[]'::jsonb);
  return r;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
