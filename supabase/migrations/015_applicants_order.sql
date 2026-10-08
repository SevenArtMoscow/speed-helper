-- Список откликов у подрядчика: строго по времени отклика.
-- Кто откликнулся первым — тот первый в списке, последний — в конце. PRO на порядок не влияет.
create or replace function api_applicants(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin
  if not _can_manage((a->>0)::bigint, me, 'applications') then perform _fail('forbidden', 'Нет доступа'); end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object('worker', _worker_json(x.worker_id)) order by x.created_at, x.id), '[]') from applications x where x.shift_id = (a->>0)::bigint);
end $$;
