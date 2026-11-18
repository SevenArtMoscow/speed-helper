-- Вкладка «Бот» в админ-панели: трафик бота и рассылки без программиста.
-- Рассылка — обычные записи в notifications: бот отправляет их в Telegram с кнопкой «Открыть SPEED HELPER», в приложении они видны в уведомлениях.
-- Бот записывает итог отправки (tg_result), поэтому видно, сколько дошло, а сколько нет (человек не запускал бота или заблокировал его).

create table if not exists broadcasts (
  id bigint generated always as identity primary key,
  author bigint references users(id) on delete set null,
  audience text not null check (audience in ('workers', 'contractors', 'all')),
  text text not null check (char_length(text) between 2 and 1000),
  link text,
  recipients int not null default 0,
  cancelled_at timestamptz,
  cancelled_count int not null default 0,       -- сколько сообщений не ушло из-за остановки
  created_at timestamptz not null default now()
);
alter table broadcasts enable row level security;
revoke all on broadcasts from anon, authenticated;

alter table notifications add column if not exists broadcast_id bigint references broadcasts(id) on delete set null;
-- ok — доставлено; old — доставлено через прежний бот (переезд); unreachable — не запускал бота или заблокировал; skipped — заблокирован у нас или тестовый; expired — пролежало больше суток
alter table notifications add column if not exists tg_result text;
create index if not exists notifications_broadcast_idx on notifications (broadcast_id) where broadcast_id is not null;

-- рассылка исполнителям 18.11.2026 сделана вручную до появления вкладки — переносим её в историю
with b as (
  insert into broadcasts(author, audience, text, link, recipients, created_at)
  select null, 'workers', min(text), '#/w/search', count(*), min(created_at) from notifications where type = 'announcement' having count(*) > 0
  returning id
)
update notifications n set broadcast_id = b.id from b where n.type = 'announcement' and n.broadcast_id is null;

-- кому уходит рассылка: живые аккаунты с Telegram; заблокированные, удалённые и тестовые не получают
create or replace function _broadcast_targets(aud text) returns setof bigint language sql stable as $$
  select u.id from users u
  where not u.blocked and not u.is_fake and u.deleted_at is null and u.tg_id is not null
    and case aud when 'workers' then 'worker' = any(u.roles) when 'contractors' then 'contractor' = any(u.roles) else true end $$;

-- ----- трафик -----
create or replace function api_adminBotStats(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
declare today date := (now() at time zone 'Europe/Moscow')::date;
begin perform _admin(me);
  return jsonb_build_object(
    'audience', jsonb_build_object('workers', (select count(*) from _broadcast_targets('workers')), 'contractors', (select count(*) from _broadcast_targets('contractors')), 'all', (select count(*) from _broadcast_targets('all'))),
    'new_1d', (select count(*) from users where not is_fake and created_at > now() - interval '1 day'),
    'new_7d', (select count(*) from users where not is_fake and created_at > now() - interval '7 days'),
    'active_1d', (select count(distinct e.user_id) from events e join users u on u.id = e.user_id where not u.is_fake and e.created_at > now() - interval '1 day'),
    'active_7d', (select count(distinct e.user_id) from events e join users u on u.id = e.user_id where not u.is_fake and e.created_at > now() - interval '7 days'),
    'sent_1d', (select count(*) from notifications where tg_sent and coalesce(tg_result, 'ok') in ('ok', 'old') and created_at > now() - interval '1 day'),
    'sent_7d', (select count(*) from notifications where tg_sent and coalesce(tg_result, 'ok') in ('ok', 'old') and created_at > now() - interval '7 days'),
    'unreachable_7d', (select count(*) from notifications where tg_result = 'unreachable' and created_at > now() - interval '7 days'),
    'queue', (select count(*) from notifications where not tg_sent and created_at > now() - interval '1 day'),
    'days', (select jsonb_agg(jsonb_build_object('date', d,
        'new', (select count(*) from users where not is_fake and (created_at at time zone 'Europe/Moscow')::date = d),
        'active', (select count(distinct e.user_id) from events e join users u on u.id = e.user_id where not u.is_fake and (e.created_at at time zone 'Europe/Moscow')::date = d),
        'sent', (select count(*) from notifications where tg_sent and coalesce(tg_result, 'ok') in ('ok', 'old') and (created_at at time zone 'Europe/Moscow')::date = d)) order by d desc)
      from generate_series(today - 6, today, interval '1 day') g(dd), lateral (select g.dd::date as d) x));
end $$;

-- ----- рассылка -----
-- test — проверка на себе: сообщение приходит только автору и в историю не попадает
create or replace function api_adminBroadcast(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := coalesce(a->0, '{}'); aud text := p->>'audience'; txt text := btrim(coalesce(p->>'text', '')); test boolean := coalesce((p->>'test')::boolean, false);
  lnk text; bid bigint; n int;
begin perform _admin(me);
  if aud is null or aud not in ('workers', 'contractors', 'all') then perform _fail('invalid', 'Выберите, кому отправить'); end if;
  if char_length(txt) < 2 then perform _fail('invalid', 'Напишите текст рассылки'); end if;
  if char_length(txt) > 1000 then perform _fail('invalid', 'Текст длиннее 1000 знаков'); end if;
  -- кнопка под сообщением: исполнителям — поиск смен, подрядчикам — главная, всем — просто приложение
  lnk := case aud when 'workers' then '#/w/search' when 'contractors' then '#/c/home' end;
  if test then
    insert into notifications(user_id, type, text, link) values (me, 'announcement', txt, lnk);
    return jsonb_build_object('test', true, 'recipients', 1);
  end if;
  -- защита от двойного нажатия: две настоящие рассылки подряд не уходят
  if exists (select 1 from broadcasts where created_at > now() - interval '2 minutes' and cancelled_at is null) then
    perform _fail('conflict', 'Рассылка только что отправлена. Следующую можно через пару минут');
  end if;
  insert into broadcasts(author, audience, text, link) values (me, aud, txt, lnk) returning id into bid;
  insert into notifications(user_id, type, text, link, broadcast_id) select t, 'announcement', txt, lnk, bid from _broadcast_targets(aud) t;
  get diagnostics n = row_count;
  update broadcasts set recipients = n where id = bid;
  insert into audit_log(actor, action, meta) values (me, 'admin.broadcast', jsonb_build_object('id', bid, 'audience', aud, 'recipients', n));
  return jsonb_build_object('id', bid, 'recipients', n);
end $$;

-- ----- история рассылок -----
create or replace function api_adminBroadcasts(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me);
  return coalesce((select jsonb_agg(x order by id desc) from (
    select b.id, jsonb_build_object('id', b.id, 'at', (extract(epoch from b.created_at) * 1000)::bigint, 'audience', b.audience, 'text', b.text, 'recipients', b.recipients,
      'author', coalesce((select name from contractor_profiles where user_id = b.author), (select name from worker_profiles where user_id = b.author), (select first_name from users where id = b.author)),
      'cancelled', b.cancelled_at is not null, 'cancelled_count', b.cancelled_count,
      'queued', count(n.id) filter (where not n.tg_sent),
      'delivered', count(n.id) filter (where n.tg_result in ('ok', 'old')),
      'unreachable', count(n.id) filter (where n.tg_result = 'unreachable'),
      'skipped', count(n.id) filter (where n.tg_result in ('skipped', 'expired')),
      'unknown', count(n.id) filter (where n.tg_sent and n.tg_result is null),
      'read', count(n.id) filter (where n.read)) as x
    from (select * from broadcasts order by id desc limit 50) b left join notifications n on n.broadcast_id = b.id
    group by b.id, b.created_at, b.audience, b.text, b.recipients, b.author, b.cancelled_at, b.cancelled_count) q), '[]');
end $$;

-- ----- остановка: ещё не отправленные сообщения убираются и из Telegram-очереди, и из уведомлений в приложении -----
create or replace function api_adminCancelBroadcast(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare bid bigint := _bigint(a->>0); n int;
begin perform _admin(me);
  if not exists (select 1 from broadcasts where id = bid) then perform _fail('not_found', 'Рассылка не найдена'); end if;
  delete from notifications where broadcast_id = bid and not tg_sent;
  get diagnostics n = row_count;
  update broadcasts set cancelled_at = coalesce(cancelled_at, now()), cancelled_count = cancelled_count + n where id = bid;
  insert into audit_log(actor, action, meta) values (me, 'admin.broadcast_cancel', jsonb_build_object('id', bid, 'stopped', n));
  return jsonb_build_object('stopped', n);
end $$;

-- ----- диспетчер: новые методы -----
create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','mySkips','unskipAll','apply','undoApply','withdraw','myApplications',
    'toggleFav','favorites','favIds','contractorPage','workerPage','createShift','myShifts','contractorStats','updateShift','cancelShift','completeShift','applicants','decide',
    'team','myTeams','teamChats','setSenior','removeMember','setAttendance','messages','sendMessage','pinMessage','dmInfo','myDialogs','pendingReviews','submitReview','skipReview','userReviews',
    'toggleShiftFav','savedShifts','myWorkers','leaderboard','searchContractors','mySubscription','boostShift','supportInbox','phoneVerifyCode','phoneReset',
    'saveShiftDraft','getShiftDraft','deleteShiftDraft','giveExtraConsent','revokeExtraConsent','myConsents',
    'gameState','gameStart','gameFinish','gameBuy','gameSelect','gameUpgrade','gameClaimQuest','gameClaimMilestone','gameDailyBonus',
    'notifications','markRead','report','track','logError','acceptTerms','deleteAccount',
    'adminStats','adminUsers','adminBlock','adminVerify','adminShifts','adminHideShift','adminReports','adminResolveReport','adminCategories','adminSaveCategory','adminAudit','adminGrantPro','adminRevokePro','adminConsents',
    'adminBotStats','adminBroadcast','adminBroadcasts','adminCancelBroadcast'];
begin
  if not (fn = any(allowed)) then perform _fail('not_implemented', 'Неизвестный метод: ' || fn); end if;
  if not (fn = any(array['me','categories','acceptTerms','deleteAccount','track','logError'])) and not _terms_ok(me) then
    perform _fail('terms_required', 'Сначала подтвердите возраст и примите Пользовательское соглашение');
  end if;
  execute format('select public.%I($1,$2)', lower('api_' || fn)) into r using me, coalesce(args, '[]'::jsonb);
  return r;
end $$;
