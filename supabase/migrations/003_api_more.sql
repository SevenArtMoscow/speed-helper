-- SPEED HELPER: остальные методы API (избранное, управление сменой и командой, диалоги, админка). Формат JSON = js/local-backend.js.
-- Выполнять после 002_api.sql.

create or replace function _admin(me bigint) returns void language plpgsql stable as $$
begin if not exists (select 1 from users where id = me and is_admin) then perform _fail('forbidden', 'Нет доступа'); end if; end $$;

create or replace function _member_perm(sid bigint, uid bigint, perm text) returns boolean language sql stable as $$ select _can_manage(sid, uid, perm) $$;

-- ----- отклики / избранное -----
create or replace function api_withdraw(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare ap applications; s shifts;
begin
  select * into ap from applications where id = (a->>0)::bigint and worker_id = me; if not found then perform _fail('not_found', 'Не найдено'); end if;
  select * into s from shifts where id = ap.shift_id for update;
  if ap.status = 'pending' then delete from applications where id = ap.id; return '{"removed":true}'; end if;
  if ap.status = 'accepted' then
    update applications set status = 'cancelled', updated_at = now() where id = ap.id returning * into ap;
    delete from shift_members where shift_id = s.id and user_id = me;
    if s.status = 'full' then update shifts set status = 'open' where id = s.id; end if;
    perform _notify(s.contractor_id, 'member_left', format('%s отказался от смены «%s»', (select name from worker_profiles where user_id = me), s.title), '#/c/shift/' || s.id);
  end if;
  return to_jsonb(ap);
end $$;

create or replace function api_toggleFav(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  delete from favorites where user_id = me and target_id = (a->>0)::bigint;
  if found then return 'false'; end if;
  insert into favorites(user_id, target_id) values (me, (a->>0)::bigint) on conflict do nothing; return 'true';
end $$;

create or replace function api_favIds(me bigint, a jsonb) returns jsonb language sql stable as $$ select coalesce(jsonb_agg(target_id), '[]') from favorites where user_id = me $$;

create or replace function api_favorites(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin
  if a->>0 = 'worker' then
    return (select coalesce(jsonb_agg(_worker_json(f.target_id)), '[]') from favorites f join worker_profiles w on w.user_id = f.target_id where f.user_id = me);
  end if;
  return (select coalesce(jsonb_agg(_contractor_json(f.target_id) || jsonb_build_object('open_shifts', (select count(*) from shifts s where s.contractor_id = f.target_id and s.status = 'open' and not s.hidden and s.date >= current_date))), '[]')
          from favorites f join contractor_profiles c on c.user_id = f.target_id where f.user_id = me);
end $$;

create or replace function _reviews_json(uid bigint) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('at', (extract(epoch from r.created_at) * 1000)::bigint,
    'from_name', coalesce((select name from contractor_profiles where user_id = r.from_user), (select name from worker_profiles where user_id = r.from_user))) order by r.id desc), '[]')
  from (select * from reviews where to_user = uid order by id desc limit 10) r $$;

create or replace function api_contractorPage(me bigint, a jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('contractor', _contractor_json((a->>0)::bigint),
    'shifts', coalesce((select jsonb_agg(_shift_json(s, me) order by s.date, s.start_time) from shifts s where s.contractor_id = (a->>0)::bigint and s.status = 'open' and not s.hidden and s.date >= current_date), '[]'),
    'reviews', _reviews_json((a->>0)::bigint), 'is_fav', exists (select 1 from favorites where user_id = me and target_id = (a->>0)::bigint)) $$;

-- Телефон исполнителя виден только подрядчику, у смены которого есть его отклик
create or replace function api_workerPage(me bigint, a jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('worker', _worker_json((a->>0)::bigint, exists (select 1 from applications x join shifts s on s.id = x.shift_id where x.worker_id = (a->>0)::bigint and s.contractor_id = me)),
    'reviews', _reviews_json((a->>0)::bigint), 'is_fav', exists (select 1 from favorites where user_id = me and target_id = (a->>0)::bigint)) $$;

create or replace function api_contractorStats(me bigint, a jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'active', (select count(*) from shifts where contractor_id = me and status in ('open','full')),
    'new_applications', (select count(*) from applications x join shifts s on s.id = x.shift_id where s.contractor_id = me and x.status = 'pending'),
    'workers', (select count(distinct m.user_id) from shift_members m join shifts s on s.id = m.shift_id where s.contractor_id = me and m.role <> 'owner'),
    'done', (select count(*) from shifts where contractor_id = me and status = 'completed')) $$;

-- ----- изменение смены -----
create or replace function api_updateShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare s shifts; o shifts; p jsonb := a->1; acc int; changed boolean; ap record;
begin
  select * into s from shifts where id = (a->>0)::bigint for update;
  if not found or s.contractor_id <> me then perform _fail('forbidden', 'Только владелец смены'); end if;
  if s.status not in ('open','full') then perform _fail('closed', 'Смену уже нельзя изменить'); end if;
  o := s;
  select count(*) into acc from shift_members where shift_id = s.id and role <> 'owner';
  if p ? 'pay' then s.pay := (p->>'pay')::int; end if;
  if p ? 'people' then s.people := (p->>'people')::int; end if;
  if p ? 'start' then s.start_time := (p->>'start')::time; end if;
  if p ? 'end' then s.end_time := (p->>'end')::time; end if;
  if p ? 'description' then s.description := coalesce(p->>'description', ''); end if;
  if p ? 'requirements' then s.requirements := coalesce(array(select jsonb_array_elements_text(p->'requirements')), '{}'); end if;
  if s.pay <= 0 or s.people < 1 then perform _fail('invalid', 'Некорректное значение'); end if;
  if s.people < acc then perform _fail('invalid', format('Уже принято %s чел.', acc)); end if;
  changed := (s.pay, s.people, s.start_time, s.end_time, s.requirements) is distinct from (o.pay, o.people, o.start_time, o.end_time, o.requirements);
  update shifts set pay = s.pay, people = s.people, start_time = s.start_time, end_time = s.end_time, description = s.description, requirements = s.requirements,
    status = case when acc >= s.people then 'full' else 'open' end where id = s.id returning * into s;
  if changed then
    for ap in select worker_id from applications where shift_id = s.id and status in ('pending','accepted') loop
      perform _notify(ap.worker_id, 'shift_updated', format('Условия смены обновлены: «%s»', s.title), '#/w/shift/' || s.id); end loop;
  end if;
  insert into audit_log(actor, action, meta) values (me, 'shift.update', jsonb_build_object('id', s.id));
  return _shift_json(s, me);
end $$;

-- ----- команда и чат -----
create or replace function api_team(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare s shifts; sid bigint := (a->>0)::bigint; mine shift_members;
begin
  select * into mine from shift_members where shift_id = sid and user_id = me;
  if not found then perform _fail('forbidden', 'Вы не в команде этой смены'); end if;
  select * into s from shifts where id = sid;
  return jsonb_build_object('shift', _shift_json(s, me), 'my_role', mine.role, 'my_perms', to_jsonb(mine.perms),
    'members', (select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object('name', coalesce(case when m.role = 'owner' then (select name from contractor_profiles where user_id = m.user_id) end, (select name from worker_profiles where user_id = m.user_id)),
        'avatar', coalesce((select avatar from worker_profiles where user_id = m.user_id), (select avatar from contractor_profiles where user_id = m.user_id))) order by m.joined_at), '[]') from shift_members m where m.shift_id = sid),
    'pinned', (select _msg_json(x) from messages x where x.scope = 'shift:' || sid and x.pinned limit 1));
end $$;

create or replace function api_myTeams(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(_shift_json(s, me) order by s.date), '[]') from shift_members m join shifts s on s.id = m.shift_id where m.user_id = me and m.role <> 'owner' and s.status <> 'cancelled' $$;

create or replace function api_setSenior(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare sid bigint := (a->>0)::bigint; uid bigint := (a->>1)::bigint; p text[] := array(select x from jsonb_array_elements_text(coalesce(a->2, '[]')) x where x in ('pin','attendance','remove','applications')); m shift_members; s shifts;
begin
  select * into s from shifts where id = sid; if not found or s.contractor_id <> me then perform _fail('forbidden', 'Нет доступа'); end if;
  update shift_members set role = case when cardinality(p) > 0 then 'senior' else 'worker' end, perms = p where shift_id = sid and user_id = uid and role <> 'owner' returning * into m;
  if not found then perform _fail('not_found', 'Участник не найден'); end if;
  perform _notify(uid, 'role', case when cardinality(p) > 0 then format('Вы назначены старшим смены «%s»', s.title) else format('Права старшего сняты: «%s»', s.title) end, '#/team/' || sid);
  insert into audit_log(actor, action, meta) values (me, 'member.senior', jsonb_build_object('sid', sid, 'user', uid, 'perms', p));
  return to_jsonb(m);
end $$;

create or replace function api_removeMember(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare sid bigint := (a->>0)::bigint; uid bigint := (a->>1)::bigint; m shift_members; s shifts;
begin
  select * into s from shifts where id = sid for update;
  if not found or not _can_manage(sid, me, 'remove') then perform _fail('forbidden', 'Нет доступа'); end if;
  select * into m from shift_members where shift_id = sid and user_id = uid and role <> 'owner'; if not found then perform _fail('not_found', 'Участник не найден'); end if;
  if m.role = 'senior' and s.contractor_id <> me then perform _fail('forbidden', 'Старшего может удалить только подрядчик'); end if;
  delete from shift_members where shift_id = sid and user_id = uid;
  update applications set status = 'cancelled', updated_at = now() where shift_id = sid and worker_id = uid and status = 'accepted';
  if s.status = 'full' then update shifts set status = 'open' where id = sid; end if;
  perform _notify(uid, 'removed', format('Вас исключили из команды: «%s»', s.title), '#/w/mine');
  insert into audit_log(actor, action, meta) values (me, 'member.remove', jsonb_build_object('sid', sid, 'user', uid));
  return 'true';
end $$;

create or replace function api_setAttendance(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare m shift_members;
begin
  if not _can_manage((a->>0)::bigint, me, 'attendance') then perform _fail('forbidden', 'Нет доступа'); end if;
  update shift_members set attended = (a->>2)::boolean where shift_id = (a->>0)::bigint and user_id = (a->>1)::bigint and role <> 'owner' returning * into m;
  if not found then perform _fail('not_found', 'Участник не найден'); end if; return to_jsonb(m);
end $$;

create or replace function api_pinMessage(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare m messages; sid bigint;
begin
  select * into m from messages where id = (a->>0)::bigint and scope like 'shift:%'; if not found then perform _fail('not_found', 'Не найдено'); end if;
  sid := substr(m.scope, 7)::bigint;
  if not _can_manage(sid, me, 'pin') then perform _fail('forbidden', 'Нет доступа'); end if;
  update messages set pinned = false where scope = m.scope and pinned;
  update messages set pinned = coalesce((a->>1)::boolean, true) where id = m.id; return 'true';
end $$;

create or replace function api_dmInfo(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare ap applications; s shifts;
begin
  perform _assert_chat(me, 'dm:' || (a->>0));
  select * into ap from applications where id = (a->>0)::bigint; select * into s from shifts where id = ap.shift_id;
  return jsonb_build_object('application', to_jsonb(ap), 'shift', _shift_json(s, me), 'worker', _worker_json(ap.worker_id), 'can_manage', _can_manage(s.id, me, 'applications'),
    'title', case when me = ap.worker_id then (select name from contractor_profiles where user_id = s.contractor_id) else (select name from worker_profiles where user_id = ap.worker_id) end);
end $$;

create or replace function api_myDialogs(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('app_id', x.id, 'last', _msg_json(l), 'info', api_dmInfo(me, jsonb_build_array(x.id))) order by l.id desc), '[]')
  from applications x join shifts s on s.id = x.shift_id
  join lateral (select * from messages m where m.scope = 'dm:' || x.id order by m.id desc limit 1) l on true
  where x.worker_id = me or s.contractor_id = me $$;

create or replace function api_pendingReviews(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('shift', _shift_json(s, me), 'to_user', t.uid, 'to_role', case when t.uid = s.contractor_id then 'contractor' else 'worker' end,
    'to_name', coalesce((select name from contractor_profiles where user_id = t.uid), (select name from worker_profiles where user_id = t.uid)),
    'to_avatar', coalesce((select avatar from worker_profiles where user_id = t.uid), (select avatar from contractor_profiles where user_id = t.uid)))), '[]')
  from shifts s join shift_members me_m on me_m.shift_id = s.id and me_m.user_id = me
  cross join lateral (select case when me = s.contractor_id then m2.user_id else s.contractor_id end as uid from shift_members m2 where m2.shift_id = s.id and (me <> s.contractor_id and m2.role = 'owner' or me = s.contractor_id and m2.role <> 'owner')) t
  where s.status = 'completed' and not exists (select 1 from reviews r where r.shift_id = s.id and r.from_user = me and r.to_user = t.uid) $$;

-- ----- админка -----
create or replace function api_adminStats(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me);
  return jsonb_build_object('users', (select count(*) from users), 'workers', (select count(*) from worker_profiles), 'contractors', (select count(*) from contractor_profiles),
    'shifts', (select count(*) from shifts), 'open_shifts', (select count(*) from shifts where status = 'open'), 'applications', (select count(*) from applications),
    'accepted', (select count(*) from applications where status in ('accepted','completed')), 'completed_shifts', (select count(*) from shifts where status = 'completed'),
    'reports_new', (select count(*) from reports where status = 'new'), 'active_24h', (select count(distinct user_id) from events where created_at > now() - interval '1 day'),
    'errors_24h', (select count(*) from events where event = 'error' and created_at > now() - interval '1 day')); end $$;

create or replace function api_adminUsers(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me);
  return (select coalesce(jsonb_agg(to_jsonb(u) || jsonb_build_object('name', coalesce((select name from worker_profiles where user_id = u.id), (select name from contractor_profiles where user_id = u.id), u.first_name)) order by u.id desc), '[]') from (select * from users order by id desc limit 500) u); end $$;

create or replace function api_adminBlock(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare u users;
begin perform _admin(me);
  if exists (select 1 from users where id = (a->>0)::bigint and is_admin) then perform _fail('forbidden', 'Нельзя заблокировать администратора'); end if;
  update users set blocked = (a->>1)::boolean where id = (a->>0)::bigint returning * into u; if not found then perform _fail('not_found', 'Не найдено'); end if;
  insert into audit_log(actor, action, meta) values (me, 'user.block', jsonb_build_object('user', u.id, 'blocked', u.blocked)); return to_jsonb(u); end $$;

create or replace function api_adminVerify(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin perform _admin(me); update contractor_profiles set verified = (a->>1)::boolean where user_id = (a->>0)::bigint;
  if not found then perform _fail('not_found', 'Не найдено'); end if;
  insert into audit_log(actor, action, meta) values (me, 'contractor.verify', jsonb_build_object('cid', a->0, 'v', a->1)); return 'true'; end $$;

create or replace function api_adminShifts(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me); return (select coalesce(jsonb_agg(_shift_json(s, null) order by s.id desc), '[]') from (select * from shifts order by id desc limit 300) s); end $$;

create or replace function api_adminHideShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin perform _admin(me); update shifts set hidden = (a->>1)::boolean where id = (a->>0)::bigint;
  insert into audit_log(actor, action, meta) values (me, 'shift.hide', jsonb_build_object('sid', a->0, 'hidden', a->1)); return 'true'; end $$;

create or replace function api_adminReports(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me);
  return (select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('at', (extract(epoch from r.created_at) * 1000)::bigint,
    'reporter_name', coalesce((select name from worker_profiles where user_id = r.reporter), (select name from contractor_profiles where user_id = r.reporter))) order by r.id desc), '[]') from reports r); end $$;

create or replace function api_adminResolveReport(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare r reports;
begin perform _admin(me);
  if a->>1 not in ('new','in_progress','resolved','rejected') then perform _fail('invalid', 'Некорректный статус'); end if;
  update reports set status = a->>1 where id = (a->>0)::bigint returning * into r; if not found then perform _fail('not_found', 'Не найдено'); end if;
  insert into audit_log(actor, action, meta) values (me, 'report.' || (a->>1), jsonb_build_object('rid', r.id)); return to_jsonb(r); end $$;

create or replace function api_adminCategories(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me); return (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from categories c); end $$;

create or replace function api_adminSaveCategory(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0;
begin perform _admin(me);
  if length(trim(coalesce(p->>'name', ''))) = 0 then perform _fail('invalid', 'Укажите название'); end if;
  if p->>'id' is not null then update categories set name = trim(p->>'name'), active = coalesce((p->>'active')::boolean, true) where id = (p->>'id')::int;
  else insert into categories(name) values (trim(p->>'name')); end if;
  return 'true'; end $$;

create or replace function api_adminAudit(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'actor', l.actor, 'action', l.action, 'meta', l.meta, 'at', (extract(epoch from l.created_at) * 1000)::bigint) order by l.id desc), '[]') from (select * from audit_log order by id desc limit 100) l); end $$;

-- ----- диспетчер: полный список методов -----
create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','apply','undoApply','withdraw','myApplications',
    'toggleFav','favorites','favIds','contractorPage','workerPage','createShift','myShifts','contractorStats','updateShift','cancelShift','completeShift','applicants','decide',
    'team','myTeams','setSenior','removeMember','setAttendance','messages','sendMessage','pinMessage','dmInfo','myDialogs','pendingReviews','submitReview',
    'notifications','markRead','report','track','logError',
    'adminStats','adminUsers','adminBlock','adminVerify','adminShifts','adminHideShift','adminReports','adminResolveReport','adminCategories','adminSaveCategory','adminAudit'];
begin
  if not (fn = any(allowed)) then perform _fail('not_implemented', 'Неизвестный метод: ' || fn); end if;
  execute format('select public.%I($1,$2)', 'api_' || fn) into r using me, coalesce(args, '[]'::jsonb);
  return r;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
