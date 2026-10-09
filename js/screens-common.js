// Общие экраны: приветствие, анкеты, уведомления, чаты, команда, отзывы
import { api, track, getSession, tg } from './api.js';
import { S, go, toast, errMsg, sheet, confirmBox, avatar, stars, pageHead, emptyState, toggle, setRole, refreshMe, mountStars, statusTag, phoneField, maskPhone, validate, clearError, reqMark } from './ui.js';
import { esc, resizeImage, timeAgo, hhmm, uid, dateLabel, plural, money, timeRange, payLabel, shortTime, dayLabel } from './util.js';
import { ICON, reviewCard, bindReviews } from './ui.js';

const LICENSES = ['A', 'B', 'C', 'D', 'E'];
export const shiftName = (s) => `${s.title} · ${dateLabel(s.date)}`;

export function reportSheet(target_type, target_id) {
  const s = sheet(`<h3>Пожаловаться</h3><label class="f">Что не так?</label><textarea class="i" id="rr" placeholder="Опишите причину"></textarea><button class="btn pri block" id="rs" style="margin-top:12px">Отправить жалобу</button>`);
  s.el.querySelector('#rs').onclick = async (e) => {
    const rr = s.el.querySelector('#rr');
    if (!validate([[rr, rr.value.trim().length >= 3, 'Опишите причину — хотя бы пару слов']])) return;
    e.target.disabled = true;
    try { await api.report({ target_type, target_id, reason: s.el.querySelector('#rr').value }); s.close(); toast('Жалоба отправлена', 'ok'); }
    catch (err) { toast(errMsg(err), 'err'); e.target.disabled = false; }
  };
}

// ---------- согласие с условиями (обязательно при первом входе) ----------
export function openLegal(kind) { const url = location.origin + '/legal/' + kind + '.html'; if (tg) tg.openLink(url); else window.open(url, '_blank', 'noopener'); }
async function consent(ctx) {
  ctx.render(`<div class="hero">
    <svg class="bolt" viewBox="0 0 24 24"><path fill="#39ff6a" d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>
    <h1>Добро пожаловать</h1><p class="mut">Прежде чем начать, подтвердите условия использования.</p>
    <div class="card" style="margin-top:18px"><div class="row" style="align-items:flex-start">${toggle(false, 'agree')}
      <div class="sm" style="line-height:1.55">Я принимаю <a class="g" href="#" data-act="legal" data-u="terms">Пользовательское соглашение</a> и даю согласие на обработку моих персональных данных на условиях <a class="g" href="#" data-act="legal" data-u="privacy">Политики конфиденциальности</a>.</div></div></div>
    <button class="btn pri block" data-act="accept" id="acc" disabled style="margin-top:10px;padding:16px">Продолжить</button>
    <p class="mut sm" style="text-align:center;margin-top:14px">Данные нужны, чтобы подбирать смены и показывать ваш профиль подрядчикам. Аккаунт можно удалить в любой момент.</p></div>`);
  ctx.acts.agree = (el) => { el.classList.toggle('on'); el.setAttribute('aria-checked', el.classList.contains('on')); document.getElementById('acc').disabled = !el.classList.contains('on'); };
  ctx.acts.legal = (el) => openLegal(el.dataset.u);
  ctx.acts.accept = async () => { await api.acceptTerms(); S.user.terms_accepted = true; track('terms_accepted'); go('#/'); };
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
    <button class="btn block" data-act="contractor" style="padding:16px">Я подрядчик</button>
    ${S.user.is_admin ? '<div style="height:10px"></div><button class="btn block ghost" data-act="admin">Админ-панель</button>' : ''}</div>`);
  ctx.acts.admin = () => go('#/admin');
  ctx.acts.worker = () => { setRole('worker'); track('role_selected', { role: 'worker' }); go(S.user.roles.includes('worker') ? '#/w/search' : '#/w/onboard'); };
  ctx.acts.contractor = () => { setRole('contractor'); track('role_selected', { role: 'contractor' }); go(S.user.roles.includes('contractor') ? '#/c/home' : '#/c/onboard'); };
}

// ---------- анкеты ----------
function photoField(cur) {
  return `<div class="row" id="photo" data-field style="margin:8px 0"><div id="pv">${avatar(cur, '', 'lg')}</div><div><button class="btn sm" data-act="photo" type="button">Загрузить фото</button><input type="file" id="pf" accept="image/*" hidden><p class="mut sm" style="margin:6px 0 0">Обязательно</p></div></div>`;
}
function bindPhoto(ctx, box) {
  box.avatar = box.avatar || null;
  ctx.acts.photo = () => document.getElementById('pf').click();
  document.getElementById('pf').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { box.avatar = await resizeImage(f); } catch { return toast('Не удалось открыть фото. Выберите другое (JPG или PNG)', 'err'); }
    document.getElementById('pv').innerHTML = avatar(box.avatar, '', 'lg'); clearError(document.getElementById('photo'));
  };
}const v = (id) => (document.getElementById(id) || {}).value;
const sw = (id) => document.getElementById(id).classList.contains('on');

async function workerForm(ctx) {
  const w = (S.user.worker) || {};
  const editing = S.user.roles.includes('worker');
  const box = { avatar: w.avatar || null };
  const li = new Set(w.license || []);
  ctx.render(reqMark(`${editing ? pageHead('Мой профиль') : `${pageHead('Расскажите о себе')}<p class="mut">Это увидят подрядчики. Остальное можно заполнить позже.</p>`}
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
    <button class="btn pri block" data-act="save" style="margin-top:16px">${editing ? 'Сохранить' : 'Продолжить'}</button>`));
  bindPhoto(ctx, box);
  const phone = maskPhone(document.getElementById('phone'));
  ctx.acts.lic = (el) => { el.classList.toggle('on'); el.classList.contains('on') ? li.add(el.dataset.l) : li.delete(el.dataset.l); };
  ctx.acts.tg = (el) => el.classList.toggle('on');
  ctx.acts.save = async () => {
    const $ = (id) => document.getElementById(id), age = Number(v('age')), ph = phone();
    if (!validate([
      [$('photo'), !!box.avatar, 'Добавьте фото — без него подрядчики не видят, кто откликнулся'],
      [$('name'), v('name').trim().length >= 2, 'Укажите имя'],
      [$('city'), v('city').trim().length > 0, 'Укажите город'],
      [$('age'), Number.isInteger(age) && age >= 16 && age <= 90, 'Возраст от 16 до 90 лет'],
      [$('phone'), !ph || ph.length === 10, 'Номер неполный — нужно 10 цифр после +7'],
    ])) return;
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
  ctx.render(reqMark(`${editing ? pageHead('Профиль подрядчика') : `${pageHead('Профиль подрядчика')}<p class="mut">Исполнители увидят это в ваших сменах.</p>`}
    ${photoField(c.avatar).replace('Обязательно', 'Необязательно')}
    <label class="f">Имя *</label><input class="i" id="name" value="${esc(c.name || S.user.first_name || '')}">
    <label class="f">Название компании</label><input class="i" id="company" value="${esc(c.company || '')}" placeholder="Необязательно">
    <label class="f">Город *</label><input class="i" id="city" value="${esc(c.city || 'Москва')}">
    <label class="f">Телефон *</label>${phoneField('phone', c.phone)}
    <label class="f">Кратко о себе</label><textarea class="i" id="about" placeholder="Необязательно">${esc(c.about || '')}</textarea>
    <button class="btn pri block" data-act="save" style="margin-top:16px">${editing ? 'Сохранить' : 'Продолжить'}</button>`));
  bindPhoto(ctx, box);
  const phone = maskPhone(document.getElementById('phone'));
  ctx.acts.save = async () => {
    const $ = (id) => document.getElementById(id);
    if (!validate([
      [$('name'), v('name').trim().length >= 2, 'Укажите имя'],
      [$('city'), v('city').trim().length > 0, 'Укажите город'],
      [$('phone'), phone().length === 10, phone() ? 'Номер неполный — нужно 10 цифр после +7' : 'Укажите телефон — по нему с вами свяжутся исполнители'],
    ])) return;
    await api.saveContractor({ name: v('name'), company: v('company').trim(), city: v('city'), phone: phone(), about: v('about').trim(), avatar: box.avatar });
    await refreshMe(); setRole('contractor'); toast('Профиль сохранён', 'ok'); track('profile_saved', { role: 'contractor' });
    go(editing ? '#/c/profile' : '#/c/home');
  };
}

// ---------- уведомления ----------
// тип → [заголовок, иконка, цвет]; одинаковый вид для всех, чтобы сразу было понятно, что случилось
const NT = {
  new_application: ['Новый отклик', 'user', 'g'], accepted: ['Вас приняли', 'check', 'g'], rejected: ['Отклик отклонён', 'close', 'r'], shift_cancelled: ['Смена отменена', 'close', 'r'],
  shift_completed: ['Смена завершена — оцените', 'check', 'o'], shift_closed: ['Смена завершена', 'info', 'o'], message: ['Новое сообщение', 'chats', 'b'], review: ['Вам поставили оценку', 'fav', 'y'],
  removed: ['Вас исключили из команды', 'close', 'r'], role: ['Роль в чате', 'shield', 'y'], shift_updated: ['Смена изменена', 'edit', 'y'], member_left: ['Участник отказался', 'user', 'r'],
  shift_overdue: ['Пора завершить смену', 'clock', 'o'], pro: ['Подписка PRO', 'crown', 'y'], saved_gone: ['Отложенная смена', 'bookmark', 'y'], new_shift_from_fav: ['Новая смена у вашего подрядчика', 'bolt', 'g'],
};
// тело уведомления без повторов заголовка: только «кто / какая смена» и что делать дальше
const NBODY = (n) => {
  const t = n.text || '', shift = (t.match(/«[^»]+»/) || [''])[0];
  switch (n.type) {
    case 'message': { const m = t.match(/^(.*?): новое сообщение в («.*»)$/); return m ? `${m[1]} · ${m[2]}` : t; }
    case 'new_application': { const m = t.match(/^Новый отклик: (.*?) — («.*»)$/); return m ? `${m[1]} · ${m[2]}` : t; }
    case 'shift_completed': return `${shift} — оцените подрядчика (можно пропустить)`;
    case 'shift_closed': return `${shift} — ваш отклик не был рассмотрен`;
    case 'shift_cancelled': return `${shift} — подрядчик отменил смену`;
    case 'accepted': return `${shift} — вы в команде смены`;
    case 'rejected': return `${shift} — подрядчик отклонил отклик`;
    case 'removed': return `${shift} — вас исключили из команды`;
    case 'shift_updated': return `${shift} — условия обновились, проверьте`;
    case 'shift_overdue': return `${shift} — завершите её и оцените исполнителей`;
    case 'member_left': { const m = t.match(/^(.*?) отказался от смены («.*»)$/); return m ? `${m[1]} · ${m[2]}` : t; }
    case 'review': return 'Откройте профиль, чтобы посмотреть оценку';
    default: return t;
  }
};
const NGROUP = [['all', 'Все', null], ['apps', 'Отклики', ['new_application', 'accepted', 'rejected', 'member_left']], ['chat', 'Чаты', ['message']], ['shifts', 'Смены', ['pro', 'shift_cancelled', 'shift_completed', 'shift_closed', 'shift_updated', 'shift_overdue', 'removed', 'role', 'saved_gone', 'new_shift_from_fav', 'review']]];
async function notifications(ctx) {
  const list = await api.notifications(S.role); let f = 'all';
  const draw = () => {
    const g = NGROUP.find((x) => x[0] === f), l = g[2] ? list.filter((n) => g[2].includes(n.type)) : list;
    const chips = NGROUP.map(([k, t, types]) => { const c = (types ? list.filter((n) => types.includes(n.type)) : list); const u = c.filter((n) => !n.read).length; return `<span class="chip ${f === k ? 'on' : ''}" data-act="nf" data-f="${k}">${t}${u ? ` · <b>${u}</b>` : ''}</span>`; }).join('');
    let last = '', body = '';
    for (const n of l) {
      const day = dayLabel(n.at); if (day !== last) { body += `<div class="nday">${day}</div>`; last = day; }
      const [title, ic, col] = NT[n.type] || ['Уведомление', 'info', ''];
      body += `<div class="nt ${n.read ? '' : 'new'}" data-act="open" data-l="${esc(n.link || '')}"><span class="nic ${col}">${ICON[ic] || ICON.info}</span><div class="nb"><div class="nh"><b>${title}</b><span class="ntime">${hhmm(n.at)}</span></div><div class="nx">${esc(NBODY(n))}</div></div>${n.read ? '' : '<i class="dot"></i>'}</div>`;
    }
    ctx.main.innerHTML = `${pageHead('Уведомления')}<p class="mut sm" style="margin:0 0 8px">Сюда приходят отклики, решения подрядчиков, сообщения в чатах и напоминания о сменах. То же самое приходит и в Telegram. Нажмите, чтобы открыть.</p><div class="tabsx">${chips}</div>${l.length ? body : emptyState(list.length ? 'В этой группе пусто' : 'Пока нет уведомлений', list.length ? '' : 'Когда что-то произойдёт — отклик, ответ подрядчика, сообщение — вы увидите это здесь.')}`;
  };
  draw();
  ctx.acts.nf = (el) => { f = el.dataset.f; draw(); };
  ctx.acts.open = (el) => el.dataset.l && go(el.dataset.l);
  api.markRead(null, S.role).then(() => refreshMe()).catch(() => {}); // подсветка «новых» остаётся на экране, значок на колокольчике гаснет
}

// ---------- список чатов: вкладки «Команды» и «Личные», сверху самые свежие ----------
async function chats(ctx) {
  let tab = sessionStorage.getItem('sh_chtab') || '', teams = [], dms = [];
  const other = S.role === 'contractor' ? ['Исполнитель', 'worker'] : ['Подрядчик', 'owner'];
  const preview = (last, mine) => last ? `<div class="cprev">${last.mine || mine ? '<span class="you">Вы:</span> ' : last.name ? `<span class="you">${esc(String(last.name).split(' ')[0])}:</span> ` : ''}${esc(last.text)}</div>` : '<div class="cprev mut">Сообщений пока нет — напишите первым</div>';
  const draw = () => {
    const tUn = teams.filter((x) => x.unread).length, dUn = dms.filter((x) => x.unread).length;
    const tabs = `<div class="tabsx"><span class="chip ${tab === 'team' ? 'on' : ''}" data-act="ctab" data-t="team">Команды смен · ${teams.length}${tUn ? ' <i class="dot"></i>' : ''}</span><span class="chip ${tab === 'dm' ? 'on' : ''}" data-act="ctab" data-t="dm">Личные · ${dms.length}${dUn ? ' <i class="dot"></i>' : ''}</span></div>`;
    let body;
    if (tab === 'team') body = teams.length ? teams.map((s) => {
      const end = s.status === 'completed' ? '<span class="tag o">Завершена</span>' : '';
      return `<div class="crow click ${s.unread ? 'un' : ''}" data-act="team" data-id="${s.id}"><span class="cav team">${ICON.users}</span><div class="cb"><div class="ctop"><b>${esc(s.title)}</b><span class="ctime">${s.last ? shortTime(s.last.at) : ''}</span></div>
        ${S.role === 'contractor' ? '' : `<div class="csub">${esc(s.contractor?.company || s.contractor?.name || '')}</div>`}<div class="csub">${esc(dateLabel(s.date))} · ${esc(timeRange(s))} · ${s.accepted_count}/${s.people} чел. ${end}</div>${preview(s.last)}</div>${s.unread ? '<i class="dot"></i>' : ''}</div>`;
    }).join('') : emptyState('Командных чатов пока нет', S.role === 'contractor' ? 'Чат команды появится, когда вы примете первого исполнителя.' : 'Чат команды появится, когда подрядчик примет ваш отклик.');
    else body = dms.length ? dms.map((d) => `<div class="crow click ${d.unread ? 'un' : ''}" data-act="dm" data-id="${d.app_id}">${avatar(d.info.worker && S.role === 'contractor' ? d.info.worker.avatar : '', d.info.title)}<div class="cb"><div class="ctop"><b>${esc(d.info.title)} <span class="rt ${other[1]}">${other[0]}</span></b><span class="ctime">${d.last ? shortTime(d.last.at) : ''}</span></div>
        <div class="csub">${esc(d.info.shift.title)} · ${esc(dateLabel(d.info.shift.date))} ${statusTag(d.info.application.status)}</div>${preview(d.last ? { text: d.last.text, mine: d.last.user_id === getSession().me, name: d.last.name } : null)}</div>${d.unread ? '<i class="dot"></i>' : ''}</div>`).join('')
      : emptyState('Личных чатов пока нет', S.role === 'contractor' ? 'Здесь появятся переписки с исполнителями, откликнувшимися на ваши смены.' : 'Откликнитесь на смену — и здесь появится чат с подрядчиком.');
    const html = `<h1>Чаты</h1>${tabs}${body}`;
    if (ctx.main.dataset.h !== html) { const st = ctx.main.scrollTop; ctx.main.innerHTML = html; ctx.main.dataset.h = html; ctx.main.scrollTop = st; }
  };
  const load = async () => {
    [teams, dms] = await Promise.all([api.teamChats(S.role), api.myDialogs(S.role)]);
    if (!tab) tab = dms.some((d) => d.unread) && !teams.some((t) => t.unread) ? 'dm' : !teams.length && dms.length ? 'dm' : 'team';
    draw();
  };
  ctx.main.dataset.h = ''; await load(); ctx.poll = load;
  ctx.acts.ctab = (el) => { tab = el.dataset.t; sessionStorage.setItem('sh_chtab', tab); draw(); };
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
      d.innerHTML = `<div class="who ${m.role}">${m.user_id === me ? 'Вы' : esc(m.name)}<span class="rt ${m.role}">${{ owner: 'Подрядчик', senior: 'Админ чата', worker: 'Исполнитель' }[m.role] || 'Исполнитель'}</span></div>${esc(m.text)}<div class="t">${hhmm(m.at)}</div>`;
      box.appendChild(d);
    }
    if (list.length && (near || last === list[list.length - 1].id)) box.scrollTop = box.scrollHeight;
  };
  const pinBar = (list) => { const p = list.find((m) => m.pinned); const el = document.getElementById('pin'); if (el) { el.hidden = !p; if (p) el.textContent = '📌 ' + p.text; } };
  const chatLink = scope.startsWith('shift:') ? '#/team/' + scope.slice(6) : '#/chat/' + scope.slice(3);
  const seenChat = () => api.markRead(chatLink).then(() => refreshMe()).catch(() => {});
  seenChat();
  add(await api.messages(scope, 0));
  const all = () => Object.values(cache);
  // закреплённое сообщение запрашивается отдельно: его могли закрепить/открепить без новых сообщений, а оно может быть старше загруженных
  const syncPin = async () => { const p = await api.messages(scope, 0, 'pin'); Object.values(cache).forEach((x) => (x.pinned = false)); p.forEach((x) => { (cache[x.id] = cache[x.id] || x).pinned = true; }); pinBar(all()); };
  const team = scope.startsWith('shift:');
  if (team) await syncPin().catch(() => pinBar(all())); else pinBar(all());
  ctx.poll = async () => { const l = await api.messages(scope, last); add(l); if (l.length) seenChat(); if (team) await syncPin(); };
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
      if (a === 'pin') { try { const next = !m.pinned; await api.pinMessage(m.id, next); Object.values(cache).forEach((x) => (x.pinned = false)); m.pinned = next; pinBar(all()); } catch (er) { toast(errMsg(er), 'err'); } }
    };
  };
}

async function dmChat(ctx, appId) {
  appId = Number(appId);
  const info = await api.dmInfo(appId);
  const isC = info.can_manage; // подрядчик или админ чата с правом «работа с откликами»
  const meId = getSession().me, other = info.application.worker_id === meId ? 'подрядчик' : 'исполнитель';
  const st = info.application.status;
  const top = `<div class="card" style="margin:0 12px 6px;flex:none"><div class="row sp"><div class="grow"><b>${esc(info.shift.title)}</b><div class="mut sm">${esc(dateLabel(info.shift.date))} · ${esc(timeRange(info.shift))} · ${esc(payLabel(info.shift))}</div></div>${statusTag(st)}</div>
    <a class="g sm" href="#" data-act="prof" style="display:inline-block;margin-top:8px">Профиль: ${esc(info.title)} · ${other} ›</a>
    ${isC && st === 'pending' ? '<div class="row gap" style="margin-top:10px"><button class="btn danger sm grow" data-act="rej">Отклонить</button><button class="btn pri sm grow" data-act="acc">Принять</button></div>' : ''}
    ${st === 'accepted' ? '<a class="g sm" href="#" data-act="team" style="display:inline-block;margin-top:8px">Общий чат команды смены ›</a>' : ''}</div>`;
  await chatView(ctx, 'dm:' + appId, `<div style="padding:0 12px">${pageHead(info.title + ' · ' + other)}</div>`, { extraTop: top });
  ctx.acts.prof = () => go(info.application.worker_id === meId ? '#/w/contractor/' + info.shift.contractor_id : '#/c/worker/' + info.application.worker_id);
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
    <div class="row sp sm" style="margin-bottom:4px"><span>${n} / ${s.people} чел.</span><span class="row gap">${can('applications') ? '<a class="g" href="#" data-act="applic">Отклики ›</a>' : ''}<a class="g" href="#" data-act="members">Участники ›</a></span></div><div class="bar" style="margin-bottom:8px"><i style="width:${Math.min(100, (n / s.people) * 100)}%"></i></div></div>`;
  await chatView(ctx, 'shift:' + sid, head, { canPin: can('pin') });
  ctx.acts.members = () => membersSheet(T, sid, can, isOwner, ctx);
  ctx.acts.applic = () => go('#/c/shift/' + sid);
}
function membersSheet(T, sid, can, isOwner, ctx) {
  const me = getSession().me, s = T.shift;
  const roleTag = (m) => (m.role === 'owner' ? '<span class="tag r">Подрядчик</span>' : m.role === 'senior' ? '<span class="tag y">Админ чата</span>' : '<span class="tag g">Исполнитель</span>');
  const sh = sheet(`<h3>Участники · ${T.members.filter((m) => m.role !== 'owner').length} / ${s.people}</h3>${T.members.map((m) => `<div class="row" style="margin:10px 0">${avatar(m.avatar, m.name, 'sm')}<div class="grow"><b class="click" data-p="${m.user_id}" data-r="${m.role}">${esc(m.name || '')}</b> ${roleTag(m)}${m.attended === true ? ' <span class="tag g">пришёл</span>' : m.attended === false ? ' <span class="tag r">не пришёл</span>' : ''}</div>
      ${m.role !== 'owner' && m.user_id !== me && (can('attendance') || can('remove') || isOwner) ? `<button class="btn sm" data-m="${m.user_id}">⋯</button>` : ''}</div>`).join('')}
    ${isOwner && s.status !== 'completed' && s.status !== 'cancelled' ? '<button class="btn pri block" data-fin style="margin-top:12px">Смена завершена</button>' : ''}`);
  sh.el.onclick = async (e) => {
    const pr = e.target.closest('[data-p]'); if (pr) { sh.close(); return go(pr.dataset.r === 'owner' ? '#/w/contractor/' + pr.dataset.p : '#/c/worker/' + pr.dataset.p); }
    if (e.target.closest('[data-fin]')) { sh.close(); return finishShift(sid).catch((er) => toast(errMsg(er), 'err')); }
    const b = e.target.closest('[data-m]'); if (!b) return;
    const uidv = Number(b.dataset.m), m = T.members.find((x) => x.user_id === uidv); sh.close();
    const a = sheet(`<h3>${esc(m.name)}</h3>${can('attendance') ? '<div class="row gap"><button class="btn grow" data-a="here">✓ Пришёл</button><button class="btn grow" data-a="miss">✗ Не пришёл</button></div><div style="height:8px"></div>' : ''}
      ${isOwner ? `<button class="btn block" data-a="senior">${m.role === 'senior' ? 'Права админа чата' : 'Назначить админом чата'}</button><div style="height:8px"></div>` : ''}${can('remove') ? '<button class="btn danger block" data-a="rm">Удалить из команды</button>' : ''}`);
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
  const P = [['pin', 'Закреплять сообщения'], ['attendance', 'Отмечать явку'], ['remove', 'Удалять участников'], ['applications', 'Принимать отклики за подрядчика']];
  const on = new Set(m.perms || []);
  const s = sheet(`<h3>Админ чата: ${esc(m.name)}</h3><p class="mut sm">Админ чата помогает подрядчику вести смену. С правом «принимать отклики» он принимает и отклоняет исполнителей вместо подрядчика.</p>${P.map(([k, t]) => `<div class="row sp" style="margin:12px 0"><span>${t}</span>${toggle(on.has(k), 'x', `data-k="${k}"`)}</div>`).join('')}<p class="mut sm">Без включённых прав участник снова станет обычным исполнителем.</p><button class="btn pri block" id="ok">Сохранить</button>`);
  s.el.onclick = async (e) => {
    const t = e.target.closest('.switch'); if (t) { t.classList.toggle('on'); t.classList.contains('on') ? on.add(t.dataset.k) : on.delete(t.dataset.k); }
    if (e.target.id === 'ok') { try { await api.setSenior(sid, m.user_id, [...on]); s.close(); toast('Права обновлены', 'ok'); done(); } catch (er) { toast(errMsg(er), 'err'); } }
  };
}
export async function finishShift(sid, after) {
  if (!(await confirmBox('Завершить смену?', { ok: 'Завершить', sub: 'После завершения стороны смогут оценить друг друга.' }))) return;
  await api.completeShift(sid); track('shift_completed', { id: sid }); toast('Смена завершена', 'ok'); go('#/review/' + sid); if (after) after();
}

// ---------- подписка PRO ----------
const PERKS = {
  w: [['crown', 'Значок PRO и золотая рамка', 'Вас сразу заметно в откликах, чатах и профиле', 1],
    ['clock', 'Ранний доступ к новым сменам', 'Видите смены на 15 минут раньше остальных', 0], ['mine', 'Статистика заработка', 'Сколько заработано за месяц, график и лучшие смены', 0], ['bell', 'Уведомления о горячих сменах', 'Срочные смены рядом — сразу к вам', 0]],
  c: [['crown', 'Значок PRO у профиля и смен', 'Исполнители больше доверяют', 1], ['search', 'Ваши смены выше в ленте', 'В пределах дня PRO-смены показываются раньше', 1], ['bolt', 'Поднять в топ — 3 раза в месяц', 'Смена на 6 часов выше всех в ленте', 1],
    ['shifts', 'Повтор смены в один клик и шаблоны', 'Публикация за 10 секунд', 0], ['mine', 'Аналитика откликов', 'Просмотры, отклики, принятые', 0], ['chats', 'Приоритетная поддержка', 'Отвечаем в первую очередь', 0]],
};
async function proPage(ctx) {
  const sub = await api.mySubscription(); let who = S.role === 'contractor' ? 'c' : 'w';
  const draw = () => {
    const until = sub.expires_at ? new Date(sub.expires_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    const live = PERKS[who].filter((p) => p[3]), soon = PERKS[who].filter((p) => !p[3]);
    const perk = ([ic, t, d, on]) => `<div class="perk ${on ? '' : 'soon'}"><span class="pk-ic">${ICON[ic]}</span><div class="grow"><b>${t}</b><div class="mut sm">${d}</div></div><span class="pk-st">${on ? '✓' : 'Скоро'}</span></div>`;
    ctx.main.innerHTML = `${pageHead('PRO')}<div class="prohero"><div class="crown">${ICON.crown}</div><h1>SPEED HELPER <span>PRO</span></h1>
      <div class="mut sm" style="margin-top:4px">${who === 'w' ? 'Заметнее для подрядчиков — больше доверия' : 'Ваши смены заметнее — быстрее набираете людей'}</div>
      ${sub.active ? `<div class="pro-on">✓ Подписка активна до ${until}</div>` : '<div class="price"><b>990 ₽</b> / месяц<div class="sm">≈ 33 ₽ в день · без автопродления</div></div>'}</div>
      <div class="seg"><span class="${who === 'w' ? 'on' : ''}" data-act="pw" data-w="w">Исполнителю</span><span class="${who === 'c' ? 'on' : ''}" data-act="pw" data-w="c">Подрядчику</span></div>
      <div class="sect">Что вы получаете</div>${live.map(perk).join('')}
      ${who === 'c' && sub.active ? `<p class="mut sm">Поднятий в топ в этом месяце: осталось ${sub.boosts_limit - sub.boosts_used} из ${sub.boosts_limit}</p>` : ''}
      ${soon.length ? `<div class="sect">Скоро добавим — уже в подписке</div>${soon.map(perk).join('')}` : ''}
      <p class="mut sm" style="margin-top:12px">PRO — необязательные дополнительные возможности, они не влияют на порядок откликов. Всем остальным в приложении можно пользоваться бесплатно. Подписка не продлевается сама.</p>
      ${sub.active ? '' : '<div class="probar"><button class="btn pri block" data-act="buy">Оформить PRO · 990 ₽ / месяц</button></div>'}`;
  };
  draw();
  ctx.acts.pw = (el) => { who = el.dataset.w; draw(); };
  ctx.acts.buy = () => {
    const sh = sheet(`<h3>Оплата подключается</h3><p class="mut sm">Приём платежей за PRO мы подключаем — скоро появится оплата картой прямо в Telegram. Пока PRO можно получить у администратора: напишите нам, и мы подключим её вам.</p>${S.cfg && S.cfg.support_url ? '<button class="btn pri block" id="sup">Написать в поддержку</button>' : ''}<button class="btn ghost block" id="cl" style="margin-top:8px">Понятно</button>`);
    sh.el.querySelector('#cl').onclick = () => sh.close();
    const b = sh.el.querySelector('#sup'); if (b) b.onclick = () => { sh.close(); const url = S.cfg.support_url; if (tg && tg.openTelegramLink && /^https:\/\/t\.me\//.test(url)) tg.openTelegramLink(url); else if (tg) tg.openLink(url); else window.open(url, '_blank', 'noopener'); };
  };
}

// ---------- все отзывы о человеке ----------
async function reviewsPage(ctx, role, uid) {
  uid = Number(uid);
  const first = await api.userReviews(uid, role, 0); let items = first.items.slice();
  const draw = () => {
    ctx.main.innerHTML = `${pageHead('Отзывы')}<div class="card row">${avatar(first.avatar, first.name)}<div class="grow"><b>${esc(first.name)}</b><div class="sm">${stars(first.rating, first.total)}</div></div><a class="g sm" href="#" data-act="toprof">Профиль ›</a></div>
      ${items.length ? items.map(reviewCard).join('') : emptyState('Отзывов пока нет')}${items.length < first.total ? '<button class="btn block" data-act="morerev">Показать ещё</button>' : ''}`;
  };
  draw(); bindReviews(ctx);
  ctx.acts.toprof = () => go(role === 'contractor' ? '#/w/contractor/' + uid : '#/c/worker/' + uid);
  ctx.acts.morerev = async () => { const r = await api.userReviews(uid, role, items.length); items = items.concat(r.items); draw(); };
}

// ---------- отзывы ----------
async function review(ctx, sid) {
  sid = Number(sid);
  const list = (await api.pendingReviews()).filter((p) => p.shift.id === sid);
  if (!list.length) { ctx.render(`${pageHead('Оценка')}${emptyState('Все оценки выставлены', 'Спасибо!', `<button class="btn pri" data-act="home">Готово</button>`)}`); ctx.acts.home = () => go('#/'); return; }
  const CR = { contractor: ['Условия', 'Соответствие описанию', 'Организация', 'Своевременность оплаты'], worker: ['Пунктуальность', 'Качество работы', 'Ответственность'] };
  ctx.render(`${pageHead('Оцените ' + (list[0].to_role === 'contractor' ? 'подрядчика' : 'исполнителей'))}<p class="mut sm">${esc(shiftName(list[0].shift))}</p><p class="mut sm" style="margin-top:-6px">Оценка необязательна — её можно пропустить.</p>${list.map((p, i) => `<div class="card" data-i="${i}"><div class="row">${avatar(p.to_avatar, p.to_name)}<b>${esc(p.to_name)}</b></div>
    <div class="stars" data-main data-field style="margin:10px 0"></div>${CR[p.to_role].map((c, j) => `<div class="row sp sm"><span>${c}</span><span class="stars" data-c="${j}" style="font-size:20px;letter-spacing:2px"></span></div>`).join('')}
    <textarea class="i" placeholder="Комментарий (необязательно)" style="margin-top:10px;min-height:56px"></textarea><div class="row gap" style="margin-top:10px"><button class="btn grow" data-act="skip1" data-i="${i}">Пропустить</button><button class="btn pri grow" data-act="send" data-i="${i}">Отправить</button></div></div>`).join('')}<button class="btn ghost block" data-act="skipAll" style="margin-top:6px">Пропустить всё</button>`);
  const getters = list.map((p, i) => { const card = ctx.main.querySelector(`.card[data-i="${i}"]`); return { main: mountStars(card.querySelector('[data-main]')), cr: [...card.querySelectorAll('[data-c]')].map((e) => mountStars(e)), card }; });
  ctx.acts.skip1 = async (el) => {
    const i = Number(el.dataset.i); await api.skipReview(sid, list[i].to_user); getters[i].card.innerHTML = '<p class="mut">Пропущено</p>';
    if (!ctx.main.querySelector('.btn.pri')) setTimeout(() => go('#/'), 500);
  };
  ctx.acts.skipAll = async () => { await api.skipReview(sid); toast('Оценка пропущена'); go('#/'); };
  ctx.acts.send = async (el) => {
    const i = Number(el.dataset.i), p = list[i], g = getters[i], stars = g.main();
    if (!validate([[g.card.querySelector('[data-main]'), stars > 0, 'Поставьте оценку — от 1 до 5 звёзд']])) return;
    const criteria = {}; CR[p.to_role].forEach((c, j) => { const x = g.cr[j](); if (x) criteria[c] = x; });
    await api.submitReview({ shift_id: sid, to_user: p.to_user, stars, criteria, text: g.card.querySelector('textarea').value });
    g.card.innerHTML = '<p class="g">✓ Оценка отправлена</p>'; track('review_sent');
    if (!ctx.main.querySelector('.btn.pri')) setTimeout(() => go('#/'), 700);
  };
}

export const commonRoutes = [
  [/^#\/consent$/, consent], [/^#\/welcome$/, welcome], [/^#\/w\/onboard$/, workerForm], [/^#\/w\/edit$/, workerForm], [/^#\/c\/onboard$/, contractorForm], [/^#\/c\/edit-profile$/, contractorForm],
  [/^#\/notifications$/, notifications], [/^#\/chats$/, chats], [/^#\/chat\/(\d+)$/, dmChat], [/^#\/team\/(\d+)$/, team], [/^#\/pro$/, proPage], [/^#\/review\/(\d+)$/, review], [/^#\/reviews\/(worker|contractor)\/(\d+)$/, reviewsPage],
];
