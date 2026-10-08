// Админ-панель владельцев (доступ только при users.is_admin = true; проверяется и на сервере)
import { api } from './api.js';
import { S, go, toast, errMsg, confirmBox, sheet, pageHead, statusTag, validate } from './ui.js';
import { esc, dateLabel, timeAgo, payLabel } from './util.js';

const TABS = [['stats', 'Показатели'], ['users', 'Пользователи'], ['shifts', 'Смены'], ['reports', 'Жалобы'], ['cats', 'Категории'], ['audit', 'Журнал']];

async function admin(ctx, tab = 'stats') {
  if (!S.user.is_admin) return go('#/');
  const nav = `${pageHead('Админ-панель')}<div class="tabsx">${TABS.map(([k, t]) => `<span class="chip ${tab === k ? 'on' : ''}" data-act="t" data-t="${k}">${t}</span>`).join('')}</div>`;
  let body = '';
  if (tab === 'stats') {
    const s = await api.adminStats();
    const items = [['Пользователи', s.users], ['Исполнители', s.workers], ['Подрядчики', s.contractors], ['Смены', s.shifts], ['Открытые смены', s.open_shifts], ['Отклики', s.applications], ['Принято', s.accepted], ['Завершено смен', s.completed_shifts], ['Активны за 24ч', s.active_24h], ['Новые жалобы', s.reports_new], ['Ошибки за 24ч', s.errors_24h]];
    if (s.fake_users) items.push(['Тестовые пользователи', s.fake_users], ['Тестовые открытые смены', s.fake_open_shifts], ['Тестовые отклики', s.fake_applications]);
    body = `<div class="grid2">${items.map(([t, n]) => `<div class="stat"><b>${n}</b>${t}</div>`).join('')}</div>${s.fake_users ? '<p class="mut sm">Цифры выше — только настоящие люди; тестовые (симулятор) считаются отдельно.</p>' : ''}`;
  }
  if (tab === 'users') {
    const l = await api.adminUsers();
    body = l.map((u) => `<div class="card"><div class="row sp"><div><b>${esc(u.name)}</b> ${u.blocked ? '<span class="tag r">заблокирован</span>' : ''}${u.verified ? ' <span class="tag g">✓ проверен</span>' : ''}${u.is_admin ? '<span class="tag y">админ</span>' : ''}${u.is_fake ? ' <span class="tag">тест</span>' : ''}<div class="mut sm">tg ${u.tg_id} · ${u.roles.join(', ') || 'без роли'}</div></div>
      <div class="row gap">${u.roles.includes('contractor') ? `<button class="btn sm ${u.verified ? '' : 'pri'}" data-act="ver" data-id="${u.id}" data-v="${u.verified ? 0 : 1}">${u.verified ? 'Снять «Проверенный»' : '✓ Проверенный'}</button>` : ''}${u.is_admin ? '' : `<button class="btn sm ${u.blocked ? '' : 'danger'}" data-act="block" data-id="${u.id}" data-b="${u.blocked ? 0 : 1}">${u.blocked ? 'Разблок.' : 'Блок'}</button>`}</div></div></div>`).join('') || '<p class="mut">Пусто</p>';
  }
  if (tab === 'shifts') {
    const l = await api.adminShifts();
    body = l.map((s) => `<div class="card"><div class="row sp"><b>${esc(s.title)}</b>${statusTag(s.status)}</div><div class="mut sm">${esc(s.contractor?.name || '')} · ${esc(dateLabel(s.date))} · ${esc(payLabel(s))}${s.hidden ? ' · <span class="r">скрыта</span>' : ''}</div>
      <button class="btn sm" style="margin-top:8px" data-act="hide" data-id="${s.id}" data-h="${s.hidden ? 0 : 1}">${s.hidden ? 'Показать' : 'Скрыть объявление'}</button></div>`).join('') || '<p class="mut">Пусто</p>';
  }
  if (tab === 'reports') {
    const l = await api.adminReports();
    body = l.map((r) => `<div class="card"><div class="row sp"><b>${{ worker: 'На исполнителя', contractor: 'На подрядчика', shift: 'На смену', message: 'На сообщение' }[r.target_type]} #${r.target_id}</b><span class="tag ${r.status === 'new' ? 'y' : 'g'}">${{ new: 'Новая', in_progress: 'В работе', resolved: 'Обработана', rejected: 'Отклонена' }[r.status] || r.status}</span></div>
      <p>${esc(r.reason)}</p><div class="mut sm">от ${esc(r.reporter_name || r.reporter)} · ${timeAgo(r.at)}</div><div class="row gap wrap" style="margin-top:8px">${['in_progress', 'resolved', 'rejected'].map((st) => `<button class="btn sm" data-act="rep" data-id="${r.id}" data-s="${st}">${{ in_progress: 'В работу', resolved: 'Обработана', rejected: 'Отклонить' }[st]}</button>`).join('')}</div></div>`).join('') || '<p class="mut">Жалоб нет</p>';
  }
  if (tab === 'cats') {
    const l = await api.adminCategories();
    body = `<button class="btn pri block" data-act="cat">＋ Добавить категорию</button>${l.map((c) => `<div class="card row sp"><span>${esc(c.name)} ${c.active ? '' : '<span class="tag r">скрыта</span>'}</span><span><button class="btn sm" data-act="cat" data-id="${c.id}" data-n="${esc(c.name)}">Изменить</button> <button class="btn sm" data-act="catact" data-id="${c.id}" data-n="${esc(c.name)}" data-a="${c.active ? 0 : 1}">${c.active ? 'Скрыть' : 'Вернуть'}</button></span></div>`).join('')}`;
  }
  if (tab === 'audit') {
    const l = await api.adminAudit();
    body = `<table class="t">${l.map((a) => `<tr><td>${timeAgo(a.at)}</td><td>${esc(a.actor_name || 'user ' + a.actor)}</td><td>${esc(a.action)}</td><td class="mut">${esc(JSON.stringify(a.meta))}</td></tr>`).join('')}</table>`;
  }
  ctx.render(nav + body);
  const re = () => admin(ctx, tab);
  const run = (fn) => async (el) => { await fn(el); re(); };
  ctx.acts.t = (el) => admin(ctx, el.dataset.t);
  ctx.acts.block = async (el) => { const b = el.dataset.b === '1'; if (b && !(await confirmBox('Заблокировать аккаунт?', { danger: true, ok: 'Заблокировать' }))) return; await api.adminBlock(Number(el.dataset.id), b); toast('Готово', 'ok'); re(); };
  ctx.acts.ver = run(async (el) => { const v = el.dataset.v === '1'; await api.adminVerify(Number(el.dataset.id), v); toast(v ? 'Статус «Проверенный подрядчик» выдан' : 'Статус «Проверенный» снят', 'ok'); });
  ctx.acts.hide = run(async (el) => { const h = el.dataset.h === '1'; await api.adminHideShift(Number(el.dataset.id), h); toast(h ? 'Объявление скрыто' : 'Объявление снова видно', 'ok'); });
  ctx.acts.rep = run(async (el) => { await api.adminResolveReport(Number(el.dataset.id), el.dataset.s); toast('Статус жалобы обновлён', 'ok'); });
  ctx.acts.catact = run(async (el) => { await api.adminSaveCategory({ id: Number(el.dataset.id), name: el.dataset.n, active: el.dataset.a === '1' }); S.cats = await api.categories(); toast(el.dataset.a === '1' ? 'Категория снова доступна' : 'Категория скрыта', 'ok'); });
  ctx.acts.cat = (el) => {
    const s = sheet(`<h3>${el.dataset.id ? 'Изменить' : 'Новая'} категория</h3><input class="i" id="n" value="${esc(el.dataset.n || '')}"><button class="btn pri block" style="margin-top:12px" id="ok">Сохранить</button>`);
    s.el.querySelector('#ok').onclick = async () => {
      const n = s.el.querySelector('#n'); if (!validate([[n, n.value.trim().length >= 2, 'Введите название категории']])) return;
      try { await api.adminSaveCategory({ id: el.dataset.id ? Number(el.dataset.id) : null, name: n.value.trim(), active: true }); } catch (e) { return toast(errMsg(e), 'err'); }
      s.close(); S.cats = await api.categories(); toast('Категория сохранена', 'ok'); re();
    };
  };
}

export const adminRoutes = [[/^#\/admin$/, admin]];
