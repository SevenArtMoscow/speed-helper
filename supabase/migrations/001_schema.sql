-- SPEED HELPER: схема БД. Все таблицы закрыты RLS без политик: клиент не может читать/писать напрямую.
-- Доступ идёт только через функцию public.api(fn, args) (см. 002_api.sql) и Edge Functions.
create table users (
  id bigint generated always as identity primary key,
  tg_id bigint not null unique,               -- один Telegram-аккаунт = один аккаунт SPEED HELPER
  first_name text, username text,
  roles text[] not null default '{}',          -- {'worker','contractor'} — несколько ролей у одного пользователя
  is_admin boolean not null default false,
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);
create table worker_profiles (
  user_id bigint primary key references users(id) on delete cascade,
  name text not null, city text not null, age int not null check (age between 16 and 90),
  avatar text, phone text, about text, experience text,
  skills text[] not null default '{}', license text[] not null default '{}',
  medbook boolean not null default false, selfemployed boolean not null default false, night boolean not null default false, tools boolean not null default false,
  updated_at timestamptz not null default now()
);
create table contractor_profiles (
  user_id bigint primary key references users(id) on delete cascade,
  name text not null, company text, city text not null, phone text not null, about text, avatar text,
  verified boolean not null default false, updated_at timestamptz not null default now()
);
create table categories (id int generated always as identity primary key, name text not null unique, active boolean not null default true);
insert into categories(name) values ('Грузчики'),('Разнорабочие'),('Склад / комплектация'),('Уборка'),('Погрузка / разгрузка'),('Курьеры'),('Промоутеры'),('Официанты / кухня'),('Монтаж / стройка'),('Прочее');

create table shifts (
  id bigint generated always as identity primary key,
  contractor_id bigint not null references users(id),
  title text not null, category_id int not null references categories(id), description text not null default '',
  address text not null, lat double precision, lng double precision,
  date date not null, start_time time not null, end_time time not null,
  pay int not null check (pay > 0), people int not null check (people between 1 and 500),
  requirements text[] not null default '{}',
  status text not null default 'open' check (status in ('open','full','completed','cancelled')),
  hidden boolean not null default false,
  created_at timestamptz not null default now(), completed_at timestamptz
);
create index shifts_feed_idx on shifts (date, start_time) where status = 'open' and not hidden;
create index shifts_contractor_idx on shifts (contractor_id, status);
create index shifts_geo_idx on shifts (lat, lng);

create table applications (
  id bigint generated always as identity primary key,
  shift_id bigint not null references shifts(id) on delete cascade,
  worker_id bigint not null references users(id),
  status text not null default 'pending' check (status in ('pending','accepted','rejected','cancelled','completed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (shift_id, worker_id)                 -- защита от дублей откликов на уровне БД
);
create index applications_worker_idx on applications (worker_id, status);
create index applications_shift_idx on applications (shift_id, status);

create table shift_members (
  shift_id bigint references shifts(id) on delete cascade, user_id bigint references users(id),
  role text not null check (role in ('owner','senior','worker')),
  perms text[] not null default '{}',           -- pin, attendance, remove, applications
  attended boolean, joined_at timestamptz not null default now(),
  primary key (shift_id, user_id)
);
create table messages (
  id bigint generated always as identity primary key,
  scope text not null,                          -- 'shift:<id>' или 'dm:<application_id>'
  user_id bigint not null references users(id), text text not null check (length(text) between 1 and 2000),
  pinned boolean not null default false, created_at timestamptz not null default now()
);
create index messages_scope_idx on messages (scope, id);
create table favorites (user_id bigint references users(id) on delete cascade, target_id bigint references users(id) on delete cascade, created_at timestamptz not null default now(), primary key (user_id, target_id));
create table skips (user_id bigint references users(id) on delete cascade, shift_id bigint references shifts(id) on delete cascade, created_at timestamptz not null default now(), primary key (user_id, shift_id));
create table reviews (
  id bigint generated always as identity primary key,
  shift_id bigint not null references shifts(id), from_user bigint not null references users(id), to_user bigint not null references users(id),
  stars int not null check (stars between 1 and 5), criteria jsonb not null default '{}', text text, created_at timestamptz not null default now(),
  unique (shift_id, from_user, to_user)
);
create index reviews_to_idx on reviews (to_user);
create table notifications (
  id bigint generated always as identity primary key, user_id bigint not null references users(id) on delete cascade,
  type text not null, text text not null, link text, read boolean not null default false, created_at timestamptz not null default now(),
  tg_sent boolean not null default false         -- для воркера, отправляющего уведомления через Telegram Bot API
);
create index notifications_user_idx on notifications (user_id, read, id desc);
create table reports (
  id bigint generated always as identity primary key, reporter bigint not null references users(id),
  target_type text not null check (target_type in ('worker','contractor','shift','message')), target_id bigint not null,
  reason text not null, status text not null default 'new' check (status in ('new','in_progress','resolved','rejected')), created_at timestamptz not null default now()
);
create table events (id bigint generated always as identity primary key, user_id bigint, event text not null, props jsonb, v text, created_at timestamptz not null default now());
create index events_idx on events (event, created_at);
create table audit_log (id bigint generated always as identity primary key, actor bigint, action text not null, meta jsonb, created_at timestamptz not null default now());
create table idempotency_keys (user_id bigint, key text, result jsonb, created_at timestamptz not null default now(), primary key (user_id, key));

-- Безопасность по умолчанию: RLS включён, политик нет => прямой доступ через REST запрещён
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop; end $$;
