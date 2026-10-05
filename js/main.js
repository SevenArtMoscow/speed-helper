import { CONFIG } from './config.js';
import { api, login, tg, MODE, track, getSession } from './api.js';
import { S, logo, go, back, toast, errMsg, skeleton, setBell } from './ui.js';
import { $, esc } from './util.js';
import { commonRoutes } from './screens-common.js';
import { workerRoutes } from './screens-worker.js';
import { contractorRoutes } from './screens-contractor.js';
import { adminRoutes } from './screens-admin.js';

const app = document.getElementById('app');
const ROUTES = [...commonRoutes, ...workerRoutes, ...contractorRoutes, ...adminRoutes];
const ctx = { main: null, acts: {}, poll: null, cleanup: null,
  render(html, { full = false } = {}) { this.main.className = full ? 'nopad' : ''; this.main.style.overflow = full ? 'hidden' : ''; this.main.innerHTML = html; } };
export { ctx };

const TABS = {
  worker: [['#/w/search', '🔍', 'Поиск'], ['#/w/mine', '📋', 'Мои смены'], ['#/chats', '💬', 'Чаты'], ['#/w/fav', '⭐', 'Избранное'], ['#/w/profile', '👤', 'Профиль']],
  contractor: [['#/c/home', '🏠', 'Главная'], ['#/c/shifts', '📋', 'Смены'], ['#/chats', '💬', 'Чаты'], ['#/c/fav', '⭐', 'Избранное'], ['#/c/profile', '👤', 'Профиль']],
};

function shell() {
  app.innerHTML = `${MODE === 'local' ? '<div class="banner">Локальный режим: данные хранятся только в этом браузере</div>' : ''}
    <div class="top">${logo()}<div class="sp"></div><button class="iconbtn" data-act="bell" aria-label="Уведомления">🔔<span class="badge" id="bell" hidden></span></button></div>
    <main id="main"></main><nav class="tabs" id="tabs" hidden></nav>`;
  ctx.main = $('#main');
  app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]'); if (!el || el.dataset.busy) return;
    const name = el.dataset.act;
    if (el.tagName === 'A') e.preventDefault(); // ссылки-действия href="#" не должны уводить на главную
    if (name === 'back') return back();
    if (name === 'bell') return go('#/notifications');
    const fn = ctx.acts[name]; if (!fn) return;
    el.dataset.busy = '1'; // защита от повторных нажатий
    try { await fn(el, e); } catch (err) { console.error(err); toast(errMsg(err), 'err'); } finally { delete el.dataset.busy; }
  });
}

export function renderTabs(hash) {
  const t = $('#tabs'), tabs = TABS[S.role];
  if (!tabs || hash.startsWith('#/team') || hash.startsWith('#/chat/') || hash.startsWith('#/admin') || hash === '#/welcome' || hash.includes('onboard')) { t.hidden = true; return; }
  t.hidden = false;
  const unread = S.user ? S.user.unread : 0;
  t.innerHTML = tabs.map(([h, ic, l]) => `<a href="${h}" class="${hash.startsWith(h) || (h === '#/w/search' && hash.startsWith('#/w/shift')) || (h === '#/c/shifts' && hash.startsWith('#/c/shift/')) ? 'on' : ''}"><span class="ic">${ic}</span>${l}</a>`).join('');
}

let navToken = 0;
async function route() {
  const hash = location.hash || '#/';
  S.route = hash;
  if (ctx.cleanup) { try { ctx.cleanup(); } catch {} }
  ctx.acts = {}; ctx.poll = null; ctx.cleanup = null;
  const my = ++navToken;
  document.querySelectorAll('.ov,.toast').forEach((n) => n.remove());
  ctx.render(skeleton());
  try {
    let h = hash;
    if (h === '#/' || h === '#') {
      if (!S.role || !(S.user.roles || []).includes(S.role)) h = '#/welcome';
      else h = S.role === 'contractor' ? '#/c/home' : '#/w/search';
      if (location.hash !== h) { history.replaceState(null, '', h); }
    }
    for (const [re, fn] of ROUTES) {
      const m = h.match(re);
      if (m) { renderTabs(h); await fn(ctx, ...m.slice(1)); if (my !== navToken) return; ctx.main.scrollTop = 0; track('screen', { r: h.split('/').slice(0, 3).join('/') }); return; }
    }
    go('#/');
  } catch (e) {
    console.error(e);
    if (my !== navToken) return;
    ctx.render(`<div class="empty"><h2>Что-то пошло не так</h2><p>${esc(errMsg(e))}</p><button class="btn pri" onclick="location.reload()">Обновить</button></div>`);
  }
}

async function tick() {
  if (document.hidden || !S.user) return;
  try { const u = await api.me(); if (u.unread !== S.user.unread) { S.user = u; setBell(); } else S.user = u; if (ctx.poll) await ctx.poll(); } catch {}
}

async function boot() {
  if (tg) { tg.ready(); tg.expand(); try { tg.setHeaderColor('#0b0c0e'); tg.setBackgroundColor('#0b0c0e'); } catch {} }
  const fit = () => { app.style.height = (window.visualViewport ? window.visualViewport.height : innerHeight) + 'px'; };
  fit(); window.visualViewport && window.visualViewport.addEventListener('resize', fit); addEventListener('resize', fit);
  const ua = navigator.userAgent.slice(0, 120);
  window.addEventListener('error', (e) => api.logError({ message: e.message, src: e.filename, line: e.lineno, stack: e.error && String(e.error.stack || '').slice(0, 500), screen: location.hash, ua }).catch(() => {}));
  window.addEventListener('unhandledrejection', (e) => api.logError({ message: 'unhandled: ' + String((e.reason && e.reason.message) || e.reason).slice(0, 300), stack: e.reason && String(e.reason.stack || '').slice(0, 500), screen: location.hash, ua }).catch(() => {}));
  shell();
  ctx.render(skeleton());
  try {
    S.user = await login();
    S.cats = await api.categories();
  } catch (e) {
    ctx.render(`<div class="empty"><h2>Не удалось войти</h2><p>${esc(errMsg(e))}</p>${tg ? '' : '<p class="sm">Откройте приложение через Telegram-бота.</p>'}<button class="btn pri" onclick="location.reload()">Повторить</button></div>`);
    return;
  }
  // переход из уведомления бота: ?r=/c/shift/5 → #/c/shift/5
  const deep = new URLSearchParams(location.search).get('r');
  if (deep && /^\/[\w\/-]*$/.test(deep)) history.replaceState(null, '', location.pathname + '#' + deep);
  S.role = localStorage.getItem('sh_role_' + S.user.id);
  if (!S.role && S.user.roles.length === 1) S.role = S.user.roles[0];
  setBell();
  window.addEventListener('hashchange', route);
  setInterval(tick, CONFIG.POLL_MS);
  document.addEventListener('visibilitychange', () => !document.hidden && tick());
  track('app_open', { v: CONFIG.APP_VERSION });
  route();
}
boot();
