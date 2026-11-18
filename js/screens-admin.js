// Админ-панель владельцев (доступ только при users.is_admin = true; проверяется и на сервере).
// Главный экран — сводка, что требует внимания, и список разделов. Каждый раздел — отдельный экран с поиском и фильтрами,
// действия над пользователем или сменой — в карточке, которая открывается по нажатию на строку
import { api } from './api.js';
import { CONFIG } from './config.js';
import { S, go, toast, errMsg, confirmBox, sheet, pageHead, statusTag, validate, avatar, ICON, toggle } from './ui.js';
import { esc, dateLabel, dateLong, timeAgo, payLabel, plural, shiftText, payoutLabel, timeRange } from './util.js';

const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
const ROLE = { worker: 'исполнитель', contractor: 'подрядчик' };
const row = ({ act, id = '', ic = '', av = '', title, sub = '', right = '', tone = '' }) => `<button class="arow ${tone}" data-act="${act}" ${id !== '' ? `data-id="${id}"` : ''}>${av || (ic ? `<span class="aic">${ICON[ic] || ''}</span>` : '')}<span class="atx"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</span>${right !== '' ? `<span class="ar">${right}</span>` : ''}<span class="ach">${ICON.chev}</span></button>`;
const list = (rows, empty = 'Ничего не найдено') => (rows.length ? `<div class="alist">${rows.join('')}</div>` : `<p class="mut aempty">${empty}</p>`);
const chips = (items, cur) => `<div class="tabsx afilt">${items.map(([k, t, n]) => `<span class="chip ${cur === k ? 'on' : ''}" data-act="f" data-f="${k}">${t}${n != null ? ` · ${n}` : ''}</span>`).join('')}</div>`;
const search = (ph) => `<label class="asearch">${ICON.search}<input id="aq" type="search" placeholder="${ph}" autocomplete="off" enterkeyhint="search"></label>`;
const needAdmin = () => { if (S.user.is_admin) return false; go('#/'); return true; };

// ---------- главный экран ----------
async function home(ctx) {
  if (needAdmin()) return;
  const s = await api.adminStats();
  const tiles = [['Заходили за сутки', s.active_24h], ['Открытые смены', s.open_shifts], ['Пользователи', s.users], ['Отклики', s.applications]];
  const attention = [
    s.reports_new && row({ act: 'go', id: 'reports', ic: 'info', title: `Новые жалобы: ${s.reports_new}`, sub: 'Разберите их в разделе «Жалобы»', tone: 'warn' }),
    s.errors_24h && `<div class="arow static warn"><span class="aic">${ICON.info}</span><span class="atx"><b>Ошибки в приложении за сутки: ${s.errors_24h}</b><span>Подробности — в журнале сервера, их смотрит разработчик</span></span></div>`,
  ].filter(Boolean);
  const sections = [
    row({ act: 'go', id: 'bot', ic: 'bell', title: 'Рассылки и трафик бота', sub: 'Написать пользователям, посмотреть, кто заходит' }),
    row({ act: 'go', id: 'users', ic: 'users', title: 'Пользователи', sub: `${s.workers} ${plural(s.workers, 'исполнитель', 'исполнителя', 'исполнителей')} · ${s.contractors} ${plural(s.contractors, 'подрядчик', 'подрядчика', 'подрядчиков')}`, right: s.users }),
    row({ act: 'go', id: 'shifts', ic: 'shifts', title: 'Смены', sub: 'Найти и скрыть объявление', right: s.shifts }),
    row({ act: 'go', id: 'reports', ic: 'info', title: 'Жалобы', sub: s.reports_new ? `Новых: ${s.reports_new}` : 'Новых нет', right: s.reports_new ? `<span class="abadge">${s.reports_new}</span>` : '' }),
    row({ act: 'go', id: 'cats', ic: 'work', title: 'Категории работ', sub: 'Названия и видимость' }),
    row({ act: 'go', id: 'audit', ic: 'clock', title: 'Журнал действий', sub: 'Кто что делал в приложении' }),
  ];
  ctx.render(`${pageHead('Админка')}
    <div class="atiles">${tiles.map(([t, n]) => `<div class="atile"><b>${n}</b><span>${t}</span></div>`).join('')}</div>
    ${attention.length ? `<div class="asect">Требует внимания</div>${list(attention)}` : ''}
    <button class="btn pri block" data-act="go" data-id="bot" style="margin:16px 0 4px">Новая рассылка</button>
    <div class="asect">Разделы</div>${list(sections)}
    ${s.fake_users ? `<p class="mut sm">Цифры — только настоящие люди. Тестовые: ${s.fake_users} ${plural(s.fake_users, 'пользователь', 'пользователя', 'пользователей')}, открытых смен: ${s.fake_open_shifts}.</p>` : ''}`);
  ctx.acts.go = (el) => go('#/admin/' + el.dataset.id);
}

// ---------- разделы ----------
const TITLES = { bot: 'Рассылки и трафик', users: 'Пользователи', shifts: 'Смены', reports: 'Жалобы', cats: 'Категории работ', audit: 'Журнал действий' };
async function section(ctx, key) {
  if (needAdmin()) return;
  ctx.render(`${pageHead(TITLES[key])}<div id="abody"><div class="skel"></div><div class="skel"></div></div>`);
  const body = document.getElementById('abody');
  await ({ bot: botSection, users: usersSection, shifts: shiftsSection, reports: reportsSection, cats: catsSection, audit: auditSection })[key](ctx, body);
}

// ----- пользователи: поиск, фильтр, действия в карточке -----
async function usersSection(ctx, body) {
  let all = await api.adminUsers(), q = '', f = 'all';
  const F = [['all', 'Все', (u) => !u.is_fake], ['worker', 'Исполнители', (u) => !u.is_fake && u.roles.includes('worker')], ['contractor', 'Подрядчики', (u) => !u.is_fake && u.roles.includes('contractor')], ['blocked', 'Заблокированы', (u) => u.blocked], ['fake', 'Тестовые', (u) => u.is_fake]];
  const match = (u) => !q || [u.name, u.first_name, u.username && '@' + u.username, String(u.tg_id)].some((v) => v && String(v).toLowerCase().includes(q));
  const badges = (u) => [u.is_admin && '<span class="tag y">админ</span>', u.blocked && '<span class="tag r">заблокирован</span>', u.verified && '<span class="tag g">проверен</span>', u.pro && '<span class="tag y">PRO</span>', u.is_fake && '<span class="tag">тест</span>'].filter(Boolean).join(' ');
  const draw = () => {
    const l = all.filter(F.find((x) => x[0] === f)[2]).filter(match);
    document.getElementById('alist').innerHTML = list(l.slice(0, 200).map((u) => row({ act: 'user', id: u.id, av: avatar(null, u.name, 'sm'), title: `${esc(u.name || 'Без имени')} ${badges(u)}`,
      sub: [u.roles.map((r) => ROLE[r] || r).join(', ') || 'не выбрал роль', u.username && '@' + esc(u.username)].filter(Boolean).join(' · ') })), q ? 'Никого не нашли' : 'Пусто')
      + (l.length > 200 ? `<p class="mut sm">Показаны первые 200 из ${l.length}. Уточните поиск.</p>` : '');
    document.getElementById('achips').innerHTML = chips(F.filter(([k, , fn]) => k === 'all' || all.some(fn)).map(([k, t, fn]) => [k, t, all.filter(fn).length]), f);
  };
  body.innerHTML = `${search('Имя, @ник или Telegram ID')}<div id="achips"></div><div id="alist"></div>`;
  draw();
  document.getElementById('aq').oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
  ctx.acts.f = (el) => { f = el.dataset.f; draw(); };
  const reload = async () => { all = await api.adminUsers(); draw(); };
  ctx.acts.user = (el) => {
    const u = all.find((x) => x.id === Number(el.dataset.id)); if (!u) return;
    const acts = [
      '<button class="btn block" data-a="consents">Согласия и документы</button>',
      u.roles.includes('contractor') && `<button class="btn block ${u.verified ? '' : 'pri'}" data-a="verify">${u.verified ? 'Снять «Проверенный подрядчик»' : 'Выдать «Проверенный подрядчик»'}</button>`,
      CONFIG.PRO_ENABLED && `<button class="btn block" data-a="pro">${u.pro ? 'Снять PRO' : 'Выдать PRO на 30 дней'}</button>`,
      !u.is_admin && `<button class="btn block ${u.blocked ? '' : 'danger'}" data-a="block">${u.blocked ? 'Разблокировать' : 'Заблокировать'}</button>`,
    ].filter(Boolean).join('');
    const s = sheet(`<div class="row">${avatar(null, u.name)}<div class="grow"><h3 style="margin:0">${esc(u.name || 'Без имени')}</h3><div class="sm">${badges(u)}</div></div></div>
      <div class="akv"><span>Роли</span><b>${esc(u.roles.map((r) => ROLE[r] || r).join(', ') || 'не выбрал')}</b><span>Telegram</span><b>${u.username ? '@' + esc(u.username) + ' · ' : ''}${esc(u.tg_id)}</b><span>Регистрация</span><b>${fmtDate(u.created_at)}</b><span>Номер</span><b>${u.phone_verified ? 'подтверждён' : 'не подтверждён'}</b></div>
      <div class="aacts">${acts}</div>`);
    s.el.onclick = async (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      try {
        if (b.dataset.a === 'consents') { s.close(); return consents(u); }
        if (b.dataset.a === 'verify') { await api.adminVerify(u.id, !u.verified); toast(u.verified ? 'Статус «Проверенный» снят' : 'Статус «Проверенный подрядчик» выдан', 'ok'); }
        if (b.dataset.a === 'pro') { if (u.pro) await api.adminRevokePro(u.id); else await api.adminGrantPro(u.id, 30); toast(u.pro ? 'PRO снята' : 'PRO выдана на 30 дней', 'ok'); }
        if (b.dataset.a === 'block') {
          if (!u.blocked && !(await confirmBox(`Заблокировать пользователя «${u.name || 'без имени'}»?`, { danger: true, ok: 'Заблокировать', sub: 'Он не сможет пользоваться приложением, его открытые смены скроются.' }))) return;
          await api.adminBlock(u.id, !u.blocked); toast(u.blocked ? 'Разблокирован' : 'Заблокирован', 'ok');
        }
      } catch (err) { return toast(errMsg(err), 'err'); }
      s.close(); reload();
    };
  };
}
// журнал согласий пользователя: документ, версия, время, принятие или отзыв, выбранные категории
async function consents(u) {
  const r = await api.adminConsents(u.id);
  const DOC = { age18: 'Подтверждение 18+', terms: 'Соглашение', additional: 'Доп. данные' }, ACT = { accept: 'принято', revoke: 'отозвано', decline: 'отказ' };
  sheet(`<h3>Согласия: ${esc(u.name || '')}</h3>${r.log.length ? `<div class="alist">${r.log.map((c) => `<div class="arow static"><span class="atx"><b>${DOC[c.doc] || esc(c.doc)} · ${ACT[c.action] || esc(c.action)}</b><span>версия ${esc(c.version)} · ${new Date(c.at).toLocaleString('ru-RU')}${(c.categories || []).length ? ' · ' + c.categories.map(esc).join(', ') : ''}</span></span></div>`).join('')}</div>` : '<p class="mut">Записей нет</p>'}`);
}

// ----- смены: поиск, фильтр, скрыть объявление -----
async function shiftsSection(ctx, body) {
  let all = await api.adminShifts(), q = '', f = 'open';
  const F = [['open', 'Открытые', (s) => ['open', 'full'].includes(s.status) && !s.hidden], ['hidden', 'Скрытые', (s) => s.hidden], ['done', 'Завершённые', (s) => s.status === 'completed'], ['all', 'Все', () => true]];
  const match = (s) => !q || [shiftText(s), s.address, s.contractor?.name, s.contractor?.company, String(s.id)].some((v) => v && String(v).toLowerCase().includes(q));
  const draw = () => {
    const l = all.filter(F.find((x) => x[0] === f)[2]).filter(match);
    document.getElementById('alist').innerHTML = list(l.map((s) => row({ act: 'shift', id: s.id, title: `<span class="clamp2">${esc(shiftText(s))}</span>`,
      sub: `${esc(dateLabel(s.date))} · ${esc(payLabel(s))} · ${esc(s.contractor?.company || s.contractor?.name || '')}`, right: s.hidden ? '<span class="tag r">скрыта</span>' : statusTag(s.status) })), q ? 'Ничего не нашли' : 'Пусто');
    document.getElementById('achips').innerHTML = chips(F.map(([k, t, fn]) => [k, t, all.filter(fn).length]), f);
  };
  body.innerHTML = `${search('Текст, адрес, подрядчик или номер')}<div id="achips"></div><div id="alist"></div>`;
  draw();
  document.getElementById('aq').oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
  ctx.acts.f = (el) => { f = el.dataset.f; draw(); };
  ctx.acts.shift = (el) => {
    const s = all.find((x) => x.id === Number(el.dataset.id)); if (!s) return;
    const sh = sheet(`<div class="row sp" style="gap:10px;align-items:flex-start"><h3 class="sh-full" style="margin:0">${esc(shiftText(s))}</h3>${s.hidden ? '<span class="tag r">скрыта</span>' : statusTag(s.status)}</div>
      <div class="akv"><span>Подрядчик</span><b>${esc(s.contractor?.company || s.contractor?.name || '')}</b><span>Когда</span><b>${esc(dateLabel(s.date))} · ${esc(timeRange(s))}</b><span>Оплата</span><b>${esc(payLabel(s))} · ${esc(payoutLabel(s))}</b><span>Адрес</span><b>${esc(s.address)}</b><span>Люди</span><b>${s.accepted_count} из ${s.people}</b><span>Номер</span><b>${s.id}</b></div>
      <div class="aacts"><button class="btn block ${s.hidden ? 'pri' : 'danger'}" data-a="hide">${s.hidden ? 'Снова показать в ленте' : 'Скрыть объявление'}</button><button class="btn block" data-a="open">Открыть смену</button></div>`);
    sh.el.onclick = async (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      if (b.dataset.a === 'open') { sh.close(); return go('#/w/shift/' + s.id); }
      try { await api.adminHideShift(s.id, !s.hidden); } catch (err) { return toast(errMsg(err), 'err'); }
      toast(s.hidden ? 'Объявление снова видно' : 'Объявление скрыто', 'ok'); sh.close(); all = await api.adminShifts(); draw();
    };
  };
}

// ----- жалобы -----
async function reportsSection(ctx, body) {
  let all = await api.adminReports(), f = all.some((r) => r.status === 'new') ? 'new' : 'all';
  const TARGET = { worker: 'На исполнителя', contractor: 'На подрядчика', shift: 'На смену', message: 'На сообщение' };
  const ST = { new: ['Новая', 'y'], in_progress: ['В работе', 'b'], resolved: ['Обработана', 'g'], rejected: ['Отклонена', ''] };
  const F = [['new', 'Новые', (r) => r.status === 'new'], ['in_progress', 'В работе', (r) => r.status === 'in_progress'], ['all', 'Все', () => true]];
  const draw = () => {
    const l = all.filter(F.find((x) => x[0] === f)[2]);
    body.innerHTML = chips(F.map(([k, t, fn]) => [k, t, all.filter(fn).length]), f) + (l.length ? l.map((r) => `<div class="card acard"><div class="row sp"><b>${TARGET[r.target_type] || esc(r.target_type)} №${r.target_id}</b><span class="tag ${ST[r.status]?.[1] || ''}">${ST[r.status]?.[0] || esc(r.status)}</span></div>
      <p class="atxt">${esc(r.reason)}</p><div class="mut sm">${esc(r.reporter_name || 'Пользователь ' + r.reporter)} · ${timeAgo(r.at)}</div>
      <div class="row gap wrap" style="margin-top:10px">${r.target_type === 'shift' ? `<button class="btn sm" data-act="openShift" data-id="${r.target_id}">Открыть смену</button>` : ''}${['in_progress', 'resolved', 'rejected'].filter((st) => st !== r.status).map((st) => `<button class="btn sm ${st === 'resolved' ? 'pri' : ''}" data-act="rep" data-id="${r.id}" data-s="${st}">${{ in_progress: 'В работу', resolved: 'Обработана', rejected: 'Отклонить' }[st]}</button>`).join('')}</div></div>`).join('') : `<p class="mut aempty">${f === 'new' ? 'Новых жалоб нет' : 'Пусто'}</p>`);
  };
  draw();
  ctx.acts.f = (el) => { f = el.dataset.f; draw(); };
  ctx.acts.openShift = (el) => go('#/w/shift/' + el.dataset.id);
  ctx.acts.rep = async (el) => { await api.adminResolveReport(Number(el.dataset.id), el.dataset.s); toast('Статус жалобы обновлён', 'ok'); all = await api.adminReports(); draw(); };
}

// ----- категории: видимость переключателем, название — по нажатию -----
async function catsSection(ctx, body) {
  const draw = async () => {
    const l = await api.adminCategories();
    body.innerHTML = `<button class="btn pri block" data-act="cat">Добавить категорию</button><p class="mut sm">Скрытая категория не предлагается в фильтрах. Смены с ней остаются на месте.</p>
      <div class="alist">${l.map((c) => `<div class="arow static"><button class="atx alink" data-act="cat" data-id="${c.id}" data-n="${esc(c.name)}"><b>${esc(c.name)}</b><span>${c.active ? 'видна' : 'скрыта'} · нажмите, чтобы переименовать</span></button>${toggle(c.active, 'catact', `data-id="${c.id}" data-n="${esc(c.name)}" data-a="${c.active ? 0 : 1}" aria-label="Видимость категории"`)}</div>`).join('')}</div>`;
  };
  await draw();
  ctx.acts.catact = async (el) => { await api.adminSaveCategory({ id: Number(el.dataset.id), name: el.dataset.n, active: el.dataset.a === '1' }); S.cats = await api.categories(); toast(el.dataset.a === '1' ? 'Категория снова видна' : 'Категория скрыта', 'ok'); draw(); };
  ctx.acts.cat = (el) => {
    const s = sheet(`<h3>${el.dataset.id ? 'Переименовать' : 'Новая'} категория</h3><input class="i" id="n" value="${esc(el.dataset.n || '')}" maxlength="60" placeholder="Например: Грузчики"><button class="btn pri block" style="margin-top:12px" id="ok">Сохранить</button>`);
    s.el.querySelector('#ok').onclick = async () => {
      const n = s.el.querySelector('#n'); if (!validate([[n, n.value.trim().length >= 2, 'Введите название категории']])) return;
      try { await api.adminSaveCategory({ id: el.dataset.id ? Number(el.dataset.id) : null, name: n.value.trim(), active: true }); } catch (e) { return toast(errMsg(e), 'err'); }
      s.close(); S.cats = await api.categories(); toast('Категория сохранена', 'ok'); draw();
    };
  };
}

// ----- журнал: понятные подписи вместо кодов -----
const ACTION = {
  'terms.accept': 'принял соглашение', 'shift.create': 'опубликовал смену', 'shift.update': 'изменил смену', 'shift.cancel': 'отменил смену', 'shift.complete': 'завершил смену', 'shift.hide': 'скрыл или показал смену', 'shift.boost': 'поднял смену в топ',
  'application.accepted': 'принял отклик', 'application.rejected': 'отклонил отклик', 'member.remove': 'исключил из команды', 'member.senior': 'назначил старшего', 'phone.verify': 'подтвердил номер', 'phone.reset': 'сменил номер',
  'account.delete': 'удалил аккаунт', 'user.block': 'заблокировал или разблокировал пользователя', 'contractor.verify': 'изменил статус «Проверенный»', 'category.save': 'изменил категорию', 'pro.grant': 'выдал PRO', 'pro.revoke': 'снял PRO',
  'admin.broadcast': 'сделал рассылку', 'admin.broadcast_cancel': 'остановил рассылку',
};
const metaText = (a) => {
  const m = a.meta || {}, id = m.id || m.sid || m.shift_id;
  if (a.action === 'admin.broadcast') return `${m.recipients} ${plural(m.recipients || 0, 'получатель', 'получателя', 'получателей')}`;
  if (a.action === 'admin.broadcast_cancel') return `не отправлено: ${m.stopped}`;
  if (a.action.startsWith('shift.') && id) return `смена №${id}${a.action === 'shift.hide' ? (m.hidden ? ', скрыта' : ', показана') : ''}`;
  if (m.uid || m.user_id) return `пользователь №${m.uid || m.user_id}`;
  return '';
};
async function auditSection(ctx, body) {
  const all = await api.adminAudit(); let f = 'all';
  const F = [['all', 'Все', () => true], ['admin', 'Админы', (a) => /^(admin|user|contractor|category|pro)\.|^shift\.hide$/.test(a.action)], ['shifts', 'Смены', (a) => /^(shift|application|member)\./.test(a.action)]];
  const draw = () => {
    const l = all.filter(F.find((x) => x[0] === f)[2]);
    body.innerHTML = chips(F.map(([k, t, fn]) => [k, t, all.filter(fn).length]), f) + list(l.map((a) => `<div class="arow static"><span class="atx"><b>${esc(a.actor_name || 'Пользователь ' + a.actor)} ${esc(ACTION[a.action] || a.action)}</b><span>${timeAgo(a.at)}${metaText(a) ? ' · ' + esc(metaText(a)) : ''}</span></span></div>`), 'Записей нет') + '<p class="mut sm">Последние 100 действий.</p>';
  };
  draw();
  ctx.acts.f = (el) => { f = el.dataset.f; draw(); };
}

// ---------- рассылки и трафик бота ----------
// Кнопка под сообщением открывает приложение: исполнителям — поиск смен, подрядчикам — главную
const AUD = [['workers', 'Исполнители'], ['contractors', 'Подрядчики'], ['all', 'Все']];
const AUD_TEXT = { workers: 'исполнителям', contractors: 'подрядчикам', all: 'всем пользователям' };
const AUD_LINK = { workers: 'Кнопка под сообщением откроет поиск смен.', contractors: 'Кнопка под сообщением откроет главную подрядчика.', all: 'Кнопка под сообщением откроет приложение.' };
const histCard = (h) => {
  const parts = [`доставлено ${h.delivered}`, h.unreachable && `не дошло ${h.unreachable}`, h.queued && `в очереди ${h.queued}`, h.skipped && `пропущено ${h.skipped}`, h.unknown && `отправлено до учёта доставки ${h.unknown}`, h.cancelled_count && `остановлено ${h.cancelled_count}`, `прочитали в приложении ${h.read}`].filter(Boolean);
  return `<div class="card acard"><div class="row sp"><b>${AUD.find(([k]) => k === h.audience)?.[1] || esc(h.audience)} · ${h.recipients}</b>${h.cancelled ? '<span class="tag r">остановлена</span>' : h.queued ? '<span class="tag y">отправляется</span>' : '<span class="tag g">отправлена</span>'}</div>
    <div class="mut sm">${new Date(h.at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}${h.author ? ' · ' + esc(h.author) : ''}</div>
    <p class="btxt">${esc(h.text)}</p><div class="sm mut">${parts.join(' · ')}</div>
    ${h.queued && !h.cancelled ? `<button class="btn sm danger" data-act="bstop" data-id="${h.id}" style="margin-top:8px">Остановить</button>` : ''}</div>`;
};
async function botSection(ctx, body) {
  const [b, hist] = await Promise.all([api.adminBotStats(), api.adminBroadcasts()]);
  const tiles = [['Новые за сутки', b.new_1d], ['Заходили за сутки', b.active_1d], ['Сообщений за сутки', b.sent_1d], ['Не дошло за неделю', b.unreachable_7d]];
  body.innerHTML = `<div class="asect" style="margin-top:4px">Новая рассылка</div>
    <div class="card acard">
      <label class="f" style="margin-top:0">Кому</label><div class="seg" id="aud">${AUD.map(([k, t]) => `<span class="chip ${k === 'workers' ? 'on' : ''}" data-act="aud" data-a="${k}">${t} · ${b.audience[k]}</span>`).join('')}</div>
      <label class="f">Текст сообщения</label><textarea class="i" id="btext" rows="5" maxlength="1000" placeholder="Например: есть новые смены на завтра, заходите и откликайтесь"></textarea>
      <div class="row sp sm" style="margin-top:4px"><span class="mut" id="bhint"></span><span class="mut" id="bcount">0 / 1000</span></div>
      <div class="row gap" style="margin-top:12px"><button class="btn grow" data-act="btest">Отправить себе</button><button class="btn pri grow" data-act="bsend" id="bsend"></button></div>
    </div>
    <div class="asect">История рассылок</div><div id="bhist"></div>
    <div class="asect">Трафик</div>
    <div class="atiles">${tiles.map(([t, n]) => `<div class="atile"><b>${n}</b><span>${t}</span></div>`).join('')}</div>
    ${b.queue ? `<p class="mut sm">Сейчас в очереди бота: ${b.queue}</p>` : ''}
    <table class="t bt"><tr><th>День</th><th>Новые</th><th>Заходили</th><th>Сообщений</th></tr>${b.days.map((d) => `<tr><td>${esc(dateLong(d.date))}</td><td>${d.new}</td><td>${d.active}</td><td>${d.sent}</td></tr>`).join('')}</table>
    <p class="mut sm">«Заходили» — открывали приложение. «Не дошло» — человек не запускал бота или заблокировал его: написать ему бот не может.</p>`;
  let aud = 'workers';
  const $ = (id) => document.getElementById(id), txt = $('btext');
  const sync = () => {
    $('bcount').textContent = `${txt.value.length} / 1000`;
    $('bhint').textContent = AUD_LINK[aud];
    $('bsend').textContent = `Отправить ${b.audience[aud]}`;
    $('bsend').disabled = !b.audience[aud];
    document.querySelectorAll('#aud [data-a]').forEach((x) => x.classList.toggle('on', x.dataset.a === aud));
  };
  const drawHist = (l) => { const el = $('bhist'); if (el) el.innerHTML = l.length ? l.map(histCard).join('') : '<p class="mut aempty">Рассылок пока не было</p>'; };
  txt.addEventListener('input', sync); sync(); drawHist(hist);
  // пока рассылка уходит, цифры обновляются сами; набранный текст при этом не сбрасывается
  ctx.poll = async () => { if ($('bhist')) drawHist(await api.adminBroadcasts()); };
  const text = () => txt.value.trim();
  const checkText = () => validate([[txt, text().length >= 2, 'Напишите текст рассылки']]);
  ctx.acts.aud = (el) => { aud = el.dataset.a; sync(); };
  ctx.acts.btest = async () => {
    if (!checkText()) return;
    await api.adminBroadcast({ audience: aud, text: text(), test: true });
    toast('Сообщение отправлено вам в Telegram для проверки', 'ok');
  };
  ctx.acts.bsend = async () => {
    if (!checkText()) return;
    const n = b.audience[aud];
    if (!(await confirmBox(`Отправить ${n} ${plural(n, 'получателю', 'получателям', 'получателям')}?`, { ok: 'Отправить', sub: `Сообщение уйдёт ${AUD_TEXT[aud]} в Telegram и появится в уведомлениях приложения. Отменить уже отправленное нельзя, неотправленное можно остановить. Текст: «${text().slice(0, 300)}${text().length > 300 ? '…' : ''}»` }))) return;
    try { const r = await api.adminBroadcast({ audience: aud, text: text() }); toast(`Рассылка запущена: ${r.recipients} ${plural(r.recipients, 'получатель', 'получателя', 'получателей')}`, 'ok'); }
    catch (e) { return toast(errMsg(e), 'err'); }
    txt.value = ''; sync(); drawHist(await api.adminBroadcasts());
  };
  ctx.acts.bstop = async (el) => {
    if (!(await confirmBox('Остановить рассылку?', { ok: 'Остановить', danger: true, sub: 'Кому сообщение ещё не ушло, тем оно не придёт. Уже доставленные останутся.' }))) return;
    const r = await api.adminCancelBroadcast(Number(el.dataset.id)); toast(`Остановлено, не отправлено: ${r.stopped}`, 'ok'); drawHist(await api.adminBroadcasts());
  };
}

export const adminRoutes = [[/^#\/admin$/, home], [/^#\/admin\/(bot|users|shifts|reports|cats|audit)$/, section]];
