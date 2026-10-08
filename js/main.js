import { CONFIG } from './config.js';
import { api, login, tg, MODE, track, getSession, publicConfig } from './api.js';
import { S, logo, go, back, toast, errMsg, skeleton, setBell, ICON, haptic } from './ui.js';
import { $, esc } from './util.js';
import { commonRoutes } from './screens-common.js';
import { workerRoutes } from './screens-worker.js';
import { contractorRoutes } from './screens-contractor.js';
import { adminRoutes } from './screens-admin.js';

const app = document.getElementById('app');

// ---------- заставка ----------
// Уходит только когда готово: вход выполнен, категории загружены, первый экран отрисован, шрифты и карта подгружены в фоне.
// Минимум по времени — чтобы успела проиграться анимация (в этой же сессии повторно — короче).
const splash = (() => {
  const el = document.getElementById('splash'), bar = document.getElementById('spbar'), hint = document.getElementById('sphint');
  const seen = (() => { try { return sessionStorage.getItem('sh_splash') === '1'; } catch { return false; } })();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MIN = reduced ? 500 : seen ? 1300 : 2900; // мс от начала загрузки страницы
  let gone = false;
  const slow = setTimeout(() => hint && (hint.hidden = false), 6000);
  const hard = setTimeout(() => finish(), 20000); // страховка: что бы ни случилось, заставка не вечная
  function step(p) { if (bar && !gone) bar.style.width = p + '%'; }
  async function finish() {
    if (gone || !el) return; gone = true; clearTimeout(slow); clearTimeout(hard);
    step(100);
    const wait = MIN - performance.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    el.classList.add('out'); try { sessionStorage.setItem('sh_splash', '1'); } catch {}
    setTimeout(() => el.remove(), 700);
  }
  return { step, finish };
})();
splash.step(18);
const ROUTES = [...commonRoutes, ...workerRoutes, ...contractorRoutes, ...adminRoutes];
const ctx = { main: null, acts: {}, poll: null, cleanup: null,
  render(html, { full = false } = {}) { this.main.className = full ? 'nopad' : ''; this.main.style.overflow = full ? 'hidden' : ''; this.main.innerHTML = html; } };
export { ctx };

// В центре — главное действие (как в TikTok): у исполнителя «Найти», у подрядчика «Опубликовать»
const TABS = {
  worker: [['#/w/mine', 'mine', 'Мои смены'], ['#/w/fav', 'fav', 'Избранное'], ['#/w/search', 'search', 'Найти', true], ['#/chats', 'chats', 'Чаты'], ['#/w/profile', 'profile', 'Профиль']],
  contractor: [['#/c/home', 'home', 'Главная'], ['#/c/shifts', 'shifts', 'Смены'], ['#/c/create', 'plus', 'Опубликовать', true], ['#/chats', 'chats', 'Чаты'], ['#/c/profile', 'profile', 'Профиль']],
};

function shell() {
  app.innerHTML = `${MODE === 'local' ? '<div class="banner">Локальный режим: данные хранятся только в этом браузере</div>' : ''}
    <div class="top">${logo()}<div class="sp"></div><button class="iconbtn topbtn" data-act="top" id="topbtn" aria-label="Рейтинг исполнителей" hidden>${ICON.trophy}</button><button class="iconbtn bellbtn" data-act="bell" aria-label="Уведомления">${ICON.bell}<span class="badge" id="bell" hidden></span></button></div>
    <main id="main"></main><nav class="tabs" id="tabs" hidden></nav>`;
  ctx.main = $('#main');
  app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]'); if (!el || el.dataset.busy) return;
    const name = el.dataset.act;
    if (el.tagName === 'A') e.preventDefault(); // ссылки-действия href="#" не должны уводить на главную
    if (name === 'back') return back();
    if (name === 'bell') return go('#/notifications');
    if (name === 'top') return go('#/w/top');
    const fn = ctx.acts[name]; if (!fn) return;
    haptic('light');
    el.dataset.busy = '1'; // защита от повторных нажатий
    try { await fn(el, e); } catch (err) { console.error(err); toast(errMsg(err), 'err'); } finally { delete el.dataset.busy; }
  });
}

export function renderTabs(hash) {
  const t = $('#tabs'), tabs = TABS[S.role];
  const tb = $('#topbtn'); if (tb) tb.hidden = S.role !== 'worker';
  if (!tabs || hash.startsWith('#/team') || hash.startsWith('#/chat/') || hash.startsWith('#/admin') || hash === '#/welcome' || hash === '#/consent' || hash.includes('onboard')) { t.hidden = true; if (tb) tb.hidden = true; return; }
  t.hidden = false;
  const unread = S.user ? S.user.unread : 0;
  t.innerHTML = tabs.map(([h, ic, l, center]) => `<a href="${h}" class="${center ? 'center ' : ''}${hash.startsWith(h) || (h === '#/w/search' && (hash.startsWith('#/w/shift') || hash === '#/w/skipped')) || (h === '#/c/shifts' && hash.startsWith('#/c/shift/')) || (h === '#/c/home' && hash.startsWith('#/c/workers')) || (h === '#/w/mine' && hash.startsWith('#/review/')) ? 'on' : ''}"><span class="ic">${ICON[ic]}</span>${l}</a>`).join('');
}

// плавное появление экрана (карточки выезжают по очереди) и «счётчики» чисел на плитках; при «меньше движения» в системе — без анимации
function rise(main) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  main.classList.add('anim'); setTimeout(() => main.classList.remove('anim'), 700);
  main.querySelectorAll('.stat b, .stats3 .st b').forEach((b) => {
    const t = b.textContent.trim(); if (!/^\d{1,6}$/.test(t)) return; const to = +t, t0 = performance.now();
    (function f(now) { const k = Math.min(1, (now - t0) / 700), e = 1 - Math.pow(1 - k, 3); b.textContent = k < 1 ? Math.round(to * e) : t; if (k < 1) requestAnimationFrame(f); })(t0);
  });
}
let navToken = 0;
async function route() {
  const hash = location.hash || '#/';
  S.route = hash;
  if (ctx.cleanup) { try { ctx.cleanup(); } catch {} }
  ctx.acts = {}; ctx.poll = null; ctx.cleanup = null;
  const my = ++navToken;
  document.querySelectorAll('.ov').forEach((n) => n.remove());
  ctx.render(skeleton());
  try {
    let h = hash;
    if (h === '#/' || h === '#') {
      if (!S.role || !(S.user.roles || []).includes(S.role)) h = '#/welcome';
      else h = S.role === 'contractor' ? '#/c/home' : '#/w/search';
      if (location.hash !== h) { history.replaceState(null, '', h); }
    }
    // без принятия соглашения дальше экрана согласия не пускаем
    if (S.user && S.user.terms_accepted === false && h !== '#/consent') { h = '#/consent'; if (location.hash !== h) history.replaceState(null, '', h); }
    for (const [re, fn] of ROUTES) {
      const m = h.match(re);
      if (m) { renderTabs(h); await fn(ctx, ...m.slice(1)); if (my !== navToken) return; ctx.main.scrollTop = 0; rise(ctx.main); track('screen', { r: h.split('/').slice(0, 3).join('/') }); return; }
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
  splash.step(32);
  try {
    S.user = await login();
    splash.step(58);
    S.cats = await api.categories();
    splash.step(76);
    publicConfig().then((c) => (S.cfg = c));
  } catch (e) {
    ctx.render(`<div class="empty"><h2>Не удалось войти</h2><p>${esc(errMsg(e))}</p>${tg ? '' : '<p class="sm">Откройте приложение через Telegram-бота.</p>'}<button class="btn pri" onclick="location.reload()">Повторить</button></div>`);
    splash.finish();
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
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  track('app_open', { v: CONFIG.APP_VERSION });
  await route();
  splash.step(92);
  // пока заставка играет: догружаем шрифты и библиотеку карты, чтобы потом открывалось мгновенно
  await Promise.allSettled([document.fonts ? document.fonts.ready : null, import('./maps.js').then((x) => x.warmMap())]);
  splash.finish();
}
boot();
