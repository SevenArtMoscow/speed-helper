-- Тестовая нагрузка: «выдуманные» пользователи (is_fake) создаются симулятором (server/tools/simulator.mjs).
--  • у них отрицательный tg_id, бот им ничего не отправляет (см. bot.js);
--  • в админке настоящие пользователи и смены идут первыми, а цифры показателей считаются без тестовых (тестовые — отдельной строкой);
--  • в рейтинге исполнителей тестовые видны только администраторам;
--  • fake_cleanup() удаляет всё тестовое одним вызовом (сообщения, отклики, смены, отзывы, пользователей); данные настоящих людей остаются.

alter table users add column if not exists is_fake boolean not null default false;
create index if not exists users_fake_idx on users (id) where is_fake;

create or replace function api_adminUsers(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me);
  return (select coalesce(jsonb_agg(to_jsonb(u) || jsonb_build_object('name', coalesce((select name from worker_profiles where user_id = u.id), (select name from contractor_profiles where user_id = u.id), u.first_name),
    'verified', coalesce((select verified from contractor_profiles where user_id = u.id), false)) order by u.is_fake, u.id desc), '[]')
    from (select * from users order by is_fake, id desc limit 500) u); end $$;

create or replace function api_adminShifts(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me);
  return (select coalesce(jsonb_agg(_shift_json(s, null) order by (select u.is_fake from users u where u.id = s.contractor_id), s.id desc), '[]')
    from (select * from shifts order by (select u.is_fake from users u where u.id = shifts.contractor_id), id desc limit 300) s); end $$;

create or replace function api_adminStats(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me);
  return jsonb_build_object(
    'users', (select count(*) from users where not is_fake),
    'workers', (select count(*) from worker_profiles w join users u on u.id = w.user_id where not u.is_fake),
    'contractors', (select count(*) from contractor_profiles c join users u on u.id = c.user_id where not u.is_fake),
    'shifts', (select count(*) from shifts s join users u on u.id = s.contractor_id where not u.is_fake),
    'open_shifts', (select count(*) from shifts s join users u on u.id = s.contractor_id where not u.is_fake and s.status = 'open'),
    'applications', (select count(*) from applications x join users w on w.id = x.worker_id join shifts s on s.id = x.shift_id join users c on c.id = s.contractor_id where not w.is_fake and not c.is_fake),
    'accepted', (select count(*) from applications x join users w on w.id = x.worker_id join shifts s on s.id = x.shift_id join users c on c.id = s.contractor_id where not w.is_fake and not c.is_fake and x.status in ('accepted','completed')),
    'completed_shifts', (select count(*) from shifts s join users u on u.id = s.contractor_id where not u.is_fake and s.status = 'completed'),
    'reports_new', (select count(*) from reports where status = 'new'),
    'active_24h', (select count(distinct e.user_id) from events e where e.created_at > now() - interval '1 day' and not exists (select 1 from users u where u.id = e.user_id and u.is_fake)),
    'errors_24h', (select count(*) from events where event = 'error' and created_at > now() - interval '1 day'),
    'fake_users', (select count(*) from users where is_fake),
    'fake_open_shifts', (select count(*) from shifts s join users u on u.id = s.contractor_id where u.is_fake and s.status = 'open'),
    'fake_applications', (select count(*) from applications x join users w on w.id = x.worker_id where w.is_fake)); end $$;

-- рейтинг: тестовые исполнители видны только администраторам
create or replace function api_leaderboard(me bigint, a jsonb) returns jsonb language sql stable as $$
  with p as (select case when a->>0 = 'all' then 'all' else 'month' end as per,
                    case when a->>0 = 'all' then '-infinity'::timestamptz else date_trunc('month', now()) end as since,
                    coalesce((select is_admin from users where id = me), false) as adm),
  done as (
    select ap.worker_id as uid, count(*) as n from applications ap join shifts s on s.id = ap.shift_id, p
    where ap.status = 'completed' and s.completed_at >= p.since
      and not exists (select 1 from shift_members m where m.shift_id = ap.shift_id and m.user_id = ap.worker_id and m.attended is false) group by ap.worker_id),
  rv as (
    select r.to_user as uid, sum(r.stars) as st, avg(r.stars) as av, count(*) as n from reviews r join shifts s on s.id = r.shift_id, p
    where s.contractor_id <> r.to_user and r.created_at >= p.since group by r.to_user),
  sc as (
    select w.user_id as uid, w.name, w.avatar, coalesce(d.n, 0) as shifts, coalesce(rv.st, 0) as stars, round(rv.av, 1) as av, coalesce(d.n, 0) * 10 + coalesce(rv.st, 0) * 2 as score
    from worker_profiles w join users u on u.id = w.user_id left join done d on d.uid = w.user_id left join rv on rv.uid = w.user_id, p
    where (coalesce(d.n, 0) > 0 or coalesce(rv.n, 0) > 0) and (not u.is_fake or p.adm)),
  ranked as (select *, rank() over (order by score desc, shifts desc, uid) as rk from sc)
  select jsonb_build_object('period', (select per from p),
    'top', coalesce((select jsonb_agg(jsonb_build_object('rank', t.rk, 'user_id', t.uid, 'name', t.name, 'avatar', t.avatar, 'score', t.score, 'shifts', t.shifts, 'rating', t.av) order by t.rk, t.uid)
                     from (select * from ranked order by rk, uid limit 20) t), '[]'),
    'me', (select jsonb_build_object('rank', r.rk, 'score', r.score, 'shifts', r.shifts, 'rating', r.av) from ranked r where r.uid = me),
    'participants', (select count(*) from ranked)) $$;

-- полная очистка тестовых данных (вызывается: node server/tools/simulator.mjs --clean)
create or replace function fake_cleanup() returns jsonb language plpgsql as $$
declare nu int; ns int; nm int; na int;
begin
  create temporary table _fk on commit drop as select id from users where is_fake;
  create temporary table _fs on commit drop as select id from shifts where contractor_id in (select id from _fk);
  create temporary table _fa on commit drop as select a.id from applications a where a.worker_id in (select id from _fk) or a.shift_id in (select id from _fs);
  delete from messages where user_id in (select id from _fk); get diagnostics nm = row_count;
  delete from messages where scope like 'dm:%' and substr(scope, 4)::bigint in (select id from _fa);
  delete from messages where scope like 'shift:%' and substr(scope, 7)::bigint in (select id from _fs);
  delete from reviews where from_user in (select id from _fk) or to_user in (select id from _fk) or shift_id in (select id from _fs);
  delete from reports where reporter in (select id from _fk);
  delete from shifts where id in (select id from _fs); get diagnostics ns = row_count;   -- каскадом: отклики, команда, пропуски, закладки
  delete from applications where worker_id in (select id from _fk); get diagnostics na = row_count;
  delete from shift_members where user_id in (select id from _fk);
  delete from favorites where user_id in (select id from _fk) or target_id in (select id from _fk);
  delete from idempotency_keys where user_id in (select id from _fk);
  delete from events where user_id in (select id from _fk);
  delete from audit_log where actor in (select id from _fk);
  delete from users where id in (select id from _fk); get diagnostics nu = row_count;   -- каскадом: профили, уведомления, закладки
  return jsonb_build_object('users', nu, 'shifts', ns, 'applications', na, 'messages', nm);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
