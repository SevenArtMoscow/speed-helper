// Игра «Рейс»: логика заезда, уровни и экономика. Не зависит от страницы и 3D, поэтому её проверяют автотесты (server/test/game.test.mjs).
// Цены, уровни и задания продублированы на сервере (миграция 024): начисляет бонусы только сервер, совпадение проверяет автотест.
// Бонусы — игровая валюта: не деньги, не выводятся и не влияют на отклики, рейтинг и выдачу смен.

// ---------- настройки мира ----------
export const LANE_W = 2.7;              // ширина полосы, м
export const LANES = [-1, 0, 1];
const LANE_TIME = 0.15;                 // перестроение на соседнюю полосу, с
const JUMP_V = 10.4, GRAVITY = 25;      // прыжок: около 0,83 с в воздухе, высота 2,2 м
const DUCK_TIME = 0.75;                 // сколько машина остаётся присевшей, с
const TRUCK_HALF = 1.4;                 // половина длины машины для столкновений, м
const HIT_X = 1.2;                      // допуск по ширине: чуть задел на перестроении — не считается
const CLEAR_Y = 0.6;                    // выше этой высоты низкое препятствие не задевается
const INVULN = 1.6;                     // неуязвимость после удара, с
export const MAX_SPEED = 38;            // самая высокая скорость в игре, м/с (сервер не принимает быстрее 45)

export const ZONES = {
  sklad: { name: 'Склад', icon: '📦' },
  gorod: { name: 'Город', icon: '🏙️' },
  trassa: { name: 'Трасса', icon: '🌙' },
};

// ---------- уровни ----------
// v — скорость в начале и в конце, gap — секунды между рядами препятствий, block — вероятность препятствия на свободной полосе,
// mix — какие препятствия встречаются, cargo — сколько коробок на маршруте, reward — бонусы за каждую новую звезду
const lv = (id, name, zone, len, v, gap, block, mix, cargo, reward, extra = {}) => ({ id, name, zone, len, v, gap, block, mix, cargo, reward, ...extra });
export const LEVELS = [
  lv(1, 'Первый рейс', 'sklad', 450, [11, 13], [1.6, 1.35], 0.4, { full: 1 }, 3, 30, { tip: 'lanes' }),
  lv(2, 'Лежачие паллеты', 'sklad', 550, [12, 14], [1.5, 1.25], 0.45, { full: 2, low: 2 }, 3, 35, { tip: 'jump', teach: 'low' }),
  lv(3, 'Низкий шлагбаум', 'sklad', 650, [12, 15], [1.45, 1.2], 0.45, { full: 2, low: 1, gate: 2 }, 4, 40, { tip: 'duck', teach: 'gate' }),
  lv(4, 'Час пик на складе', 'sklad', 800, [13, 16], [1.35, 1.1], 0.5, { full: 2, low: 1, gate: 1 }, 4, 50),
  lv(5, 'Большая отгрузка', 'sklad', 1000, [14, 18], [1.25, 1.0], 0.55, { full: 3, low: 2, gate: 2 }, 5, 70),
  lv(6, 'Выезд в город', 'gorod', 800, [15, 18], [1.25, 1.05], 0.5, { full: 3, low: 1, gate: 1 }, 4, 70),
  lv(7, 'Встречка', 'gorod', 900, [15, 19], [1.2, 1.0], 0.5, { full: 2, low: 1, gate: 1, moving: 2 }, 5, 80, { tip: 'moving' }),
  lv(8, 'Пробки на кольце', 'gorod', 1000, [16, 20], [1.15, 0.95], 0.55, { full: 3, low: 2, gate: 2, moving: 2 }, 5, 90),
  lv(9, 'Вечерняя доставка', 'gorod', 1150, [17, 21], [1.1, 0.92], 0.55, { full: 3, low: 2, gate: 2, moving: 3 }, 6, 100),
  lv(10, 'Срочный заказ', 'gorod', 1300, [18, 23], [1.05, 0.88], 0.6, { full: 3, low: 2, gate: 2, moving: 3 }, 6, 130),
  lv(11, 'Ночная трасса', 'trassa', 1200, [19, 23], [1.0, 0.88], 0.55, { full: 3, low: 2, gate: 1, moving: 3 }, 6, 130),
  lv(12, 'Дальнобой', 'trassa', 1400, [20, 25], [0.98, 0.85], 0.6, { full: 3, low: 2, gate: 2, moving: 3 }, 7, 150),
  lv(13, 'Перевал', 'trassa', 1600, [21, 26], [0.95, 0.82], 0.62, { full: 3, low: 3, gate: 2, moving: 3 }, 7, 170),
  lv(14, 'Без сна', 'trassa', 1800, [22, 28], [0.92, 0.78], 0.65, { full: 3, low: 3, gate: 3, moving: 3 }, 8, 200),
  lv(15, 'Легенда дорог', 'trassa', 2200, [23, 30], [0.9, 0.75], 0.68, { full: 3, low: 3, gate: 3, moving: 4 }, 10, 300),
];
export const levelById = (id) => LEVELS.find((l) => l.id === Number(id));
export const ENDLESS = { mode: 'endless', name: 'Бесконечный рейс' };

// ---------- машины, цвета, улучшения ----------
// hearts — дополнительная прочность, coinBonus — надбавка к бонусам (её считает сервер), magnet — лишние секунды магнита
export const TRUCKS = [
  { id: 'van', name: 'Каблук', price: 0, hearts: 0, coinBonus: 0, magnet: 0, about: 'Первая машина. Маленькая, юркая, своя.' },
  { id: 'gazel', name: 'Газелька', price: 1200, hearts: 0, coinBonus: 0.05, magnet: 0, about: 'Тентованный борт и +5% к бонусам.' },
  { id: 'box', name: 'Будка', price: 3500, hearts: 1, coinBonus: 0.05, magnet: 0, about: 'Крепкий фургон: +1 к прочности и +5% к бонусам.' },
  { id: 'dump', name: 'Самосвал', price: 8000, hearts: 1, coinBonus: 0.1, magnet: 1, about: 'Гружёный и злой: +1 к прочности, +10% к бонусам.' },
  { id: 'fura', name: 'Фура', price: 16000, hearts: 1, coinBonus: 0.15, magnet: 2, about: 'Король дороги: +1 к прочности, +15% к бонусам, магнит дольше.' },
];
export const truckById = (id) => TRUCKS.find((t) => t.id === id) || TRUCKS[0];
export const PAINTS = [
  { id: 'green', name: 'Фирменный', hex: 0x2fd65c, price: 0 },
  { id: 'white', name: 'Белый', hex: 0xf1f3f5, price: 150 },
  { id: 'red', name: 'Красный', hex: 0xe5383b, price: 200 },
  { id: 'blue', name: 'Синий', hex: 0x2f7cf6, price: 200 },
  { id: 'orange', name: 'Оранжевый', hex: 0xff8a1f, price: 300 },
  { id: 'purple', name: 'Фиолетовый', hex: 0x8d4df5, price: 500 },
  { id: 'black', name: 'Чёрный', hex: 0x2b2f36, price: 700 },
  { id: 'gold', name: 'Золотой', hex: 0xf2c230, price: 1500 },
];
export const paintById = (id) => PAINTS.find((p) => p.id === id) || PAINTS[0];
export const UPGRADES = [
  { id: 'magnet', name: 'Магнит', about: 'Сам притягивает бонусы', base: 6, step: 1.5 },
  { id: 'shield', name: 'Щит', about: 'Защищает от удара', base: 6, step: 1.5 },
  { id: 'x2', name: 'Бонусы ×2', about: 'Удваивает собранные бонусы', base: 7, step: 1.5 },
];
export const UPGRADE_COST = [150, 350, 700, 1400, 2800];   // цена следующего уровня улучшения
export const upgradeSeconds = (id, lvl = 0) => { const u = UPGRADES.find((x) => x.id === id); return u.base + u.step * lvl; };

// ---------- задания ----------
// Каждый день по одному заданию из каждой группы. Выбор делает сервер, здесь — только описание.
export const QUESTS = [
  { id: 'd1000', group: 'distance', type: 'distance', target: 1000, reward: 40, title: 'Проехать 1 км' },
  { id: 'd2500', group: 'distance', type: 'distance', target: 2500, reward: 80, title: 'Проехать 2,5 км' },
  { id: 'd5000', group: 'distance', type: 'distance', target: 5000, reward: 150, title: 'Проехать 5 км' },
  { id: 'c150', group: 'collect', type: 'coins', target: 150, reward: 50, title: 'Собрать 150 бонусов' },
  { id: 'c400', group: 'collect', type: 'coins', target: 400, reward: 100, title: 'Собрать 400 бонусов' },
  { id: 'b5', group: 'collect', type: 'cargo', target: 5, reward: 50, title: 'Подобрать 5 коробок' },
  { id: 'b12', group: 'collect', type: 'cargo', target: 12, reward: 110, title: 'Подобрать 12 коробок' },
  { id: 'r3', group: 'skill', type: 'runs', target: 3, reward: 40, title: 'Сделать 3 заезда' },
  { id: 'j15', group: 'skill', type: 'jumps', target: 15, reward: 50, title: 'Перепрыгнуть 15 раз' },
  { id: 'k8', group: 'skill', type: 'ducks', target: 8, reward: 50, title: 'Пригнуться 8 раз' },
  { id: 'n1', group: 'skill', type: 'clean', target: 1, reward: 100, title: 'Пройти рейс без единого удара' },
];
export const questById = (id) => QUESTS.find((q) => q.id === id);
export const MILESTONES = [
  { id: 'km10', type: 'total_distance', target: 10000, reward: 200, title: 'Проехать 10 км за всё время' },
  { id: 'km50', type: 'total_distance', target: 50000, reward: 800, title: 'Проехать 50 км за всё время' },
  { id: 'star10', type: 'total_stars', target: 10, reward: 200, title: 'Заработать 10 звёзд' },
  { id: 'star45', type: 'total_stars', target: 45, reward: 2000, title: 'Заработать все 45 звёзд' },
  { id: 'car2', type: 'trucks', target: 2, reward: 150, title: 'Купить вторую машину' },
  { id: 'car5', type: 'trucks', target: 5, reward: 2500, title: 'Собрать весь гараж' },
  { id: 'lvl5', type: 'level', target: 5, reward: 300, title: 'Дойти до 5 уровня' },
  { id: 'lvl10', type: 'level', target: 10, reward: 1000, title: 'Дойти до 10 уровня' },
  { id: 'end1', type: 'best_endless', target: 1000, reward: 150, title: 'Километр в бесконечном рейсе' },
  { id: 'end3', type: 'best_endless', target: 3000, reward: 600, title: '3 км в бесконечном рейсе' },
];
export const DAILY_BONUS = [20, 30, 40, 60, 80, 100, 200];   // за вход день за днём; седьмой день повторяется
export const DAILY_CAP = 6000;                                // больше за сутки заезды не приносят
// опыт: 2-й уровень — 100, 3-й — 300, 4-й — 600…
export const xpForLevel = (n) => 50 * n * (n - 1);
export const levelOfXp = (xp) => Math.floor((1 + Math.sqrt(1 + (4 * Math.max(0, xp)) / 50)) / 2);
export const starsOf = (level, { completed, cargo, hits }) => (completed ? 1 + (cargo >= level.cargo ? 1 : 0) + (hits === 0 ? 1 : 0) : 0);

// ---------- случайные числа: один и тот же seed даёт один и тот же маршрут ----------
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const lerp = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));

// ---------- маршрут ----------
// Препятствия ставятся рядами. Сначала выбирается безопасная полоса, до которой игрок точно успеет доехать, и только потом занимаются остальные.
// Так на любом seed есть проходимый путь: это проверяет автотест, а бот проходит каждый уровень.
export class Course {
  constructor(seed, level = null) {
    this.r = rng(seed); this.level = level; this.endless = !level;
    this.obstacles = []; this.items = []; this.tips = [];
    this.z = 55; this.path = 1; this.row = 0; this.prevAction = false; this.prevLen = 0;
    this.nextPower = 180 + this.r() * 120;
    this.len = level ? level.len : Infinity;
    if (level) {
      this.cargoAt = Array.from({ length: level.cargo }, (_, i) => ((i + 1) / (level.cargo + 1)) * (level.len - 60) + 40);
      const T = { lanes: [[12, 'Свайп влево и вправо — смена полосы'], [60, 'Собирай молнии и коробки']], jump: [[25, 'Свайп вверх — прыжок через низкие препятствия']], duck: [[25, 'Свайп вниз — пригнуться под шлагбаумом']], moving: [[25, 'Встречные едут быстрее: перестраивайся заранее']] }[level.tip];
      if (T) this.tips = T.map(([z, text]) => ({ z, text }));
    } else this.cargoAt = [];
    this.nextCargoEndless = 150;
    this.built = 0;
  }
  // скорость зависит только от положения на маршруте
  speedAt(z) {
    if (this.level) return lerp(this.level.v[0], this.level.v[1], z / this.level.len);
    return lerp(13, 34, z / 4500);
  }
  zoneAt(z) { return this.level ? this.level.zone : ['sklad', 'gorod', 'trassa'][Math.floor(z / 1200) % 3]; }
  cfg(z) {
    if (this.level) { const p = z / this.level.len; return { gap: lerp(this.level.gap[0], this.level.gap[1], p), block: this.level.block, mix: this.level.mix }; }
    const p = z / 4500;
    return { gap: lerp(1.45, 0.76, p), block: lerp(0.4, 0.68, p), mix: { full: 3, low: z > 200 ? 2 : 0, gate: z > 500 ? 2 : 0, moving: z > 1000 ? 3 : 0 } };
  }
  pickKind(mix, exclude = []) {
    const list = Object.entries(mix).filter(([k, n]) => n > 0 && !exclude.includes(k));
    let x = this.r() * list.reduce((s, [, n]) => s + n, 0);
    for (const [k, n] of list) { x -= n; if (x <= 0) return k; }
    return list.length ? list[list.length - 1][0] : null;
  }
  // достроить маршрут вперёд до указанной точки
  ensure(upto) {
    while (this.built < upto && this.z < this.len - 40) this.addRow();
    if (this.z >= this.len - 40) this.built = Infinity;
  }
  addRow() {
    const r = this.r, sp = this.speedAt(this.z), c = this.cfg(this.z);
    const gapS = Math.max(0.72, c.gap * (0.92 + r() * 0.25)), gapM = gapS * sp + this.prevLen;
    const fromZ = this.z, z = this.z + gapM, prev = this.path;
    if (z >= this.len - 40) { this.z = z; return; }
    // куда игрок успевает: через две полосы — только если есть время
    const reach = LANES.filter((l) => Math.abs(l - prev) <= (gapS >= 0.95 ? 2 : 1));
    const stay = reach.includes(prev) && r() < 0.35;
    const path = stay ? prev : reach[Math.floor(r() * reach.length)];
    const walls = [null, null, null];
    const teach = this.level && this.level.teach, teachRow = teach && this.row >= 1 && this.row % 5 === 1 && this.row < 18;
    // на самой безопасной полосе — пусто или то, что можно преодолеть; подряд два действия не требуем
    let pathKind = null;
    const actions = ['low', 'gate'].filter((k) => c.mix[k]);
    if (!teachRow && actions.length && !this.prevAction && gapS >= 0.78 && r() < 0.28) pathKind = actions[Math.floor(r() * actions.length)];
    if (teachRow && !this.prevAction) { walls[0] = walls[1] = walls[2] = teach; pathKind = teach; } else {
      for (const l of LANES) {
        if (l === path) continue;
        if (r() < c.block) walls[l + 1] = this.pickKind(c.mix);
      }
      if (pathKind) walls[path + 1] = pathKind;
    }
    let maxLen = 0;
    LANES.forEach((l) => {
      const kind = walls[l + 1]; if (!kind) return;
      const moving = kind === 'moving', full = kind === 'full' || moving;
      const len = full && !moving && r() < 0.3 ? 5 : full ? 3 : 0.8;
      maxLen = Math.max(maxLen, len);
      this.obstacles.push({ kind, lane: l, x: l * LANE_W, z, len, model: full ? Math.floor(r() * 4) : Math.floor(r() * 2), oncoming: moving ? 9 + r() * 4 : 0, gone: false });
    });
    // дорожка из молний ведёт по безопасной полосе и показывает путь
    if (r() < 0.78) {
      const n = Math.floor((gapM - this.prevLen - 3) / 3);
      for (let i = 0; i < n; i++) this.items.push({ kind: 'coin', lane: path, x: path * LANE_W, z: z - 2 - i * 3, y: 0.9 + (pathKind === 'low' && i <= 2 ? (3 - i) * 0.45 : 0), got: false });
      if (pathKind === 'low') this.items.push({ kind: 'coin', lane: path, x: path * LANE_W, z: z + 1, y: 2.2, got: false });
    }
    // немного молний в стороне — соблазн для тех, кто успевает
    const side = LANES.filter((l) => l !== path && !walls[l + 1]);
    if (side.length && r() < 0.2) {
      const l = side[Math.floor(r() * side.length)];
      for (let i = 0; i < 3; i++) this.items.push({ kind: 'coin', lane: l, x: l * LANE_W, z: z - i * 3, y: 0.9, got: false });
    }
    // коробки и усиления кладём посередине ряда на безопасной полосе
    const mid = (fromZ + this.prevLen + z) / 2;
    if (this.cargoAt.length && mid >= this.cargoAt[0]) { this.cargoAt.shift(); this.items.push({ kind: 'cargo', lane: path, x: path * LANE_W, z: mid, y: 0.8, got: false }); }
    else if (this.endless && mid >= this.nextCargoEndless) { this.nextCargoEndless = mid + 150 + r() * 120; this.items.push({ kind: 'cargo', lane: path, x: path * LANE_W, z: mid, y: 0.8, got: false }); }
    else if (mid >= this.nextPower) { this.nextPower = mid + 220 + r() * 220; this.items.push({ kind: ['magnet', 'shield', 'x2'][Math.floor(r() * 3)], lane: path, x: path * LANE_W, z: mid, y: 1.0, got: false }); }
    this.path = path; this.z = z; this.prevLen = maxLen; this.prevAction = !!pathKind || !!teachRow; this.row++; this.built = z;
  }
}

// ---------- заезд ----------
// state.events наполняется для отрисовки и звука и очищается снаружи
export class Run {
  constructor({ seed, level = null, truck = 'van', upgrades = {} }) {
    const t = truckById(truck);
    this.course = new Course(seed, level); this.level = level; this.truck = t; this.upgrades = upgrades;
    this.z = 0; this.t = 0; this.lane = 0; this.x = 0; this.y = 0; this.vy = 0; this.duck = 0; this.jumpBuf = 0;
    this.maxHearts = (level ? 3 : 1) + t.hearts; this.hearts = this.maxHearts; this.invuln = 0; this.slow = 0;
    this.coins = 0; this.value = 0; this.cargo = 0; this.hits = 0; this.jumps = 0; this.ducks = 0;
    this.power = { magnet: 0, shield: 0, x2: 0 };
    this.done = false; this.completed = false; this.events = [];
    this.iOb = 0; this.iIt = 0;
    this.course.ensure(160);
  }
  get speed() { return this.course.speedAt(this.z) * (this.slow > 0 ? 0.72 : 1); }
  get grounded() { return this.y <= 0 && this.vy <= 0; }
  get distance() { return Math.floor(this.z); }
  get progress() { return this.level ? Math.min(1, this.z / this.level.len) : 0; }
  input(a) {
    if (this.done) return;
    if (a === 'left' && this.lane > -1) { this.lane--; this.events.push({ t: 'lane' }); }
    if (a === 'right' && this.lane < 1) { this.lane++; this.events.push({ t: 'lane' }); }
    if (a === 'up') { this.duck = 0; if (this.grounded) this.jump(); else this.jumpBuf = 0.14; }
    if (a === 'down') { if (this.grounded) { if (this.duck <= 0) { this.ducks++; this.events.push({ t: 'duck' }); } this.duck = DUCK_TIME; } else { this.vy = -16; this.duck = DUCK_TIME; this.ducks++; } this.jumpBuf = 0; }
  }
  jump() { this.vy = JUMP_V; this.y = 0.001; this.jumps++; this.events.push({ t: 'jump' }); }
  step(dt) {
    if (this.done) return;
    this.t += dt;
    this.z += this.speed * dt;
    if (!this.level) this.course.ensure(this.z + 160); else this.course.ensure(this.z + 200);
    // перестроение
    const tx = this.lane * LANE_W, mv = (LANE_W / LANE_TIME) * dt, dx = tx - this.x;
    this.x += Math.abs(dx) <= mv ? dx : Math.sign(dx) * mv;
    // прыжок и приседание
    if (this.y > 0 || this.vy > 0) {
      this.vy -= GRAVITY * dt; this.y += this.vy * dt;
      if (this.y <= 0) { this.y = 0; this.vy = 0; this.events.push({ t: 'land' }); if (this.jumpBuf > 0) { this.jump(); this.jumpBuf = 0; } }
    }
    if (this.duck > 0) this.duck -= dt;
    if (this.jumpBuf > 0) this.jumpBuf -= dt;
    if (this.invuln > 0) this.invuln -= dt;
    if (this.slow > 0) this.slow -= dt;
    for (const k in this.power) if (this.power[k] > 0) this.power[k] = Math.max(0, this.power[k] - dt);
    this.collide(); this.collect();
    if (this.level && this.z >= this.level.len) this.finish(true);
  }
  collide() {
    const obs = this.course.obstacles;
    while (this.iOb < obs.length && obs[this.iOb].z + obs[this.iOb].len < this.z - 3) this.iOb++;
    for (let i = this.iOb; i < obs.length; i++) {
      const o = obs[i];
      if (o.z - TRUCK_HALF > this.z) break;
      if (o.gone || this.z - TRUCK_HALF > o.z + o.len || Math.abs(this.x - o.x) >= HIT_X) continue;
      if (o.kind === 'low' && this.y > CLEAR_Y) continue;
      if (o.kind === 'gate' && this.duck > 0) continue;
      if (this.invuln > 0) continue;
      o.gone = true;
      if (this.power.shield > 0) { this.power.shield = 0; this.invuln = 0.6; this.events.push({ t: 'smash', o }); continue; }
      this.hits++; this.hearts--; this.invuln = INVULN; this.slow = 0.9;
      this.events.push({ t: 'hit', o });
      if (this.hearts <= 0) { this.finish(false); return; }
    }
  }
  collect() {
    const items = this.course.items;
    while (this.iIt < items.length && items[this.iIt].z < this.z - 4) this.iIt++;
    const magnet = this.power.magnet > 0;
    for (let i = this.iIt; i < items.length; i++) {
      const it = items[i];
      if (it.z - this.z > 18) break;
      if (it.got) continue;
      const dz = it.z - this.z;
      if (magnet && it.kind === 'coin' && dz < 16) it.pulled = true;
      const near = Math.abs(it.x - this.x) < 1.35 && Math.abs(dz) < 1.9 && (it.y < 1.6 || this.y > 0.35);
      if (near || (it.pulled && dz < 2.2)) this.take(it);
    }
  }
  take(it) {
    it.got = true;
    if (it.kind === 'coin') { this.coins++; this.value += this.power.x2 > 0 ? 2 : 1; this.events.push({ t: 'coin', it }); return; }
    if (it.kind === 'cargo') { this.cargo++; this.events.push({ t: 'cargo', it }); return; }
    const lvl = this.upgrades[it.kind] || 0;
    this.power[it.kind] = upgradeSeconds(it.kind, lvl) + (it.kind === 'magnet' ? this.truck.magnet : 0);
    this.events.push({ t: 'power', it });
  }
  finish(completed) {
    this.done = true; this.completed = completed;
    this.events.push({ t: completed ? 'finish' : 'crash' });
  }
  // итог заезда для сервера
  stats() { return { distance: this.distance, coins: this.value, cargo: this.cargo, hits: this.hits, jumps: this.jumps, ducks: this.ducks, completed: this.completed }; }
  // где встречная машина выглядит прямо сейчас: столкновение считается в точке o.z, поэтому честность ряда не меняется
  visualZ(o) { return o.oncoming ? o.z + (o.z - this.z) * (o.oncoming / Math.max(8, this.speed)) : o.z; }
}

// ---------- проверка честности (для автотестов): есть ли путь через весь маршрут ----------
export function courseIsFair(course) {
  const rows = new Map();
  for (const o of course.obstacles) { if (!rows.has(o.z)) rows.set(o.z, []); rows.get(o.z).push(o); }
  const zs = [...rows.keys()].sort((a, b) => a - b);
  let can = new Set([0]), z0 = 0;
  for (const z of zs) {
    const gapT = (z - z0) / course.speedAt(z0), blocked = new Set(rows.get(z).filter((o) => o.kind === 'full' || o.kind === 'moving').map((o) => o.lane));
    const next = new Set();
    for (const from of can) for (const l of LANES) if (!blocked.has(l) && Math.abs(l - from) * 0.3 <= gapT) next.add(l);
    if (!next.size) return false;
    can = next; z0 = z;
  }
  return true;
}

// Бот для автотестов: как человек, видит дорогу на несколько секунд вперёд и выбирает путь заранее.
// horizon — на сколько секунд вперёд смотрит; коробки предпочитает, если до них можно доехать.
export function botAct(run, { horizon = 2.6 } = {}) {
  const obs = run.course.obstacles, rows = [];
  for (let i = run.iOb; i < obs.length; i++) {
    const o = obs[i];
    if (o.gone || o.z + o.len < run.z - TRUCK_HALF) continue;
    if (o.z - run.z > run.speed * horizon) break;
    let row = rows.find((r) => r.z === o.z);
    if (!row) rows.push(row = { z: o.z, len: 0, c: [null, null, null], bonus: [0, 0, 0] });
    row.c[o.lane + 1] = o; row.len = Math.max(row.len, o.len);
  }
  // коробка считается отдельным рядом без препятствий: до неё тоже надо доехать
  for (const it of run.course.items) {
    if (it.got || it.kind !== 'cargo' || it.z < run.z || it.z - run.z > run.speed * horizon) continue;
    const row = { z: it.z, len: 0, c: [null, null, null], bonus: [0, 0, 0] }; row.bonus[it.lane + 1] = 0.5; rows.push(row);
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.z - b.z);
  const costOf = (o) => (!o ? 0 : o.kind === 'full' || o.kind === 'moving' ? 1e6 : 0.3);
  const val = rows.map(() => [0, 0, 0]);
  for (let i = rows.length - 1; i >= 0; i--) for (const l of LANES) {
    let next = 0;
    if (i + 1 < rows.length) {
      const avail = (rows[i + 1].z - rows[i].z - rows[i].len) / run.speed;
      next = Math.min(...LANES.map((m) => (Math.abs(l - m) * 0.3 > avail ? 1e6 : val[i + 1][m + 1] + Math.abs(l - m) * 0.02)));
    }
    val[i][l + 1] = costOf(rows[i].c[l + 1]) - rows[i].bonus[l + 1] + next;
  }
  const first = rows[0], tFirst = (first.z - TRUCK_HALF - run.z) / run.speed;
  let best = run.lane, bestV = Infinity;
  for (const l of LANES) {
    const d = Math.abs(l - run.lane);
    if (d * LANE_TIME > tFirst + 0.02 && d > 0) continue;
    const v = val[0][l + 1] + d * 0.02;
    if (v < bestV) { bestV = v; best = l; }
  }
  if (best !== run.lane) {
    // сбоку ещё едем мимо препятствия — ждём, пока проедем
    const side = run.lane + Math.sign(best - run.lane), along = tFirst <= 0 && first.c[side + 1];
    if (!along && Math.abs(run.x - run.lane * LANE_W) < 0.3) return best < run.lane ? 'left' : 'right';
    return null;
  }
  const here = first.c[run.lane + 1];
  if (here && here.kind === 'low' && tFirst < 0.3 && run.grounded) return 'up';
  if (here && here.kind === 'gate' && tFirst < 0.3 && run.duck <= 0.05) return 'down';
  return null;
}
