// Обновление уже работающей базы: миграции ТЗ ред. 2 применяются к данным прежней версии. Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

// те же папки и тот же порядок, что при запуске сервера (server.js → migrate.js)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = [path.join(ROOT, 'server', 'migrations'), path.join(ROOT, 'supabase', 'migrations')]
  .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.sql')).map((name) => ({ name, file: path.join(d, name) })))
  .sort((a, b) => a.name.localeCompare(b.name));
const apply = async (db, list) => { for (const f of list) await db.exec(fs.readFileSync(f.file, 'utf8')); };
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];

test('обновление базы прежней версии', { timeout: 120000 }, async () => {
  const db = await PGlite.create();
  await apply(db, files.filter((f) => f.name < '022'));

  // данные, какими они были до обновления
  await db.exec(`
    insert into users(id, tg_id, first_name, roles, terms_accepted_at, phone_verified, phone_verified_at) overriding system value values
      (1, 101, 'Исполнитель', '{worker}', now(), null, null),
      (2, 102, 'Несовершеннолетний', '{worker}', now(), null, null),
      (3, 103, 'Подрядчик с номером', '{contractor}', now(), '9160000001', now()),
      (4, 104, 'Подрядчик без номера', '{contractor}', now(), null, null);
    insert into worker_profiles(user_id, name, city, age, avatar, phone, about, experience, skills, license, medbook, selfemployed, night, tools) values
      (1, 'Пётр', 'Москва', 30, 'data:image/png;base64,AA', '+79160000009', 'о себе', 'опыт', '{погрузка}', '{B}', true, true, true, false),
      (2, 'Юный', 'Москва', 17, 'data:image/png;base64,AA', null, null, null, '{}', '{}', true, false, false, false);
    insert into contractor_profiles(user_id, name, city, phone, about) values (3, 'С номером', 'Москва', '9169999999', 'о компании'), (4, 'Без номера', 'Москва', '9168888888', null);
    insert into shifts(id, contractor_id, title, category_id, address, date, start_time, end_time, pay, people, requirements) overriding system value values
      (1, 3, 'Банкет', 1, 'Москва', current_date + 1, '09:00', '18:00', 3000, 2, '{18+,Медкнижка}');
  `);

  await apply(db, files.filter((f) => f.name >= '022'));

  // медкнижка удалена вместе со значениями
  assert.equal((await one(db, "select count(*)::int as n from information_schema.columns where table_name = 'worker_profiles' and column_name = 'medbook'")).n, 0);
  assert.deepEqual((await one(db, 'select requirements from shifts where id = 1')).requirements, ['18+']);
  // анкета не повреждена, данные на месте до решения пользователя
  const w = await one(db, 'select * from worker_profiles where user_id = 1');
  assert.equal(w.about, 'о себе'); assert.deepEqual(w.skills, ['погрузка']); assert.equal(w.selfemployed, true);
  assert.equal((await one(db, 'select age from worker_profiles where user_id = 2')).age, 17);
  // согласия не придуманы задним числом: условия и дополнительные данные подтверждаются заново
  assert.equal((await one(db, 'select count(*)::int as n from consent_log')).n, 0);
  assert.equal((await one(db, 'select _terms_ok(1) as ok')).ok, false);
  const pending = (await one(db, 'select _extra_filled(1) as c')).c.sort();
  assert.deepEqual(pending, ['about', 'experience', 'license', 'phone', 'photo', 'preferences', 'selfemployed', 'skills']);
  // у подрядчика остаётся только подтверждённый номер, подтверждение сохраняется
  assert.equal((await one(db, 'select phone from contractor_profiles where user_id = 3')).phone, '9160000001');
  assert.equal((await one(db, 'select phone from contractor_profiles where user_id = 4')).phone, null);
  assert.equal((await one(db, 'select phone_verified from users where id = 3')).phone_verified, '9160000001');
  // процент заполнения считается без медкнижки и не превышает 100
  assert.ok((await one(db, 'select _percent(w) as p from worker_profiles w where user_id = 1')).p <= 100);
  // старая смена: название, категория и описание на месте, срок выплаты не назначен задним числом
  const sj = (await one(db, 'select _shift_json(s, 3) as j from shifts s where id = 1')).j;
  assert.equal(sj.title, 'Банкет'); assert.equal(sj.category_id, 1); assert.equal(sj.payout_kind, null); assert.equal(sj.payout_date, null);
  // сохранённый текст документов нельзя переписать
  await assert.rejects(db.query("update legal_versions set body = 'другое' where doc = 'terms'"));
  await assert.rejects(db.query("delete from legal_versions where doc = 'terms'"));
});
