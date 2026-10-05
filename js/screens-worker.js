// Экраны исполнителя
import { api, track, MODE, devUsers, setDevUser, tg } from './api.js';
import { CONFIG } from './config.js';
import { localReset } from './local-backend.js';
import { S, go, toast, errMsg, sheet, confirmBox, avatar, stars, pageHead, emptyState, verifiedTag, statusTag, setRole, refreshMe } from './ui.js';
import { createMap, placemark, radiusCircle, shiftsLayer, pickLocation, routeLink } from './maps.js';
import { esc, dateLabel, money, kmLabel, plural, phone10, fmtPhone } from './util.js';
import { reportSheet, shiftName } from './screens-common.js';

const FKEY = 'sh_filters_v1';
const defFilters = () => ({ date: 'any', min_pay: 0, radius_km: 30, geo: 'msk', lat: CONFIG.DEFAULT_CITY.lat, lng: CONFIG.DEFAULT_CITY.lng, categories: [] });
const loadF = () => { try { return { ...defFilters(), ...JSON.parse(localStorage.getItem(FKEY)) }; } catch { return defFilters(); } };
const saveF = (f) => localStorage.setItem(FKEY, JSON.stringify(f));
const needProfile = () => !S.user.roles.includes('worker');

export const shiftCardBody = (s) => `<div class="row sp"><span class="tag g">${esc(s.category_name || '')}</span>${s.distance_km != null ? `<span class="mut sm">📍 ${kmLabel(s.distance_km)}</span>` : ''}</div>
  <h1 style="margin:10px 0 2px">${esc(s.title)}</h1>
  <div class="row gap wrap sm"><span>${esc(s.contractor?.company || s.contractor?.name || '')}</span>${verifiedTag(s.contractor?.verified, 'Проверенный подрядчик')}<span>${stars(s.contractor?.rating, s.contractor?.reviews)}</span></div>
  <div class="pay" style="margin:12px 0 8px">${money(s.pay)}</div>
  <div class="sm" style="line-height:1.7">🗓 ${esc(dateLabel(s.date))} · ${esc(s.start)}–${esc(s.end)}<br>📍 ${esc(s.address)}<br>👥 Нужно ${s.people} ${plural(s.people, 'человек', 'человека', 'человек')} · осталось мест: ${Math.max(0, s.people - s.accepted_count)}</div>
  ${s.description ? `<p class="mut" style="margin:10px 0 6px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(s.description)}</p>` : ''}
  ${(s.requirements || []).length ? `<div class="row wrap gap" style="margin-top:6px">${s.requirements.map((r) => `<span class="tag">${esc(r)}</span>`).join('')}</div>` : ''}`;

// ---------- поиск: свайпы / список / карта ----------
async function search(ctx) {
  if (needProfile()) return go('#/w/onboard');
  const F = loadF();
  let mode = sessionStorage.getItem('sh_mode') || 'swipe';
  let queue = [], next = 0, total = 0, hist = null, loading = false, busy = false, map = null;

  const fetchMore = async (reset) => {
    if (loading) return; loading = true;
    try {
      if (reset) { queue = []; next = 0; }
      if (next === null) return;
      const r = await api.feed({ ...F, offset: next, limit: mode === 'map' ? 200 : 20 });
      const have = new Set(queue.map((x) => x.id)); queue.push(...r.items.filter((x) => !have.has(x.id))); next = r.next; total = r.total;
    } finally { loading = false; }
  };
  const summary = () => {
    const d = { any: 'Все даты', today: 'Сегодня', tomorrow: 'Завтра', weekend: 'Выходные' }[F.date];
    return `${d} · от ${F.min_pay} ₽ · ${F.radius_km} км`;
  };
  const frame = () => `<div class="row sp" style="margin:2px 0 6px"><div class="tabsx" style="margin:0">${[['swipe', 'Карточки'], ['list', 'Список'], ['map', 'Карта']].map(([k, t]) => `<span class="chip ${mode === k ? 'on' : ''}" data-act="mode" data-m="${k}">${t}</span>`).join('')}</div><button class="btn sm" data-act="filters">⚙ Фильтры</button></div><div class="mut sm" style="margin-bottom:4px">${summary()}</div><div id="body"></div>`;

  const empty = () => `<div class="empty"><h2>Пока новых смен нет.</h2><p>Попробуйте расширить поиск.</p>
    <div class="row wrap gap" style="justify-content:center"><button class="btn pri" data-act="similar">Показать похожие смены</button><button class="btn" data-act="filters">Изменить фильтры</button><button class="btn" data-act="refresh">Обновить поиск</button>${hist ? '<button class="btn" data-act="undo">↺ Вернуть последнюю</button>' : ''}</div></div>`;

  const draw = () => {
    const body = document.getElementById('body'); if (!body) return;
    if (map) { map.remove(); map = null; }
    if (mode === 'swipe') return drawDeck(body);
    if (!queue.length) { body.innerHTML = empty(); return; }
    if (mode === 'list') { body.innerHTML = queue.map((s) => `<div class="card click" data-act="open" data-id="${s.id}">${shiftCardBody(s)}</div>`).join('') + (next !== null ? '<button class="btn block" data-act="more">Показать ещё</button>' : ''); return; }
    body.innerHTML = '<div id="map" style="height:62vh;border-radius:18px;overflow:hidden"></div>';
    drawMap(document.getElementById('map')).catch((e) => { const el = document.getElementById('map'); if (el) el.outerHTML = `<p class="mut">${esc(e.message)}</p>`; });
  };

  async function drawMap(el) {
    const m = await createMap(el, { center: [F.lat, F.lng], zoom: F.radius_km > 60 ? 7 : F.radius_km > 20 ? 9 : 10.5 });
    if (!m) return; if (map) map.remove(); map = m;
    radiusCircle(map, F.lat, F.lng, F.radius_km);
    shiftsLayer(map, queue, (id) => {
      const s = queue.find((x) => x.id === id); if (!s) return;
      const sh = sheet(`<div class="row sp"><span class="pay g" style="font-size:24px;font-weight:900">${money(s.pay)}</span><span class="mut sm">${kmLabel(s.distance_km)}</span></div><h3>${esc(s.title)}</h3><p class="mut sm">${esc(dateLabel(s.date))} · ${esc(s.start)}–${esc(s.end)}<br>${esc(s.address)}</p><button class="btn pri block" data-o>Открыть</button>`);
      sh.el.querySelector('[data-o]').onclick = () => { sh.close(); go('#/w/shift/' + s.id); };
    });
  }

  function drawDeck(body) {
    if (!queue.length) { body.innerHTML = empty(); return; }
    body.innerHTML = `<div class="deck" id="deck"></div><div class="actions"><button class="rb undo" data-act="undo" ${hist ? '' : 'disabled'} aria-label="Вернуть">↺</button><button class="rb no" data-act="skip" aria-label="Пропустить">✕</button><button class="rb ok" data-act="like" aria-label="Откликнуться">✓</button></div><p class="mut sm" style="text-align:center;margin:0">Вправо — откликнуться · влево — пропустить</p>`;
    const deck = document.getElementById('deck');
    [queue[1], queue[0]].forEach((s, i) => { if (!s) return; const c = document.createElement('div'); c.className = 'sc' + (i === 0 ? ' behind' : ''); c.dataset.id = s.id; c.innerHTML = `<span class="stamp ok">ОТКЛИК</span><span class="stamp no">ПРОПУСК</span><div class="body">${shiftCardBody(s)}</div><button class="btn ghost sm" data-act="open" data-id="${s.id}" style="margin-top:8px">Подробнее</button>`; deck.appendChild(c); });
    bindDrag(deck.lastElementChild);
  }

  function bindDrag(card) {
    if (!card) return;
    let sx = 0, sy = 0, dx = 0, drag = false, moved = false;
    const ok = card.querySelector('.stamp.ok'), no = card.querySelector('.stamp.no');
    card.onpointerdown = (e) => { if (e.target.closest('button')) return; drag = true; moved = false; sx = e.clientX; sy = e.clientY; card.setPointerCapture(e.pointerId); card.style.transition = 'none'; };
    card.onpointermove = (e) => {
      if (!drag) return; dx = e.clientX - sx; if (Math.abs(dx) > 6) moved = true;
      card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
      ok.style.opacity = Math.max(0, Math.min(1, dx / 90)); no.style.opacity = Math.max(0, Math.min(1, -dx / 90));
    };
    const end = () => {
      if (!drag) return; drag = false;
      if (Math.abs(dx) > 100) return decide(dx > 0 ? 'like' : 'skip');
      card.style.transition = 'transform .25s'; card.style.transform = ''; ok.style.opacity = no.style.opacity = 0; dx = 0;
    };
    card.onpointerup = end; card.onpointercancel = end;
  }

  // Кнопки и свайпы запускают одну и ту же логику
  async function decide(kind) {
    if (busy || !queue.length) return; busy = true;
    const s = queue[0]; const card = document.querySelector('#deck .sc:last-child');
    if (card) { card.style.transition = 'transform .28s ease-out,opacity .28s'; card.style.transform = `translateX(${kind === 'like' ? 130 : -130}vw) rotate(${kind === 'like' ? 24 : -24}deg)`; card.style.opacity = 0; }
    queue.shift();
    try {
      if (kind === 'like') { const r = await api.apply(s.id); hist = { kind, s, dup: !!r.duplicate }; toast(r.duplicate ? 'Вы уже откликались' : 'Отклик отправлен', 'ok'); track('swipe_right', { id: s.id }); track('application_sent', { id: s.id }); }
      else { await api.skip(s.id); hist = { kind, s }; track('swipe_left', { id: s.id }); }
    } catch (e) {
      queue.unshift(s); toast(errMsg(e), 'err');
      if (e.code === 'closed') queue.shift();
    }
    setTimeout(() => { busy = false; if (queue.length < 5 && next !== null) fetchMore().then(draw); draw(); }, 240);
  }

  ctx.render(frame());
  document.getElementById('body').innerHTML = '<div class="skel" style="height:50vh"></div>';
  await fetchMore(true); draw();

  ctx.acts.like = () => decide('like'); ctx.acts.skip = () => decide('skip');
  ctx.acts.undo = async () => {
    if (!hist || busy) return;
    try {
      if (hist.kind === 'like') { if (!(await api.undoApply(hist.s.id))) { hist = null; draw(); return toast('Отклик уже обработан — вернуть нельзя', 'err'); } }
      else await api.unskip(hist.s.id);
      queue.unshift(hist.s); hist = null; draw();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  ctx.acts.open = (el) => go('#/w/shift/' + el.dataset.id);
  ctx.acts.more = async () => { await fetchMore(); draw(); };
  ctx.acts.refresh = async () => { hist = null; await fetchMore(true); draw(); };
  ctx.acts.similar = async () => {
    const base = hist && hist.s; if (!base) { F.radius_km = Math.max(F.radius_km, 100); F.date = 'any'; F.min_pay = 0; saveF(F); toast('Расширили поиск'); await fetchMore(true); return draw(); }
    const r = await api.feed({ ...F, date: 'any', min_pay: 0, radius_km: 150, similar_to: base.id, include_skipped: true }); queue = r.items; next = r.next; draw();
    if (!queue.length) toast('Похожих смен нет');
  };
  ctx.acts.mode = async (el) => { mode = el.dataset.m; sessionStorage.setItem('sh_mode', mode); document.querySelectorAll('[data-act=mode]').forEach((c) => c.classList.toggle('on', c.dataset.m === mode)); await fetchMore(true); draw(); };
  ctx.acts.filters = () => filtersSheet(F, async () => { saveF(F); ctx.render(''); search(ctx); });
  ctx.poll = async () => { if (!busy && mode !== 'map' && queue.length < 3 && next === null) { const before = queue.length; await fetchMore(true); if (queue.length !== before && !document.querySelector('.sheet')) draw(); } };
  ctx.cleanup = () => { if (map) map.remove(); map = null; };
}

function filtersSheet(F, apply) {
  const s = sheet(`<h3>Фильтры</h3>
    <label class="f">Когда</label><div class="row wrap gap" id="fd">${[['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['weekend', 'Выходные'], ['any', 'Все смены']].map(([k, t]) => `<span class="chip ${F.date === k ? 'on' : ''}" data-d="${k}">${t}</span>`).join('')}</div>
    <label class="f">Минимальная оплата: <b id="pv">от ${F.min_pay} ₽</b></label><input type="range" id="pr" min="0" max="15000" step="50" value="${F.min_pay}"><div class="row gap"><input class="i" id="pn" type="number" inputmode="numeric" value="${F.min_pay}" placeholder="Своя сумма"><span class="mut sm" style="white-space:nowrap">до 15 000 ₽+</span></div>
    <label class="f">Где</label><div class="row wrap gap" id="fg">${[['msk', 'Москва'], ['mo', 'Московская область'], ['near', 'Рядом со мной'], ['pick', 'На карте']].map(([k, t]) => `<span class="chip ${F.geo === k ? 'on' : ''}" data-g="${k}">${t}</span>`).join('')}</div>
    <label class="f">Радиус: <b id="rv">${F.radius_km} км</b></label><input type="range" id="rr" min="1" max="150" value="${F.radius_km}">
    <label class="f">Какую работу ищете?</label><div class="row wrap gap" id="fc">${S.cats.map((c) => `<span class="chip ${F.categories.includes(c.id) ? 'on' : ''}" data-c="${c.id}">${esc(c.name)}</span>`).join('')}</div>
    <div class="row gap" style="margin-top:18px"><button class="btn ghost grow" id="rs">Сбросить</button><button class="btn pri grow" id="ok">Применить</button></div>`);
  const q = (id) => s.el.querySelector('#' + id);
  q('pr').oninput = () => { F.min_pay = +q('pr').value; q('pn').value = F.min_pay; q('pv').textContent = `от ${F.min_pay} ₽`; };
  q('pn').oninput = () => { F.min_pay = Math.max(0, +q('pn').value || 0); q('pr').value = F.min_pay; q('pv').textContent = `от ${F.min_pay} ₽`; };
  q('rr').oninput = () => { F.radius_km = +q('rr').value; q('rv').textContent = F.radius_km + ' км'; };
  s.el.onclick = async (e) => {
    const d = e.target.closest('[data-d]'), g = e.target.closest('[data-g]'), c = e.target.closest('[data-c]');
    if (d) { F.date = d.dataset.d; s.el.querySelectorAll('[data-d]').forEach((x) => x.classList.toggle('on', x === d)); }
    if (c) { const id = +c.dataset.c; F.categories = F.categories.includes(id) ? F.categories.filter((x) => x !== id) : [...F.categories, id]; c.classList.toggle('on'); }
    if (g) {
      const k = g.dataset.g; const set = () => { F.geo = k; s.el.querySelectorAll('[data-g]').forEach((x) => x.classList.toggle('on', x === g)); q('rr').value = F.radius_km; q('rv').textContent = F.radius_km + ' км'; };
      const M = CONFIG.DEFAULT_CITY;
      if (k === 'msk') { F.lat = M.lat; F.lng = M.lng; F.radius_km = 25; set(); }
      if (k === 'mo') { F.lat = M.lat; F.lng = M.lng; F.radius_km = 120; set(); }
      if (k === 'near') {
        if (!navigator.geolocation) return toast('Геолокация недоступна', 'err');
        navigator.geolocation.getCurrentPosition((p) => { F.lat = p.coords.latitude; F.lng = p.coords.longitude; F.radius_km = Math.min(F.radius_km, 30); set(); }, () => toast('Не удалось определить местоположение', 'err'), { timeout: 8000 });
      }
      if (k === 'pick') { const r = await pickLocation({ lat: F.lat, lng: F.lng }); if (r) { F.lat = r.lat; F.lng = r.lng; set(); } }
    }
    if (e.target.id === 'rs') { Object.assign(F, defFilters()); s.close(); apply(); }
    if (e.target.id === 'ok') { s.close(); apply(); }
  };
}

// ---------- карточка смены ----------
async function shiftPage(ctx, id) {
  id = Number(id);
  const s = await api.getShift(id);
  const mine = s.contractor_id === S.user.id;
  const canApply = !mine && s.status === 'open' && !s.my_status;
  ctx.render(`${pageHead('Смена', '<button class="iconbtn" data-act="rep" aria-label="Пожаловаться">⚑</button>')}<div class="card">${shiftCardBody(s).replace('-webkit-line-clamp:3', '-webkit-line-clamp:99')}</div>
    <div class="card click row" data-act="contractor"><div>${avatar(s.contractor.avatar, s.contractor.name)}</div><div class="grow"><b>${esc(s.contractor.company || s.contractor.name)}</b><div class="sm">${stars(s.contractor.rating, s.contractor.reviews)} · ${s.contractor.shifts_done} смен</div></div>›</div>
    ${s.lat != null ? `<div id="map" style="height:200px;border-radius:16px;overflow:hidden;margin:10px 0 4px"></div><a class="g sm" href="${routeLink(s.lat, s.lng)}" target="_blank" rel="noopener" data-act="route">🧭 Маршрут в Яндекс Картах</a>` : ''}
    ${s.my_status ? `<div class="card row sp"><span>Ваш отклик</span>${statusTag(s.my_status)}</div>${s.my_status === 'accepted' ? `<button class="btn pri block" data-act="team">Перейти в команду</button><div style="height:8px"></div>` : ''}<button class="btn block" data-act="dm">💬 Написать подрядчику</button>` : ''}
    ${canApply ? '<button class="btn pri block" data-act="apply" style="padding:16px">Откликнуться</button><div style="height:8px"></div><button class="btn block ghost" data-act="ask">💬 Задать вопрос подрядчику</button>' : (!s.my_status && !mine ? `<p class="mut" style="text-align:center">${s.status === 'full' ? 'Все места заняты' : 'Смена закрыта'}</p>` : '')}`);
  if (s.lat != null) {
    let m = null; ctx.cleanup = () => m && m.remove();
    createMap(document.getElementById('map'), { center: [s.lat, s.lng], zoom: 15, geolocate: false })
      .then((x) => { if (!x) return; m = x; m.scrollZoom.disable(); placemark(m, s.lat, s.lng); })
      .catch((e) => { const el = document.getElementById('map'); if (el) el.outerHTML = `<p class="mut sm">${esc(e.message)}</p>`; });
  }
  // в Telegram внешние ссылки открываем через openLink (иначе откроются внутри мини-приложения)
  ctx.acts.route = (el) => { if (tg) tg.openLink(el.href); else window.open(el.href, '_blank'); };
  ctx.acts.apply = async () => { const r = await api.apply(id); toast(r.duplicate ? 'Вы уже откликались' : 'Отклик отправлен', 'ok'); track('application_sent', { id }); shiftPage(ctx, id); };
  ctx.acts.dm = () => go('#/chat/' + s.my_application_id);
  // личный чат привязан к отклику: чтобы задать вопрос, откликаемся (отклик можно отозвать в «Моих сменах»)
  ctx.acts.ask = async () => {
    if (!(await confirmBox('Чтобы написать подрядчику, нужно откликнуться на смену', { ok: 'Откликнуться и написать', sub: 'Отклик можно отозвать в разделе «Мои смены».' }))) return;
    const r = await api.apply(id); track('application_sent', { id, via: 'ask' }); go('#/chat/' + r.id);
  };
  ctx.acts.contractor = () => go('#/w/contractor/' + s.contractor.id);
  ctx.acts.team = () => go('#/team/' + id);
  ctx.acts.rep = () => reportSheet('shift', id);
  track('shift_viewed', { id });
}

// ---------- мои смены ----------
async function mine(ctx) {
  let tab = sessionStorage.getItem('sh_mtab') || 'pending';
  const TABS = [['pending', 'В ожидании', ['pending']], ['accepted', 'Подтверждённые', ['accepted']], ['completed', 'Завершённые', ['completed']], ['off', 'Отменённые / отклонённые', ['rejected', 'cancelled']]];
  let data = [];
  const draw = () => {
    const cur = TABS.find((t) => t[0] === tab); const list = data.filter((a) => cur[2].includes(a.status));
    const html = `<h1>Мои смены</h1><div class="tabsx">${TABS.map(([k, t, st]) => { const n = data.filter((a) => st.includes(a.status)).length; return `<span class="chip ${tab === k ? 'on' : ''}" data-act="tab" data-t="${k}">${t}${n ? ` · ${n}` : ''}</span>`; }).join('')}</div>` +
      (list.length ? list.map((a) => `<div class="card click" data-act="open" data-id="${a.shift.id}" data-st="${a.status}"><div class="row sp"><b>${esc(a.shift.title)}</b>${statusTag(a.status)}</div><div class="mut sm">${esc(dateLabel(a.shift.date))} · ${esc(a.shift.start)}–${esc(a.shift.end)} · ${money(a.shift.pay)}</div><div class="sm">${esc(a.shift.contractor.company || a.shift.contractor.name)}</div>
        ${a.status === 'accepted' ? `<div class="row gap" style="margin-top:8px"><button class="btn pri sm grow" data-act="team" data-id="${a.shift.id}">Команда</button><button class="btn sm grow" data-act="dm" data-app="${a.id}">Написать</button><button class="btn danger sm" data-act="leave" data-app="${a.id}">Отказаться</button></div>` : ''}
        ${a.status === 'pending' ? `<div class="row gap" style="margin-top:8px"><button class="btn sm grow" data-act="dm" data-app="${a.id}">Написать</button><button class="btn danger sm" data-act="leave" data-app="${a.id}">Отозвать</button></div>` : ''}
        ${a.status === 'completed' ? `<button class="btn sm block" data-act="rate" data-id="${a.shift.id}" style="margin-top:8px">Оценить подрядчика</button>` : ''}</div>`).join('') : emptyState(tab === 'pending' ? 'Откликов в ожидании нет' : 'Здесь пока пусто'));
    if (ctx.main.dataset.h !== html) { ctx.main.innerHTML = html; ctx.main.dataset.h = html; }
  };
  const load = async () => { data = await api.myApplications(); draw(); };
  ctx.main.dataset.h = ''; await load(); ctx.poll = load;
  ctx.acts.tab = (el) => { tab = el.dataset.t; sessionStorage.setItem('sh_mtab', tab); draw(); };
  ctx.acts.open = (el, e) => { if (e.target.closest('button')) return; go('#/w/shift/' + el.dataset.id); };
  ctx.acts.team = (el) => go('#/team/' + el.dataset.id);
  ctx.acts.rate = (el) => go('#/review/' + el.dataset.id);
  ctx.acts.dm = (el) => go('#/chat/' + el.dataset.app);
  ctx.acts.leave = async (el) => { if (!(await confirmBox('Отказаться от смены?', { ok: 'Отказаться', danger: true }))) return; await api.withdraw(Number(el.dataset.app)); toast('Готово', 'ok'); await load(); };
}

// ---------- избранные подрядчики ----------
async function fav(ctx) {
  const list = await api.favorites('contractor');
  ctx.render(`<h1>Избранное</h1><p class="mut sm">Подрядчики, которых вы сохранили</p>${list.length ? list.map((c) => `<div class="card"><div class="row">${avatar(c.avatar, c.name)}<div class="grow"><b>${esc(c.company || c.name)}</b>${verifiedTag(c.verified, 'Проверенный')}<div class="sm">${stars(c.rating, c.reviews)}</div></div></div>${c.about ? `<p class="mut sm">${esc(c.about)}</p>` : ''}
    ${c.open_shifts ? '' : '<p class="mut sm">У этого подрядчика сейчас нет актуальных смен.</p>'}<button class="btn block sm" data-act="c" data-id="${c.id}">Посмотреть объявления</button></div>`).join('') : emptyState('Пока пусто', 'Добавляйте подрядчиков в избранное на странице подрядчика.')}`);
  ctx.acts.c = (el) => go('#/w/contractor/' + el.dataset.id);
}

async function contractorPage(ctx, id) {
  id = Number(id);
  const P = await api.contractorPage(id), c = P.contractor;
  ctx.render(`${pageHead(c.company || c.name, '<button class="iconbtn" data-act="rep">⚑</button>')}<div class="card row">${avatar(c.avatar, c.name, 'lg')}<div class="grow"><b>${esc(c.name)}</b>${c.company ? `<div class="mut sm">${esc(c.company)}</div>` : ''}<div>${stars(c.rating, c.reviews)}</div><div class="mut sm">${c.shifts_done} проведённых смен</div>${verifiedTag(c.verified, 'Проверенный подрядчик')}</div></div>
    ${c.about ? `<p>${esc(c.about)}</p>` : ''}<button class="btn block ${P.is_fav ? '' : 'pri'}" data-act="fav">${P.is_fav ? '★ В избранном' : '☆ В избранное'}</button>
    <h2>Актуальные смены</h2>${P.shifts.length ? P.shifts.map((s) => `<div class="card click" data-act="open" data-id="${s.id}"><b>${esc(s.title)}</b><div class="mut sm">${esc(dateLabel(s.date))} · ${money(s.pay)}</div></div>`).join('') : '<p class="mut">У этого подрядчика сейчас нет актуальных смен.</p>'}
    ${P.reviews.length ? `<h2>Отзывы</h2>${P.reviews.map((r) => `<div class="card"><div class="star">${'★'.repeat(r.stars)}</div>${r.text ? `<div>${esc(r.text)}</div>` : ''}<div class="mut sm">${esc(r.from_name || '')}</div></div>`).join('')}` : ''}`);
  ctx.acts.fav = async () => { await api.toggleFav(id); contractorPage(ctx, id); };
  ctx.acts.open = (el) => go('#/w/shift/' + el.dataset.id);
  ctx.acts.rep = () => reportSheet('contractor', id);
}

// ---------- профиль исполнителя ----------
export function profileBlock(w, own) {
  const rows = [['Возраст', w.age && `${w.age}`], ['Город', w.city], ['Опыт', w.experience], ['Навыки', (w.skills || []).length && w.skills.join(', ')], ['Права', (w.license || []).length && 'Категории ' + w.license.join(', ')],
    ['Медкнижка', w.medbook && 'Есть'], ['Самозанятость', w.selfemployed && 'Да'], ['Ночные смены', w.night && 'Готов'], ['Инструмент', w.tools && 'Умеет работать']].filter(([, v]) => v);
  return `<div class="card row">${avatar(w.avatar, w.name, 'lg')}<div class="grow"><h1 style="margin:0">${esc(w.name)}</h1><div>${stars(w.rating, w.reviews)}</div><div class="mut sm">${w.shifts_done} завершённых смен</div>${verifiedTag(w.verified, 'Проверенный исполнитель')}</div></div>
    ${w.about ? `<p>${esc(w.about)}</p>` : ''}${rows.length ? `<div class="card">${rows.map(([k, v]) => `<div class="row sp sm" style="margin:6px 0"><span class="mut">${k}</span><span style="text-align:right">${esc(v)}</span></div>`).join('')}</div>` : ''}${phone10(w.phone) ? `<div class="card row sp"><span class="mut">Телефон</span><a class="g" href="tel:+7${phone10(w.phone)}">${esc(fmtPhone(w.phone))}</a></div>` : ''}`;
}
async function profile(ctx) {
  const u = await refreshMe(); const w = u.worker;
  ctx.render(`<h1>Профиль</h1>${profileBlock(w, true)}
    <div class="card"><div class="row sp"><b>Профиль заполнен на ${w.percent}%</b>${w.percent >= CONFIG.MIN_VERIFIED_PERCENT ? '<span class="tag g">✓</span>' : ''}</div><div class="bar" style="margin:8px 0"><i style="width:${w.percent}%"></i></div>
    ${w.percent < 100 ? `<p class="mut sm" style="margin:0">Заполните профиль полностью: больше доверия подрядчиков, больше приглашений, выше позиция в поиске${w.percent < CONFIG.MIN_VERIFIED_PERCENT ? ` и статус «Проверенный исполнитель» (от ${CONFIG.MIN_VERIFIED_PERCENT}%)` : ''}.</p>` : ''}</div>
    <button class="btn block" data-act="edit">Редактировать профиль</button><div style="height:8px"></div>${roleSwitch()}${devPanel(u)}`);
  bindCommonProfile(ctx, u); ctx.acts.edit = () => go('#/w/edit');
}
export function roleSwitch() {
  const other = S.role === 'worker' ? 'contractor' : 'worker';
  return `<button class="btn block ghost" data-act="switch">${other === 'contractor' ? 'Режим подрядчика' : 'Режим исполнителя'}${S.user.roles.includes(other) ? '' : ' (создать профиль)'}</button>`;
}
export function devPanel(u) {
  if (MODE !== 'local') return u.is_admin ? '<div style="height:8px"></div><button class="btn block ghost" data-act="admin">Админ-панель</button>' : '';
  const users = devUsers();
  return `<h2>Режим разработки</h2><div class="card sm"><p class="mut" style="margin-top:0">Вы: Telegram ID ${u.tg_id}. Каждая вкладка браузера — отдельный пользователь. Чтобы проверить цепочку, откройте вторую вкладку как другого пользователя.</p>
    <div class="row wrap gap">${users.map((x) => `<span class="chip ${x.tg_id === u.tg_id ? 'on' : ''}" data-act="dev" data-id="${x.tg_id}">${esc(x.name)} (${x.tg_id})${x.is_admin ? ' ★' : ''}</span>`).join('')}<span class="chip" data-act="devnew">+ новый</span><span class="chip" data-act="devadmin">Админ (ID 1)</span></div>
    <button class="btn danger sm" data-act="devreset" style="margin-top:10px">Стереть все локальные данные</button></div>${u.is_admin ? '<button class="btn block ghost" data-act="admin">Админ-панель</button>' : ''}`;
}
export function bindCommonProfile(ctx, u) {
  ctx.acts.switch = () => { const o = S.role === 'worker' ? 'contractor' : 'worker'; setRole(o); go(S.user.roles.includes(o) ? '#/' : (o === 'worker' ? '#/w/onboard' : '#/c/onboard')); };
  ctx.acts.admin = () => go('#/admin');
  ctx.acts.dev = (el) => setDevUser(el.dataset.id);
  ctx.acts.devnew = () => setDevUser(2000 + Math.floor(Math.random() * 8000));
  ctx.acts.devadmin = () => setDevUser(1);
  ctx.acts.devreset = async () => { if (await confirmBox('Стереть все локальные данные?', { danger: true, ok: 'Стереть' })) { localReset(); sessionStorage.clear(); location.hash = '#/'; location.reload(); } };
}

export const workerRoutes = [
  [/^#\/w\/search$/, search], [/^#\/w\/shift\/(\d+)$/, shiftPage], [/^#\/w\/mine$/, mine], [/^#\/w\/fav$/, fav], [/^#\/w\/contractor\/(\d+)$/, contractorPage], [/^#\/w\/profile$/, profile],
];
