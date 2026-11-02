// Игра «Рейс»: экраны (рейсы, задания, гараж) и сам заезд. 3D и движок подгружаются только при входе в заезд или гараж.
import { api, tg, MODE } from './api.js';
import { S, go, toast, errMsg, pageHead, ICON, haptic, tick, prefs } from './ui.js';
import { esc } from './util.js';
import { LEVELS, ZONES, ENDLESS, TRUCKS, PAINTS, UPGRADES, UPGRADE_COST, QUESTS, MILESTONES, DAILY_BONUS, DAILY_CAP, Run, levelById, questById, truckById, paintById, upgradeSeconds, xpForLevel } from './game-core.js';

const BOLT = '<svg class="g-bolt" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>';
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');
const starRow = (n, max = 3) => `<span class="g-stars">${Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}">★</i>`).join('')}</span>`;
const unlocked = (st, id) => id === 1 || Number(st.stars[id - 1] || 0) >= 1;
const lastTab = () => { try { return sessionStorage.getItem('sh_game_tab') || 'runs'; } catch { return 'runs'; } };
const keepTab = (t) => { try { sessionStorage.setItem('sh_game_tab', t); } catch {} };

// ---------- плашка на главной и в профиле ----------
export const gameBanner = () => `<button class="g-banner" data-act="openGame" type="button" aria-label="Открыть игру Рейс">
  <span class="g-banner-ic">🚚</span><span class="g-banner-tx"><b>Рейс</b><span>Игра: гоняй на грузовике, копи бонусы и прокачивай машину</span></span><span class="g-banner-go">›</span></button>`;

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
      return `<div class="g-zone ${z}"><div class="g-zone-h"><span>${ZONES[z].icon} ${ZONES[z].name}</span><span class="mut sm">★ ${list.reduce((s, l) => s + Number(st.stars[l.id] || 0), 0)} / ${list.length * 3}</span></div><div class="g-levels ${open ? '' : 'off'}">${list.map((l) => {
        const on = unlocked(st, l.id), n = Number(st.stars[l.id] || 0);
        return `<button class="g-level ${on ? '' : 'lock'} ${n ? 'done' : ''}" ${on ? `data-act="playLevel" data-id="${l.id}"` : 'disabled'} aria-label="${esc(l.name)}">${on ? `<b>${l.id}</b>${starRow(n)}` : '<span class="g-lock">🔒</span>'}</button>`;
      }).join('')}</div></div>`;
    }).join('');
    return `<button class="g-endless" data-act="playEndless"><span class="g-e-ic">♾️</span><span class="g-e-tx"><b>${ENDLESS.name}</b><span>Едь, пока не врежешься. Рекорд: ${fmt(st.best_endless)} м</span></span><span class="g-play-ic">▶</span></button>
      <div class="mut sm" style="margin:12px 2px 2px">Звёзды: ★ ${stars} / ${LEVELS.length * 3}. Новый рейс открывается после прохождения предыдущего.</div>${zones}${disclaimer()}`;
  };
  const questRow = (q, act) => {
    const done = q.progress >= q.target, pct = Math.min(100, Math.round((q.progress / q.target) * 100));
    return `<div class="g-quest ${q.claimed ? 'claimed' : ''}"><div class="grow"><b>${esc(q.title)}</b><div class="g-qbar"><i style="width:${pct}%"></i></div><span class="mut sm">${fmt(q.progress)} / ${fmt(q.target)}</span></div>
      ${q.claimed ? '<span class="g-got">✓</span>' : done ? `<button class="btn pri sm" data-act="${act}" data-id="${q.id}">${BOLT}${fmt(q.reward)}</button>` : `<span class="g-rew">${BOLT}${fmt(q.reward)}</span>`}</div>`;
  };
  const tasksTab = () => {
    const streak = Math.min(st.bonus.streak, 7);
    const days = DAILY_BONUS.map((v, i) => `<div class="g-day ${i < streak ? 'on' : ''}"><span>${i + 1}</span><b>${v}</b></div>`).join('');
    return `<div class="g-card"><div class="row sp"><b>Бонус за вход</b><span class="mut sm">Серия: ${st.bonus.streak} ${st.bonus.streak === 1 ? 'день' : st.bonus.streak >= 2 && st.bonus.streak <= 4 ? 'дня' : 'дней'}</span></div><div class="g-days">${days}</div>
        ${st.bonus.available ? `<button class="btn pri block" data-act="dailyBonus" style="margin-top:10px">Забрать ${BOLT}${st.bonus.next}</button>` : '<p class="mut sm" style="margin:8px 0 0">Сегодня уже получен. Приходи завтра, чтобы не прервать серию.</p>'}</div>
      <div class="sect">Задания дня</div>${quests().map((q) => questRow(q, 'claimQuest')).join('')}
      <p class="mut sm">За заезды сегодня: ${fmt(st.earned_today)} из ${fmt(DAILY_CAP)} бонусов. Новые задания появятся завтра.</p>
      <div class="sect">Достижения</div>${milestoneView().map((m) => questRow(m, 'claimMilestone')).join('')}${disclaimer()}`;
  };
  const garageTab = () => {
    const truck = truckById(st.truck);
    const trucks = TRUCKS.map((t) => {
      const own = st.trucks.includes(t.id), sel = st.truck === t.id;
      return `<div class="g-truck ${sel ? 'sel' : ''}"><div class="grow"><b>${esc(t.name)}</b><div class="mut sm">${esc(t.about)}</div></div>${sel ? '<span class="g-got">В деле</span>' : own ? `<button class="btn sm" data-act="selTruck" data-id="${t.id}">Выбрать</button>` : `<button class="btn sm ${st.coins >= t.price ? 'pri' : ''}" data-act="buyTruck" data-id="${t.id}" ${st.coins >= t.price ? '' : 'disabled'}>${BOLT}${fmt(t.price)}</button>`}</div>`;
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
  const disclaimer = () => '<p class="mut sm g-note">Бонусы — игровая валюта. Это не деньги: их нельзя вывести, и они не влияют на смены, отклики и рейтинг исполнителей.</p>';
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
  ctx.acts.claimMilestone = (el) => act(api.gameClaimMilestone(el.dataset.id), 'Достижение выполнено');
  ctx.acts.selTruck = (el) => act(api.gameSelect({ kind: 'truck', id: el.dataset.id }));
  ctx.acts.buyTruck = (el) => act(api.gameBuy({ kind: 'truck', id: el.dataset.id }), 'Новая машина в гараже');
  ctx.acts.paint = (el) => { const id = el.dataset.id; return st.paints.includes(id) ? act(api.gameSelect({ kind: 'paint', id })) : (st.coins >= paintById(id).price ? act(api.gameBuy({ kind: 'paint', id }), 'Новый цвет') : toast('Не хватает бонусов', 'err')); };
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
  jump: () => beep(300, 0.16, 'sine', 0.05, 420), land: () => beep(120, 0.08, 'sine', 0.05), lane: () => beep(420, 0.04, 'sine', 0.02), duck: () => beep(300, 0.12, 'sine', 0.04, -180),
  hit: () => beep(120, 0.3, 'sawtooth', 0.09, -70), smash: () => beep(240, 0.2, 'square', 0.05, -120), crash: () => beep(90, 0.5, 'sawtooth', 0.1, -50),
  finish: () => { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.16, 'triangle', 0.06), i * 110)); },
};

// ---------- заезд ----------
async function play(ctx, { level }, st) {
  const root = document.createElement('div'); root.className = 'g-play';
  root.innerHTML = '<canvas id="gcanvas"></canvas><div class="g-loading" id="gload"><div class="g-load-ic">🚚</div><b>Заводим мотор…</b></div>';
  document.body.appendChild(root);
  try { tg?.disableVerticalSwipes?.(); tg?.enableClosingConfirmation?.(); } catch {}
  let closed = false;
  const close = () => {
    if (closed) return; closed = true; stop?.(); root.remove();
    try { tg?.enableVerticalSwipes?.(); tg?.disableClosingConfirmation?.(); } catch {}
    go(location.hash);
  };
  let stop = null;
  try {
    const { GameView, loadEngine, webglAvailable } = await import('./game-3d.js');
    if (!webglAvailable()) throw Object.assign(new Error('Этому устройству не хватает поддержки 3D-графики (WebGL)'), { code: 'nogl' });
    const [T, run0] = await Promise.all([loadEngine(), api.gameStart(level ? { level: level.id } : { endless: true })]);
    if (closed) return;
    const view = new GameView(root.querySelector('#gcanvas'), T);
    view.setTruck(st.truck, st.paint);
    drive({ root, view, run0, level, st, close, setStop: (f) => { stop = f; }, ctx });
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="g-loading"><b>Не удалось начать заезд</b><p class="mut sm">${esc(errMsg(e))}</p><button class="btn pri" id="gx">Назад</button></div>`;
    root.querySelector('#gx').onclick = close;
  }
}

function drive({ root, view, run0, level, st, close, setStop, ctx }) {
  const run = new Run({ seed: run0.seed, level, truck: st.truck, upgrades: st.upgrades });
  if (MODE === 'local') window.__game = { run, view };   // только для проверки в локальном режиме
  root.querySelector('#gload').remove();
  root.insertAdjacentHTML('beforeend', `<div class="g-hud">
      <div class="g-hud-top"><button class="g-pause" id="gpause" aria-label="Пауза">❚❚</button><div class="g-hearts" id="ghearts"></div><div class="g-count">${BOLT}<b id="gcoin">0</b></div></div>
      ${level ? `<div class="g-prog"><i id="gprog"></i></div><div class="g-sub"><span>📦 <b id="gcargo">0</b> / ${level.cargo}</span><span class="g-lname">${esc(level.name)}</span></div>` : '<div class="g-sub"><span><b id="gdist">0</b> м</span><span>Рекорд: ' + fmt(st.best_endless) + ' м</span></div>'}
      <div class="g-pows" id="gpows"></div></div>
    <div class="g-tip" id="gtip" hidden></div><div class="g-count3" id="g321"></div><div id="gover"></div>`);
  const $ = (id) => root.querySelector('#' + id);
  const heartsHtml = () => Array.from({ length: run.maxHearts }, (_, i) => `<i class="${i < run.hearts ? 'on' : ''}">♥</i>`).join('');
  $('ghearts').innerHTML = heartsHtml();
  view.startRun(run);
  let last = performance.now(), raf = 0, running = false, paused = false, acc = 0, ended = false, tipT = 0, shownCoin = -1, shownCargo = -1, tips = [...run.course.tips];
  const POW = { magnet: ['🧲', 'Магнит'], shield: ['🛡️', 'Щит'], x2: ['×2', 'Бонусы ×2'] };
  const showTip = (text) => { const t = $('gtip'); t.textContent = text; t.hidden = false; tipT = 3.2; };

  const onEvent = (e) => {
    SFX[e.t]?.();
    if (e.t === 'coin') haptic('select');
    if (e.t === 'cargo' || e.t === 'power' || e.t === 'smash') haptic('medium');
    if (e.t === 'hit' || e.t === 'crash') { haptic('error'); $('ghearts').innerHTML = heartsHtml(); root.classList.add('g-flash'); setTimeout(() => root.classList.remove('g-flash'), 260); }
    if (e.t === 'power') showTip(POW[e.it.kind][1] + '!');
  };
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (running && !paused) {
      acc += dt;
      while (acc >= 1 / 60) { run.step(1 / 60); acc -= 1 / 60; if (run.done) break; }
      if (run.events.length) { view.handle(run.events, run); run.events.forEach(onEvent); run.events.length = 0; }
      if (tips.length && run.z >= tips[0].z) showTip(tips.shift().text);
      if (run.done && !ended) { ended = true; setTimeout(finish, run.completed ? 500 : 800); }
    }
    view.frame(running && !paused ? dt : dt * 0.15, run);
    if (run.value !== shownCoin) { shownCoin = run.value; $('gcoin').textContent = fmt(run.value); }
    if (level) { $('gprog').style.width = (run.progress * 100).toFixed(1) + '%'; if (run.cargo !== shownCargo) { shownCargo = run.cargo; $('gcargo').textContent = run.cargo; } } else $('gdist').textContent = fmt(run.distance);
    const pows = Object.entries(run.power).filter(([, v]) => v > 0).map(([k, v]) => `<span class="g-pow">${POW[k][0]} ${Math.ceil(v)}с</span>`).join('');
    if ($('gpows').dataset.h !== pows) { $('gpows').innerHTML = pows; $('gpows').dataset.h = pows; }
    if (tipT > 0) { tipT -= dt; if (tipT <= 0) $('gtip').hidden = true; }
  };
  raf = requestAnimationFrame(loop);
  // отсчёт перед стартом
  (async () => {
    for (const t of ['3', '2', '1', 'Поехали!']) { const c = $('g321'); if (!c) return; c.textContent = t; c.className = 'g-count3 show'; beep(t === 'Поехали!' ? 880 : 440, 0.12, 'triangle', 0.05); await new Promise((r) => setTimeout(r, t === 'Поехали!' ? 450 : 620)); c.className = 'g-count3'; }
    running = true; last = performance.now();
  })();

  // ---------- управление: свайпы (срабатывают сразу, не дожидаясь отпускания) и клавиатура ----------
  let sx = 0, sy = 0, swiping = false;
  const act = (a) => { if (running && !paused) run.input(a); };
  const onDown = (e) => { sx = e.clientX; sy = e.clientY; swiping = true; };
  const onMove = (e) => {
    if (!swiping) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 22) return;
    act(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    swiping = false;
  };
  const onUp = () => { swiping = false; };
  const onKey = (e) => {
    const m = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', a: 'left', d: 'right', w: 'up', s: 'down', ф: 'left', в: 'right', ц: 'up', ы: 'down' }[e.key];
    if (m) { e.preventDefault(); act(m); }
    if (e.key === 'Escape') setPause(!paused);
  };
  root.addEventListener('pointerdown', onDown); root.addEventListener('pointermove', onMove); root.addEventListener('pointerup', onUp); root.addEventListener('pointercancel', onUp);
  addEventListener('keydown', onKey);
  const onResize = () => view.resize(); addEventListener('resize', onResize);
  const onHide = () => { if (document.hidden && running && !ended) setPause(true); };
  document.addEventListener('visibilitychange', onHide);
  const cleanup = () => { cancelAnimationFrame(raf); removeEventListener('keydown', onKey); removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onHide); view.dispose(); };
  setStop(cleanup);
  // ---------- пауза ----------
  const setPause = (on) => {
    if (ended || !running) return;
    paused = on; last = performance.now();
    if (!on) { $('gover').innerHTML = ''; return; }
    $('gover').innerHTML = `<div class="g-over"><div class="g-panel"><h2>Пауза</h2><div class="row sp" style="margin:6px 0 14px"><span>Звук</span><button class="btn sm" id="gsnd">${prefs.sound ? 'Включён' : 'Выключен'}</button></div>
      <button class="btn pri block" id="gcont">Продолжить</button><button class="btn block ghost" id="gquit" style="margin-top:8px">Выйти из рейса</button><p class="mut sm" style="margin:10px 0 0">При выходе собранное за этот заезд не сохранится.</p></div></div>`;
    $('gcont').onclick = () => setPause(false);
    $('gquit').onclick = close;
    $('gsnd').onclick = (e) => { prefs.set('sound', !prefs.sound); e.target.textContent = prefs.sound ? 'Включён' : 'Выключен'; };
  };
  $('gpause').onclick = () => setPause(!paused);
  $('gpause').addEventListener('pointerdown', (e) => e.stopPropagation());

  // ---------- итог: начисляет только сервер; при обрыве связи результат можно отправить ещё раз ----------
  async function finish() {
    const over = $('gover');
    over.innerHTML = `<div class="g-over"><div class="g-panel g-res"><h2>${run.completed ? 'Рейс пройден!' : 'Авария'}</h2><p class="mut">Сохраняем результат…</p></div></div>`;
    const stats = run.stats();
    let res;
    try { res = await api.gameFinish(run0.run_id, stats); }
    catch (e) {
      over.innerHTML = `<div class="g-over"><div class="g-panel g-res"><h2>Результат не сохранён</h2><p class="mut">${esc(errMsg(e))}</p><button class="btn pri block" id="gretry">Отправить ещё раз</button><button class="btn block ghost" id="gback" style="margin-top:8px">Выйти</button></div></div>`;
      $('gretry').onclick = finish; $('gback').onclick = close;
      return;
    }
    Object.assign(st, res.state);
    const next = level && LEVELS.find((l) => l.id === level.id + 1), canNext = next && res.completed && Number(st.stars[level.id] || 0) >= 1;
    const nameTitle = level ? (res.completed ? 'Рейс пройден!' : 'Рейс не пройден') : (res.best === res.distance && res.distance > 0 ? 'Новый рекорд!' : 'Авария');
    over.innerHTML = `<div class="g-over"><div class="g-panel g-res"><h2>${nameTitle}</h2>
      ${level ? `<div class="g-bigstars">${[1, 2, 3].map((i) => `<i class="${i <= res.stars ? 'on' : ''}" style="animation-delay:${i * 0.18}s">★</i>`).join('')}</div>
        <div class="g-goals"><span class="${res.completed ? 'ok' : ''}">Доехать до финиша</span><span class="${res.cargo >= level.cargo ? 'ok' : ''}">Все коробки: ${res.cargo} / ${level.cargo}</span><span class="${res.completed && res.hits === 0 ? 'ok' : ''}">Без ударов</span></div>` : `<div class="g-bigdist"><b>${fmt(res.distance)}</b> м</div><p class="mut sm" style="margin:0">Рекорд: ${fmt(res.best)} м</p>`}
      <div class="g-earn"><div><b>${BOLT}+${fmt(res.earned)}</b><span>бонусов</span></div><div><b>+${fmt(res.xp)}</b><span>опыта</span></div></div>
      ${res.level_after > res.level_before ? `<div class="g-up-lvl">🎉 Уровень ${res.level_after}! Подарок: ${BOLT}${fmt(res.level_bonus)}</div>` : ''}
      ${res.capped ? '<p class="mut sm">На сегодня достигнут лимит бонусов за заезды. Задания и опыт продолжают считаться.</p>' : ''}
      ${canNext ? '<button class="btn pri block" id="gnext">Следующий рейс</button>' : ''}<button class="btn ${canNext ? '' : 'pri'} block" id="gagain" style="margin-top:8px">${res.completed ? 'Пройти ещё раз' : 'Попробовать снова'}</button><button class="btn block ghost" id="gback" style="margin-top:8px">К рейсам</button></div></div>`;
    if (res.stars >= 1) tick('done');
    $('gback').onclick = close;
    const restart = (lvl) => { cleanup(); root.remove(); setStop(null); play(ctx, { level: lvl }, st); };
    $('gagain').onclick = () => restart(level);
    if (canNext) $('gnext').onclick = () => restart(next);
  }
}

export const gameRoutes = [[/^#\/game$/, hub]];
