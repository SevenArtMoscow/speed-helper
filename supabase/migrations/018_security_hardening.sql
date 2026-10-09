-- Укрепление безопасности по итогам ручного разбора:
--  1. журнал событий (track / logError) не принимает «тяжёлые» записи: раньше один пользователь мог забить диск;
--  2. права (license) исполнителя — только допустимые категории (раньше туда можно было записать произвольный HTML), навыки — до 60 символов и 30 штук;
--  3. скрытую админом смену открывает только владелец, участник команды или админ;
--  4. критерии оценки в отзыве — небольшой объект;
--  5. новые служебные функции закрыты от прямого вызова (как и остальные) — приложение вызывает только public.api.

-- 1. события: потолок размера (старые записи не проверяются)
alter table events add constraint events_size check (char_length(event) <= 64 and coalesce(length(props::text), 0) <= 8000) not valid;
create or replace function api_track(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  -- слишком длинное или пустое событие молча пропускаем: аналитика не должна ломать приложение
  if length(coalesce(a->>0, '')) between 1 and 64 and length(coalesce((a->1)::text, '')) <= 2000 then
    insert into events(user_id, event, props) values (me, a->>0, a->1);
  end if;
  return 'true'::jsonb;
end $$;
create or replace function api_logError(me bigint, a jsonb) returns jsonb language plpgsql as $$
begin
  if length(coalesce((a->0)::text, '')) <= 6000 then insert into events(user_id, event, props) values (me, 'error', a->0); end if;
  return 'true'::jsonb;
end $$;

-- 2. права и навыки; уже сохранённое чистим
create or replace function api_saveWorker(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; av text; age int := _int(p->>'age');
begin
  if length(trim(coalesce(p->>'name',''))) < 2 then perform _fail('invalid', 'Укажите имя'); end if;
  if length(trim(coalesce(p->>'city',''))) = 0 then perform _fail('invalid', 'Укажите город'); end if;
  if coalesce(age, 0) not between 16 and 90 then perform _fail('invalid', 'Укажите возраст (16–90)'); end if;
  select avatar into av from worker_profiles where user_id = me;
  if coalesce(p->>'avatar', av) is null then perform _fail('invalid', 'Добавьте фото'); end if;
  insert into worker_profiles(user_id, name, city, age, avatar, phone, about, experience, skills, license, medbook, selfemployed, night, tools)
  values (me, trim(p->>'name'), trim(p->>'city'), age, coalesce(p->>'avatar', av), p->>'phone', p->>'about', p->>'experience',
    coalesce(array(select left(trim(x), 60) from jsonb_array_elements_text(coalesce(p->'skills','[]')) x where trim(x) <> '' limit 30), '{}'), coalesce(array(select distinct x from jsonb_array_elements_text(coalesce(p->'license','[]')) x where x in ('A','B','C','D','E')), '{}'),
    coalesce((p->>'medbook')::boolean, false), coalesce((p->>'selfemployed')::boolean, false), coalesce((p->>'night')::boolean, false), coalesce((p->>'tools')::boolean, false))
  on conflict (user_id) do update set name = excluded.name, city = excluded.city, age = excluded.age, avatar = excluded.avatar, phone = excluded.phone, about = excluded.about,
    experience = excluded.experience, skills = excluded.skills, license = excluded.license, medbook = excluded.medbook, selfemployed = excluded.selfemployed, night = excluded.night, tools = excluded.tools, updated_at = now();
  update users set roles = array(select distinct unnest(roles || 'worker'::text)) where id = me;
  return api_me(me, a);
end $$;
update worker_profiles set license = array(select distinct x from unnest(license) x where x in ('A','B','C','D','E'))
  where exists (select 1 from unnest(license) x where x not in ('A','B','C','D','E'));

-- 3. скрытая смена
create or replace function api_getShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare s shifts;
begin
  select * into s from shifts where id = (a->>0)::bigint;
  if not found or (s.hidden and s.contractor_id <> me and not exists (select 1 from users where id = me and is_admin)
      and not exists (select 1 from shift_members where shift_id = s.id and user_id = me)) then perform _fail('not_found', 'Смена не найдена'); end if;
  return _shift_json(s, me);
end $$;

-- 4. отзыв
create or replace function api_submitReview(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; s shifts; sid bigint := (p->>'shift_id')::bigint; tu bigint := (p->>'to_user')::bigint;
begin
  select * into s from shifts where id = sid; if not found then perform _fail('not_found', 'Смена не найдена'); end if;
  if s.status <> 'completed' then perform _fail('closed', 'Оценка доступна после завершения смены'); end if;
  if me = tu or not exists (select 1 from shift_members where shift_id = sid and user_id = me) or not exists (select 1 from shift_members where shift_id = sid and user_id = tu) then perform _fail('forbidden', 'Нет доступа'); end if;
  if me <> s.contractor_id and tu <> s.contractor_id then perform _fail('forbidden', 'Исполнитель оценивает только подрядчика'); end if;
  if jsonb_typeof(coalesce(p->'criteria', '{}')) <> 'object' or length(coalesce(p->'criteria', '{}')::text) > 600 then perform _fail('invalid', 'Некорректные критерии оценки'); end if;
  if coalesce((p->>'stars')::int, 0) not between 1 and 5 then perform _fail('invalid', 'Поставьте оценку'); end if;
  insert into reviews(shift_id, from_user, to_user, stars, criteria, text) values (sid, me, tu, (p->>'stars')::int, coalesce(p->'criteria','{}'), left(p->>'text', 1000)) on conflict do nothing;
  if not found then return '{"duplicate":true}'; end if;
  perform _notify(tu, 'review', 'Вам поставили оценку', case when tu = s.contractor_id then '#/c/profile' else '#/w/profile' end);
  return '{"ok":true}';
end $$;

-- 5. закрыть прямой вызов служебных функций (приложение ходит только через public.api)
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.api(text, jsonb) to authenticated;
