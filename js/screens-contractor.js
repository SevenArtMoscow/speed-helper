// Экраны подрядчика
import { api, track } from './api.js';
import { CONFIG } from './config.js';
import { S, go, toast, errMsg, sheet, confirmBox, avatar, stars, pageHead, emptyState, verifiedTag, statusTag, toggle, refreshMe, validate, markError, clearError, reqMark, heroCard, infoRows, sect, ICON, reviewsBlock, bindReviews, proCard, proBadge, haptic, tick, openBot } from './ui.js';
import { pickLocation, geocode, attachSuggest } from './maps.js';
import { esc, dateLabel, dateLong, money, todayISO, addDays, uid, plural, fmtPhone, timeRange, payLabel, payNote, shiftText, PAYOUT, payoutMinDay, payoutDetail } from './util.js';
import { reportSheet, finishShift, shiftName, askPhone } from './screens-common.js';
import { profileBlock, roleSwitch, devPanel, bindCommonProfile, helpBlock, phoneStatus } from './screens-worker.js';
import { gameBanner } from './screens-game.js';

const need = () => !S.user.roles.includes('contractor');
const BASE_TAGS = ['18+', 'Опыт склада', 'Права категории B', 'Самозанятость'];

const shiftRow = (s, extra = '') => `<div class="card click" data-act="open" data-id="${s.id}"><div class="row sp"><b>${esc(s.title)}</b>${statusTag(s.status)}</div>
  <div class="mut sm">${esc(dateLabel(s.date))} · ${esc(timeRange(s))} · ${esc(payLabel(s))}</div><div class="row sp sm" style="margin-top:6px"><span>👥 ${s.accepted_count} / ${s.people}</span>${s.ended && ['open', 'full'].includes(s.status) ? '<span class="tag o">Время прошло — завершите смену</span>' : ''}${s.pending_count ? `<span class="tag g">${s.pending_count} ${plural(s.pending_count, 'новый отклик', 'новых отклика', 'новых откликов')}</span>` : ''}</div>${extra}</div>`;

async function home(ctx) {
  if (need()) return go('#/c/onboard');
  // вернулись из бота с подтверждённым номером, а смена ждёт публикации — продолжаем её
  if (S.user.draft_pending && S.user.phone_verified) return go('#/c/create');
  const load = async () => {
    const [st, list] = await Promise.all([api.contractorStats(), api.myShifts()]);
    const act = list.filter((s) => ['open', 'full'].includes(s.status)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const html = `<h1>Главная</h1><div class="grid2" style="margin:10px 0"><button class="stat" data-act="go" data-to="#/c/shifts/act"><b>${st.active}</b>Активные смены</button><button class="stat" data-act="go" data-to="#/c/shifts/new"><b>${st.new_applications}</b>Новые отклики</button><button class="stat" data-act="go" data-to="#/c/workers"><b>${st.workers}</b>Исполнители</button><button class="stat o" data-act="go" data-to="#/c/shifts/done"><b>${st.done}</b>Завершённые</button></div>
      <button class="btn pri block" data-act="create" style="padding:15px">＋ Опубликовать смену</button>
      <button class="btn block" data-act="go" data-to="#/c/fav" style="margin-top:8px">★ Избранные исполнители</button>${CONFIG.GAME_ENABLED ? gameBanner() : ''}
      <h2>Открытые смены</h2>${act.length ? act.slice(0, 20).map((s) => shiftRow(s)).join('') : `<div class="empty"><h2>У вас пока нет открытых смен.</h2></div>`}`;
    if (ctx.main.dataset.h !== html) { ctx.main.innerHTML = html; ctx.main.dataset.h = html; }
  };
  ctx.main.dataset.h = ''; await load(); ctx.poll = load;
  ctx.acts.create = () => go('#/c/create'); ctx.acts.open = (el) => go('#/c/shift/' + el.dataset.id); ctx.acts.go = (el) => go(el.dataset.to);
}

async function shifts(ctx, mode) {
  if (need()) return go('#/c/onboard');
  let tab = mode === 'new' ? 'new' : mode === 'done' ? 'done' : 'act';
  const entryTitle = { act: 'Активные смены', new: 'Новые отклики', done: 'Завершённые смены' }[mode];   // зашли с плитки на главной — показываем «Назад»
  const ACT = ['open', 'full'];
  const T = [['act', 'Активные', (s) => ACT.includes(s.status)], ['new', 'С откликами', (s) => ACT.includes(s.status) && s.pending_count > 0], ['done', 'Завершённые', (s) => s.status === 'completed', 'o'], ['off', 'Отменённые', (s) => s.status === 'cancelled']];
  let list = [];
  const draw = () => {
    const cur = T.find((t) => t[0] === tab), l = list.filter(cur[2]);
    const html = `${entryTitle ? pageHead(entryTitle, '<button class="btn pri sm" data-act="create">＋ Создать</button>') : '<div class="row sp"><h1>Смены</h1><button class="btn pri sm" data-act="create">＋ Создать</button></div>'}<div class="tabsx">${T.map(([k, t, f, c]) => `<span class="chip ${c || ''} ${tab === k ? 'on' : ''}" data-act="tab" data-t="${k}">${t} · ${list.filter(f).length}</span>`).join('')}</div>${l.length ? l.map((s) => shiftRow(s)).join('') : emptyState(tab === 'act' ? 'У вас пока нет открытых смен.' : tab === 'new' ? 'Новых откликов нет' : 'Здесь пока пусто', '', tab === 'act' ? '<button class="btn pri" data-act="create">Создать смену</button>' : '')}`;
    if (ctx.main.dataset.h !== html) { ctx.main.innerHTML = html; ctx.main.dataset.h = html; }
  };
  const load = async () => { list = await api.myShifts(); draw(); };
  ctx.main.dataset.h = ''; await load(); ctx.poll = load;
  ctx.acts.tab = (el) => { tab = el.dataset.t; draw(); }; ctx.acts.create = () => go('#/c/create'); ctx.acts.open = (el) => go('#/c/shift/' + el.dataset.id);
}

// ---------- мои исполнители ----------
async function workers(ctx) {
  if (need()) return go('#/c/onboard');
  const list = await api.myWorkers();
  ctx.render(`${pageHead('Мои исполнители')}<p class="mut sm">Люди, которых вы принимали на свои смены</p>${list.length ? list.map((w) => `<div class="card click row" data-act="p" data-id="${w.user_id}">${avatar(w.avatar, w.name)}<div class="grow"><b>${esc(w.name)}</b> ${verifiedTag(w.verified, 'Проверен')}<div class="sm">${stars(w.rating, w.reviews)} · ${w.together} ${plural(w.together, 'смена', 'смены', 'смен')} с вами</div></div>›</div>`).join('') : emptyState('Пока никого', 'Исполнители появятся здесь после того, как вы примете отклики.')}`);
  ctx.acts.p = (el) => go('#/c/worker/' + el.dataset.id);
}

// ---------- создание и изменение смены ----------
// Порядок полей задан ТЗ от 05.11.2026: что сделать, адрес, дата и люди, время, оплата, срок выплаты, «Дополнительно»
async function createOrEdit(ctx, id) {
  const editing = !!id; id = Number(id);
  if (need()) return go('#/c/onboard');
  const old = editing ? await api.getShift(id) : null;
  if (old && old.contractor_id !== S.user.id) return go('#/c/home');
  // черновик на сервере: без подтверждённого номера смену можно заполнить, а опубликовать — после подтверждения
  const draft = editing ? null : await api.getShiftDraft();
  const d = old || (draft && draft.form) || {};
  const reqs = new Set(d.requirements || []); const custom = (d.requirements || []).filter((r) => !BASE_TAGS.includes(r));
  let geo = d.lat != null ? { lat: d.lat, lng: d.lng, region: d.region } : null;
  const reqId = (draft && draft.reqId) || uid(); // ключ идемпотентности: двойное нажатие «Опубликовать» или возврат из бота не создадут две смены
  const lock = editing ? 'disabled' : '';
  // у старых смен и черновиков описания могло не быть — тогда показываем прежнее название, чтобы текст не потерялся
  const text = shiftText(d);
  ctx.render(reqMark(`${pageHead(editing ? 'Изменить смену' : 'Новая смена')}${editing ? '<p class="mut sm">Можно менять описание, время, количество людей, оплату, срок выплаты и требования. Для другого адреса или даты создайте новую смену.</p>' : draft ? '<div class="card row sp"><span class="sm">Черновик восстановлен</span><a class="g sm" href="#" data-act="dropDraft">Очистить</a></div>' : ''}
    <label class="f">Что нужно сделать? *</label><textarea class="i" id="desc" rows="4" maxlength="3000" placeholder="Опишите работу: что нужно сделать, какой объём и что взять с собой">${esc(text)}</textarea>
    <label class="f">Адрес *</label><div class="row gap"><input class="i" id="addr" value="${esc(d.address || '')}" placeholder="Город, улица, дом" autocomplete="off" ${lock}>${editing ? '' : '<button class="btn" data-act="pin" aria-label="На карте">📍</button>'}</div><div class="sm ${geo ? 'g' : 'mut'}" id="geo">${geo ? '✓ Адрес на карте указан' : 'Начните вводить адрес и выберите его из подсказок'}</div>
    <div class="pair"><div><label class="f">Дата *</label><input class="i" id="date" type="date" min="${todayISO()}" value="${esc(d.date || addDays(todayISO(), 1))}" ${lock}></div><div><label class="f">Людей *</label><input class="i" id="people" type="number" inputmode="numeric" min="1" value="${esc(d.people || '')}"></div></div>
    <div class="pair"><div><label class="f">Начало *</label><input class="i" id="start" type="time" value="${esc(d.start || '09:00')}"></div><div><label class="f">Окончание *</label><input class="i" id="end" type="time" value="${d.until_done ? '' : esc(d.end || '18:00')}" ${d.until_done ? 'disabled' : ''}></div></div>
    <div class="row sp" style="margin:10px 0"><span>До выполнения задачи<div class="mut sm">Без точного времени окончания: работаем, пока задача не сделана</div></span>${toggle(!!d.until_done, 'ud', 'id="ud"')}</div>
    <label class="f">Как платите</label><div class="seg" id="pt"><span class="chip" data-act="pt" data-v="shift">За смену</span><span class="chip" data-act="pt" data-v="hour">В час</span></div>
    <label class="f" id="paylbl">Оплата за смену, ₽ *</label><input class="i" id="pay" type="number" inputmode="numeric" min="1" value="${esc(d.pay || '')}"><p class="hint" id="payhint">На одного человека</p>
    <label class="f">Когда выплатите? *</label><select class="i" id="po"><option value="">Выберите срок выплаты</option>${PAYOUT.map(([v, t]) => `<option value="${v}" ${d.payout_kind === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <div id="podbox" ${d.payout_kind === 'date' ? '' : 'hidden'}><label class="f">Дата выплаты *</label><input class="i" id="pod" type="date" value="${esc(d.payout_date || '')}"><p class="hint" id="podhint"></p></div>
    <button class="more" type="button" data-act="more" aria-expanded="false" aria-controls="morebox"><span class="grow"><b>Дополнительно</b><span class="mut sm" id="moresub"></span></span>${ICON.chev}</button>
    <div id="morebox" hidden><label class="f">Требования</label><div class="row wrap gap" id="reqs"></div>
    ${editing ? '' : `<div class="row sp" style="margin:14px 0 4px"><span>Уведомить работников из избранного<div class="mut sm">Это не приглашение и не подтверждение</div></span>${toggle(!!d.notify_favorites, 'tg', 'id="nf"')}</div>`}</div>
    <button class="btn pri block" data-act="save" style="margin-top:16px">${editing ? 'Сохранить' : 'Опубликовать смену'}</button>`));
  const $ = (i) => document.getElementById(i);
  const val = (i) => $(i).value;
  // «Дополнительно» свёрнуто; в подписи видно, что внутри уже выбрано
  const moreSub = () => { const n = reqs.size, nf = $('nf')?.classList.contains('on'); $('moresub').textContent = n || nf ? [n && `${n} ${plural(n, 'требование', 'требования', 'требований')}`, nf && 'уведомим избранных'].filter(Boolean).join(' · ') : 'Требования и уведомления в избранном'; };
  const drawReqs = () => { $('reqs').innerHTML = [...BASE_TAGS, ...custom].map((r) => `<span class="chip ${reqs.has(r) ? 'on' : ''}" data-act="req" data-r="${esc(r)}">${esc(r)}</span>`).join('') + '<span class="chip" data-act="addreq">＋ Своё</span>'; moreSub(); };
  drawReqs();
  ctx.acts.more = (el) => { const open = $('morebox').hidden; $('morebox').hidden = !open; el.setAttribute('aria-expanded', open); };
  // оплата «за смену / в час» и «до выполнения задачи»
  let ptype = d.pay_type || 'shift';
  const ud = () => $('ud').classList.contains('on');
  // конкретная дата выплаты — не раньше окончания смены, а без точного окончания — не раньше даты начала. Проверяем при каждом изменении даты и времени
  const shiftNow = () => ({ date: val('date'), start: val('start'), end: val('end'), until_done: ud() });
  const podMin = () => (val('date') ? payoutMinDay(shiftNow()) : todayISO());
  const podErr = () => (ud() ? 'Дата выплаты не может быть раньше даты смены' : 'Дата выплаты не может быть раньше окончания смены');
  const syncPayout = () => {
    const isDate = val('po') === 'date', min = podMin(), pod = $('pod');
    $('podbox').hidden = !isDate; pod.min = min; $('podhint').textContent = `Не раньше ${dateLong(min)}`;
    // после текущего события: подсветка поля сама снимается на «input», здесь ставим её заново, если дата всё ещё раньше допустимой
    setTimeout(() => { if (val('po') === 'date' && pod.value && pod.value < podMin()) markError(pod, podErr()); else clearError(pod); });
  };
  const syncPay = () => {
    document.querySelectorAll('#pt [data-v]').forEach((c) => c.classList.toggle('on', c.dataset.v === ptype));
    $('paylbl').innerHTML = (ptype === 'hour' ? 'Оплата в час, ₽' : 'Оплата за смену, ₽') + ' <span class="req">*</span>';
    const end = $('end'), on = ud(); end.disabled = on; if (on) end.value = ''; else if (!end.value) end.value = '18:00';
    const pay = Number(val('pay')); let h = 8;
    if (!on && val('start') && val('end')) { const [a, b] = [val('start'), val('end')].map((t) => { const [x, y] = t.split(':'); return +x * 60 + +y; }); h = ((b - a + 1440) % 1440) / 60 || 1; }
    $('payhint').textContent = 'На одного человека' + (ptype === 'hour' && pay > 0 ? ` · ≈ ${money(Math.round(pay * h))} за ${on ? '8 часов' : Math.round(h * 10) / 10 + ' ч'}` : '');
    syncPayout();
  };
  ['pay', 'start', 'end', 'date'].forEach((i) => $(i).addEventListener('input', syncPay));
  $('po').addEventListener('change', syncPayout); $('pod').addEventListener('input', syncPayout);
  ctx.acts.pt = (el) => { ptype = el.dataset.v; syncPay(); };
  ctx.acts.ud = (el) => { el.classList.toggle('on'); el.setAttribute('aria-checked', el.classList.contains('on')); syncPay(); };
  syncPay();
  ctx.acts.req = (el) => { const r = el.dataset.r; reqs.has(r) ? reqs.delete(r) : reqs.add(r); drawReqs(); }; // повторное нажатие отключает тег
  ctx.acts.tg = (el) => { el.classList.toggle('on'); moreSub(); };
  ctx.acts.addreq = () => {
    const s = sheet('<h3>Своё требование</h3><input class="i" id="nr" maxlength="40" placeholder="Например: опыт с мебелью"><button class="btn pri block" style="margin-top:12px" id="ok">Добавить</button>');
    s.el.querySelector('#ok').onclick = () => {
      const nr = s.el.querySelector('#nr'), t = nr.value.trim();
      if (!validate([[nr, t.length >= 2, 'Напишите требование']])) return;
      if (![...BASE_TAGS, ...custom].includes(t)) custom.push(t);
      reqs.add(t); drawReqs(); s.close();
    };
  };
  // ----- адрес: проверка существования через DaData (до номера дома) -----
  const addrEl = $('addr');
  let geoFor = geo ? addrEl.value : null, checkSeq = 0; // для какого текста адреса найдена точка
  const geoInfo = (t, cls) => { const el = $('geo'); if (el) { el.className = 'sm ' + cls; el.textContent = t; } };
  const setGeo = (p, address, text) => { geo = { lat: p.lat, lng: p.lng, region: p.region }; if (address) addrEl.value = address; geoFor = addrEl.value; geoInfo(text, 'g'); };
  const checkAddr = async () => {
    const q = addrEl.value.trim(), my = ++checkSeq;
    if (geo && q === geoFor) return true;
    geo = null; if (q.length < 3) { geoInfo('Начните вводить адрес и выберите его из подсказок', 'mut'); return false; }
    geoInfo('Проверяем адрес…', 'mut');
    let g; try { g = await geocode(q); } catch (e) { geoInfo('Не удалось проверить адрес: ' + e.message + '. Укажите точку 📍', 'r'); return false; }
    if (my !== checkSeq) return !!geo; // пока проверяли, адрес изменили
    if (!g) { geoInfo('✗ Такой адрес не найден. Проверьте город, улицу и дом или укажите точку 📍', 'r'); return false; }
    if (!g.region) { geoInfo('✗ Мы работаем только в Москве и Московской области', 'r'); return false; }
    if (!g.house) { geoInfo(`⚠ Не хватает номера дома: «${g.address}». Выберите дом из подсказок или поставьте точку 📍`, 'y'); return false; }
    if (!g.ok) { geoInfo(`⚠ Дом найден, но без координат: «${g.address}». Поставьте точку на карте 📍`, 'y'); return false; }
    setGeo(g, g.address, '✓ Адрес найден'); return true;
  };
  if (!editing) {
    addrEl.addEventListener('input', () => { if (addrEl.value.trim() !== geoFor) { geo = null; geoInfo('Выберите адрес из подсказок — так мы проверим, что он существует', 'mut'); } });
    addrEl.addEventListener('change', () => setTimeout(checkAddr, 250)); // даём сработать выбору из подсказок
    attachSuggest(addrEl, (g) => (g.ok ? setGeo(g, g.address, '✓ Адрес найден') : checkAddr()));
  }
  ctx.acts.pin = async () => {
    const r = await pickLocation({ ...(geo || {}), query: val('addr') });
    if (r) setGeo(r, r.address, r.ok ? '✓ Адрес указан на карте' : '✓ Точка на карте указана — проверьте текст адреса');
  };
  // общие проверки для создания и изменения
  const checks = () => {
    const ppl = Number(val('people')), pay = Number(val('pay')), po = val('po');
    return [
      [$('desc'), val('desc').trim().length >= 3, 'Опишите, что нужно сделать'],
      [$('people'), Number.isInteger(ppl) && ppl >= 1 && ppl <= 500, 'Сколько людей нужно (1–500)'],
      [$('start'), !!val('start'), 'Укажите время начала'],
      [$('end'), ud() || (!!val('end') && val('end') !== val('start')), val('end') ? 'Окончание совпадает с началом' : 'Укажите время окончания или «до выполнения задачи»'],
      [$('pay'), Number.isInteger(pay) && pay >= 1 && pay <= 1000000, pay > 1000000 ? 'Слишком большая сумма (до 1 000 000 ₽)' : 'Укажите сумму оплаты в рублях'],
      [$('po'), !!po, 'Выберите срок выплаты'],
      ...(po === 'date' ? [[$('pod'), !!val('pod') && val('pod') >= podMin(), val('pod') ? podErr() : 'Укажите дату выплаты']] : []),
    ];
  };
  const payout = () => ({ payout_kind: val('po'), payout_date: val('po') === 'date' ? val('pod') : null });
  ctx.acts.save = async () => {
    if (editing) {
      if (!validate(checks())) return;
      await api.updateShift(id, { description: val('desc').trim(), pay: val('pay'), pay_type: ptype, until_done: ud(), people: val('people'), start: val('start'), end: val('end'), requirements: [...reqs], ...payout() });
      toast('Смена обновлена', 'ok'); return go('#/c/shift/' + id);
    }
    const addrOk = await checkAddr();
    const list = checks();
    list.splice(1, 0, [addrEl, addrOk, val('addr').trim() ? 'Адрес не найден — выберите его из подсказок или поставьте точку 📍' : 'Укажите адрес'], [$('date'), !!val('date') && val('date') >= todayISO(), val('date') ? 'Дата уже прошла' : 'Укажите дату']);
    if (!validate(list)) return;
    const form = { description: val('desc').trim(), address: val('addr'), lat: geo.lat, lng: geo.lng, date: val('date'), start: val('start'), end: val('end'), pay: val('pay'), pay_type: ptype, until_done: ud(), region: geo.region, people: val('people'), requirements: [...reqs], notify_favorites: $('nf').classList.contains('on'), ...payout() };
    // номер ещё не подтверждён: сохраняем черновик и просим подтвердить; запрет публикации проверяет и сервер
    if (!S.user.phone_verified) return holdForPhone(form);
    let s;
    try { s = await api.createShift(form, reqId); }
    catch (e) { if (e.code === 'phone_unverified') { await refreshMe(); return holdForPhone(form); } throw e; }
    S.user.draft_pending = false; publishing = false;
    track('shift_created', { id: s.id }); toast('Смена опубликована', 'ok'); go('#/c/shift/' + s.id);
  };
  let publishing = false;
  async function holdForPhone(form) {
    await api.saveShiftDraft({ form, reqId, pending: true });
    S.user.draft_pending = true; publishing = true;
    askPhone('Смена сохранена как черновик. После подтверждения номера она опубликуется автоматически.');
  }
  // вернулись из бота: статус обновился сам (опрос в main.js), публикуем смену из того же черновика
  if (!editing) ctx.poll = async () => { if (publishing && S.user.phone_verified) { publishing = false; toast('Номер подтверждён — публикуем смену'); await ctx.acts.save(); } };
  ctx.acts.dropDraft = async () => { await api.deleteShiftDraft(); S.user.draft_pending = false; toast('Черновик очищен'); createOrEdit(ctx); };
  // приложение закрывалось на время подтверждения: черновик ждёт публикации
  if (draft && draft.pending) { if (S.user.phone_verified) { toast('Номер подтверждён — публикуем смену'); await ctx.acts.save(); } else publishing = true; }
}

// ---------- страница смены подрядчика ----------
async function shiftPage(ctx, id) {
  id = Number(id);
  const load = async () => {
    const [s, apps] = await Promise.all([api.getShift(id), api.applicants(id)]);
    const active = ['open', 'full'].includes(s.status), owner = s.contractor_id === S.user.id;
    const groups = [['pending', 'Новые отклики'], ['accepted', 'Приняты'], ['completed', 'Участвовали'], ['rejected', 'Отклонены'], ['cancelled', 'Отказались / исключены']];
    const html = `${pageHead('Смена')}<div class="card"><div class="row sp" style="align-items:flex-start;gap:10px"><h2 class="sh-full" style="margin:0">${esc(shiftText(s))}</h2><span style="flex:none">${s.boosted ? '<span class="tag o">⚡ В топе</span> ' : ''}${statusTag(s.status)}</span></div><div class="mut sm" style="margin:6px 0">${esc(dateLabel(s.date))} · ${esc(timeRange(s))} · ${esc(payLabel(s))}${payNote(s) ? ` (${esc(payNote(s))})` : ''}<br>${esc(s.address)}</div><div class="sm payout">${esc(payoutDetail(s))}</div>
      <div class="row sp sm"><span>👥 ${s.accepted_count} / ${s.people}</span></div><div class="bar" style="margin:6px 0"><i style="width:${Math.min(100, (s.accepted_count / s.people) * 100)}%"></i></div>
      ${(s.requirements || []).map((r) => `<span class="tag">${esc(r)}</span> `).join('')}
      ${active ? (owner ? '<div class="row gap wrap" style="margin-top:12px"><button class="btn sm" data-act="edit">Изменить</button><button class="btn sm" data-act="team">Команда и чат</button><button class="btn sm pri" data-act="fin">Смена завершена</button>' + (CONFIG.PRO_ENABLED ? '<button class="btn sm" data-act="boost">⚡ В топ</button>' : '') + '<button class="btn sm danger" data-act="cancel">Отменить</button></div>' : '<div class="row gap wrap" style="margin-top:12px"><button class="btn sm" data-act="team">Команда и чат</button></div><p class="mut sm">Вы — админ чата этой смены: можно принимать и отклонять отклики.</p>') : (s.status === 'completed' ? '<div class="row gap" style="margin-top:12px"><button class="btn sm" data-act="team">Команда</button><button class="btn sm pri" data-act="rate">Оценить исполнителей</button></div>' : '')}</div>
      <h2>Отклики · ${apps.length}</h2>${apps.length ? groups.map(([st, t]) => { const l = apps.filter((a) => a.status === st); return l.length ? `<div class="mut sm" style="margin:12px 0 4px">${t} · ${l.length}</div>` + l.map((a) => cand(a, active, s.status === 'open')).join('') : ''; }).join('') : '<p class="mut">Пока никто не откликнулся.</p>'}`;
    if (ctx.main.dataset.h !== html && !document.querySelector('.ov')) { ctx.main.innerHTML = html; ctx.main.dataset.h = html; }
    ctx.shiftData = { s, apps };
  };
  const cand = (a, active, canAccept) => { const w = a.worker || {}; return `<div class="card"><div class="row click" data-act="prof" data-id="${a.worker_id}">${avatar(w.avatar, w.name)}<div class="grow"><b>${esc(w.name)}</b> ${w.pro ? proBadge() : ''}${verifiedTag(w.verified, 'Проверен')}<div class="sm">${stars(w.rating, w.reviews)} · ${w.shifts_done} ${plural(w.shifts_done, 'смена', 'смены', 'смен')}</div>${(w.skills || []).length ? `<div class="mut sm">${esc(w.skills.slice(0, 4).join(', '))}</div>` : ''}</div>${statusTag(a.status)}</div>
    <div class="row gap" style="margin-top:10px"><button class="btn sm grow" data-act="dm" data-app="${a.id}">Написать</button>${a.status === 'pending' && active ? `<button class="btn sm danger" data-act="dec" data-app="${a.id}" data-d="rejected" data-n="${esc(w.name)}">Отклонить</button>${canAccept ? `<button class="btn sm pri" data-act="dec" data-app="${a.id}" data-d="accepted" data-n="${esc(w.name)}">Принять</button>` : ''}` : ''}</div></div>`; };
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
  // «Поднять в топ»: смена на 6 часов выше всех в ленте (PRO, 3 раза в месяц)
  ctx.acts.boost = async () => {
    const sub = await api.mySubscription();
    if (!sub.active) { if (await confirmBox('Поднять в топ — функция PRO', { ok: 'Что даёт PRO', cancel: 'Закрыть', sub: 'Смена на 6 часов окажется выше всех в ленте. 3 раза в месяц.' })) go('#/pro'); return; }
    if (!(await confirmBox('Поднять смену в топ?', { ok: 'Поднять', sub: `Смена будет выше всех в ленте 6 часов. Осталось поднятий в этом месяце: ${sub.boosts_limit - sub.boosts_used}.` }))) return;
    await api.boostShift(id); haptic('success'); tick('done'); toast('Смена в топе ленты на 6 часов ⚡', 'ok'); await load();
  };
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
  const activeBlock = P.active.length ? sect('Активные задания') + P.active.map((a) => `<div class="card"><b>${esc(a.title)}</b><div class="mut sm">${esc(dateLabel(a.date))} · ${esc(timeRange(a))}</div></div>`).join('') + (P.active_count > P.active.length ? `<p class="mut sm">Всего активных заданий: ${P.active_count}</p>` : '') : P.active_count ? `<p class="mut sm">Сейчас занят на ${P.active_count} ${plural(P.active_count, 'смене', 'сменах', 'сменах')}</p>` : '';
  ctx.render(`${pageHead('Кандидат', '<button class="iconbtn" data-act="rep">⚑</button>')}${profileBlock(w)}${activeBlock}
    <button class="btn block ${P.is_fav ? '' : 'pri'}" data-act="fav">${P.is_fav ? '★ В избранном' : '☆ В избранное'}</button>
    ${reviewsBlock(P.reviews, w.reviews, 'worker', wid)}`);
  bindReviews(ctx);
  ctx.acts.fav = async () => { const on = await api.toggleFav(wid); toast(on ? 'Добавлено в избранное' : 'Убрано из избранного', 'ok'); workerPage(ctx, wid); };
  ctx.acts.rep = () => reportSheet('worker', wid);
}

async function fav(ctx) {
  const list = await api.favorites('worker');
  ctx.render(`${pageHead('Избранные исполнители')}<p class="mut sm">Исполнители, с которыми вы хотите работать снова</p>${list.length ? list.map((w) => `<div class="card click row" data-act="p" data-id="${w.user_id}">${avatar(w.avatar, w.name)}<div class="grow"><b>${esc(w.name)}</b> ${w.pro ? proBadge() : ''}${verifiedTag(w.verified, 'Проверен')}<div class="sm">${stars(w.rating, w.reviews)} · ${w.shifts_done} ${plural(w.shifts_done, 'смена', 'смены', 'смен')}</div></div>›</div>`).join('') : emptyState('Пока пусто', 'Добавляйте исполнителей в избранное в их профиле.')}`);
  ctx.acts.p = (el) => go('#/c/worker/' + el.dataset.id);
}

async function profile(ctx) {
  const u = await refreshMe(), c = u.contractor, R = await api.userReviews(u.id, 'contractor', 0).catch(() => null);
  ctx.render(`${heroCard({ rev: ['contractor', u.id, c.reviews], pro: c.pro, av: c.avatar, name: c.name, verified: c.verified, sub: c.company ? esc(c.company) : '', tags: verifiedTag(c.verified, 'Проверенный подрядчик'),
      stats: [[c.rating == null ? '—' : c.rating.toFixed(1) + ' <small class="star">★</small>', c.reviews ? `${c.reviews} ${plural(c.reviews, 'отзыв', 'отзыва', 'отзывов')}` : 'нет оценок'], [c.shifts_done, plural(c.shifts_done, 'смена', 'смены', 'смен')], [esc(c.city || '—'), 'город']] })}
    ${c.about ? `<div class="about">${esc(c.about)}</div>` : ''}
    ${phoneStatus(u, u.phone_verified ? 'можно публиковать смены' : 'публиковать смены')}
    ${CONFIG.GAME_ENABLED ? gameBanner() : ''}${proCard(u)}${reviewsBlock(R ? R.items.slice(0, 5) : [], R ? R.total : 0, 'contractor', u.id)}<button class="btn block" data-act="edit" style="margin-top:6px">${ICON.edit}Редактировать профиль</button><div style="height:8px"></div>${roleSwitch()}${devPanel(u)}${helpBlock()}`);
  bindCommonProfile(ctx, u); bindReviews(ctx); ctx.acts.edit = () => go('#/c/edit-profile');
  ctx.poll = async () => { if (!u.phone_verified && S.user.phone_verified) profile(ctx); };   // подтвердили в боте — обновляем статус
}

export const contractorRoutes = [
  [/^#\/c\/home$/, home], [/^#\/c\/shifts(?:\/(act|new|done))?$/, shifts], [/^#\/c\/workers$/, workers], [/^#\/c\/create$/, createOrEdit], [/^#\/c\/edit\/(\d+)$/, createOrEdit], [/^#\/c\/shift\/(\d+)$/, shiftPage],
  [/^#\/c\/worker\/(\d+)$/, workerPage], [/^#\/c\/fav$/, fav], [/^#\/c\/profile$/, profile],
];
