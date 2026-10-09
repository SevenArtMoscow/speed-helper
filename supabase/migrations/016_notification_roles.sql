-- Один аккаунт может быть и исполнителем, и подрядчиком. Уведомления, колокольчик и «прочитано»
-- раньше были общими на оба режима и перемешивались. Теперь у каждого уведомления есть роль,
-- вычисляемая по типу и ссылке (таблицу и старые функции отправки менять не нужно):
--  • notifications(роль)  — только уведомления выбранного режима (и общие, например «подключён PRO»);
--  • me.unread_worker / me.unread_contractor — раздельные счётчики; me.unread остаётся общим;
--  • markRead(ссылка, роль) — «прочитано» гасит только выбранный режим.

create or replace function _nrole(n notifications) returns text language sql stable as $$
  select case
    when n.type in ('new_application', 'member_left', 'shift_overdue') then 'contractor'
    when n.type in ('accepted', 'rejected', 'shift_cancelled', 'shift_completed', 'shift_closed', 'shift_updated', 'removed', 'role', 'saved_gone', 'new_shift_from_fav') then 'worker'
    when n.type = 'review' then case when n.link like '#/c/%' then 'contractor' else 'worker' end
    when n.type = 'message' and n.link like '#/team/%' then
      case when exists (select 1 from shifts s where s.id = substr(n.link, 8)::bigint and s.contractor_id = n.user_id) then 'contractor' else 'worker' end
    when n.type = 'message' and n.link like '#/chat/%' then
      case when exists (select 1 from applications x where x.id = substr(n.link, 8)::bigint and x.worker_id = n.user_id) then 'worker' else 'contractor' end
    else null end $$;

create or replace function api_notifications(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(n) || jsonb_build_object('at', (extract(epoch from n.created_at) * 1000)::bigint, 'role', _nrole(n)) order by n.id desc), '[]')
  from (select * from notifications x where x.user_id = me and (a->>0 is null or _nrole(x) is null or _nrole(x) = a->>0) order by x.id desc limit 100) n $$;

create or replace function api_markRead(me bigint, a jsonb) returns jsonb language sql as $$
  with u as (update notifications n set read = true where n.user_id = me and not n.read and (a->>0 is null or n.link = a->>0)
    and (a->>1 is null or _nrole(n) is null or _nrole(n) = a->>1) returning 1) select to_jsonb(true) $$;

create or replace function api_me(me bigint, a jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('id', u.id, 'tg_id', u.tg_id, 'first_name', u.first_name, 'username', u.username, 'roles', to_jsonb(u.roles), 'is_admin', u.is_admin,
    'worker', _worker_json(u.id, true), 'contractor', (select to_jsonb(c) || _contractor_json(u.id) from contractor_profiles c where c.user_id = u.id),
    'unread', (select count(*) from notifications n where n.user_id = u.id and not n.read),
    'unread_worker', (select count(*) from notifications n where n.user_id = u.id and not n.read and coalesce(_nrole(n), 'worker') = 'worker'),
    'unread_contractor', (select count(*) from notifications n where n.user_id = u.id and not n.read and coalesce(_nrole(n), 'contractor') = 'contractor'),
    'terms_accepted', u.terms_accepted_at is not null,
    'pro', _is_pro(u.id), 'pro_until', (select (extract(epoch from expires_at) * 1000)::bigint from subscriptions where user_id = u.id and expires_at > now()))
  from users u where u.id = me $$;
