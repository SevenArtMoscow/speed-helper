// Экраны подрядчика
import { api, track } from './api.js';
import { S, go, toast, errMsg, sheet, confirmBox, avatar, stars, pageHead, emptyState, verifiedTag, statusTag, pickLocation, toggle, refreshMe } from './ui.js';
import { esc, dateLabel, money, todayISO, addDays, uid, plural } from './util.js';
import { reportSheet, finishShift, shiftName } from './screens-common.js';
import { profileBlock, roleSwitch, devPanel, bindCommonProfile } from './screens-worker.js';

const need = () => !S.user.roles.includes('contractor');
const BASE_TAGS = ['18+', 'Опыт склада', 'Права категории B', 'Медкнижка', 'Самозанятость'];

const shiftRow = (s, extra = '') => `<div class="card click" data-act="open" data-id="${s.id}"><div class="row sp"><b>${esc(s.title)}</b>${statusTag(s.status)}</div>
  <div class="mut sm">${esc(dateLabel(s.date))} · ${esc(s.start)}–${esc(s.end)} · ${money(s.pay)}</div><div class="row sp sm" style="margin-top:6px"><span>👥 ${s.accepted_count} / ${s.people}</span>${s.pending_count ? `<span class="tag g">${s.pending_count} новых откликов</span>` : ''}</div>${extra}</div>`;

async function home(ctx) {
  if (need()) return go('#/c/onboard');
  const load = async () => {
    const [st, list] = await Promise.all([api.contractorStats(), api.myShifts()]);
    const act = list.filter((s) => ['open', 'full'].includes(s.status)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const html = `<h1>Главная</h1><div class="grid2" style="margin:10px 0"><div class="stat"><b>${st.active}</b>Активные смены</div><div class="stat"><b>${st.new_applications}</b>Новые отклики</div><div class="stat"><b>${st.workers}</b>Исполнители</div><div class="stat"><b>${st.done}</b>Завершённые</div></div>
      <button class="btn pri block" data-act="create" style="padding:15px">＋ Создать смену</button>
      <h2>Ближайшие смены</h2>${act.length ? act.slice(0, 20).map((s) => shiftRow(s)).join('') : `<div class="empty"><h2>У вас пока нет открытых смен.</h2></div>`}`;
    if (ctx.main.dataset.h !== html) { ctx.main.innerHTML = html; ctx.main.dataset.h = html; }
  };
  ctx.main.dataset.h = ''; await load(); ctx.poll = load;
  ctx.acts.create = () => go('#/c/create'); ctx.acts.open = (el) => go('#/c/shift/' + el.dataset.id);
}

async function shifts(ctx) {
  if (need()) return go('#/c/onboard');
  let tab = 'act';
  const T = [['act', 'Активные', ['open', 'full']], ['done', 'Завершённые', ['completed']], ['off', 'Отменённые', ['cancelled']]];
  let list = [];
  const draw = () => {
    const cur = T.find((t) => t[0] === tab), l = list.filter((s) => cur[2].includes(s.status));
    const html = `<div class="row sp"><h1>Смены</h1><button class="btn pri sm" data-act="create">＋ Создать</button></div><div class="tabsx">${T.map(([k, t, st]) => `<span class="chip ${tab === k ? 'on' : ''}" data-act="tab" data-t="${k}">${t} · ${list.filter((s) => st.includes(s.status)).length}</span>`).join('')}</div>${l.length ? l.map((s) => shiftRow(s)).join('') : emptyState(tab === 'act' ? 'У вас пока нет открытых смен.' : 'Здесь пока пусто', '', tab === 'act' ? '<button class="btn pri" data-act="create">Создать смену</button>' : '')}`;
    if (ctx.main.dataset.h !== html) { ctx.main.innerHTML = html; ctx.main.dataset.h = html; }
  };
  const load = async () => { list = await api.myShifts(); draw(); };
  ctx.main.dataset.h = ''; await load(); ctx.poll = load;
  ctx.acts.tab = (el) => { tab = el.dataset.t; draw(); }; ctx.acts.create = () => go('#/c/create'); ctx.acts.open = (el) => go('#/c/shift/' + el.dataset.id);
}

// ---------- создание ----------
// Прототип «ИИ-помощника»: разбор обычной фразы правилами. Точка расширения — api.aiParseShift (LLM на сервере).
export function parseShiftText(text) {
  const t = text.toLowerCase(), out = {};
  const words = { один: 1, одного: 1, два: 2, двух: 2, три: 3, трёх: 3, трех: 3, четыре: 4, четырёх: 4, четырех: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, десять: 10 };
  let m = t.match(/(\d+)\s*(?:чел|человек|грузч|рабоч|работник)/); if (m) out.people = +m[1];
  if (!out.people) for (const [w, n] of Object.entries(words)) if (new RegExp('\\b' + w + '\\b').test(t)) { out.people = n; break; }
  m = t.match(/с\s*(\d{1,2})(?::(\d{2}))?\s*(?:до|по|-)\s*(\d{1,2})(?::(\d{2}))?/); if (m) { out.start = `${m[1].padStart(2, '0')}:${m[2] || '00'}`; out.end = `${m[3].padStart(2, '0')}:${m[4] || '00'}`; }
  m = t.match(/(?:оплата|платим|за смену|по)\s*(\d[\d\s]{2,6})\s*(?:₽|р|руб|тыс)?/) || t.match(/(\d[\d\s]{2,6})\s*(?:₽|руб)/); if (m) out.pay = +m[1].replace(/\s/g, '');
  if (/послезавтра/.test(t)) out.date = addDays(todayISO(), 2); else if (/завтра/.test(t)) out.date = addDays(todayISO(), 1); else if (/сегодня/.test(t)) out.date = todayISO();
  m = t.match(/\bв\s+([а-яё-]+(?:ах|ях|ове|еве|ино|ово|ке|ве|ске|ом)?)/);
  const cats = [['груз', 'Грузчики'], ['разгруз', 'Погрузка / разгрузка'], ['склад', 'Склад / комплектация'], ['убор', 'Уборка'], ['курьер', 'Курьеры'], ['промоут', 'Промоутеры'], ['официант', 'Официанты / кухня'], ['монтаж', 'Монтаж / стройка']];
  for (const [k, n] of cats) if (t.includes(k)) { const c = S.cats.find((x) => x.name === n); if (c) { out.category_id = c.id; break; } }
  out.title = text.split(/[.,]/)[0].trim().slice(0, 60); out.description = text.trim();
  return out;
}

async function createOrEdit(ctx, id) {
  const editing = !!id; id = Number(id);
  if (need()) return go('#/c/onboard');
  const old = editing ? await api.getShift(id) : null;
  if (old && old.contractor_id !== S.user.id) return go('#/c/home');
  const reqs = new Set(old ? old.requirements : []); const custom = (old ? old.requirements : []).filter((r) => !BASE_TAGS.includes(r));
  let geo = old && old.lat != null ? { lat: old.lat, lng: old.lng } : null;
  const reqId = uid(); // ключ идемпотентности: двойное нажатие «Создать» не создаст две смены
  const d = old || {};
  const lock = editing ? 'disabled' : '';
  ctx.render(`${pageHead(editing ? 'Изменить смену' : 'Новая смена')}${editing ? '<p class="mut sm">Можно менять оплату, количество людей, время, требования и описание. Для другого места или вида работ создайте новую смену.</p>' : '<button class="btn block ghost" data-act="ai">✨ Заполнить с ИИ-ассистентом</button>'}
    <label class="f">Название смены *</label><input class="i" id="title" value="${esc(d.title || '')}" placeholder="Например: Разгрузка мебели" ${lock}>
    <label class="f">Категория *</label><select class="i" id="cat" ${lock}><option value="">Выберите…</option>${S.cats.map((c) => `<option value="${c.id}" ${d.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <label class="f">Описание</label><textarea class="i" id="desc" placeholder="Что нужно делать">${esc(d.description || '')}</textarea>
    <label class="f">Адрес *</label><div class="row gap"><input class="i" id="addr" value="${esc(d.address || '')}" placeholder="Город, улица, дом" ${lock}>${editing ? '' : '<button class="btn" data-act="pin" aria-label="На карте">📍</button>'}</div><div class="sm ${geo ? 'g' : 'mut'}" id="geo">${geo ? '✓ Точка на карте указана' : 'Нажмите 📍, чтобы найти адрес на карте и поставить точку'}</div>
    <div class="grid2"><div><label class="f">Дата *</label><input class="i" id="date" type="date" min="${todayISO()}" value="${esc(d.date || addDays(todayISO(), 1))}" ${lock}></div><div><label class="f">Людей *</label><input class="i" id="people" type="number" inputmode="numeric" min="1" value="${esc(d.people || '')}"></div></div>
    <div class="grid2"><div><label class="f">Начало *</label><input class="i" id="start" type="time" value="${esc(d.start || '09:00')}"></div><div><label class="f">Окончание *</label><input class="i" id="end" type="time" value="${esc(d.end || '18:00')}"></div></div>
    <label class="f">Оплата за смену, ₽ *</label><input class="i" id="pay" type="number" inputmode="numeric" min="1" value="${esc(d.pay || '')}">
    <label class="f">Требования</label><div class="row wrap gap" id="reqs"></div>
    ${editing ? '' : `<div class="row sp" style="margin:14px 0"><span>Уведомить работников из избранного<div class="mut sm">Это не приглашение и не подтверждение</div></span>${toggle(false, 'tg', 'id="nf"')}</div>`}
    <button class="btn pri block" data-act="save" style="margin-top:14px">${editing ? 'Сохранить' : 'Опубликовать смену'}</button>`);
  const drawReqs = () => { document.getElementById('reqs').innerHTML = [...BASE_TAGS, ...custom].map((r) => `<span class="chip ${reqs.has(r) ? 'on' : ''}" data-act="req" data-r="${esc(r)}">${esc(r)}</span>`).join('') + '<span class="chip" data-act="addreq">＋ Своё</span>'; };
  drawReqs();
  const val = (i) => document.getElementById(i).value;
  ctx.acts.req = (el) => { const r = el.dataset.r; reqs.has(r) ? reqs.delete(r) : reqs.add(r); drawReqs(); }; // повторное нажатие отключает тег
  ctx.acts.tg = (el) => el.classList.toggle('on');
  ctx.acts.addreq = () => { const s = sheet('<h3>Своё требование</h3><input class="i" id="nr" maxlength="40"><button class="btn pri block" style="margin-top:12px" id="ok">Добавить</button>'); s.el.querySelector('#ok').onclick = () => { const t = s.el.querySelector('#nr').value.trim(); if (t) { custom.push(t); reqs.add(t); drawReqs(); } s.close(); }; };
  ctx.acts.pin = async () => { const r = await pickLocation({ ...(geo || {}), query: val('addr') }); if (r) { geo = { lat: r.lat, lng: r.lng }; if (r.address && !val('addr')) document.getElementById('addr').value = r.address; document.getElementById('geo').className = 'sm g'; document.getElementById('geo').textContent = '✓ Точка на карте указана'; } };
  ctx.acts.ai = () => {
    const s = sheet('<h3>ИИ-ассистент</h3><p class="mut sm">Опишите смену обычными словами — мы предложим заполнение полей, а вы проверите.</p><textarea class="i" id="t" placeholder="Завтра нужны четыре человека разгружать мебель в Химках с 9 до 18, оплата 4500"></textarea><button class="btn pri block" style="margin-top:12px" id="ok">Заполнить</button>');
    s.el.querySelector('#ok').onclick = () => {
      const r = parseShiftText(s.el.querySelector('#t').value); s.close();
      const set = (i, v) => v != null && (document.getElementById(i).value = v);
      set('title', r.title); set('desc', r.description); set('people', r.people); set('start', r.start); set('end', r.end); set('pay', r.pay); set('date', r.date); set('cat', r.category_id);
      toast('Проверьте поля и укажите адрес на карте');
    };
  };
  ctx.acts.save = async () => {
    if (editing) {
      await api.updateShift(id, { pay: val('pay'), people: val('people'), start: val('start'), end: val('end'), description: val('desc').trim(), requirements: [...reqs] });
      toast('Смена обновлена', 'ok'); return go('#/c/shift/' + id);
    }
    if (!geo) return toast('Укажите точку на карте (📍) — исполнители ищут смены по расстоянию', 'err');
    const s = await api.createShift({ title: val('title'), category_id: val('cat'), description: val('desc').trim(), address: val('addr'), lat: geo.lat, lng: geo.lng, date: val('date'), start: val('start'), end: val('end'), pay: val('pay'), people: val('people'), requirements: [...reqs], notify_favorites: document.getElementById('nf').classList.contains('on') }, reqId);
    track('shift_created', { id: s.id }); toast('Смена опубликована', 'ok'); go('#/c/shift/' + s.id);
  };
}

// ---------- страница смены подрядчика ----------
async function shiftPage(ctx, id) {
  id = Number(id);
  const load = async () => {
    const [s, apps] = await Promise.all([api.getShift(id), api.applicants(id)]);
    const active = ['open', 'full'].includes(s.status);
    const groups = [['pending', 'Новые отклики'], ['accepted', 'Приняты'], ['completed', 'Участвовали'], ['rejected', 'Отклонены'], ['cancelled', 'Отказались']];
    const html = `${pageHead('Смена')}<div class="card"><div class="row sp"><h2 style="margin:0">${esc(s.title)}</h2>${statusTag(s.status)}</div><div class="mut sm" style="margin:6px 0">${esc(dateLabel(s.date))} · ${esc(s.start)}–${esc(s.end)} · ${money(s.pay)}<br>${esc(s.address)}</div>
      <div class="row sp sm"><span>👥 ${s.accepted_count} / ${s.people}</span></div><div class="bar" style="margin:6px 0"><i style="width:${Math.min(100, (s.accepted_count / s.people) * 100)}%"></i></div>
      ${s.description ? `<p class="mut sm">${esc(s.description)}</p>` : ''}${(s.requirements || []).map((r) => `<span class="tag">${esc(r)}</span> `).join('')}
      ${active ? '<div class="row gap wrap" style="margin-top:12px"><button class="btn sm" data-act="edit">Изменить</button><button class="btn sm" data-act="team">Команда и чат</button><button class="btn sm pri" data-act="fin">Смена завершена</button><button class="btn sm danger" data-act="cancel">Отменить</button></div>' : (s.status === 'completed' ? '<div class="row gap" style="margin-top:12px"><button class="btn sm" data-act="team">Команда</button><button class="btn sm pri" data-act="rate">Оценить исполнителей</button></div>' : '')}</div>
      <h2>Отклики · ${apps.length}</h2>${apps.length ? groups.map(([st, t]) => { const l = apps.filter((a) => a.status === st); return l.length ? `<div class="mut sm" style="margin:12px 0 4px">${t} · ${l.length}</div>` + l.map((a) => cand(a, active)).join('') : ''; }).join('') : '<p class="mut">Пока никто не откликнулся.</p>'}`;
    if (ctx.main.dataset.h !== html && !document.querySelector('.ov')) { ctx.main.innerHTML = html; ctx.main.dataset.h = html; }
    ctx.shiftData = { s, apps };
  };
  const cand = (a, active) => { const w = a.worker || {}; return `<div class="card"><div class="row click" data-act="prof" data-id="${a.worker_id}">${avatar(w.avatar, w.name)}<div class="grow"><b>${esc(w.name)}</b> ${verifiedTag(w.verified, 'Проверен')}<div class="sm">${stars(w.rating, w.reviews)} · ${w.shifts_done} смен</div>${(w.skills || []).length ? `<div class="mut sm">${esc(w.skills.slice(0, 4).join(', '))}</div>` : ''}</div>${statusTag(a.status)}</div>
    <div class="row gap" style="margin-top:10px"><button class="btn sm grow" data-act="dm" data-app="${a.id}">Написать</button>${a.status === 'pending' && active ? `<button class="btn sm danger" data-act="dec" data-app="${a.id}" data-d="rejected" data-n="${esc(w.name)}">Отклонить</button><button class="btn sm pri" data-act="dec" data-app="${a.id}" data-d="accepted" data-n="${esc(w.name)}">Принять</button>` : ''}</div></div>`; };
  ctx.main.dataset.h = ''; await load(); ctx.poll = load;
  ctx.acts.edit = () => go('#/c/edit/' + id);
  ctx.acts.team = () => go('#/team/' + id);
  ctx.acts.rate = () => go('#/review/' + id);
  ctx.acts.prof = (el) => go('#/c/worker/' + el.dataset.id);
  ctx.acts.dm = (el) => go('#/chat/' + el.dataset.app);
  ctx.acts.dec = async (el) => {
    const ok = el.dataset.d === 'accepted';
    if (!(await confirmBox(ok ? `Принять ${el.dataset.n}?` : `Отклонить ${el.dataset.n}?`, { ok: ok ? 'Принять' : 'Отклонить', danger: !ok }))) return;
    await api.decide(Number(el.dataset.app), el.dataset.d); track(ok ? 'application_accepted' : 'application_rejected'); toast(ok ? 'Исполнитель принят и добавлен в команду' : 'Отклик отклонён', 'ok'); await load();
  };
  ctx.acts.fin = () => finishShift(id);
  ctx.acts.cancel = async () => {
    const { s, apps } = ctx.shiftData; const pend = apps.filter((a) => a.status === 'pending').length, acc = apps.filter((a) => a.status === 'accepted').length;
    const sub = acc || pend ? `Есть ${acc ? `принятые исполнители (${acc})` : ''}${acc && pend ? ' и ' : ''}${pend ? `неразобранные отклики (${pend})` : ''}. Все они получат уведомление об отмене.` : '';
    if (!(await confirmBox('Вы уверены, что хотите отменить смену?', { ok: 'Отменить смену', cancel: 'Назад', danger: true, sub }))) return;
    await api.cancelShift(id); toast('Смена отменена', 'ok'); go('#/c/shifts');
  };
  track('applicants_opened', { id });
}

async function workerPage(ctx, wid) {
  wid = Number(wid);
  const P = await api.workerPage(wid), w = P.worker;
  ctx.render(`${pageHead('Кандидат', '<button class="iconbtn" data-act="rep">⚑</button>')}${profileBlock(w)}
    <button class="btn block ${P.is_fav ? '' : 'pri'}" data-act="fav">${P.is_fav ? '★ В избранном' : '☆ В избранное'}</button>
    ${P.reviews.length ? `<h2>Отзывы</h2>${P.reviews.map((r) => `<div class="card"><div class="star">${'★'.repeat(r.stars)}</div>${r.text ? `<div>${esc(r.text)}</div>` : ''}<div class="mut sm">${esc(r.from_name || '')}</div></div>`).join('')}` : ''}`);
  ctx.acts.fav = async () => { await api.toggleFav(wid); workerPage(ctx, wid); };
  ctx.acts.rep = () => reportSheet('worker', wid);
}

async function fav(ctx) {
  const list = await api.favorites('worker');
  ctx.render(`<h1>Избранное</h1><p class="mut sm">Исполнители, с которыми вы хотите работать снова</p>${list.length ? list.map((w) => `<div class="card click row" data-act="p" data-id="${w.user_id}">${avatar(w.avatar, w.name)}<div class="grow"><b>${esc(w.name)}</b> ${verifiedTag(w.verified, 'Проверен')}<div class="sm">${stars(w.rating, w.reviews)} · ${w.shifts_done} смен</div></div>›</div>`).join('') : emptyState('Пока пусто', 'Добавляйте исполнителей в избранное в их профиле.')}`);
  ctx.acts.p = (el) => go('#/c/worker/' + el.dataset.id);
}

async function profile(ctx) {
  const u = await refreshMe(), c = u.contractor;
  ctx.render(`<h1>Профиль</h1><div class="card row">${avatar(c.avatar, c.name, 'lg')}<div class="grow"><h1 style="margin:0">${esc(c.name)}</h1>${c.company ? `<div class="mut">${esc(c.company)}</div>` : ''}<div>${stars(c.rating, c.reviews)}</div><div class="mut sm">${c.shifts_done} проведённых смен · ${esc(c.city)}</div>${verifiedTag(c.verified, 'Проверенный подрядчик')}</div></div>
    ${c.about ? `<p>${esc(c.about)}</p>` : ''}<div class="card row sp"><span class="mut">Телефон</span><span>+7 ${esc(c.phone)}</span></div>
    <button class="btn block" data-act="edit">Редактировать профиль</button><div style="height:8px"></div>${roleSwitch()}${devPanel(u)}`);
  bindCommonProfile(ctx, u); ctx.acts.edit = () => go('#/c/edit-profile');
}

export const contractorRoutes = [
  [/^#\/c\/home$/, home], [/^#\/c\/shifts$/, shifts], [/^#\/c\/create$/, createOrEdit], [/^#\/c\/edit\/(\d+)$/, createOrEdit], [/^#\/c\/shift\/(\d+)$/, shiftPage],
  [/^#\/c\/worker\/(\d+)$/, workerPage], [/^#\/c\/fav$/, fav], [/^#\/c\/profile$/, profile],
];
