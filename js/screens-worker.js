// Экраны исполнителя
import { api, track, MODE, devUsers, setDevUser, tg } from './api.js';
import { CONFIG } from './config.js';
import { localReset } from './local-backend.js';
import { S, go, toast, errMsg, sheet, confirmBox, avatar, stars, pageHead, emptyState, verifiedTag, statusTag, setRole, refreshMe, heroCard, infoRows, pill, sect, ring, ICON } from './ui.js';
import { createMap, placemark, shiftsLayer, routeLink } from './maps.js';
import { esc, dateLabel, money, plural, phone10, fmtPhone, timeRange, payLabel, payNote } from './util.js';
import { reportSheet, shiftName, openLegal } from './screens-common.js';

const FKEY = 'sh_filters_v1';
const defFilters = () => ({ date: 'any', min_pay: 0, geo: 'any', categories: [] });
// старые сохранённые фильтры (радиус, «рядом», «на карте») приводим к новым: работаем только по Москве и области
const loadF = () => { try { const f = { ...defFilters(), ...JSON.parse(localStorage.getItem(FKEY)) }; delete f.radius_km; delete f.lat; delete f.lng; if (!['msk', 'mo', 'any'].includes(f.geo)) f.geo = 'any'; return f; } catch { return defFilters(); } };
const saveF = (f) => localStorage.setItem(FKEY, JSON.stringify(f));
const needProfile = () => !S.user.roles.includes('worker');

export const shiftCardBody = (s) => `<div class="row sp"><span class="tag g">${esc(s.category_name || '')}</span><span class="mut sm">${s.region === 'mo' ? 'Московская обл.' : 'Москва'}</span></div>
  <h1 style="margin:10px 0 2px">${esc(s.title)}</h1>
  <div class="row gap wrap sm"><span>${esc(s.contractor?.company || s.contractor?.name || '')}</span>${verifiedTag(s.contractor?.verified, 'Проверенный подрядчик')}<span>${stars(s.contractor?.rating, s.contractor?.reviews)}</span></div>
  <div class="pay" style="margin:12px 0 2px">${esc(payLabel(s))}</div>${payNote(s) ? `<div class="mut sm" style="margin-bottom:6px">${esc(payNote(s))}</div>` : '<div style="height:6px"></div>'}
  <div class="sm" style="line-height:1.7">🗓 ${esc(dateLabel(s.date))} · ${esc(timeRange(s))}<br>📍 ${esc(s.address)}<br>👥 Нужно ${s.people} ${plural(s.people, 'человек', 'человека', 'человек')} · осталось мест: ${Math.max(0, s.people - s.accepted_count)}</div>
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
    return `${d} · ${{ msk: 'Москва', mo: 'Московская область', any: 'Москва и область' }[F.geo]} · от ${money(F.min_pay)}`;
  };
  const frame = () => `<div class="row sp" style="margin:2px 0 6px"><div class="tabsx" style="margin:0">${[['swipe', 'Карточки'], ['list', 'Список'], ['map', 'Карта']].map(([k, t]) => `<span class="chip ${mode === k ? 'on' : ''}" data-act="mode" data-m="${k}">${t}</span>`).join('')}</div><button class="btn sm" data-act="filters">⚙ Фильтры</button></div><div class="row sp" style="margin-bottom:4px"><span class="mut sm">${summary()}</span><a class="g sm" href="#" data-act="skippedList" id="skn" hidden>↺ Пропущенные</a></div><div id="body"></div>`;
  // ссылка на пропущенные смены (с количеством) — видна, если есть что вернуть
  let skipCount = 0;
  const showSkips = (n) => { skipCount = Math.max(0, n); const a = document.getElementById('skn'); if (a) { a.hidden = !skipCount; a.textContent = `↺ Пропущенные · ${skipCount}`; } };
  const loadSkips = () => api.mySkips().then((l) => showSkips(l.length)).catch(() => {});

  const empty = () => `<div class="empty"><h2>Пока новых смен нет.</h2><p>Попробуйте расширить поиск.</p>
    <div class="row wrap gap" style="justify-content:center"><button class="btn pri" data-act="similar">Показать похожие смены</button><button class="btn" data-act="filters">Изменить фильтры</button><button class="btn" data-act="refresh">Обновить поиск</button>${skipCount ? `<button class="btn" data-act="skippedList">↺ Пропущенные · ${skipCount}</button>` : ''}${hist ? '<button class="btn" data-act="undo">↺ Вернуть последнюю</button>' : ''}</div></div>`;

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
    const m = await createMap(el, { center: [CONFIG.DEFAULT_CITY.lat, CONFIG.DEFAULT_CITY.lng], zoom: F.geo === 'msk' ? 9.6 : F.geo === 'mo' ? 8.2 : 8.8 });
    if (!m) return; if (map) map.remove(); map = m;
    shiftsLayer(map, queue, (id) => {
      const s = queue.find((x) => x.id === id); if (!s) return;
      const sh = sheet(`<div class="row sp"><span class="pay g" style="font-size:24px;font-weight:900">${esc(payLabel(s))}</span><span class="mut sm">${s.region === 'mo' ? 'Московская обл.' : 'Москва'}</span></div><h3>${esc(s.title)}</h3><p class="mut sm">${esc(dateLabel(s.date))} · ${esc(timeRange(s))}<br>${esc(s.address)}</p><button class="btn pri block" data-o>Открыть</button>`);
      sh.el.querySelector('[data-o]').onclick = () => { sh.close(); go('#/w/shift/' + s.id); };
    });
  }

  function drawDeck(body) {
    if (!queue.length) { body.innerHTML = empty(); return; }
    body.innerHTML = `<div class="deck" id="deck"></div><div class="actions"><button class="rb undo" data-act="undo" ${hist ? '' : 'disabled'} aria-label="Вернуть">↺</button><button class="rb no" data-act="skip" aria-label="Пропустить">✕</button><button class="rb save" data-act="save" aria-label="Отложить на потом">${ICON.bookmark}</button><button class="rb ok" data-act="like" aria-label="Откликнуться">✓</button></div><p class="mut sm" style="text-align:center;margin:0">Вправо — откликнуться · влево — пропустить · закладка — отложить</p>`;
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
    if (card) { card.style.transition = 'transform .28s ease-out,opacity .28s'; card.style.transform = kind === 'save' ? 'translateY(-60vh) scale(.5)' : `translateX(${kind === 'like' ? 130 : -130}vw) rotate(${kind === 'like' ? 24 : -24}deg)`; card.style.opacity = 0; }
    queue.shift();
    try {
      if (kind === 'like') { const r = await api.apply(s.id); hist = { kind, s, dup: !!r.duplicate }; toast(r.duplicate ? 'Вы уже откликались' : 'Отклик отправлен', 'ok'); track('swipe_right', { id: s.id }); track('application_sent', { id: s.id }); }
      else if (kind === 'save') { await api.toggleShiftFav(s.id); hist = { kind, s }; toast('Смена отложена — она в «Избранном»', 'ok'); track('shift_saved', { id: s.id }); }
      else { await api.skip(s.id); hist = { kind, s }; showSkips(skipCount + 1); track('swipe_left', { id: s.id }); }
    } catch (e) {
      queue.unshift(s); toast(errMsg(e), 'err');
      if (e.code === 'closed') queue.shift();
    }
    setTimeout(() => { busy = false; if (queue.length < 5 && next !== null) fetchMore().then(draw); draw(); }, 240);
  }

  ctx.render(frame());
  document.getElementById('body').innerHTML = '<div class="skel" style="height:50vh"></div>';
  await fetchMore(true); draw(); loadSkips().then(() => !queue.length && draw());

  ctx.acts.like = () => decide('like'); ctx.acts.skip = () => decide('skip'); ctx.acts.save = () => decide('save');
  ctx.acts.undo = async () => {
    if (!hist || busy) return;
    try {
      if (hist.kind === 'like') { if (!(await api.undoApply(hist.s.id))) { hist = null; draw(); return toast('Отклик уже обработан — вернуть нельзя', 'err'); } }
      else if (hist.kind === 'save') await api.toggleShiftFav(hist.s.id);
      else { await api.unskip(hist.s.id); showSkips(skipCount - 1); }
      queue.unshift(hist.s); hist = null; draw();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  ctx.acts.open = (el) => go('#/w/shift/' + el.dataset.id);
  ctx.acts.more = async () => { await fetchMore(); draw(); };
  ctx.acts.refresh = async () => { hist = null; await fetchMore(true); draw(); if (!queue.length) toast('Новых смен пока нет'); };
  ctx.acts.skippedList = () => go('#/w/skipped');
  ctx.acts.similar = async () => {
    const base = hist && hist.s; if (!base) { F.geo = 'any'; F.date = 'any'; F.min_pay = 0; F.categories = []; saveF(F); toast('Расширили поиск'); await fetchMore(true); return draw(); }
    const r = await api.feed({ ...F, date: 'any', min_pay: 0, geo: 'any', similar_to: base.id, include_skipped: true }); queue = r.items; next = r.next; draw();
    if (!queue.length) toast('Похожих смен нет');
  };
  ctx.acts.mode = async (el) => { mode = el.dataset.m; sessionStorage.setItem('sh_mode', mode); document.querySelectorAll('[data-act=mode]').forEach((c) => c.classList.toggle('on', c.dataset.m === mode)); await fetchMore(true); draw(); };
  ctx.acts.filters = () => filtersSheet(F, async () => { saveF(F); ctx.render(''); search(ctx); });
  ctx.poll = async () => { if (!busy && mode !== 'map' && queue.length < 3 && next === null) { const before = queue.length; await fetchMore(true); if (queue.length !== before && !document.querySelector('.sheet')) draw(); } };
  ctx.cleanup = () => { if (map) map.remove(); map = null; };
}

function filtersSheet(F, apply) {
  const s = sheet(`<h3>Фильтры</h3>
    <label class="f">Когда</label><div class="row wrap gap" id="fd">${[['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['weekend', 'Выходные'], ['any', 'Любая']].map(([k, t]) => `<span class="chip ${F.date === k ? 'on' : ''}" data-d="${k}">${t}</span>`).join('')}</div>
    <label class="f">Минимальная оплата: <b id="pv">от ${money(F.min_pay)}</b></label><input type="range" id="pr" min="0" max="15000" step="50" value="${F.min_pay}"><div class="row gap"><input class="i" id="pn" type="number" inputmode="numeric" value="${F.min_pay}" placeholder="Своя сумма"><span class="mut sm" style="white-space:nowrap">до 15 000 ₽+</span></div>
    <label class="f">Где</label><div class="row wrap gap" id="fg">${[['msk', 'Москва'], ['mo', 'Московская область'], ['any', 'Любая']].map(([k, t]) => `<span class="chip ${F.geo === k ? 'on' : ''}" data-g="${k}">${t}</span>`).join('')}</div>
    <p class="hint">Работаем только в Москве и Московской области</p>
    <label class="f">Какую работу ищете?</label><div class="row wrap gap" id="fc">${S.cats.map((c) => `<span class="chip ${F.categories.includes(c.id) ? 'on' : ''}" data-c="${c.id}">${esc(c.name)}</span>`).join('')}</div>
    <div class="row gap" style="margin-top:18px"><button class="btn ghost grow" id="rs">Сбросить</button><button class="btn pri grow" id="ok">Применить</button></div>`);
  const q = (id) => s.el.querySelector('#' + id);
  q('pr').oninput = () => { F.min_pay = +q('pr').value; q('pn').value = F.min_pay; q('pv').textContent = `от ${money(F.min_pay)}`; };
  q('pn').oninput = () => { F.min_pay = Math.max(0, +q('pn').value || 0); q('pr').value = F.min_pay; q('pv').textContent = `от ${money(F.min_pay)}`; };
  s.el.onclick = async (e) => {
    const d = e.target.closest('[data-d]'), g = e.target.closest('[data-g]'), c = e.target.closest('[data-c]');
    if (d) { F.date = d.dataset.d; s.el.querySelectorAll('[data-d]').forEach((x) => x.classList.toggle('on', x === d)); }
    if (c) { const id = +c.dataset.c; F.categories = F.categories.includes(id) ? F.categories.filter((x) => x !== id) : [...F.categories, id]; c.classList.toggle('on'); }
    if (g) { F.geo = g.dataset.g; s.el.querySelectorAll('[data-g]').forEach((x) => x.classList.toggle('on', x === g)); }
    if (e.target.id === 'rs') { Object.assign(F, defFilters()); s.close(); apply(); }
    if (e.target.id === 'ok') { s.close(); apply(); }
  };
}

// ---------- пропущенные смены (свайп влево): поиск, вернуть в ленту, откликнуться ----------
async function skippedPage(ctx) {
  if (needProfile()) return go('#/w/onboard');
  let list = await api.mySkips(), q = '';
  const match = (s) => !q || [s.title, s.address, s.category_name, s.contractor?.company, s.contractor?.name, s.description].join(' ').toLowerCase().includes(q);
  const draw = () => {
    const l = list.filter(match);
    document.getElementById('skl').innerHTML = !list.length ? emptyState('Пропущенных смен нет', 'Здесь появятся смены, которые вы смахнули влево.', '<button class="btn pri" data-act="toSearch">К поиску смен</button>')
      : !l.length ? emptyState('Ничего не нашлось', 'Попробуйте другое слово.')
      : l.map((s) => `<div class="card" data-id="${s.id}"><div class="click" data-act="open" data-id="${s.id}">${shiftCardBody(s)}</div>
        <div class="row gap" style="margin-top:12px"><button class="btn sm grow" data-act="back2" data-id="${s.id}">↺ Вернуть в ленту</button><button class="btn pri sm grow" data-act="apply" data-id="${s.id}">Откликнуться</button></div></div>`).join('');
    const all = document.getElementById('skall'); if (all) all.hidden = list.length < 2;
  };
  ctx.render(`${pageHead('Пропущенные', '<button class="btn sm" data-act="all" id="skall" hidden>Вернуть все</button>')}
    <p class="mut sm" style="margin-top:0">Смены, которые вы смахнули влево. Верните их в ленту или откликнитесь сразу.</p>
    <input class="i" id="skq" type="search" placeholder="🔍 Поиск: название, адрес, подрядчик" autocomplete="off"><div id="skl"></div>`);
  draw();
  document.getElementById('skq').oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
  const drop = (id) => { list = list.filter((s) => s.id !== id); draw(); };
  ctx.acts.open = (el) => go('#/w/shift/' + el.dataset.id);
  ctx.acts.toSearch = () => go('#/w/search');
  ctx.acts.back2 = async (el) => { const id = Number(el.dataset.id); await api.unskip(id); drop(id); toast('Смена вернулась в ленту', 'ok'); };
  ctx.acts.apply = async (el) => {
    const id = Number(el.dataset.id);
    try { const r = await api.apply(id); drop(id); toast(r.duplicate ? 'Вы уже откликались' : 'Отклик отправлен', 'ok'); track('application_sent', { id, via: 'skipped' }); }
    catch (e) { if (e.code === 'closed') drop(id); throw e; }
  };
  ctx.acts.all = async () => {
    if (!(await confirmBox(`Вернуть в ленту все пропущенные смены (${list.length})?`, { ok: 'Вернуть все' }))) return;
    await api.unskipAll(); list = []; draw(); toast('Все смены вернулись в ленту', 'ok');
  };
}

// ---------- карточка смены ----------
async function shiftPage(ctx, id) {
  id = Number(id);
  const s = await api.getShift(id);
  const mine = s.contractor_id === S.user.id;
  const canApply = !mine && s.status === 'open' && !s.my_status;
  ctx.render(`${pageHead('Смена', `<span class="row">${canApply ? `<button class="bm ${s.saved ? 'on' : ''}" data-act="bm" aria-label="Отложить на потом">${ICON.bookmark}</button>` : ''}<button class="iconbtn" data-act="rep" aria-label="Пожаловаться">⚑</button></span>`)}<div class="card">${shiftCardBody(s).replace('-webkit-line-clamp:3', '-webkit-line-clamp:99')}</div>
    <div class="card click row" data-act="contractor"><div>${avatar(s.contractor.avatar, s.contractor.name)}</div><div class="grow"><b>${esc(s.contractor.company || s.contractor.name)}</b><div class="sm">${stars(s.contractor.rating, s.contractor.reviews)} · ${s.contractor.shifts_done} ${plural(s.contractor.shifts_done, 'смена', 'смены', 'смен')}</div></div>›</div>
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
  ctx.acts.bm = async (el) => { const on = await api.toggleShiftFav(id); el.classList.toggle('on', on); toast(on ? 'Отложено — смена в «Избранном»' : 'Убрано из отложенных', 'ok'); };
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
      (list.length ? list.map((a) => `<div class="card click" data-act="open" data-id="${a.shift.id}" data-st="${a.status}"><div class="row sp"><b>${esc(a.shift.title)}</b>${statusTag(a.status)}</div><div class="mut sm">${esc(dateLabel(a.shift.date))} · ${esc(timeRange(a.shift))} · ${esc(payLabel(a.shift))}</div><div class="sm">${esc(a.shift.contractor.company || a.shift.contractor.name)}</div>
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
  ctx.acts.leave = async (el) => {
    const pending = (el.closest('[data-st]') || {}).dataset?.st === 'pending';
    if (!(await confirmBox(pending ? 'Отозвать отклик?' : 'Отказаться от смены?', { ok: pending ? 'Отозвать' : 'Отказаться', danger: true, sub: pending ? '' : 'Подрядчик получит уведомление, место освободится для других.' }))) return;
    await api.withdraw(Number(el.dataset.app)); toast(pending ? 'Отклик отозван' : 'Вы отказались от смены', 'ok'); await load();
  };
}

// ---------- избранные подрядчики ----------
async function fav(ctx) {
  const [list, saved] = await Promise.all([api.favorites('contractor'), api.savedShifts()]);
  let tab = sessionStorage.getItem('sh_favtab') || (saved.length || !list.length ? 'shifts' : 'c'), items = saved.slice();
  const draw = () => {
    const head = `<h1>Избранное</h1><div class="tabsx"><span class="chip ${tab === 'shifts' ? 'on' : ''}" data-act="ftab" data-t="shifts">Отложенные смены${items.length ? ` · ${items.length}` : ''}</span><span class="chip ${tab === 'c' ? 'on' : ''}" data-act="ftab" data-t="c">Подрядчики${list.length ? ` · ${list.length}` : ''}</span></div>`;
    const shiftsHtml = items.length ? '<p class="mut sm">Смены, которые вы отложили «на потом»</p>' + items.map((s) => `<div class="card" data-id="${s.id}"><div class="click" data-act="open" data-id="${s.id}">${shiftCardBody(s)}</div><div class="row gap" style="margin-top:12px"><button class="btn sm grow" data-act="unsave" data-id="${s.id}">Убрать</button><button class="btn pri sm grow" data-act="apply" data-id="${s.id}">Откликнуться</button></div></div>`).join('')
      : emptyState('Отложенных смен нет', 'Нажмите на закладку на карточке смены, чтобы вернуться к ней позже.', '<button class="btn pri" data-act="toSearch">К поиску смен</button>');
    const cHtml = list.length ? '<p class="mut sm">Подрядчики, которых вы сохранили</p>' + list.map((c) => `<div class="card"><div class="row">${avatar(c.avatar, c.name)}<div class="grow"><b>${esc(c.company || c.name)}</b>${verifiedTag(c.verified, 'Проверенный')}<div class="sm">${stars(c.rating, c.reviews)}</div></div></div>${c.about ? `<p class="mut sm">${esc(c.about)}</p>` : ''}
      ${c.open_shifts ? '' : '<p class="mut sm">У этого подрядчика сейчас нет актуальных смен.</p>'}<button class="btn block sm" data-act="c" data-id="${c.id}">Посмотреть объявления</button></div>`).join('') : emptyState('Пока пусто', 'Добавляйте подрядчиков в избранное на странице подрядчика.');
    ctx.main.innerHTML = head + (tab === 'shifts' ? shiftsHtml : cHtml);
  };
  draw();
  const drop = (id) => { items = items.filter((x) => x.id !== id); draw(); };
  ctx.acts.ftab = (el) => { tab = el.dataset.t; sessionStorage.setItem('sh_favtab', tab); draw(); };
  ctx.acts.c = (el) => go('#/w/contractor/' + el.dataset.id);
  ctx.acts.open = (el) => go('#/w/shift/' + el.dataset.id);
  ctx.acts.toSearch = () => go('#/w/search');
  ctx.acts.unsave = async (el) => { const id = Number(el.dataset.id); await api.toggleShiftFav(id); drop(id); toast('Убрано из отложенных', 'ok'); };
  ctx.acts.apply = async (el) => {
    const id = Number(el.dataset.id);
    try { const r = await api.apply(id); drop(id); toast(r.duplicate ? 'Вы уже откликались' : 'Отклик отправлен', 'ok'); track('application_sent', { id, via: 'saved' }); }
    catch (e) { if (e.code === 'closed') drop(id); throw e; }
  };
}

// ---------- рейтинг исполнителей ----------
async function top(ctx) {
  let per = sessionStorage.getItem('sh_lbper') || 'month';
  const MEDAL = ['🥇', '🥈', '🥉'], month = new Date().toLocaleDateString('ru-RU', { month: 'long', timeZone: 'Europe/Moscow' });
  const draw = async () => {
    const r = await api.leaderboard(per);
    const prizes = (S.cfg && S.cfg.prizes) || 'Лучшие исполнители месяца получают призы. Условия и призы объявит администратор.';
    const row = (x) => `<div class="lb ${x.rank <= 3 ? 'p' + x.rank : ''} ${x.user_id === S.user.id ? 'me' : ''} click" data-act="prof" data-id="${x.user_id}"><div class="rk">${x.rank <= 3 ? MEDAL[x.rank - 1] : x.rank}</div>${avatar(x.avatar, x.name, 'sm')}<div class="grow"><b>${esc(x.name)}${x.user_id === S.user.id ? ' (вы)' : ''}</b><div class="mut sm">${x.shifts} ${plural(x.shifts, 'смена', 'смены', 'смен')}${x.rating != null ? ` · ★ ${x.rating}` : ''}</div></div><div class="sc"><b>${x.score}</b><span>очков</span></div></div>`;
    const inTop = r.me && r.top.some((x) => x.user_id === S.user.id);
    const mine = !S.user.roles.includes('worker') ? '' : r.me ? (inTop ? '' : `<div class="card"><b>Ваше место: ${r.me.rank}</b><div class="mut sm">${r.me.score} очков · ${r.me.shifts} ${plural(r.me.shifts, 'смена', 'смены', 'смен')}</div></div>`)
      : '<div class="card"><b>Вы пока вне рейтинга</b><div class="mut sm">Выполните смену и получите оценку — и вы появитесь в таблице.</div></div>';
    ctx.main.innerHTML = `${pageHead('Рейтинг исполнителей')}<div class="tabsx"><span class="chip ${per === 'month' ? 'on' : ''}" data-act="per" data-p="month">${month[0].toUpperCase() + month.slice(1)}</span><span class="chip ${per === 'all' ? 'on' : ''}" data-act="per" data-p="all">За всё время</span></div>
      <div class="prize"><b>🏆 Призы</b><div class="sm" style="margin-top:4px">${esc(prizes)}</div></div>
      <p class="mut sm" style="margin:0 0 8px">Очки: 10 за каждую проведённую смену и 2 за каждую звезду в отзывах. «Не пришёл» очков не даёт.</p>${mine}
      ${r.top.length ? r.top.map(row).join('') : emptyState('Пока никого', 'Первые очки появятся после завершённых смен.')}`;
  };
  await draw();
  ctx.acts.per = async (el) => { per = el.dataset.p; sessionStorage.setItem('sh_lbper', per); await draw(); };
  ctx.acts.prof = (el) => go('#/c/worker/' + el.dataset.id);
}

async function contractorPage(ctx, id) {
  id = Number(id);
  const P = await api.contractorPage(id), c = P.contractor;
  ctx.render(`${pageHead(c.company || c.name, '<button class="iconbtn" data-act="rep" aria-label="Пожаловаться">⚑</button>')}${heroCard({ av: c.avatar, name: c.name, verified: c.verified, sub: c.company ? esc(c.company) : '', tags: verifiedTag(c.verified, 'Проверенный подрядчик'),
      stats: [[c.rating == null ? '—' : c.rating.toFixed(1) + ' <small class="star">★</small>', c.reviews ? `${c.reviews} ${plural(c.reviews, 'отзыв', 'отзыва', 'отзывов')}` : 'нет оценок'], [c.shifts_done, plural(c.shifts_done, 'смена', 'смены', 'смен')], [esc(c.city || '—'), 'город']] })}
    ${c.about ? `<div class="about">${esc(c.about)}</div>` : ''}<button class="btn block ${P.is_fav ? 'favon' : 'pri'}" data-act="fav">${P.is_fav ? '★ В избранном' : '☆ В избранное'}</button>
    <h2>Актуальные смены</h2>${P.shifts.length ? P.shifts.map((s) => `<div class="card click row sp" data-act="open" data-id="${s.id}"><div class="grow"><b>${esc(s.title)}</b><div class="mut sm">${esc(dateLabel(s.date))}</div></div><span class="pay-tag">${esc(payLabel(s))}</span></div>`).join('') : '<p class="mut">У этого подрядчика сейчас нет актуальных смен.</p>'}
    ${P.reviews.length ? `<h2>Отзывы</h2>${P.reviews.map((r) => `<div class="card review"><div class="row sp"><span class="star">${'★'.repeat(r.stars)}<span class="off">${'★'.repeat(5 - r.stars)}</span></span><span class="mut sm">${esc(r.from_name || '')}</span></div>${r.text ? `<div style="margin-top:6px">${esc(r.text)}</div>` : ''}</div>`).join('')}` : ''}`);
  ctx.acts.fav = async () => { const on = await api.toggleFav(id); toast(on ? 'Добавлено в избранное' : 'Убрано из избранного', 'ok'); contractorPage(ctx, id); };
  ctx.acts.open = (el) => go('#/w/shift/' + el.dataset.id);
  ctx.acts.rep = () => reportSheet('contractor', id);
}

// ---------- профиль исполнителя ----------
export function profileBlock(w, own) {
  const rows = [['pin', 'Город', w.city && esc(w.city)], ['user', 'Возраст', w.age && `${w.age} ${plural(w.age, 'год', 'года', 'лет')}`], ['work', 'Опыт', w.experience && esc(w.experience)], ['car', 'Права', (w.license || []).length && 'категории ' + w.license.join(', ')]].filter(([, , v]) => v);
  const feats = [w.medbook && pill('heart', 'Медкнижка'), w.selfemployed && pill('money', 'Самозанятый'), w.night && pill('moon', 'Ночные смены'), w.tools && pill('bolt', 'С инструментом')].filter(Boolean);
  const skills = (w.skills || []).map((s) => `<span class="pill plain">${esc(s)}</span>`);
  return heroCard({ av: w.avatar, name: w.name, verified: w.verified, tags: verifiedTag(w.verified, 'Проверенный исполнитель'),
      stats: [[w.rating == null ? '—' : w.rating.toFixed(1) + ' <small class="star">★</small>', w.reviews ? `${w.reviews} ${plural(w.reviews, 'отзыв', 'отзыва', 'отзывов')}` : 'нет оценок'], [w.shifts_done, plural(w.shifts_done, 'смена', 'смены', 'смен')], [w.percent + '%', 'профиль']] })
    + (w.about ? `<div class="about">${esc(w.about)}</div>` : '') + infoRows(rows)
    + (skills.length ? sect('Навыки') + `<div class="row wrap gap">${skills.join('')}</div>` : '') + (feats.length ? sect('Особенности') + `<div class="row wrap gap">${feats.join('')}</div>` : '')
    + (phone10(w.phone) ? `<a class="callbtn" href="tel:+7${phone10(w.phone)}">${ICON.phone}<span>${esc(fmtPhone(w.phone))}</span><small>Позвонить</small></a>` : '');
}
async function profile(ctx) {
  const u = await refreshMe(); const w = u.worker, ok = w.percent >= CONFIG.MIN_VERIFIED_PERCENT;
  const P = await api.workerPage(u.id).catch(() => null);
  const active = P && P.active.length ? sect('Активные задания') + P.active.map((a) => `<div class="card click row sp" data-act="openShift" data-id="${a.id}"><div class="grow"><b>${esc(a.title)}</b><div class="mut sm">${esc(dateLabel(a.date))} · ${esc(timeRange(a))}</div></div>›</div>`).join('') : '';
  ctx.render(`${profileBlock(w, true)}
    <div class="card prog"><div class="row">${ring(w.percent, 64)}<div class="grow"><b>Профиль заполнен на ${w.percent}%</b><div class="mut sm">${ok ? 'У вас статус «Проверенный исполнитель»' : `Ещё ${CONFIG.MIN_VERIFIED_PERCENT - w.percent}% до статуса «Проверенный»`}</div></div></div>
    ${w.percent < 100 ? `<p class="mut sm" style="margin:12px 0 0">Чем полнее профиль, тем больше доверия подрядчиков и выше позиция в поиске.</p>` : ''}</div>
    ${active}<button class="btn block" data-act="toTop" style="margin-top:12px">${ICON.trophy}Рейтинг исполнителей</button><div style="height:8px"></div><button class="btn block" data-act="edit">${ICON.edit}Редактировать профиль</button><div style="height:8px"></div>${roleSwitch()}${devPanel(u)}${helpBlock()}`);
  bindCommonProfile(ctx, u); ctx.acts.edit = () => go('#/w/edit'); ctx.acts.toTop = () => go('#/w/top'); ctx.acts.openShift = (el) => go('#/w/shift/' + el.dataset.id);
}
// «Помощь и документы»: политика, соглашение, поддержка, удаление аккаунта (право на удаление данных — 152-ФЗ)
export function helpBlock() {
  const link = (ic, t, act, extra = '') => `<div class="irow click" data-act="${act}" ${extra}><span class="ico">${ICON[ic]}</span><span class="k" style="color:var(--txt);font-size:15px">${t}</span><span class="v mut">›</span></div>`;
  return `<div class="sect">Помощь и документы</div><div class="info">${link('shield', 'Политика конфиденциальности', 'legal', 'data-u="privacy"')}${link('info', 'Пользовательское соглашение', 'legal', 'data-u="terms"')}${S.cfg && S.cfg.support_url ? link('chats', 'Написать в поддержку', 'support') : ''}</div>
    <button class="btn danger block" data-act="delAccount" style="margin-top:14px">Удалить аккаунт</button>`;
}
export function roleSwitch() {
  const other = S.role === 'worker' ? 'contractor' : 'worker';
  return `<button class="btn block ghost" data-act="switch">${ICON.swap}${other === 'contractor' ? 'Режим подрядчика' : 'Режим исполнителя'}${S.user.roles.includes(other) ? '' : ' (создать профиль)'}</button>`;
}
export function devPanel(u) {
  if (MODE !== 'local') return u.is_admin ? '<div style="height:8px"></div><button class="btn block ghost" data-act="admin">Админ-панель</button>' : '';
  const users = devUsers();
  return `<h2>Режим разработки</h2><div class="card sm"><p class="mut" style="margin-top:0">Вы: Telegram ID ${u.tg_id}. Каждая вкладка браузера — отдельный пользователь. Чтобы проверить цепочку, откройте вторую вкладку как другого пользователя.</p>
    <div class="row wrap gap">${users.map((x) => `<span class="chip ${x.tg_id === u.tg_id ? 'on' : ''}" data-act="dev" data-id="${x.tg_id}">${esc(x.name)} (${x.tg_id})${x.is_admin ? ' ★' : ''}</span>`).join('')}<span class="chip" data-act="devnew">+ новый</span><span class="chip" data-act="devadmin">Админ (ID 1)</span></div>
    <button class="btn danger sm" data-act="devreset" style="margin-top:10px">Стереть все локальные данные</button></div>${u.is_admin ? '<button class="btn block ghost" data-act="admin">Админ-панель</button>' : ''}`;
}
export function bindCommonProfile(ctx, u) {
  ctx.acts.legal = (el) => openLegal(el.dataset.u);
  ctx.acts.support = () => {
    const url = S.cfg.support_url;
    if (tg && tg.openTelegramLink && /^https:\/\/t\.me\//.test(url)) tg.openTelegramLink(url); // чат поддержки открывается внутри Telegram
    else if (tg) tg.openLink(url);
    else window.open(url, '_blank', 'noopener');
  };
  ctx.acts.delAccount = async () => {
    if (!(await confirmBox('Удалить аккаунт?', { ok: 'Продолжить', danger: true, sub: 'Профиль, избранное и уведомления будут стёрты, активные смены и отклики отменены. Это нельзя отменить.' }))) return;
    if (!(await confirmBox('Точно удалить навсегда?', { ok: 'Да, удалить', danger: true, sub: 'Рейтинг и история смен будут потеряны.' }))) return;
    await api.deleteAccount(); localStorage.removeItem('sh_role_' + S.user.id); S.role = null; await refreshMe(); toast('Аккаунт удалён', 'ok'); go('#/');
  };
  ctx.acts.switch = () => { const o = S.role === 'worker' ? 'contractor' : 'worker'; setRole(o); go(S.user.roles.includes(o) ? '#/' : (o === 'worker' ? '#/w/onboard' : '#/c/onboard')); };
  ctx.acts.admin = () => go('#/admin');
  ctx.acts.dev = (el) => setDevUser(el.dataset.id);
  ctx.acts.devnew = () => setDevUser(2000 + Math.floor(Math.random() * 8000));
  ctx.acts.devadmin = () => setDevUser(1);
  ctx.acts.devreset = async () => { if (await confirmBox('Стереть все локальные данные?', { danger: true, ok: 'Стереть' })) { localReset(); sessionStorage.clear(); location.hash = '#/'; location.reload(); } };
}

export const workerRoutes = [
  [/^#\/w\/top$/, top], [/^#\/w\/search$/, search], [/^#\/w\/skipped$/, skippedPage],[/^#\/w\/shift\/(\d+)$/, shiftPage], [/^#\/w\/mine$/, mine], [/^#\/w\/fav$/, fav], [/^#\/w\/contractor\/(\d+)$/, contractorPage], [/^#\/w\/profile$/, profile],
];
