-- Личные чаты: диалог по отклику виден сразу (в ожидании / принят), даже до первого сообщения.
-- Пустые диалоги идут после диалогов с сообщениями; last = null.
create or replace function api_myDialogs(me bigint, a jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('app_id', x.id, 'last', case when l.id is null then null else _msg_json(l) end, 'info', api_dmInfo(me, jsonb_build_array(x.id)))
    order by l.id desc nulls last, x.updated_at desc), '[]')
  from applications x join shifts s on s.id = x.shift_id
  left join lateral (select * from messages m where m.scope = 'dm:' || x.id order by m.id desc limit 1) l on true
  where (x.worker_id = me or s.contractor_id = me) and (l.id is not null or x.status in ('pending', 'accepted')) $$;
