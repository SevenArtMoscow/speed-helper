-- Поиск подрядчиков для исполнителя и вкладки «Активные / Завершённые» в профиле подрядчика.
--  • searchContractors(текст) — до 20 подрядчиков по имени или компании; без текста — самые опытные;
--    заблокированные и тестовые (is_fake) не показываются;
--  • contractorPage теперь отдаёт active_count, completed_count и последние 30 завершённых смен.

create or replace function api_searchContractors(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare q text := lower(left(trim(coalesce(a->>0, '')), 60));
begin
  return coalesce((
    select jsonb_agg(x.j order by x.rel desc, x.done desc, x.id)
    from (
      select c.user_id as id, _contractor_json(c.user_id) as j,
        (select count(*) from shifts s where s.contractor_id = c.user_id and s.status = 'completed') as done,
        case when q = '' then 0
             when strpos(lower(coalesce(c.company, '')), q) = 1 or strpos(lower(c.name), q) = 1 then 2 else 1 end as rel
      from contractor_profiles c join users u on u.id = c.user_id
      where not u.blocked and not u.is_fake and u.deleted_at is null and c.user_id <> me
        and (q = '' or strpos(lower(coalesce(c.company, '')), q) > 0 or strpos(lower(c.name), q) > 0)
      order by rel desc, done desc, c.user_id limit 20
    ) x), '[]'::jsonb);
end $$;

create or replace function api_contractorPage(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin
  if not exists (select 1 from contractor_profiles where user_id = (a->>0)::bigint) then perform _fail('not_found', 'Подрядчик не найден'); end if;
  return jsonb_build_object('contractor', _contractor_json((a->>0)::bigint),
    'shifts', coalesce((select jsonb_agg(_shift_json(s, me) order by s.date, s.start_time) from shifts s where s.contractor_id = (a->>0)::bigint and s.status = 'open' and not s.hidden and s.date >= current_date and not _shift_ended(s)), '[]'),
    'active_count', (select count(*) from shifts s where s.contractor_id = (a->>0)::bigint and s.status = 'open' and not s.hidden and s.date >= current_date and not _shift_ended(s)),
'completed_count', (select count(*) from shifts s where s.contractor_id = (a->>0)::bigint and s.status = 'completed' and not s.hidden),
'completed', coalesce((select jsonb_agg(_shift_json(s, me) order by s.date desc, s.start_time desc) from (select * from shifts x where x.contractor_id = (a->>0)::bigint and x.status = 'completed' and not x.hidden order by x.date desc, x.start_time desc limit 30) s), '[]'),
'reviews', _reviews_as((a->>0)::bigint, 'contractor'), 'is_fav', exists (select 1 from favorites where user_id = me and target_id = (a->>0)::bigint));
end $$;

create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','mySkips','unskipAll','apply','undoApply','withdraw','myApplications',
    'toggleFav','favorites','favIds','contractorPage','workerPage','createShift','myShifts','contractorStats','updateShift','cancelShift','completeShift','applicants','decide',
    'team','myTeams','teamChats','setSenior','removeMember','setAttendance','messages','sendMessage','pinMessage','dmInfo','myDialogs','pendingReviews','submitReview','skipReview','userReviews',
    'toggleShiftFav','savedShifts','myWorkers','leaderboard','searchContractors','mySubscription','boostShift',
    'notifications','markRead','report','track','logError','acceptTerms','deleteAccount',
    'adminStats','adminUsers','adminBlock','adminVerify','adminShifts','adminHideShift','adminReports','adminResolveReport','adminCategories','adminSaveCategory','adminAudit','adminGrantPro','adminRevokePro'];
begin
  if not (fn = any(allowed)) then perform _fail('not_implemented', 'Неизвестный метод: ' || fn); end if;
  execute format('select public.%I($1,$2)', lower('api_' || fn)) into r using me, coalesce(args, '[]'::jsonb);
  return r;
end $$;
