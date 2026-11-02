// Игра «Рейс»: 3D-модели и отрисовка. Все модели собираются из простых фигур кодом, поэтому отдельных файлов-ассетов нет.
// Каждая модель — один меш с цветами в вершинах: мало обращений к видеокарте, игра держит частоту кадров на обычных телефонах.
// Мир изгибается в шейдере (как в популярных раннерах), дальние объекты плавно уходят за горизонт.
import { LANE_W, paintById } from './game-core.js';

const DARK = 0x23262b, TIRE = 0x16181c, GLASS = 0x233447, CHROME = 0xc6cfd6, RED = 0xff2a2a, AMBER = 0xffb020, LIGHT = 0xfff3c4, WHITE = 0xf2f4f6, CARD = 0xc9975b, TAPE = 0xe8d6a8, GOLD = 0xffd23c, STEEL = 0x6c747d, WOOD = 0xa9794a;

// ---------- сборка моделей ----------
class Mesher {
  constructor(T) { this.T = T; this.solid = []; this.glow = []; this.m = new T.Matrix4(); }
  add(geo, color, x, y, z, { rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, glow = false } = {}) {
    const T = this.T;
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    this.m.compose(new T.Vector3(x, y, z), new T.Quaternion().setFromEuler(new T.Euler(rx, ry, rz)), new T.Vector3(sx, sy, sz));
    g.applyMatrix4(this.m);
    (glow ? this.glow : this.solid).push({ g, c: new T.Color(color) });
    return this;
  }
  box(w, h, d, x, y, z, color, o = {}) {
    const T = this.T;
    return this.add(o.r ? roundBox(T, w, h, d, o.r) : new T.BoxGeometry(w, h, d), color, x, y, z, o);
  }
  cyl(rt, rb, h, x, y, z, color, o = {}) { return this.add(new this.T.CylinderGeometry(rt, rb, h, o.seg || 12), color, x, y, z, o); }
  ball(r, x, y, z, color, o = {}) { return this.add(new this.T.SphereGeometry(r, o.seg || 12, o.seg ? Math.ceil(o.seg * 0.7) : 8), color, x, y, z, o); }
  cone(r, h, x, y, z, color, o = {}) { return this.add(new this.T.ConeGeometry(r, h, o.seg || 8), color, x, y, z, o); }
  bolt(size, x, y, z, color, o = {}) { return this.add(boltGeo(this.T, 0.1), color, x, y, z, { ...o, sx: size, sy: size, sz: 1 }); }
  // окна фасада: ряды квадратов; часть гаснет, чтобы здание выглядело живым
  windows(w, h, cols, rows, x, y, z, color, side, lit = 0.6, seed = 1) {
    let a = seed;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      a = (a * 16807) % 2147483647;
      const on = a % 100 < lit * 100, ww = (w / cols) * 0.55, wh = (h / rows) * 0.55;
      const px = (c + 0.5) / cols * w - w / 2, py = (r + 0.5) / rows * h - h / 2;
      if (side === 'z') this.box(ww, wh, 0.06, x + px, y + py, z, on ? color : 0x39424e, { glow: on });
      else this.box(0.06, wh, ww, x, y + py, z + px, on ? color : 0x39424e, { glow: on });
    }
    return this;
  }
  build() { return { geo: merge(this.T, this.solid), glow: this.glow.length ? merge(this.T, this.glow) : null }; }
}

function merge(T, parts) {
  let n = 0;
  for (const p of parts) n += p.g.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const { g, c } of parts) {
    const a = g.getAttribute('position'), b = g.getAttribute('normal');
    pos.set(a.array, o * 3); nor.set(b.array, o * 3);
    for (let i = 0; i < a.count; i++) { col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b; }
    o += a.count; g.dispose();
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new T.BufferAttribute(nor, 3));
  geo.setAttribute('color', new T.BufferAttribute(col, 3));
  geo.computeBoundingSphere(); geo.boundingSphere.radius += 40;   // мир изгибается в шейдере — не отсекаем заранее
  return geo;
}

// скруглённая коробка: подразбитый куб, вершины которого прижаты к скруглению
function roundBox(T, w, h, d, r, seg = 3) {
  const g = new T.BoxGeometry(w, h, d, seg, seg, seg), p = g.getAttribute('position'), n = g.getAttribute('normal');
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r, v = new T.Vector3(), c = new T.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    c.set(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
    const dir = v.clone().sub(c);
    if (dir.lengthSq() < 1e-6) continue;
    dir.normalize();
    p.setXYZ(i, c.x + dir.x * r, c.y + dir.y * r, c.z + dir.z * r);
    n.setXYZ(i, dir.x, dir.y, dir.z);
  }
  return g;
}

function boltShape(T) {
  const pts = [[13, 2], [4, 14], [10, 14], [9, 22], [18, 10], [12, 10]], s = new T.Shape();
  pts.forEach(([x, y], i) => { const px = (x - 11) / 11, py = (12 - y) / 11; if (i) s.lineTo(px, py); else s.moveTo(px, py); });
  s.closePath();
  return s;
}
function boltGeo(T, depth = 0.14) {
  const g = new T.ExtrudeGeometry(boltShape(T), { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  return g;
}

// ---------- водитель ----------
// Высовывается из окна, чтобы его было видно и в заезде, когда камера сзади
function driverParts(T) {
  const m = new Mesher(T);
  m.ball(0.27, 0, 0, 0, 0xffc58a);                                 // голова
  m.ball(0.075, -0.1, 0.05, -0.24, 0x1b1d21); m.ball(0.075, 0.1, 0.05, -0.24, 0x1b1d21);   // глаза
  m.ball(0.03, -0.08, 0.08, -0.31, 0xffffff); m.ball(0.03, 0.12, 0.08, -0.31, 0xffffff);
  m.box(0.14, 0.035, 0.03, 0, -0.1, -0.25, 0x9c4a2f);              // улыбка
  m.ball(0.285, 0, 0.09, 0.01, 0x2fd65c, { sy: 0.72 });            // кепка
  m.box(0.34, 0.035, 0.22, 0, 0.1, -0.3, 0x24ad49, { r: 0.015 });  // козырёк
  m.ball(0.09, -0.26, 0.0, 0, 0xffc58a, { sy: 1.2, sx: 0.7 });     // уши
  m.ball(0.09, 0.26, 0.0, 0, 0xffc58a, { sy: 1.2, sx: 0.7 });
  m.box(0.14, 0.14, 0.5, -0.05, -0.34, 0.05, 0xffc58a, { r: 0.05, rx: 0.3, rz: 0.4 });   // рука на окне
  return m.build();
}

// ---------- машины: перед смотрит в -z, задняя часть проработана подробнее всего: её игрок видит всё время ----------
function rearLights(m, w, y, z) {
  for (const s of [-1, 1]) {
    m.box(0.24, 0.3, 0.05, s * (w / 2 - 0.2), y, z, RED, { glow: true });
    m.box(0.18, 0.1, 0.05, s * (w / 2 - 0.2), y - 0.24, z, AMBER, { glow: true });
  }
}
function bumper(m, w, y, z) {
  m.box(w, 0.2, 0.22, 0, y, z, DARK, { r: 0.06 });
  m.box(0.56, 0.16, 0.03, 0, y + 0.02, z + 0.12, WHITE);
  m.box(0.1, 0.1, 0.03, -0.2, y + 0.02, z + 0.135, 0x2f7cf6);
}
function cab(m, paint, { w = 2, h = 1.6, d = 1.55, y = 1.35, z = -1.1, roof = true } = {}) {
  m.box(w, h, d, 0, y, z, paint, { r: 0.22 });
  m.box(w - 0.16, h * 0.42, 0.07, 0, y + h * 0.16, z - d / 2 + 0.06, GLASS, { rx: -0.3 });   // лобовое
  for (const s of [-1, 1]) {
    m.box(0.05, h * 0.36, d * 0.55, s * (w / 2 + 0.005), y + h * 0.17, z + 0.1, GLASS);     // боковые окна
    m.box(0.2, 0.16, 0.08, s * (w / 2 + 0.14), y + h * 0.1, z - d * 0.3, DARK, { r: 0.03 });   // зеркала
    m.box(0.36, 0.2, 0.05, s * (w / 2 - 0.28), y - h * 0.33, z - d / 2 - 0.01, LIGHT, { glow: true });   // фары
  }
  m.box(w * 0.46, h * 0.16, 0.06, 0, y - h * 0.32, z - d / 2 - 0.01, 0x3a3f46);   // решётка
  m.box(w + 0.02, 0.18, 0.22, 0, y - h * 0.47, z - d / 2, DARK, { r: 0.06 });     // передний бампер
  if (roof) m.box(w * 0.5, 0.08, 0.3, 0, y + h / 2 + 0.03, z, DARK, { r: 0.03 });
  m.box(w * 0.2, h * 0.15, 0.03, 0, y + h * 0.42, z - d / 2 + 0.2, AMBER, { glow: true, sy: 0.3 });
}

// Описание модели: body/glow — кузов, wheels — [x, y, z, r], driver — где сидит водитель, height — высота, length — длина за кабиной (для камеры)
export function truckModel(T, id, paintHex) {
  const m = new Mesher(T), paint = paintHex, wheels = [];
  const wheelPair = (z, r = 0.44, x = 1) => { wheels.push([-x, r, z, r], [x, r, z, r]); };
  let driver = [-1.03, 2.0, -0.5], height = 2.5, length = 4;
  if (id === 'van') {
    m.box(1.95, 0.2, 3.7, 0, 0.46, 0, DARK);
    m.box(1.96, 1.0, 3.72, 0, 1.0, 0, paint, { r: 0.2 });
    m.box(1.86, 0.86, 2.6, 0, 1.78, 0.5, paint, { r: 0.24 });
    m.box(1.8, 0.62, 1.3, 0, 1.56, -1.05, paint, { r: 0.22 });
    m.box(1.66, 0.74, 0.07, 0, 1.78, -0.86, GLASS, { rx: -0.6 });
    for (const s of [-1, 1]) {
      m.box(0.05, 0.44, 1.0, s * 0.935, 1.84, -0.05, GLASS);
      m.box(0.05, 0.44, 0.8, s * 0.935, 1.84, 1.08, GLASS);
      m.box(0.34, 0.2, 0.05, s * 0.66, 1.08, -1.87, LIGHT, { glow: true });
      m.box(0.2, 0.15, 0.08, s * 1.08, 1.56, -0.8, DARK, { r: 0.03 });
      m.box(0.62, 0.46, 0.05, s * 0.4, 1.88, 1.81, GLASS);                       // окна задних дверей
    }
    m.box(0.04, 1.5, 0.05, 0, 1.4, 1.86, 0x1d6e36);                              // шов дверей
    m.box(0.3, 0.05, 0.06, -0.25, 1.32, 1.87, DARK); m.box(0.3, 0.05, 0.06, 0.25, 1.32, 1.87, DARK);
    m.bolt(0.26, 0, 1.0, 1.875, GOLD);
    rearLights(m, 1.96, 1.2, 1.86);
    bumper(m, 2.04, 0.58, 1.87);
    m.box(2.04, 0.2, 0.22, 0, 0.56, -1.86, DARK, { r: 0.06 });
    // багажник на крыше
    m.box(1.5, 0.05, 1.9, 0, 2.27, 0.5, CHROME); for (const z of [-0.3, 0.5, 1.3]) m.box(1.6, 0.05, 0.05, 0, 2.3, z, CHROME);
    m.box(0.72, 0.46, 0.72, -0.34, 2.54, 0.86, CARD); m.box(0.74, 0.08, 0.2, -0.34, 2.56, 0.86, TAPE);
    m.box(0.58, 0.38, 0.6, 0.38, 2.5, 0.2, CARD); m.box(0.6, 0.07, 0.16, 0.38, 2.52, 0.2, TAPE);
    wheelPair(-1.15, 0.42, 0.95); wheelPair(1.15, 0.42, 0.95);
    driver = [-1.02, 1.98, -0.42]; height = 2.8; length = 3.8;
  } else if (id === 'gazel') {
    m.box(1.9, 0.22, 4.5, 0, 0.52, 0.4, DARK);
    cab(m, paint);
    m.box(2.1, 0.28, 2.95, 0, 0.86, 1.1, 0x565b62, { r: 0.04 });
    m.box(2.14, 1.72, 2.95, 0, 1.84, 1.1, 0x7f8c6c, { r: 0.24 });              // тент
    for (let i = 0; i < 4; i++) m.box(2.17, 1.74, 0.05, 0, 1.84, 0.1 + i * 0.68, 0x68745a, { r: 0.02 });
    m.box(1.86, 1.42, 0.06, 0, 1.74, 2.6, 0x5c6750);                           // полог сзади
    for (const s of [-0.62, 0, 0.62]) m.box(0.07, 1.4, 0.04, s, 1.74, 2.64, 0x3f4737);
    m.box(1.92, 0.06, 0.05, 0, 1.08, 2.64, 0x3f4737);
    rearLights(m, 2.08, 0.98, 2.6);
    bumper(m, 2.1, 0.6, 2.62);
    for (const s of [-1, 1]) m.box(0.5, 0.36, 0.04, s * 0.74, 0.34, 2.5, 0x0e0f11);   // брызговики
    wheelPair(-1.1, 0.44, 0.98); wheelPair(1.6, 0.46, 0.98);
    driver = [-1.08, 2.0, -1.0]; height = 2.8; length = 4.6;
  } else if (id === 'box') {
    m.box(1.9, 0.24, 4.9, 0, 0.56, 0.6, DARK);
    cab(m, paint, { h: 1.7, y: 1.4 });
    m.box(2.34, 2.1, 3.5, 0, 1.85, 1.3, WHITE, { r: 0.08 });                   // будка
    m.box(2.36, 0.46, 3.52, 0, 1.45, 1.3, paint, { r: 0.03 });
    m.box(2.36, 0.08, 3.52, 0, 1.76, 1.3, GOLD);
    for (let i = 0; i < 7; i++) m.box(2.1, 0.05, 0.04, 0, 1.0 + i * 0.28, 3.07, 0xc4cad0);   // ролета
    m.box(0.42, 0.06, 0.06, 0, 1.15, 3.1, DARK);
    m.bolt(0.42, 0, 2.2, 3.09, 0x2fd65c);
    for (const s of [-1, 1]) { m.box(0.14, 0.09, 0.05, s * 0.86, 2.84, 3.05, AMBER, { glow: true }); m.box(0.5, 0.36, 0.04, s * 0.78, 0.34, 3.0, 0x0e0f11); }
    rearLights(m, 2.26, 0.98, 3.08);
    bumper(m, 2.2, 0.6, 3.1);
    wheelPair(-1.15, 0.46, 1.0); wheelPair(2.0, 0.48, 1.04);
    driver = [-1.08, 2.08, -1.05]; height = 3.0; length = 5.1;
  } else if (id === 'dump') {
    m.box(1.9, 0.28, 5.2, 0, 0.62, 0.8, DARK);
    cab(m, paint, { w: 2.1, h: 1.9, y: 1.55, d: 1.6 });
    m.box(0.16, 1.5, 0.16, -1.0, 1.9, -0.2, CHROME, { r: 0.05 });              // выхлопная труба
    m.box(2.3, 1.2, 3.5, 0, 1.6, 1.55, 0x4d535a, { r: 0.05 });                 // кузов
    for (let i = 0; i < 5; i++) for (const s of [-1, 1]) m.box(0.06, 1.16, 0.12, s * 1.17, 1.6, 0.25 + i * 0.65, 0x3a3f45);
    m.box(2.34, 0.1, 3.54, 0, 2.2, 1.55, 0x383d43);
    m.ball(1.0, 0, 2.2, 1.55, 0xd7b26b, { sy: 0.48, sz: 1.5, seg: 10 });       // песок
    m.ball(0.3, -0.5, 2.5, 1.0, 0xc9a35c, { seg: 6 }); m.ball(0.24, 0.45, 2.48, 2.1, 0xe2c07c, { seg: 6 });
    m.box(2.24, 1.22, 0.12, 0, 1.6, 3.33, 0x3b4046, { r: 0.03 });              // задний борт
    for (const s of [-0.7, 0, 0.7]) m.box(0.1, 1.2, 0.05, s, 1.6, 3.41, 0xffd23c);
    m.box(2.26, 0.14, 0.05, 0, 1.15, 3.41, 0xe5383b);
    rearLights(m, 2.2, 0.92, 3.42);
    bumper(m, 2.24, 0.62, 3.46);
    for (const s of [-1, 1]) m.box(0.5, 0.36, 0.04, s * 0.8, 0.36, 3.35, 0x0e0f11);
    wheelPair(-1.1, 0.5, 1.02); wheelPair(1.5, 0.52, 1.04); wheelPair(2.65, 0.52, 1.04);
    driver = [-1.14, 2.25, -1.05]; height = 3.1; length = 5.4;
  } else {
    // фура: кабина со спальником и полуприцеп
    m.box(1.9, 0.3, 7.2, 0, 0.64, 1.9, DARK);
    cab(m, paint, { w: 2.2, h: 2.2, y: 1.72, d: 1.9, z: -0.95 });
    m.box(2.0, 0.34, 1.4, 0, 2.98, -0.65, paint, { r: 0.14 });                 // обтекатель
    for (const s of [-1, 1]) m.cyl(0.08, 0.08, 2.0, s * 1.06, 2.05, 0.15, CHROME, { seg: 8 });
    m.box(2.44, 2.1, 4.9, 0, 1.95, 3.15, WHITE, { r: 0.08 });                  // полуприцеп
    m.box(2.46, 0.5, 4.92, 0, 1.3, 3.15, paint, { r: 0.03 });
    m.bolt(0.42, -1.235, 2.2, 3.15, paint, { ry: -Math.PI / 2 }); m.bolt(0.42, 1.235, 2.2, 3.15, paint, { ry: Math.PI / 2 });
    m.box(2.3, 2.02, 0.06, 0, 1.95, 5.6, 0xe3e6e9);                            // двери
    m.box(0.05, 2.0, 0.05, 0, 1.95, 5.64, 0x8d949b);
    for (const s of [-0.85, -0.3, 0.3, 0.85]) m.box(0.05, 1.94, 0.05, s, 1.95, 5.66, CHROME);
    for (let i = 0; i < 12; i++) m.box(0.2, 0.12, 0.03, -1.1 + i * 0.2, 1.06, 5.65, i % 2 ? WHITE : 0xe5383b);   // светоотражающая лента
    for (const x of [-0.8, -0.27, 0.27, 0.8]) m.box(0.14, 0.06, 0.04, x, 2.94, 5.62, AMBER, { glow: true });
    rearLights(m, 2.3, 0.72, 5.68);
    m.box(2.34, 0.14, 0.08, 0, 0.48, 5.68, 0x8d949b);
    for (const s of [-1, 1]) m.box(0.5, 0.34, 0.04, s * 0.82, 0.34, 5.5, 0x0e0f11);
    wheelPair(-1.2, 0.5, 1.03); wheelPair(1.0, 0.52, 1.05); wheelPair(3.6, 0.5, 1.05); wheelPair(4.75, 0.5, 1.05);
    driver = [-1.2, 2.3, -1.0]; height = 3.2; length = 6.4;
  }
  return { ...m.build(), wheels, driver, height, length };
}

function wheelGeo(T) {
  const m = new Mesher(T);
  m.cyl(1, 1, 0.34, 0, 0, 0, TIRE, { rz: Math.PI / 2, seg: 14 });
  for (const s of [-1, 1]) {
    m.cyl(0.58, 0.58, 0.04, s * 0.17, 0, 0, 0xb9c0c7, { rz: Math.PI / 2, seg: 10 });
    m.box(0.05, 0.86, 0.2, s * 0.19, 0, 0, 0x7a828a);   // спица — по ней видно вращение
  }
  return m.build().geo;
}

// ---------- препятствия ----------
function hazard(m, w, h, x, y, z, a = 0xffd23c, b = 0x1c1e22, n = 7) {
  for (let i = 0; i < n; i++) m.box(w / n, h, 0.06, x - w / 2 + (i + 0.5) * (w / n), y, z, i % 2 ? b : a);
}
function obstacleGeo(T, key) {
  const m = new Mesher(T);
  // начало координат — ближняя к игроку грань, вперёд — в -z
  if (key === 'full0') {   // штабель ящиков
    m.box(2.3, 0.14, 3, 0, 0.1, -1.5, WOOD);
    m.box(1.15, 1.05, 1.4, -0.58, 0.7, -0.72, CARD); m.box(1.15, 1.05, 1.4, 0.58, 0.7, -0.72, 0xb98a50); m.box(1.15, 1.05, 1.4, -0.58, 0.7, -2.2, 0xb98a50); m.box(1.15, 1.05, 1.4, 0.58, 0.7, -2.2, CARD);
    m.box(1.2, 0.94, 1.3, -0.2, 1.72, -0.8, 0xd2a468); m.box(1.2, 0.94, 1.3, 0.25, 1.72, -2.1, CARD);
    for (const x of [-0.58, 0.58]) m.box(1.17, 0.09, 0.14, x, 0.8, -0.0, TAPE);
    m.box(0.09, 0.96, 0.02, -0.2, 1.72, -0.14, TAPE);
    m.box(0.3, 0.3, 0.02, 0.58, 0.55, 0.0, 0xe5383b);
  } else if (key === 'full1') {   // припаркованная легковая
    m.box(2.0, 0.72, 3, 0, 0.72, -1.5, 0x2f7cf6, { r: 0.2 });
    m.box(1.72, 0.62, 1.7, 0, 1.3, -1.45, 0x3a86f8, { r: 0.2 });
    m.box(1.56, 0.42, 0.05, 0, 1.33, -0.6, GLASS, { rx: 0.35 });
    for (const s of [-1, 1]) { m.box(0.3, 0.2, 0.04, s * 0.72, 0.84, 0.01, RED, { glow: true }); for (const z of [-0.5, -2.5]) m.cyl(0.36, 0.36, 0.26, s * 0.92, 0.36, z, TIRE, { rz: Math.PI / 2, seg: 10 }); }
    m.box(2.04, 0.18, 0.14, 0, 0.5, 0, DARK, { r: 0.05 }); m.box(0.5, 0.13, 0.03, 0, 0.66, 0.02, WHITE);
  } else if (key === 'full2') {   // контейнер
    m.box(2.35, 2.2, 3, 0, 1.2, -1.5, 0xc8402f);
    for (let i = 0; i < 9; i++) m.box(0.1, 2.14, 0.05, -1.02 + i * 0.255, 1.2, 0.015, 0xa63324);
    for (const x of [-0.45, 0.45]) m.box(0.06, 2.1, 0.06, x, 1.2, 0.05, CHROME);
    m.box(1.1, 0.34, 0.03, 0, 1.92, 0.04, WHITE);
    m.bolt(0.14, 0, 1.92, 0.06, 0xc8402f);
  } else if (key === 'full3') {   // бетонные блоки и забор
    for (const x of [-0.8, 0, 0.8]) { m.box(0.78, 0.9, 3, x, 0.45, -1.5, 0xaab0b6, { r: 0.07 }); m.box(0.8, 0.14, 0.04, x, 0.6, 0.02, x === 0 ? 0xe5383b : WHITE); }
    for (const x of [-1.05, 1.05]) m.box(0.08, 1.2, 0.08, x, 1.45, -0.4, STEEL);
    hazard(m, 2.2, 0.32, 0, 1.75, -0.36, 0xe5383b, WHITE, 8);
    m.box(0.38, 0.38, 0.04, 0, 1.25, -0.34, 0xffd23c);
  } else if (key === 'moving0' || key === 'moving1') {   // встречная: фары видно издалека
    const body = key === 'moving0' ? 0xf3c623 : 0xe8eaed;
    m.box(2.0, 0.78, 3, 0, 0.76, -1.5, body, { r: 0.22 });
    m.box(1.72, 0.66, 1.6, 0, 1.38, -1.7, key === 'moving0' ? 0xf7d34a : 0xdfe2e6, { r: 0.2 });
    m.box(1.56, 0.5, 0.05, 0, 1.4, -0.82, GLASS, { rx: -0.45 });
    for (const s of [-1, 1]) { m.box(0.42, 0.24, 0.05, s * 0.66, 0.84, 0.01, LIGHT, { glow: true }); for (const z of [-0.55, -2.45]) m.cyl(0.36, 0.36, 0.26, s * 0.92, 0.36, z, TIRE, { rz: Math.PI / 2, seg: 10 }); }
    m.box(0.8, 0.24, 0.04, 0, 0.84, 0.0, 0x24272c);
    m.box(2.04, 0.18, 0.14, 0, 0.5, 0, DARK, { r: 0.05 });
    if (key === 'moving0') { m.box(0.56, 0.2, 0.3, 0, 1.8, -1.7, 0x24272c, { r: 0.04 }); for (let i = 0; i < 6; i++) m.box(1.9 / 6, 0.09, 0.03, -0.8 + i * 0.32, 1.0, 0.015 + 0, i % 2 ? 0x24272c : 0xf3c623); }
    m.box(1.2, 0.06, 0.2, 0, 1.76, -1.2, 0xff5a4d, { glow: true });
  } else if (key === 'low0') {   // паллета с короткими коробками: прыгать
    m.box(2.34, 0.12, 0.8, 0, 0.1, -0.4, WOOD); m.box(2.34, 0.08, 0.8, 0, 0.26, -0.4, 0xb78a58);
    for (const x of [-0.72, 0, 0.72]) m.box(0.68, 0.34, 0.66, x, 0.48, -0.4, x ? CARD : 0xd2a468);
    hazard(m, 2.2, 0.1, 0, 0.5, 0.0, 0xffd23c, 0x1c1e22, 8);
  } else if (key === 'low1') {   // низкий барьер и конусы
    m.box(2.3, 0.3, 0.3, 0, 0.42, -0.4, 0xe9ecef, { r: 0.05 });
    hazard(m, 2.3, 0.22, 0, 0.42, -0.23, 0xff6a13, WHITE, 8);
    for (const x of [-1.05, 1.05]) { m.box(0.14, 0.28, 0.5, x, 0.14, -0.4, 0x2b2f35); m.cone(0.18, 0.46, x, 0.72, -0.4, 0xff6a13); }
  } else if (key === 'gate0') {   // шлагбаум: пригнуться
    for (const x of [-1.22, 1.22]) { m.box(0.22, 2.3, 0.22, x, 1.15, -0.4, 0x4c5259); m.box(0.4, 0.14, 0.4, x, 0.07, -0.4, 0x2f3338); }
    for (let i = 0; i < 8; i++) m.box(2.3 / 8, 0.3, 0.16, -1.01 + i * 0.29, 1.92, -0.4, i % 2 ? WHITE : 0xe5383b);
    m.ball(0.14, -1.22, 2.42, -0.4, RED, { glow: true, seg: 8 });
    m.box(0.8, 0.5, 0.05, 0, 2.3, -0.3, 0xffd23c, { rz: Math.PI / 4, sx: 0.62, sy: 1 });
    m.box(0.07, 0.26, 0.05, 0, 2.33, -0.27, 0x1c1e22); m.box(0.07, 0.07, 0.05, 0, 2.15, -0.27, 0x1c1e22);
  } else if (key === 'gate1') {   // низкая труба над дорогой
    for (const x of [-1.25, 1.25]) m.box(0.26, 2.4, 0.5, x, 1.2, -0.4, 0x707982);
    m.cyl(0.26, 0.26, 2.7, 0, 2.0, -0.4, 0x5e6770, { rz: Math.PI / 2, seg: 10 });
    hazard(m, 2.2, 0.16, 0, 1.76, -0.14, 0xffd23c, 0x1c1e22, 9);
    for (const x of [-0.7, 0.7]) m.box(0.3, 0.05, 0.05, x, 2.26, -0.4, CHROME);
  }
  return m.build();
}

// ---------- предметы ----------
function coinGeo(T) {
  const m = new Mesher(T);
  m.add(new T.TorusGeometry(0.46, 0.075, 6, 16), GOLD, 0, 0, 0);
  m.add(boltGeo(T, 0.12), GOLD, 0, 0, 0, { sx: 0.36, sy: 0.36 });
  return m.build().geo;
}
function itemGeo(T, kind) {
  const m = new Mesher(T);
  if (kind === 'cargo') {
    m.box(0.95, 0.85, 0.95, 0, 0, 0, CARD, { r: 0.04 });
    m.box(0.97, 0.87, 0.2, 0, 0, 0, TAPE);
    m.box(0.2, 0.87, 0.97, 0, 0, 0, TAPE);
    m.bolt(0.16, -0.28, 0.14, 0.49, 0x2fd65c);
  } else if (kind === 'magnet') {
    m.add(new T.TorusGeometry(0.42, 0.15, 8, 14, Math.PI), 0xe5383b, 0, 0.05, 0);
    for (const s of [-1, 1]) { m.box(0.3, 0.3, 0.3, s * 0.42, -0.12, 0, 0xe5383b); m.box(0.3, 0.22, 0.3, s * 0.42, -0.38, 0, WHITE); }
  } else if (kind === 'shield') {
    m.ball(0.48, 0, 0, 0, 0x37b6ff, { sz: 0.34, seg: 12 });
    m.bolt(0.26, 0, 0, 0.18, WHITE); m.bolt(0.26, 0, 0, -0.18, WHITE);
  } else {
    m.add(new T.TorusGeometry(0.46, 0.09, 6, 18), 0xff5ec4, 0, 0, 0);
    m.add(new T.CircleGeometry(0.42, 18), 0xfff0fb, 0, 0, 0.02);
    m.box(0.06, 0.44, 0.04, -0.15, 0, 0.05, 0xd7239b, { rz: 0.6 }); m.box(0.06, 0.44, 0.04, -0.15, 0, 0.05, 0xd7239b, { rz: -0.6 });
    m.box(0.2, 0.05, 0.04, 0.17, 0.14, 0.05, 0xd7239b); m.box(0.05, 0.14, 0.04, 0.25, 0.08, 0.05, 0xd7239b); m.box(0.2, 0.05, 0.04, 0.17, 0, 0.05, 0xd7239b); m.box(0.05, 0.14, 0.04, 0.09, -0.07, 0.05, 0xd7239b); m.box(0.2, 0.05, 0.04, 0.17, -0.14, 0.05, 0xd7239b);
  }
  return m.build();
}

// ---------- районы: цвета и окружение ----------
const THEMES = {
  sklad: { top: '#6db9f7', bottom: '#e6f4ff', fog: 0xdcedfb, ground: 0x8f9483, road: 0x51565e, side: 0xbcc0c4, hemi: [0xffffff, 0x8c8f80, 2.1], sun: [0xfff3da, 1.7], line: '#e9edf0', stars: 0, clouds: 7, head: 0 },
  gorod: { top: '#3d3a86', bottom: '#ffab70', fog: 0xeea27d, ground: 0x6b7360, road: 0x585b68, side: 0xa79c9a, hemi: [0xffd9c4, 0x4f4a63, 1.9], sun: [0xffbe8a, 1.8], line: '#f0e4d4', stars: 0, clouds: 5, head: 0.25 },
  trassa: { top: '#080d2b', bottom: '#2a3478', fog: 0x1b2455, ground: 0x24452f, road: 0x5f6580, side: 0x6d7590, hemi: [0xb4c0ff, 0x1f2748, 2.5], sun: [0xcdd8ff, 1.2], line: '#ffffff', stars: 120, clouds: 0, head: 1 },
};

function sceneryKits(T) {
  const kit = (fn) => { const m = new Mesher(T); fn(m); return m.build(); };
  const lamp = (m, dir, glowC = LIGHT) => { m.box(0.14, 5.4, 0.14, 0, 2.7, 0, 0x565d65); m.box(1.5, 0.1, 0.12, dir * 0.7, 5.35, 0, 0x565d65); m.box(0.5, 0.1, 0.24, dir * 1.3, 5.28, 0, glowC, { glow: true }); };
  const tree = (m, s = 1, c = 0x3f9b57) => { m.cyl(0.18 * s, 0.26 * s, 1.5 * s, 0, 0.75 * s, 0, 0x6b4a30, { seg: 6 }); m.ball(1.1 * s, 0, 2.2 * s, 0, c, { seg: 6 }); m.ball(0.8 * s, 0.5 * s, 2.9 * s, 0.2, c, { seg: 6 }); m.ball(0.7 * s, -0.55 * s, 2.7 * s, -0.2, c, { seg: 6 }); };
  const pine = (m, s = 1, c = 0x14513a) => { m.cyl(0.14 * s, 0.2 * s, 1, 0, 0.5, 0, 0x3a2b20, { seg: 5 }); m.cone(1.3 * s, 2.3 * s, 0, 1.9 * s, 0, c, { seg: 7 }); m.cone(1.0 * s, 2 * s, 0, 3.1 * s, 0, c, { seg: 7 }); m.cone(0.7 * s, 1.7 * s, 0, 4.2 * s, 0, c, { seg: 7 }); };
  return {
    sklad: {
      near: [
        (d) => kit((m) => lamp(m, d)),
        () => kit((m) => { for (let i = 0; i < 3; i++) m.box(1.5, 0.14, 1.5, 0, 0.1 + i * 0.28, 0, WOOD); m.box(1.2, 1.0, 1.2, 0, 1.1, 0, CARD); m.box(1.22, 0.1, 0.3, 0, 1.2, 0, TAPE); }),
        () => kit((m) => { for (const x of [-1.5, 0, 1.5]) m.box(1.3, 0.14, 1.3, x, 0.08, 0, WOOD); m.box(1.2, 1.3, 1.2, -1.5, 0.8, 0, 0xb98a50); m.box(1.2, 0.9, 1.2, 1.5, 0.6, 0, CARD); }),
        () => kit((m) => { for (let i = -2; i <= 2; i++) m.box(0.08, 1.8, 0.08, 0, 0.9, i * 2, STEEL); m.box(0.03, 1.6, 8.2, 0, 0.9, 0, 0x8d949b); }),
        () => kit((m) => { m.box(1.6, 0.55, 2.2, 0, 0.72, 0, 0xf1a51f, { r: 0.1 }); m.box(1.4, 0.06, 1.3, 0, 1.9, 0.1, 0x2b2f35); for (const s of [-1, 1]) { m.box(0.08, 1.4, 0.08, s * 0.65, 1.3, 0.6, 0x2b2f35); m.box(0.08, 1.4, 0.08, s * 0.65, 1.3, -0.5, 0x2b2f35); m.cyl(0.32, 0.32, 0.24, s * 0.82, 0.32, 0.7, TIRE, { rz: Math.PI / 2 }); m.cyl(0.24, 0.24, 0.2, s * 0.82, 0.24, -0.7, TIRE, { rz: Math.PI / 2 }); m.box(0.1, 0.08, 1.2, s * 0.35, 0.16, -1.6, 0x2b2f35); } m.box(0.26, 2.1, 0.12, 0, 1.2, -1.0, 0x3a3f46); }),
      ],
      far: [
        () => kit((m) => { m.box(14, 7.5, 18, 0, 3.75, 0, 0xd9dde0); m.box(14.4, 0.7, 18.4, 0, 7.6, 0, 0x8c939b); for (const z of [-5, 5]) for (const s of [-1, 1]) { m.box(0.1, 3.8, 4.4, s * 7.03, 1.9, z, 0x7b8289); for (let i = 0; i < 6; i++) m.box(0.12, 0.05, 4.2, s * 7.05, 0.5 + i * 0.6, z, 0x9aa1a8); } m.box(0.1, 1.4, 16, -7.04, 6, 0, 0x2fd65c); m.box(0.1, 1.4, 16, 7.04, 6, 0, 0x2fd65c); }),
        () => kit((m) => { const c = [0xc8402f, 0x2f7cf6, 0x2e9c5a, 0xe89a23]; for (let x = 0; x < 2; x++) for (let y = 0; y < 3 - x; y++) { m.box(5.6, 2.5, 12, x * 6 - 3, 1.25 + y * 2.5, 0, c[(x + y * 2) % 4]); for (let i = 0; i < 12; i++) for (const s of [-1, 1]) m.box(0.06, 2.3, 0.3, x * 6 - 3 + s * 2.82, 1.25 + y * 2.5, -5.2 + i * 0.95, 0x000000, { sx: 1 }); } }),
        () => kit((m) => { for (const s of [-1, 1]) { m.box(0.6, 19, 0.6, s * 5, 9.5, 0, 0xf2b527); m.box(0.08, 19, 2, s * 5, 9.5, 0, 0xcf9716); } m.box(14, 1.1, 1.1, 0, 19, 0, 0xf2b527); m.box(2.4, 1.6, 1.6, 2, 17.8, 0, 0x3a3f46); m.box(0.08, 8, 0.08, 2, 13, 0, DARK); m.box(5, 2.4, 2.4, 2, 7.8, 0, 0x2f7cf6); }),
      ],
    },
    gorod: {
      near: [
        (d) => kit((m) => lamp(m, d, 0xffdfa0)),
        () => kit((m) => tree(m, 1.15, 0x4b9a55)),
        () => kit((m) => tree(m, 0.9, 0x63a74d)),
        (d) => kit((m) => { m.box(0.1, 2.5, 3.2, d * -0.8, 1.25, 0, 0x4c5259); m.box(1.7, 0.12, 3.5, 0, 2.55, 0, 0x2f3338); m.box(0.5, 0.45, 2.3, 0, 0.45, 0, 0x7a8087); m.box(0.08, 1.6, 1.1, d * -0.75, 1.5, -1, 0x9fe4ff, { glow: true }); }),
        (d) => kit((m) => { m.box(0.25, 4.2, 0.25, 0, 2.1, 0, 0x4c5259); m.box(0.14, 2.3, 5, 0, 5.1, 0, 0x1e2127); m.box(0.16, 2.0, 4.7, 0, 5.1, 0, 0x2fd65c, { glow: true }); m.box(0.18, 1.0, 3.2, 0, 5.1, 0, 0x0b0c0e, { glow: true }); m.box(0.2, 0.5, 0.5, 0, 5.1, 0, 0xffd23c, { glow: true }); }),
      ],
      far: [
        () => kit((m) => { m.box(12, 26, 12, 0, 13, 0, 0x7e6a7b); m.box(12.3, 0.6, 12.3, 0, 26, 0, 0x564a58); m.windows(10, 22, 6, 11, -6.04, 13, 0, 0xffe59b, 'x', 0.55, 7); m.windows(10, 22, 6, 11, 6.04, 13, 0, 0xffe59b, 'x', 0.55, 13); m.windows(10, 22, 6, 11, 0, 13, 6.04, 0xffe59b, 'z', 0.55, 19); }),
        () => kit((m) => { m.box(11, 16, 14, 0, 8, 0, 0xa8695b); m.box(11.2, 0.5, 14.2, 0, 16, 0, 0x6e4238); m.box(5, 3, 6, 0, 17.5, 0, 0x8f5a4f); m.windows(12, 13, 7, 7, -5.54, 8.5, 0, 0xffdc9b, 'x', 0.6, 3); m.windows(12, 13, 7, 7, 5.54, 8.5, 0, 0xffdc9b, 'x', 0.6, 5); m.windows(9, 13, 5, 7, 0, 8.5, 7.04, 0xffdc9b, 'z', 0.6, 11); }),
        () => kit((m) => { m.box(13, 38, 13, 0, 19, 0, 0x54688c); m.box(8, 8, 8, 0, 42, 0, 0x45577a); m.box(0.5, 9, 0.5, 0, 50, 0, 0x8d949b); m.ball(0.3, 0, 54.5, 0, RED, { glow: true, seg: 6 }); m.windows(11, 34, 7, 16, -6.54, 19, 0, 0xcfe7ff, 'x', 0.5, 23); m.windows(11, 34, 7, 16, 6.54, 19, 0, 0xcfe7ff, 'x', 0.5, 29); m.windows(11, 34, 7, 16, 0, 19, 6.54, 0xcfe7ff, 'z', 0.5, 31); }),
      ],
    },
    trassa: {
      near: [
        (d) => kit((m) => lamp(m, d, 0xfff0b0)),
        () => kit((m) => pine(m, 1.1)),
        () => kit((m) => pine(m, 0.8, 0x1a5e43)),
        () => kit((m) => { for (let i = -3; i <= 3; i++) { m.box(0.12, 0.8, 0.12, 0, 0.4, i * 2, 0x8d949b); m.box(0.08, 0.16, 0.08, 0.04, 0.68, i * 2, AMBER, { glow: true }); } m.box(0.06, 0.32, 12.5, 0, 0.74, 0, 0xb6bdc4); }),
        (d) => kit((m) => { m.box(0.12, 2.5, 0.12, 0, 1.25, 0, 0x8d949b); m.box(0.06, 1.3, 2.2, d * 0.04, 3.1, 0, 0x1f7a44); m.box(0.08, 0.1, 1.8, d * 0.06, 3.4, 0, WHITE, { glow: true }); m.box(0.08, 0.1, 1.2, d * 0.06, 3.05, 0.2, WHITE, { glow: true }); m.box(0.08, 0.1, 1.5, d * 0.06, 2.75, -0.1, WHITE, { glow: true }); }),
      ],
      far: [
        () => kit((m) => { m.cone(16, 13, 0, 6.5, 0, 0x142a3f, { seg: 6 }); m.cone(8, 8, 9, 4, 6, 0x10233a, { seg: 6 }); }),
        () => kit((m) => { for (let i = 0; i < 5; i++) { m.cyl(0.2, 0.3, 1, -8 + i * 3.8, 0.5, (i % 2) * 5 - 2, 0x2a1f18, { seg: 5 }); m.cone(2 + i % 2, 6 + (i % 3), -8 + i * 3.8, 4 + (i % 3) / 2, (i % 2) * 5 - 2, 0x0f4030, { seg: 6 }); } }),
        () => kit((m) => { m.cyl(0.26, 0.5, 20, 0, 10, 0, 0xc9d0d8, { seg: 8 }); for (let i = 0; i < 3; i++) m.box(0.5, 9, 0.2, Math.sin(i * 2.09) * 4.5, 20 + Math.cos(i * 2.09) * 4.5, 0.4, WHITE, { rz: -i * 2.09 }); m.ball(0.6, 0, 20, 0.4, 0xc9d0d8, { seg: 8 }); m.ball(0.22, 0, 21, 0, RED, { glow: true, seg: 6 }); }),
      ],
    },
  };
}

// ---------- текстуры, которые рисуются на лету ----------
function canvasTex(T, w, h, draw, repeat = false) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = T.RepeatWrapping;
  return t;
}
function skyTexture(T, th, aspect) {
  return canvasTex(T, 320, Math.round(Math.max(180, Math.min(800, 320 / aspect))), (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h * 0.5);
    sky.addColorStop(0, th.top); sky.addColorStop(1, th.bottom); g.fillStyle = sky; g.fillRect(0, 0, w, h);
    let a = 12345; const rnd = () => (a = (a * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < th.stars; i++) { g.fillStyle = `rgba(255,255,255,${0.3 + rnd() * 0.7})`; const s = rnd() * 1.5 + 0.5; g.fillRect(rnd() * w, rnd() * h * 0.46, s, s); }
    if (th.stars) { g.fillStyle = '#f6efd0'; g.beginPath(); g.arc(w * 0.78, h * 0.14, 17, 0, 7); g.fill(); g.fillStyle = th.top; g.beginPath(); g.arc(w * 0.75, h * 0.13, 15, 0, 7); g.fill(); }
    if (th.clouds) {
      if (th.head === 0) { const sun = g.createRadialGradient(w * 0.24, h * 0.13, 4, w * 0.24, h * 0.13, w * 0.24); sun.addColorStop(0, 'rgba(255,250,220,1)'); sun.addColorStop(0.35, 'rgba(255,245,200,.6)'); sun.addColorStop(1, 'rgba(255,245,200,0)'); g.fillStyle = sun; g.fillRect(0, 0, w, h); }
      else { const sun = g.createRadialGradient(w * 0.5, h * 0.44, 8, w * 0.5, h * 0.44, w * 0.55); sun.addColorStop(0, 'rgba(255,240,190,1)'); sun.addColorStop(0.3, 'rgba(255,190,120,.7)'); sun.addColorStop(1, 'rgba(255,160,110,0)'); g.fillStyle = sun; g.fillRect(0, 0, w, h); }
      for (let i = 0; i < th.clouds; i++) { const x = rnd() * w, y = rnd() * h * 0.34 + 14; g.fillStyle = th.head ? 'rgba(255,214,186,.55)' : 'rgba(255,255,255,.85)'; for (let k = 0; k < 5; k++) { g.beginPath(); g.ellipse(x + k * 16 - 32, y + (k % 2) * 4, 22 - Math.abs(k - 2) * 4, 9 + (2 - Math.abs(k - 2)) * 2, 0, 0, 7); g.fill(); } }
    }
  });
}
function roadTexture(T, th) {
  return canvasTex(T, 256, 256, (g, w, h) => {
    g.fillStyle = '#' + th.road.toString(16).padStart(6, '0'); g.fillRect(0, 0, w, h);
    let a = 777; const rnd = () => (a = (a * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.08})`; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
    g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(w * 0.13, 0, 8, h); g.fillRect(w * 0.47, 0, 7, h); g.fillRect(w * 0.8, 0, 8, h);
    g.fillStyle = th.line;
    for (const x of [1 / 3, 2 / 3]) { g.fillRect(w * x - 3, h * 0.08, 6, h * 0.42); }
    g.fillRect(0, 0, 7, h); g.fillRect(w - 7, 0, 7, h);
  }, true);
}
const blobTexture = (T) => canvasTex(T, 128, 128, (g, w, h) => { const r = g.createRadialGradient(w / 2, h / 2, 6, w / 2, h / 2, w / 2); r.addColorStop(0, 'rgba(0,0,0,.6)'); r.addColorStop(0.65, 'rgba(0,0,0,.34)'); r.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = r; g.fillRect(0, 0, w, h); });
const beamTexture = (T) => canvasTex(T, 128, 256, (g, w, h) => { const r = g.createLinearGradient(0, h, 0, 0); r.addColorStop(0, 'rgba(255,240,180,.55)'); r.addColorStop(1, 'rgba(255,240,180,0)'); g.fillStyle = r; g.beginPath(); g.moveTo(w * 0.3, h); g.lineTo(w * 0.7, h); g.lineTo(w, 0); g.lineTo(0, 0); g.fill(); });
const finishTexture = (T) => canvasTex(T, 512, 96, (g, w, h) => { g.fillStyle = '#0d0f12'; g.fillRect(0, 0, w, h); for (let x = 0; x < w; x += 24) for (let y = 0; y < 2; y++) { g.fillStyle = (x / 24 + y) % 2 ? '#ffffff' : '#0d0f12'; g.fillRect(x, y * 18, 24, 18); } g.fillStyle = '#39ff6a'; g.font = '900 44px sans-serif'; g.textAlign = 'center'; g.fillText('ФИНИШ', w / 2, 86); });

// ---------- материалы с изгибом мира ----------
function bendMaterial(mat, bend) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uBend = bend;
    sh.vertexShader = 'uniform vec2 uBend;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nmvPosition.xy += uBend * mvPosition.z * mvPosition.z;\ngl_Position = projectionMatrix * mvPosition;');
  };
  mat.customProgramCacheKey = () => 'bend';
  return mat;
}

// ---------- заезд ----------
const RANGE = 230;   // сколько метров вперёд видно
export class GameView {
  constructor(canvas, T, { low = false } = {}) {
    this.T = T; this.canvas = canvas; this.low = low;
    this.r = new T.WebGLRenderer({ canvas, antialias: !low, powerPreference: 'high-performance' });
    this.pixel = Math.min(window.devicePixelRatio || 1, low ? 1.25 : 2);
    this.r.setPixelRatio(this.pixel);
    this.scene = new T.Scene();
    this.cam = new T.PerspectiveCamera(58, 1, 0.5, 400);
    this.bend = { value: new T.Vector2(0, -0.00085) };
    const B = (m) => bendMaterial(m, this.bend);
    this.mat = B(new T.MeshLambertMaterial({ vertexColors: true }));
    this.glowMat = B(new T.MeshBasicMaterial({ vertexColors: true }));
    this.hemi = new T.HemisphereLight(0xffffff, 0x777777, 2);
    this.sun = new T.DirectionalLight(0xffffff, 1.6); this.sun.position.set(-6, 14, 8);
    this.scene.add(this.hemi, this.sun);
    this.scene.fog = new T.Fog(0xffffff, 70, RANGE - 20);
    this.themes = {}; this.zone = null; this.shake = 0; this.time = 0; this.fps = { n: 0, t: 0 };
    this.buildGround(); this.buildPools(); this.buildTruckRig(); this.buildParticles();
    this.resize();
  }
  theme(z) {
    if (!this.themes[z]) { const th = THEMES[z]; this.themes[z] = { ...th, sky: skyTexture(this.T, th, this.cam.aspect), roadTex: roadTexture(this.T, th) }; this.themes[z].roadTex.repeat.set(1, 26); }
    return this.themes[z];
  }
  buildGround() {
    const T = this.T, B = (m) => bendMaterial(m, this.bend), segs = 40;
    const plane = (w, mat, x, y = 0) => { const g = new T.PlaneGeometry(w, RANGE + 60, 1, segs); g.rotateX(-Math.PI / 2); g.boundingSphere = null; const mesh = new T.Mesh(g, mat); mesh.position.set(x, y, -(RANGE + 60) / 2 + 30); mesh.frustumCulled = false; this.scene.add(mesh); return mesh; };
    this.roadMat = B(new T.MeshLambertMaterial({ color: 0xffffff }));
    this.road = plane(LANE_W * 3 + 0.5, this.roadMat, 0, 0.01);
    this.sideMat = B(new T.MeshLambertMaterial({ color: 0xbbbbbb }));
    plane(2.2, this.sideMat, -(LANE_W * 1.5 + 1.35), 0.09); plane(2.2, this.sideMat, LANE_W * 1.5 + 1.35, 0.09);
    this.groundMat = B(new T.MeshLambertMaterial({ color: 0x888888 }));
    plane(120, this.groundMat, -(LANE_W * 1.5 + 2.4 + 60), 0); plane(120, this.groundMat, LANE_W * 1.5 + 2.4 + 60, 0);
  }
  buildPools() {
    const T = this.T;
    this.obGeo = {}; this.obPool = {};
    this.kits = sceneryKits(T);
    this.slots = []; this.kitCache = {};
    let a = 4242; this.srnd = () => (a = (a * 16807) % 2147483647) / 2147483647;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 18; i++) this.slots.push(this.newSlot(side, 'near', i * 13 + this.srnd() * 4));
      for (let i = 0; i < 10; i++) this.slots.push(this.newSlot(side, 'far', i * 24 + this.srnd() * 8));
    }
    this.coins = new T.InstancedMesh(coinGeo(T), bendMaterial(new T.MeshLambertMaterial({ vertexColors: true, emissive: 0x7a5200 }), this.bend), 220);
    this.coins.instanceMatrix.setUsage(T.DynamicDrawUsage); this.coins.frustumCulled = false; this.scene.add(this.coins);
    this.itemGeo = {}; this.itemPool = {};
    this.dummy = new T.Object3D();
    this.blobs = new T.InstancedMesh(new T.CircleGeometry(1, 16).rotateX(-Math.PI / 2), bendMaterial(new T.MeshBasicMaterial({ map: blobTexture(T), transparent: true, depthWrite: false }), this.bend), 60);
    this.blobs.frustumCulled = false; this.blobs.renderOrder = 1; this.scene.add(this.blobs);
    // финишная арка
    const m = new Mesher(T); for (const s of [-1, 1]) { m.box(0.5, 7.4, 0.5, s * 5.6, 3.7, 0, 0x2b2f35); m.ball(0.34, s * 5.6, 7.6, 0, 0x39ff6a, { glow: true, seg: 8 }); }
    const f = m.build();
    this.finish = new T.Group(); this.finish.add(new T.Mesh(f.geo, this.mat), new T.Mesh(f.glow, this.glowMat));
    const banner = new T.Mesh(new T.PlaneGeometry(11.4, 2.2), bendMaterial(new T.MeshBasicMaterial({ map: finishTexture(T), side: T.DoubleSide }), this.bend));
    banner.position.y = 6.6; this.finish.add(banner); this.finish.visible = false; this.scene.add(this.finish);
    this.finish.traverse((o) => { o.frustumCulled = false; });
  }
  newSlot(side, row, z) {
    const T = this.T, mesh = new T.Mesh(new T.BufferGeometry(), this.mat), glow = new T.Mesh(new T.BufferGeometry(), this.glowMat);
    mesh.frustumCulled = glow.frustumCulled = false; mesh.add(glow); this.scene.add(mesh);
    return { side, row, z, mesh, glow, x: 0, set: false };
  }
  kit(zone, row, i, side) {
    const key = `${zone}:${row}:${i}:${side}`;
    if (!this.kitCache[key]) this.kitCache[key] = this.kits[zone][row][i](-side);
    return this.kitCache[key];
  }
  placeSlot(s, zone) {
    const list = this.kits[zone][s.row], i = Math.floor(this.srnd() * list.length), k = this.kit(zone, s.row, i, s.side);
    s.mesh.geometry = k.geo; s.glow.geometry = k.glow || (this.emptyGeo ||= new this.T.BufferGeometry());
    s.glow.visible = !!k.glow;
    s.x = s.side * (s.row === 'near' ? LANE_W * 1.5 + 2.2 + this.srnd() * 1.5 : 21 + this.srnd() * 14);
    s.mesh.rotation.y = s.row === 'far' ? Math.round(this.srnd() * 3) * (Math.PI / 2) : 0;
    s.mesh.position.x = s.x;
    s.set = true;
  }
  buildTruckRig() {
    const T = this.T;
    this.rig = new T.Group(); this.scene.add(this.rig);
    this.bodyPivot = new T.Group(); this.rig.add(this.bodyPivot);
    this.body = new T.Mesh(new T.BufferGeometry(), this.mat); this.bodyGlow = new T.Mesh(new T.BufferGeometry(), this.glowMat);
    this.body.frustumCulled = this.bodyGlow.frustumCulled = false; this.bodyPivot.add(this.body, this.bodyGlow);
    this.wheelG = wheelGeo(T); this.wheels = [];
    const d = driverParts(T); this.driver = new T.Mesh(d.geo, this.mat); this.driver.frustumCulled = false; this.bodyPivot.add(this.driver);
    // щит вокруг машины и свет фар ночью
    this.bubble = new T.Mesh(new T.SphereGeometry(1, 18, 12), bendMaterial(new T.MeshBasicMaterial({ color: 0x4fc3ff, transparent: true, opacity: 0.22, depthWrite: false, blending: T.AdditiveBlending }), this.bend));
    this.bubble.visible = false; this.bubble.frustumCulled = false; this.rig.add(this.bubble);
    const beam = beamTexture(T); this.beamMat = bendMaterial(new T.MeshBasicMaterial({ map: beam, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }), this.bend);
    const g = new T.PlaneGeometry(6, 22); g.rotateX(-Math.PI / 2); g.translate(0, 0.06, -13);
    this.beam = new T.Mesh(g, this.beamMat); this.beam.frustumCulled = false; this.rig.add(this.beam);
    this.truckInfo = null;
  }
  setTruck(id, paintId) {
    const T = this.T, info = truckModel(T, id, paintById(paintId).hex);
    this.body.geometry.dispose(); this.bodyGlow.geometry.dispose();
    this.body.geometry = info.geo; this.bodyGlow.geometry = info.glow || new T.BufferGeometry();
    for (const w of this.wheels) this.bodyPivot.remove(w);
    this.wheels = info.wheels.map(([x, y, z, r]) => { const w = new T.Mesh(this.wheelG, this.mat); w.position.set(x, y, z); w.scale.setScalar(r); w.frustumCulled = false; this.bodyPivot.add(w); return w; });
    this.driver.position.set(...info.driver); this.driver.userData.base = info.driver;
    this.truckInfo = info;
    this.duckScale = Math.min(0.62, 1.42 / info.height);
    this.camDist = 11.6 + Math.max(0, info.length - 3.8) * 1.05; this.camY = 6.6 + Math.max(0, info.length - 3.8) * 0.55;
    this.bubble.scale.set(2.2, info.height * 0.7 + 0.5, Math.max(2.8, info.length * 0.62)); this.bubble.position.set(0, info.height * 0.42, info.length * 0.28);
    return info;
  }
  buildParticles() {
    const T = this.T;
    this.parts = []; this.partMesh = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), bendMaterial(new T.MeshBasicMaterial({ color: 0xffffff }), this.bend), 90);
    this.partMesh.instanceMatrix.setUsage(T.DynamicDrawUsage); this.partMesh.frustumCulled = false; this.partMesh.count = 0; this.scene.add(this.partMesh);
    this.color = new T.Color();
  }
  burst(x, y, z, color, n = 8, speed = 6, size = 0.16) {
    for (let i = 0; i < n && this.parts.length < 90; i++) {
      const a = Math.random() * 6.28, b = Math.random() * 3.14;
      this.parts.push({ x, y, z, vx: Math.cos(a) * Math.sin(b) * speed, vy: Math.abs(Math.cos(b)) * speed * 0.9 + 1.5, vz: Math.sin(a) * Math.sin(b) * speed, life: 0.45 + Math.random() * 0.3, c: color, s: size * (0.7 + Math.random() * 0.6) });
    }
  }
  setZone(zone) {
    if (zone === this.zone) return;
    const first = !this.zone; this.zone = zone;
    const th = this.theme(zone);
    this.scene.background = th.sky;
    this.roadMat.map = th.roadTex; this.roadMat.needsUpdate = true;
    this.target = th;
    if (first) this.applyTheme(1);
  }
  // плавная смена цветов между районами в бесконечном рейсе
  applyTheme(k) {
    const th = this.target, T = this.T; if (!th) return;
    const mix = (c, hex) => c.lerp(this.color.set(hex), k);
    mix(this.scene.fog.color, th.fog); mix(this.roadMat.color, th.road === undefined ? 0xffffff : th.road);
    mix(this.sideMat.color, th.side); mix(this.groundMat.color, th.ground);
    mix(this.hemi.color, th.hemi[0]); mix(this.hemi.groundColor, th.hemi[1]); this.hemi.intensity += (th.hemi[2] - this.hemi.intensity) * k;
    mix(this.sun.color, th.sun[0]); this.sun.intensity += (th.sun[1] - this.sun.intensity) * k;
    this.beamMat.opacity += (th.head * 0.75 - this.beamMat.opacity) * k;
  }
  startRun(run) {
    this.setZone(run.course.zoneAt(0));
    for (const s of this.slots) { s.set = false; }
    this.finish.visible = !!run.level;
    this.camX = 0; this.rollV = 0;
  }
  handle(events, run) {
    for (const e of events) {
      if (e.t === 'coin') this.burst(this.rig.position.x, 1.4, -0.6, 0xffd23c, 4, 3.5, 0.12);
      else if (e.t === 'cargo') this.burst(this.rig.position.x, 1.6, -0.6, 0xc9975b, 12, 6, 0.2);
      else if (e.t === 'power') this.burst(this.rig.position.x, 1.8, -0.6, 0xff5ec4, 16, 7, 0.18);
      else if (e.t === 'land') this.burst(this.rig.position.x, 0.2, 0.6, 0xc8ccd1, 7, 3, 0.14);
      else if (e.t === 'hit' || e.t === 'smash') { this.shake = e.t === 'hit' ? 1 : 0.6; this.burst(e.o.x, 1.2, -1.6, 0xff6a3d, 14, 8, 0.22); this.burst(e.o.x, 1, -1.6, 0xd9c29b, 12, 7, 0.26); }
      else if (e.t === 'crash') { this.shake = 1.4; this.burst(this.rig.position.x, 1.8, -1, 0x4a4e55, 22, 6, 0.34); }
    }
  }
  // кадр заезда
  frame(dt, run) {
    this.time += dt; const T = this.T, t = this.time, z = run.z;
    // район меняется только в бесконечном рейсе
    const zone = run.course.zoneAt(z); if (zone !== this.zone) this.setZone(zone);
    if (this.target) this.applyTheme(Math.min(1, dt * 1.2));
    // разметка едет навстречу, дорога чуть поворачивает и дышит
    if (this.roadMat.map) this.roadMat.map.offset.y = (z / (RANGE + 60)) * 26;
    this.bend.value.x = Math.sin(z * 0.006) * 0.0011 + Math.sin(z * 0.0023 + 1) * 0.0007;
    this.bend.value.y = -0.00085 + Math.sin(z * 0.004) * 0.00022;
    // машина
    const info = this.truckInfo, rig = this.rig; rig.position.x = run.x; rig.position.y = run.y + 0.02;
    const vx = (run.x - (this.prevX ?? run.x)) / Math.max(dt, 0.001); this.prevX = run.x;
    this.rollV += ((-vx * 0.012) - this.rollV) * Math.min(1, dt * 14);
    const air = run.y > 0, duck = run.duck > 0, sq = duck ? this.duckScale : 1;
    this.squash = (this.squash ?? 1) + (sq - (this.squash ?? 1)) * Math.min(1, dt * 18);
    const P = this.bodyPivot; P.rotation.z = this.rollV; P.rotation.y = -this.rollV * 0.7;
    P.rotation.x += ((air ? Math.max(-0.2, Math.min(0.2, run.vy * 0.018)) : 0) - P.rotation.x) * Math.min(1, dt * 12);
    P.scale.y = this.squash + (air ? 0.04 : 0) + (run.done ? 0 : Math.sin(t * 24) * 0.006); P.scale.x = 1 + (1 - this.squash) * 0.2;
    P.position.y = (run.done ? 0 : Math.abs(Math.sin(t * 11)) * 0.03);
    for (const w of this.wheels) w.rotation.x -= (run.speed * dt) / Math.max(0.3, w.scale.x);
    if (info) { this.driver.position.y = info.driver[1] + Math.sin(t * 9) * 0.015; this.driver.rotation.z = this.rollV * 2; this.driver.rotation.y = 0.5 + Math.sin(t * 1.3) * 0.25; this.driver.rotation.x = air ? -0.35 : 0; }
    rig.visible = !(run.invuln > 0 && !run.done && Math.floor(t * 13) % 2 === 0);
    this.bubble.visible = run.power.shield > 0; this.bubble.material.opacity = 0.16 + Math.sin(t * 7) * 0.05 + (run.power.shield < 1.5 ? (Math.floor(t * 8) % 2) * 0.1 : 0);
    // пыль из-под колёс
    if (!air && !run.done && Math.random() < dt * (run.speed * 0.9)) this.burst(run.x + (Math.random() - 0.5) * 1.5, 0.15, (info ? info.length * 0.48 : 2), zone === 'trassa' ? 0x4c5578 : 0xbfc4c9, 1, 1.2, 0.13);
    this.syncScenery(run); this.syncEntities(run); this.syncBlobs(run); this.syncParticles(dt);
    // камера: чем быстрее, тем шире обзор
    this.camX += (run.x * 0.55 - this.camX) * Math.min(1, dt * 6);
    const fov = 56 + Math.min(14, (run.speed - 11) * 0.62); if (Math.abs(fov - this.cam.fov) > 0.05) { this.cam.fov += (fov - this.cam.fov) * Math.min(1, dt * 2); this.cam.updateProjectionMatrix(); }
    this.shake = Math.max(0, this.shake - dt * 2.4);
    const sh = this.shake * this.shake * 0.4;
    this.cam.position.set(this.camX + (Math.random() - 0.5) * sh, this.camY * this.fit + run.y * 0.3 + (Math.random() - 0.5) * sh, this.camDist * this.fit);
    this.cam.lookAt(this.camX * 0.55, 1.2 + run.y * 0.25, -18);
    this.r.render(this.scene, this.cam);
    this.adapt(dt);
  }
  syncScenery(run) {
    const z = run.z, c = run.course;
    for (const s of this.slots) {
      const span = s.row === 'near' ? 18 * 13 : 10 * 24;
      if (!s.set || s.z - z < -24) {
        if (s.set) s.z += span;
        while (s.z - z < -24) s.z += span;
        this.placeSlot(s, c.zoneAt(s.z));
      }
      s.mesh.position.z = -(s.z - z);
      s.mesh.visible = s.z - z > -14 && !(this.low && s.row === 'far' && s.z - z > 150);
    }
    if (this.finish.visible && run.level) { this.finish.position.set(0, 0, -(run.level.len - z)); }
  }
  pooled(pool, key, make) {
    const p = pool[key] || (pool[key] = { list: [], used: 0 });
    if (p.used >= p.list.length) { const o = make(); p.list.push(o); this.scene.add(o); }
    const o = p.list[p.used++]; o.visible = true;
    return o;
  }
  group(geo) {
    const T = this.T, g = new T.Mesh(geo.geo, this.mat); g.frustumCulled = false;
    if (geo.glow) { const gl = new T.Mesh(geo.glow, this.glowMat); gl.frustumCulled = false; g.add(gl); }
    return g;
  }
  syncEntities(run) {
    const T = this.T, z = run.z, d = this.dummy, t = this.time;
    for (const k in this.obPool) this.obPool[k].used = 0;
    for (const k in this.itemPool) this.itemPool[k].used = 0;
    const blobs = this._blobs = [];
    // препятствия
    const obs = run.course.obstacles;
    for (let i = run.iOb; i < obs.length; i++) {
      const o = obs[i], vz = run.visualZ(o);
      if (o.z - z > RANGE) break;
      if (o.gone || vz - z > RANGE) continue;
      const key = o.kind === 'moving' ? `moving${o.model % 2}` : o.kind === 'full' ? `full${o.model % 4}` : `${o.kind}${o.model % 2}`;
      const mesh = this.pooled(this.obPool, key, () => this.group(this.obGeo[key] || (this.obGeo[key] = obstacleGeo(T, key))));
      mesh.position.set(o.x, 0, -(vz - z));
      // препятствия подлиннее растягиваются вперёд (встречные — только машины, их не растягиваем)
      mesh.scale.z = o.kind === 'full' ? o.len / 3 : 1;
      if (o.kind === 'moving') mesh.position.y = Math.abs(Math.sin(t * 13 + i)) * 0.03;
      if (o.kind !== 'gate') blobs.push(o.x, -(vz - z) - (o.len || 1) / 2, 1.5, Math.max(1.4, (o.len || 1) * 0.72));
    }
    for (const k in this.obPool) { const p = this.obPool[k]; for (let i = p.used; i < p.list.length; i++) p.list[i].visible = false; }
    // предметы
    const items = run.course.items; let nc = 0;
    for (let i = run.iIt; i < items.length; i++) {
      const it = items[i];
      if (it.z - z > RANGE) break;
      if (it.got) continue;
      let dz = it.z - z, x = it.x, y = it.y;
      if (it.pulled) { const k = Math.max(0, Math.min(1, dz / 16)); x = run.x + (it.x - run.x) * k; y = 1.2 + (it.y - 1.2) * k; }
      if (it.kind === 'coin') {
        if (nc >= 220) continue;
        d.position.set(x, y + Math.sin(t * 3 + it.z) * 0.07, -dz); d.rotation.set(0, t * 3.2 + it.z * 0.12, 0); d.scale.setScalar(0.92); d.updateMatrix();
        this.coins.setMatrixAt(nc++, d.matrix);
      } else {
        const mesh = this.pooled(this.itemPool, it.kind, () => this.group(this.itemGeo[it.kind] || (this.itemGeo[it.kind] = itemGeo(T, it.kind))));
        mesh.position.set(x, y + Math.sin(t * 2.5 + it.z) * 0.12, -dz); mesh.rotation.y = t * 1.8;
        mesh.scale.setScalar(it.kind === 'cargo' ? 1.05 : 1.2);
        blobs.push(x, -dz, 0.8, 0.8);
      }
    }
    this.coins.count = nc; this.coins.instanceMatrix.needsUpdate = true;
    for (const k in this.itemPool) { const p = this.itemPool[k]; for (let i = p.used; i < p.list.length; i++) p.list[i].visible = false; }
  }
  syncBlobs(run) {
    const d = this.dummy, b = this._blobs || []; let n = 0;
    const h = Math.max(0.5, 1 - run.y * 0.14), info = this.truckInfo;
    d.position.set(run.x, 0.11, info ? info.length * 0.28 : 0); d.rotation.set(0, 0, 0); d.scale.set(1.5 * h, 1, (info ? Math.max(2.3, info.length * 0.68) : 2.5) * h); d.updateMatrix(); this.blobs.setMatrixAt(n++, d.matrix);
    for (let i = 0; i + 3 < b.length && n < 60; i += 4) { d.position.set(b[i], 0.1, b[i + 1]); d.scale.set(b[i + 2], 1, b[i + 3]); d.updateMatrix(); this.blobs.setMatrixAt(n++, d.matrix); }
    this.blobs.count = n; this.blobs.instanceMatrix.needsUpdate = true;
  }
  syncParticles(dt) {
    const d = this.dummy, m = this.partMesh; let n = 0;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]; p.life -= dt;
      if (p.life <= 0) { this.parts.splice(i, 1); continue; }
      p.vy -= 16 * dt; p.x += p.vx * dt; p.y = Math.max(0.06, p.y + p.vy * dt); p.z += (p.vz + 16) * dt;
      d.position.set(p.x, p.y, p.z); d.rotation.set(p.life * 7, p.life * 5, 0); d.scale.setScalar(p.s * Math.min(1, p.life * 3)); d.updateMatrix();
      m.setMatrixAt(n, d.matrix); m.setColorAt(n, this.color.set(p.c)); n++;
    }
    m.count = n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
  // слабый телефон: снижаем чёткость и убираем дальние объекты, но не частоту кадров
  adapt(dt) {
    const f = this.fps; f.n++; f.t += dt;
    if (f.t < 2.5) return;
    const v = f.n / f.t; f.n = 0; f.t = 0; this.lastFps = v;
    if (v < 38 && this.pixel > 1) { this.pixel = Math.max(1, this.pixel - 0.35); this.r.setPixelRatio(this.pixel); this.resize(); }
    else if (v < 30) this.low = true;
  }
  resize() {
    const c = this.canvas, w = c.clientWidth || innerWidth, h = c.clientHeight || innerHeight;
    this.r.setSize(w, h, false); this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
    this.fit = w > h ? 0.72 : 1;   // на широком экране полосы и так помещаются
  }
  dispose() { this.r.dispose(); this.r.forceContextLoss?.(); }
}

// ---------- витрина в гараже: машина крутится на подиуме ----------
export class GaragePreview {
  constructor(canvas, T) {
    this.T = T; this.canvas = canvas;
    this.r = new T.WebGLRenderer({ canvas, antialias: true, alpha: true }); this.r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.scene = new T.Scene(); this.cam = new T.PerspectiveCamera(32, 1, 0.5, 100);
    this.scene.add(new T.HemisphereLight(0xffffff, 0x445066, 2.5));
    const sun = new T.DirectionalLight(0xffffff, 2); sun.position.set(5, 9, 6); this.scene.add(sun);
    this.mat = new T.MeshLambertMaterial({ vertexColors: true }); this.glowMat = new T.MeshBasicMaterial({ vertexColors: true });
    const m = new Mesher(T); m.cyl(4.6, 4.8, 0.3, 0, -0.16, 0, 0x20252c, { seg: 40 }); m.cyl(4.72, 4.72, 0.04, 0, -0.01, 0, 0x2fd65c, { seg: 40 }); m.cyl(4.55, 4.55, 0.04, 0, 0, 0, 0x262b33, { seg: 40 });
    this.scene.add(new T.Mesh(m.build().geo, this.mat));
    this.pivot = new T.Group(); this.scene.add(this.pivot);
    this.wheelG = wheelGeo(T); this.items = []; this.a = -2.5; this.resize();
  }
  setTruck(id, paintId) {
    const T = this.T, info = truckModel(T, id, paintById(paintId).hex);
    for (const o of this.items) { this.pivot.remove(o); if (o.geometry !== this.wheelG && !o.keepGeo) o.geometry.dispose(); }
    this.items = [new T.Mesh(info.geo, this.mat)];
    if (info.glow) this.items.push(new T.Mesh(info.glow, this.glowMat));
    for (const [x, y, z, r] of info.wheels) { const w = new T.Mesh(this.wheelG, this.mat); w.position.set(x, y, z); w.scale.setScalar(r); this.items.push(w); }
    const d = driverParts(T), dm = new T.Mesh(d.geo, this.mat); dm.position.set(...info.driver); dm.rotation.y = 0.35; this.items.push(dm);
    const cz = (info.length - 3.8) * 0.5;
    this.items.forEach((o) => { o.position.z -= cz; this.pivot.add(o); });
    this.dist = 9.5 + info.length * 1.05; this.lookY = info.height * 0.42;
    this.resize();
  }
  frame(dt) {
    this.a += dt * 0.5;
    this.pivot.rotation.y = this.a;
    this.cam.position.set(0, this.lookY + 3.2, this.dist); this.cam.lookAt(0, this.lookY, 0);
    this.r.render(this.scene, this.cam);
  }
  resize() { const c = this.canvas, w = c.clientWidth || 320, h = c.clientHeight || 220; this.r.setSize(w, h, false); this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); }
  dispose() { this.r.dispose(); this.r.forceContextLoss?.(); }
}

export const loadEngine = () => import('./three.game.min.js');
export function webglAvailable() { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } }
