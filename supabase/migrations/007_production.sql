-- Подготовка к продакшену: согласие пользователя, удаление аккаунта (152-ФЗ), лимиты длин полей, индексы, очистка старых данных.

-- ----- согласие и удаление -----
alter table users add column if not exists terms_accepted_at timestamptz;
alter table users add column if not exists deleted_at timestamptz;
-- действующие пользователи до этой миграции приняли условия неявно — просим подтвердить заново при следующем входе
-- (terms_accepted_at остаётся null)

-- ----- лимиты длин (not valid: новые и изменяемые строки проверяются, старые не блокируют миграцию) -----
alter table worker_profiles add constraint worker_len check (
  char_length(name) <= 60 and char_length(city) <= 60 and coalesce(char_length(about), 0) <= 1000 and coalesce(char_length(experience), 0) <= 300
  and coalesce(char_length(phone), 0) <= 20 and coalesce(char_length(avatar), 0) <= 400000 and cardinality(skills) <= 30) not valid;
alter table contractor_profiles add constraint contractor_len check (
  char_length(name) <= 60 and coalesce(char_length(company), 0) <= 100 and char_length(city) <= 60 and coalesce(char_length(about), 0) <= 1000
  and char_length(phone) <= 20 and coalesce(char_length(avatar), 0) <= 400000) not valid;
alter table shifts add constraint shift_len check (
  char_length(title) <= 100 and char_length(description) <= 3000 and char_length(address) <= 300 and cardinality(requirements) <= 20 and pay <= 1000000) not valid;
alter table reports add constraint report_len check (char_length(reason) <= 1000) not valid;

-- ----- индексы -----
create index if not exists notifications_unsent_idx on notifications (id) where not tg_sent;
create index if not exists events_time_idx on events (created_at);
create index if not exists favorites_target_idx on favorites (target_id);
create index if not exists idem_time_idx on idempotency_keys (created_at);

-- ----- профиль: добавляем признак принятого соглашения -----
create or replace function api_me(me bigint, a jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('id', u.id, 'tg_id', u.tg_id, 'first_name', u.first_name, 'username', u.username, 'roles', to_jsonb(u.roles), 'is_admin', u.is_admin,
    'worker', _worker_json(u.id, true), 'contractor', (select to_jsonb(c) || _contractor_json(u.id) from contractor_profiles c where c.user_id = u.id),
    'unread', (select count(*) from notifications n where n.user_id = u.id and not n.read), 'terms_accepted', u.terms_accepted_at is not null)
  from users u where u.id = me $$;

create or replace function api_acceptTerms(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  update users set terms_accepted_at = now(), deleted_at = null where id = me and terms_accepted_at is null;
  if found then insert into audit_log(actor, action, meta) values (me, 'terms.accept', '{}'); end if;
  return 'true';
end $$;

-- Удаление аккаунта: активные смены и отклики отменяются (участники получают уведомления), персональные данные стираются.
-- Строка users остаётся обезличенной (нужна для целостности смен, отзывов и сообщений других людей).
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
  delete from notifications where user_id = me;
  update messages set text = '[сообщение удалено]', pinned = false where user_id = me;
  update reviews set text = null where from_user = me;
  update users set first_name = null, username = null, roles = '{}', terms_accepted_at = null, deleted_at = now() where id = me;
  insert into audit_log(actor, action, meta) values (me, 'account.delete', '{}');
  return 'true';
end $$;

-- ----- очистка старых служебных данных (вызывается сервером раз в несколько часов) -----
create or replace function maintenance() returns jsonb language plpgsql as $$
declare e int; i int; n int;
begin
  delete from events where created_at < now() - interval '60 days'; get diagnostics e = row_count;
  delete from idempotency_keys where created_at < now() - interval '3 days'; get diagnostics i = row_count;
  delete from notifications where tg_sent and created_at < now() - interval '60 days'; get diagnostics n = row_count;
  return jsonb_build_object('events', e, 'idempotency', i, 'notifications', n);
end $$;

-- ----- диспетчер: + acceptTerms, deleteAccount -----
create or replace function public.api(fn text, args jsonb default '[]') returns jsonb language plpgsql security definer set search_path = public as $$
declare me bigint := _me(); r jsonb;
  allowed text[] := array['me','categories','saveWorker','saveContractor','feed','getShift','skip','unskip','mySkips','unskipAll','apply','undoApply','withdraw','myApplications',
    'toggleFav','favorites','favIds','contractorPage','workerPage','createShift','myShifts','contractorStats','updateShift','cancelShift','completeShift','applicants','decide',
    'team','myTeams','setSenior','removeMember','setAttendance','messages','sendMessage','pinMessage','dmInfo','myDialogs','pendingReviews','submitReview',
    'notifications','markRead','report','track','logError','acceptTerms','deleteAccount',
    'adminStats','adminUsers','adminBlock','adminVerify','adminShifts','adminHideShift','adminReports','adminResolveReport','adminCategories','adminSaveCategory','adminAudit'];
begin
  if not (fn = any(allowed)) then perform _fail('not_implemented', 'Неизвестный метод: ' || fn); end if;
  execute format('select public.%I($1,$2)', lower('api_' || fn)) into r using me, coalesce(args, '[]'::jsonb);
  return r;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
