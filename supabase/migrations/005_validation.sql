-- Проверка входных данных: пустые и нечисловые значения дают понятную ошибку (invalid), а не «Ошибка сервера».
create or replace function _int(v text) returns int language sql immutable as $$
  select case when v ~ '^\s*-?\d{1,9}\s*$' then trim(v)::int end $$;
create or replace function _date(v text) returns date language plpgsql immutable as $$
begin return nullif(trim(coalesce(v, '')), '')::date; exception when others then return null; end $$;
create or replace function _time(v text) returns time language plpgsql immutable as $$
begin return nullif(trim(coalesce(v, '')), '')::time; exception when others then return null; end $$;

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
    coalesce(array(select trim(x) from jsonb_array_elements_text(coalesce(p->'skills','[]')) x where trim(x) <> ''), '{}'), coalesce(array(select jsonb_array_elements_text(coalesce(p->'license','[]'))), '{}'),
    coalesce((p->>'medbook')::boolean, false), coalesce((p->>'selfemployed')::boolean, false), coalesce((p->>'night')::boolean, false), coalesce((p->>'tools')::boolean, false))
  on conflict (user_id) do update set name = excluded.name, city = excluded.city, age = excluded.age, avatar = excluded.avatar, phone = excluded.phone, about = excluded.about,
    experience = excluded.experience, skills = excluded.skills, license = excluded.license, medbook = excluded.medbook, selfemployed = excluded.selfemployed, night = excluded.night, tools = excluded.tools, updated_at = now();
  update users set roles = array(select distinct unnest(roles || 'worker'::text)) where id = me;
  return api_me(me, a);
end $$;

create or replace function api_createShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; k text := a->>1; s shifts; r jsonb;
  cat int := _int(p->>'category_id'); d date := _date(p->>'date'); st time := _time(p->>'start'); en time := _time(p->>'end'); pay int := _int(p->>'pay'); ppl int := _int(p->>'people');
begin
  if not exists (select 1 from contractor_profiles where user_id = me) then perform _fail('profile_required', 'Сначала заполните профиль подрядчика'); end if;
  if k is not null then select result into r from idempotency_keys where user_id = me and key = k; if found then return r; end if; end if;
  if length(trim(coalesce(p->>'title',''))) < 3 then perform _fail('invalid', 'Укажите название смены'); end if;
  if cat is null or not exists (select 1 from categories where id = cat and active) then perform _fail('invalid', 'Выберите категорию'); end if;
  if length(trim(coalesce(p->>'address',''))) < 3 then perform _fail('invalid', 'Укажите адрес'); end if;
  if d is null then perform _fail('invalid', 'Укажите дату'); end if;
  if d < current_date then perform _fail('invalid', 'Дата не может быть в прошлом'); end if;
  if st is null or en is null then perform _fail('invalid', 'Укажите время начала и окончания'); end if;
  if st = en then perform _fail('invalid', 'Время начала и окончания совпадает'); end if;
  if coalesce(pay, 0) not between 1 and 1000000 then perform _fail('invalid', 'Укажите оплату (до 1 000 000 ₽)'); end if;
  if coalesce(ppl, 0) not between 1 and 500 then perform _fail('invalid', 'Укажите количество людей (1–500)'); end if;
  insert into shifts(contractor_id, title, category_id, description, address, lat, lng, date, start_time, end_time, pay, people, requirements)
  values (me, trim(p->>'title'), cat, coalesce(p->>'description',''), trim(p->>'address'), (p->>'lat')::float, (p->>'lng')::float, d,
    st, en, pay, ppl, coalesce(array(select jsonb_array_elements_text(coalesce(p->'requirements','[]'))), '{}')) returning * into s;
  insert into shift_members(shift_id, user_id, role) values (s.id, me, 'owner');
  if coalesce((p->>'notify_favorites')::boolean, false) then
    insert into notifications(user_id, type, text, link) select f.target_id, 'new_shift_from_fav', format('Новая смена: «%s»', s.title), '#/w/shift/' || s.id
    from favorites f join worker_profiles w on w.user_id = f.target_id where f.user_id = me;
  end if;
  insert into audit_log(actor, action, meta) values (me, 'shift.create', jsonb_build_object('id', s.id));
  r := _shift_json(s, me);
  if k is not null then insert into idempotency_keys(user_id, key, result) values (me, k, r) on conflict do nothing; end if;
  return r;
end $$;

create or replace function api_updateShift(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare s shifts; o shifts; p jsonb := a->1; acc int; changed boolean; ap record;
begin
  select * into s from shifts where id = (a->>0)::bigint for update;
  if not found or s.contractor_id <> me then perform _fail('forbidden', 'Только владелец смены'); end if;
  if s.status not in ('open','full') then perform _fail('closed', 'Смену уже нельзя изменить'); end if;
  o := s;
  select count(*) into acc from shift_members where shift_id = s.id and role <> 'owner';
  if p ? 'pay' then s.pay := _int(p->>'pay'); end if;
  if p ? 'people' then s.people := _int(p->>'people'); end if;
  if p ? 'start' then s.start_time := _time(p->>'start'); end if;
  if p ? 'end' then s.end_time := _time(p->>'end'); end if;
  if p ? 'description' then s.description := coalesce(p->>'description', ''); end if;
  if p ? 'requirements' then s.requirements := coalesce(array(select jsonb_array_elements_text(p->'requirements')), '{}'); end if;
  if coalesce(s.pay, 0) not between 1 and 1000000 then perform _fail('invalid', 'Укажите оплату (до 1 000 000 ₽)'); end if;
  if coalesce(s.people, 0) not between 1 and 500 then perform _fail('invalid', 'Укажите количество людей (1–500)'); end if;
  if s.start_time is null or s.end_time is null then perform _fail('invalid', 'Укажите время начала и окончания'); end if;
  if s.start_time = s.end_time then perform _fail('invalid', 'Время начала и окончания совпадает'); end if;
  if s.people < acc then perform _fail('invalid', format('Уже принято %s чел. — нельзя указать меньше', acc)); end if;
  changed := (s.pay, s.people, s.start_time, s.end_time, s.requirements) is distinct from (o.pay, o.people, o.start_time, o.end_time, o.requirements);
  update shifts set pay = s.pay, people = s.people, start_time = s.start_time, end_time = s.end_time, description = s.description, requirements = s.requirements,
    status = case when acc >= s.people then 'full' else 'open' end where id = s.id returning * into s;
  if changed then
    for ap in select worker_id from applications where shift_id = s.id and status in ('pending','accepted') loop
      perform _notify(ap.worker_id, 'shift_updated', format('Условия смены обновлены: «%s»', s.title), '#/w/shift/' || s.id); end loop;
  end if;
  insert into audit_log(actor, action, meta) values (me, 'shift.update', jsonb_build_object('id', s.id));
  return _shift_json(s, me);
end $$;

create or replace function api_report(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; begin
  if coalesce(p->>'target_type', '') not in ('worker','contractor','shift','message') or _int(p->>'target_id') is null then perform _fail('invalid', 'Некорректная жалоба'); end if;
  if length(trim(coalesce(p->>'reason',''))) < 3 then perform _fail('invalid', 'Опишите причину'); end if;
  insert into reports(reporter, target_type, target_id, reason) values (me, p->>'target_type', (p->>'target_id')::bigint, left(p->>'reason', 1000)); return 'true'; end $$;

-- ----- админка -----
-- в списке пользователей виден статус «Проверенный подрядчик» (чтобы его можно было снять)
create or replace function api_adminUsers(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me);
  return (select coalesce(jsonb_agg(to_jsonb(u) || jsonb_build_object('name', coalesce((select name from worker_profiles where user_id = u.id), (select name from contractor_profiles where user_id = u.id), u.first_name),
    'verified', coalesce((select verified from contractor_profiles where user_id = u.id), false)) order by u.id desc), '[]') from (select * from users order by id desc limit 500) u); end $$;

create or replace function api_adminSaveCategory(me bigint, a jsonb) returns jsonb language plpgsql as $$
declare p jsonb := a->0; n text := trim(coalesce(p->>'name', ''));
begin perform _admin(me);
  if length(n) < 2 then perform _fail('invalid', 'Укажите название'); end if;
  if exists (select 1 from categories where lower(name) = lower(n) and id is distinct from _int(p->>'id')) then perform _fail('invalid', 'Такая категория уже есть'); end if;
  if p->>'id' is not null then update categories set name = n, active = coalesce((p->>'active')::boolean, true) where id = _int(p->>'id');
  else insert into categories(name) values (n); end if;
  insert into audit_log(actor, action, meta) values (me, 'category.save', jsonb_build_object('name', n, 'active', p->'active'));
  return 'true'; end $$;

-- журнал: имя того, кто сделал действие
create or replace function api_adminAudit(me bigint, a jsonb) returns jsonb language plpgsql stable as $$
begin perform _admin(me);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'actor', l.actor, 'action', l.action, 'meta', l.meta, 'at', (extract(epoch from l.created_at) * 1000)::bigint,
    'actor_name', coalesce((select name from contractor_profiles where user_id = l.actor), (select name from worker_profiles where user_id = l.actor), (select first_name from users where id = l.actor))) order by l.id desc), '[]')
    from (select * from audit_log order by id desc limit 100) l); end $$;
