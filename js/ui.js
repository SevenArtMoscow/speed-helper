// UI-компоненты, общее состояние
import { esc, initials, $, fmtPhone } from './util.js';
import { api } from './api.js';

export const S = { user: null, role: null, cats: [], route: '' };

export const BOLT = '<svg viewBox="0 0 24 24"><path fill="#39ff6a" d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>';
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
