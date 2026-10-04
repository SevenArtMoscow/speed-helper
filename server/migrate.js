// Применяет *.sql по порядку имени файла (из всех переданных папок), каждый файл — один раз, в транзакции.
import fs from 'node:fs';
import path from 'node:path';
export async function migrate(pool, dirs) {
  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const files = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.sql')).map((f) => ({ name: f, file: path.join(d, f) })))
    .sort((a, b) => a.name.localeCompare(b.name));
  const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name));
  for (const { name, file } of files) {
    if (done.has(name)) continue;
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(fs.readFileSync(file, 'utf8'));
      await c.query('insert into schema_migrations(name) values ($1)', [name]);
      await c.query('commit');
      console.log('миграция применена:', name);
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw new Error(`миграция ${name} не применилась: ${e.message}`);
    } finally { c.release(); }
  }
}
