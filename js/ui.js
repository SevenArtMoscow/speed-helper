// UI-компоненты, общее состояние
import { esc, initials, $, fmtPhone } from './util.js';
import { api } from './api.js';

export const S = { user: null, role: null, cats: [], route: '' };

export const BOLT = '<svg viewBox="0 0 24 24"><path fill="#39ff6a" d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>';
// Линейные иконки 24×24 (цвет — currentColor): нижнее меню и шапка
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
export const ICON = {
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/><path class="f" d="M11.6 7.6 9.4 11h2.4l-.6 3.4 2.4-3.6h-2.3z"/>'),
  mine: svg('<rect x="5" y="4.5" width="14" height="16.5" rx="2.5"/><path d="M9 4.5V3.5h6v1"/><path d="m9 13 2.2 2.2L15.5 11"/>'),
  chats: svg('<path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 19.8l1.2-4.4A8 8 0 1 1 20.5 11.5z"/><path d="M8.5 11.5h.01M12.5 11.5h.01M16.5 11.5h.01" stroke-width="2.6"/>'),
  fav: svg('<path d="m12 3.3 2.7 5.5 6 .9-4.35 4.25 1.03 6L12 17.1l-5.38 2.85 1.03-6L3.3 9.7l6-.9z"/>'),
  profile: svg('<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c.6-3.9 3.7-6.3 7.5-6.3s6.9 2.4 7.5 6.3"/>'),
  home: svg('<path d="M3.5 10.5 12 4l8.5 6.5"/><path d="M5.5 9v11h4.5v-6h4v6h4.5V9"/>'),
  shifts: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14h3M8 17h6"/>'),
  bell: svg('<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.8 1.8H4.2z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
};
export const logo = () => `<div class="logo">${BOLT}<span>SPEED HELPER</span></div>`;
export const go = (hash) => { if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = hash; };
export const back = () => { if (history.length > 1) history.back(); else go(S.role === 'contractor' ? '#/c/home' : '#/w/search'); };

export function toast(msg, kind = '') {
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; document.body.appendChild(t);
  if (navigator.vibrate && kind === 'ok') navigator.vibrate(10);
  setTimeout(() => t.remove(), 2600);
}
export const errMsg = (e) => (e && e.message && e.code !== 'server' ? e.message : 'Не удалось выполнить действие. Попробуйте ещё раз');

export function sheet(html, { mid = false } = {}) {
  const ov = document.createElement('div'); ov.className = 'ov' + (mid ? ' mid' : '');
  ov.innerHTML = `<div class="${mid ? 'dlg' : 'sheet'}">${html}</div>`;
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.body.appendChild(ov);
  return { el: ov.firstElementChild, close };
}

export function confirmBox(text, { ok = 'Да', cancel = 'Отмена', danger = false, sub = '' } = {}) {
  return new Promise((res) => {
    const s = sheet(`<h3>${esc(text)}</h3>${sub ? `<p class="mut sm">${esc(sub)}</p>` : ''}<div class="row gap" style="margin-top:16px"><button class="btn ghost grow" data-v="0">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'pri'} grow" data-v="1">${esc(ok)}</button></div>`, { mid: true });
    s.el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) { s.close(); res(b.dataset.v === '1'); } });
    s.el.parentElement.addEventListener('click', (e) => { if (e.target === s.el.parentElement) res(false); });
  });
}

export const avatar = (src, name, cls = '') => (src ? `<img class="av ${cls}" src="${esc(src)}" alt="">` : `<div class="av ${cls}">${esc(initials(name))}</div>`);
export const stars = (r, n) => (r == null ? '<span class="mut sm">Нет оценок</span>' : `<span class="star">★</span> <b>${r.toFixed(1)}</b>${n != null ? ` <span class="mut sm">(${n})</span>` : ''}`);
export const verifiedTag = (v, text) => (v ? `<span class="tag g">✓ ${text}</span>` : '');
export const pageHead = (title, right = '') => `<div class="row sp" style="margin:4px 0 8px"><div class="row"><button class="iconbtn" data-act="back" aria-label="Назад" style="padding-left:0">‹</button><h1 style="margin:0">${esc(title)}</h1></div>${right}</div>`;
export const skeleton = (n = 3) => Array.from({ length: n }, () => '<div class="skel"></div>').join('');
export const emptyState = (title, text = '', btn = '') => `<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p>${btn}</div>`;
export const toggle = (on, act, data = '') => `<div class="switch ${on ? 'on' : ''}" data-act="${act}" ${data} role="switch" aria-checked="${!!on}"><i></i></div>`;

// ---------- проверка форм: пропущенные поля подсвечиваются красным с подсказкой ----------
// Блок поля — само поле или его обёртка (.row с кнопкой, ряд чипов); подсказка ставится сразу после блока.
const fieldBox = (el) => (el.closest('[data-field]') || (el.parentElement && el.parentElement.classList.contains('row') && el.tagName !== 'DIV' ? el.parentElement : el));
export function clearError(el) {
  const box = fieldBox(el); box.classList.remove('bad');
  if (box.nextElementSibling && box.nextElementSibling.classList.contains('ferr')) box.nextElementSibling.remove();
}
export function markError(el, msg) {
  clearError(el); const box = fieldBox(el); box.classList.add('bad');
  const e = document.createElement('div'); e.className = 'ferr'; e.textContent = msg; box.after(e);
  // подсветка снимается, как только поле начали исправлять
  const off = () => { clearError(el); el.removeEventListener('input', off); el.removeEventListener('change', off); el.removeEventListener('click', off); };
  el.addEventListener('input', off); el.addEventListener('change', off); if (el.tagName === 'DIV') el.addEventListener('click', off);
}
// звёздочка обязательного поля («Имя *») — красная
export const reqMark = (html) => html.replace(/ \*<\/label>/g, ' <span class="req">*</span></label>');
// checks: [[элемент, условие_ок, текст], ...]. Возвращает true, если всё заполнено.
export function validate(checks) {
  let first = null;
  for (const [el, good, msg] of checks) { if (!el) continue; if (good) clearError(el); else { markError(el, msg); first = first || el; } }
  if (!first) return true;
  fieldBox(first).scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(first.tagName)) setTimeout(() => first.focus({ preventScroll: true }), 300);
  if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
  toast(checks.filter(([el, g]) => el && !g).length > 1 ? 'Заполните поля, выделенные красным' : checks.find(([el, g]) => el && !g)[2], 'err');
  return false;
}

// Маска телефона «+7 (XXX) XXX-XX-XX» на поле ввода. Возвращает () => 10 цифр номера.
export const phoneField = (id, value) => `<input class="i" id="${id}" type="tel" inputmode="tel" autocomplete="tel" maxlength="18" value="${esc(fmtPhone(value))}" placeholder="+7 (___) ___-__-__">`;
export function maskPhone(el) {
  let prev = el.value.replace(/\D/g, '').slice(1);
  el.addEventListener('input', (e) => {
    const raw = el.value, all = raw.replace(/\D/g, '');
    // «+7» маски и первая набранная 7/8 — код страны; вставка 8XXXXXXXXXX / +7XXXXXXXXXX тоже обрезается
    let d = raw.startsWith('+7') ? all.slice(1) : all;
    if (d.length >= 11 && /^[78]/.test(d)) d = d.slice(1);
    if (!prev && /^[78]$/.test(d)) d = '';
    d = d.slice(0, 10);
    if (e.inputType === 'deleteContentBackward' && d === prev) d = d.slice(0, -1); // стёрли скобку/дефис — стираем цифру перед ними
    el.value = d ? fmtPhone(d) : (all ? '+7 (' : '');
    prev = d;
  });
  el.addEventListener('focus', () => { if (!el.value) el.value = '+7 ('; });
  el.addEventListener('blur', () => { if (!prev) el.value = ''; });
  return () => prev;
}

export const STATUS = {
  pending: ['В ожидании', 'y'], accepted: ['Подтверждена', 'g'], rejected: ['Отклонена', 'r'], cancelled: ['Отменена', 'r'], completed: ['Завершена', ''],
  open: ['Открыта', 'g'], full: ['Набрана', 'y'],
};
export const statusTag = (st) => { const [t, c] = STATUS[st] || [st, '']; return `<span class="tag ${c}">${t}</span>`; };

export function mountStars(root, initial = 0) {
  const w = root; let v = initial;
  const paint = () => w.querySelectorAll('span').forEach((s, i) => s.classList.toggle('on', i < v));
  w.innerHTML = [1, 2, 3, 4, 5].map((i) => `<span data-i="${i}">★</span>`).join(''); paint();
  w.addEventListener('click', (e) => { const s = e.target.closest('[data-i]'); if (s) { v = Number(s.dataset.i); paint(); } });
  return () => v;
}

export function setBell() { const b = $('#bell'); if (!b) return; const n = S.user ? S.user.unread : 0; b.hidden = !n; b.textContent = n > 9 ? '9+' : n; }
export async function refreshMe() { S.user = await api.me(); setBell(); return S.user; }
export const setRole = (r) => { S.role = r; localStorage.setItem('sh_role_' + S.user.id, r); };
