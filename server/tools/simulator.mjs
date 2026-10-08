// SPEED HELPER — симулятор «кипящей» работы для предрелизного теста и проверки нагрузки.
//
// Заводит выдуманных исполнителей и подрядчиков (tg_id < 0, пометка users.is_fake) и ведёт их «рабочий день»:
// публикуют смены, листают ленту, откликаются, принимают и отклоняют, пишут в чаты, отмечают явку, завершают смены, ставят оценки.
// Все запросы идут через настоящий HTTP API сервера (с лимитами, проверкой прав и т. д.), поэтому нагрузка честная.
// Живые участники команды «вклиниваются»: на их отклики к тестовым сменам подрядчики отвечают, на личные сообщения — отвечают,
// а тестовые исполнители откликаются и на их смены.
//
// Запуск (на сервере):   systemd-run --unit=speedhelper-sim --collect node /opt/speedhelper/server/tools/simulator.mjs --users 200 --rate 2
// Остановить:            systemctl stop speedhelper-sim
// Статус:                node /opt/speedhelper/server/tools/simulator.mjs --status
// Убрать всё тестовое:   systemctl stop speedhelper-sim; node /opt/speedhelper/server/tools/simulator.mjs --clean
//
// Параметры: --users N (исполнителей и подрядчиков по N, по умолчанию 200)   --rate X (действий в секунду, 2)
//            --online N (сколько «открытых приложений» опрашивают сервер раз в 4 с, 80)   --hours H (автостоп, 6)
//            --seed N (смен в начале, 150)   --cap N (потолок открытых тестовых смен, 600)   --age СЕК (через сколько секунд смену можно завершать, 120)   --base URL (адрес сервера)
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from '../env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv(path.join(ROOT, 'server', '.env'));
const env = process.env;
for (const k of ['DATABASE_URL', 'JWT_SECRET']) if (!env[k]) { console.error('Не задана переменная ' + k); process.exit(1); }
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); if (i < 0) return d; const v = argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; };
const N = Number(opt('users', 200)), RATE = Number(opt('rate', 2)), ONLINE = Number(opt('online', 80)), HOURS = Number(opt('hours', 6)), SEED = Number(opt('seed', 150)), CAP = Number(opt('cap', 600));
const AGE = Number(opt('age', 120)); // через сколько секунд после публикации смену можно завершать
const BASE = String(opt('base', `http://127.0.0.1:${env.PORT || 3000}`)).replace(/\/$/, '');
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
const log = (...a) => console.log(new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' }), ...a);

// ---------- команды --status / --clean ----------
if (opt('status', false) || opt('clean', false)) {
  if (opt('clean', false)) { const [r] = await q('select fake_cleanup() as r'); log('Тестовые данные удалены:', JSON.stringify(r.r)); }
  const [s] = await q(`select (select count(*) from users where is_fake) as users, (select count(*) from shifts s join users u on u.id = s.contractor_id where u.is_fake) as shifts,
    (select count(*) from applications a join users u on u.id = a.worker_id where u.is_fake) as applications, (select count(*) from messages m join users u on u.id = m.user_id where u.is_fake) as messages`);
  log('Сейчас тестовых: пользователей', s.users, '· смен', s.shifts, '· откликов', s.applications, '· сообщений', s.messages);
  await pool.end(); process.exit(0);
}

// ---------- данные для правдоподобия ----------
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const chance = (p) => Math.random() < p;
const FM = ['Александр', 'Дмитрий', 'Максим', 'Сергей', 'Андрей', 'Алексей', 'Артём', 'Илья', 'Кирилл', 'Михаил', 'Никита', 'Матвей', 'Роман', 'Егор', 'Денис', 'Павел', 'Владимир', 'Руслан', 'Тимур', 'Олег', 'Иван', 'Евгений', 'Виктор', 'Георгий'];
const FF = ['Анна', 'Мария', 'Елена', 'Ольга', 'Наталья', 'Екатерина', 'Анастасия', 'Дарья', 'Полина', 'Ксения', 'Виктория', 'Юлия', 'Алина', 'Милана', 'Софья', 'Ирина', 'Татьяна', 'Светлана'];
const LM = ['Иванов', 'Смирнов', 'Кузнецов', 'Попов', 'Васильев', 'Петров', 'Соколов', 'Михайлов', 'Новиков', 'Фёдоров', 'Морозов', 'Волков', 'Алексеев', 'Лебедев', 'Семёнов', 'Егоров', 'Павлов', 'Козлов', 'Степанов', 'Николаев', 'Орлов', 'Андреев', 'Макаров', 'Никитин', 'Захаров'];
const COMP = ['ООО «Склад-Сервис»', 'ИП Громов', 'ООО «МегаЛогистик»', 'ООО «Чистый Дом»', 'ИП Сидоров', 'ООО «Промо-Групп»', 'ООО «Быстрая Доставка»', 'ИП Крылова', 'ООО «СтройМонтаж»', 'ООО «Банкет-Холл»', 'ООО «Фуд Тайм»', 'ИП Белов', 'ООО «Мебель Плюс»', 'ООО «Ритейл Помощь»', 'ИП Захарова', 'ООО «Эвент Лайн»', 'ООО «Транс-Груз»', 'ООО «Маркет Пик»'];
const ADDR = [
  ['г Москва, ул Тверская, д 12', 55.764, 37.606, 'msk'], ['г Москва, Ленинградский проспект, д 39', 55.79, 37.547, 'msk'], ['г Москва, ул Профсоюзная, д 56', 55.677, 37.563, 'msk'],
  ['г Москва, Каширское шоссе, д 31', 55.658, 37.65, 'msk'], ['г Москва, ул Новослободская, д 14', 55.781, 37.601, 'msk'], ['г Москва, Варшавское шоссе, д 125', 55.613, 37.619, 'msk'],
  ['г Москва, Дмитровское шоссе, д 100', 55.865, 37.575, 'msk'], ['г Москва, ул Вавилова, д 3', 55.702, 37.577, 'msk'], ['г Москва, Рязанский проспект, д 2', 55.726, 37.726, 'msk'],
  ['г Москва, ул Ботаническая, д 25', 55.833, 37.586, 'msk'], ['г Москва, Волгоградский проспект, д 32', 55.723, 37.745, 'msk'], ['г Москва, Щёлковское шоссе, д 77', 55.81, 37.8, 'msk'],
  ['г Москва, Кутузовский проспект, д 36', 55.739, 37.516, 'msk'], ['г Москва, ул Арбат, д 10', 55.7512, 37.5905, 'msk'], ['г Москва, Пресненская набережная, д 12', 55.749, 37.539, 'msk'],
  ['г Москва, ул Электрозаводская, д 21', 55.789, 37.704, 'msk'], ['г Москва, ул Люблинская, д 100', 55.677, 37.743, 'msk'], ['г Москва, Open-Air парк Горького, д 9', 55.731, 37.601, 'msk'],
  ['Московская обл, г Химки, ул Ленинградская, д 1', 55.897, 37.43, 'mo'], ['Московская обл, г Мытищи, Олимпийский проспект, д 50', 55.91, 37.733, 'mo'],
  ['Московская обл, г Красногорск, ул Ленина, д 1', 55.8317, 37.3295, 'mo'], ['Московская обл, г Балашиха, шоссе Энтузиастов, д 1', 55.796, 37.938, 'mo'],
  ['Московская обл, г Подольск, ул Ленина, д 1', 55.431, 37.545, 'mo'], ['Московская обл, г Люберцы, Октябрьский проспект, д 100', 55.676, 37.899, 'mo'],
  ['Московская обл, г Одинцово, Можайское шоссе, д 20', 55.678, 37.278, 'mo'], ['Московская обл, г Домодедово, Каширское шоссе, д 5', 55.441, 37.768, 'mo'],
  ['Московская обл, г Долгопрудный, Лихачёвский проспект, д 5', 55.939, 37.505, 'mo'], ['Московская обл, г Королёв, проспект Королёва, д 1', 55.914, 37.854, 'mo'],
  ['Московская обл, г Щёлково, Пролетарский проспект, д 1', 55.921, 37.991, 'mo'], ['Московская обл, г Пушкино, Московский проспект, д 1', 56.01, 37.847, 'mo'],
  ['Московская обл, г Раменское, ул Космонавтов, д 1', 55.57, 38.23, 'mo'], ['Московская обл, г Жуковский, ул Жуковского, д 1', 55.599, 38.12, 'mo'],
].map(([address, lat, lng, region]) => ({ address, lat, lng, region }));
// [название, категория, тип оплаты, минимум, максимум, людей от, людей до, описание, требования]
const TPL = [
  ['Грузчики на склад', 'Грузчики', 'shift', 2800, 4200, 2, 8, 'Погрузка и перемещение коробов на складе, спецодежда выдаётся.', ['18+']],
  ['Разгрузка фуры', 'Погрузка / разгрузка', 'shift', 3000, 5000, 3, 10, 'Разгрузка еврофуры вручную, около 3 часов работы.', ['18+']],
  ['Комплектация заказов', 'Склад / комплектация', 'hour', 300, 450, 2, 12, 'Сборка заказов по накладным, работа на ногах.', ['Опыт склада']],
  ['Уборка офиса', 'Уборка', 'shift', 2200, 3500, 1, 4, 'Влажная уборка офисных помещений после рабочего дня.', ['18+']],
  ['Генеральная уборка после ремонта', 'Уборка', 'hour', 350, 500, 2, 6, 'Вывоз мусора, мытьё окон и полов.', []],
  ['Курьер на день', 'Курьеры', 'shift', 2500, 4000, 1, 5, 'Доставка заказов по району пешком или на самокате.', ['18+']],
  ['Промоутер у метро', 'Промоутеры', 'shift', 1800, 3000, 2, 10, 'Раздача листовок у входа в метро, форма выдаётся.', []],
  ['Официант на банкет', 'Официанты / кухня', 'shift', 3000, 4800, 3, 12, 'Обслуживание банкета на 80 гостей, чёрный низ и белый верх.', ['Медкнижка']],
  ['Помощник на кухню', 'Официанты / кухня', 'hour', 280, 380, 1, 4, 'Нарезка, мытьё посуды, помощь повару.', ['Медкнижка']],
  ['Монтаж стеллажей', 'Монтаж / стройка', 'shift', 4500, 7500, 2, 6, 'Сборка металлических стеллажей по схеме, инструмент есть.', ['Опыт склада']],
  ['Демонтаж перегородок', 'Монтаж / стройка', 'shift', 4000, 6500, 2, 5, 'Демонтаж гипсокартонных перегородок и вынос мусора.', ['18+']],
  ['Разнорабочие на стройплощадку', 'Разнорабочие', 'hour', 320, 480, 3, 15, 'Подсобные работы на объекте до выполнения задачи.', ['18+']],
  ['Переезд офиса', 'Грузчики', 'shift', 3500, 5500, 3, 8, 'Перевозка мебели и техники, аккуратная погрузка.', ['18+']],
  ['Сборка мебели', 'Монтаж / стройка', 'hour', 400, 600, 1, 3, 'Сборка шкафов и кроватей в новой квартире.', []],
  ['Помощник на мероприятие', 'Прочее', 'shift', 2500, 4200, 4, 15, 'Помощь с монтажом сцены и работа с гостями на мероприятии.', []],
  ['Фасовка продуктов', 'Склад / комплектация', 'shift', 2400, 3400, 4, 14, 'Фасовка и упаковка продуктов, перчатки выдаются.', ['Медкнижка']],
];
const SAY_W = ['Здравствуйте! Смена ещё актуальна?', 'Подскажите, где именно встречаемся?', 'Могу подойти заранее, во сколько удобно?', 'Спецодежда нужна своя?', 'Я на месте, подхожу к входу', 'Подтверждаю, буду вовремя', 'Есть ли горячая вода и обед?', 'Опыт есть, работал на таком уже', 'Можно взять с собой друга?', 'Спасибо, всё понял!', 'Задерживаюсь на 10 минут, не переживайте', 'Какой вход со двора?'];
const SAY_C = ['Здравствуйте! Да, смена актуальна', 'Встречаемся у главного входа, спросите бригадира', 'Приходите за 15 минут до начала', 'Спецодежду выдаём на месте', 'Отлично, ждём вас!', 'Обед предоставляем, вода есть', 'Подтвердил вас, до встречи', 'Возьмите паспорт, нужен для пропуска', 'Спасибо за работу, всё отлично', 'Можно приходить вдвоём, мест хватает', 'Напишите, когда будете на месте', 'Всё в силе, жду завтра'];
const REVIEW_TXT = ['Отличная работа, рекомендую', 'Всё чётко, оплата вовремя', 'Пришёл вовремя, работал хорошо', 'Хороший подрядчик, вернусь ещё', 'Немного задержали оплату, но в целом ок', 'Всё как договаривались', ''];
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (name) => { const ini = name.split(' ').map((w) => w[0]).slice(0, 2).join(''); const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="hsl(${hue(name)},45%,32%)"/><text x="48" y="60" font-size="38" font-family="Arial" fill="#fff" text-anchor="middle">${ini}</text></svg>`; return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'); };

// ---------- вспомогательное: токены, запросы, метрики ----------
const b64u = (b) => Buffer.from(b).toString('base64url');
const sign = (sub) => { const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b = b64u(JSON.stringify({ sub: String(sub), exp: Math.floor(Date.now() / 1000) + 12 * 3600 })); return `${h}.${b}.${crypto.createHmac('sha256', env.JWT_SECRET).update(`${h}.${b}`).digest('base64url')}`; };
const tokens = new Map();
const tok = (id) => { let t = tokens.get(id); if (!t || t.exp < Date.now()) { t = { v: sign(id), exp: Date.now() + 10 * 3600e3 }; tokens.set(id, t); } return t.v; };
let win = { n: 0, lat: [], bad: 0, st: {} }, tot = { n: 0, bad: 0, biz: 0, by: {} };
const rec = (fn, status, ms) => {
  win.n++; tot.n++; win.lat.push(ms);
  const by = (tot.by[fn] ||= { n: 0, lat: [], bad: 0 }); by.n++; by.lat.push(ms); if (by.lat.length > 2000) by.lat.shift();
  if (status >= 500 || status === 429 || status < 0) { win.bad++; tot.bad++; by.bad++; win.st[status] = (win.st[status] || 0) + 1; }
  else if (status >= 400) tot.biz++;
};
async function call(uid, fn, ...a) {
  const t0 = performance.now(); let status = -1, body = null;
  try { const r = await fetch(BASE + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok(uid) }, body: JSON.stringify({ fn, args: a }), signal: AbortSignal.timeout(20000) }); status = r.status; body = await r.json().catch(() => null); } catch { status = -1; }
  rec(fn, status, performance.now() - t0); return { status, body, ok: status === 200 };
}
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// ---------- пользователи ----------
let W = [], C = []; const fake = new Set();
async function ensureUsers() {
  const mk = async (i, kind) => {
    const tg = kind === 'w' ? -(1000 + i) : -(100000 + i);
    const female = kind === 'w' ? chance(0.35) : chance(0.3);
    const first = female ? pick(FF) : pick(FM), last = pick(LM) + (female ? 'а' : '');
    const [r] = await q(`insert into users(tg_id, first_name, roles, is_fake, terms_accepted_at) values ($1, $2, '{}', true, now()) on conflict (tg_id) do update set is_fake = true, terms_accepted_at = coalesce(users.terms_accepted_at, now()) returning id`, [tg, first]);
    return { id: Number(r.id), tg, name: kind === 'w' ? `${first} ${last}` : (chance(0.55) ? pick(COMP) : `${first} ${last}`), person: `${first} ${last}`, kind };
  };
  for (let i = 1; i <= N; i++) { W.push(await mk(i, 'w')); C.push(await mk(i, 'c')); }
  [...W, ...C].forEach((u) => fake.add(u.id));
  const haveW = new Set((await q('select user_id from worker_profiles where user_id = any($1)', [W.map((u) => u.id)])).map((r) => Number(r.user_id)));
  const haveC = new Set((await q('select user_id from contractor_profiles where user_id = any($1)', [C.map((u) => u.id)])).map((r) => Number(r.user_id)));
  const jobs = [];
  for (const w of W) if (!haveW.has(w.id)) jobs.push(() => call(w.id, 'saveWorker', { name: w.person, city: 'Москва', age: rnd(18, 55), avatar: avatar(w.person), about: chance(0.5) ? 'Ответственный, без вредных привычек' : '', experience: chance(0.6) ? pick(['1 год на складе', '2 года грузчиком', 'Курьер, 3 года', 'Работал на мероприятиях']) : '', skills: [pick(['погрузка', 'уборка', 'сборка', 'курьер', 'кухня', 'монтаж']), pick(['склад', 'мебель', 'доставка', 'инструмент'])], license: chance(0.3) ? ['B'] : [], phone: '', medbook: chance(0.4), selfemployed: chance(0.3), night: chance(0.5), tools: chance(0.3) }));
  for (const c of C) if (!haveC.has(c.id)) jobs.push(() => call(c.id, 'saveContractor', { name: c.person, company: c.name === c.person ? '' : c.name, city: 'Москва', phone: '000000' + String(c.tg).slice(-4).padStart(4, '0'), about: 'Тестовый подрядчик', avatar: chance(0.7) ? avatar(c.name) : null }));
  let k = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (k < jobs.length) { const j = jobs[k++]; const r = await j(); if (!r.ok) log('профиль не создан:', r.status, JSON.stringify(r.body)); } }));
  log(`Тестовые пользователи готовы: ${W.length} исполнителей, ${C.length} подрядчиков (профилей создано: ${jobs.length})`);
}

// ---------- время (МСК) и смены ----------
const msk = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; };
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
let CAT = {};
function genShift() {
  const t = pick(TPL), a = pick(ADDR), now = msk();
  let off = pick([0, 1, 1, 1, 2, 2, 3, 4, 5, 6]), start;
  if (off === 0) { start = Math.ceil((now.min + 70) / 30) * 30; if (start > 20 * 60) { off = 1; start = rnd(8, 14) * 60; } } else start = rnd(8, 18) * 60 + pick([0, 30]);
  const untilDone = chance(0.12), len = rnd(4, 11) * 60;
  const pay = Math.round(rnd(t[3], t[4]) / 50) * 50;
  return { title: t[0], category_id: CAT[t[1]], description: t[7], address: a.address, lat: a.lat + (Math.random() - 0.5) * 0.004, lng: a.lng + (Math.random() - 0.5) * 0.004, region: a.region, date: addDays(now.date, off),
    start: hhmm(start), end: untilDone ? '' : hhmm(start + len), until_done: untilDone, pay_type: t[2], pay, people: rnd(t[5], t[6]), requirements: t[8], notify_favorites: false };
}

// ---------- действия ----------
const pend = { creating: 0 };
async function aCreate() {
  const [{ n }] = await q(`select count(*)::int as n from shifts s where s.status in ('open','full') and s.contractor_id = any($1)`, [C.map((c) => c.id)]);
  if (n >= CAP) return aComplete(true);
  const c = pick(C); const [{ k }] = await q(`select count(*)::int as k from shifts where contractor_id = $1 and status in ('open','full')`, [c.id]);
  if (k >= 6) return;
  await call(c.id, 'createShift', genShift(), crypto.randomUUID());
}
async function aBrowse() {
  const w = pick(W); const f = { geo: pick(['any', 'any', 'msk', 'mo']), date: pick(['any', 'any', 'today', 'tomorrow', 'weekend']), min_pay: pick([0, 0, 0, 1500, 3000]), limit: 20, offset: 0, categories: chance(0.25) ? [pick(Object.values(CAT))] : [] };
  const r = await call(w.id, 'feed', f); if (!r.ok) return null; return { w, items: r.body.items || [] };
}
async function aApply() {
  const b = await aBrowse(); if (!b || !b.items.length) return;
  const [{ n }] = await q(`select count(*)::int as n from applications where worker_id = $1 and status = 'pending'`, [b.w.id]);
  if (n >= 6) { const [ap] = await q(`select id from applications where worker_id = $1 and status = 'pending' order by random() limit 1`, [b.w.id]); if (ap && chance(0.5)) await call(b.w.id, 'withdraw', Number(ap.id)); return; }
  // чужие (настоящих людей) смены привлекательнее: на них откликаемся чаще
  const real = b.items.filter((s) => !fake.has(Number(s.contractor_id)));
  const s = real.length && chance(0.6) ? pick(real) : pick(b.items);
  const r = await call(b.w.id, 'apply', s.id); if (r.ok && chance(0.5)) setTimeout(() => call(b.w.id, 'sendMessage', 'dm:' + r.body.id, pick(SAY_W), crypto.randomUUID()), rnd(3000, 20000));
}
async function aSkipSave() {
  const b = await aBrowse(); if (!b || !b.items.length) return; const s = pick(b.items);
  if (chance(0.6)) await call(b.w.id, 'skip', s.id); else await call(b.w.id, 'toggleShiftFav', s.id);
}
async function aWorkerMisc() {
  const w = pick(W); const fn = pick(['myApplications', 'notifications', 'savedShifts', 'favorites', 'myDialogs', 'leaderboard']);
  await call(w.id, fn, fn === 'favorites' ? 'contractor' : fn === 'myDialogs' ? 'worker' : fn === 'leaderboard' ? 'month' : undefined);
}
async function aContractorMisc() {
  const c = pick(C); const fn = pick(['myShifts', 'contractorStats', 'myWorkers', 'myDialogs', 'notifications']);
  await call(c.id, fn, fn === 'myDialogs' ? 'contractor' : undefined);
}
// подрядчики разбирают отклики (в том числе от настоящих людей к тестовым сменам)
async function aDecide(minAgeSec = 6) {
  const rows = await q(`select a.id, a.worker_id, s.id as sid, s.contractor_id from applications a join shifts s on s.id = a.shift_id join users cu on cu.id = s.contractor_id join users wu on wu.id = a.worker_id
    where cu.is_fake and a.status = 'pending' and s.status = 'open' and a.created_at < now() - ($1 || ' seconds')::interval order by (not wu.is_fake) desc, random() limit 4`, [String(minAgeSec)]);
  for (const a of rows) {
    const realWorker = !fake.has(Number(a.worker_id)); const accept = chance(realWorker ? 0.95 : 0.72);
    const r = await call(Number(a.contractor_id), 'decide', Number(a.id), accept ? 'accepted' : 'rejected');
    if (r.ok && accept) setTimeout(() => call(Number(a.contractor_id), 'sendMessage', 'dm:' + a.id, pick(SAY_C), crypto.randomUUID()), rnd(2000, 12000));
    else if (!r.ok && r.body && r.body.hint === 'full') await call(Number(a.contractor_id), 'decide', Number(a.id), 'rejected');
  }
}
async function aChat() {
  if (chance(0.55)) {
    const [t] = await q(`select a.id, a.worker_id, s.contractor_id, wu.is_fake as wf, cu.is_fake as cf, (select m.user_id from messages m where m.scope = 'dm:' || a.id order by m.id desc limit 1) as last_user,
        (select m.created_at from messages m where m.scope = 'dm:' || a.id order by m.id desc limit 1) as last_at
      from applications a join shifts s on s.id = a.shift_id join users wu on wu.id = a.worker_id join users cu on cu.id = s.contractor_id
      where a.status in ('pending','accepted') and (wu.is_fake or cu.is_fake) and a.created_at > now() - interval '3 days' order by random() limit 1`);
    if (!t) return; const wid = Number(t.worker_id), cid = Number(t.contractor_id);
    const sender = t.last_user && Number(t.last_user) === wid ? (t.cf ? cid : null) : t.last_user && Number(t.last_user) === cid ? (t.wf ? wid : null) : (t.wf && (!t.cf || chance(0.5)) ? wid : (t.cf ? cid : null));
    if (sender == null) return; if (t.last_at && Date.now() - new Date(t.last_at).getTime() < 8000) return;
    await call(sender, 'sendMessage', 'dm:' + t.id, sender === wid ? pick(SAY_W) : pick(SAY_C), crypto.randomUUID());
  } else {
    const [t] = await q(`select s.id, (select m.user_id from shift_members m join users u on u.id = m.user_id where m.shift_id = s.id and u.is_fake order by random() limit 1) as uid from shifts s
      join users cu on cu.id = s.contractor_id where s.status in ('open','full') and exists (select 1 from shift_members m where m.shift_id = s.id and m.role <> 'owner') and (cu.is_fake or true) order by random() limit 1`);
    if (!t || !t.uid) return; const isOwner = (await q(`select 1 from shifts where id = $1 and contractor_id = $2`, [t.id, t.uid])).length > 0;
    await call(Number(t.uid), 'sendMessage', 'shift:' + t.id, isOwner ? pick(SAY_C) : pick(SAY_W), crypto.randomUUID());
  }
}
// завершение смен: отметить явку, завершить; затем участники оценивают
async function aComplete(force = false) {
  const [s] = await q(`select s.id, s.contractor_id from shifts s join users cu on cu.id = s.contractor_id where cu.is_fake and s.status in ('open','full') and s.created_at < now() - ($1 || ' seconds')::interval
    and exists (select 1 from shift_members m where m.shift_id = s.id and m.role <> 'owner') order by random() limit 1`, [String(force ? Math.min(30, AGE) : AGE)]);
  if (!s) return; const cid = Number(s.contractor_id);
  const ms = await q(`select user_id from shift_members where shift_id = $1 and role <> 'owner'`, [s.id]);
  for (const m of ms) if (chance(0.9)) await call(cid, 'setAttendance', Number(s.id), Number(m.user_id), chance(0.9));
  await call(cid, 'completeShift', Number(s.id));
}
async function aReview() {
  const [u] = await q(`select m.user_id from shift_members m join shifts s on s.id = m.shift_id join users u on u.id = m.user_id where u.is_fake and s.status = 'completed' and s.completed_at > now() - interval '2 days' order by random() limit 1`);
  if (!u) return; const uid = Number(u.user_id); const r = await call(uid, 'pendingReviews'); if (!r.ok) return;
  for (const p of (r.body || []).slice(0, 3)) {
    if (chance(0.12)) { await call(uid, 'skipReview', p.shift.id, p.to_user); continue; }
    const stars = pick([5, 5, 5, 5, 5, 4, 4, 4, 3, 3, 2, 1]);
    await call(uid, 'submitReview', { shift_id: p.shift.id, to_user: p.to_user, stars, criteria: {}, text: chance(0.4) ? pick(REVIEW_TXT) : '' });
  }
}
async function aWithdrawOrFav() {
  if (chance(0.5)) { const c = pick(C), w = pick(W); await call(w.id, 'toggleFav', c.id); } else { const w = pick(W), c = pick(C); await call(c.id, 'toggleFav', w.id); }
}
// настоящие люди пишут тестовым — отвечаем (личные чаты и командные)
async function realLoop() {
  try {
    const dms = await q(`with last as (select distinct on (scope) scope, user_id, created_at from messages where scope like 'dm:%' and created_at > now() - interval '15 minutes' order by scope, id desc)
      select substr(l.scope, 4)::bigint as app, a.worker_id, s.contractor_id, wu.is_fake as wf, cu.is_fake as cf, l.user_id as lu from last l join applications a on a.id = substr(l.scope, 4)::bigint join shifts s on s.id = a.shift_id
      join users wu on wu.id = a.worker_id join users cu on cu.id = s.contractor_id join users lastu on lastu.id = l.user_id
      where not lastu.is_fake and l.created_at < now() - interval '4 seconds' and (wu.is_fake or cu.is_fake) limit 6`);
    for (const d of dms) { const wid = Number(d.worker_id), cid = Number(d.contractor_id); const sender = d.wf && Number(d.lu) !== wid ? wid : d.cf && Number(d.lu) !== cid ? cid : null; if (sender) await call(sender, 'sendMessage', 'dm:' + d.app, sender === wid ? pick(SAY_W) : pick(SAY_C), crypto.randomUUID()); }
    const team = await q(`with last as (select distinct on (scope) scope, user_id, created_at from messages where scope like 'shift:%' and created_at > now() - interval '15 minutes' order by scope, id desc)
      select substr(l.scope, 7)::bigint as sid, (select m.user_id from shift_members m join users u on u.id = m.user_id where m.shift_id = substr(l.scope, 7)::bigint and u.is_fake order by random() limit 1) as uid
      from last l join users lastu on lastu.id = l.user_id where not lastu.is_fake and l.created_at < now() - interval '5 seconds' limit 4`);
    for (const t of team) if (t.uid && chance(0.7)) { const own = (await q('select 1 from shifts where id = $1 and contractor_id = $2', [t.sid, t.uid])).length > 0; await call(Number(t.uid), 'sendMessage', 'shift:' + t.sid, own ? pick(SAY_C) : pick(SAY_W), crypto.randomUUID()); }
    // настоящие подрядчики: тестовые исполнители откликаются на их новые смены
    const fresh = await q(`select s.id from shifts s join users cu on cu.id = s.contractor_id where not cu.is_fake and s.status = 'open' and s.created_at > now() - interval '10 minutes'
      and (select count(*) from applications a join users wu on wu.id = a.worker_id where a.shift_id = s.id and wu.is_fake) < least(s.people + 2, 6) order by random() limit 2`);
    for (const s of fresh) if (chance(0.5)) { const w = pick(W); const r = await call(w.id, 'apply', Number(s.id)); if (r.ok && !r.body.duplicate) setTimeout(() => call(w.id, 'sendMessage', 'dm:' + r.body.id, pick(SAY_W), crypto.randomUUID()), rnd(3000, 15000)); }
  } catch (e) { log('realLoop:', e.message); }
}

// ---------- «открытые приложения»: опрос сервера раз в 4 секунды, как делает настоящий клиент ----------
const pollers = [];
function startPollers() {
  const online = [...W.slice(0, Math.ceil(ONLINE * 0.7)), ...C.slice(0, Math.floor(ONLINE * 0.3))];
  for (const u of online) setTimeout(() => pollers.push(setInterval(() => { call(u.id, 'me'); if (chance(0.25)) call(u.id, 'myDialogs', u.kind === 'w' ? 'worker' : 'contractor'); }, 4000 + rnd(-400, 400))), rnd(0, 4000));
  log(`Включён опрос «открытых приложений»: ${online.length} пользователей каждые ~4 с (≈${Math.round(online.length / 4)} запросов/с)`);
}

const ACTIONS = [[aBrowse, 22], [aApply, 16], [aSkipSave, 7], [aWorkerMisc, 6], [aContractorMisc, 5], [aCreate, 8], [aDecide, 12], [aChat, 12], [aComplete, 4], [aReview, 5], [aWithdrawOrFav, 3]];
const TOTW = ACTIONS.reduce((a, x) => a + x[1], 0);
const pickAction = () => { let r = Math.random() * TOTW; for (const [f, w] of ACTIONS) { if ((r -= w) < 0) return f; } return ACTIONS[0][0]; };

// ---------- главный цикл и отчёты ----------
let stopping = false, inflight = 0; const t0 = Date.now(); const actCount = { n: 0, win: 0 };
async function report(full) {
  const secs = 10, lat = win.lat; const [d] = await q(`select (select count(*) from shifts s join users u on u.id = s.contractor_id where u.is_fake and s.status = 'open') as open_shifts,
    (select count(*) from applications a join users u on u.id = a.worker_id where u.is_fake and a.status = 'pending') as pend, (select count(*) from applications a join users u on u.id = a.worker_id where u.is_fake) as apps,
    (select count(*) from messages m join users u on u.id = m.user_id where u.is_fake) as msgs, (select count(*) from shifts s join users u on u.id = s.contractor_id where u.is_fake and s.status = 'completed') as done`).catch(() => [{}]);
  log(`${(win.n / secs).toFixed(1)} запр/с · действий ${(actCount.win / secs).toFixed(1)}/с · задержка p50 ${pct(lat, 0.5).toFixed(0)} p95 ${pct(lat, 0.95).toFixed(0)} max ${Math.max(0, ...lat).toFixed(0)} мс · ошибок ${win.bad}${win.bad ? ' ' + JSON.stringify(win.st) : ''} | открытых смен ${d.open_shifts}, откликов ждут ${d.pend} (всего ${d.apps}), завершено ${d.done}, сообщений ${d.msgs} | память ${(process.memoryUsage().rss / 1048576).toFixed(0)} МБ`);
  win = { n: 0, lat: [], bad: 0, st: {} }; actCount.win = 0;
  if (full) { const rows = Object.entries(tot.by).sort((a, b) => b[1].n - a[1].n).map(([fn, v]) => `${fn}: ${v.n} шт, p95 ${pct(v.lat, 0.95).toFixed(0)} мс${v.bad ? ', ОШИБОК ' + v.bad : ''}`); log('По методам за всё время →', rows.join(' · ')); }
}
async function main() {
  const cats = await q('select id, name from categories where active'); for (const c of cats) CAT[c.name] = Number(c.id);
  log(`Старт симулятора: по ${N} исполнителей и подрядчиков, ${RATE} действий/с, онлайн ${ONLINE}, автостоп через ${HOURS} ч, адрес ${BASE}`);
  const h = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null); if (!h || !h.ok) { console.error('Сервер не отвечает по адресу ' + BASE); process.exit(1); }
  await ensureUsers();
  log(`Начальные смены: создаём ${SEED}…`);
  let created = 0; await Promise.all(Array.from({ length: 5 }, async () => { while (created < SEED) { created++; const c = pick(C); await call(c.id, 'createShift', genShift(), crypto.randomUUID()); } }));
  startPollers();
  setInterval(() => report(false), 10000); setInterval(() => report(true), 120000);
  setInterval(realLoop, 3000);
  let budget = 0;
  const loop = setInterval(() => {
    if (stopping) return; budget += RATE / 10;
    while (budget >= 1) { budget--; if (inflight >= 40) continue; inflight++; actCount.n++; actCount.win++; Promise.resolve().then(pickAction()).catch((e) => log('действие:', e.message)).finally(() => inflight--); }
  }, 100);
  const stop = async (why) => { if (stopping) return; stopping = true; clearInterval(loop); pollers.forEach(clearInterval); log('Остановка:', why); await new Promise((r) => setTimeout(r, 1500)); await report(true); log(`Итого: запросов ${tot.n}, ошибок сервера/лимитов ${tot.bad}, обычных отказов (закрыто, занято и т. п.) ${tot.biz}. Тестовые данные остались — убрать: node server/tools/simulator.mjs --clean`); await pool.end(); process.exit(0); };
  process.on('SIGINT', () => stop('сигнал')); process.on('SIGTERM', () => stop('сигнал'));
  setTimeout(() => stop(`прошло ${HOURS} ч`), HOURS * 3600e3);
}
main().catch((e) => { console.error('Симулятор упал:', e); process.exit(1); });
