// Локальный движок: повторяет правила серверных RPC (см. supabase/migrations) на localStorage.
// Нужен для разработки/проверки без Supabase. В нём НЕТ демо-смен: база пустая, пока пользователи сами не создадут данные.
import { CONFIG } from './config.js';
import { dist, isWeekend, todayISO, addDays, uid } from './util.js';

const KEY = 'sh_local_db_v1';
const DEFAULT_CATEGORIES = ['Грузчики', 'Разнорабочие', 'Склад / комплектация', 'Уборка', 'Погрузка / разгрузка', 'Курьеры', 'Промоутеры', 'Официанты / кухня', 'Монтаж / стройка', 'Прочее'];
const WORKER_WEIGHTS = { name: 15, city: 10, age: 10, avatar: 10, phone: 5, about: 5, experience: 10, skills: 10, license: 5, medbook: 5, selfemployed: 5, night: 5, tools: 5 };

const fresh = () => ({
  seq: 1, users: [], workers: {}, contractors: {},
  categories: DEFAULT_CATEGORIES.map((name, i) => ({ id: i + 1, name, active: true })),
  shifts: [], applications: [], members: [], messages: [], favorites: [], skips: [],
  reviews: [], notifications: [], reports: [], events: [], audit: [], idem: {},
});

let db = load();
function load() { try { return JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch { return fresh(); } }
function save() { localStorage.setItem(KEY, JSON.stringify(db)); }
function reload() { db = load(); }
const id = () => db.seq++;
const now = () => Date.now();
const fail = (code, msg) => { const e = new Error(msg || code); e.code = code; throw e; };
const arr = (v) => (Array.isArray(v) ? v : []);

function audit(actor, action, meta) { db.audit.push({ id: id(), actor, action, meta, at: now() }); if (db.audit.length > 2000) db.audit.shift(); }
function notify(userId, type, text, link) { db.notifications.push({ id: id(), user_id: userId, type, text, link: link || null, read: false, at: now() }); }

export const profilePercent = (w) => {
  if (!w) return 0;
  const has = { name: !!w.name, city: !!w.city, age: !!w.age, avatar: !!w.avatar, phone: !!w.phone, about: !!w.about, experience: !!w.experience,
    skills: arr(w.skills).length > 0, license: arr(w.license).length > 0, medbook: !!w.medbook, selfemployed: !!w.selfemployed, night: !!w.night, tools: !!w.tools };
  return Object.entries(WORKER_WEIGHTS).reduce((s, [k, v]) => s + (has[k] ? v : 0), 0);
};

// ---------- агрегаты ----------
function ratingOf(userId) {
  const r = db.reviews.filter((x) => x.to_user === userId);
  if (!r.length) return { rating: null, reviews: 0 };
  return { rating: Math.round((r.reduce((s, x) => s + x.stars, 0) / r.length) * 10) / 10, reviews: r.length };
}
const doneShifts = (userId) => db.applications.filter((a) => a.worker_id === userId && a.status === 'completed').length;
const contractorDone = (cid) => db.shifts.filter((s) => s.contractor_id === cid && s.status === 'completed').length;
const acceptedCount = (sid) => db.members.filter((m) => m.shift_id === sid && m.role !== 'owner').length;

function contractorView(cid) {
  const c = db.contractors[cid]; if (!c) return null;
  return { id: cid, name: c.name, company: c.company, avatar: c.avatar, about: c.about, city: c.city, verified: !!c.verified, shifts_done: contractorDone(cid), ...ratingOf(cid) };
}
function workerView(uidv, full) {
  const w = db.workers[uidv]; if (!w) return null;
  const pct = profilePercent(w);
  const v = { user_id: uidv, name: w.name, avatar: w.avatar, city: w.city, age: w.age, skills: arr(w.skills), percent: pct,
    verified: pct >= CONFIG.MIN_VERIFIED_PERCENT, shifts_done: doneShifts(uidv), ...ratingOf(uidv),
    about: w.about, experience: w.experience, license: arr(w.license), medbook: w.medbook, selfemployed: w.selfemployed, night: w.night, tools: w.tools };
  if (full) v.phone = w.phone;
  return v;
}

function shiftView(s, me, origin) {
  const v = { ...s, contractor: contractorView(s.contractor_id), accepted_count: acceptedCount(s.id), category_name: (db.categories.find((c) => c.id === s.category_id) || {}).name };
  if (origin && s.lat != null) v.distance_km = dist(origin.lat, origin.lng, s.lat, s.lng);
  if (me) { const a = db.applications.find((x) => x.shift_id === s.id && x.worker_id === me); v.my_status = a ? a.status : null; v.my_application_id = a ? a.id : null; }
  return v;
}

// ---------- проверки ----------
function actor(uidv) {
  const u = db.users.find((x) => x.id === uidv);
  if (!u) fail('unauthorized', 'Нужно войти');
  if (u.blocked) fail('blocked', 'Аккаунт заблокирован');
  return u;
}
function isSenior(shiftId, userId, perm) {
  const m = db.members.find((x) => x.shift_id === shiftId && x.user_id === userId && x.role === 'senior');
  return !!(m && (!perm || (m.perms || []).includes(perm)));
}
function canManage(s, userId, perm) { return s.contractor_id === userId || isSenior(s.id, userId, perm); }
function shiftOr404(sid) { const s = db.shifts.find((x) => x.id === sid); if (!s) fail('not_found', 'Смена не найдена'); return s; }

function withIdem(userId, key, fn) {
  if (!key) return fn();
  const k = userId + ':' + key;
  if (db.idem[k] !== undefined) return db.idem[k];
  const r = fn(); db.idem[k] = r; return r;
}

// ---------- API ----------
const API = {
  // Auth: в локальном режиме tg-пользователь берётся как есть (на сервере — только после проверки initData)
  login({ tg_id, first_name, username }) {
    let u = db.users.find((x) => x.tg_id === Number(tg_id));
    if (!u) {
      u = { id: id(), tg_id: Number(tg_id), first_name: first_name || 'Пользователь', username: username || null, roles: [], is_admin: Number(tg_id) === 1, blocked: false, created_at: now() };
      db.users.push(u);
    }
    if (u.blocked) fail('blocked', 'Аккаунт заблокирован');
    return API.me(u.id);
  },
  me(me) {
    const u = actor(me);
    return { id: u.id, tg_id: u.tg_id, first_name: u.first_name, username: u.username, roles: u.roles, is_admin: u.is_admin,
      worker: workerView(u.id, true), contractor: db.contractors[u.id] ? { ...db.contractors[u.id], ...contractorView(u.id) } : null,
      unread: db.notifications.filter((n) => n.user_id === u.id && !n.read).length };
  },
  categories() { return db.categories.filter((c) => c.active); },

  saveWorker(me, p) {
    const u = actor(me);
    const name = String(p.name || '').trim(), city = String(p.city || '').trim(), age = Number(p.age);
    if (name.length < 2) fail('invalid', 'Укажите имя');
    if (!city) fail('invalid', 'Укажите город');
    if (!(age >= 16 && age <= 90)) fail('invalid', 'Укажите возраст (16–90)');
    if (!p.avatar && !(db.workers[me] || {}).avatar) fail('invalid', 'Добавьте фото');
    db.workers[me] = { ...(db.workers[me] || {}), ...p, name, city, age, skills: arr(p.skills).map((s) => String(s).trim()).filter(Boolean), license: arr(p.license) };
    if (!u.roles.includes('worker')) u.roles.push('worker');
    return API.me(me);
  },
  saveContractor(me, p) {
    const u = actor(me);
    const name = String(p.name || '').trim(), city = String(p.city || '').trim(), phone = String(p.phone || '').replace(/\D/g, '');
    if (name.length < 2) fail('invalid', 'Укажите имя');
    if (!city) fail('invalid', 'Укажите город');
    if (phone.length < 10) fail('invalid', 'Укажите телефон');
    const old = db.contractors[me] || {};
    db.contractors[me] = { ...old, ...p, name, city, phone: phone.slice(-10), verified: !!old.verified };
    if (!u.roles.includes('contractor')) u.roles.push('contractor');
    return API.me(me);
  },

  // ----- поиск смен -----
  feed(me, f = {}) {
    actor(me);
    const origin = f.lat != null ? { lat: f.lat, lng: f.lng } : CONFIG.DEFAULT_CITY;
    const t = todayISO();
    const skipped = new Set(db.skips.filter((s) => s.user_id === me).map((s) => s.shift_id));
    const applied = new Set(db.applications.filter((a) => a.worker_id === me).map((a) => a.shift_id));
    let list = db.shifts.filter((s) => s.status === 'open' && !s.hidden && s.contractor_id !== me && s.date >= t && !applied.has(s.id) && (f.include_skipped || !skipped.has(s.id)));
    if (f.date === 'today') list = list.filter((s) => s.date === t);
    else if (f.date === 'tomorrow') list = list.filter((s) => s.date === addDays(t, 1));
    else if (f.date === 'weekend') list = list.filter((s) => isWeekend(s.date));
    if (f.min_pay) list = list.filter((s) => s.pay >= f.min_pay);
    if (f.categories && f.categories.length) list = list.filter((s) => f.categories.includes(s.category_id));
    if (f.similar_to) { const b = shiftOr404(f.similar_to); list = list.filter((s) => s.category_id === b.category_id && s.id !== b.id); }
    let out = list.map((s) => shiftView(s, me, origin));
    if (f.radius_km) out = out.filter((s) => s.distance_km == null || s.distance_km <= f.radius_km);
    out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start) || b.id - a.id);
    const off = f.offset || 0, lim = f.limit || 20;
    return { items: out.slice(off, off + lim), total: out.length, next: off + lim < out.length ? off + lim : null };
  },
  getShift(me, sid) { actor(me); return shiftView(shiftOr404(sid), me, null); },
  skip(me, sid) { actor(me); if (!db.skips.find((s) => s.user_id === me && s.shift_id === sid)) db.skips.push({ user_id: me, shift_id: sid, at: now() }); return true; },
  unskip(me, sid) { actor(me); db.skips = db.skips.filter((s) => !(s.user_id === me && s.shift_id === sid)); return true; },
  mySkips(me) {
    actor(me); const t = todayISO();
    return db.skips.filter((k) => k.user_id === me).sort((a, b) => b.at - a.at).map((k) => ({ k, s: db.shifts.find((x) => x.id === k.shift_id) }))
      .filter(({ s }) => s && s.status === 'open' && !s.hidden && s.date >= t && !db.applications.some((a) => a.shift_id === s.id && a.worker_id === me))
      .map(({ k, s }) => ({ ...shiftView(s, me, null), skipped_at: k.at }));
  },
  unskipAll(me) { actor(me); const n = db.skips.filter((s) => s.user_id === me).length; db.skips = db.skips.filter((s) => s.user_id !== me); return n; },

  // ----- отклик (идемпотентен: unique(shift, worker)) -----
  apply(me, sid) {
    const u = actor(me);
    if (!db.workers[me]) fail('profile_required', 'Сначала заполните профиль исполнителя');
    const s = shiftOr404(sid);
    const ex = db.applications.find((a) => a.shift_id === sid && a.worker_id === me);
    if (ex) return { ...ex, duplicate: true };
    if (s.contractor_id === me) fail('own_shift', 'Нельзя откликнуться на свою смену');
    if (s.status !== 'open' || s.hidden) fail('closed', 'Смена уже закрыта');
    const a = { id: id(), shift_id: sid, worker_id: me, status: 'pending', created_at: now(), updated_at: now() };
    db.applications.push(a);
    notify(s.contractor_id, 'new_application', `Новый отклик: ${db.workers[me].name} — «${s.title}»`, `#/c/shift/${sid}`);
    db.skips = db.skips.filter((x) => !(x.user_id === me && x.shift_id === sid));
    return a;
  },
  withdraw(me, appId) {
    actor(me);
    const a = db.applications.find((x) => x.id === appId && x.worker_id === me);
    if (!a) fail('not_found');
    if (a.status === 'pending') { db.applications = db.applications.filter((x) => x !== a); return { removed: true }; }
    if (a.status === 'accepted') {
      a.status = 'cancelled'; a.updated_at = now();
      db.members = db.members.filter((m) => !(m.shift_id === a.shift_id && m.user_id === me));
      const s = shiftOr404(a.shift_id); if (s.status === 'full') s.status = 'open';
      notify(s.contractor_id, 'member_left', `${db.workers[me].name} отказался от смены «${s.title}»`, `#/c/shift/${s.id}`);
    }
    return a;
  },
  undoApply(me, sid) { // «Вернуть» — только пока отклик в ожидании
    const a = db.applications.find((x) => x.shift_id === sid && x.worker_id === me);
    if (a && a.status === 'pending') { db.applications = db.applications.filter((x) => x !== a); const c = db.notifications.findIndex((n) => n.type === 'new_application' && n.link === `#/c/shift/${sid}` && !n.read); if (c >= 0) db.notifications.splice(c, 1); return true; }
    return false;
  },
  myApplications(me) {
    actor(me);
    return db.applications.filter((a) => a.worker_id === me).sort((a, b) => b.updated_at - a.updated_at)
      .map((a) => ({ ...a, shift: shiftView(shiftOr404(a.shift_id), me, null) }));
  },

  // ----- избранное подрядчиков -----
  toggleFav(me, cid) {
    actor(me);
    const i = db.favorites.findIndex((f) => f.user_id === me && f.target_id === cid);
    if (i >= 0) { db.favorites.splice(i, 1); return false; }
    db.favorites.push({ user_id: me, target_id: cid, at: now() }); return true;
  },
  favorites(me, kind) { // kind: 'contractor' | 'worker'
    actor(me);
    const ids = db.favorites.filter((f) => f.user_id === me).map((f) => f.target_id);
    return kind === 'worker' ? ids.filter((i) => db.workers[i]).map((i) => workerView(i)) : ids.filter((i) => db.contractors[i]).map((i) => ({ ...contractorView(i), open_shifts: db.shifts.filter((s) => s.contractor_id === i && s.status === 'open' && !s.hidden && s.date >= todayISO()).length }));
  },
  favIds(me) { return db.favorites.filter((f) => f.user_id === me).map((f) => f.target_id); },
  contractorPage(me, cid) {
    actor(me);
    return { contractor: contractorView(cid), shifts: db.shifts.filter((s) => s.contractor_id === cid && s.status === 'open' && !s.hidden && s.date >= todayISO()).map((s) => shiftView(s, me, null)),
      reviews: db.reviews.filter((r) => r.to_user === cid).slice(-10).reverse().map((r) => ({ ...r, from_name: (db.workers[r.from_user] || db.contractors[r.from_user] || {}).name })), is_fav: db.favorites.some((f) => f.user_id === me && f.target_id === cid) };
  },
  workerPage(me, wid) {
    actor(me);
    const c = db.applications.some((a) => a.worker_id === wid && db.shifts.find((s) => s.id === a.shift_id)?.contractor_id === me);
    return { worker: workerView(wid, c), reviews: db.reviews.filter((r) => r.to_user === wid).slice(-10).reverse().map((r) => ({ ...r, from_name: (db.contractors[r.from_user] || {}).name })), is_fav: db.favorites.some((f) => f.user_id === me && f.target_id === wid) };
  },

  // ----- подрядчик -----
  createShift(me, p, reqId) {
    actor(me);
    if (!db.contractors[me]) fail('profile_required', 'Сначала заполните профиль подрядчика');
    return withIdem(me, reqId, () => {
      const title = String(p.title || '').trim(), address = String(p.address || '').trim();
      if (title.length < 3) fail('invalid', 'Укажите название смены');
      if (!db.categories.find((c) => c.id === Number(p.category_id) && c.active)) fail('invalid', 'Выберите категорию');
      if (address.length < 3) fail('invalid', 'Укажите адрес');
      if (!p.date || p.date < todayISO()) fail('invalid', 'Дата не может быть в прошлом');
      if (!p.start || !p.end) fail('invalid', 'Укажите время начала и окончания');
      if (!(Number(p.pay) > 0)) fail('invalid', 'Укажите оплату');
      if (!(Number(p.people) >= 1 && Number(p.people) <= 500)) fail('invalid', 'Укажите количество людей');
      const s = { id: id(), contractor_id: me, title, category_id: Number(p.category_id), description: String(p.description || '').trim(), address, lat: p.lat ?? null, lng: p.lng ?? null,
        date: p.date, start: p.start, end: p.end, pay: Math.round(Number(p.pay)), people: Math.round(Number(p.people)), requirements: arr(p.requirements), status: 'open', hidden: false, created_at: now() };
      db.shifts.push(s);
      db.members.push({ shift_id: s.id, user_id: me, role: 'owner', perms: [], attended: null, at: now() });
      if (p.notify_favorites) {
        const fav = db.favorites.filter((f) => f.user_id === me && db.workers[f.target_id]).map((f) => f.target_id);
        fav.forEach((w) => notify(w, 'new_shift_from_fav', `Новая смена от ${db.contractors[me].name}: «${s.title}»`, `#/w/shift/${s.id}`));
      }
      audit(me, 'shift.create', { id: s.id });
      return shiftView(s, me, null);
    });
  },
  myShifts(me) {
    actor(me);
    return db.shifts.filter((s) => s.contractor_id === me).sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start))
      .map((s) => ({ ...shiftView(s, me, null), pending_count: db.applications.filter((a) => a.shift_id === s.id && a.status === 'pending').length }));
  },
  contractorStats(me) {
    actor(me);
    const mine = db.shifts.filter((s) => s.contractor_id === me);
    const ids = new Set(mine.map((s) => s.id));
    return { active: mine.filter((s) => ['open', 'full'].includes(s.status)).length, new_applications: db.applications.filter((a) => ids.has(a.shift_id) && a.status === 'pending').length,
      workers: new Set(db.members.filter((m) => ids.has(m.shift_id) && m.role !== 'owner').map((m) => m.user_id)).size, done: mine.filter((s) => s.status === 'completed').length };
  },
  updateShift(me, sid, patch) {
    actor(me);
    const s = shiftOr404(sid);
    if (s.contractor_id !== me) fail('forbidden', 'Только владелец смены');
    if (!['open', 'full'].includes(s.status)) fail('closed', 'Смену уже нельзя изменить');
    const allowed = ['pay', 'people', 'start', 'end', 'requirements', 'description'];
    const changed = [];
    for (const k of allowed) {
      if (patch[k] === undefined) continue;
      let v = patch[k];
      if (k === 'pay' || k === 'people') { v = Math.round(Number(v)); if (!(v > 0)) fail('invalid', 'Некорректное значение'); }
      if (k === 'people' && v < acceptedCount(sid)) fail('invalid', `Уже принято ${acceptedCount(sid)} чел.`);
      if (JSON.stringify(s[k]) !== JSON.stringify(v)) { s[k] = v; if (k !== 'description') changed.push(k); }
    }
    if (s.status === 'full' && acceptedCount(sid) < s.people) s.status = 'open';
    if (s.status === 'open' && acceptedCount(sid) >= s.people) s.status = 'full';
    if (changed.length) db.applications.filter((a) => a.shift_id === sid && ['pending', 'accepted'].includes(a.status)).forEach((a) => notify(a.worker_id, 'shift_updated', `Условия смены обновлены: «${s.title}»`, `#/w/shift/${sid}`));
    audit(me, 'shift.update', { id: sid, changed });
    return shiftView(s, me, null);
  },
  cancelShift(me, sid) {
    actor(me);
    const s = shiftOr404(sid);
    if (s.contractor_id !== me) fail('forbidden');
    if (s.status === 'cancelled' || s.status === 'completed') return shiftView(s, me, null);
    s.status = 'cancelled';
    db.applications.filter((a) => a.shift_id === sid && ['pending', 'accepted'].includes(a.status)).forEach((a) => { a.status = 'cancelled'; a.updated_at = now(); notify(a.worker_id, 'shift_cancelled', `Смена отменена: «${s.title}»`, `#/w/mine`); });
    audit(me, 'shift.cancel', { id: sid });
    return shiftView(s, me, null);
  },
  completeShift(me, sid) {
    actor(me);
    const s = shiftOr404(sid);
    if (s.contractor_id !== me) fail('forbidden');
    if (!['open', 'full'].includes(s.status)) return shiftView(s, me, null);
    s.status = 'completed'; s.completed_at = now();
    db.applications.filter((a) => a.shift_id === sid && a.status === 'pending').forEach((a) => { a.status = 'rejected'; a.updated_at = now(); });
    db.applications.filter((a) => a.shift_id === sid && a.status === 'accepted').forEach((a) => { a.status = 'completed'; a.updated_at = now(); notify(a.worker_id, 'shift_completed', `Смена завершена: «${s.title}». Оцените подрядчика`, `#/review/${sid}`); });
    audit(me, 'shift.complete', { id: sid });
    return shiftView(s, me, null);
  },
  applicants(me, sid) {
    actor(me);
    const s = shiftOr404(sid);
    if (!canManage(s, me, 'applications')) fail('forbidden');
    return db.applications.filter((a) => a.shift_id === sid).sort((a, b) => b.created_at - a.created_at).map((a) => ({ ...a, worker: workerView(a.worker_id) }));
  },
  decide(me, appId, decision) {
    actor(me);
    const a = db.applications.find((x) => x.id === appId); if (!a) fail('not_found');
    const s = shiftOr404(a.shift_id);
    if (!canManage(s, me, 'applications')) fail('forbidden');
    if (!['accepted', 'rejected'].includes(decision)) fail('invalid');
    if (a.status === decision) return a; // идемпотентно
    if (a.status !== 'pending') fail('conflict', 'Заявка уже обработана');
    if (decision === 'accepted') {
      if (s.status !== 'open') fail('closed', 'Смена закрыта');
      if (acceptedCount(s.id) >= s.people) fail('full', 'Все места заняты');
      a.status = 'accepted';
      db.members.push({ shift_id: s.id, user_id: a.worker_id, role: 'worker', perms: [], attended: null, at: now() });
      if (acceptedCount(s.id) >= s.people) s.status = 'full';
      notify(a.worker_id, 'accepted', `Вас приняли: «${s.title}». Вы в команде смены`, `#/team/${s.id}`);
    } else { a.status = 'rejected'; notify(a.worker_id, 'rejected', `Отклик отклонён: «${s.title}»`, `#/w/mine`); }
    a.updated_at = now();
    audit(me, 'application.' + decision, { id: appId });
    return a;
  },

  // ----- команда и чат -----
  team(me, sid) {
    actor(me);
    const s = shiftOr404(sid);
    if (!db.members.some((m) => m.shift_id === sid && m.user_id === me)) fail('forbidden', 'Вы не в команде этой смены');
    const members = db.members.filter((m) => m.shift_id === sid).map((m) => ({ ...m, name: m.role === 'owner' ? (db.contractors[m.user_id] || {}).name : (db.workers[m.user_id] || {}).name, avatar: (db.workers[m.user_id] || db.contractors[m.user_id] || {}).avatar }));
    return { shift: shiftView(s, me, null), members, my_role: (members.find((m) => m.user_id === me) || {}).role, my_perms: (members.find((m) => m.user_id === me) || {}).perms, pinned: db.messages.find((x) => x.scope === 'shift:' + sid && x.pinned) || null };
  },
  myTeams(me) {
    actor(me);
    return db.members.filter((m) => m.user_id === me && m.role !== 'owner').map((m) => shiftView(shiftOr404(m.shift_id), me, null)).filter((s) => s.status !== 'cancelled');
  },
  setSenior(me, sid, userId, perms) {
    actor(me); const s = shiftOr404(sid);
    if (s.contractor_id !== me) fail('forbidden');
    const m = db.members.find((x) => x.shift_id === sid && x.user_id === userId && x.role !== 'owner'); if (!m) fail('not_found');
    const p = arr(perms).filter((x) => ['pin', 'attendance', 'remove', 'applications'].includes(x));
    if (p.length) { m.role = 'senior'; m.perms = p; } else { m.role = 'worker'; m.perms = []; }
    notify(userId, 'role', p.length ? `Вы назначены старшим смены «${s.title}»` : `Права старшего сняты: «${s.title}»`, `#/team/${sid}`);
    audit(me, 'member.senior', { sid, userId, p });
    return m;
  },
  removeMember(me, sid, userId) {
    actor(me); const s = shiftOr404(sid);
    if (!canManage(s, me, 'remove')) fail('forbidden');
    const m = db.members.find((x) => x.shift_id === sid && x.user_id === userId && x.role !== 'owner'); if (!m) fail('not_found');
    if (m.role === 'senior' && s.contractor_id !== me) fail('forbidden', 'Старшего может удалить только подрядчик');
    db.members = db.members.filter((x) => x !== m);
    const a = db.applications.find((x) => x.shift_id === sid && x.worker_id === userId && x.status === 'accepted'); if (a) { a.status = 'cancelled'; a.updated_at = now(); }
    if (s.status === 'full') s.status = 'open';
    notify(userId, 'removed', `Вас исключили из команды: «${s.title}»`, `#/w/mine`);
    audit(me, 'member.remove', { sid, userId });
    return true;
  },
  setAttendance(me, sid, userId, value) {
    actor(me); const s = shiftOr404(sid);
    if (!canManage(s, me, 'attendance')) fail('forbidden');
    const m = db.members.find((x) => x.shift_id === sid && x.user_id === userId && x.role !== 'owner'); if (!m) fail('not_found');
    m.attended = value; return m;
  },
  messages(me, scope, afterId = 0) {
    actor(me); assertChat(me, scope);
    return db.messages.filter((m) => m.scope === scope && m.id > afterId).map(msgView);
  },
  sendMessage(me, scope, text, reqId) {
    actor(me); assertChat(me, scope);
    text = String(text || '').trim();
    if (!text) fail('invalid'); if (text.length > 2000) fail('invalid', 'Слишком длинное сообщение');
    return withIdem(me, reqId, () => {
      const m = { id: id(), scope, user_id: me, text, at: now(), pinned: false };
      db.messages.push(m);
      recipients(scope).filter((r) => r !== me).forEach((r) => { if (!db.notifications.some((n) => n.user_id === r && n.type === 'message' && n.link === chatLink(scope) && !n.read)) notify(r, 'message', 'Новое сообщение в чате', chatLink(scope)); });
      return msgView(m);
    });
  },
  pinMessage(me, msgId, pinned) {
    actor(me); const m = db.messages.find((x) => x.id === msgId); if (!m || !m.scope.startsWith('shift:')) fail('not_found');
    const s = shiftOr404(Number(m.scope.split(':')[1]));
    if (!canManage(s, me, 'pin')) fail('forbidden');
    db.messages.filter((x) => x.scope === m.scope).forEach((x) => (x.pinned = false));
    m.pinned = !!pinned; return true;
  },
  dmInfo(me, appId) {
    actor(me); const a = db.applications.find((x) => x.id === appId); if (!a) fail('not_found'); assertChat(me, 'dm:' + appId);
    const s = shiftOr404(a.shift_id);
    return { application: a, shift: shiftView(s, me, null), worker: workerView(a.worker_id), can_manage: canManage(s, me, 'applications'), title: me === a.worker_id ? (db.contractors[s.contractor_id] || {}).name : (db.workers[a.worker_id] || {}).name };
  },
  myDialogs(me) {
    actor(me);
    const apps = db.applications.filter((a) => { const s = db.shifts.find((x) => x.id === a.shift_id); return a.worker_id === me || (s && s.contractor_id === me); });
    // диалог по отклику виден сразу (в ожидании / принят), даже до первого сообщения
    return apps.map((a) => { const last = [...db.messages].reverse().find((m) => m.scope === 'dm:' + a.id); return last || ['pending', 'accepted'].includes(a.status) ? { app_id: a.id, last: last ? msgView(last) : null, info: API.dmInfo(me, a.id) } : null; })
      .filter(Boolean).sort((x, y) => (y.last ? y.last.at : 0) - (x.last ? x.last.at : 0));
  },

  // ----- отзывы -----
  pendingReviews(me) {
    actor(me);
    const out = [];
    for (const s of db.shifts.filter((x) => x.status === 'completed')) {
      const mem = db.members.filter((m) => m.shift_id === s.id);
      if (!mem.some((m) => m.user_id === me)) continue;
      const targets = me === s.contractor_id ? mem.filter((m) => m.role !== 'owner').map((m) => m.user_id) : [s.contractor_id];
      targets.filter((t) => !db.reviews.some((r) => r.shift_id === s.id && r.from_user === me && r.to_user === t)).forEach((t) => out.push({ shift: shiftView(s, me, null), to_user: t, to_name: (db.workers[t] || db.contractors[t] || {}).name, to_role: t === s.contractor_id ? 'contractor' : 'worker', to_avatar: (db.workers[t] || db.contractors[t] || {}).avatar }));
    }
    return out;
  },
  submitReview(me, { shift_id, to_user, stars, criteria, text }) {
    actor(me); const s = shiftOr404(shift_id);
    if (s.status !== 'completed') fail('closed', 'Оценка доступна после завершения смены');
    const mem = db.members.filter((m) => m.shift_id === shift_id).map((m) => m.user_id);
    if (!mem.includes(me) || !mem.includes(to_user) || me === to_user) fail('forbidden');
    if (me !== s.contractor_id && to_user !== s.contractor_id) fail('forbidden', 'Исполнитель оценивает только подрядчика');
    if (!(stars >= 1 && stars <= 5)) fail('invalid', 'Поставьте оценку');
    if (db.reviews.some((r) => r.shift_id === shift_id && r.from_user === me && r.to_user === to_user)) return { duplicate: true };
    db.reviews.push({ id: id(), shift_id, from_user: me, to_user, stars: Math.round(stars), criteria: criteria || {}, text: String(text || '').slice(0, 1000), at: now() });
    notify(to_user, 'review', 'Вам поставили оценку', to_user === s.contractor_id ? '#/c/profile' : '#/w/profile');
    return { ok: true };
  },

  // ----- уведомления, жалобы, аналитика -----
  notifications(me) { actor(me); return db.notifications.filter((n) => n.user_id === me).sort((a, b) => b.at - a.at).slice(0, 100); },
  markRead(me) { db.notifications.filter((n) => n.user_id === me).forEach((n) => (n.read = true)); return true; },
  report(me, { target_type, target_id, reason }) {
    actor(me);
    if (!['worker', 'contractor', 'shift', 'message'].includes(target_type)) fail('invalid');
    if (String(reason || '').trim().length < 3) fail('invalid', 'Опишите причину');
    db.reports.push({ id: id(), reporter: me, target_type, target_id, reason: String(reason).slice(0, 1000), status: 'new', at: now() });
    return true;
  },
  track(me, event, props) { db.events.push({ id: id(), user_id: me, event, props: props || {}, at: now(), v: CONFIG.APP_VERSION }); if (db.events.length > 5000) db.events.splice(0, 1000); return true; },
  logError(me, err) { db.events.push({ id: id(), user_id: me, event: 'error', props: err, at: now(), v: CONFIG.APP_VERSION }); return true; },

  // ----- админка -----
  adminStats(me) {
    admin(me);
    const day = now() - 864e5;
    return { users: db.users.length, workers: Object.keys(db.workers).length, contractors: Object.keys(db.contractors).length, shifts: db.shifts.length, open_shifts: db.shifts.filter((s) => s.status === 'open').length,
      applications: db.applications.length, accepted: db.applications.filter((a) => ['accepted', 'completed'].includes(a.status)).length, completed_shifts: db.shifts.filter((s) => s.status === 'completed').length,
      reports_new: db.reports.filter((r) => r.status === 'new').length, active_24h: new Set(db.events.filter((e) => e.at > day).map((e) => e.user_id)).size, errors_24h: db.events.filter((e) => e.event === 'error' && e.at > day).length };
  },
  adminUsers(me) { admin(me); return db.users.map((u) => ({ ...u, name: (db.workers[u.id] || db.contractors[u.id] || {}).name || u.first_name })).reverse(); },
  adminBlock(me, userId, blocked) { admin(me); const u = db.users.find((x) => x.id === userId); if (!u) fail('not_found'); if (u.is_admin) fail('forbidden'); u.blocked = !!blocked; audit(me, 'user.block', { userId, blocked }); return u; },
  adminVerify(me, cid, v) { admin(me); if (!db.contractors[cid]) fail('not_found'); db.contractors[cid].verified = !!v; audit(me, 'contractor.verify', { cid, v }); return true; },
  adminShifts(me) { admin(me); return db.shifts.map((s) => shiftView(s, null, null)).reverse(); },
  adminHideShift(me, sid, hidden) { admin(me); const s = shiftOr404(sid); s.hidden = !!hidden; audit(me, 'shift.hide', { sid, hidden }); return true; },
  adminReports(me) { admin(me); return db.reports.map((r) => ({ ...r, reporter_name: (db.workers[r.reporter] || db.contractors[r.reporter] || {}).name })).reverse(); },
  adminResolveReport(me, rid, status) { admin(me); const r = db.reports.find((x) => x.id === rid); if (!r) fail('not_found'); r.status = status; audit(me, 'report.' + status, { rid }); return r; },
  adminCategories(me) { admin(me); return db.categories; },
  adminSaveCategory(me, { id: cid, name, active }) {
    admin(me); name = String(name || '').trim(); if (!name) fail('invalid');
    if (cid) { const c = db.categories.find((x) => x.id === cid); if (!c) fail('not_found'); c.name = name; c.active = active !== false; }
    else db.categories.push({ id: id(), name, active: true });
    return true;
  },
  adminAudit(me) { admin(me); return [...db.audit].reverse().slice(0, 100); },
};

function admin(me) { const u = actor(me); if (!u.is_admin) fail('forbidden', 'Нет доступа'); }
function assertChat(me, scope) {
  if (scope.startsWith('shift:')) { if (!db.members.some((m) => m.shift_id === Number(scope.slice(6)) && m.user_id === me)) fail('forbidden', 'Вы не в команде смены'); return; }
  if (scope.startsWith('dm:')) {
    const a = db.applications.find((x) => x.id === Number(scope.slice(3))); if (!a) fail('not_found');
    const s = db.shifts.find((x) => x.id === a.shift_id);
    if (me !== a.worker_id && me !== s.contractor_id) fail('forbidden'); return;
  }
  fail('invalid');
}
function recipients(scope) {
  if (scope.startsWith('shift:')) return db.members.filter((m) => m.shift_id === Number(scope.slice(6))).map((m) => m.user_id);
  const a = db.applications.find((x) => x.id === Number(scope.slice(3))); const s = db.shifts.find((x) => x.id === a.shift_id); return [a.worker_id, s.contractor_id];
}
function chatLink(scope) { return scope.startsWith('shift:') ? '#/team/' + scope.slice(6) : '#/chat/' + scope.slice(3); }
function msgView(m) {
  let role = 'worker', name = (db.workers[m.user_id] || {}).name;
  if (m.scope.startsWith('shift:')) {
    const mem = db.members.find((x) => x.shift_id === Number(m.scope.slice(6)) && x.user_id === m.user_id);
    role = mem ? mem.role : 'worker';
  } else { const a = db.applications.find((x) => x.id === Number(m.scope.slice(3))); const s = db.shifts.find((x) => x.id === a.shift_id); role = m.user_id === s.contractor_id ? 'owner' : 'worker'; }
  if (role === 'owner') name = (db.contractors[m.user_id] || {}).name;
  return { ...m, name: name || 'Пользователь', role };
}

// Вызов API. me — id текущего пользователя (в проде определяется сервером по JWT).
export async function localCall(fn, me, args) {
  reload();
  if (!API[fn]) fail('not_found', 'Неизвестный метод ' + fn);
  const r = fn === 'login' ? API.login(...args) : API[fn](me, ...args);
  save();
  return JSON.parse(JSON.stringify(r ?? null));
}
export const localReset = () => localStorage.removeItem(KEY);
export const localVersion = () => localStorage.getItem(KEY) || '';
export const localUsers = () => { reload(); return db.users.map((u) => ({ tg_id: u.tg_id, name: (db.workers[u.id] || db.contractors[u.id] || {}).name || u.first_name, is_admin: u.is_admin })); };
