-- Роли из Supabase, на которые ссылаются миграции (revoke/grant). На обычном PostgreSQL их нет — создаём пустыми (nologin).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
