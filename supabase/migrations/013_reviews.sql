-- Отзывы видны всем и ведут к профилю автора:
--  • в каждом отзыве: кто оставил (имя, фото, роль), по какой смене, критерии, дата;
--  • userReviews(пользователь, роль, смещение) — полный список отзывов страницами по 20.

create or replace function _reviews_page(uid bigint, rl text, lim int, off int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'stars', r.stars, 'criteria', r.criteria, 'text', r.text, 'at', (extract(epoch from r.created_at) * 1000)::bigint,
    'from_user', r.from_user, 'from_role', case when r.from_user = s.contractor_id then 'contractor' else 'worker' end,
    'from_name', coalesce(case when r.from_user = s.contractor_id then (select coalesce(nullif(company, ''), name) from contractor_profiles where user_id = r.from_user)
                               else (select name from worker_profiles where user_id = r.from_user) end, 'Удалённый пользователь'),
    'from_avatar', case when r.from_user = s.contractor_id then (select avatar from contractor_profiles where user_id = r.from_user) else (select avatar from worker_profiles where user_id = r.from_user) end,
    'shift_id', s.id, 'shift_title', s.title) order by r.id desc), '[]')
  from (select rv.* from reviews rv join shifts sh on sh.id = rv.shift_id where rv.to_user = uid and ((sh.contractor_id = uid) = (rl = 'contractor')) order by rv.id desc limit lim offset off) r
  join shifts s on s.id = r.shift_id $$;

create or replace function _reviews_as(uid bigint, as_role text) returns jsonb language sql stable as $$ select _reviews_page(uid, as_role, 10, 0) $$;

create or replace function api_userReviews(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare uid bigint := (a->>0)::bigint; rl text := case when a->>1 = 'contractor' then 'contractor' else 'worker' end; off int := greatest(coalesce(_int(a->>2), 0), 0);
begin
  if (rl = 'contractor' and not exists (select 1 from contractor_profiles where user_id = uid)) or (rl = 'worker' and not exists (select 1 from worker_profiles where user_id = uid)) then
    perform _fail('not_found', 'Профиль не найден'); end if;
  return jsonb_build_object('role', rl, 'user_id', uid,
    'name', case when rl = 'contractor' then (select coalesce(nullif(company, ''), name) from contractor_profiles where user_id = uid) else (select name from worker_profiles where user_id = uid) end,
    'avatar', case when rl = 'contractor' then (select avatar from contractor_profiles where user_id = uid) else (select avatar from worker_profiles where user_id = uid) end,
    'total', (_rating_as(uid, rl)->>'reviews')::int, 'rating', _rating_as(uid, rl)->'rating', 'items', _reviews_page(uid, rl, 20, off));
end $$;

create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','mySkips','unskipAll','apply','undoApply','withdraw','myApplications',
    'toggleFav','favorites','favIds','contractorPage','workerPage','createShift','myShifts','contractorStats','updateShift','cancelShift','completeShift','applicants','decide',
    'team','myTeams','teamChats','setSenior','removeMember','setAttendance','messages','sendMessage','pinMessage','dmInfo','myDialogs','pendingReviews','submitReview','skipReview','userReviews',
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
