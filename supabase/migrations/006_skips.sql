-- Пропущенные смены: исполнитель может посмотреть всё, что свайпнул влево, и вернуть смену в ленту.
-- Показываем только смены, на которые ещё можно откликнуться (открыта, не скрыта, не в прошлом, отклика нет).
create or replace function api_mySkips(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(_shift_json(s, me) || jsonb_build_object('skipped_at', (extract(epoch from k.created_at) * 1000)::bigint) order by k.created_at desc), '[]')
  from skips k join shifts s on s.id = k.shift_id
  where k.user_id = me and s.status = 'open' and not s.hidden and s.date >= current_date
    and not exists (select 1 from applications x where x.shift_id = s.id and x.worker_id = me) $$;

-- вернуть в ленту все пропущенные разом
create or replace function api_unskipAll(me bigint, a jsonb) returns jsonb language sql as $$
  with d as (delete from skips where user_id = me returning 1) select to_jsonb(count(*)) from d $$;

-- ----- диспетчер: + mySkips, unskipAll -----
create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','mySkips','unskipAll','apply','undoApply','withdraw','myApplications',
    'toggleFav','favorites','favIds','contractorPage','workerPage','createShift','myShifts','contractorStats','updateShift','cancelShift','completeShift','applicants','decide',
    'team','myTeams','setSenior','removeMember','setAttendance','messages','sendMessage','pinMessage','dmInfo','myDialogs','pendingReviews','submitReview',
    'notifications','markRead','report','track','logError',
    'adminStats','adminUsers','adminBlock','adminVerify','adminShifts','adminHideShift','adminReports','adminResolveReport','adminCategories','adminSaveCategory','adminAudit'];
begin
  if not (fn = any(allowed)) then perform _fail('not_implemented', 'Неизвестный метод: ' || fn); end if;
  execute format('select public.%I($1,$2)', lower('api_' || fn)) into r using me, coalesce(args, '[]'::jsonb);
  return r;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
