// Экраны подрядчика
import { api, track } from './api.js';
import { S, go, toast, errMsg, sheet, confirmBox, avatar, stars, pageHead, emptyState, verifiedTag, statusTag, toggle, refreshMe, validate, reqMark, heroCard, infoRows, sect, ICON } from './ui.js';
import { pickLocation, geocode, attachSuggest } from './maps.js';
import { esc, dateLabel, money, todayISO, addDays, uid, plural, fmtPhone, timeRange, payLabel, payNote } from './util.js';
import { reportSheet, finishShift, shiftName } from './screens-common.js';
import { profileBlock, roleSwitch, devPanel, bindCommonProfile, helpBlock } from './screens-worker.js';

const need = () => !S.user.roles.includes('contractor');
const BASE_TAGS = ['18+', 'Опыт склада', 'Права категории B', 'Медкнижка', 'Самозанятость'];

const shiftRow = (s, extra = '') => `<div class="card click" data-act="open" data-id="${s.id}"><div class="row sp"><b>${esc(s.title)}</b>${statusTag(s.status)}</div>
  <div class="mut sm">${esc(dateLabel(s.date))} · ${esc(timeRange(s))} · ${esc(payLabel(s))}</div><div class="row sp sm" style="margin-top:6px"><span>👥 ${s.accepted_count} / ${s.people}</span>${s.pending_count ? `<span class="tag g">${s.pending_count} ${plural(s.pending_count, 'новый отклик', 'новых отклика', 'новых откликов')}</span>` : ''}</div>${extra}</div>`;

async function home(ctx) {
  if (need()) return go('#/c/onboard');
  const load = async () => {
    const [st, list] = await Promise.all([api.contractorStats(), api.myShifts()]);
    const act = list.filter((s) => ['open', 'full'].includes(s.status)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const html = `<h1>Главная</h1><div class="grid2" style="margin:10px 0"><button class="stat" data-act="go" data-to="#/c/shifts"><b>${st.active}</b>Активные смены</button><button class="stat" data-act="go" data-to="#/c/shifts/new"><b>${st.new_applications}</b>Новые отклики</button><button class="stat" data-act="go" data-to="#/c/workers"><b>${st.workers}</b>Исполнители</button><button class="stat o" data-act="go" data-to="#/c/shifts/done"><b>${st.done}</b>Завершённые</button></div>
      <button class="btn pri block" data-act="create" style="padding:15px">＋ Опубликовать смену</button>
      <button class="btn block" data-act="go" data-to="#/c/fav" style="margin-top:8px">★ Избранные исполнители</button>
      <h2>Открытые смены</h2>${act.length ? act.slice(0, 20).map((s) => shiftRow(s)).join('') : `<div class="empty"><h2>У вас пока нет открытых смен.</h2></div>`}`;
    if (ctx.main.dataset.h !== html) { ctx.main.innerHTML = html; ctx.main.dataset.h = html; }
  };
  ctx.main.dataset.h = ''; await load(); ctx.poll = load;
  ctx.acts.create = () => go('#/c/create'); ctx.acts.open = (el) => go('#/c/shift/' + el.dataset.id); ctx.acts.go = (el) => go(el.dataset.to);
}

async function shifts(ctx, mode) {
  if (need()) return go('#/c/onboard');
  let tab = mode === 'new' ? 'new' : mode === 'done' ? 'done' : 'act';
  const ACT = ['open', 'full'];
  const T = [['act', 'Активные', (s) => ACT.includes(s.status)], ['new', 'Новые отклики', (s) => ACT.includes(s.status) && s.pending_count > 0], ['done', 'Завершённые', (s) => s.status === 'completed', 'o'], ['off', 'Отменённые', (s) => s.status === 'cancelled']];
  let list = [];
  const draw = () => {
    const cur = T.find((t) => t[0] === tab), l = list.filter(cur[2]);
    const html = `<div class="row sp"><h1>Смены</h1><button class="btn pri sm" data-act="create">＋ Создать</button></div><div class="tabsx">${T.map(([k, t, f, c]) => `<span class="chip ${c || ''} ${tab === k ? 'on' : ''}" data-act="tab" data-t="${k}">${t} · ${list.filter(f).length}</span>`).join('')}</div>${l.length ? l.map((s) => shiftRow(s)).join('') : emptyState(tab === 'act' ? 'У вас пока нет открытых смен.' : tab === 'new' ? 'Новых откликов нет' : 'Здесь пока пусто', '', tab === 'act' ? '<button class="btn pri" data-act="create">Создать смену</button>' : '')}`;
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

// ---------- создание ----------
// Прототип «ИИ-помощника»: разбор обычной фразы правилами. Точка расширения — api.aiParseShift (LLM на сервере).
// \b в JS не работает с кириллицей — границы слова задаём явно
const W = (re) => new RegExp(`(^|[^а-яёa-z0-9])(?:${re})(?=[^а-яёa-z0-9]|$)`, 'i');
const NUM_WORDS = [['одн(?:ого|а|у)?|один', 1], ['дв(?:а|е|ое|ух)', 2], ['тр(?:и|ое|ёх|ех)', 3], ['четыр(?:е|ёх|ех)|четверо', 4], ['пят(?:ь|еро|и)', 5], ['шест(?:ь|еро|и)', 6], ['сем(?:ь|еро|и)', 7], ['восем(?:ь|ь?ми)|восьмеро', 8], ['девят(?:ь|ь?и)', 9], ['десят(?:ь|еро|и)', 10]];
const PEOPLE = '(?:человек[а]?|чел\\.?|грузчик[а-я]*|рабоч[а-я]*|работник[а-я]*|исполнител[а-я]*|помощник[а-я]*|промоутер[а-я]*|курьер[а-я]*|уборщ[а-я]*)';
// «2 грузчика» в названии → «Грузчики»; «4 человека» → убираем
const ROLE_TITLE = [[/грузчик/, 'Грузчики'], [/промоутер/, 'Промоутеры'], [/курьер/, 'Курьеры'], [/уборщ/, 'Уборщики'], [/помощник/, 'Помощники'], [/работник/, 'Работники'], [/рабоч/, 'Рабочие']];
const COLLECTIVE = 'двое|трое|четверо|пятеро|шестеро|семеро|восьмеро';
// порядок важен: более узкие категории — раньше
const CAT_RULES = [[/разгру[зж]|погру[зж]|выгру[зж]|фур[уаы]/, 'Погрузка / разгрузка'], [/грузчик|переезд|мебел|такелаж/, 'Грузчики'], [/склад|комплект|сборк[аи] заказ|сортиров/, 'Склад / комплектация'],
  [/убор|клининг|мыть|помыть|чистк/, 'Уборка'], [/курьер|доставк/, 'Курьеры'], [/промоут|листовк|флаер|раздач/, 'Промоутеры'], [/официант|кухн|повар|посуд|бармен|банкет/, 'Официанты / кухня'],
  [/монтаж|демонтаж|стройк|строит|ремонт|сварщ|бетон/, 'Монтаж / стройка'], [/разнорабоч/, 'Разнорабочие']];
const hh = (h, part) => { h = +h; if (/вечер|ночи|дня/.test(part || '') && h < 12) h += 12; return String(h % 24).padStart(2, '0'); };
export function parseShiftText(text) {
  const t = text.toLowerCase().replace(/ё/g, 'е'), out = {};
  // люди: «4 человека», «нужны четверо грузчиков», «двое»
  let m = t.match(new RegExp(`(\\d{1,3})\\s*${PEOPLE}`, 'i')); if (m) out.people = +m[1];
  if (!out.people) for (const [re, n] of NUM_WORDS) if (W(re.replace(/ё/g, 'е')).test(t)) { out.people = n; break; }
  // время: «с 9 до 18», «с 8:30 до 17:00», «с 9 утра до 6 вечера», «9-18»
  m = t.match(/(?:с\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(утра|дня|вечера|ночи)?\s*(?:до|по|-|–)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(утра|дня|вечера|ночи)?/);
  if (m && +m[1] <= 24 && +m[4] <= 24) { out.start = `${hh(m[1], m[3])}:${m[2] || '00'}`; out.end = `${hh(m[4], m[6])}:${m[5] || '00'}`; }
  // оплата: «оплата 4500», «по 3 000 ₽», «4500р», «4 тыс»
  // первая сумма от 100 ₽ («по 12» во времени — не оплата)
  for (const re of [/(?:оплата|платим|плачу|за смену|по|зп)\s*(\d[\d ]{0,7}\d|\d)\s*(тыс)?/g, /(\d[\d ]{1,7}\d)\s*(?:₽|р(?![а-я])|руб)/g, /(\d{1,3})\s*(тыс)/g]) {
    for (const x of t.matchAll(re)) { let p = +x[1].replace(/\s/g, ''); if (x[2]) p *= 1000; if (p >= 100 && p <= 1000000) { out.pay = p; break; } }
    if (out.pay) break;
  }
  if (/послезавтра/.test(t)) out.date = addDays(todayISO(), 2); else if (/завтра/.test(t)) out.date = addDays(todayISO(), 1); else if (/сегодня/.test(t)) out.date = todayISO();
  for (const [re, n] of CAT_RULES) if (re.test(t)) { const c = S.cats.find((x) => x.name === n); if (c) { out.category_id = c.id; break; } }
  // название: фраза без даты, «нужны», количества людей, времени и оплаты
  const roleWord = (s) => { const r = ROLE_TITLE.find(([re]) => re.test(s.toLowerCase())); return r ? ' ' + r[1] + ' ' : ' '; };
  let title = text
    .replace(/(?:оплата|платим|плачу|зп|по)\s*\d[\d ]*\s*(?:тыс[а-я.]*|₽|р\.?(?![а-я])|руб[а-я.]*)?(?:\s*за смену)?/gi, '')
    .replace(/\d[\d ]*\s*(?:тыс[а-я.]*|₽|р\.?(?![а-я])|руб[а-я.]*)(?:\s*за смену)?/gi, '').replace(/за смену/gi, '')
    .replace(/(?:с\s*)?\d{1,2}(?:[:.]\d{2})?\s*(?:утра|дня|вечера|ночи)?\s*(?:до|по|-|–)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:утра|дня|вечера|ночи)?/i, '')
    .replace(/(сегодня|послезавтра|завтра)/gi, '').replace(/(нуж(?:ен|на|но|ны)|требу[юе]тся|ищем|ищу|срочно)/gi, '')
    .replace(new RegExp(`\\d{1,3}\\s*${PEOPLE}`, 'gi'), roleWord).replace(new RegExp(`(?:${NUM_WORDS.map(([r]) => r).join('|')})\\s+${PEOPLE}`, 'gi'), roleWord)
    .replace(new RegExp(`(^|[^а-яё])(?:${COLLECTIVE})(?=[^а-яё]|$)`, 'gi'), '$1')
    .replace(/\s+([,.])/g, '$1').replace(/([,.])(?:\s*[,.])+/g, '$1').replace(/\s{2,}/g, ' ').replace(/^[\s,.\-–]+|[\s,.\-–]+$/g, '');
  title = title.charAt(0).toUpperCase() + title.slice(1);
  out.title = (title.length >= 3 ? title : (S.cats.find((c) => c.id === out.category_id) || {}).name || text.trim()).slice(0, 60);
  out.description = text.trim();
  return out;
}

async function createOrEdit(ctx, id) {
  const editing = !!id; id = Number(id);
  if (need()) return go('#/c/onboard');
  const old = editing ? await api.getShift(id) : null;
  if (old && old.contractor_id !== S.user.id) return go('#/c/home');
  const reqs = new Set(old ? old.requirements : []); const custom = (old ? old.requirements : []).filter((r) => !BASE_TAGS.includes(r));
  let geo = old && old.lat != null ? { lat: old.lat, lng: old.lng, region: old.region } : null;
  const reqId = uid(); // ключ идемпотентности: двойное нажатие «Создать» не создаст две смены
  const d = old || {};
  const lock = editing ? 'disabled' : '';
  ctx.render(reqMark(`${pageHead(editing ? 'Изменить смену' : 'Новая смена')}${editing ? '<p class="mut sm">Можно менять оплату, количество людей, время, требования и описание. Для другого места или вида работ создайте новую смену.</p>' : '<button class="btn block ghost" data-act="ai">✨ Заполнить с ИИ-ассистентом</button>'}
    <label class="f">Название смены *</label><input class="i" id="title" value="${esc(d.title || '')}" placeholder="Например: Разгрузка мебели" ${lock}>
    <label class="f">Категория *</label><select class="i" id="cat" ${lock}><option value="">Выберите…</option>${S.cats.map((c) => `<option value="${c.id}" ${d.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <label class="f">Описание</label><textarea class="i" id="desc" placeholder="Что нужно делать">${esc(d.description || '')}</textarea>
    <label class="f">Адрес *</label><div class="row gap"><input class="i" id="addr" value="${esc(d.address || '')}" placeholder="Город, улица, дом" autocomplete="off" ${lock}>${editing ? '' : '<button class="btn" data-act="pin" aria-label="На карте">📍</button>'}</div><div class="sm ${geo ? 'g' : 'mut'}" id="geo">${geo ? '✓ Адрес на карте указан' : 'Начните вводить адрес и выберите его из подсказок'}</div>
    <div class="grid2"><div><label class="f">Дата *</label><input class="i" id="date" type="date" min="${todayISO()}" value="${esc(d.date || addDays(todayISO(), 1))}" ${lock}></div><div><label class="f">Людей *</label><input class="i" id="people" type="number" inputmode="numeric" min="1" value="${esc(d.people || '')}"></div></div>
    <div class="grid2"><div><label class="f">Начало *</label><input class="i" id="start" type="time" value="${esc(d.start || '09:00')}"></div><div><label class="f">Окончание *</label><input class="i" id="end" type="time" value="${d.until_done ? '' : esc(d.end || '18:00')}" ${d.until_done ? 'disabled' : ''}></div></div>
    <div class="row sp" style="margin:10px 0"><span>До выполнения задачи<div class="mut sm">Без точного времени окончания: работаем, пока задача не сделана</div></span>${toggle(!!d.until_done, 'ud', 'id="ud"')}</div>
    <label class="f">Как платите</label><div class="seg" id="pt"><span class="chip" data-act="pt" data-v="shift">За смену</span><span class="chip" data-act="pt" data-v="hour">В час</span></div>
    <label class="f" id="paylbl">Оплата за смену, ₽ *</label><input class="i" id="pay" type="number" inputmode="numeric" min="1" value="${esc(d.pay || '')}"><p class="hint" id="payhint"></p>
    <label class="f">Требования</label><div class="row wrap gap" id="reqs"></div>
    ${editing ? '' : `<div class="row sp" style="margin:14px 0"><span>Уведомить работников из избранного<div class="mut sm">Это не приглашение и не подтверждение</div></span>${toggle(false, 'tg', 'id="nf"')}</div>`}
    <button class="btn pri block" data-act="save" style="margin-top:14px">${editing ? 'Сохранить' : 'Опубликовать смену'}</button>`));
  const drawReqs = () => { document.getElementById('reqs').innerHTML = [...BASE_TAGS, ...custom].map((r) => `<span class="chip ${reqs.has(r) ? 'on' : ''}" data-act="req" data-r="${esc(r)}">${esc(r)}</span>`).join('') + '<span class="chip" data-act="addreq">＋ Своё</span>'; };
  drawReqs();
  const val = (i) => document.getElementById(i).value;
  // оплата «за смену / в час» и «до выполнения задачи»
  let ptype = d.pay_type || 'shift';
  const ud = () => document.getElementById('ud').classList.contains('on');
  const syncPay = () => {
    document.querySelectorAll('#pt [data-v]').forEach((c) => c.classList.toggle('on', c.dataset.v === ptype));
    document.getElementById('paylbl').innerHTML = ptype === 'hour' ? 'Ставка за час, ₽ <span class="req">*</span>' : 'Оплата за смену, ₽ <span class="req">*</span>';
    const end = document.getElementById('end'), on = ud(); end.disabled = on; if (on) end.value = ''; else if (!end.value) end.value = '18:00';
    const pay = Number(val('pay')); let h = 8;
    if (!on && val('start') && val('end')) { const [a, b] = [val('start'), val('end')].map((t) => { const [x, y] = t.split(':'); return +x * 60 + +y; }); h = ((b - a + 1440) % 1440) / 60 || 1; }
    document.getElementById('payhint').textContent = ptype === 'hour' && pay > 0 ? `≈ ${money(Math.round(pay * h))} за ${on ? '8 часов' : Math.round(h * 10) / 10 + ' ч'}` : '';
  };
  ['pay', 'start', 'end'].forEach((i) => document.getElementById(i).addEventListener('input', syncPay));
  ctx.acts.pt = (el) => { ptype = el.dataset.v; syncPay(); };
  ctx.acts.ud = (el) => { el.classList.toggle('on'); el.setAttribute('aria-checked', el.classList.contains('on')); syncPay(); };
  syncPay();
  ctx.acts.req = (el) => { const r = el.dataset.r; reqs.has(r) ? reqs.delete(r) : reqs.add(r); drawReqs(); }; // повторное нажатие отключает тег
  ctx.acts.tg = (el) => el.classList.toggle('on');
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
  const addrEl = document.getElementById('addr');
  let geoFor = geo ? addrEl.value : null, checkSeq = 0; // для какого текста адреса найдена точка
  const geoInfo = (t, cls) => { const el = document.getElementById('geo'); if (el) { el.className = 'sm ' + cls; el.textContent = t; } };
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
  ctx.acts.ai = () => {
    const s = sheet('<h3>ИИ-ассистент</h3><p class="mut sm">Опишите смену обычными словами — мы предложим заполнение полей, а вы проверите.</p><textarea class="i" id="t" placeholder="Завтра нужны четыре человека разгружать мебель в Химках с 9 до 18, оплата 4500"></textarea><button class="btn pri block" style="margin-top:12px" id="ok">Заполнить</button>');
    s.el.querySelector('#ok').onclick = () => {
      const r = parseShiftText(s.el.querySelector('#t').value); s.close();
      const set = (i, v) => v != null && (document.getElementById(i).value = v);
      set('title', r.title); set('desc', r.description); set('people', r.people); set('start', r.start); set('end', r.end); set('pay', r.pay); set('date', r.date); set('cat', r.category_id);
      toast('Проверьте поля и укажите адрес на карте');
    };
  };
  const $ = (i) => document.getElementById(i);
  // общие проверки для создания и изменения
  const timeChecks = () => {
    const ppl = Number(val('people')), pay = Number(val('pay'));
    return [
      [$('people'), Number.isInteger(ppl) && ppl >= 1 && ppl <= 500, 'Сколько людей нужно (1–500)'],
      [$('start'), !!val('start'), 'Укажите время начала'],
      [$('end'), ud() || (!!val('end') && val('end') !== val('start')), val('end') ? 'Окончание совпадает с началом' : 'Укажите время окончания или «до выполнения задачи»'],
      [$('pay'), Number.isInteger(pay) && pay >= 1 && pay <= 1000000, pay > 1000000 ? 'Слишком большая сумма (до 1 000 000 ₽)' : 'Укажите оплату за смену в рублях'],
    ];
  };
  ctx.acts.save = async () => {
    if (editing) {
      if (!validate(timeChecks())) return;
      await api.updateShift(id, { pay: val('pay'), pay_type: ptype, until_done: ud(), people: val('people'), start: val('start'), end: val('end'), description: val('desc').trim(), requirements: [...reqs] });
      toast('Смена обновлена', 'ok'); return go('#/c/shift/' + id);
    }
    const addrOk = await checkAddr();
    if (!validate([
      [$('title'), val('title').trim().length >= 3, 'Название — хотя бы 3 буквы'],
      [$('cat'), !!val('cat'), 'Выберите категорию'],
      [addrEl, addrOk, val('addr').trim() ? 'Адрес не найден — выберите его из подсказок или поставьте точку 📍' : 'Укажите адрес'],
      [$('date'), !!val('date') && val('date') >= todayISO(), val('date') ? 'Дата уже прошла' : 'Укажите дату'],
      ...timeChecks(),
    ])) return;
    const s = await api.createShift({ title: val('title'), category_id: val('cat'), description: val('desc').trim(), address: val('addr'), lat: geo.lat, lng: geo.lng, date: val('date'), start: val('start'), end: val('end'), pay: val('pay'), pay_type: ptype, until_done: ud(), region: geo.region, people: val('people'), requirements: [...reqs], notify_favorites: document.getElementById('nf').classList.contains('on') }, reqId);
    track('shift_created', { id: s.id }); toast('Смена опубликована', 'ok'); go('#/c/shift/' + s.id);
  };
}

// ---------- страница смены подрядчика ----------
async function shiftPage(ctx, id) {
  id = Number(id);
  const load = async () => {
    const [s, apps] = await Promise.all([api.getShift(id), api.applicants(id)]);
    const active = ['open', 'full'].includes(s.status), owner = s.contractor_id === S.user.id;
    const groups = [['pending', 'Новые отклики'], ['accepted', 'Приняты'], ['completed', 'Участвовали'], ['rejected', 'Отклонены'], ['cancelled', 'Отказались / исключены']];
    const html = `${pageHead('Смена')}<div class="card"><div class="row sp"><h2 style="margin:0">${esc(s.title)}</h2>${statusTag(s.status)}</div><div class="mut sm" style="margin:6px 0">${esc(dateLabel(s.date))} · ${esc(timeRange(s))} · ${esc(payLabel(s))}${payNote(s) ? ` (${esc(payNote(s))})` : ''}<br>${esc(s.address)}</div>
      <div class="row sp sm"><span>👥 ${s.accepted_count} / ${s.people}</span></div><div class="bar" style="margin:6px 0"><i style="width:${Math.min(100, (s.accepted_count / s.people) * 100)}%"></i></div>
      ${s.description ? `<p class="mut sm">${esc(s.description)}</p>` : ''}${(s.requirements || []).map((r) => `<span class="tag">${esc(r)}</span> `).join('')}
      ${active ? (owner ? '<div class="row gap wrap" style="margin-top:12px"><button class="btn sm" data-act="edit">Изменить</button><button class="btn sm" data-act="team">Команда и чат</button><button class="btn sm pri" data-act="fin">Смена завершена</button><button class="btn sm danger" data-act="cancel">Отменить</button></div>' : '<div class="row gap wrap" style="margin-top:12px"><button class="btn sm" data-act="team">Команда и чат</button></div><p class="mut sm">Вы — админ чата этой смены: можно принимать и отклонять отклики.</p>') : (s.status === 'completed' ? '<div class="row gap" style="margin-top:12px"><button class="btn sm" data-act="team">Команда</button><button class="btn sm pri" data-act="rate">Оценить исполнителей</button></div>' : '')}</div>
      <h2>Отклики · ${apps.length}</h2>${apps.length ? groups.map(([st, t]) => { const l = apps.filter((a) => a.status === st); return l.length ? `<div class="mut sm" style="margin:12px 0 4px">${t} · ${l.length}</div>` + l.map((a) => cand(a, active, s.status === 'open')).join('') : ''; }).join('') : '<p class="mut">Пока никто не откликнулся.</p>'}`;
    if (ctx.main.dataset.h !== html && !document.querySelector('.ov')) { ctx.main.innerHTML = html; ctx.main.dataset.h = html; }
    ctx.shiftData = { s, apps };
  };
  const cand = (a, active, canAccept) => { const w = a.worker || {}; return `<div class="card"><div class="row click" data-act="prof" data-id="${a.worker_id}">${avatar(w.avatar, w.name)}<div class="grow"><b>${esc(w.name)}</b> ${verifiedTag(w.verified, 'Проверен')}<div class="sm">${stars(w.rating, w.reviews)} · ${w.shifts_done} ${plural(w.shifts_done, 'смена', 'смены', 'смен')}</div>${(w.skills || []).length ? `<div class="mut sm">${esc(w.skills.slice(0, 4).join(', '))}</div>` : ''}</div>${statusTag(a.status)}</div>
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
    ${P.reviews.length ? `<h2>Отзывы</h2>${P.reviews.map((r) => `<div class="card review"><div class="row sp"><span class="star">${'★'.repeat(r.stars)}<span class="off">${'★'.repeat(5 - r.stars)}</span></span><span class="mut sm">${esc(r.from_name || '')}</span></div>${r.text ? `<div style="margin-top:6px">${esc(r.text)}</div>` : ''}</div>`).join('')}` : ''}`);
  ctx.acts.fav = async () => { const on = await api.toggleFav(wid); toast(on ? 'Добавлено в избранное' : 'Убрано из избранного', 'ok'); workerPage(ctx, wid); };
  ctx.acts.rep = () => reportSheet('worker', wid);
}

async function fav(ctx) {
  const list = await api.favorites('worker');
  ctx.render(`<h1>Избранное</h1><p class="mut sm">Исполнители, с которыми вы хотите работать снова</p>${list.length ? list.map((w) => `<div class="card click row" data-act="p" data-id="${w.user_id}">${avatar(w.avatar, w.name)}<div class="grow"><b>${esc(w.name)}</b> ${verifiedTag(w.verified, 'Проверен')}<div class="sm">${stars(w.rating, w.reviews)} · ${w.shifts_done} ${plural(w.shifts_done, 'смена', 'смены', 'смен')}</div></div>›</div>`).join('') : emptyState('Пока пусто', 'Добавляйте исполнителей в избранное в их профиле.')}`);
  ctx.acts.p = (el) => go('#/c/worker/' + el.dataset.id);
}

async function profile(ctx) {
  const u = await refreshMe(), c = u.contractor;
  ctx.render(`${heroCard({ av: c.avatar, name: c.name, verified: c.verified, sub: c.company ? esc(c.company) : '', tags: verifiedTag(c.verified, 'Проверенный подрядчик'),
      stats: [[c.rating == null ? '—' : c.rating.toFixed(1) + ' <small class="star">★</small>', c.reviews ? `${c.reviews} ${plural(c.reviews, 'отзыв', 'отзыва', 'отзывов')}` : 'нет оценок'], [c.shifts_done, plural(c.shifts_done, 'смена', 'смены', 'смен')], [esc(c.city || '—'), 'город']] })}
    ${c.about ? `<div class="about">${esc(c.about)}</div>` : ''}${infoRows([['phone', 'Телефон', esc(fmtPhone(c.phone))]])}
    <button class="btn block" data-act="edit" style="margin-top:6px">${ICON.edit}Редактировать профиль</button><div style="height:8px"></div>${roleSwitch()}${devPanel(u)}${helpBlock()}`);
  bindCommonProfile(ctx, u); ctx.acts.edit = () => go('#/c/edit-profile');
}

export const contractorRoutes = [
  [/^#\/c\/home$/, home], [/^#\/c\/shifts(?:\/(new|done))?$/, shifts], [/^#\/c\/workers$/, workers], [/^#\/c\/create$/, createOrEdit], [/^#\/c\/edit\/(\d+)$/, createOrEdit], [/^#\/c\/shift\/(\d+)$/, shiftPage],
  [/^#\/c\/worker\/(\d+)$/, workerPage], [/^#\/c\/fav$/, fav], [/^#\/c\/profile$/, profile],
];
