-- Доработка логики новых функций:
--  • у смены есть признак «время прошло» (ended): подрядчик видит, что смену пора завершить;
--  • напоминание подрядчику: смена прошла, но не завершена (раз в несколько часов проверяет служба обслуживания, одно напоминание на смену);
--  • отложенная смена, которая заполнилась/отменена/прошла, сообщает об этом владельцу закладки (раз).

create or replace function _shift_json(s shifts, me bigint, olat double precision default null, olng double precision default null) returns jsonb language plpgsql stable as $$
declare j jsonb; a applications;
begin
  j := jsonb_build_object('id', s.id, 'contractor_id', s.contractor_id, 'title', s.title, 'category_id', s.category_id, 'category_name', (select name from categories where id = s.category_id),
    'description', s.description, 'address', s.address, 'lat', s.lat, 'lng', s.lng, 'date', s.date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'),
    'pay', s.pay, 'people', s.people, 'requirements', to_jsonb(s.requirements), 'status', s.status, 'hidden', s.hidden,
    'until_done', s.until_done, 'pay_type', s.pay_type, 'region', s.region, 'total', _shift_total(s), 'ended', _shift_ended(s),
    'saved', exists (select 1 from shift_favs v where v.shift_id = s.id and v.user_id = me),
    'contractor', _contractor_json(s.contractor_id), 'accepted_count', (select count(*) from shift_members m where m.shift_id = s.id and m.role <> 'owner'));
  if olat is not null and s.lat is not null then
    j := j || jsonb_build_object('distance_km', 6371 * 2 * asin(sqrt(sin(radians(s.lat - olat) / 2) ^ 2 + cos(radians(olat)) * cos(radians(s.lat)) * sin(radians(s.lng - olng) / 2) ^ 2)));
  end if;
  select * into a from applications where shift_id = s.id and worker_id = me;
  if found then j := j || jsonb_build_object('my_status', a.status, 'my_application_id', a.id); end if;
  return j;
end $$;

create or replace function maintenance() returns jsonb language plpgsql as $$
declare e int; i int; n int; o int; sv int;
begin
  delete from events where created_at < now() - interval '60 days'; get diagnostics e = row_count;
  delete from idempotency_keys where created_at < now() - interval '3 days'; get diagnostics i = row_count;
  delete from notifications where tg_sent and created_at < now() - interval '60 days'; get diagnostics n = row_count;
  -- подрядчику: смена прошла, но не завершена (есть принятые исполнители), одно напоминание на смену
  insert into notifications(user_id, type, text, link)
    select s.contractor_id, 'shift_overdue', format('Смена «%s» прошла. Завершите её и оцените исполнителей', s.title), '#/c/shift/' || s.id
    from shifts s
    where s.status in ('open','full') and _shift_ended(s) and s.date >= current_date - 14
      and exists (select 1 from shift_members m where m.shift_id = s.id and m.role <> 'owner')
      and not exists (select 1 from notifications x where x.user_id = s.contractor_id and x.type = 'shift_overdue' and x.link = '#/c/shift/' || s.id);
  get diagnostics o = row_count;
  -- исполнителю: отложенная смена перестала быть доступной (заполнена, отменена, скрыта или прошла) — сообщаем один раз и убираем закладку
  with gone as (
    delete from shift_favs v using shifts s
    where s.id = v.shift_id and (s.status <> 'open' or s.hidden or _shift_ended(s))
    returning v.user_id, s.title, s.status)
  insert into notifications(user_id, type, text, link)
    select user_id, 'saved_gone', format('Отложенная смена «%s» %s', title, case when status = 'full' then 'уже набрана' when status = 'cancelled' then 'отменена' else 'больше недоступна' end), '#/w/fav' from gone;
  get diagnostics sv = row_count;
  return jsonb_build_object('events', e, 'idempotency', i, 'notifications', n, 'overdue_reminders', o, 'saved_gone', sv);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
