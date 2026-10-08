-- Понятные чаты и уведомления:
--  • teamChats(роль) — командные чаты с последним сообщением и признаком «есть непрочитанное», самые свежие сверху;
--  • myDialogs — тоже с признаком «непрочитано»;
--  • markRead(ссылка) — можно отметить прочитанными только уведомления одного чата (открыли чат — точка пропала);
--  • уведомление о сообщении говорит, кто написал и в какой смене.

create or replace function api_teamChats(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x.j order by x.ord desc nulls last, x.d desc), '[]') from (
    select _shift_json(s, me) || jsonb_build_object(
        'last', case when l.id is null then null else jsonb_build_object('text', l.text, 'at', (extract(epoch from l.created_at) * 1000)::bigint, 'mine', l.user_id = me,
          'name', case when l.user_id = s.contractor_id then coalesce((select name from contractor_profiles where user_id = l.user_id), 'Подрядчик') else coalesce((select name from worker_profiles where user_id = l.user_id), 'Участник') end) end,
        'unread', exists (select 1 from notifications n where n.user_id = me and not n.read and n.type = 'message' and n.link = '#/team/' || s.id)) as j,
      l.id as ord, s.date as d
    from shifts s left join lateral (select * from messages m where m.scope = 'shift:' || s.id order by m.id desc limit 1) l on true
    where s.status <> 'cancelled' and case when a->>0 = 'contractor'
        then s.contractor_id = me and exists (select 1 from shift_members m where m.shift_id = s.id and m.role <> 'owner')
        else exists (select 1 from shift_members m where m.shift_id = s.id and m.user_id = me and m.role <> 'owner') end
  ) x $$;

create or replace function api_myDialogs(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('app_id', x.id, 'last', _msg_json(l), 'info', api_dmInfo(me, jsonb_build_array(x.id)),
    'unread', exists (select 1 from notifications n where n.user_id = me and not n.read and n.type = 'message' and n.link = '#/chat/' || x.id)) order by l.id desc), '[]')
  from applications x join shifts s on s.id = x.shift_id
  join lateral (select * from messages m where m.scope = 'dm:' || x.id order by m.id desc limit 1) l on true
  where case a->>0 when 'contractor' then s.contractor_id = me when 'worker' then x.worker_id = me else (x.worker_id = me or s.contractor_id = me) end $$;

create or replace function api_markRead(me bigint, a jsonb) returns jsonb language sql as $$
  with u as (update notifications set read = true where user_id = me and not read and (a->>0 is null or link = a->>0) returning 1) select to_jsonb(true) $$;

create or replace function api_sendMessage(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare m messages; t text := trim(coalesce(a->>1,'')); k text := a->>2; r jsonb; sh shifts; sname text; lnk text;
begin
  perform _assert_chat(me, a->>0);
  if t = '' or length(t) > 2000 then perform _fail('invalid', 'Некорректное сообщение'); end if;
  if k is not null then select result into r from idempotency_keys where user_id = me and key = k; if found then return r; end if; end if;
  insert into messages(scope, user_id, text) values (a->>0, me, t) returning * into m;
  if a->>0 like 'shift:%' then select * into sh from shifts where id = substr(a->>0, 7)::bigint; lnk := '#/team/' || sh.id;
  else select s.* into sh from applications x join shifts s on s.id = x.shift_id where x.id = substr(a->>0, 4)::bigint; lnk := '#/chat/' || substr(a->>0, 4); end if;
  sname := case when sh.contractor_id = me then (select name from contractor_profiles where user_id = me) else (select name from worker_profiles where user_id = me) end;
  insert into notifications(user_id, type, text, link)
  select r2.uid, 'message', format('%s: новое сообщение в «%s»', coalesce(sname, 'Участник'), sh.title), lnk
  from (select user_id as uid from shift_members where a->>0 like 'shift:%' and shift_id = substr(a->>0, 7)::bigint
        union select x.worker_id from applications x where a->>0 like 'dm:%' and x.id = substr(a->>0, 4)::bigint
        union select s.contractor_id from applications x join shifts s on s.id = x.shift_id where a->>0 like 'dm:%' and x.id = substr(a->>0, 4)::bigint) r2
  where r2.uid <> me and not exists (select 1 from notifications n where n.user_id = r2.uid and n.type = 'message' and not n.read and n.link = lnk);
  r := _msg_json(m);
  if k is not null then insert into idempotency_keys(user_id, key, result) values (me, k, r) on conflict do nothing; end if;
  return r;
end $$;

create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','mySkips','unskipAll','apply','undoApply','withdraw','myApplications',
    'toggleFav','favorites','favIds','contractorPage','workerPage','createShift','myShifts','contractorStats','updateShift','cancelShift','completeShift','applicants','decide',
    'team','myTeams','teamChats','setSenior','removeMember','setAttendance','messages','sendMessage','pinMessage','dmInfo','myDialogs','pendingReviews','submitReview','skipReview',
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
