// Общие экраны: приветствие, анкеты, уведомления, чаты, команда, отзывы
import { api, track, getSession } from './api.js';
import { S, go, toast, errMsg, sheet, confirmBox, avatar, stars, pageHead, emptyState, toggle, setRole, refreshMe, mountStars, statusTag, phoneField, maskPhone } from './ui.js';
import { esc, resizeImage, timeAgo, hhmm, uid, dateLabel, plural } from './util.js';

const LICENSES = ['A', 'B', 'C', 'D', 'E'];
export const shiftName = (s) => `${s.title} · ${dateLabel(s.date)}`;

export function reportSheet(target_type, target_id) {
  const s = sheet(`<h3>Пожаловаться</h3><label class="f">Что не так?</label><textarea class="i" id="rr" placeholder="Опишите причину"></textarea><button class="btn pri block" id="rs" style="margin-top:12px">Отправить жалобу</button>`);
  s.el.querySelector('#rs').onclick = async (e) => {
    e.target.disabled = true;
    try { await api.report({ target_type, target_id, reason: s.el.querySelector('#rr').value }); s.close(); toast('Жалоба отправлена', 'ok'); }
    catch (err) { toast(errMsg(err), 'err'); e.target.disabled = false; }
  };
}

// ---------- приветствие ----------
async function welcome(ctx) {
  ctx.render(`<div class="hero">
    <svg class="bolt" viewBox="0 0 24 24"><path fill="#39ff6a" d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>
    <h1>Работа на завтра.<br><span class="g">Найди смену за минуту.</span></h1>
    <p class="mut">Смены и исполнители — быстро, без лишних шагов.</p>
    <div style="height:24px"></div>
    <button class="btn pri block" data-act="worker" style="padding:16px">Найти смену</button>
    <div style="height:10px"></div>
    <button class="btn block" data-act="contractor" style="padding:16px">Я подрядчик</button></div>`);
  ctx.acts.worker = () => { setRole('worker'); track('role_selected', { role: 'worker' }); go(S.user.roles.includes('worker') ? '#/w/search' : '#/w/onboard'); };
  ctx.acts.contractor = () => { setRole('contractor'); track('role_selected', { role: 'contractor' }); go(S.user.roles.includes('contractor') ? '#/c/home' : '#/c/onboard'); };
}

// ---------- анкеты ----------
function photoField(cur) {
  return `<div class="row" style="margin:8px 0"><div id="pv">${avatar(cur, '', 'lg')}</div><div><button class="btn sm" data-act="photo" type="button">Загрузить фото</button><input type="file" id="pf" accept="image/*" hidden><p class="mut sm" style="margin:6px 0 0">Обязательно</p></div></div>`;
}
function bindPhoto(ctx, box) {
  box.avatar = box.avatar || null;
  ctx.acts.photo = () => document.getElementById('pf').click();
  document.getElementById('pf').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    box.avatar = await resizeImage(f); document.getElementById('pv').innerHTML = avatar(box.avatar, '', 'lg');
  };
}
const v = (id) => (document.getElementById(id) || {}).value;
const sw = (id) => document.getElementById(id).classList.contains('on');

async function workerForm(ctx) {
  const w = (S.user.worker) || {};
  const editing = S.user.roles.includes('worker');
  const box = { avatar: w.avatar || null };
  const li = new Set(w.license || []);
  ctx.render(`${editing ? pageHead('Мой профиль') : `<h1>Расскажите о себе</h1><p class="mut">Это увидят подрядчики. Остальное можно заполнить позже.</p>`}
    ${photoField(w.avatar)}
    <label class="f">Имя *</label><input class="i" id="name" value="${esc(w.name || S.user.first_name || '')}" maxlength="60">
    <div class="grid2"><div><label class="f">Город *</label><input class="i" id="city" value="${esc(w.city || 'Москва')}"></div><div><label class="f">Возраст *</label><input class="i" id="age" type="number" inputmode="numeric" min="16" max="90" value="${esc(w.age || '')}"></div></div>
    <h2>Дополнительно</h2><p class="mut sm">Пустые поля в профиле не показываются</p>
    <label class="f">О себе</label><textarea class="i" id="about">${esc(w.about || '')}</textarea>
    <label class="f">Опыт работы</label><input class="i" id="experience" value="${esc(w.experience || '')}" placeholder="Например: 2 года на складе">
    <label class="f">Навыки (через запятую)</label><input class="i" id="skills" value="${esc((w.skills || []).join(', '))}" placeholder="погрузка, монтаж, уборка">
    <label class="f">Водительские права</label><div class="row wrap gap" id="lic">${LICENSES.map((l) => `<span class="chip ${li.has(l) ? 'on' : ''}" data-act="lic" data-l="${l}">${l}</span>`).join('')}</div>
    <label class="f">Телефон</label>${phoneField('phone', w.phone)}
    ${[['medbook', 'Есть медкнижка'], ['selfemployed', 'Самозанятый'], ['night', 'Готов работать ночью'], ['tools', 'Умею работать с инструментом']].map(([k, t]) => `<div class="row sp" style="margin:12px 0"><span>${t}</span>${toggle(w[k], 'tg', `id="${k}"`)}</div>`).join('')}
    <button class="btn pri block" data-act="save" style="margin-top:16px">${editing ? 'Сохранить' : 'Продолжить'}</button>`);
  bindPhoto(ctx, box);
  const phone = maskPhone(document.getElementById('phone'));
  ctx.acts.lic = (el) => { el.classList.toggle('on'); el.classList.contains('on') ? li.add(el.dataset.l) : li.delete(el.dataset.l); };
  ctx.acts.tg = (el) => el.classList.toggle('on');
  ctx.acts.save = async () => {
    const ph = phone(); if (ph && ph.length < 10) return toast('Номер телефона неполный — 10 цифр после +7', 'err');
    await api.saveWorker({ name: v('name'), city: v('city'), age: v('age'), avatar: box.avatar, about: v('about').trim(), experience: v('experience').trim(), skills: v('skills').split(','), license: [...li], phone: ph ? '+7' + ph : '',
      medbook: sw('medbook'), selfemployed: sw('selfemployed'), night: sw('night'), tools: sw('tools') });
    await refreshMe(); setRole('worker'); toast('Профиль сохранён', 'ok'); track('profile_saved', { role: 'worker' });
    go(editing ? '#/w/profile' : '#/w/search');
  };
}

async function contractorForm(ctx) {
  const c = S.user.contractor || {};
  const editing = S.user.roles.includes('contractor');
  const box = { avatar: c.avatar || null };
  ctx.render(`${editing ? pageHead('Профиль подрядчика') : `<h1>Профиль подрядчика</h1><p class="mut">Исполнители увидят это в ваших сменах.</p>`}
    ${photoField(c.avatar).replace('Обязательно', 'Необязательно')}
    <label class="f">Имя *</label><input class="i" id="name" value="${esc(c.name || S.user.first_name || '')}">
    <label class="f">Название компании</label><input class="i" id="company" value="${esc(c.company || '')}" placeholder="Необязательно">
    <label class="f">Город *</label><input class="i" id="city" value="${esc(c.city || 'Москва')}">
    <label class="f">Телефон *</label>${phoneField('phone', c.phone)}
    <label class="f">Кратко о себе</label><textarea class="i" id="about" placeholder="Необязательно">${esc(c.about || '')}</textarea>
    <button class="btn pri block" data-act="save" style="margin-top:16px">${editing ? 'Сохранить' : 'Продолжить'}</button>`);
  bindPhoto(ctx, box);
  const phone = maskPhone(document.getElementById('phone'));
  ctx.acts.save = async () => {
    if (phone().length < 10) return toast('Укажите телефон полностью — 10 цифр после +7', 'err');
    await api.saveContractor({ name: v('name'), company: v('company').trim(), city: v('city'), phone: phone(), about: v('about').trim(), avatar: box.avatar });
    await refreshMe(); setRole('contractor'); toast('Профиль сохранён', 'ok'); track('profile_saved', { role: 'contractor' });
    go(editing ? '#/c/profile' : '#/c/home');
  };
}

// ---------- уведомления ----------
async function notifications(ctx) {
  const list = await api.notifications();
  ctx.render(`${pageHead('Уведомления')}${list.length ? list.map((n) => `<div class="card click" data-act="open" data-l="${esc(n.link || '')}" style="${n.read ? 'opacity:.7' : 'border-color:var(--g)'}"><div>${esc(n.text)}</div><div class="mut sm">${timeAgo(n.at)}</div></div>`).join('') : emptyState('Пока нет уведомлений')}`);
  ctx.acts.open = (el) => el.dataset.l && go(el.dataset.l);
  await api.markRead(); await refreshMe();
}

// ---------- список диалогов ----------
async function chats(ctx) {
  const render = async () => {
    const [dms, teams] = await Promise.all([api.myDialogs(), S.role === 'contractor' ? api.myShifts() : api.myTeams()]);
    const teamList = (S.role === 'contractor' ? teams.filter((s) => s.accepted_count > 0 && s.status !== 'cancelled') : teams);
    const html = `<h1>Чаты</h1><h2>Команды смен</h2>${teamList.length ? teamList.map((s) => `<div class="card click row" data-act="team" data-id="${s.id}"><div class="grow"><b>${esc(shiftName(s))}</b><div class="mut sm">${s.accepted_count} / ${s.people} чел.</div></div>›</div>`).join('') : '<p class="mut">Команда появится после принятия отклика.</p>'}
      <h2>Личные</h2>${dms.length ? dms.map((d) => `<div class="card click row" data-act="dm" data-id="${d.app_id}">${avatar(d.info.worker && S.role === 'contractor' ? d.info.worker.avatar : '', d.info.title)}<div class="grow"><b>${esc(d.info.title)}</b><div class="mut sm">${esc(d.info.shift.title)}</div><div class="sm ${d.last ? '' : 'mut'}" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.last ? esc(d.last.text) : 'Нет сообщений — напишите первым'}</div></div><span class="mut sm">${d.last ? hhmm(d.last.at) : ''}</span></div>`).join('') : `<p class="mut">${S.role === 'contractor' ? 'Здесь появятся чаты с исполнителями, которые откликнулись на ваши смены.' : 'Откликнитесь на смену — и здесь появится чат с подрядчиком.'}</p>`}`;
    if (ctx.main.dataset.h !== html) { ctx.main.innerHTML = html; ctx.main.dataset.h = html; }
  };
  ctx.main.dataset.h = ''; await render(); ctx.poll = render;
  ctx.acts.team = (el) => go('#/team/' + el.dataset.id);
  ctx.acts.dm = (el) => go('#/chat/' + el.dataset.id);
}

// ---------- чат (общий компонент) ----------
async function chatView(ctx, scope, head, { canPin = false, extraTop = '' } = {}) {
  const me = getSession().me;
  ctx.render(`<div class="chat">${head}${extraTop}<div class="pin" id="pin" hidden></div><div class="msgs" id="msgs"></div>
    <form class="compose" id="cf" autocomplete="off"><input id="ci" placeholder="Сообщение" maxlength="2000" autocomplete="off" enterkeyhint="send"><button type="submit" id="cs" aria-label="Отправить">➤</button></form></div>`, { full: true });
  const box = document.getElementById('msgs'); let last = 0; const seen = new Set(); const cache = {};
  const add = (list) => {
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    for (const m of list) {
      if (seen.has(m.id)) continue; seen.add(m.id); last = Math.max(last, m.id); cache[m.id] = m;
      const d = document.createElement('div'); d.className = 'm' + (m.user_id === me ? ' me' : ''); d.dataset.act = 'msg'; d.dataset.id = m.id;
      d.innerHTML = `${m.user_id === me ? '' : `<div class="who ${m.role}">${esc(m.name)}${m.role === 'owner' ? ' · подрядчик' : m.role === 'senior' ? ' · старший' : ''}</div>`}${esc(m.text)}<div class="t">${hhmm(m.at)}</div>`;
      box.appendChild(d);
    }
    if (list.length && (near || last === list[list.length - 1].id)) box.scrollTop = box.scrollHeight;
  };
  const pinBar = (list) => { const p = list.find((m) => m.pinned); const el = document.getElementById('pin'); if (el) { el.hidden = !p; if (p) el.textContent = '📌 ' + p.text; } };
  add(await api.messages(scope, 0));
  const all = () => Object.values(cache);
  pinBar(all());
  ctx.poll = async () => { const l = await api.messages(scope, last); add(l); if (l.length) pinBar(all()); };
  // Отправка: кнопка, Enter и клавиша «Отправить» на телефоне идут через submit формы.
  // На телефоне касание кнопки обрабатываем сразу (touchstart) и не даём полю потерять фокус:
  // иначе первое касание лишь прячет клавиатуру, экран перестраивается и нажатие теряется.
  const input = document.getElementById('ci'), btn = document.getElementById('cs');
  const send = async () => {
    const text = input.value.trim(); if (!text) return;
    input.value = '';
    const tmp = document.createElement('div'); tmp.className = 'm me sending'; tmp.innerHTML = `${esc(text)}<div class="t">отправка…</div>`; box.appendChild(tmp); box.scrollTop = box.scrollHeight;
    try { const m = await api.sendMessage(scope, text, uid()); tmp.remove(); add([m]); track('message_sent', { scope: scope.split(':')[0] }); }
    catch (e) { tmp.remove(); if (!input.value) input.value = text; toast(errMsg(e), 'err'); }
  };
  document.getElementById('cf').onsubmit = (e) => { e.preventDefault(); send(); };
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); send(); }, { passive: false });
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  ctx.acts.msg = (el) => {
    const m = cache[el.dataset.id]; const mine = m.user_id === me;
    const s = sheet(`${canPin ? `<button class="btn block" data-a="pin">${m.pinned ? 'Открепить' : 'Закрепить'}</button><div style="height:8px"></div>` : ''}${mine ? '' : '<button class="btn danger block" data-a="rep">Пожаловаться</button>'}`);
    if (!canPin && mine) s.close();
    s.el.onclick = async (e) => {
      const a = e.target.dataset.a; if (!a) return; s.close();
      if (a === 'rep') reportSheet('message', m.id);
      if (a === 'pin') { try { await api.pinMessage(m.id, !m.pinned); Object.values(cache).forEach((x) => (x.pinned = false)); m.pinned = !m.pinned; pinBar(all()); } catch (er) { toast(errMsg(er), 'err'); } }
    };
  };
}

async function dmChat(ctx, appId) {
  appId = Number(appId);
  const info = await api.dmInfo(appId);
  const isC = S.role === 'contractor' && info.can_manage;
  const st = info.application.status;
  const top = `<div class="card" style="margin:0 12px 6px;flex:none"><div class="row sp"><div class="grow"><b>${esc(info.shift.title)}</b><div class="mut sm">${esc(dateLabel(info.shift.date))} · ${esc(info.shift.start)}–${esc(info.shift.end)} · ${info.shift.pay} ₽</div></div>${statusTag(st)}</div>
    ${isC && st === 'pending' ? '<div class="row gap" style="margin-top:10px"><button class="btn danger sm grow" data-act="rej">Отклонить</button><button class="btn pri sm grow" data-act="acc">Принять</button></div>' : ''}
    ${st === 'accepted' ? '<a class="g sm" href="#" data-act="team" style="display:inline-block;margin-top:8px">Общий чат команды смены ›</a>' : ''}</div>`;
  await chatView(ctx, 'dm:' + appId, `<div style="padding:0 12px">${pageHead(info.title)}</div>`, { extraTop: top });
  const decide = (d, q) => async () => { if (!(await confirmBox(q, { ok: d === 'accepted' ? 'Принять' : 'Отклонить', danger: d === 'rejected' }))) return; await api.decide(appId, d); toast(d === 'accepted' ? 'Исполнитель принят' : 'Отклик отклонён', 'ok'); dmChat(ctx, appId); };
  ctx.acts.team = () => go('#/team/' + info.shift.id);
  ctx.acts.acc = decide('accepted', 'Принять кандидата в команду смены?');
  ctx.acts.rej = decide('rejected', 'Отклонить отклик?');
}

// ---------- команда смены ----------
async function team(ctx, sid) {
  sid = Number(sid);
  const T = await api.team(sid);
  const s = T.shift, isOwner = T.my_role === 'owner';
  const can = (p) => isOwner || (T.my_perms || []).includes(p);
  const n = s.accepted_count;
  const head = `<div style="padding:0 12px">${pageHead(shiftName(s), can('remove') || isOwner ? '' : '')}
    <div class="row sp sm" style="margin-bottom:4px"><span>${n} / ${s.people} чел.</span><a class="g" href="#" data-act="members">Участники ›</a></div><div class="bar" style="margin-bottom:8px"><i style="width:${Math.min(100, (n / s.people) * 100)}%"></i></div></div>`;
  await chatView(ctx, 'shift:' + sid, head, { canPin: can('pin') });
  ctx.acts.members = () => membersSheet(T, sid, can, isOwner, ctx);
}
function membersSheet(T, sid, can, isOwner, ctx) {
  const me = getSession().me, s = T.shift;
  const roleTag = (m) => (m.role === 'owner' ? '<span class="tag r">Подрядчик</span>' : m.role === 'senior' ? '<span class="tag y">Старший</span>' : '<span class="tag g">Исполнитель</span>');
  const sh = sheet(`<h3>Участники · ${T.members.filter((m) => m.role !== 'owner').length} / ${s.people}</h3>${T.members.map((m) => `<div class="row" style="margin:10px 0">${avatar(m.avatar, m.name, 'sm')}<div class="grow"><b>${esc(m.name || '')}</b> ${roleTag(m)}${m.attended === true ? ' <span class="tag g">пришёл</span>' : m.attended === false ? ' <span class="tag r">не пришёл</span>' : ''}</div>
      ${m.role !== 'owner' && m.user_id !== me && (can('attendance') || can('remove') || isOwner) ? `<button class="btn sm" data-m="${m.user_id}">⋯</button>` : ''}</div>`).join('')}
    ${isOwner && s.status !== 'completed' && s.status !== 'cancelled' ? '<button class="btn pri block" data-fin style="margin-top:12px">Смена завершена</button>' : ''}`);
  sh.el.onclick = async (e) => {
    if (e.target.closest('[data-fin]')) { sh.close(); return finishShift(sid, () => go('#/c/shift/' + sid)); }
    const b = e.target.closest('[data-m]'); if (!b) return;
    const uidv = Number(b.dataset.m), m = T.members.find((x) => x.user_id === uidv); sh.close();
    const a = sheet(`<h3>${esc(m.name)}</h3>${can('attendance') ? '<div class="row gap"><button class="btn grow" data-a="here">✓ Пришёл</button><button class="btn grow" data-a="miss">✗ Не пришёл</button></div><div style="height:8px"></div>' : ''}
      ${isOwner ? `<button class="btn block" data-a="senior">${m.role === 'senior' ? 'Изменить права старшего' : 'Назначить старшим'}</button><div style="height:8px"></div>` : ''}${can('remove') ? '<button class="btn danger block" data-a="rm">Удалить из команды</button>' : ''}`);
    a.el.onclick = async (ev) => {
      const act = ev.target.dataset.a; if (!act) return; a.close();
      try {
        if (act === 'here' || act === 'miss') { await api.setAttendance(sid, uidv, act === 'here'); toast('Отмечено', 'ok'); }
        if (act === 'rm') { if (!(await confirmBox(`Удалить ${m.name} из команды?`, { ok: 'Удалить', danger: true }))) return; await api.removeMember(sid, uidv); toast('Участник удалён', 'ok'); }
        if (act === 'senior') return seniorSheet(sid, m, () => team(ctx, sid));
        team(ctx, sid);
      } catch (er) { toast(errMsg(er), 'err'); }
    };
  };
}
function seniorSheet(sid, m, done) {
  const P = [['pin', 'Закреплять сообщения'], ['attendance', 'Отмечать явку'], ['remove', 'Удалять участников'], ['applications', 'Работать с откликами']];
  const on = new Set(m.perms || []);
  const s = sheet(`<h3>Права старшего: ${esc(m.name)}</h3>${P.map(([k, t]) => `<div class="row sp" style="margin:12px 0"><span>${t}</span>${toggle(on.has(k), 'x', `data-k="${k}"`)}</div>`).join('')}<p class="mut sm">Без включённых прав участник станет обычным исполнителем.</p><button class="btn pri block" id="ok">Сохранить</button>`);
  s.el.onclick = async (e) => {
    const t = e.target.closest('.switch'); if (t) { t.classList.toggle('on'); t.classList.contains('on') ? on.add(t.dataset.k) : on.delete(t.dataset.k); }
    if (e.target.id === 'ok') { try { await api.setSenior(sid, m.user_id, [...on]); s.close(); toast('Права обновлены', 'ok'); done(); } catch (er) { toast(errMsg(er), 'err'); } }
  };
}
export async function finishShift(sid, after) {
  if (!(await confirmBox('Завершить смену?', { ok: 'Завершить', sub: 'После завершения стороны смогут оценить друг друга.' }))) return;
  await api.completeShift(sid); track('shift_completed', { id: sid }); toast('Смена завершена', 'ok'); go('#/review/' + sid); if (after) after();
}

// ---------- отзывы ----------
async function review(ctx, sid) {
  sid = Number(sid);
  const list = (await api.pendingReviews()).filter((p) => p.shift.id === sid);
  if (!list.length) { ctx.render(`${pageHead('Оценка')}${emptyState('Все оценки выставлены', 'Спасибо!', `<button class="btn pri" data-act="home">Готово</button>`)}`); ctx.acts.home = () => go('#/'); return; }
  const CR = { contractor: ['Условия', 'Соответствие описанию', 'Организация', 'Своевременность оплаты'], worker: ['Пунктуальность', 'Качество работы', 'Ответственность'] };
  ctx.render(`${pageHead('Оцените ' + (list[0].to_role === 'contractor' ? 'подрядчика' : 'исполнителей'))}<p class="mut sm">${esc(shiftName(list[0].shift))}</p>${list.map((p, i) => `<div class="card" data-i="${i}"><div class="row">${avatar(p.to_avatar, p.to_name)}<b>${esc(p.to_name)}</b></div>
    <div class="stars" data-main style="margin:10px 0"></div>${CR[p.to_role].map((c, j) => `<div class="row sp sm"><span>${c}</span><span class="stars" data-c="${j}" style="font-size:20px;letter-spacing:2px"></span></div>`).join('')}
    <textarea class="i" placeholder="Комментарий (необязательно)" style="margin-top:10px;min-height:56px"></textarea><button class="btn pri block" style="margin-top:10px" data-act="send" data-i="${i}">Отправить</button></div>`).join('')}`);
  const getters = list.map((p, i) => { const card = ctx.main.querySelector(`.card[data-i="${i}"]`); return { main: mountStars(card.querySelector('[data-main]')), cr: [...card.querySelectorAll('[data-c]')].map((e) => mountStars(e)), card }; });
  ctx.acts.send = async (el) => {
    const i = Number(el.dataset.i), p = list[i], g = getters[i], stars = g.main();
    const criteria = {}; CR[p.to_role].forEach((c, j) => { const x = g.cr[j](); if (x) criteria[c] = x; });
    await api.submitReview({ shift_id: sid, to_user: p.to_user, stars, criteria, text: g.card.querySelector('textarea').value });
    g.card.innerHTML = '<p class="g">✓ Оценка отправлена</p>'; track('review_sent');
    if (!ctx.main.querySelector('.btn.pri')) setTimeout(() => go('#/'), 700);
  };
}

export const commonRoutes = [
  [/^#\/welcome$/, welcome], [/^#\/w\/onboard$/, workerForm], [/^#\/w\/edit$/, workerForm], [/^#\/c\/onboard$/, contractorForm], [/^#\/c\/edit-profile$/, contractorForm],
  [/^#\/notifications$/, notifications], [/^#\/chats$/, chats], [/^#\/chat\/(\d+)$/, dmChat], [/^#\/team\/(\d+)$/, team], [/^#\/review\/(\d+)$/, review],
];
