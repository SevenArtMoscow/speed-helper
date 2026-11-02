// Игра «Рейс»: экраны (рейсы, задания, гараж) и сам заезд. 3D и движок подгружаются только при входе в заезд или гараж.
import { api, tg, MODE } from './api.js';
import { S, go, toast, errMsg, pageHead, ICON, haptic, tick, prefs } from './ui.js';
import { esc } from './util.js';
import { LEVELS, ZONES, ENDLESS, TRUCKS, PAINTS, UPGRADES, UPGRADE_COST, QUESTS, MILESTONES, DAILY_BONUS, DAILY_CAP, Run, levelById, questById, truckById, paintById, upgradeSeconds, xpForLevel } from './game-core.js';

const BOLT = '<svg class="g-bolt" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>';
const fillIc = (p) => `<svg class="g-ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${p}</svg>`;
const lineIc = (p) => `<svg class="g-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC = {
  star: fillIc('<path d="m12 2.8 2.85 5.95 6.55.87-4.8 4.55 1.22 6.48L12 17.5l-5.82 3.15 1.22-6.48L2.6 9.62l6.55-.87z"/>'),
  heart: fillIc('<path d="M12 21s-8.5-5.2-8.5-11.4A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8.5 2.6C20.5 15.8 12 21 12 21z"/>'),
  play: fillIc('<path d="M8 5.2v13.6a.6.6 0 0 0 .9.5l10.8-6.8a.6.6 0 0 0 0-1L8.9 4.7a.6.6 0 0 0-.9.5z"/>'),
  pause: fillIc('<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>'),
  lock: lineIc('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  infinity: lineIc('<path d="M7.5 8.2a3.8 3.8 0 1 0 0 7.6c3.4 0 5.6-7.6 9-7.6a3.8 3.8 0 1 1 0 7.6c-3.4 0-5.6-7.6-9-7.6z"/>'),
  box: lineIc('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>'),
  magnet: lineIc('<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4zM6 8.5h4M14 8.5h4"/>'),
  shield: lineIc('<path d="M12 3.2 5 6v5.6c0 4.2 2.9 7.5 7 9.2 4.1-1.7 7-5 7-9.2V6z"/>'),
  check: lineIc('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  circle: lineIc('<circle cx="12" cy="12" r="7.5"/>'),
  chev: lineIc('<path d="m9 6 6 6-6 6"/>'),
};
const nf = new Intl.NumberFormat('ru-RU'), fmt = (n) => nf.format(Number(n || 0));
const starRow = (n, max = 3) => `<span class="g-stars">${Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}">${IC.star}</i>`).join('')}</span>`;
const unlocked = (st, id) => id === 1 || Number(st.stars[id - 1] || 0) >= 1;
const lastTab = () => { try { return sessionStorage.getItem('sh_game_tab') || 'runs'; } catch { return 'runs'; } };
const keepTab = (t) => { try { sessionStorage.setItem('sh_game_tab', t); } catch {} };

// ---------- плашка на главной и в профиле ----------
export const gameBanner = () => `<button class="g-banner" data-act="openGame" type="button" aria-label="Открыть игру Рейс">
  <span class="g-banner-ic">${ICON.truck}</span><span class="g-banner-tx"><b>Рейс</b><span>Мини-игра: рейсы на грузовике, бонусы и гараж</span></span><span class="g-banner-go">${IC.chev}</span></button>`;

// ---------- главный экран игры ----------
async function hub(ctx) {
  let st = await api.gameState(), tab = lastTab(), preview = null, stopPreview = null;
  const quests = () => st.quests.map((q) => ({ ...questById(q.id), ...q }));
  const milestoneView = () => st.milestones.map((m) => ({ ...MILESTONES.find((x) => x.id === m.id), ...m }));
  const readyCount = () => quests().filter((q) => !q.claimed && q.progress >= q.target).length + milestoneView().filter((m) => !m.claimed && m.progress >= m.target).length + (st.bonus.available ? 1 : 0);
  const head = () => {
    const a = xpForLevel(st.level), b = xpForLevel(st.level + 1), pct = Math.round(((st.xp - a) / (b - a)) * 100);
    return `${pageHead('Рейс')}<div class="g-top"><div class="g-lvl"><b>${st.level}</b><span>уровень</span></div><div class="g-xp"><div class="g-xpbar"><i style="width:${pct}%"></i></div><span class="mut sm">${fmt(st.xp - a)} / ${fmt(b - a)} опыта</span></div><div class="g-coins">${BOLT}<b id="gcoins">${fmt(st.coins)}</b></div></div>
      <div class="g-tabs">${[['runs', 'Рейсы'], ['tasks', 'Задания'], ['garage', 'Гараж']].map(([k, t]) => `<button class="g-tab ${tab === k ? 'on' : ''}" data-act="gtab" data-t="${k}">${t}${k === 'tasks' && readyCount() ? `<sup>${readyCount()}</sup>` : ''}</button>`).join('')}</div>`;
  };
  const runsTab = () => {
    const stars = Object.values(st.stars).reduce((s, n) => s + Number(n), 0);
    const zones = Object.keys(ZONES).map((z) => {
      const list = LEVELS.filter((l) => l.zone === z);
      const open = list.some((l) => unlocked(st, l.id));
      return `<div class="g-zone ${z}"><div class="g-zone-h"><span>${ZONES[z].name}</span><span class="mut sm">${IC.star} ${list.reduce((s, l) => s + Number(st.stars[l.id] || 0), 0)} / ${list.length * 3}</span></div><div class="g-levels ${open ? '' : 'off'}">${list.map((l) => {
        const on = unlocked(st, l.id), n = Number(st.stars[l.id] || 0);
        return `<button class="g-level ${on ? '' : 'lock'} ${n ? 'done' : ''}" ${on ? `data-act="playLevel" data-id="${l.id}"` : 'disabled'} aria-label="${esc(l.name)}">${on ? `<b>${l.id}</b>${starRow(n)}` : `<span class="g-lock">${IC.lock}</span>`}</button>`;
      }).join('')}</div></div>`;
    }).join('');
    return `<button class="g-endless" data-act="playEndless"><span class="g-e-ic">${IC.infinity}</span><span class="g-e-tx"><b>${ENDLESS.name}</b><span>До первого удара. Рекорд: ${fmt(st.best_endless)} м</span></span><span class="g-play-ic">${IC.play}</span></button>
      <div class="mut sm" style="margin:12px 2px 2px">Звёзды: ${stars} из ${LEVELS.length * 3}. Новый рейс открывается после прохождения предыдущего.</div>${zones}${disclaimer()}`;
  };
  const questRow = (q, act) => {
    const done = q.progress >= q.target, pct = Math.min(100, Math.round((q.progress / q.target) * 100));
    return `<div class="g-quest ${q.claimed ? 'claimed' : ''}"><div class="grow"><b>${esc(q.title)}</b><div class="g-qbar"><i style="width:${pct}%"></i></div><span class="mut sm">${fmt(q.progress)} / ${fmt(q.target)}</span></div>
      ${q.claimed ? `<span class="g-got">${IC.check}</span>` : done ? `<button class="btn pri sm" data-act="${act}" data-id="${q.id}">${BOLT}${fmt(q.reward)}</button>` : `<span class="g-rew">${BOLT}${fmt(q.reward)}</span>`}</div>`;
  };
  const tasksTab = () => {
    const streak = Math.min(st.bonus.streak, 7);
    const days = DAILY_BONUS.map((v, i) => `<div class="g-day ${i < streak ? 'on' : ''}"><span>${i + 1}</span><b>${v}</b></div>`).join('');
    return `<div class="g-card"><div class="row sp"><b>Бонус за вход</b><span class="mut sm">Серия: ${st.bonus.streak} ${st.bonus.streak === 1 ? 'день' : st.bonus.streak >= 2 && st.bonus.streak <= 4 ? 'дня' : 'дней'}</span></div><div class="g-days">${days}</div>
        ${st.bonus.available ? `<button class="btn pri block" data-act="dailyBonus" style="margin-top:10px">Забрать ${BOLT}${st.bonus.next}</button>` : '<p class="mut sm" style="margin:8px 0 0">Сегодня бонус уже получен. Следующий будет завтра.</p>'}</div>
      <div class="sect">Задания дня</div>${quests().map((q) => questRow(q, 'claimQuest')).join('')}
      <p class="mut sm">За заезды сегодня: ${fmt(st.earned_today)} из ${fmt(DAILY_CAP)} бонусов. Новые задания появятся завтра.</p>
      <div class="sect">Достижения</div>${milestoneView().map((m) => questRow(m, 'claimMilestone')).join('')}${disclaimer()}`;
  };
  const garageTab = () => {
    const truck = truckById(st.truck);
    const trucks = TRUCKS.map((t) => {
      const own = st.trucks.includes(t.id), sel = st.truck === t.id;
      return `<div class="g-truck ${sel ? 'sel' : ''}"><div class="grow"><b>${esc(t.name)}</b><div class="mut sm">${esc(t.about)}</div></div>${sel ? '<span class="g-got">Выбрана</span>' : own ? `<button class="btn sm" data-act="selTruck" data-id="${t.id}">Выбрать</button>` : `<button class="btn sm ${st.coins >= t.price ? 'pri' : ''}" data-act="buyTruck" data-id="${t.id}" ${st.coins >= t.price ? '' : 'disabled'}>${BOLT}${fmt(t.price)}</button>`}</div>`;
    }).join('');
    const paints = PAINTS.map((p) => {
      const own = st.paints.includes(p.id), sel = st.paint === p.id, hex = '#' + p.hex.toString(16).padStart(6, '0');
      return `<button class="g-paint ${sel ? 'sel' : ''} ${own ? '' : 'lock'}" style="--c:${hex}" data-act="paint" data-id="${p.id}" aria-label="${esc(p.name)}"><i></i><span>${own ? esc(p.name) : `${BOLT}${fmt(p.price)}`}</span></button>`;
    }).join('');
    const ups = UPGRADES.map((u) => {
      const lvl = Number(st.upgrades[u.id] || 0), max = lvl >= UPGRADE_COST.length, cost = UPGRADE_COST[lvl];
      return `<div class="g-up"><div class="grow"><b>${esc(u.name)}</b><div class="mut sm">${esc(u.about)} · ${upgradeSeconds(u.id, lvl)} с</div><div class="g-pips">${UPGRADE_COST.map((_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('')}</div></div>${max ? '<span class="g-got">Максимум</span>' : `<button class="btn sm ${st.coins >= cost ? 'pri' : ''}" data-act="upgrade" data-id="${u.id}" ${st.coins >= cost ? '' : 'disabled'}>${BOLT}${fmt(cost)}</button>`}</div>`;
    }).join('');
    return `<div class="g-show"><canvas id="gpreview"></canvas><div class="g-show-name"><b>${esc(truck.name)}</b><span class="mut sm">${esc(paintById(st.paint).name)}</span></div></div>
      <div class="sect">Машины</div>${trucks}<div class="sect">Цвет</div><div class="g-paints">${paints}</div><div class="sect">Улучшения</div>${ups}${disclaimer()}`;
  };
  const disclaimer = () => '<p class="mut sm g-note">Бонусы действуют только в игре. Их нельзя вывести, и они не влияют на смены, отклики и рейтинг исполнителей.</p>';
  const draw = () => {
    if (stopPreview) { stopPreview(); stopPreview = null; }
    ctx.main.innerHTML = head() + (tab === 'runs' ? runsTab() : tab === 'tasks' ? tasksTab() : garageTab());
    if (tab === 'garage') startPreview();
  };
  async function startPreview() {
    const canvas = document.getElementById('gpreview'); if (!canvas) return;
    try {
      const { GaragePreview, loadEngine, webglAvailable } = await import('./game-3d.js');
      if (!webglAvailable()) { canvas.parentElement.classList.add('nogl'); return; }
      const T = await loadEngine(); if (!document.body.contains(canvas)) return;
      preview = new GaragePreview(canvas, T); preview.setTruck(st.truck, st.paint);
      let last = performance.now(), raf = 0, on = true;
      const loop = (now) => { if (!on) return; preview.frame(Math.min(0.05, (now - last) / 1000)); last = now; raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
      stopPreview = () => { on = false; cancelAnimationFrame(raf); preview.dispose(); preview = null; };
    } catch (e) { console.error(e); canvas.parentElement.classList.add('nogl'); }
  }
  // запрос, меняющий состояние: ответ сервера — новое состояние игры
  const act = async (call, ok) => { st = await call; if (ok) toast(typeof ok === 'function' ? ok(st) : ok, 'ok'); haptic('success'); tick('done'); draw(); };
  draw();
  ctx.cleanup = () => { if (stopPreview) stopPreview(); };
  ctx.acts.gtab = (el) => { tab = el.dataset.t; keepTab(tab); draw(); ctx.main.scrollTop = 0; };
  ctx.acts.playLevel = (el) => play(ctx, { level: levelById(el.dataset.id) }, st);
  ctx.acts.playEndless = () => play(ctx, { level: null }, st);
  ctx.acts.dailyBonus = () => act(api.gameDailyBonus(), (s) => `Получено бонусов: ${s.got}`);
  ctx.acts.claimQuest = (el) => act(api.gameClaimQuest(el.dataset.id), 'Награда получена');
  ctx.acts.claimMilestone = (el) => act(api.gameClaimMilestone(el.dataset.id), 'Награда получена');
  ctx.acts.selTruck = (el) => act(api.gameSelect({ kind: 'truck', id: el.dataset.id }));
  ctx.acts.buyTruck = (el) => act(api.gameBuy({ kind: 'truck', id: el.dataset.id }), 'Машина куплена');
  ctx.acts.paint = (el) => { const id = el.dataset.id; return st.paints.includes(id) ? act(api.gameSelect({ kind: 'paint', id })) : (st.coins >= paintById(id).price ? act(api.gameBuy({ kind: 'paint', id }), 'Цвет куплен') : toast('Не хватает бонусов', 'err')); };
  ctx.acts.upgrade = (el) => act(api.gameUpgrade(el.dataset.id), 'Улучшение установлено');
}

// ---------- звук: простые сигналы, включаются настройкой приложения или кнопкой в игре ----------
let audio = null;
function beep(freq, dur = 0.09, type = 'sine', vol = 0.06, slide = 0) {
  if (!prefs.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.type = type; o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination); o.start(); o.stop(t + dur + 0.02);
  } catch {}
}
let coinNote = 0, coinAt = 0;
const SFX = {
  coin: () => { const now = performance.now(); coinNote = now - coinAt < 500 ? Math.min(coinNote + 1, 12) : 0; coinAt = now; beep(880 * 2 ** (coinNote / 12), 0.07, 'triangle', 0.05); },
  cargo: () => { beep(520, 0.1, 'square', 0.04); setTimeout(() => beep(780, 0.13, 'square', 0.04), 90); },
  power: () => { [660, 880, 1100].forEach((f, i) => setTimeout(() => beep(f, 0.09, 'triangle', 0.05), i * 70)); },
  jump: () => beep(300, 0.16, 'sine', 0.05, 420), land: () => beep(120, 0.08, 'sine', 0.05), lane: () => beep(420, 0.04, 'sine', 0.02), edge: () => beep(150, 0.06, 'sine', 0.04), duck: () => beep(300, 0.12, 'sine', 0.04, -180),
  hit: () => beep(120, 0.3, 'sawtooth', 0.09, -70), smash: () => beep(240, 0.2, 'square', 0.05, -120), crash: () => beep(90, 0.5, 'sawtooth', 0.1, -50),
  finish: () => { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.16, 'triangle', 0.06), i * 110)); },
};

// ---------- заезд ----------
const STEP = 1 / 60;
// подсказки: [для телефона, для компьютера]
const TIPS = {
  lanes: ['Свайпай влево и вправо, чтобы менять полосу', 'Стрелки влево и вправо меняют полосу'],
  collect: ['Собирай молнии и коробки', 'Собирай молнии и коробки'],
  jump: ['Свайп вверх: прыжок через низкие препятствия', 'Стрелка вверх: прыжок через низкие препятствия'],
  duck: ['Свайп вниз: проезд под шлагбаумом', 'Стрелка вниз: проезд под шлагбаумом'],
  moving: ['Встречные едут быстрее, перестраивайся заранее', 'Встречные едут быстрее, перестраивайся заранее'],
};
const CONTROLS = ['Свайпай или нажимай слева и справа', 'Стрелки или WASD, пробел для прыжка, Esc для паузы'];
const KEYS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down', Space: 'up' };
const POW = { magnet: [IC.magnet, 'Магнит'], shield: [IC.shield, 'Щит'], x2: ['×2', 'Бонусы ×2'] };

async function play(ctx, { level }, st) {
  const root = document.createElement('div'); root.className = 'g-play';
  root.innerHTML = '<canvas id="gcanvas"></canvas><div class="g-fx" id="gfx"></div><div class="g-loading" id="gload"></div>';
  document.body.appendChild(root);
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  try { tg?.disableVerticalSwipes?.(); tg?.enableClosingConfirmation?.(); } catch {}
  const canvas = root.querySelector('#gcanvas'), load = root.querySelector('#gload');
  let closed = false, view = null, stopRun = null, ro = null;
  const close = () => {
    if (closed) return; closed = true; stopRun?.(); ro?.disconnect(); view?.dispose(); root.remove();
    try { tg?.enableVerticalSwipes?.(); tg?.disableClosingConfirmation?.(); } catch {}
    go(location.hash);
  };
  // повторный заезд не пересобирает сцену: модели уже готовы, поэтому он начинается почти сразу
  const begin = async (lvl) => {
    stopRun?.(); stopRun = null; root.querySelector('.g-ui')?.remove();
    load.innerHTML = '<div class="g-spin"></div><b>Загрузка</b>'; load.hidden = false; load.classList.toggle('re', !!view);
    try {
      const { GameView, loadEngine, webglAvailable } = await import('./game-3d.js');
      if (!webglAvailable()) throw Object.assign(new Error('Этому устройству не хватает поддержки 3D-графики (WebGL)'), { code: 'nogl' });
      const [T, run0] = await Promise.all([loadEngine(), api.gameStart(lvl ? { level: lvl.id } : { endless: true })]);
      if (closed) return;
      if (!view) { view = new GameView(canvas, T); view.setTruck(st.truck, st.paint); ro = new ResizeObserver(() => view.onResize()); ro.observe(canvas); }
      await view.prewarm(lvl);
      if (closed) return;
      load.hidden = true;
      stopRun = drive({ root, view, run0, level: lvl, st, close, restart: begin });
    } catch (e) {
      console.error(e);
      load.classList.remove('re');
      load.innerHTML = `<b>Не удалось начать заезд</b><p class="mut sm">${esc(errMsg(e))}</p><button class="btn pri" id="gx">Назад</button>`;
      load.querySelector('#gx').onclick = close;
    }
  };
  begin(level);
}

function drive({ root, view, run0, level, st, close, restart }) {
  const run = new Run({ seed: run0.seed, level, truck: st.truck, upgrades: st.upgrades });
  if (MODE === 'local') window.__game = { run, view };   // только для проверки в локальном режиме
  const hint = matchMedia('(pointer: coarse)').matches ? 0 : 1, ui = document.createElement('div'); ui.className = 'g-ui';
  ui.innerHTML = `<div class="g-hud">
      <div class="g-hud-top"><button class="g-pause" id="gpause" aria-label="Пауза">${IC.pause}</button><div class="g-hearts" id="ghearts"></div><div class="g-count">${BOLT}<b id="gcoin">0</b></div></div>
      ${level ? `<div class="g-prog"><i id="gprog"></i></div><div class="g-sub"><span class="g-cargo">${IC.box}<b id="gcargo">0</b> / ${level.cargo}</span><span class="g-lname">${esc(level.name)}</span></div>` : `<div class="g-sub"><span><b id="gdist">0</b> м</span><span>Рекорд: ${fmt(st.best_endless)} м</span></div>`}
      <div class="g-pows" id="gpows"></div></div>
    <div class="g-tip" id="gtip" hidden></div><div class="g-count3" id="g321"></div><div id="gover"></div>`;
  root.appendChild(ui);
  const $ = (id) => ui.querySelector('#' + id);
  const fx = root.querySelector('#gfx'), elCoin = $('gcoin'), elProg = $('gprog'), elCargo = $('gcargo'), elDist = $('gdist'), elPows = $('gpows'), elTip = $('gtip');
  const drawHearts = () => { $('ghearts').innerHTML = Array.from({ length: run.maxHearts }, (_, i) => `<i class="${i < run.hearts ? 'on' : ''}">${IC.heart}</i>`).join(''); };
  drawHearts();
  view.startRun(run);
  let last = performance.now(), smooth = STEP, raf = 0, running = false, paused = false, dead = false, acc = 0, alpha = 1, ended = false, tipT = 0, hapticAt = 0;
  let shownCoin = -1, shownCargo = -1, shownProg = -1, shownDist = -1, shownPow = -1;
  const tips = [...run.course.tips];
  const showTip = (text, sec = 3.2) => { elTip.textContent = text; elTip.hidden = false; tipT = sec; };
  const moving = () => root.classList.toggle('g-run', running && !paused && !ended);

  const onEvent = (e) => {
    SFX[e.t]?.();
    if (e.t === 'coin') { const now = performance.now(); if (now - hapticAt > 110) { hapticAt = now; haptic('select'); } }
    if (e.t === 'cargo' || e.t === 'power' || e.t === 'smash') haptic('medium');
    if (e.t === 'hit' || e.t === 'crash') { haptic('error'); drawHearts(); fx.animate?.([{ opacity: 0.34 }, { opacity: 0 }], { duration: 280, easing: 'ease-out' }); }
    if (e.t === 'power') showTip(POW[e.it.kind][1], 1.6);
  };
  // счётчики меняем, только когда значение изменилось: лишняя работа со страницей в каждом кадре даёт рывки на телефоне
  const updateHud = (dt) => {
    if (run.value !== shownCoin) { shownCoin = run.value; elCoin.textContent = fmt(run.value); }
    if (level) {
      const p = Math.round(run.progress * 500); if (p !== shownProg) { shownProg = p; elProg.style.transform = `scaleX(${p / 500})`; }
      if (run.cargo !== shownCargo) { shownCargo = run.cargo; elCargo.textContent = run.cargo; }
    } else if (run.distance !== shownDist) { shownDist = run.distance; elDist.textContent = fmt(run.distance); }
    const P = run.power, key = Math.ceil(P.magnet) + Math.ceil(P.shield) * 100 + Math.ceil(P.x2) * 10000;
    if (key !== shownPow) { shownPow = key; elPows.innerHTML = Object.entries(P).filter(([, v]) => v > 0).map(([k, v]) => `<span class="g-pow">${POW[k][0]} ${Math.ceil(v)} с</span>`).join(''); }
    if (tipT > 0) { tipT -= dt; if (tipT <= 0) elTip.hidden = true; }
  };
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    const real = Math.max(0, (now - last) / 1000), capped = Math.min(real, 0.05); last = now;
    // таймер кадров неровный: мелкие колебания сглаживаем, настоящие провалы считаем как есть, чтобы игра не отставала от времени
    smooth += (capped - smooth) * 0.1;
    const dt = Math.abs(capped - smooth) < smooth * 0.3 ? smooth : capped;
    if (running && !paused) {
      acc += dt;
      while (acc >= STEP) { run.step(STEP); acc -= STEP; if (run.done) break; }
      alpha = acc / STEP;
      if (run.events.length) { view.handle(run.events, run); run.events.forEach(onEvent); run.events.length = 0; }
      while (tips.length && run.z >= tips[0].z) showTip(TIPS[tips.shift().id][hint]);
      if (run.done && !ended) { ended = true; moving(); setTimeout(() => { if (!dead) finish(); }, run.completed ? 1000 : 1100); }
    }
    view.frame(dt, run, alpha, paused, real);
    updateHud(dt);
  };
  raf = requestAnimationFrame(loop);
  // отсчёт перед стартом: за это время игра заодно подбирает качество графики под устройство
  (async () => {
    if (!level || level.id <= 3 || hint) showTip(CONTROLS[hint], 2.6);
    for (const t of ['3', '2', '1', 'Старт']) { if (dead) return; const c = $('g321'); c.textContent = t; c.className = 'g-count3 show'; beep(t === 'Старт' ? 880 : 440, 0.12, 'triangle', 0.05); await new Promise((r) => setTimeout(r, t === 'Старт' ? 420 : 620)); c.className = 'g-count3'; }
    if (dead) return;
    running = true; moving();
  })();

  // ---------- управление ----------
  // Свайп срабатывает сразу, не дожидаясь отпускания. Палец можно не отрывать: жест в другую сторону работает сразу,
  // в ту же сторону — только после длинного движения, чтобы один длинный свайп случайно не перебрасывал через две полосы
  const act = (a) => { if (running && !paused) run.input(a); };
  let tracking = false, gestured = false, lastDir = null, sx = 0, sy = 0, rx = 0, ry = 0, downAt = 0;
  const onDown = (e) => {
    if (e.target.closest?.('.g-panel,.g-pause')) return;
    sx = rx = e.clientX; sy = ry = e.clientY; downAt = e.timeStamp; tracking = true; gestured = false; lastDir = null;
    try { root.setPointerCapture(e.pointerId); } catch {}
  };
  const onMove = (e) => {
    if (!tracking) return;
    const x = e.clientX, y = e.clientY;
    if (lastDir === 'left') rx = Math.min(rx, x); else if (lastDir === 'right') rx = Math.max(rx, x); else if (lastDir === 'up') ry = Math.min(ry, y); else if (lastDir === 'down') ry = Math.max(ry, y);
    const dx = x - rx, dy = y - ry, ax = Math.abs(dx), ay = Math.abs(dy);
    let dir = Math.max(ax, ay) < 20 ? null : ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    if (dir && dir === lastDir) dir = null;
    if (!dir && lastDir && ({ left: sx - x, right: x - sx, up: sy - y, down: y - sy })[lastDir] >= 70) dir = lastDir;
    if (!dir) return;
    act(dir); lastDir = dir; gestured = true; sx = rx = x; sy = ry = y;
  };
  // короткое нажатие без движения: слева от центра — влево, справа — вправо
  const onUp = (e) => {
    if (!tracking) return; tracking = false;
    if (!gestured && e.type === 'pointerup' && e.timeStamp - downAt < 260) act(e.clientX < innerWidth / 2 ? 'left' : 'right');
  };
  const onKey = (e) => {
    const m = KEYS[e.code];
    if (m) { e.preventDefault(); if (!e.repeat) act(m); }
    if (e.repeat) return;
    if (e.code === 'Escape' || e.code === 'KeyP') setPause(!paused);
    if (e.code === 'Enter') ui.querySelector('.g-panel .btn.pri')?.click();
  };
  root.addEventListener('pointerdown', onDown); root.addEventListener('pointermove', onMove); root.addEventListener('pointerup', onUp); root.addEventListener('pointercancel', onUp);
  addEventListener('keydown', onKey);
  const onHide = () => { if (document.hidden) setPause(true); };
  const onBlur = () => setPause(true);
  document.addEventListener('visibilitychange', onHide); addEventListener('blur', onBlur);
  const cleanup = () => {
    dead = true; cancelAnimationFrame(raf);
    root.removeEventListener('pointerdown', onDown); root.removeEventListener('pointermove', onMove); root.removeEventListener('pointerup', onUp); root.removeEventListener('pointercancel', onUp);
    removeEventListener('keydown', onKey); removeEventListener('blur', onBlur); document.removeEventListener('visibilitychange', onHide);
    root.classList.remove('g-run');
  };
  // ---------- пауза ----------
  const setPause = (on) => {
    if (ended || !running || paused === on) return;
    paused = on; moving();
    if (!on) { $('gover').innerHTML = ''; return; }
    $('gover').innerHTML = `<div class="g-over"><div class="g-panel"><h2>Пауза</h2><div class="row sp" style="margin:6px 0 14px"><span>Звук</span><button class="btn sm" id="gsnd">${prefs.sound ? 'Включён' : 'Выключен'}</button></div>
      <div class="g-acts"><button class="btn pri block" id="gcont">Продолжить</button><button class="btn block ghost" id="gquit">Выйти из рейса</button></div><p class="mut sm" style="margin:10px 0 0">При выходе собранное за этот заезд не сохранится.</p></div></div>`;
    $('gcont').onclick = () => setPause(false);
    $('gquit').onclick = close;
    $('gsnd').onclick = (e) => { prefs.set('sound', !prefs.sound); e.target.textContent = prefs.sound ? 'Включён' : 'Выключен'; };
  };
  $('gpause').onclick = () => setPause(!paused);

  // ---------- итог: начисляет только сервер; при обрыве связи результат можно отправить ещё раз ----------
  async function finish() {
    const over = $('gover');
    over.innerHTML = `<div class="g-over"><div class="g-panel g-res"><h2>${run.completed ? 'Рейс пройден' : 'Авария'}</h2><p class="mut">Сохраняем результат…</p></div></div>`;
    const stats = run.stats();
    let res;
    try { res = await api.gameFinish(run0.run_id, stats); }
    catch (e) {
      over.innerHTML = `<div class="g-over"><div class="g-panel g-res"><h2>Результат не сохранён</h2><p class="mut">${esc(errMsg(e))}</p><div class="g-acts"><button class="btn pri block" id="gretry">Отправить ещё раз</button><button class="btn block ghost" id="gback">Выйти</button></div></div></div>`;
      $('gretry').onclick = finish; $('gback').onclick = close;
      return;
    }
    Object.assign(st, res.state);
    const next = level && LEVELS.find((l) => l.id === level.id + 1), canNext = next && res.completed && Number(st.stars[level.id] || 0) >= 1;
    const nameTitle = level ? (res.completed ? 'Рейс пройден' : 'Рейс не пройден') : (res.best === res.distance && res.distance > 0 ? 'Новый рекорд' : 'Авария');
    const goal = (ok, text) => `<span class="${ok ? 'ok' : ''}">${ok ? IC.check : IC.circle}${text}</span>`;
    over.innerHTML = `<div class="g-over"><div class="g-panel g-res"><h2>${nameTitle}</h2>
      ${level ? `<div class="g-bigstars">${[1, 2, 3].map((i) => `<i class="${i <= res.stars ? 'on' : ''}" style="animation-delay:${i * 0.18}s">${IC.star}</i>`).join('')}</div>
        <div class="g-goals">${goal(res.completed, 'Доехать до финиша')}${goal(res.cargo >= level.cargo, `Все коробки: ${res.cargo} / ${level.cargo}`)}${goal(res.completed && res.hits === 0, 'Без ударов')}</div>` : `<div class="g-bigdist"><b>${fmt(res.distance)}</b> м</div><p class="mut sm" style="margin:0">Рекорд: ${fmt(res.best)} м</p>`}
      <div class="g-earn"><div><b>${BOLT}+${fmt(res.earned)}</b><span>бонусов</span></div><div><b>+${fmt(res.xp)}</b><span>опыта</span></div></div>
      ${res.level_after > res.level_before ? `<div class="g-up-lvl">Уровень ${res.level_after}. Награда: ${BOLT}${fmt(res.level_bonus)}</div>` : ''}
      ${res.capped ? '<p class="mut sm">На сегодня достигнут лимит бонусов за заезды. Задания и опыт продолжают считаться.</p>' : ''}
      <div class="g-acts">${canNext ? '<button class="btn pri block" id="gnext">Следующий рейс</button>' : ''}<button class="btn ${canNext ? '' : 'pri'} block" id="gagain">${res.completed ? 'Пройти ещё раз' : 'Попробовать снова'}</button><button class="btn block ghost" id="gback">К рейсам</button></div></div></div>`;
    if (res.stars >= 1) tick('done');
    $('gback').onclick = close;
    $('gagain').onclick = () => restart(level);
    if (canNext) $('gnext').onclick = () => restart(next);
  }
  return cleanup;
}

export const gameRoutes = [[/^#\/game$/, hub]];
