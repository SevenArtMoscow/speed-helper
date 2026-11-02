// Игра «Рейс»: честность маршрутов и проходимость уровней. Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, Course, Run, botAct, courseIsFair, MAX_SPEED, levelOfXp, xpForLevel, starsOf, rng } from '../../js/game-core.js';

// every — как часто бот принимает решение (6 кадров = 0,1 с); slip — доля решений, которые он пропускает, как невнимательный игрок
const play = (level, seed, { every = 6, maxMeters = 8000, slip = 0, truck = 'van' } = {}) => {
  const run = new Run({ seed, level, truck });
  const dt = 1 / 60; let tick = 0; const noise = rng(seed ^ 0x5bd1e995);
  while (!run.done && run.z < maxMeters) {
    if (tick++ % every === 0 && noise() >= slip) { const a = botAct(run); if (a) run.input(a); }
    run.step(dt); run.events.length = 0;
  }
  return run;
};

test('маршрут одинаков при одном и том же seed и отличается при другом', () => {
  const sign = (seed, lvl) => { const c = new Course(seed, lvl); c.ensure(Infinity); return c.obstacles.map((o) => `${o.kind}:${o.lane}:${o.z.toFixed(2)}`).join('|'); };
  assert.equal(sign(42, LEVELS[4]), sign(42, LEVELS[4]));
  assert.notEqual(sign(42, LEVELS[4]), sign(43, LEVELS[4]));
});

test('на каждом уровне при любом seed есть проходимый путь', () => {
  const r = rng(7);
  for (const lvl of LEVELS) for (let i = 0; i < 300; i++) {
    const c = new Course(Math.floor(r() * 2 ** 31), lvl); c.ensure(Infinity);
    assert.ok(courseIsFair(c), `уровень ${lvl.id}, попытка ${i}`);
    assert.ok(c.obstacles.length > 3, `уровень ${lvl.id}: слишком пусто`);
  }
});

test('в бесконечном рейсе путь есть на 15 км', () => {
  for (let seed = 1; seed <= 40; seed++) { const c = new Course(seed * 977, null); c.ensure(15000); assert.ok(courseIsFair(c), `seed ${seed}`); }
});

test('все коробки уровня действительно лежат на маршруте', () => {
  for (const lvl of LEVELS) for (let seed = 1; seed <= 100; seed++) {
    const c = new Course(seed * 31, lvl); c.ensure(Infinity);
    const n = c.items.filter((i) => i.kind === 'cargo').length;
    assert.equal(n, lvl.cargo, `уровень ${lvl.id}, seed ${seed}: коробок ${n}`);
  }
});

test('плотность молний не превышает лимит сервера', () => {
  for (const lvl of LEVELS) for (let seed = 1; seed <= 100; seed++) {
    const c = new Course(seed * 13, lvl); c.ensure(Infinity);
    const coins = c.items.filter((i) => i.kind === 'coin').length;
    assert.ok(coins * 2 <= lvl.len * 1.5, `уровень ${lvl.id}: ${coins} молний на ${lvl.len} м`);
  }
});

test('скорость не выходит за предел и растёт к концу уровня', () => {
  for (const lvl of LEVELS) {
    const c = new Course(1, lvl);
    assert.ok(c.speedAt(lvl.len) <= MAX_SPEED);
    assert.ok(c.speedAt(lvl.len) > c.speedAt(0));
    // за время одного ряда игрок успевает перестроиться
    assert.ok(lvl.gap[1] >= 0.7, `уровень ${lvl.id}: слишком частые ряды`);
  }
});

test('внимательный игрок проходит каждый уровень, в том числе на три звезды', () => {
  const report = [];
  for (const lvl of LEVELS) {
    let wins = 0, three = 0, hits = 0, cargo = 0, secs = 0; const N = 60;
    for (let seed = 1; seed <= N; seed++) { const run = play(lvl, seed * 101 + lvl.id); if (run.completed) wins++; if (starsOf(lvl, run.stats()) === 3) three++; hits += run.hits; cargo += run.cargo; secs += run.t; }
    report.push(`${lvl.id}: прошёл ${wins}/${N}, три звезды ${three}, ударов ${(hits / N).toFixed(2)}, коробок ${(cargo / N).toFixed(1)}/${lvl.cargo}, ${(secs / N).toFixed(0)} с`);
    assert.ok(wins >= N * 0.97, `уровень ${lvl.id}: прошёл только ${wins} из ${N}\n${report.join('\n')}`);
    assert.ok(three >= N * 0.5, `уровень ${lvl.id}: три звезды только ${three} из ${N}\n${report.join('\n')}`);
  }
  console.log(report.join('\n'));
});

test('сложность растёт плавно: невнимательный игрок проходит начало и спотыкается в конце', () => {
  const rate = (lvl) => { let w = 0; const N = 80; for (let s = 1; s <= N; s++) if (play(lvl, s * 53 + lvl.id, { slip: 0.45 }).completed) w++; return w / N; };
  const zone = (ids) => ids.reduce((s, id) => s + rate(LEVELS[id - 1]), 0) / ids.length;
  const a = zone([1, 2, 3]), b = zone([6, 7, 8]), c = zone([13, 14, 15]);
  console.log(`прохождение при ошибках: начало ${(a * 100).toFixed(0)}%, середина ${(b * 100).toFixed(0)}%, конец ${(c * 100).toFixed(0)}%`);
  assert.ok(a >= 0.8, `начало слишком сложное: ${a}`);
  assert.ok(a >= b && b >= c, `сложность скачет: ${a} ${b} ${c}`);
});

test('бесконечный рейс затягивает: опытный игрок едет долго, невнимательный заканчивает быстрее', () => {
  const dist = (slip) => { let sum = 0; const N = 30; for (let s = 1; s <= N; s++) sum += play(null, s * 211, { slip, maxMeters: 12000 }).z; return sum / N; };
  const pro = dist(0), novice = dist(0.5);
  console.log(`бесконечный рейс: опытный ${pro.toFixed(0)} м, новичок ${novice.toFixed(0)} м`);
  assert.ok(pro > 1500, `опытный ${pro}`);
  assert.ok(novice < pro, `новичок ${novice} и опытный ${pro}`);
});

test('длительность уровней подходит для короткой сессии', () => {
  for (const lvl of LEVELS) { const avg = lvl.len / ((lvl.v[0] + lvl.v[1]) / 2); assert.ok(avg >= 25 && avg <= 90, `уровень ${lvl.id}: ${avg.toFixed(0)} с`); }
});

test('механика: перестроение, прыжок, присед, удары', () => {
  const lvl = LEVELS[0];
  const r = new Run({ seed: 5, level: lvl, truck: 'van' });
  r.input('left'); assert.equal(r.lane, -1); r.input('left'); assert.equal(r.lane, -1);
  for (let i = 0; i < 20; i++) r.step(1 / 60);
  assert.ok(Math.abs(r.x + 2.7) < 0.01, 'доехал до полосы');
  r.input('up'); r.step(1 / 60); assert.ok(r.y > 0, 'в воздухе');
  r.input('down'); assert.ok(r.vy < 0, 'резкое приземление');
  for (let i = 0; i < 60; i++) r.step(1 / 60);
  assert.equal(r.y, 0);
  // низкое препятствие: прыжок проходит, без прыжка — удар
  const hit = (act, kind) => {
    const x = new Run({ seed: 5, level: LEVELS[3], truck: 'van' });
    x.course.obstacles.length = 0; x.course.items.length = 0;
    x.course.obstacles.push({ kind, lane: 0, x: 0, z: 30, len: 0.8, model: 0, oncoming: 0, gone: false });
    let acted = false; const sp = x.speed;
    for (let i = 0; i < 300; i++) { if (act && !acted && x.z >= 30 - sp * 0.2) { x.input(act); acted = true; } x.step(1 / 60); }
    return x.hits;
  };
  assert.equal(hit(null, 'low'), 1); assert.equal(hit('up', 'low'), 0); assert.equal(hit('down', 'low'), 1);
  assert.equal(hit(null, 'gate'), 1); assert.equal(hit('down', 'gate'), 0); assert.equal(hit('up', 'gate'), 1);
  assert.equal(hit(null, 'full'), 1); assert.equal(hit('up', 'full'), 1); assert.equal(hit('down', 'full'), 1);
});

test('прочность, щит и конец заезда', () => {
  const crash = (level, truck, shield) => {
    const x = new Run({ seed: 9, level, truck });
    x.course.obstacles.length = 0; x.course.items.length = 0;
    for (let i = 1; i <= 8; i++) x.course.obstacles.push({ kind: 'full', lane: 0, x: 0, z: i * 60, len: 3, model: 0, oncoming: 0, gone: false });
    x.course.ensure = () => {};
    if (shield) x.power.shield = 99;
    while (!x.done && x.z < 700) x.step(1 / 60);
    return x;
  };
  const a = crash(LEVELS[0], 'van'); assert.equal(a.done, true); assert.equal(a.completed, false); assert.equal(a.hits, 3);
  const b = crash(LEVELS[0], 'box'); assert.equal(b.hits, 4, 'будка держит на один удар больше');
  const c = crash(null, 'van'); assert.equal(c.hits, 1, 'в бесконечном рейсе с одного удара');
  const d = crash(null, 'van', true); assert.equal(d.hits, 1, 'щит гасит один удар, следующий уже считается');
  assert.ok(d.z > 110, 'щит спас от первого столкновения');
});

test('звёзды и уровни аккаунта', () => {
  const L = LEVELS[0];
  assert.equal(starsOf(L, { completed: false, cargo: 9, hits: 0 }), 0);
  assert.equal(starsOf(L, { completed: true, cargo: 0, hits: 2 }), 1);
  assert.equal(starsOf(L, { completed: true, cargo: L.cargo, hits: 2 }), 2);
  assert.equal(starsOf(L, { completed: true, cargo: L.cargo, hits: 0 }), 3);
  assert.equal(levelOfXp(0), 1); assert.equal(levelOfXp(99), 1); assert.equal(levelOfXp(100), 2); assert.equal(levelOfXp(299), 2); assert.equal(levelOfXp(300), 3);
  for (let n = 1; n < 40; n++) assert.equal(levelOfXp(xpForLevel(n)), n);
});
