-- Игра «Рейс»: прогресс, бонусы, задания и гараж привязаны к аккаунту.
--  • Бонусы — игровая валюта: не деньги, не выводятся и не влияют на отклики, рейтинг и выдачу смен.
--  • Начисляет только сервер. Заезд начинается с gameStart, результат проверяется на правдоподобие (время, расстояние, плотность бонусов), есть дневной потолок.
--  • Персональных данных здесь нет: при удалении аккаунта всё игровое стирается вместе с ним.
--  • Цены и уровни совпадают с js/game-core.js (проверяет автотест).

create table if not exists game_profiles (
  user_id bigint primary key references users(id) on delete cascade,
  coins bigint not null default 0 check (coins >= 0), xp bigint not null default 0 check (xp >= 0),
  truck text not null default 'van', paint text not null default 'green',
  trucks text[] not null default '{van}', paints text[] not null default '{green}',
  upgrades jsonb not null default '{}', stars jsonb not null default '{}',     -- {"магнит": уровень}, {"номер уровня": звёзды}
  best_endless int not null default 0, total_distance bigint not null default 0, total_runs int not null default 0,
  streak int not null default 0, last_bonus date, milestones text[] not null default '{}',
  updated_at timestamptz not null default now());

create table if not exists game_runs (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  level int,                                              -- null — бесконечный рейс
  seed int not null, started_at timestamptz not null default now(), finished_at timestamptz, result jsonb);
create index if not exists game_runs_user_idx on game_runs (user_id, started_at);
create index if not exists game_runs_time_idx on game_runs (started_at);

create table if not exists game_daily (
  user_id bigint not null references users(id) on delete cascade, day date not null,
  progress jsonb not null default '{}', claimed text[] not null default '{}', earned int not null default 0,
  primary key (user_id, day));

alter table game_profiles enable row level security;
alter table game_runs enable row level security;
alter table game_daily enable row level security;
revoke all on game_profiles, game_runs, game_daily from anon, authenticated;

-- то же, что в js/game-core.js
create or replace function _game_catalog() returns jsonb language sql immutable as $$ select '{"levels":[{"id":1,"zone":"sklad","len":450,"cargo":3,"reward":30},{"id":2,"zone":"sklad","len":550,"cargo":3,"reward":35},{"id":3,"zone":"sklad","len":650,"cargo":4,"reward":40},{"id":4,"zone":"sklad","len":800,"cargo":4,"reward":50},{"id":5,"zone":"sklad","len":1000,"cargo":5,"reward":70},{"id":6,"zone":"gorod","len":800,"cargo":4,"reward":70},{"id":7,"zone":"gorod","len":900,"cargo":5,"reward":80},{"id":8,"zone":"gorod","len":1000,"cargo":5,"reward":90},{"id":9,"zone":"gorod","len":1150,"cargo":6,"reward":100},{"id":10,"zone":"gorod","len":1300,"cargo":6,"reward":130},{"id":11,"zone":"trassa","len":1200,"cargo":6,"reward":130},{"id":12,"zone":"trassa","len":1400,"cargo":7,"reward":150},{"id":13,"zone":"trassa","len":1600,"cargo":7,"reward":170},{"id":14,"zone":"trassa","len":1800,"cargo":8,"reward":200},{"id":15,"zone":"trassa","len":2200,"cargo":10,"reward":300}],"trucks":[{"id":"van","price":0,"coinBonus":0},{"id":"gazel","price":1200,"coinBonus":0.05},{"id":"box","price":3500,"coinBonus":0.05},{"id":"dump","price":8000,"coinBonus":0.1},{"id":"fura","price":16000,"coinBonus":0.15}],"paints":[{"id":"green","price":0},{"id":"white","price":150},{"id":"red","price":200},{"id":"blue","price":200},{"id":"orange","price":300},{"id":"purple","price":500},{"id":"black","price":700},{"id":"gold","price":1500}],"upgrades":["magnet","shield","x2"],"upgradeCost":[150,350,700,1400,2800],"quests":[{"id":"d1000","group":"distance","type":"distance","target":1000,"reward":40},{"id":"d2500","group":"distance","type":"distance","target":2500,"reward":80},{"id":"d5000","group":"distance","type":"distance","target":5000,"reward":150},{"id":"c150","group":"collect","type":"coins","target":150,"reward":50},{"id":"c400","group":"collect","type":"coins","target":400,"reward":100},{"id":"b5","group":"collect","type":"cargo","target":5,"reward":50},{"id":"b12","group":"collect","type":"cargo","target":12,"reward":110},{"id":"r3","group":"skill","type":"runs","target":3,"reward":40},{"id":"j15","group":"skill","type":"jumps","target":15,"reward":50},{"id":"k8","group":"skill","type":"ducks","target":8,"reward":50},{"id":"n1","group":"skill","type":"clean","target":1,"reward":100}],"milestones":[{"id":"km10","type":"total_distance","target":10000,"reward":200},{"id":"km50","type":"total_distance","target":50000,"reward":800},{"id":"star10","type":"total_stars","target":10,"reward":200},{"id":"star45","type":"total_stars","target":45,"reward":2000},{"id":"car2","type":"trucks","target":2,"reward":150},{"id":"car5","type":"trucks","target":5,"reward":2500},{"id":"lvl5","type":"level","target":5,"reward":300},{"id":"lvl10","type":"level","target":10,"reward":1000},{"id":"end1","type":"best_endless","target":1000,"reward":150},{"id":"end3","type":"best_endless","target":3000,"reward":600}],"dailyBonus":[20,30,40,60,80,100,200],"dailyCap":6000}'::jsonb $$;

create or replace function _game_level(xp bigint) returns int language sql immutable as $$
  select floor((1 + sqrt(1 + 4 * greatest(xp, 0) / 50.0)) / 2)::int $$;

create or replace function _game_profile(uid bigint) returns game_profiles language plpgsql as $$
declare p game_profiles;
begin
  insert into game_profiles(user_id) values (uid) on conflict do nothing;
  select * into p from game_profiles where user_id = uid;
  return p;
end $$;

create or replace function _game_day(uid bigint) returns game_daily language plpgsql as $$
declare d game_daily;
begin
  insert into game_daily(user_id, day) values (uid, current_date) on conflict do nothing;
  select * into d from game_daily where user_id = uid and day = current_date;
  return d;
end $$;

-- три задания на день: по одному из группы, одинаковые для всех
create or replace function _game_quests(d date) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x.q order by x.ord), '[]') from (
    select g.ord, (select q from jsonb_array_elements(_game_catalog()->'quests') q where q->>'group' = g.grp order by q->>'id'
                   offset abs(hashtext(d::text || g.grp)::bigint) % (select count(*) from jsonb_array_elements(_game_catalog()->'quests') c where c->>'group' = g.grp) limit 1) as q
    from (values (1, 'distance'), (2, 'collect'), (3, 'skill')) g(ord, grp)) x $$;

create or replace function _game_stars(p game_profiles) returns int language sql immutable as $$
  select coalesce(sum(v::int), 0)::int from jsonb_each_text(p.stars) e(k, v) $$;

create or replace function _game_progress(p game_profiles, typ text) returns bigint language sql immutable as $$
  select case typ when 'total_distance' then p.total_distance when 'total_stars' then _game_stars(p) when 'trucks' then cardinality(p.trucks)
                  when 'level' then _game_level(p.xp) when 'best_endless' then p.best_endless else 0 end $$;

create or replace function _game_bonus_next(p game_profiles) returns int language sql stable as $$
  select (_game_catalog()->'dailyBonus'->>(least(case when p.last_bonus = current_date - 1 then p.streak else 0 end, 6)))::int $$;

create or replace function _game_state(me bigint) returns jsonb language plpgsql as $$
declare p game_profiles := _game_profile(me); d game_daily := _game_day(me);
begin
  return jsonb_build_object('coins', p.coins, 'xp', p.xp, 'level', _game_level(p.xp), 'truck', p.truck, 'paint', p.paint,
    'trucks', to_jsonb(p.trucks), 'paints', to_jsonb(p.paints), 'upgrades', p.upgrades, 'stars', p.stars,
    'best_endless', p.best_endless, 'total_distance', p.total_distance, 'total_runs', p.total_runs,
    'earned_today', d.earned,
    'bonus', jsonb_build_object('available', p.last_bonus is distinct from current_date, 'streak', p.streak, 'next', _game_bonus_next(p)),
    'quests', (select coalesce(jsonb_agg(jsonb_build_object('id', q->>'id', 'progress', least(coalesce((d.progress->>(q->>'type'))::int, 0), (q->>'target')::int), 'claimed', (q->>'id') = any(d.claimed))), '[]') from jsonb_array_elements(_game_quests(d.day)) q),
    'milestones', (select coalesce(jsonb_agg(jsonb_build_object('id', m->>'id', 'progress', least(_game_progress(p, m->>'type'), (m->>'target')::bigint), 'claimed', (m->>'id') = any(p.milestones))), '[]') from jsonb_array_elements(_game_catalog()->'milestones') m));
end $$;

create or replace function api_gameState(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin return _game_state(me); end $$;

-- начало заезда: { level: номер } или { endless: true }. Уровень открывается звездой за предыдущий.
create or replace function api_gameStart(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare o jsonb := coalesce(a->0, '{}'); lvl int := _int(o->>'level'); p game_profiles := _game_profile(me); r game_runs;
begin
  if o->'endless' is distinct from 'true'::jsonb then
    if lvl is null or not exists (select 1 from jsonb_array_elements(_game_catalog()->'levels') l where (l->>'id')::int = lvl) then perform _fail('not_found', 'Такого рейса нет'); end if;
    if lvl > 1 and coalesce((p.stars->>(lvl - 1)::text)::int, 0) < 1 then perform _fail('forbidden', 'Сначала пройдите предыдущий рейс'); end if;
  else lvl := null; end if;
  insert into game_runs(user_id, level, seed) values (me, lvl, floor(random() * 2147483647)::int) returning * into r;
  return jsonb_build_object('run_id', r.id, 'seed', r.seed, 'level', r.level);
end $$;

-- конец заезда: проверяем правдоподобие и начисляем. Повторная отправка возвращает тот же результат.
create or replace function api_gameFinish(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare r game_runs; s jsonb := coalesce(a->1, '{}'); cat jsonb := _game_catalog(); lvl jsonb; p game_profiles; d game_daily;
  dist int := greatest(coalesce(_int(s->>'distance'), 0), 0); v_coins int := greatest(coalesce(_int(s->>'coins'), 0), 0); cargo int := greatest(coalesce(_int(s->>'cargo'), 0), 0);
  hits int := greatest(coalesce(_int(s->>'hits'), 0), 0); jumps int := greatest(coalesce(_int(s->>'jumps'), 0), 0); ducks int := greatest(coalesce(_int(s->>'ducks'), 0), 0);
  completed boolean := s->'completed' = 'true'::jsonb; elapsed double precision; v_stars int := 0; old_stars int := 0; new_stars int := 0;
  bonus numeric; raw int; v_earned int; xp_gain int; lvl_before int; lvl_after int; lvl_bonus int := 0; best int; res jsonb; clean boolean;
begin
  select * into r from game_runs where id = _bigint(a->>0) and user_id = me for update;
  if not found then perform _fail('not_found', 'Заезд не найден'); end if;
  if r.finished_at is not null then return r.result || jsonb_build_object('state', _game_state(me)); end if;
  elapsed := extract(epoch from now() - r.started_at);
  if elapsed > 7200 then perform _fail('closed', 'Заезд устарел'); end if;
  if r.level is not null then select l into lvl from jsonb_array_elements(cat->'levels') l where (l->>'id')::int = r.level; end if;
  -- правдоподобие: быстрее 45 м/с никто не ездит, молний на маршруте не больше 0,75 на метр (и ×2 от усиления)
  if dist > elapsed * 45 + 30 or dist > 200000 or v_coins > dist * 1.5 + 10 or hits > 50 or jumps > dist / 3 + 5 or ducks > dist / 3 + 5
     or cargo > coalesce((lvl->>'cargo')::int, dist / 100 + 5) then
    perform _fail('invalid', 'Результат заезда не принят');
  end if;
  if lvl is not null then
    completed := completed and dist >= (lvl->>'len')::int - 3;
    dist := least(dist, (lvl->>'len')::int + 5);
    if completed then v_stars := 1 + (case when cargo >= (lvl->>'cargo')::int then 1 else 0 end) + (case when hits = 0 then 1 else 0 end); end if;
  else completed := false; end if;
  clean := lvl is not null and completed and hits = 0;

  p := _game_profile(me); d := _game_day(me);
  select coalesce((t->>'coinBonus')::numeric, 0) into bonus from jsonb_array_elements(cat->'trucks') t where t->>'id' = p.truck;
  if lvl is not null then
    old_stars := coalesce((p.stars->>(r.level::text))::int, 0);
    new_stars := greatest(v_stars - old_stars, 0);
    raw := floor(v_coins * (1 + coalesce(bonus, 0))) + new_stars * (lvl->>'reward')::int;
  else
    raw := floor(v_coins * (1 + coalesce(bonus, 0))) + dist / 50;
  end if;
  v_earned := least(raw, greatest((cat->>'dailyCap')::int - d.earned, 0));
  xp_gain := dist / 10 + new_stars * 25 + case when completed then 10 else 0 end;
  lvl_before := _game_level(p.xp); lvl_after := _game_level(p.xp + xp_gain);
  for i in (lvl_before + 1)..lvl_after loop lvl_bonus := lvl_bonus + 50 * i; end loop;
  best := greatest(p.best_endless, case when r.level is null then dist else 0 end);

  update game_profiles set coins = coins + v_earned + lvl_bonus, xp = xp + xp_gain, best_endless = best, total_distance = total_distance + dist, total_runs = total_runs + 1,
    stars = case when lvl is not null and v_stars > old_stars then game_profiles.stars || jsonb_build_object(r.level::text, v_stars) else game_profiles.stars end, updated_at = now()
    where user_id = me;
  update game_daily set earned = earned + v_earned, progress = progress || jsonb_build_object(
      'distance', coalesce((progress->>'distance')::int, 0) + dist, 'coins', coalesce((progress->>'coins')::int, 0) + v_coins, 'cargo', coalesce((progress->>'cargo')::int, 0) + cargo,
      'runs', coalesce((progress->>'runs')::int, 0) + 1, 'jumps', coalesce((progress->>'jumps')::int, 0) + jumps, 'ducks', coalesce((progress->>'ducks')::int, 0) + ducks,
      'clean', coalesce((progress->>'clean')::int, 0) + (case when clean then 1 else 0 end))
    where user_id = me and day = current_date;

  res := jsonb_build_object('earned', v_earned, 'capped', v_earned < raw, 'xp', xp_gain, 'completed', completed, 'stars', v_stars, 'new_stars', new_stars, 'best', best,
    'level_before', lvl_before, 'level_after', lvl_after, 'level_bonus', lvl_bonus, 'distance', dist, 'cargo', cargo, 'hits', hits);
  update game_runs set finished_at = now(), result = res where id = r.id;
  return res || jsonb_build_object('state', _game_state(me));
end $$;

-- покупка: { kind: truck|paint, id }. Купленное сразу выбирается.
create or replace function api_gameBuy(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare kind text := a->0->>'kind'; item text := a->0->>'id'; cat jsonb := _game_catalog(); price int; p game_profiles := _game_profile(me);
begin
  if kind not in ('truck', 'paint') then perform _fail('invalid', 'Некорректная покупка'); end if;
  select (x->>'price')::int into price from jsonb_array_elements(cat->(kind || 's')) x where x->>'id' = item;
  if price is null then perform _fail('not_found', 'Такого нет в гараже'); end if;
  if item = any(case when kind = 'truck' then p.trucks else p.paints end) then perform _fail('conflict', 'Уже куплено'); end if;
  if p.coins < price then perform _fail('invalid', 'Не хватает бонусов'); end if;
  if kind = 'truck' then update game_profiles set coins = coins - price, trucks = trucks || item, truck = item, updated_at = now() where user_id = me;
  else update game_profiles set coins = coins - price, paints = paints || item, paint = item, updated_at = now() where user_id = me; end if;
  return _game_state(me);
end $$;

create or replace function api_gameSelect(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare kind text := a->0->>'kind'; item text := a->0->>'id'; p game_profiles := _game_profile(me);
begin
  if kind = 'truck' and item = any(p.trucks) then update game_profiles set truck = item, updated_at = now() where user_id = me;
  elsif kind = 'paint' and item = any(p.paints) then update game_profiles set paint = item, updated_at = now() where user_id = me;
  else perform _fail('forbidden', 'Сначала купите это в гараже'); end if;
  return _game_state(me);
end $$;

create or replace function api_gameUpgrade(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare item text := a->>0; cat jsonb := _game_catalog(); p game_profiles := _game_profile(me); lvl int; price int;
begin
  if not (cat->'upgrades') ? coalesce(item, '') then perform _fail('not_found', 'Такого улучшения нет'); end if;
  lvl := coalesce((p.upgrades->>item)::int, 0);
  if lvl >= jsonb_array_length(cat->'upgradeCost') then perform _fail('conflict', 'Улучшение уже на максимуме'); end if;
  price := (cat->'upgradeCost'->>lvl)::int;
  if p.coins < price then perform _fail('invalid', 'Не хватает бонусов'); end if;
  update game_profiles set coins = coins - price, upgrades = upgrades || jsonb_build_object(item, lvl + 1), updated_at = now() where user_id = me;
  return _game_state(me);
end $$;

create or replace function api_gameClaimQuest(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare d game_daily := _game_day(me); q jsonb; begin
  perform _game_profile(me);
  select x into q from jsonb_array_elements(_game_quests(d.day)) x where x->>'id' = a->>0;
  if q is null then perform _fail('not_found', 'Такого задания сегодня нет'); end if;
  if (q->>'id') = any(d.claimed) then perform _fail('conflict', 'Награда уже получена'); end if;
  if coalesce((d.progress->>(q->>'type'))::int, 0) < (q->>'target')::int then perform _fail('invalid', 'Задание ещё не выполнено'); end if;
  update game_daily set claimed = claimed || (q->>'id') where user_id = me and day = d.day;
  update game_profiles set coins = coins + (q->>'reward')::int, updated_at = now() where user_id = me;
  return _game_state(me);
end $$;

create or replace function api_gameClaimMilestone(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p game_profiles := _game_profile(me); m jsonb;
begin
  select x into m from jsonb_array_elements(_game_catalog()->'milestones') x where x->>'id' = a->>0;
  if m is null then perform _fail('not_found', 'Такого достижения нет'); end if;
  if (m->>'id') = any(p.milestones) then perform _fail('conflict', 'Награда уже получена'); end if;
  if _game_progress(p, m->>'type') < (m->>'target')::bigint then perform _fail('invalid', 'Достижение ещё не выполнено'); end if;
  update game_profiles set coins = coins + (m->>'reward')::int, milestones = milestones || (m->>'id'), updated_at = now() where user_id = me;
  return _game_state(me);
end $$;

-- ежедневный бонус: день за днём больше, пропуск сбрасывает серию
create or replace function api_gameDailyBonus(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p game_profiles := _game_profile(me); amount int;
begin
  if p.last_bonus = current_date then perform _fail('conflict', 'Сегодняшний бонус уже получен'); end if;
  amount := _game_bonus_next(p);
  update game_profiles set coins = coins + amount, streak = case when last_bonus = current_date - 1 then streak + 1 else 1 end, last_bonus = current_date, updated_at = now() where user_id = me;
  return _game_state(me) || jsonb_build_object('got', amount);
end $$;

-- при удалении аккаунта игровые данные стираются вместе с остальным
create or replace function _users_clear_phone() returns trigger language plpgsql as $$
begin
  new.phone_verified := null; new.phone_verified_at := null;
  new.terms_version := null; new.age_confirmed_at := null; new.extra_consent := '{}'; new.extra_consent_version := null;
  delete from phone_codes where user_id = new.id;
  delete from shift_drafts where user_id = new.id;
  delete from game_profiles where user_id = new.id;
  delete from game_runs where user_id = new.id;
  delete from game_daily where user_id = new.id;
  return new;
end $$;

-- обслуживание: старые заезды и дневные счётчики не копятся
create or replace function maintenance() returns jsonb language plpgsql as $$
declare e int; i int; n int; o int; sv int; pc int; dr int; gr int;
begin
  delete from events where created_at < now() - interval '60 days'; get diagnostics e = row_count;
  delete from idempotency_keys where created_at < now() - interval '3 days'; get diagnostics i = row_count;
  delete from notifications where tg_sent and created_at < now() - interval '60 days'; get diagnostics n = row_count;
  delete from phone_codes where created_at < now() - interval '7 days'; get diagnostics pc = row_count;
  delete from shift_drafts where updated_at < now() - interval '30 days'; get diagnostics dr = row_count;
  delete from game_runs where started_at < now() - interval '30 days'; get diagnostics gr = row_count;
  delete from game_daily where day < current_date - 14;
  insert into notifications(user_id, type, text, link)
    select s.contractor_id, 'shift_overdue', format('Смена «%s» прошла. Завершите её и оцените исполнителей', s.title), '#/c/shift/' || s.id
    from shifts s
    where s.status in ('open','full') and _shift_ended(s) and s.date >= current_date - 14
      and exists (select 1 from shift_members m where m.shift_id = s.id and m.role <> 'owner')
      and not exists (select 1 from notifications x where x.user_id = s.contractor_id and x.type = 'shift_overdue' and x.link = '#/c/shift/' || s.id);
  get diagnostics o = row_count;
  with gone as (
    delete from shift_favs v using shifts s
    where s.id = v.shift_id and (s.status <> 'open' or s.hidden or _shift_ended(s))
    returning v.user_id, s.title, s.status)
  insert into notifications(user_id, type, text, link)
    select user_id, 'saved_gone', format('Отложенная смена «%s» %s', title, case when status = 'full' then 'уже набрана' when status = 'cancelled' then 'отменена' else 'больше недоступна' end), '#/w/fav' from gone;
  get diagnostics sv = row_count;
  return jsonb_build_object('events', e, 'idempotency', i, 'notifications', n, 'overdue_reminders', o, 'saved_gone', sv, 'phone_codes', pc, 'drafts', dr, 'game_runs', gr);
end $$;

-- ===== диспетчер: + игра =====
create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','mySkips','unskipAll','apply','undoApply','withdraw','myApplications',
    'toggleFav','favorites','favIds','contractorPage','workerPage','createShift','myShifts','contractorStats','updateShift','cancelShift','completeShift','applicants','decide',
    'team','myTeams','teamChats','setSenior','removeMember','setAttendance','messages','sendMessage','pinMessage','dmInfo','myDialogs','pendingReviews','submitReview','skipReview','userReviews',
    'toggleShiftFav','savedShifts','myWorkers','leaderboard','searchContractors','mySubscription','boostShift','supportInbox','phoneVerifyCode','phoneReset',
    'saveShiftDraft','getShiftDraft','deleteShiftDraft','giveExtraConsent','revokeExtraConsent','myConsents',
    'gameState','gameStart','gameFinish','gameBuy','gameSelect','gameUpgrade','gameClaimQuest','gameClaimMilestone','gameDailyBonus',
    'notifications','markRead','report','track','logError','acceptTerms','deleteAccount',
    'adminStats','adminUsers','adminBlock','adminVerify','adminShifts','adminHideShift','adminReports','adminResolveReport','adminCategories','adminSaveCategory','adminAudit','adminGrantPro','adminRevokePro','adminConsents'];
begin
  if not (fn = any(allowed)) then perform _fail('not_implemented', 'Неизвестный метод: ' || fn); end if;
  if not (fn = any(array['me','categories','acceptTerms','deleteAccount','track','logError'])) and not _terms_ok(me) then
    perform _fail('terms_required', 'Сначала подтвердите возраст и примите Пользовательское соглашение');
  end if;
  execute format('select public.%I($1,$2)', lower('api_' || fn)) into r using me, coalesce(args, '[]'::jsonb);
  return r;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
