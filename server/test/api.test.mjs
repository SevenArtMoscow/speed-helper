// Автотесты сервера: поднимают настоящий server.js на встроенной PostgreSQL (PGlite) и прогоняют весь API —
// правильные и неправильные данные, права доступа, лимиты, удаление аккаунта. Запуск: cd server && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const TOKEN = '123456:TEST_ONLY', PORT = 3199, DBPORT = 54329;
const db = await PGlite.create();
const sock = new PGLiteSocketServer({ db, port: DBPORT, host: '127.0.0.1' });
await sock.start();
Object.assign(process.env, { DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${DBPORT}/postgres?sslmode=disable`, PG_POOL_MAX: '1', PORT: String(PORT), DISABLE_BOT: '1', TG_BOT_TOKEN: TOKEN,
  JWT_SECRET: 'test-secret', ADMIN_TG_IDS: '1', APP_URL: `http://127.0.0.1:${PORT}`, OPERATOR_NAME: 'ООО Тестовый оператор', OPERATOR_CONTACT: 'help@example.test', SUPPORT_URL: 'https://t.me/test_support', NODE_ENV: 'test', RATE_MULT: '10' });
await import('../server.js');
const ROOT = `http://127.0.0.1:${PORT}`, BASE = ROOT + '/api';
for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }

const initData = (user) => { const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) }); const c = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n'); p.set('hash', crypto.createHmac('sha256', crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest()).update(c).digest('hex')); return p.toString(); };
async function login(id, name, unverified = false) {
  const r = await (await fetch(BASE + '/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: initData({ id, first_name: name }) }) })).json();
  const call = async (fn, ...args) => { const res = await fetch(BASE + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.access_token }, body: JSON.stringify({ fn, args }) }); const j = await res.json().catch(() => ({})); return { status: res.status, body: j }; };
  // по умолчанию тестовые пользователи с подтверждённым номером (уникальным), иначе подрядчики не смогли бы публиковать смены
  if (!unverified) await db.query('update users set phone_verified = $2 where id = $1 and phone_verified is null', [r.user_id, String(9000000000 + id)]);
  return { id: r.user_id, call, token: r.access_token };
}
let pass = 0, fail = 0; const bugs = [];
const ok = async (name, p, check) => { const r = await p; const good = r.status === 200 && (!check || check(r.body)); good ? pass++ : (fail++, bugs.push(`${name}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)); return r.body; };
const no = async (name, p, hint) => { const r = await p; const good = r.status !== 200 && r.status !== 500 && (!hint || r.body.hint === hint); good ? pass++ : (fail++, bugs.push(`${name}: ожидалась ошибка ${hint || ''}, получено ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)); return r.body; };
const check = (name, cond, info = '') => { cond ? pass++ : (fail++, bugs.push(`${name} ${info}`)); };
const key = () => crypto.randomUUID();
const day = (n) => { const d = new Date(Date.now() + n * 864e5 + 3 * 36e5); return d.toISOString().slice(0, 10); }; // МСК

test('API: полный сценарий', { timeout: 180000 }, async (t) => {
  // после теста даём раннеру записать результат и завершаем процесс (сервер и БД держат его живым)
  t.after(() => setTimeout(() => process.exit(process.exitCode || 0), 1000));
  const A = await login(1, 'Админ'), C = await login(6001, 'Подрядчик'), C2 = await login(6002, 'Подрядчик2');
  const W1 = await login(6101, 'Исп1'), W2 = await login(6102, 'Исп2'), W3 = await login(6103, 'Исп3'), X = await login(6199, 'Пустой');
  const cats = await ok('categories', W1.call('categories'), (b) => b.length > 0);

  // ----- анкеты -----
  const wp = { name: 'Пётр', city: 'Москва', age: 25, avatar: 'data:image/png;base64,AA', skills: ['погрузка'], license: [], phone: '+79161234567' };
  await no('saveWorker без имени', W1.call('saveWorker', { ...wp, name: '' }), 'invalid');
  await no('saveWorker без города', W1.call('saveWorker', { ...wp, city: ' ' }), 'invalid');
  await no('saveWorker возраст abc', W1.call('saveWorker', { ...wp, age: 'abc' }), 'invalid');
  await no('saveWorker возраст пусто', W1.call('saveWorker', { ...wp, age: '' }), 'invalid');
  await no('saveWorker возраст 10', W1.call('saveWorker', { ...wp, age: 10 }), 'invalid');
  await no('saveWorker без фото', W1.call('saveWorker', { ...wp, avatar: null }), 'invalid');
  await ok('saveWorker W1', W1.call('saveWorker', wp), (b) => b.roles.includes('worker'));
  await ok('saveWorker W2', W2.call('saveWorker', { ...wp, name: 'Анна' }));
  await ok('saveWorker W3', W3.call('saveWorker', { ...wp, name: 'Олег', phone: '' }));
  const cp = { name: 'Иван', company: 'ООО Тест', city: 'Москва', phone: '9161234567', about: '' };
  await no('saveContractor короткий телефон', C.call('saveContractor', { ...cp, phone: '916' }), 'invalid');
  await no('saveContractor без имени', C.call('saveContractor', { ...cp, name: '' }), 'invalid');
  await ok('saveContractor C', C.call('saveContractor', cp), (b) => b.contractor.phone === '9161234567');
  await ok('saveContractor C2', C2.call('saveContractor', { ...cp, name: 'Мария', phone: '+7 (926) 000-11-22' }), (b) => b.contractor.phone === '9260001122');

  // ----- без профиля -----
  await no('apply без профиля', X.call('apply', 1), 'profile_required');
  await no('createShift без профиля', X.call('createShift', {}, key()), 'profile_required');

  // ----- создание смены -----
  const sp = { title: 'Разгрузка мебели', category_id: cats[0].id, description: 'тест', address: 'Москва, Тверская 1', lat: 55.76, lng: 37.61, date: day(1), start: '09:00', end: '18:00', pay: 3000, people: 2, requirements: ['18+'], notify_favorites: false };
  await no('createShift короткое название', C.call('createShift', { ...sp, title: 'аб' }, key()), 'invalid');
  await no('createShift без категории', C.call('createShift', { ...sp, category_id: '' }, key()), 'invalid');
  await no('createShift без адреса', C.call('createShift', { ...sp, address: '' }, key()), 'invalid');
  await no('createShift дата в прошлом', C.call('createShift', { ...sp, date: day(-1) }, key()), 'invalid');
  await no('createShift без даты', C.call('createShift', { ...sp, date: '' }, key()), 'invalid');
  await no('createShift оплата 0', C.call('createShift', { ...sp, pay: 0 }, key()), 'invalid');
  await no('createShift оплата abc', C.call('createShift', { ...sp, pay: 'abc' }, key()), 'invalid');
  await no('createShift оплата огромная', C.call('createShift', { ...sp, pay: 99999999999 }, key()), 'invalid');
  await no('createShift людей 0', C.call('createShift', { ...sp, people: 0 }, key()), 'invalid');
  await no('createShift людей 501', C.call('createShift', { ...sp, people: 501 }, key()), 'invalid');
  await no('createShift без начала', C.call('createShift', { ...sp, start: '' }, key()), 'invalid');
  await no('createShift без окончания', C.call('createShift', { ...sp, end: '' }, key()), 'invalid');
  await no('createShift начало = окончание', C.call('createShift', { ...sp, start: '10:00', end: '10:00' }, key()), 'invalid');
  const k1 = key();
  const S1 = await ok('createShift S1', C.call('createShift', sp, k1), (b) => b.id && b.status === 'open');
  await ok('createShift повтор (идемпотентность)', C.call('createShift', sp, k1), (b) => b.id === S1.id);
  const S2 = await ok('createShift S2 ночная', C.call('createShift', { ...sp, title: 'Ночная уборка', people: 1, start: '22:00', end: '06:00', date: day(2), category_id: cats[1].id }, key()));
  const S3 = await ok('createShift S3 (C2)', C2.call('createShift', { ...sp, title: 'Склад', people: 3, pay: 5000 }, key()));

  // ----- лента и отклики -----
  await ok('feed W1', W1.call('feed', { radius_km: 30 }), (b) => b.items.length === 3);
  await ok('feed завтра', W1.call('feed', { date: 'tomorrow' }), (b) => b.items.every((s) => s.date === day(1)));
  await ok('feed мин. оплата', W1.call('feed', { min_pay: 4000 }), (b) => b.items.length === 1);
  await ok('feed категория', W1.call('feed', { categories: [cats[1].id] }), (b) => b.items.length === 1);
  await ok('feed: регион «область» — смен нет (все в Москве)', W1.call('feed', { geo: 'mo' }), (b) => b.items.length === 0);
  await ok('feed: регион «Москва»', W1.call('feed', { geo: 'msk' }), (b) => b.items.length === 3);
  await ok('feed подрядчик не видит своих', C.call('feed', {}), (b) => !b.items.some((s) => s.contractor_id === C.id));
  await ok('getShift', W1.call('getShift', S1.id), (b) => b.title === sp.title);
  await no('getShift несуществующей', W1.call('getShift', 99999), 'not_found');
  await ok('skip', W1.call('skip', S3.id)); await ok('feed без пропущенной', W1.call('feed', {}), (b) => !b.items.some((s) => s.id === S3.id));
  await ok('unskip', W1.call('unskip', S3.id)); await ok('feed после возврата', W1.call('feed', {}), (b) => b.items.some((s) => s.id === S3.id));
  const a1 = await ok('apply W1→S1', W1.call('apply', S1.id), (b) => b.status === 'pending');
  await ok('apply повтор', W1.call('apply', S1.id), (b) => b.duplicate && b.id === a1.id);
  await ok('undoApply', W1.call('undoApply', S1.id), (b) => b === true);
  const a1b = await ok('apply снова', W1.call('apply', S1.id));
  const a2 = await ok('apply W2→S1', W2.call('apply', S1.id));
  const a3 = await ok('apply W3→S1', W3.call('apply', S1.id));
  const a3s2 = await ok('apply W3→S2', W3.call('apply', S2.id));
  await ok('withdraw pending', W3.call('withdraw', a3s2.id), (b) => b.removed);
  await ok('saveWorker C (две роли)', C.call('saveWorker', wp));
  await no('apply на свою смену', C.call('apply', S1.id), 'own_shift');
  await ok('myApplications W1', W1.call('myApplications'), (b) => b.length === 1 && b[0].shift.id === S1.id);
  await ok('applicants C', C.call('applicants', S1.id), (b) => b.length === 3);
  await no('applicants чужой', C2.call('applicants', S1.id), 'forbidden');
  await ok('myShifts C', C.call('myShifts'), (b) => b.find((s) => s.id === S1.id).pending_count === 3);

  // ----- решения по откликам -----
  await no('decide чужим подрядчиком', C2.call('decide', a1b.id, 'accepted'), 'forbidden');
  await no('decide неверное решение', C.call('decide', a1b.id, 'maybe'), 'invalid');
  await ok('accept W1', C.call('decide', a1b.id, 'accepted'), (b) => b.status === 'accepted');
  await ok('accept W1 повтор', C.call('decide', a1b.id, 'accepted'));
  await ok('accept W2 (смена набрана)', C.call('decide', a2.id, 'accepted'));
  await ok('getShift full', W3.call('getShift', S1.id), (b) => b.status === 'full');
  await no('accept W3 сверх мест', C.call('decide', a3.id, 'accepted'), 'full');
  await ok('reject W3', C.call('decide', a3.id, 'rejected'), (b) => b.status === 'rejected');
  await no('decide уже отклонённого', C.call('decide', a3.id, 'accepted'), 'conflict');
  await ok('contractorStats', C.call('contractorStats'), (b) => b.active === 2 && b.workers === 2);

  // ----- команда и чат -----
  await ok('team W1', W1.call('team', S1.id), (b) => b.members.length === 3 && b.my_role === 'worker');
  await no('team посторонний', W3.call('team', S1.id), 'forbidden');
  await ok('myTeams W1', W1.call('myTeams'), (b) => b.length === 1);
  const m1 = await ok('sendMessage team W1', W1.call('sendMessage', 'shift:' + S1.id, 'Всем привет', key()));
  await no('sendMessage пустое', W1.call('sendMessage', 'shift:' + S1.id, '   ', key()), 'invalid');
  await no('sendMessage 2001 символ', W1.call('sendMessage', 'shift:' + S1.id, 'я'.repeat(2001), key()), 'invalid');
  await no('sendMessage посторонний', W3.call('sendMessage', 'shift:' + S1.id, 'хак', key()), 'forbidden');
  await no('sendMessage неверный чат', W1.call('sendMessage', 'abc', 'x', key()), 'invalid');
  await no('sendMessage dm несуществующего', W1.call('sendMessage', 'dm:99999', 'x', key()), 'not_found');
  await ok('messages C', C.call('messages', 'shift:' + S1.id, 0), (b) => b.length === 1);
  await no('pin работником', W1.call('pinMessage', m1.id, true), 'forbidden');
  await ok('pin подрядчиком', C.call('pinMessage', m1.id, true));
  await ok('team pinned', W2.call('team', S1.id), (b) => b.pinned && b.pinned.id === m1.id);
  await ok('setSenior W1', C.call('setSenior', S1.id, W1.id, ['pin', 'attendance']), (b) => b.role === 'senior');
  await no('setSenior не владельцем', W1.call('setSenior', S1.id, W2.id, ['pin']), 'forbidden');
  await ok('pin старшим', W1.call('pinMessage', m1.id, false));
  await ok('attendance старшим', W1.call('setAttendance', S1.id, W2.id, true), (b) => b.attended === true);
  await no('remove старшим без права', W1.call('removeMember', S1.id, W2.id), 'forbidden');
  await ok('removeMember W2', C.call('removeMember', S1.id, W2.id));
  await ok('getShift снова open', W3.call('getShift', S1.id), (b) => b.status === 'open');
  await ok('myApplications W2 cancelled', W2.call('myApplications'), (b) => b[0].status === 'cancelled');

  // ----- личные чаты -----
  await ok('dm W1→C', W1.call('sendMessage', 'dm:' + a1b.id, 'Вопрос', key()));
  await ok('dm C читает', C.call('messages', 'dm:' + a1b.id, 0), (b) => b.length === 1 && b[0].role === 'worker');
  await no('dm посторонний читает', W3.call('messages', 'dm:' + a1b.id, 0), 'forbidden');
  await ok('dmInfo', C.call('dmInfo', a1b.id), (b) => b.can_manage && b.title === 'Пётр');
  await ok('myDialogs W3 (отклонён, без сообщений) пуст', W3.call('myDialogs'), (b) => b.length === 0);
  await ok('myDialogs C', C.call('myDialogs'), (b) => b.some((d) => d.app_id === a1b.id));

  // ----- изменение смены -----
  await no('updateShift людей меньше принятых', C.call('updateShift', S1.id, { people: 0 }), 'invalid');
  await no('updateShift оплата abc', C.call('updateShift', S1.id, { pay: 'abc' }), 'invalid');
  await no('updateShift чужим', C2.call('updateShift', S1.id, { pay: 100 }), 'forbidden');
  await ok('updateShift', C.call('updateShift', S1.id, { pay: 3500, people: 1 }), (b) => b.pay === 3500 && b.status === 'full');

  // ----- избранное и страницы -----
  await ok('toggleFav W1→C', W1.call('toggleFav', C.id), (b) => b === true);
  await ok('favorites contractor', W1.call('favorites', 'contractor'), (b) => b.length === 1 && b[0].open_shifts >= 1);
  await ok('favIds', W1.call('favIds'), (b) => b.includes(C.id));
  await ok('toggleFav C→W1', C.call('toggleFav', W1.id));
  await ok('favorites worker', C.call('favorites', 'worker'), (b) => b.length === 1);
  await ok('contractorPage', W1.call('contractorPage', C.id), (b) => b.is_fav && b.shifts.length >= 1);
  await ok('workerPage с телефоном (есть отклик)', C.call('workerPage', W1.id), (b) => b.worker.phone === wp.phone);
  await ok('workerPage без телефона (нет отклика)', C2.call('workerPage', W1.id), (b) => !('phone' in b.worker));

  // ----- завершение и отзывы -----
  await no('completeShift чужим', C2.call('completeShift', S1.id), 'forbidden');
  await ok('completeShift', C.call('completeShift', S1.id), (b) => b.status === 'completed');
  await ok('pendingReviews W1', W1.call('pendingReviews'), (b) => b.length === 1 && b[0].to_role === 'contractor');
  await ok('pendingReviews C', C.call('pendingReviews'), (b) => b.length === 1 && b[0].to_user === W1.id);
  await no('review без звёзд', W1.call('submitReview', { shift_id: S1.id, to_user: C.id, stars: 0 }), 'invalid');
  await no('review посторонний', W3.call('submitReview', { shift_id: S1.id, to_user: C.id, stars: 5 }), 'forbidden');
  await ok('review W1→C', W1.call('submitReview', { shift_id: S1.id, to_user: C.id, stars: 5, criteria: { Условия: 5 }, text: 'Отлично' }));
  await ok('review повтор', W1.call('submitReview', { shift_id: S1.id, to_user: C.id, stars: 4 }), (b) => b.duplicate);
  await ok('review C→W1', C.call('submitReview', { shift_id: S1.id, to_user: W1.id, stars: 4 }));
  await ok('рейтинг подрядчика', W1.call('contractorPage', C.id), (b) => b.contractor.rating === 5 && b.reviews.length === 1);
  await ok('shifts_done W1', C.call('workerPage', W1.id), (b) => b.worker.shifts_done === 1);
  await no('updateShift завершённой', C.call('updateShift', S1.id, { pay: 1 }), 'closed');

  // ----- отмена смены -----
  await ok('apply W2→S2', W2.call('apply', S2.id));
  await ok('cancelShift S2', C.call('cancelShift', S2.id), (b) => b.status === 'cancelled');
  await ok('W2 уведомлён об отмене', W2.call('notifications'), (b) => b.some((n) => n.type === 'shift_cancelled'));
  await no('apply на отменённую', W1.call('apply', S2.id), 'closed');

  // ----- уведомления, жалобы, аналитика -----
  await ok('notifications W1', W1.call('notifications'), (b) => b.length > 0);
  await ok('markRead', W1.call('markRead')); await ok('me unread 0', W1.call('me'), (b) => b.unread === 0);
  await no('report без причины', W1.call('report', { target_type: 'contractor', target_id: C.id, reason: 'a' }), 'invalid');
  await no('report неверный тип', W1.call('report', { target_type: 'xxx', target_id: 1, reason: 'плохо себя вёл' }));
  await ok('report', W1.call('report', { target_type: 'contractor', target_id: C.id, reason: 'Опоздал с оплатой' }));
  await ok('track', W1.call('track', 'test', { a: 1 })); await ok('logError', W1.call('logError', { message: 'test' }));
  await no('неизвестный метод', W1.call('dropDatabase'), 'not_implemented');

  // ----- админка -----
  await no('adminStats не админ', W1.call('adminStats'), 'forbidden');
  await ok('adminStats', A.call('adminStats'), (b) => b.users >= 7);
  const users = await ok('adminUsers', A.call('adminUsers'), (b) => b.length >= 7);
  await ok('adminBlock W3', A.call('adminBlock', W3.id, true));
  const blocked = await W3.call('me'); blocked.status === 401 && blocked.body.hint === 'blocked' ? pass++ : (fail++, bugs.push('заблокированный не получил отказ: ' + JSON.stringify(blocked)));
  await ok('adminBlock снять', A.call('adminBlock', W3.id, false)); await ok('W3 снова работает', W3.call('me'));
  await no('adminBlock админа', A.call('adminBlock', A.id, true), 'forbidden');
  await ok('adminVerify C', A.call('adminVerify', C.id, true)); await ok('verified виден', W1.call('contractorPage', C.id), (b) => b.contractor.verified === true);
  await ok('adminShifts', A.call('adminShifts'), (b) => b.length >= 3);
  await ok('adminHideShift', A.call('adminHideShift', S3.id, true)); await ok('скрытая не в ленте', W1.call('feed', {}), (b) => !b.items.some((s) => s.id === S3.id));
  await ok('adminHideShift вернуть', A.call('adminHideShift', S3.id, false));
  const reps = await ok('adminReports', A.call('adminReports'), (b) => b.length >= 1);
  await ok('adminResolveReport', A.call('adminResolveReport', reps[0].id, 'resolved'));
  await no('adminResolveReport неверный статус', A.call('adminResolveReport', reps[0].id, 'xxx'));
  await ok('adminCategories', A.call('adminCategories'));
  const nc = await ok('adminSaveCategory новая', A.call('adminSaveCategory', { id: null, name: 'Тест-категория', active: true }));
  await no('adminSaveCategory пустое имя', A.call('adminSaveCategory', { id: null, name: ' ', active: true }), 'invalid');
  await ok('adminAudit', A.call('adminAudit'), (b) => b.length > 0);
  await ok('withdraw accepted', W1.call('apply', S3.id).then(async (r) => { const ap = r.body; await C2.call('decide', ap.id, 'accepted'); return W1.call('withdraw', ap.id); }), (b) => b.status === 'cancelled');


  // ===== продакшен: согласие, удаление аккаунта, лимиты, заголовки =====
  const T = await login(8001, 'Новый');
  await ok('me: соглашение не принято', T.call('me'), (b) => b.terms_accepted === false);
  await ok('acceptTerms', T.call('acceptTerms')); await ok('me: соглашение принято', T.call('me'), (b) => b.terms_accepted === true);

  // удаление аккаунта исполнителя: отклик и место в команде отменяются, профиль стёрт, подрядчик уведомлён
  const D = await login(8002, 'Удаляемый'); await D.call('acceptTerms');
  await ok('saveWorker D', D.call('saveWorker', { ...wp, name: 'Удаляемый Иван' }));
  const dsh = await ok('createShift для D', C.call('createShift', { ...sp, title: 'Смена для удаления', people: 5, date: day(3) }, key()));
  const dap = await ok('apply D', D.call('apply', dsh.id)); await ok('accept D', C.call('decide', dap.id, 'accepted'));
  await ok('sendMessage D', D.call('sendMessage', 'shift:' + dsh.id, 'Секретное сообщение', key()));
  await ok('deleteAccount D', D.call('deleteAccount'));
  await ok('после удаления: профиля нет, соглашение сброшено', D.call('me'), (b) => b.worker === null && b.roles.length === 0 && b.terms_accepted === false);
  await ok('после удаления: отклик отменён', C.call('applicants', dsh.id), (b) => b.find((x) => x.id === dap.id).status === 'cancelled');
  await ok('после удаления: сообщение обезличено', C.call('messages', 'shift:' + dsh.id, 0), (b) => b[0].text === '[сообщение удалено]');
  await ok('подрядчик уведомлён об уходе', C.call('notifications'), (b) => b.some((n) => n.type === 'member_left'));
  await ok('D может зарегистрироваться заново', D.call('acceptTerms'));

  // удаление аккаунта подрядчика: открытые смены отменяются, исполнители уведомлены
  const K = await login(8003, 'Удаляемый подрядчик'); await K.call('acceptTerms');
  await ok('saveContractor K', K.call('saveContractor', { ...cp, name: 'Удаляемая Мария' }));
  const ksh = await ok('createShift K', K.call('createShift', { ...sp, title: 'Смена удаляемого', date: day(3) }, key()));
  await ok('apply W2→K', W2.call('apply', ksh.id));
  await ok('deleteAccount K', K.call('deleteAccount'));
  await ok('смены K отменены', A.call('adminShifts'), (b) => b.find((s) => s.id === ksh.id).status === 'cancelled');
  await ok('исполнитель уведомлён об отмене', W2.call('notifications'), (b) => b.some((n) => n.type === 'shift_cancelled' && /Смена удаляемого/.test(n.text)));
  await no('админа удалить нельзя', A.call('deleteAccount'), 'forbidden');

  // длина полей: слишком длинный текст — понятная ошибка, а не 500
  await no('слишком длинное «о себе»', W1.call('saveWorker', { ...wp, about: 'я'.repeat(1001) }), 'invalid');
  await no('слишком длинное название смены', C.call('createShift', { ...sp, title: 'н'.repeat(101) }, key()), 'invalid');

  // лимиты: жалоб не больше 10 в час (в тесте множитель ×10 → 100)
  const R = await login(8004, 'Спамер'); await R.call('saveWorker', wp);
  let limited = 0; for (let i = 0; i < 104; i++) { const r = await R.call('report', { target_type: 'shift', target_id: S3.id, reason: 'проверка лимита ' + i }); if (r.status === 429) limited++; }
  check('лимит жалоб: после лимита приходит 429', limited === 4, 'получено 429: ' + limited);

  // заголовки безопасности, юридические страницы, публичный конфиг, закрытость исходников
  const page = await fetch(ROOT + '/');
  check('CSP на главной', /default-src 'self'/.test(page.headers.get('content-security-policy') || ''));
  check('nosniff на главной', page.headers.get('x-content-type-options') === 'nosniff');
  check('CSP разрешает карту и подсказки, но не eval', /tiles\.openfreemap\.org/.test(page.headers.get('content-security-policy')) && !/unsafe-eval/.test(page.headers.get('content-security-policy')));
  const priv = await (await fetch(ROOT + '/legal/privacy.html')).text();
  check('политика: оператор подставлен', priv.includes('ООО Тестовый оператор') && priv.includes('help@example.test') && !priv.includes('{{'));
  const cfg = await (await fetch(BASE + '/config')).json();
  check('конфиг: ссылка поддержки', cfg.support_url === 'https://t.me/test_support');
  const leak = await (await fetch(ROOT + '/server/server.js')).text();
  check('исходники сервера не раздаются', !leak.includes("from 'node:http'"));
  const leak2 = await (await fetch(ROOT + '/server/.env')).text();
  check('.env не раздаётся', !leak2.includes('JWT_SECRET'));
  const bad = await fetch(BASE + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake.token.value' }, body: '{"fn":"me"}' });
  check('поддельный токен отклоняется', bad.status === 401);
  const forged = await fetch(BASE + '/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: initData({ id: 1, first_name: 'Хакер' }).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64)) }) });
  check('подделанные данные Telegram отклоняются', forged.status === 401);

  // ===== регрессия по итогам QA =====
  // рейтинг по ролям: оценка, полученная в одной роли, не попадает в профиль другой роли того же человека
  await ok('QA: у C как исполнителя нет оценок (оценён как подрядчик)', W1.call('workerPage', C.id), (b) => b.worker.rating === null && b.reviews.length === 0);
  await ok('QA: saveContractor W1', W1.call('saveContractor', { ...cp, name: 'Пётр-подрядчик' }));
  await ok('QA: у W1 как подрядчика нет оценок', C2.call('contractorPage', W1.id), (b) => b.contractor.rating === null && b.reviews.length === 0);
  await ok('QA: у W1 как исполнителя оценка 4', C.call('workerPage', W1.id), (b) => b.worker.rating === 4 && b.reviews.length === 1);
  // прошедшее время смены
  await no('QA: смена на сегодня с прошедшим временем', C.call('createShift', { ...sp, date: day(0), start: '00:00', end: '00:01' }, key()), 'invalid');
  const ES = await ok('QA: смена на сегодня вечером', C.call('createShift', { ...sp, title: 'Сегодняшняя', date: day(0), start: '23:58', end: '23:59' }, key()));
  await db.query("update shifts set start_time = '00:00', end_time = '00:01' where id = $1", [ES.id]);
  await ok('QA: прошедшая смена не в ленте', W3.call('feed', {}), (b) => !b.items.some((x) => x.id === ES.id));
  await no('QA: отклик на прошедшую смену', W3.call('apply', ES.id), 'closed');
  await ok('QA: прошедшая смена не на странице подрядчика', W3.call('contractorPage', C.id), (b) => !b.shifts.some((x) => x.id === ES.id));
  // отмена отклика убирает уведомление подрядчику
  await ok('QA: apply W3→S3', W3.call('apply', S3.id));
  await ok('QA: уведомление об отклике есть', C2.call('notifications'), (b) => b.some((n) => n.type === 'new_application' && /Олег/.test(n.text) && n.link === '#/c/shift/' + S3.id));
  await ok('QA: undoApply W3', W3.call('undoApply', S3.id), (b) => b === true);
  await ok('QA: уведомление об отклике убрано', C2.call('notifications'), (b) => !b.some((n) => n.type === 'new_application' && /Олег/.test(n.text) && n.link === '#/c/shift/' + S3.id));
  // нерассмотренные отклики уведомляются при завершении
  const SH = await ok('QA: смена для завершения', C.call('createShift', { ...sp, title: 'Завершаемая', date: day(4) }, key()));
  await ok('QA: apply W2→SH', W2.call('apply', SH.id));
  await ok('QA: completeShift SH', C.call('completeShift', SH.id));
  await ok('QA: W2 уведомлён о закрытии отклика', W2.call('notifications'), (b) => b.some((n) => n.type === 'shift_closed' && /Завершаемая/.test(n.text)));
  // закреплённое сообщение — отдельным запросом; первая загрузка — последние 300
  await ok('QA: pin', C.call('pinMessage', m1.id, true));
  await ok('QA: messages(pin) возвращает закреплённое', W1.call('messages', 'shift:' + S1.id, 0, 'pin'), (b) => b.length === 1 && b[0].id === m1.id);
  await ok('QA: unpin', C.call('pinMessage', m1.id, false));
  await ok('QA: после открепления пусто', W1.call('messages', 'shift:' + S1.id, 0, 'pin'), (b) => b.length === 0);
  await db.query("insert into messages(scope, user_id, text) select 'shift:' || $1::text, $2::bigint, 'm' || g from generate_series(1, 320) g", [S1.id, W1.id]);
  await ok('QA: первая загрузка чата — не больше 300, последние', W1.call('messages', 'shift:' + S1.id, 0), (b) => b.length === 300 && b[299].text === 'm320');
  await ok('QA: догрузка после последнего id', W1.call('messages', 'shift:' + S1.id, 0).then(async (r) => W1.call('messages', 'shift:' + S1.id, r.body[299].id)), (b) => b.length === 0);
  await no('QA: страница несуществующего подрядчика', W1.call('contractorPage', 99999), 'not_found');
  await no('QA: страница несуществующего исполнителя', W1.call('workerPage', 99999), 'not_found');
  // не пришёл — не считается проведённой сменой
  await ok('QA: отметка «не пришёл»', C.call('setAttendance', S1.id, W1.id, false));
  await ok('QA: no-show не в «проведено смен»', C.call('workerPage', W1.id), (b) => b.worker.shifts_done === 0);
  await ok('QA: отметка «пришёл»', C.call('setAttendance', S1.id, W1.id, true));
  await ok('QA: пришёл — снова считается', C.call('workerPage', W1.id), (b) => b.worker.shifts_done === 1);

  // ===== новые возможности =====
  // оплата в час, «до выполнения задачи», регион
  await no('NEW: вне Москвы и МО', C.call('createShift', { ...sp, lat: 59.93, lng: 30.31 }, key()), 'invalid');
  await no('NEW: без окончания и без «до выполнения»', C.call('createShift', { ...sp, end: '' }, key()), 'invalid');
  await no('NEW: неверный тип оплаты', C.call('createShift', { ...sp, pay_type: 'week' }, key()), 'invalid');
  const HS = await ok('NEW: смена с почасовой оплатой «до выполнения»', C.call('createShift', { ...sp, title: 'Почасовая работа', pay: 500, pay_type: 'hour', until_done: true, end: '', date: day(5), lat: 55.9, lng: 37.0, region: 'mo' }, key()),
    (b) => b.pay_type === 'hour' && b.until_done === true && b.region === 'mo' && b.total === 4000);
  await ok('NEW: фильтр «область» находит смену', W3.call('feed', { geo: 'mo' }), (b) => b.items.length === 1 && b.items[0].id === HS.id);
  await ok('NEW: фильтр «Москва» её не показывает', W3.call('feed', { geo: 'msk' }), (b) => !b.items.some((x) => x.id === HS.id));
  await ok('NEW: мин. оплата сравнивается с суммой за смену (500×8=4000)', W3.call('feed', { geo: 'mo', min_pay: 3500 }), (b) => b.items.some((x) => x.id === HS.id));
  await ok('NEW: мин. оплата выше суммы — не показывается', W3.call('feed', { geo: 'mo', min_pay: 4500 }), (b) => !b.items.some((x) => x.id === HS.id));
  await ok('NEW: правка типа оплаты', C.call('updateShift', HS.id, { pay_type: 'shift', pay: 3000 }), (b) => b.pay_type === 'shift' && b.total === 3000);
  // отложенные смены
  await ok('NEW: отложить смену', W3.call('toggleShiftFav', HS.id), (b) => b === true);
  await ok('NEW: отложенная — в списке', W3.call('savedShifts'), (b) => b.length === 1 && b[0].id === HS.id && b[0].saved === true);
  await ok('NEW: отложенная — не в ленте', W3.call('feed', {}), (b) => !b.items.some((x) => x.id === HS.id));
  await ok('NEW: include_saved возвращает её в ленту', W3.call('feed', { include_saved: true }), (b) => b.items.some((x) => x.id === HS.id));
  await ok('NEW: убрать из отложенных', W3.call('toggleShiftFav', HS.id), (b) => b === false);
  await ok('NEW: снова отложить', W3.call('toggleShiftFav', HS.id));
  await ok('NEW: отклик снимает закладку', W3.call('apply', HS.id));
  await ok('NEW: закладки нет после отклика', W3.call('savedShifts'), (b) => b.length === 0);
  await no('NEW: отложить несуществующую', W3.call('toggleShiftFav', 99999), 'not_found');
  // чаты по роли: у C две роли (подрядчик и исполнитель)
  await ok('NEW: диалоги подрядчика C', C.call('myDialogs', 'contractor'), (b) => b.length >= 1 && b.every((d) => d.info.shift.contractor_id === C.id));
  await ok('NEW: диалоги C как исполнителя — своих смен нет', C.call('myDialogs', 'worker'), (b) => b.every((d) => d.info.shift.contractor_id !== C.id));
  // права админа чата: старший с «работа с откликами» получает уведомления и может принимать
  const AS = await ok('NEW: смена для проверки админа чата', C.call('createShift', { ...sp, title: 'Смена с админом чата', date: day(6), people: 3 }, key()));
  const w1ap = await ok('NEW: W1 откликается', W1.call('apply', AS.id));
  await ok('NEW: W1 принят', C.call('decide', w1ap.id, 'accepted'));
  await ok('NEW: W1 — админ чата (работа с откликами)', C.call('setSenior', AS.id, W1.id, ['applications']), (b) => b.role === 'senior');
  const asap = await ok('NEW: W2 откликается', W2.call('apply', AS.id));
  await ok('NEW: админ чата получил уведомление об отклике', W1.call('notifications'), (b) => b.some((n) => n.type === 'new_application' && n.link === '#/c/shift/' + AS.id));
  await ok('NEW: админ чата видит отклики', W1.call('applicants', AS.id), (b) => b.length === 2);
  await ok('NEW: админ чата принимает за подрядчика', W1.call('decide', asap.id, 'accepted'), (b) => b.status === 'accepted');
  await no('NEW: админ чата не может отменить смену', W1.call('cancelShift', AS.id), 'forbidden');
  // профиль: активные задания
  await ok('NEW: подрядчик видит активные задания исполнителя', C.call('workerPage', W2.id), (b) => b.active_count === 1 && b.active.length === 1 && b.active[0].id === AS.id);
  await ok('NEW: посторонний видит только число', C2.call('workerPage', W2.id), (b) => b.active_count === 1 && b.active.length === 0);
  await ok('NEW: свои активные задания видны', W2.call('workerPage', W2.id), (b) => b.active.length === 1);
  await ok('NEW: мои исполнители', C.call('myWorkers'), (b) => b.some((x) => x.user_id === W2.id) && b.every((x) => 'together' in x));
  // необязательные отзывы
  await ok('NEW: завершаем смену с админом чата', C.call('completeShift', AS.id));
  await ok('NEW: есть неоценённые', W2.call('pendingReviews'), (b) => b.some((x) => x.shift.id === AS.id));
  await ok('NEW: пропустить отзыв', W2.call('skipReview', AS.id));
  await ok('NEW: пропущенный не просится', W2.call('pendingReviews'), (b) => !b.some((x) => x.shift.id === AS.id));
  await ok('NEW: подрядчику по этой смене просятся два отзыва', C.call('pendingReviews'), (b) => b.filter((x) => x.shift.id === AS.id).length === 2);
  await ok('NEW: пропуск одного исполнителя', C.call('skipReview', AS.id, W2.id));
  await ok('NEW: остался один', C.call('pendingReviews'), (b) => b.filter((x) => x.shift.id === AS.id).length === 1);
  await ok('NEW: пропуск всех по смене', C.call('skipReview', AS.id));
  await ok('NEW: отзывов не осталось', C.call('pendingReviews'), (b) => !b.some((x) => x.shift.id === AS.id));
  // рейтинг исполнителей
  await ok('NEW: рейтинг: месяц', W1.call('leaderboard', 'month'), (b) => b.period === 'month' && Array.isArray(b.top) && b.top.length >= 1 && b.top[0].rank === 1 && b.participants >= 1);
  await ok('NEW: рейтинг: за всё время содержит W1 с очками', W1.call('leaderboard', 'all'), (b) => b.me && b.me.score >= 10 && b.top.some((x) => x.user_id === W1.id));
  await ok('NEW: рейтинг: у нового исполнителя нет места', X.call('leaderboard', 'all'), (b) => b.me === null);
  await ok('NEW: рейтинг упорядочен по очкам', W1.call('leaderboard', 'all'), (b) => b.top.every((x, i) => i === 0 || b.top[i - 1].score >= x.score));

  // напоминания и закладки, которые перестали быть доступными
  const SX = await ok('NEW: смена для напоминаний', C.call('createShift', { ...sp, title: 'Прошедшая неоконченная', date: day(7), people: 2 }, key()));
  await ok('NEW: W3 откладывает её', W3.call('toggleShiftFav', SX.id));
  const sxap = await ok('NEW: W2 откликается', W2.call('apply', SX.id)); await ok('NEW: W2 принят', C.call('decide', sxap.id, 'accepted'));
  await db.query("update shifts set date = current_date, start_time = '00:00', end_time = '00:01', until_done = false where id = $1", [SX.id]);
  await ok('NEW: смена помечена «время прошло»', C.call('getShift', SX.id), (b) => b.ended === true);
  await db.query('select maintenance()');
  await ok('NEW: подрядчик получил напоминание', C.call('notifications'), (b) => b.filter((n) => n.type === 'shift_overdue' && n.link === '#/c/shift/' + SX.id).length === 1);
  await db.query('select maintenance()');
  await ok('NEW: напоминание не дублируется', C.call('notifications'), (b) => b.filter((n) => n.type === 'shift_overdue' && n.link === '#/c/shift/' + SX.id).length === 1);
  await ok('NEW: W3 уведомлён, что отложенная смена недоступна', W3.call('notifications'), (b) => b.some((n) => n.type === 'saved_gone' && /Прошедшая неоконченная/.test(n.text)));
  await ok('NEW: закладка снята', W3.call('savedShifts'), (b) => !b.some((x) => x.id === SX.id));

  // ===== тестовые (выдуманные) пользователи =====
  const FW = await login(-5001, 'Тест Исполнитель'), FC = await login(-5002, 'Тест Подрядчик');
  await db.query('update users set is_fake = true where tg_id in (-5001, -5002)');
  await ok('FAKE: профиль исполнителя', FW.call('saveWorker', { ...wp, name: 'Тест Исполнитель' }));
  await ok('FAKE: профиль подрядчика', FC.call('saveContractor', { ...cp, name: 'Тест Подрядчик', phone: '0000000001' }));
  const FS = await ok('FAKE: смена тестового подрядчика', FC.call('createShift', { ...sp, title: 'Тестовая смена симулятора', date: day(9), people: 1 }, key()));
  const fap = await ok('FAKE: отклик тестового исполнителя', FW.call('apply', FS.id));
  await ok('FAKE: принят', FC.call('decide', fap.id, 'accepted'));
  await ok('FAKE: сообщение в личном чате', FW.call('sendMessage', 'dm:' + fap.id, 'Здравствуйте', key()));
  await ok('FAKE: завершение', FC.call('completeShift', FS.id));
  await ok('FAKE: в рейтинге обычному пользователю тестовых нет', W1.call('leaderboard', 'all'), (b) => !b.top.some((x) => x.name === 'Тест Исполнитель'));
  await ok('FAKE: администратору в рейтинге тестовые видны', A.call('leaderboard', 'all'), (b) => b.top.some((x) => x.name === 'Тест Исполнитель'));
  await ok('FAKE: показатели админки — тестовые отдельно', A.call('adminStats'), (b) => b.fake_users === 2 && b.fake_applications === 1);
  await ok('FAKE: в списке админа тестовые в конце и с пометкой', A.call('adminUsers'), (b) => b.slice(-2).every((u) => u.is_fake === true) && !b.slice(0, 3).some((u) => u.is_fake));
  await db.query('select fake_cleanup()');
  await ok('FAKE: после очистки тестовых нет', A.call('adminStats'), (b) => b.fake_users === 0 && b.fake_applications === 0);
  await no('FAKE: тестовая смена удалена', W1.call('getShift', FS.id), 'not_found');
  await ok('FAKE: настоящие данные на месте (смена S1, отклики, рейтинг)', W1.call('getShift', S1.id), (b) => b.title === sp.title);
  await ok('FAKE: настоящий W3 цел и работает', W3.call('myApplications'), (b) => Array.isArray(b) && b.length >= 1);

  // ===== чаты и уведомления: понятные списки =====
  await ok('W1 пишет в чат команды S1', W1.call('sendMessage', 'shift:' + S1.id, 'Последнее сообщение команды', key()));
  await ok('CHAT: уведомление называет автора и смену', C.call('notifications'), (b) => b.some((n) => n.type === 'message' && n.link === '#/team/' + S1.id && /Пётр: новое сообщение в «Разгрузка мебели»/.test(n.text)));
  await ok('CHAT: командные чаты подрядчика — последнее сообщение и «непрочитано»', C.call('teamChats', 'contractor'), (b) => { const x = b.find((s) => s.id === S1.id); return x && x.last.text === 'Последнее сообщение команды' && x.last.name === 'Пётр' && x.unread === true && x.last.mine === false; });
  await ok('CHAT: у исполнителя своё сообщение помечено «mine»', W1.call('teamChats', 'worker'), (b) => { const x = b.find((s) => s.id === S1.id); return x && x.last.mine === true && x.unread === false; });
  await ok('CHAT: подрядчик не видит чужие команды', C2.call('teamChats', 'contractor'), (b) => !b.some((s) => s.id === S1.id));
  await ok('CHAT: markRead по ссылке гасит только этот чат', C.call('markRead', '#/team/' + S1.id));
  await ok('CHAT: чат прочитан, остальные уведомления целы', C.call('notifications'), (b) => b.filter((n) => n.link === '#/team/' + S1.id).every((n) => n.read) && b.some((n) => !n.read));
  await ok('CHAT: после прочтения «непрочитано» нет', C.call('teamChats', 'contractor'), (b) => b.find((s) => s.id === S1.id).unread === false);
  await ok('CHAT: личные чаты помечены «unread»', C.call('myDialogs', 'contractor'), (b) => b.every((d) => typeof d.unread === 'boolean'));

  // ===== отзывы: видно автора, переход в профиль, полный список =====
  await ok('REV: страница подрядчика — у отзыва виден автор, роль, смена', W3.call('contractorPage', C.id), (b) => { const r = b.reviews[0]; return r && r.from_user === W1.id && r.from_role === 'worker' && r.from_name === 'Пётр' && r.shift_title === sp.title && r.stars === 5 && r.criteria['Условия'] === 5 && r.text === 'Отлично' && typeof r.at === 'number'; });
  await ok('REV: полный список — всем доступен', C2.call('userReviews', C.id, 'contractor', 0), (b) => b.total === 1 && b.items.length === 1 && b.items[0].from_user === W1.id && b.name.length > 0 && b.rating === 5);
  await ok('REV: у исполнителя W1 отзыв от подрядчика', C2.call('userReviews', W1.id, 'worker', 0), (b) => b.total === 1 && b.items[0].from_user === C.id && b.items[0].from_role === 'contractor');
  await ok('REV: отзыв подрядчику не попадает в список «как исполнителю»', W3.call('userReviews', C.id, 'worker', 0), (b) => b.total === 0 && b.items.length === 0);
  await ok('REV: постранично — смещение за пределы даёт пустой список', W3.call('userReviews', C.id, 'contractor', 20), (b) => b.items.length === 0 && b.total === 1);
  await no('REV: нет такого профиля', W3.call('userReviews', 99999, 'worker', 0), 'not_found');
  await no('REV: у человека нет роли подрядчика', W3.call('userReviews', W3.id, 'contractor', 0), 'not_found');

  // ===== подписка PRO =====
  await ok('PRO: у W3 подписки нет', W3.call('mySubscription'), (b) => b.active === false && b.price === 990 && b.boosts_limit === 3 && b.boosts_used === 0);
  const PS = await ok('PRO: смена для поднятия', C.call('createShift', { ...sp, title: 'Смена в топ', date: day(12), people: 2 }, key()));
  await no('PRO: поднять без подписки нельзя', C.call('boostShift', PS.id), 'pro_required');
  await no('PRO: выдать PRO может только админ', W1.call('adminGrantPro', C.id, 30), 'forbidden');
  await ok('PRO: админ выдаёт подписку подрядчику C', A.call('adminGrantPro', C.id, 30), (b) => b.expires_at > Date.now());
  await ok('PRO: у C статус PRO в me и в профиле', C.call('me'), (b) => b.pro === true && b.pro_until > Date.now() && b.contractor.pro === true);
  await ok('PRO: профиль подрядчика показывает PRO всем', W3.call('contractorPage', C.id), (b) => b.contractor.pro === true);
  await ok('PRO: уведомление о подключении', C.call('notifications'), (b) => b.some((n) => n.type === 'pro'));
  await ok('PRO: смена PRO-подрядчика до поднятия — не первая в ленте', W3.call('feed', {}), (b) => b.items.length > 1 && b.items[0].id !== PS.id);
  await no('PRO: чужую смену поднять нельзя', C2.call('boostShift', PS.id), 'forbidden');
  await ok('PRO: поднятие в топ', C.call('boostShift', PS.id), (b) => b.boosted === true);
  await ok('PRO: поднятая смена первая в ленте, хотя дата дальняя', W3.call('feed', {}), (b) => b.items[0].id === PS.id && b.items[0].boosted === true && b.items[0].contractor.pro === true);
  await ok('PRO: счётчик поднятий', C.call('mySubscription'), (b) => b.active === true && b.boosts_used === 1 && b.source === 'admin');
  await ok('PRO: второе поднятие', C.call('boostShift', PS.id)); await ok('PRO: третье поднятие', C.call('boostShift', PS.id));
  await no('PRO: четвёртое — лимит месяца', C.call('boostShift', PS.id), 'limit');
  // порядок откликов — строго по времени (PRO на него не влияет)
  const PS2 = await ok('PRO: смена для откликов', C2.call('createShift', { ...sp, title: 'Отклики PRO', date: day(11), people: 3 }, key()));
  await ok('PRO: W3 откликается первым', W3.call('apply', PS2.id)); await ok('PRO: админ выдаёт PRO исполнителю W2', A.call('adminGrantPro', W2.id, 7));
  await ok('PRO: W2 откликается позже', W2.call('apply', PS2.id));
  await ok('Отклики: кто откликнулся раньше — тот первый (даже если позже стал PRO)', C2.call('applicants', PS2.id), (b) => b.length === 2 && b[0].worker_id === W3.id && b[0].worker.pro === false && b[1].worker_id === W2.id && b[1].worker.pro === true);
  await ok('PRO: в списке админа виден признак PRO', A.call('adminUsers'), (b) => b.find((u) => u.id === W2.id).pro === true && b.find((u) => u.id === W3.id).pro === false);
  await ok('PRO: продление складывается', A.call('adminGrantPro', W2.id, 7), (b) => b.expires_at > Date.now() + 13 * 864e5);
  await ok('PRO: админ снимает подписку', A.call('adminRevokePro', W2.id)); await ok('PRO: после снятия не PRO', W2.call('me'), (b) => b.pro === false);
  await ok('PRO: после поднятия лимит не сбрасывается снятием', C.call('mySubscription'), (b) => b.boosts_used === 3);

  // один аккаунт — и исполнитель, и подрядчик: уведомления и счётчики не должны перемешиваться
  const DR = await login(6201, 'Двойной');
  await ok('ROLES: профиль исполнителя', DR.call('saveWorker', { ...wp, name: 'Двойной Иван' })); await ok('ROLES: профиль подрядчика', DR.call('saveContractor', { ...cp, name: 'Двойной Иван' }));
  const RS = await ok('ROLES: смена от лица подрядчика', DR.call('createShift', { ...sp, title: 'Смена двойного', date: day(12), people: 2 }, key()));
  const RS2 = await ok('ROLES: чужая смена', C2.call('createShift', { ...sp, title: 'Чужая для двойного', date: day(12), people: 2 }, key()));
  await ok('ROLES: W1 откликается на смену двойного', W1.call('apply', RS.id));      // уведомление подрядчику
  const rap = await ok('ROLES: двойной откликается как исполнитель', DR.call('apply', RS2.id));
  await ok('ROLES: C2 принимает двойного', C2.call('decide', rap.id, 'accepted'));   // уведомление исполнителю
  await ok('ROLES: в режиме подрядчика — только отклик', DR.call('notifications', 'contractor'), (b) => b.some((n) => n.type === 'new_application') && !b.some((n) => n.type === 'accepted'));
  await ok('ROLES: в режиме исполнителя — только «приняли»', DR.call('notifications', 'worker'), (b) => b.some((n) => n.type === 'accepted') && !b.some((n) => n.type === 'new_application'));
  await ok('ROLES: без роли видно всё (как раньше)', DR.call('notifications'), (b) => b.some((n) => n.type === 'accepted') && b.some((n) => n.type === 'new_application'));
  await ok('ROLES: счётчики раздельные', DR.call('me'), (b) => b.unread === 2 && b.unread_worker === 1 && b.unread_contractor === 1);
  await ok('ROLES: прочитано в режиме исполнителя', DR.call('markRead', null, 'worker'));
  await ok('ROLES: подрядческое осталось непрочитанным', DR.call('me'), (b) => b.unread_worker === 0 && b.unread_contractor === 1 && b.unread === 1);
  await ok('ROLES: прочитано в режиме подрядчика', DR.call('markRead', null, 'contractor')); await ok('ROLES: всё прочитано', DR.call('me'), (b) => b.unread === 0);
  await ok('ROLES: чат — командное сообщение подрядчику-владельцу попадает в его режим', C2.call('sendMessage', 'dm:' + rap.id, 'Привет, вы приняты', key()));
  await ok('ROLES: сообщение пришло исполнителю, а не подрядчику', DR.call('me'), (b) => b.unread_worker === 1 && b.unread_contractor === 0);
  await ok('ROLES: общее уведомление (PRO) видно в обоих режимах', A.call('adminGrantPro', DR.id, 3), () => true);
  await ok('ROLES: PRO в режиме исполнителя', DR.call('notifications', 'worker'), (b) => b.some((n) => n.type === 'pro')); await ok('ROLES: PRO в режиме подрядчика', DR.call('notifications', 'contractor'), (b) => b.some((n) => n.type === 'pro'));

  // подтверждение номера: без него смену не создать; один номер — один аккаунт; удаление аккаунта освобождает номер
  const verify = async (tgId, phone) => (await db.query('select bot_verify_phone($1, $2) as r', [tgId, phone])).rows[0].r;
  const UV = await login(7001, 'Новичок', true), UV2 = await login(7002, 'Двойник', true);
  await ok('PHONE: профиль подрядчика UV', UV.call('saveContractor', { ...cp, name: 'Новичок' })); await ok('PHONE: профиль подрядчика UV2', UV2.call('saveContractor', { ...cp, name: 'Двойник' }));
  await ok('PHONE: до подтверждения phone_verified = false', UV.call('me'), (b) => b.phone_verified === false);
  await no('PHONE: смену без подтверждённого номера создать нельзя', UV.call('createShift', { ...sp, title: 'Без номера', date: day(13) }, key()), 'phone_unverified');
  check('PHONE: короткий номер отклонён', (await verify(7001, '123')) === 'invalid');
  check('PHONE: не российский номер отклонён', (await verify(7001, '+49 151 2345 6789')) === 'foreign');
  check('PHONE: неизвестный пользователь', (await verify(999999, '+7 916 111-22-33')) === 'no_user');
  check('PHONE: подтверждение проходит', (await verify(7001, '+7 (916) 111-22-33')) === 'ok');
  await ok('PHONE: после подтверждения phone_verified = true', UV.call('me'), (b) => b.phone_verified === true);
  await ok('PHONE: теперь смену создать можно', UV.call('createShift', { ...sp, title: 'С номером', date: day(13) }, key()));
  check('PHONE: тот же номер на втором аккаунте (с 8 вместо +7) — занят', (await verify(7002, '8 916 111 22 33')) === 'taken');
  await no('PHONE: у двойника смену создать нельзя', UV2.call('createShift', { ...sp, title: 'Двойник', date: day(13) }, key()), 'phone_unverified');
  check('PHONE: повторное подтверждение тем же человеком не мешает', (await verify(7001, '79161112233')) === 'ok');
  await ok('PHONE: админ публикует без проверки номера', A.call('me'), (b) => b.phone_verified === true);
  await ok('PHONE: удаление аккаунта', UV.call('deleteAccount'));
  check('PHONE: после удаления номер свободен для другого аккаунта', (await verify(7002, '79161112233')) === 'ok');

  // ---- безопасность: размеры, допустимые значения, скрытые смены ----
  const SEC = await login(7101, 'Безопасность');
  await ok('SEC: обычное событие записывается', SEC.call('track', 'sec_test_ok', { a: 1 }));
  await ok('SEC: слишком большое событие молча игнорируется', SEC.call('track', 'sec_test_big', { x: 'я'.repeat(5000) }));
  await ok('SEC: слишком длинное имя события игнорируется', SEC.call('track', 'zzzz' + 'z'.repeat(100), {}));
  const evs = await db.query("select event from events where event like 'sec_test_%' or event like 'zzzz%'");
  check('SEC: в журнале только нормальное событие', evs.rows.length === 1 && evs.rows[0].event === 'sec_test_ok', JSON.stringify(evs.rows));
  await ok('SEC: огромная ошибка игнорируется', SEC.call('logError', { message: 'я'.repeat(7000) })); await ok('SEC: обычная ошибка пишется', SEC.call('logError', { message: 'тест' }));
  const errs = await db.query("select count(*)::int as n from events where event = 'error' and user_id = $1", [SEC.id]);
  check('SEC: в журнале одна ошибка из двух', errs.rows[0].n === 1, JSON.stringify(errs.rows));
  const bigReq = await fetch(BASE + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SEC.token }, body: JSON.stringify({ fn: 'track', args: ['sec_big_req', { x: 'a'.repeat(100000) }] }) });
  check('SEC: запрос больше 64 КБ отклонён (кроме профиля с фото)', bigReq.status === 413, String(bigReq.status));
  await ok('SEC: профиль с фото по-прежнему принимается', SEC.call('saveWorker', { ...wp, name: 'Безопасный', license: ['B', '<b data-pwn=1>x</b>', 'Z', 'B'], skills: ['я'.repeat(100), 'ok'] }),
    (b) => JSON.stringify(b.worker.license) === '["B"]' && b.worker.skills[0].length === 60 && b.worker.skills[1] === 'ok');
  const badPath = await fetch(ROOT + '/%E0%A4%A', {}); check('SEC: некорректный адрес страницы — 400, а не 500', badPath.status === 400, String(badPath.status));
  const HSH = await ok('SEC: смена для скрытия', C2.call('createShift', { ...sp, title: 'Скрытая смена', date: day(14) }, key()));
  await ok('SEC: админ скрывает смену', A.call('adminHideShift', HSH.id, true));
  await no('SEC: скрытая смена посторонним недоступна', W3.call('getShift', HSH.id), 'not_found');
  await ok('SEC: владельцу скрытая смена доступна', C2.call('getShift', HSH.id)); await ok('SEC: админу скрытая смена доступна', A.call('getShift', HSH.id));
  await ok('SEC: после возврата видна всем', A.call('adminHideShift', HSH.id, false)); await ok('SEC: видна исполнителю', W3.call('getShift', HSH.id));
  const RV = await ok('SEC: смена для отзыва', C2.call('createShift', { ...sp, title: 'Для отзыва', date: day(15) }, key()));
  const rva = await ok('SEC: W3 откликается', W3.call('apply', RV.id)); await ok('SEC: C2 принимает', C2.call('decide', rva.id, 'accepted')); await ok('SEC: C2 завершает', C2.call('completeShift', RV.id));
  await no('SEC: огромные критерии отзыва отклонены', W3.call('submitReview', { shift_id: RV.id, to_user: C2.id, stars: 5, criteria: { a: 'я'.repeat(700) }, text: 'ок' }), 'invalid');
  await ok('SEC: обычный отзыв проходит', W3.call('submitReview', { shift_id: RV.id, to_user: C2.id, stars: 5, criteria: { 'Условия': 5 }, text: 'ок' }));

  // ---- поиск подрядчиков и вкладки профиля подрядчика ----
  const SR = await login(7201, 'Ищущий');
  await ok('FIND: профиль исполнителя', SR.call('saveWorker', { ...wp, name: 'Ищущий Олег' }));
  await ok('FIND: поиск по части названия компании находит подрядчика', SR.call('searchContractors', 'двойной'), (b) => b.some((c) => /Двойной/.test(c.name)) && b.every((c) => c.id && 'rating' in c && 'shifts_done' in c));
  await ok('FIND: регистр и пробелы не мешают', SR.call('searchContractors', '  ДВОЙНОЙ  '), (b) => b.some((c) => /Двойной/.test(c.name)));
  await ok('FIND: без текста — самые опытные, не больше 20', SR.call('searchContractors', ''), (b) => Array.isArray(b) && b.length > 0 && b.length <= 20);
  await ok('FIND: нет совпадений — пустой список', SR.call('searchContractors', 'zzzzнетакого'), (b) => Array.isArray(b) && b.length === 0);
  await ok('FIND: символы % и _ не работают как шаблон', SR.call('searchContractors', '%'), (b) => b.length === 0);
  await ok('FIND: себя в поиске нет', DR.call('searchContractors', 'двойной'), (b) => !b.some((c) => c.id === DR.id));
  await ok('FIND: поиск доступен и подрядчику', C2.call('searchContractors', ''), (b) => Array.isArray(b));
  await ok('FIND: заблокированный подрядчик в поиске не виден', A.call('adminBlock', DR.id, true));
  await ok('FIND: …и не находится', SR.call('searchContractors', 'двойной'), (b) => !b.some((c) => c.id === DR.id));
  await ok('FIND: разблокировали', A.call('adminBlock', DR.id, false));
  await ok('FIND: профиль подрядчика содержит счётчики и завершённые', SR.call('contractorPage', C2.id), (b) => typeof b.active_count === 'number' && typeof b.completed_count === 'number' && Array.isArray(b.completed) && b.completed_count >= 1 && b.completed.length >= 1 && b.completed.length <= 30);
  await ok('FIND: счётчики активных совпадают со списком', SR.call('contractorPage', C2.id), (b) => b.active_count === b.shifts.length);

  assert.equal(fail, 0, `Не прошло ${fail} из ${pass + fail}:\n  ✗ ${bugs.join('\n  ✗ ')}`);
  console.log(`Проверок пройдено: ${pass}`);
});

