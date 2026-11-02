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
  // ореол вокруг источника света и пятно света на дороге: видны в сумерках и ночью
  halo(x, y, z, size, c) { (this.halos ||= []).push({ x, y, z, size, c }); return this; }
  pool(x, z, sx, sz, c) { (this.pools ||= []).push({ x, z, sx, sz, c }); return this; }
  // ao — на какой высоте заканчивается затенение от земли
  build({ ao = 0 } = {}) { return { geo: merge(this.T, this.solid, ao), glow: this.glow.length ? merge(this.T, this.glow) : null, halos: this.halos, pools: this.pools }; }
}

function merge(T, parts, ao = 0) {
  let n = 0;
  for (const p of parts) n += p.g.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const { g, c } of parts) {
    const a = g.getAttribute('position'), b = g.getAttribute('normal');
    pos.set(a.array, o * 3); nor.set(b.array, o * 3);
    // у самой земли темнее: простое затенение в цвете вершин ничего не стоит при отрисовке и хорошо «ставит» модель на дорогу
    for (let i = 0; i < a.count; i++) { const k = ao ? 0.58 + 0.42 * Math.min(1, Math.max(0, a.getY(i) / ao)) : 1; col[(o + i) * 3] = c.r * k; col[(o + i) * 3 + 1] = c.g * k; col[(o + i) * 3 + 2] = c.b * k; }
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
    m.halo(s * (w / 2 - 0.2), y, z + 0.08, 1.15, RED);
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
  // тёмные арки над колёсами на бортах, которые спускаются до колеса
  const arch = (hw, list) => { for (const [x, y, z, r] of list) m.cyl(r + 0.08, r + 0.08, 0.025, Math.sign(x) * hw, y + 0.02, z, 0x101215, { rz: Math.PI / 2, seg: 16 }); };
  arch(id === 'van' ? 0.985 : id === 'fura' ? 1.105 : id === 'dump' ? 1.055 : 1.005, id === 'van' ? wheels : wheels.slice(0, 2));
  return { ...m.build({ ao: 1.15 }), wheels, driver, height, length };
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
  return m.build({ ao: 0.9 });
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
  sklad: { top: '#4f9fe8', mid: '#9dd0f6', bottom: '#e6f4ff', fog: 0xe6f4ff, ground: 0x8f9483, road: 0x6c7079, side: 0xc4c7ca, hemi: [0xffffff, 0x8c8f80, 2.1], sun: [0xfff3da, 1.9], sunPos: [-11, 15, -10], rim: 0x1c1f22, dust: 0xc8ccd1, line: 0xe9edf0, edge: 0xf2c230, glow: 0, stars: 0, clouds: 7, cloud: '255,255,255', sunAt: [0.24, 0.14], sunGlow: '255,247,214', sunCore: '255,255,240', back: ['#b4cbdc', '#9db7ca'], head: 0 },
  gorod: { top: '#2f2c74', mid: '#b4688f', bottom: '#ffab70', fog: 0xffab70, ground: 0x6b7360, road: 0x4d4f5b, side: 0xa79c9a, hemi: [0xffd9c4, 0x4f4a63, 1.9], sun: [0xffb37a, 2.1], sunPos: [-9, 10, -32], rim: 0x4a2318, dust: 0x7d6f70, line: 0xf0e4d4, edge: 0xf0e4d4, glow: 0.5, stars: 0, clouds: 5, cloud: '255,214,186', sunAt: [0.5, 0.45], sunGlow: '255,190,120', sunCore: '255,240,190', back: ['#a8688a', '#6f4a6d'], head: 0.25 },
  trassa: { top: '#060a24', mid: '#121a4c', bottom: '#2a3478', fog: 0x2a3478, ground: 0x24452f, road: 0x3b4158, side: 0x6d7590, hemi: [0xb4c0ff, 0x1f2748, 2.5], sun: [0xcdd8ff, 1.3], sunPos: [10, 15, -8], rim: 0x2b3a7a, dust: 0x4c5578, line: 0xffffff, edge: 0xffffff, glow: 1, stars: 170, clouds: 0, cloud: '255,255,255', sunAt: [0.76, 0.13], sunGlow: '150,170,255', sunCore: '246,239,208', back: ['#1a2358', '#141c48'], head: 1 },
};

function sceneryKits(T) {
  const kit = (fn, ao = 1) => { const m = new Mesher(T); fn(m); return m.build({ ao }); };
  const far = (fn) => kit(fn, 9);
  const lamp = (m, dir, glowC = LIGHT) => { m.box(0.14, 5.4, 0.14, 0, 2.7, 0, 0x565d65); m.box(1.5, 0.1, 0.12, dir * 0.7, 5.35, 0, 0x565d65); m.box(0.5, 0.1, 0.24, dir * 1.3, 5.28, 0, glowC, { glow: true }); m.halo(dir * 1.3, 5.22, 0, 2.6, glowC); m.pool(dir * 1.3, 0, 9, 11, glowC); };
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
        () => far((m) => { m.box(14, 7.5, 18, 0, 3.75, 0, 0xd9dde0); m.box(14.4, 0.7, 18.4, 0, 7.6, 0, 0x8c939b); for (const z of [-5, 5]) for (const s of [-1, 1]) { m.box(0.1, 3.8, 4.4, s * 7.03, 1.9, z, 0x7b8289); for (let i = 0; i < 6; i++) m.box(0.12, 0.05, 4.2, s * 7.05, 0.5 + i * 0.6, z, 0x9aa1a8); } m.box(0.1, 1.4, 16, -7.04, 6, 0, 0x2fd65c); m.box(0.1, 1.4, 16, 7.04, 6, 0, 0x2fd65c); }),
        () => far((m) => { const c = [0xc8402f, 0x2f7cf6, 0x2e9c5a, 0xe89a23]; for (let x = 0; x < 2; x++) for (let y = 0; y < 3 - x; y++) { m.box(5.6, 2.5, 12, x * 6 - 3, 1.25 + y * 2.5, 0, c[(x + y * 2) % 4]); for (let i = 0; i < 12; i++) for (const s of [-1, 1]) m.box(0.06, 2.3, 0.3, x * 6 - 3 + s * 2.82, 1.25 + y * 2.5, -5.2 + i * 0.95, 0x000000, { sx: 1 }); } }),
        () => far((m) => { for (const s of [-1, 1]) { m.box(0.6, 19, 0.6, s * 5, 9.5, 0, 0xf2b527); m.box(0.08, 19, 2, s * 5, 9.5, 0, 0xcf9716); } m.box(14, 1.1, 1.1, 0, 19, 0, 0xf2b527); m.box(2.4, 1.6, 1.6, 2, 17.8, 0, 0x3a3f46); m.box(0.08, 8, 0.08, 2, 13, 0, DARK); m.box(5, 2.4, 2.4, 2, 7.8, 0, 0x2f7cf6); }),
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
        () => far((m) => { m.box(12, 26, 12, 0, 13, 0, 0x7e6a7b); m.box(12.3, 0.6, 12.3, 0, 26, 0, 0x564a58); m.windows(10, 22, 6, 11, -6.04, 13, 0, 0xffe59b, 'x', 0.55, 7); m.windows(10, 22, 6, 11, 6.04, 13, 0, 0xffe59b, 'x', 0.55, 13); m.windows(10, 22, 6, 11, 0, 13, 6.04, 0xffe59b, 'z', 0.55, 19); }),
        () => far((m) => { m.box(11, 16, 14, 0, 8, 0, 0xa8695b); m.box(11.2, 0.5, 14.2, 0, 16, 0, 0x6e4238); m.box(5, 3, 6, 0, 17.5, 0, 0x8f5a4f); m.windows(12, 13, 7, 7, -5.54, 8.5, 0, 0xffdc9b, 'x', 0.6, 3); m.windows(12, 13, 7, 7, 5.54, 8.5, 0, 0xffdc9b, 'x', 0.6, 5); m.windows(9, 13, 5, 7, 0, 8.5, 7.04, 0xffdc9b, 'z', 0.6, 11); }),
        () => far((m) => { m.box(13, 38, 13, 0, 19, 0, 0x54688c); m.box(8, 8, 8, 0, 42, 0, 0x45577a); m.box(0.5, 9, 0.5, 0, 50, 0, 0x8d949b); m.ball(0.3, 0, 54.5, 0, RED, { glow: true, seg: 6 }); m.windows(11, 34, 7, 16, -6.54, 19, 0, 0xcfe7ff, 'x', 0.5, 23); m.windows(11, 34, 7, 16, 6.54, 19, 0, 0xcfe7ff, 'x', 0.5, 29); m.windows(11, 34, 7, 16, 0, 19, 6.54, 0xcfe7ff, 'z', 0.5, 31); }),
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
        () => far((m) => { m.cone(16, 13, 0, 6.5, 0, 0x142a3f, { seg: 6 }); m.cone(8, 8, 9, 4, 6, 0x10233a, { seg: 6 }); }),
        () => far((m) => { for (let i = 0; i < 5; i++) { m.cyl(0.2, 0.3, 1, -8 + i * 3.8, 0.5, (i % 2) * 5 - 2, 0x2a1f18, { seg: 5 }); m.cone(2 + i % 2, 6 + (i % 3), -8 + i * 3.8, 4 + (i % 3) / 2, (i % 2) * 5 - 2, 0x0f4030, { seg: 6 }); } }),
        () => far((m) => { m.cyl(0.26, 0.5, 20, 0, 10, 0, 0xc9d0d8, { seg: 8 }); for (let i = 0; i < 3; i++) m.box(0.5, 9, 0.2, Math.sin(i * 2.09) * 4.5, 20 + Math.cos(i * 2.09) * 4.5, 0.4, WHITE, { rz: -i * 2.09 }); m.ball(0.6, 0, 20, 0.4, 0xc9d0d8, { seg: 8 }); m.ball(0.22, 0, 21, 0, RED, { glow: true, seg: 6 }); }),
      ],
    },
  };
}

// ---------- текстуры, которые рисуются на лету ----------
const seeded = (s) => { let a = s; return () => (a = (a * 16807) % 2147483647) / 2147483647; };
function canvasTex(T, w, h, draw, { repeat = false, srgb = true, aniso = 1, mips = true } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new T.CanvasTexture(c); if (srgb) t.colorSpace = T.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = T.RepeatWrapping;
  t.anisotropy = aniso;
  if (!mips) { t.generateMipmaps = false; t.minFilter = T.LinearFilter; }
  return t;
}
// небо привязано к экрану и рисуется под его пропорции, чтобы солнце и луна оставались круглыми
function skyTexture(T, th, aspect) {
  const W = aspect > 1 ? 1024 : 640, H = Math.round(Math.max(320, Math.min(1280, W / aspect)));
  return canvasTex(T, W, H, (g, w, h) => {
    const rnd = seeded(12345), u = w / 512, sky = g.createLinearGradient(0, 0, 0, h * 0.6);
    sky.addColorStop(0, th.top); sky.addColorStop(0.6, th.mid); sky.addColorStop(1, th.bottom); g.fillStyle = sky; g.fillRect(0, 0, w, h);
    const soft = (x, y, r, rgb, a) => { const p = g.createRadialGradient(x, y, 0, x, y, r); p.addColorStop(0, `rgba(${rgb},${a})`); p.addColorStop(1, `rgba(${rgb},0)`); g.fillStyle = p; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); };
    for (let i = 0; i < th.stars * u; i++) { const y = rnd() * h * 0.5, s = (0.35 + rnd() * rnd() * 0.75) * u; g.fillStyle = `rgba(255,255,255,${(0.25 + rnd() * 0.75) * (1 - y / (h * 0.55))})`; g.beginPath(); g.arc(rnd() * w, y, s, 0, 7); g.fill(); }
    if (th.sunAt) {
      const [sx, sy] = th.sunAt, x = sx * w, y = sy * h;
      soft(x, y, w * 0.62, th.sunGlow, 0.55); soft(x, y, w * 0.2, th.sunGlow, 0.8); soft(x, y, w * (th.stars ? 0.055 : 0.075), th.sunCore, 1);
      if (th.stars) { g.fillStyle = '#f4efd8'; g.beginPath(); g.arc(x, y, w * 0.032, 0, 7); g.fill(); g.fillStyle = 'rgba(190,190,170,.35)'; for (const [dx, dy, r] of [[-5, -3, 3], [4, 4, 2.4], [5, -6, 1.7]]) { g.beginPath(); g.arc(x + dx * u, y + dy * u, r * u, 0, 7); g.fill(); } }
    }
    // облака из мягких пятен: снизу плотнее, сверху рыхлее
    for (let i = 0; i < th.clouds; i++) {
      const x = rnd() * w, y = h * (0.06 + rnd() * 0.3), S = (0.7 + rnd() * 0.9) * u;
      for (let k = 0; k < 11; k++) { const f = k / 10 - 0.5, r = (30 - Math.abs(f) * 34) * S; soft(x + f * 130 * S, y - (1 - Math.abs(f) * 2) * 9 * S + rnd() * 6, r, th.cloud, 0.34); }
      soft(x, y + 8 * S, 58 * S, th.cloud, 0.16);
    }
    // лёгкий шум убирает полосы на плавных переходах
    for (let i = 0; i < 2600 * u; i++) { g.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,.012)' : 'rgba(0,0,0,.012)'; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
  }, { mips: false });
}
// силуэты на горизонте: стоят в мире за концом дороги и уходят вбок вместе с поворотом
function backdropTexture(T, zone, th) {
  return canvasTex(T, 1024, 128, (g, w, h) => {
    const rnd = seeded(97 + zone.length * 131), [farC, nearC] = th.back;
    const rect = (x, bw, bh, c) => { g.fillStyle = c; for (const o of [-w, 0, w]) g.fillRect(x + o, h - bh, bw, bh); };
    if (zone === 'sklad') {
      for (let i = 0; i < 16; i++) rect(rnd() * w, 60 + rnd() * 110, 14 + rnd() * 24, farC);
      for (let i = 0; i < 4; i++) { const x = rnd() * w; rect(x, 4, 92, nearC); rect(x + 44, 4, 92, nearC); rect(x - 30, 110, 5, nearC); g.fillStyle = nearC; for (const o of [-w, 0, w]) g.fillRect(x - 30 + o, h - 92, 110, 5); }
      for (let i = 0; i < 10; i++) rect(rnd() * w, 50 + rnd() * 90, 10 + rnd() * 26, nearC);
      for (let i = 0; i < 5; i++) rect(rnd() * w, 5, 44 + rnd() * 30, nearC);
    } else if (zone === 'gorod') {
      for (let i = 0; i < 46; i++) rect(rnd() * w, 16 + rnd() * 26, 34 + rnd() * 66, farC);
      for (let i = 0; i < 26; i++) {
        const x = rnd() * w, bw = 16 + rnd() * 24, bh = 26 + rnd() * rnd() * 92;
        rect(x, bw, bh, nearC);
        if (bh > 80) rect(x + bw / 2 - 1, 2, bh + 12, nearC);
        for (let wy = h - bh + 4; wy < h - 6; wy += 6) for (let wx = x + 3; wx < x + bw - 3; wx += 5) if (rnd() < 0.34) { g.fillStyle = 'rgba(255,224,150,.8)'; g.fillRect(wx, wy, 2, 3); }
      }
    } else {
      // хребты: сумма волн с целым числом периодов, поэтому текстура не имеет шва
      const ridge = (c, base, amp, p) => { g.fillStyle = c; g.beginPath(); g.moveTo(0, h); for (let x = 0; x <= w; x += 4) { const u = (x / w) * 6.2832; g.lineTo(x, h - base - amp * (0.5 + 0.5 * Math.sin(u * 3 + p) * Math.sin(u * 5 + p * 2)) - amp * 0.4 * Math.abs(Math.sin(u * 11 + p * 3))); } g.lineTo(w, h); g.fill(); };
      ridge(farC, 26, 62, 1.1); ridge(nearC, 10, 40, 4.2);
      for (let i = 0; i < 26; i++) { g.fillStyle = 'rgba(255,214,140,.7)'; g.fillRect(rnd() * w, h - 8 - rnd() * 18, 2, 2); }
    }
    // низ растворяется в дымке, поэтому не видно, где кончается дорога
    g.globalCompositeOperation = 'source-atop';
    const fog = '#' + th.fog.toString(16).padStart(6, '0'), f = g.createLinearGradient(0, 0, 0, h);
    f.addColorStop(0.3, fog + '00'); f.addColorStop(0.94, fog); g.fillStyle = f; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = fog; g.fillRect(0, h - 3, w, 3);
  }, { repeat: true, mips: false });
}
// Дорога: красный канал — зернистость покрытия, зелёный — разметка, синий — краевая линия.
// Цвета задаёт район, поэтому текстура одна на все районы и при их смене дорога плавно перекрашивается
const ROAD_TILE = 11, SIDE_TILE = 3, GROUND_TILE = 10;
function roadTexture(T, aniso) {
  return canvasTex(T, 512, 512, (g, w, h) => {
    const img = g.createImageData(w, h), d = img.data, rnd = seeded(777), M = LANE_W * 3 + 0.5, col = new Float32Array(w), dash = new Uint8Array(w), edge = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      const m = ((x + 0.5) / w - 0.5) * M, a = Math.abs(m); let k = 1;
      for (const c of [-LANE_W, 0, LANE_W]) for (const s of [-0.85, 0.85]) { const q = Math.abs(m - c - s); if (q < 0.34) k -= (1 - q / 0.34) * 0.075; }
      col[x] = k; dash[x] = Math.abs(a - LANE_W / 2) < 0.075 ? 255 : 0; edge[x] = Math.abs(a - (M / 2 - 0.24)) < 0.075 ? 255 : 0;
    }
    const patches = Array.from({ length: 5 }, () => [rnd() * 0.8, rnd() * 0.85, 0.08 + rnd() * 0.14, 0.05 + rnd() * 0.1, 0.92 + rnd() * 0.05]);
    for (let y = 0, i = 0; y < h; y++) {
      const v = y / h, on = (v * 2) % 1 < 0.52, wave = Math.sin(v * 18.85);
      for (let x = 0; x < w; x++, i += 4) {
        const u = x / w; let lum = col[x] * (0.9 + rnd() * 0.1 + Math.sin(u * 12.57 + wave * 1.4) * 0.018);
        for (const p of patches) if (u > p[0] && u < p[0] + p[2] && v > p[1] && v < p[1] + p[3]) lum *= p[4];
        d[i] = lum * 255; d[i + 1] = on ? dash[x] * (0.8 + rnd() * 0.2) : 0; d[i + 2] = edge[x] * (0.85 + rnd() * 0.15); d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, { repeat: true, srgb: false, aniso });
}
function sideTexture(T, aniso) {
  return canvasTex(T, 256, 256, (g, w, h) => {
    const rnd = seeded(4321);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { const v = Math.round(214 + rnd() * 30); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x * w / 2, y * h / 2, w / 2, h / 2); }
    g.fillStyle = 'rgb(150,150,150)'; for (const p of [0, w / 2 - 2]) { g.fillRect(p, 0, 4, h); g.fillRect(0, p, w, 4); }
    for (let i = 0; i < 1800; i++) { g.fillStyle = `rgba(${rnd() > 0.5 ? '255,255,255' : '0,0,0'},${rnd() * 0.09})`; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
  }, { repeat: true, srgb: false, aniso });
}
function groundTexture(T, aniso) {
  return canvasTex(T, 256, 256, (g, w, h) => {
    const rnd = seeded(1234); g.fillStyle = 'rgb(226,226,226)'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      const x = rnd() * w, y = rnd() * h, r = 12 + rnd() * 34, c = rnd() > 0.5 ? '255,255,255' : '0,0,0', a = rnd() * 0.035;
      for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) { g.fillStyle = `rgba(${c},${a})`; g.beginPath(); g.arc(x + ox, y + oy, r, 0, 7); g.fill(); }
    }
    for (let i = 0; i < 3200; i++) { g.fillStyle = `rgba(${rnd() > 0.5 ? '255,255,255' : '0,0,0'},${rnd() * 0.12})`; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
  }, { repeat: true, srgb: false, aniso });
}
const blobTexture = (T) => canvasTex(T, 128, 128, (g, w, h) => { const r = g.createRadialGradient(w / 2, h / 2, 6, w / 2, h / 2, w / 2); r.addColorStop(0, 'rgba(0,0,0,.6)'); r.addColorStop(0.65, 'rgba(0,0,0,.34)'); r.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = r; g.fillRect(0, 0, w, h); });
const glowTexture = (T) => canvasTex(T, 64, 64, (g, w, h) => { const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.22, 'rgba(255,255,255,.55)'); r.addColorStop(0.55, 'rgba(255,255,255,.14)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, w, h); }, { srgb: false });
const puffTexture = (T) => canvasTex(T, 64, 64, (g, w, h) => { const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); r.addColorStop(0, 'rgba(255,255,255,.34)'); r.addColorStop(0.5, 'rgba(255,255,255,.18)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, w, h); }, { srgb: false });
const beamTexture = (T) => canvasTex(T, 128, 256, (g, w, h) => { const r = g.createLinearGradient(0, h, 0, 0); r.addColorStop(0, 'rgba(255,240,180,.55)'); r.addColorStop(1, 'rgba(255,240,180,0)'); g.fillStyle = r; g.beginPath(); g.moveTo(w * 0.3, h); g.lineTo(w * 0.7, h); g.lineTo(w, 0); g.lineTo(0, 0); g.fill(); });
const finishTexture = (T) => canvasTex(T, 512, 96, (g, w, h) => { g.fillStyle = '#0d0f12'; g.fillRect(0, 0, w, h); for (let x = 0; x < w; x += 24) for (let y = 0; y < 2; y++) { g.fillStyle = (x / 24 + y) % 2 ? '#ffffff' : '#0d0f12'; g.fillRect(x, y * 18, 24, 18); } g.fillStyle = '#39ff6a'; g.font = '900 44px sans-serif'; g.textAlign = 'center'; g.fillText('ФИНИШ', w / 2, 86); });

// ---------- материалы ----------
// Изгиб мира. rim — подсветка по краю силуэта, road — разметка из каналов текстуры дороги.
// Тени считаются до изгиба, поэтому лежат на месте и на повороте дороги
function bendMaterial(mat, bend, { rim = null, road = null, shell = false, fade = false } = {}) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uBend = bend;
    sh.vertexShader = 'uniform vec2 uBend;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nmvPosition.xy += uBend * mvPosition.z * mvPosition.z;\ngl_Position = projectionMatrix * mvPosition;');
    if (rim) { sh.uniforms.uRim = rim; sh.fragmentShader = 'uniform vec3 uRim;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight += uRim * pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 3.0);\n#include <opaque_fragment>'); }
    if (fade) {
      sh.vertexShader = 'attribute float aFade;\nvarying float vFadeA;\n' + sh.vertexShader.replace('#include <project_vertex>', 'vFadeA = aFade;\n#include <project_vertex>');
      sh.fragmentShader = 'varying float vFadeA;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', 'diffuseColor.a *= vFadeA;\n#include <opaque_fragment>');
    }
    if (shell) sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', 'diffuseColor.a *= 0.1 + 0.9 * pow(1.0 - saturate(abs(dot(normalize(vViewPosition), normal))), 2.2);\n#include <opaque_fragment>');
    if (road) { Object.assign(sh.uniforms, road); sh.fragmentShader = 'uniform vec3 uLine;\nuniform vec3 uEdge;\n' + sh.fragmentShader.replace('#include <map_fragment>', 'vec4 rt = texture2D(map, vMapUv);\ndiffuseColor.rgb = mix(mix(diffuseColor.rgb * rt.r, uLine, rt.g), uEdge, rt.b);'); }
  };
  mat.customProgramCacheKey = () => `bend${rim ? 'R' : ''}${road ? 'D' : ''}${shell ? 'S' : ''}${fade ? 'F' : ''}`;
  return mat;
}
// Две картинки с плавным переходом: при смене района небо и горизонт не перескакивают
function fadeMaterial(T, uni, { sky = false, bend = null } = {}) {
  const mat = new T.MeshBasicMaterial(sky ? { depthTest: false, depthWrite: false, fog: false } : { transparent: true, depthWrite: false, fog: false });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    if (bend) sh.uniforms.uBend = bend;
    const vert = sky
      ? '#include <project_vertex>\nvFade = vec2(position.x * 0.43 + 0.5 + uShift.x, position.y * 0.5 + 0.5 + uShift.y);\ngl_Position = vec4(position.xy, 1.0, 1.0);'
      : '#include <project_vertex>\nvFade = uv * vec2(2.0, 0.98) + vec2(0.0, 0.01);\nmvPosition.xy += uBend * mvPosition.z * mvPosition.z;\ngl_Position = projectionMatrix * mvPosition;';
    sh.vertexShader = `varying vec2 vFade;\nuniform vec2 uShift;\n${bend ? 'uniform vec2 uBend;\n' : ''}` + sh.vertexShader.replace('#include <project_vertex>', vert);
    sh.fragmentShader = 'varying vec2 vFade;\nuniform sampler2D uA;\nuniform sampler2D uB;\nuniform float uMix;\n' + sh.fragmentShader.replace('#include <map_fragment>', 'diffuseColor = mix(texture2D(uA, vFade), texture2D(uB, vFade), uMix);');
  };
  mat.customProgramCacheKey = () => (sky ? 'fadeSky' : 'fadeBack');
  return mat;
}

// ---------- заезд ----------
const RANGE = 230;   // сколько метров вперёд видно
// Уровни качества: начинаем с лучшего и снижаем, если телефон не успевает. Обычно это решается ещё во время отсчёта
const QUALITY = [{ dpr: 2, shadows: true, fx: true, below: 47 }, { dpr: 1.5, shadows: false, fx: true, below: 42 }, { dpr: 1, shadows: false, fx: false, below: 26 }, { dpr: 0.8, shadows: false, fx: false, below: 0 }];
const OB_KEYS = ['full0', 'full1', 'full2', 'full3', 'moving0', 'moving1', 'low0', 'low1', 'gate0', 'gate1'];
const obKey = (o) => (o.kind === 'moving' ? `moving${o.model % 2}` : o.kind === 'full' ? `full${o.model % 4}` : `${o.kind}${o.model % 2}`);
const DEBRIS = { full0: [CARD, 0xb98a50, TAPE, WOOD], full1: [0x2f7cf6, 0x3a86f8, GLASS, DARK], full2: [0xc8402f, 0xa63324, CHROME], full3: [0xaab0b6, 0x8d949b, 0xe5383b, WHITE], moving0: [0xf3c623, 0xf7d34a, GLASS, DARK], moving1: [0xe8eaed, 0xdfe2e6, GLASS, DARK], low0: [WOOD, CARD, 0xd2a468, 0xffd23c], low1: [0xe9ecef, 0xff6a13, 0x2b2f35], gate0: [0xe5383b, WHITE, 0x4c5259], gate1: [0x5e6770, 0xffd23c, 0x707982] };
const damp = (dt, k) => 1 - Math.exp(-dt * k);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const spring = (s, to, k, c, dt) => { s.v += (k * (to - s.x) - c * s.v) * dt; s.x += s.v * dt; };
const yieldFrame = () => new Promise((r) => setTimeout(r));

export class GameView {
  constructor(canvas, T) {
    this.T = T; this.canvas = canvas;
    this.r = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.r.shadowMap.enabled = true;
    this.scene = new T.Scene();
    this.cam = new T.PerspectiveCamera(56, 1, 0.5, 420);
    this.bend = { value: new T.Vector2(0, -0.00085) }; this.rim = { value: new T.Color(0) }; this.color = new T.Color(); this.vec = new T.Vector3();
    const aniso = Math.min(8, this.r.capabilities.getMaxAnisotropy());
    this.tex = { road: roadTexture(T, aniso), side: sideTexture(T, Math.min(4, aniso)), ground: groundTexture(T, Math.min(4, aniso)), glow: glowTexture(T) };
    this.mat = bendMaterial(new T.MeshLambertMaterial({ vertexColors: true }), this.bend, { rim: this.rim });
    this.glowMat = bendMaterial(new T.MeshBasicMaterial({ vertexColors: true }), this.bend);
    this.hemi = new T.HemisphereLight(0xffffff, 0x777777, 2);
    this.sun = new T.DirectionalLight(0xffffff, 1.6); this.sun.position.set(-11, 15, -10); this.sun.target.position.set(0, 0, -18);
    // область теней — дорога от камеры до 50 м вперёд; на компьютере карта теней чётче
    const sc = this.sun.shadow, sm = matchMedia('(pointer: fine)').matches ? 2048 : 1024; sc.mapSize.set(sm, sm); sc.bias = -0.0006; sc.normalBias = 0.03; sc.intensity = 0.8;
    Object.assign(sc.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 90 }); sc.camera.updateProjectionMatrix();
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.scene.fog = new T.Fog(0xffffff, 32, 128);   // мир изгибается и уходит за перегиб примерно в 90 м от камеры: к этому месту дымка должна сгуститься
    this.calm = matchMedia?.('(prefers-reduced-motion:reduce)')?.matches;
    this.themes = {}; this.warm = new Set(); this.zone = null; this.fade = 0; this.time = 0; this.fps = { n: 0, t: 0, skip: 20 }; this.glowK = 0;
    this.roll = { x: 0, v: 0 }; this.heave = { x: 0, v: 0 }; this.pitch = { x: 0, v: 0 }; this.squash = { x: 1, v: 0 }; this.kick = { x: 0, v: 0 };
    this.buildSky(); this.buildGround(); this.buildPools(); this.buildTruckRig(); this.buildParticles(); this.buildFx();
    this.tier = 0; this.setQuality(0);
  }
  theme(z) {
    if (!this.themes[z]) { const th = THEMES[z]; this.themes[z] = { ...th, sky: skyTexture(this.T, th, this.cam.aspect), backdrop: backdropTexture(this.T, z, th) }; }
    return this.themes[z];
  }
  buildSky() {
    const T = this.T;
    this.skyU = { uA: { value: null }, uB: { value: null }, uMix: { value: 0 }, uShift: { value: new T.Vector2() } };
    this.backU = { uA: { value: null }, uB: { value: null }, uMix: this.skyU.uMix, uShift: { value: new T.Vector2() } };
    const sky = new T.Mesh(new T.PlaneGeometry(2, 2), fadeMaterial(T, this.skyU, { sky: true }));
    sky.frustumCulled = false; sky.renderOrder = -100; this.scene.add(sky);
    const back = new T.Mesh(new T.PlaneGeometry(960, 54), fadeMaterial(T, this.backU, { bend: this.bend }));
    back.position.set(0, 40, -(RANGE + 34)); back.frustumCulled = false; this.scene.add(back);
  }
  buildGround() {
    const T = this.T, B = (m, o) => bendMaterial(m, this.bend, o), L = RANGE + 60, segs = 40;
    const plane = (w, mat, x, y = 0) => { const g = new T.PlaneGeometry(w, L, 1, segs); g.rotateX(-Math.PI / 2); g.boundingSphere = null; const mesh = new T.Mesh(g, mat); mesh.position.set(x, y, -L / 2 + 30); mesh.frustumCulled = false; this.scene.add(mesh); return mesh; };
    this.roadUni = { uLine: { value: new T.Color() }, uEdge: { value: new T.Color() } };
    this.tex.road.repeat.set(1, L / ROAD_TILE); this.tex.side.repeat.set(1, L / SIDE_TILE); this.tex.ground.repeat.set(12, L / GROUND_TILE);
    this.roadMat = B(new T.MeshLambertMaterial({ map: this.tex.road }), { road: this.roadUni });
    this.road = plane(LANE_W * 3 + 0.5, this.roadMat, 0, 0.01);
    this.sideMat = B(new T.MeshLambertMaterial({ map: this.tex.side }));
    this.sides = [plane(2.2, this.sideMat, -(LANE_W * 1.5 + 1.35), 0.09), plane(2.2, this.sideMat, LANE_W * 1.5 + 1.35, 0.09)];
    this.groundMat = B(new T.MeshLambertMaterial({ map: this.tex.ground }));
    plane(120, this.groundMat, -(LANE_W * 1.5 + 2.4 + 60), 0); plane(120, this.groundMat, LANE_W * 1.5 + 2.4 + 60, 0);
  }
  buildPools() {
    const T = this.T;
    this.obGeo = {}; this.obPool = {};
    this.kits = sceneryKits(T);
    this.slots = []; this.kitCache = {};
    this.srnd = seeded(4242);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 18; i++) this.slots.push(this.newSlot(side, 'near', i * 13 + this.srnd() * 4));
      for (let i = 0; i < 10; i++) this.slots.push(this.newSlot(side, 'far', i * 24 + this.srnd() * 8));
    }
    this.coins = new T.InstancedMesh(coinGeo(T), bendMaterial(new T.MeshLambertMaterial({ vertexColors: true, emissive: 0x7a5200 }), this.bend, { rim: this.rim }), 220);
    this.coins.instanceMatrix.setUsage(T.DynamicDrawUsage); this.coins.frustumCulled = false; this.scene.add(this.coins);
    this.itemGeo = {}; this.itemPool = {};
    this.dummy = new T.Object3D();
    this.blobs = new T.InstancedMesh(new T.CircleGeometry(1, 16).rotateX(-Math.PI / 2), bendMaterial(new T.MeshBasicMaterial({ map: blobTexture(T), transparent: true, depthWrite: false }), this.bend), 60);
    this.blobs.frustumCulled = false; this.blobs.renderOrder = 1; this.scene.add(this.blobs);
    this._b = [];
    // финишная арка: высокая, потому что после финиша машина катится дальше и камера проезжает под ней
    const m = new Mesher(T); for (const s of [-1, 1]) { m.box(0.5, 11, 0.5, s * 5.6, 5.5, 0, 0x2b2f35); m.ball(0.34, s * 5.6, 11.2, 0, 0x39ff6a, { glow: true, seg: 8 }); }
    const f = m.build();
    this.finish = new T.Group(); this.finish.add(new T.Mesh(f.geo, this.mat), new T.Mesh(f.glow, this.glowMat));
    const banner = new T.Mesh(new T.PlaneGeometry(11.4, 2.2), bendMaterial(new T.MeshBasicMaterial({ map: finishTexture(T), side: T.DoubleSide }), this.bend));
    banner.position.y = 10; this.finish.add(banner); this.finish.visible = false; this.scene.add(this.finish);
    this.finish.traverse((o) => { o.frustumCulled = false; });
  }
  newSlot(side, row, z) {
    const T = this.T, mesh = new T.Mesh(new T.BufferGeometry(), this.mat), glow = new T.Mesh(new T.BufferGeometry(), this.glowMat);
    mesh.frustumCulled = glow.frustumCulled = false; mesh.add(glow); this.scene.add(mesh);
    return { side, row, z, z0: z, mesh, glow, x: 0, set: false, k: null };
  }
  // модель зависит от стороны дороги, только если у функции сборки есть такой параметр
  kit(zone, row, i, side) {
    const fn = this.kits[zone][row][i], key = `${zone}:${row}:${i}:${fn.length ? side : 0}`;
    if (!this.kitCache[key]) this.kitCache[key] = fn(-side);
    return this.kitCache[key];
  }
  placeSlot(s, zone) {
    const list = this.kits[zone][s.row], i = Math.floor(this.srnd() * list.length), k = this.kit(zone, s.row, i, s.side);
    s.k = k; s.mesh.geometry = k.geo; s.glow.geometry = k.glow || (this.emptyGeo ||= new this.T.BufferGeometry());
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
    this.body.frustumCulled = this.bodyGlow.frustumCulled = false; this.body.castShadow = true; this.bodyPivot.add(this.body, this.bodyGlow);
    this.wheelG = wheelGeo(T); this.wheels = [];
    const d = driverParts(T); this.driver = new T.Mesh(d.geo, this.mat); this.driver.frustumCulled = false; this.bodyPivot.add(this.driver);
    // щит вокруг машины и свет фар ночью
    this.bubble = new T.Mesh(new T.SphereGeometry(1, 24, 16), bendMaterial(new T.MeshLambertMaterial({ color: 0x000000, emissive: 0x4fc3ff, transparent: true, opacity: 0.9, depthWrite: false, blending: T.AdditiveBlending }), this.bend, { shell: true }));
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
    // колёса стоят на дороге отдельно от кузова: кузов качается на подвеске над ними
    for (const w of this.wheels) this.rig.remove(w);
    this.wheels = info.wheels.map(([x, y, z, r]) => { const w = new T.Mesh(this.wheelG, this.mat); w.position.set(x, y, z); w.scale.setScalar(r); w.rotation.order = 'YXZ'; w.frustumCulled = false; w.castShadow = true; this.rig.add(w); return w; });
    // кузов качается вокруг середины машины, а не вокруг кабины
    const cz = info.length * 0.28, weight = (info.length - 3.8) / 2.6; this.cz = cz; this.weight = weight;
    this.bodyPivot.position.z = cz; this.body.position.z = this.bodyGlow.position.z = -cz;
    this.driver.position.set(info.driver[0], info.driver[1], info.driver[2] - cz);
    this.truckInfo = info;
    this.duckScale = Math.min(0.62, 1.42 / info.height);
    this.camDist = 11.6 + Math.max(0, info.length - 3.8) * 1.05; this.camY = 6.6 + Math.max(0, info.length - 3.8) * 0.55;
    this.bubble.scale.set(2.2, info.height * 0.7 + 0.5, Math.max(2.8, info.length * 0.62)); this.bubble.position.set(0, info.height * 0.42, cz);
    return info;
  }
  buildParticles() {
    const T = this.T;
    const inst = (geo, mat, n, o) => { const m = new T.InstancedMesh(geo, bendMaterial(mat, this.bend, o), n); m.instanceMatrix.setUsage(T.DynamicDrawUsage); m.frustumCulled = false; m.setColorAt(0, this.color.set(0xffffff)); m.count = 0; this.scene.add(m); return m; };
    this.parts = [];
    this.partMesh = inst(new T.BoxGeometry(1, 1, 1), new T.MeshLambertMaterial({ color: 0xffffff }), 110);
    this.softMesh = inst(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: puffTexture(T), transparent: true, depthWrite: false }), 70, { fade: true });
    this.softMesh.renderOrder = 2;
    this.softFade = new T.InstancedBufferAttribute(new Float32Array(70), 1); this.softFade.setUsage(T.DynamicDrawUsage); this.softMesh.geometry.setAttribute('aFade', this.softFade);
  }
  buildFx() {
    const T = this.T, add = (geo, mat, n) => { const m = new T.InstancedMesh(geo, bendMaterial(mat, this.bend), n); m.instanceMatrix.setUsage(T.DynamicDrawUsage); m.frustumCulled = false; m.setColorAt(0, this.color.set(0xffffff)); m.count = 0; this.scene.add(m); return m; };
    const light = () => new T.MeshBasicMaterial({ map: this.tex.glow, transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false });
    this.haloMesh = add(new T.PlaneGeometry(1, 1), light(), 56); this.haloMesh.renderOrder = 3;
    this.poolMesh = add(new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), light(), 32); this.poolMesh.renderOrder = 1;
    this.streaks = add(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.09, depthWrite: false, fog: false }), 20);
    this.streakPts = Array.from({ length: 20 }, (_, i) => ({ x: (i % 2 ? 1 : -1) * (LANE_W * 1.5 + 1 + Math.random() * 9), y: 0.5 + Math.random() * 6, z: Math.random() * 90 }));
  }
  burst(x, y, wz, color, n = 8, speed = 6, size = 0.16, { soft = false, carry = 0, life = 0.6, grav = 16, bounce = 0, spin = 7 } = {}) {
    const box = this.parts.reduce((s, p) => s + (p.soft ? 0 : 1), 0), max = soft ? 70 + box : 110;
    for (let i = 0; i < n && this.parts.length < max; i++) {
      const a = Math.random() * 6.28, b = Math.random() * 3.14, c = Array.isArray(color) ? color[Math.floor(Math.random() * color.length)] : color;
      this.parts.push({ x, y, wz, vx: Math.cos(a) * Math.sin(b) * speed, vy: Math.abs(Math.cos(b)) * speed * 0.9 + (soft ? 0.3 : 1.5), vz: Math.sin(a) * Math.sin(b) * speed + carry * this.speedNow, life: life * (0.75 + Math.random() * 0.5), max: life, c, s: size * (0.7 + Math.random() * 0.6), soft, grav, bounce, spin: spin * (0.5 + Math.random()), a: Math.random() * 6 });
    }
  }
  // препятствие разлетается по дороге: обломки летят вперёд вместе с машиной, падают и отскакивают
  debris(o, run) {
    const colors = DEBRIS[obKey(o)] || [STEEL], big = o.kind === 'full' || o.kind === 'moving';
    for (const y of big ? [0.7, 1.4, 2] : [0.5, 1]) this.burst(o.x, y, run.z + 1, colors, big ? 8 : 6, big ? 8.5 : 7, big ? 0.46 : 0.32, { carry: 0.9, life: 1.5, bounce: 0.42, spin: 9 });
    this.burst(o.x, 1.2, run.z + 1, 0xd9d4c8, 8, 3.5, 2, { soft: true, carry: 0.7, life: 0.7, grav: -1 });
  }
  setZone(zone, instant = false) {
    if (zone === this.zone && !instant) return;
    this.zone = zone; const th = this.theme(zone); this.target = th;
    if (instant) { this.skyU.uA.value = this.skyU.uB.value = th.sky; this.backU.uA.value = this.backU.uB.value = th.backdrop; this.skyU.uMix.value = 0; this.fade = 0; this.themeLeft = 0; this.applyTheme(1); }
    else { this.skyU.uB.value = th.sky; this.backU.uB.value = th.backdrop; this.fade = 0.0001; this.themeLeft = 6; }
  }
  // плавная смена цветов между районами в бесконечном рейсе
  applyTheme(k) {
    const th = this.target; if (!th) return;
    const mix = (c, hex) => c.lerp(this.color.set(hex), k);
    mix(this.scene.fog.color, th.fog); mix(this.roadMat.color, th.road); mix(this.roadUni.uLine.value, th.line); mix(this.roadUni.uEdge.value, th.edge);
    mix(this.sideMat.color, th.side); mix(this.groundMat.color, th.ground); mix(this.rim.value, th.rim);
    mix(this.hemi.color, th.hemi[0]); mix(this.hemi.groundColor, th.hemi[1]); this.hemi.intensity += (th.hemi[2] - this.hemi.intensity) * k;
    mix(this.sun.color, th.sun[0]); this.sun.intensity += (th.sun[1] - this.sun.intensity) * k;
    this.sun.position.lerp(this.vec.set(...th.sunPos), k);
    this.beamMat.opacity += (th.head * 0.75 - this.beamMat.opacity) * k;
    this.glowK += (th.glow - this.glowK) * k;
  }
  // Заранее собираем модели и отдаём их видеокарте: иначе первый показ новой модели даёт заметный рывок прямо в заезде.
  // Вызывается под экраном загрузки
  async prewarm(level) {
    const T = this.T, zones = (level ? [level.zone] : Object.keys(THEMES)).filter((z) => !this.warm.has(z)), tmp = new T.Group();
    if (!zones.length) return;
    const add = (k) => { for (const [geo, mat] of [[k.geo, this.mat], [k.glow, this.glowMat]]) if (geo) { const m = new T.Mesh(geo, mat); m.frustumCulled = false; tmp.add(m); } };
    for (const z of zones) {
      this.warm.add(z); const th = this.theme(z); this.r.initTexture(th.sky); this.r.initTexture(th.backdrop);
      for (const row of ['near', 'far']) this.kits[z][row].forEach((_, i) => { add(this.kit(z, row, i, 1)); add(this.kit(z, row, i, -1)); });
      await yieldFrame();
    }
    for (const key of OB_KEYS) add(this.obGeo[key] || (this.obGeo[key] = obstacleGeo(T, key)));
    for (const kind of ['cargo', 'magnet', 'shield', 'x2']) add(this.itemGeo[kind] || (this.itemGeo[kind] = itemGeo(T, kind)));
    if (!this.skyU.uA.value) this.setZone(zones[0], true);
    this.resize();
    this.scene.add(tmp); this.r.compile(this.scene, this.cam); this.r.render(this.scene, this.cam); this.scene.remove(tmp);
    await yieldFrame();
  }
  startRun(run) {
    this.setZone(run.course.zoneAt(0), true);
    for (const s of this.slots) { s.set = false; s.z = s.z0; }
    this.finish.visible = !!run.level;
    this.camX = 0; this.camLift = 0; this.prevVx = 0; this.vxs = 0; this.yaw = 0; this.steer = 0; this.shake = 0; this.smoke = 0; this.coast = 0; this.coastV = 0; this.coastRate = 3; this.speedNow = 0; this.lastZ = 0;
    for (const s of [this.roll, this.heave, this.pitch, this.kick]) { s.x = 0; s.v = 0; }
    this.squash.x = 1; this.squash.v = 0; this.parts.length = 0;
    for (const w of this.wheels) w.rotation.set(0, 0, 0);
    this.fps.skip = 12; this.fps.n = 0; this.fps.t = 0;
  }
  handle(events, run) {
    const x = run.x, z = run.z, len = this.truckInfo.length, dust = THEMES[this.zone].dust, W = 1 + this.weight * 0.35;
    for (const e of events) {
      if (e.t === 'coin') this.burst(x, 1.4, z + 0.6, GOLD, 3, 2.2, 0.55, { soft: true, carry: 1, life: 0.35, grav: 1 });
      else if (e.t === 'cargo') { this.burst(x, 1.6, z + 0.6, [CARD, TAPE], 10, 5.5, 0.18, { carry: 1, life: 0.7, spin: 8 }); this.burst(x, 1.4, z + 0.6, 0xffe9b0, 4, 2, 1.1, { soft: true, carry: 1, life: 0.4, grav: 0 }); }
      else if (e.t === 'power') this.burst(x, 1.8, z + 0.6, 0xff5ec4, 9, 5, 0.8, { soft: true, carry: 1, life: 0.42, grav: 2 });
      else if (e.t === 'land') {
        const v = Math.min(18, e.v || 8); this.heave.v -= v * 0.16 * W; this.pitch.v -= v * 0.1; this.shake = Math.max(this.shake, v > 13 ? 0.5 : 0.28);
        for (const s of [-1, 1]) this.burst(x + s, 0.25, z - len * 0.2, dust, 3, 2.4, 1, { soft: true, carry: 0.6, life: 0.5, grav: -1 });
      } else if (e.t === 'jump') {
        this.heave.v += 1.1; this.pitch.v += 1.2;
        this.burst(x, 0.2, z - len * 0.45, dust, 3, 1.8, 0.8, { soft: true, carry: 0.5, life: 0.4, grav: -1 });
      } else if (e.t === 'lane') this.burst(x - e.d * 0.9, 0.2, z - len * 0.4, dust, 2, 1.2, 0.6, { soft: true, carry: 0.6, life: 0.35, grav: -1 });
      else if (e.t === 'edge') { this.roll.v += e.d * 0.9; this.shake = Math.max(this.shake, 0.22); }
      else if (e.t === 'duck') this.heave.v -= 0.9;
      else if (e.t === 'hit' || e.t === 'smash') { this.shake = e.t === 'hit' ? 1 : 0.6; this.kick.v = e.t === 'hit' ? -9 : -5; this.pitch.v -= 1.5; this.heave.v += 0.6; this.debris(e.o, run); }
      else if (e.t === 'crash') { this.shake = 1.4; this.kick.v = -13; this.smoke = 2.6; this.coastV = Math.max(this.speedNow, 6) * 0.42; this.coastRate = 5; this.roll.v += (Math.random() > 0.5 ? 1 : -1) * 1.6; }
      else if (e.t === 'finish') { this.coastV = this.speedNow; this.coastRate = 1.1; this.burst(0, 6, z + 8, [0x39ff6a, GOLD, 0xff5ec4, 0x37b6ff, WHITE], 40, 9, 0.2, { carry: 0.75, life: 1.7, grav: 7, spin: 11 }); }
    }
  }
  // кадр заезда. alpha — доля пути между двумя шагами расчёта, frozen — пауза, real — сколько времени прошло на самом деле
  frame(dt, run, alpha = 1, frozen = false, real = dt) {
    this.adapt(real);
    const vdt = frozen ? 0 : dt; this.time += vdt; const t = this.time, a = run.done ? 1 : alpha;
    if (this.coastV > 0.01) { this.coast += this.coastV * vdt; this.coastV *= Math.exp(-this.coastRate * vdt); }
    const z = run.pz + (run.z - run.pz) * a + this.coast, x = run.px + (run.x - run.px) * a, y = run.py + (run.y - run.py) * a;
    const moved = z - this.lastZ; this.lastZ = z; this.renderZ = z;
    this.speedNow = run.done ? this.coastV : run.speed;
    const baseSpeed = run.course.speedAt(z);
    // район меняется только в бесконечном рейсе
    const zone = run.course.zoneAt(z); if (zone !== this.zone) this.setZone(zone);
    if (this.themeLeft > 0) { this.themeLeft -= vdt; this.applyTheme(damp(vdt, 1.2)); }
    if (this.fade > 0) { this.fade += vdt / 2.6; if (this.fade >= 1) { this.skyU.uA.value = this.skyU.uB.value; this.backU.uA.value = this.backU.uB.value; this.fade = 0; this.skyU.uMix.value = 0; } else this.skyU.uMix.value = this.fade * this.fade * (3 - 2 * this.fade); }
    // покрытие едет навстречу, дорога чуть поворачивает и дышит
    this.tex.road.offset.y = (z / ROAD_TILE) % 1; this.tex.side.offset.y = (z / SIDE_TILE) % 1; this.tex.ground.offset.y = (z / GROUND_TILE) % 1;
    this.bend.value.x = Math.sin(z * 0.006) * 0.0011 + Math.sin(z * 0.0023 + 1) * 0.0007;
    this.bend.value.y = -0.00085 + Math.sin(z * 0.004) * 0.00022;
    this.driveTruck(vdt, run, x, y, t, moved, zone, z);
    this.nHalo = 0; this.nPool = 0;
    this.syncScenery(run, z); this.syncEntities(run, x, z); this.syncBlobs(run, x, y); this.syncParticles(vdt, z); this.syncStreaks(z, baseSpeed); this.syncLights(y);
    this.moveCamera(vdt, run, x, y, t, baseSpeed);
    this.r.render(this.scene, this.cam);
  }
  // машина на подвеске: кузов отстаёт от колёс, кренится на перестроении и приседает на приземлении
  driveTruck(dt, run, x, y, t, moved, zone, z) {
    const info = this.truckInfo, rig = this.rig, P = this.bodyPivot, air = y > 0, duck = run.duck > 0, crashed = run.done && !run.completed;
    rig.position.set(x, y + 0.02, 0);
    const vx = run.done ? 0 : run.vx, dvx = vx - this.prevVx; this.prevVx = vx;
    this.roll.v += dvx * (0.055 + this.weight * 0.012);
    const K = Math.max(0.68, 1 - this.weight * 0.14), n = Math.max(1, Math.ceil(dt / 0.012)), h = dt / n;
    for (let i = 0; i < n; i++) {
      spring(this.roll, crashed ? 0.05 : 0, 170 * K, 13, h);
      spring(this.heave, air ? 0.11 : crashed ? -0.06 : 0, 280 * K, 19, h);
      spring(this.pitch, air ? clamp(run.vy * 0.016, -0.2, 0.2) : crashed ? -0.05 : 0, 190 * K, 15, h);
      spring(this.squash, duck ? this.duckScale : 1, 340, 26, h);
      spring(this.kick, 0, 110, 11, h);
    }
    const sp = Math.max(8, this.speedNow);
    this.yaw += (-Math.atan(vx / sp) * 0.24 - this.yaw) * damp(dt, 16);
    this.steer += (clamp(-vx * 0.022, -0.42, 0.42) - this.steer) * damp(dt, 20);
    // дрожь от дороги зависит от скорости; пока машина стоит, чуть дрожит только от мотора
    const road = this.calm ? 0 : moved > 0 ? (Math.sin(t * 31) * 0.009 + Math.sin(t * 47 + 1) * 0.006) * Math.min(1, this.speedNow / 14) : Math.sin(t * 52) * 0.004;
    P.position.y = this.heave.x + road;
    P.rotation.set(this.pitch.x + road * 0.25, this.yaw, this.roll.x);
    P.scale.set(1 + (1 - this.squash.x) * 0.22, this.squash.x, 1);
    const wheels = this.wheels; for (let i = 0; i < wheels.length; i++) { const w = wheels[i]; w.rotation.x -= moved / Math.max(0.3, w.scale.x); w.rotation.y = (i < 2 ? this.steer : 0) + this.yaw * 0.6; }
    if (info) { this.driver.position.y = info.driver[1] + Math.sin(t * 9) * 0.012; this.driver.rotation.z = this.roll.x * 1.6; this.driver.rotation.y = 0.5 + Math.sin(t * 1.3) * 0.25; this.driver.rotation.x = air ? -0.3 : 0; }
    rig.visible = !(run.invuln > 0 && !run.done && Math.floor(t * 9) % 2 === 0);
    this.bubble.visible = run.power.shield > 0; this.bubble.material.opacity = (run.power.shield < 1.5 && Math.floor(t * 8) % 2 ? 0.35 : 0.85) + Math.sin(t * 7) * 0.1;
    if (!dt) return;
    const rear = z - (info ? info.length * 0.48 : 2);
    // пыль из-под колёс и выхлоп
    if (!air && !run.done && moved > 0 && Math.random() < dt * this.speedNow * 0.3) this.burst(x + (Math.random() > 0.5 ? 0.85 : -0.85), 0.2, rear, THEMES[zone].dust, 1, 0.7, 0.6, { soft: true, carry: 0.55, life: 0.38, grav: -0.8 });
    if (!run.done && Math.random() < dt * 5) this.burst(x + 0.55, 0.4 + y, rear - 0.1, 0x71767d, 1, 0.5, 0.5, { soft: true, carry: moved > 0 ? 0.75 : 0, life: 0.5, grav: -1.6 });
    // после аварии из-под капота идёт дым
    if (this.smoke > 0) { this.smoke -= dt; if (Math.random() < dt * 26) this.burst(x + (Math.random() - 0.5), 1.5, z + 0.8, 0x3c4047, 1, 1, 1.5, { soft: true, life: 1.1, grav: -2.6 }); }
  }
  // камера догоняет машину с запаздыванием, на скорости обзор шире
  moveCamera(dt, run, x, y, t, baseSpeed) {
    this.camX += (x * this.follow - this.camX) * damp(dt, 7);
    this.camLift += (y - this.camLift) * damp(dt, 9);
    this.vxs += ((run.done ? 0 : run.vx) - this.vxs) * damp(dt, 10);
    const fov = this.fovBase + Math.min(14, Math.max(0, baseSpeed - 11) * 0.62); if (Math.abs(fov - this.cam.fov) > 0.02) { this.cam.fov += (fov - this.cam.fov) * damp(dt, 1.6); this.cam.updateProjectionMatrix(); this.tanH = Math.tan((this.cam.fov * Math.PI) / 360) * this.cam.aspect; }
    this.shake = Math.max(0, this.shake - dt * 2.4);
    const sh = this.calm ? 0 : this.shake * this.shake * 0.34, sx = (Math.sin(t * 61) + Math.sin(t * 37) * 0.6) * sh, sy = (Math.sin(t * 53 + 1) + Math.sin(t * 29) * 0.6) * sh;
    this.cam.position.set(this.camX + sx, this.camY * this.fit + this.camLift * 0.3 + sy, this.camDist + this.kick.x * 0.45);
    this.cam.lookAt(this.camX * 0.55, this.lookY + this.camLift * 0.25, this.lookZ);
    if (!this.calm) this.cam.rotateZ(-this.vxs * 0.0011);
    // небо сдвигается вместе с поворотом дороги
    this.skyU.uShift.value.set(clamp(this.bend.value.x * 30 + this.camX * 0.004, -0.07, 0.07), this.camLift * 0.0016);
  }
  // виден ли объект в кадре с учётом изгиба: всё лишнее не отправляем на видеокарту
  inView(x, dz, r) {
    const d = dz + this.camDist;
    return d < -8 ? false : Math.abs(x - this.camX + this.bend.value.x * d * d) < Math.max(0, d) * this.tanH * 1.08 + r;
  }
  addHalo(x, y, vz, size, color, k) {
    if (this.nHalo >= 56) return;
    const d = this.dummy, m = this.haloMesh; d.position.set(x, y, vz); d.rotation.set(0, 0, 0); d.scale.set(size, size, 1); d.updateMatrix();
    m.setMatrixAt(this.nHalo, d.matrix); m.setColorAt(this.nHalo++, this.color.set(color).multiplyScalar(k));
  }
  addPool(x, vz, sx, sz, color, k) {
    if (this.nPool >= 32) return;
    const d = this.dummy, m = this.poolMesh; d.position.set(x, 0.13, vz); d.rotation.set(0, 0, 0); d.scale.set(sx, 1, sz); d.updateMatrix();
    m.setMatrixAt(this.nPool, d.matrix); m.setColorAt(this.nPool++, this.color.set(color).multiplyScalar(k));
  }
  syncLights(y) {
    const k = this.glowK, info = this.truckInfo;
    if (k > 0.03 && info?.halos && this.rig.visible) for (const h of info.halos) this.addHalo(this.rig.position.x + h.x, y + h.y + this.heave.x, h.z, h.size, h.c, k * 0.8);
    const H = this.haloMesh, Pm = this.poolMesh;
    H.count = this.nHalo; H.visible = this.nHalo > 0; H.instanceMatrix.needsUpdate = true; if (H.instanceColor) H.instanceColor.needsUpdate = true;
    Pm.count = this.nPool; Pm.visible = this.nPool > 0; Pm.instanceMatrix.needsUpdate = true; if (Pm.instanceColor) Pm.instanceColor.needsUpdate = true;
  }
  syncScenery(run, z) {
    const c = run.course, q = QUALITY[this.tier], k = q.fx ? this.glowK : 0;
    for (const s of this.slots) {
      const span = s.row === 'near' ? 18 * 13 : 10 * 24;
      if (!s.set || s.z - z < -24) {
        if (s.set) s.z += span;
        while (s.z - z < -24) s.z += span;
        this.placeSlot(s, c.zoneAt(s.z));
      }
      const dz = s.z - z, near = s.row === 'near';
      s.mesh.position.z = -dz;
      const vis = dz > -14 && this.inView(s.x, dz, near ? 5 : 22) && !(this.tier >= 2 && !near && dz > 150);
      s.mesh.visible = vis;
      s.mesh.castShadow = vis && q.shadows && near && dz < 52;
      if (vis && k > 0.03 && s.k.halos) {
        const fade = 1 - (Math.max(0, dz) / RANGE) ** 2;
        for (const h of s.k.halos) this.addHalo(s.x + h.x, h.y, -dz + h.z, h.size, h.c, k * fade);
        if (dz < 120 && s.k.pools) for (const p of s.k.pools) this.addPool(s.x + p.x, -dz + p.z, p.sx, p.sz, p.c, k * fade * 0.42);
      }
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
  syncEntities(run, tx, z) {
    const T = this.T, d = this.dummy, t = this.time, q = QUALITY[this.tier], k = q.fx ? this.glowK : 0;
    for (const key in this.obPool) this.obPool[key].used = 0;
    for (const key in this.itemPool) this.itemPool[key].used = 0;
    const blobs = this._b; blobs.length = 0;
    // препятствия
    const obs = run.course.obstacles;
    for (let i = run.iOb; i < obs.length; i++) {
      const o = obs[i], vz = run.visualZ(o, z);
      if (o.z - z > RANGE) break;
      if (o.gone || vz - z > RANGE) continue;
      const key = obKey(o), vp = -(vz - z);
      const mesh = this.pooled(this.obPool, key, () => this.group(this.obGeo[key] || (this.obGeo[key] = obstacleGeo(T, key))));
      mesh.position.set(o.x, 0, vp);
      mesh.castShadow = q.shadows && vp > -52 && vp < 15;
      // препятствия подлиннее растягиваются вперёд (встречные — только машины, их не растягиваем)
      mesh.scale.z = o.kind === 'full' ? o.len / 3 : 1;
      if (o.kind === 'moving') mesh.position.y = Math.abs(Math.sin(t * 13 + i)) * 0.03;
      if (o.kind !== 'gate') blobs.push(o.x, vp - (o.len || 1) / 2, 1.5, Math.max(1.4, (o.len || 1) * 0.72));
      if (k > 0.03) {
        const fade = 1 - (Math.min(RANGE, vz - z) / RANGE) ** 2;
        if (o.kind === 'moving') { for (const s of [-1, 1]) this.addHalo(o.x + s * 0.66, 0.84, vp + 0.15, 2.3, LIGHT, k * fade); this.addPool(o.x, vp + 8, 4, 16, LIGHT, k * fade * 0.34); }
        else if (key === 'gate0') this.addHalo(o.x - 1.22, 2.42, vp - 0.25, 1.5, RED, k * fade);
      }
    }
    for (const key in this.obPool) { const p = this.obPool[key]; for (let i = p.used; i < p.list.length; i++) p.list[i].visible = false; }
    // предметы
    const items = run.course.items; let nc = 0;
    for (let i = run.iIt; i < items.length; i++) {
      const it = items[i];
      if (it.z - z > RANGE) break;
      if (it.got) continue;
      let dz = it.z - z, x = it.x, y = it.y;
      if (it.pulled) { const f = Math.max(0, Math.min(1, dz / 16)); x = tx + (it.x - tx) * f; y = 1.2 + (it.y - 1.2) * f; }
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
    for (const key in this.itemPool) { const p = this.itemPool[key]; for (let i = p.used; i < p.list.length; i++) p.list[i].visible = false; }
  }
  syncBlobs(run, x, y) {
    const d = this.dummy, b = this._b; let n = 0;
    const h = Math.max(0.5, 1 - y * 0.14), info = this.truckInfo;
    d.position.set(x, 0.11, info ? info.length * 0.28 : 0); d.rotation.set(0, 0, 0); d.scale.set(1.5 * h, 1, (info ? Math.max(2.3, info.length * 0.68) : 2.5) * h); d.updateMatrix(); this.blobs.setMatrixAt(n++, d.matrix);
    for (let i = 0; i + 3 < b.length && n < 60; i += 4) { d.position.set(b[i], 0.1, b[i + 1]); d.scale.set(b[i + 2], 1, b[i + 3]); d.updateMatrix(); this.blobs.setMatrixAt(n++, d.matrix); }
    this.blobs.count = n; this.blobs.instanceMatrix.needsUpdate = true;
  }
  syncParticles(dt, z) {
    const d = this.dummy, hard = this.partMesh, soft = this.softMesh; let nh = 0, ns = 0;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]; p.life -= dt;
      if (p.life <= 0) { this.parts[i] = this.parts[this.parts.length - 1]; this.parts.pop(); continue; }
      p.vy -= p.grav * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.wz += p.vz * dt; p.a += p.spin * dt;
      if (p.y < 0.08) { p.y = 0.08; if (p.bounce) { p.vy = Math.abs(p.vy) * p.bounce; p.vx *= 0.7; p.vz *= 0.82; p.spin *= 0.6; } else p.vy = 0; }
      if (p.soft) { p.vx *= 1 - dt * 2; p.vz *= 1 - dt * 1.2; }
      const f = Math.min(1, p.life / (p.max * 0.35));
      const vz = -(p.wz - z); d.position.set(p.x, p.y, vz);
      if (p.soft) {
        if (ns >= 70) continue;
        d.rotation.set(0, 0, p.a * 0.2); const g = p.s * (1.5 - p.life / p.max * 0.8); d.scale.set(g, g, 1); d.updateMatrix();
        this.softFade.setX(ns, f * clamp((this.camDist - 2 - vz) / 5, 0, 1));
        soft.setMatrixAt(ns, d.matrix); soft.setColorAt(ns++, this.color.set(p.c));
      } else {
        if (nh >= 110) continue;
        d.rotation.set(p.a, p.a * 0.7, 0); d.scale.setScalar(p.s * Math.min(1, f * 1.4)); d.updateMatrix();
        hard.setMatrixAt(nh, d.matrix); hard.setColorAt(nh++, this.color.set(p.c));
      }
    }
    this.softFade.needsUpdate = ns > 0;
    hard.count = nh; hard.visible = nh > 0; hard.instanceMatrix.needsUpdate = true; hard.instanceColor.needsUpdate = true;
    soft.count = ns; soft.visible = ns > 0; soft.instanceMatrix.needsUpdate = true; soft.instanceColor.needsUpdate = true;
  }
  // тонкие штрихи по краям на большой скорости
  syncStreaks(z, speed) {
    const m = this.streaks, on = QUALITY[this.tier].fx ? clamp((speed - 17) / 11, 0, 1) : 0; if (!on) { m.visible = false; return; }
    const d = this.dummy; m.visible = true; let n = 0;
    for (const s of this.streakPts) {
      if (s.z - z < -10) s.z = z + 70 + Math.random() * 30;
      d.position.set(s.x, s.y, -(s.z - z)); d.rotation.set(0, 0, 0); d.scale.set(0.035, 0.035, 1 + speed * 0.2 * on); d.updateMatrix();
      m.setMatrixAt(n++, d.matrix);
    }
    m.count = n; m.instanceMatrix.needsUpdate = true;
  }
  setQuality(n) {
    const q = QUALITY[n]; this.tier = n;
    const px = Math.min(window.devicePixelRatio || 1, q.dpr);
    if (px !== this.pixel) { this.pixel = px; this.r.setPixelRatio(px); this.resize(); }
    this.sun.castShadow = q.shadows; this.road.receiveShadow = q.shadows; for (const s of this.sides) s.receiveShadow = q.shadows;
    this.blobs.material.opacity = q.shadows ? 0.62 : 1;
    this.fps.skip = 8;
  }
  // слабый телефон: снижаем качество сразу по ступеням, чтобы не терять частоту кадров
  adapt(real) {
    const f = this.fps; if (real > 0.25 || !real) return;
    if (f.skip > 0) { f.skip--; return; }
    f.n++; f.t += real;
    if (f.t < 1.1) return;
    const v = f.n / f.t; f.n = 0; f.t = 0; this.lastFps = v;
    if (this.tier < QUALITY.length - 1 && v < QUALITY[this.tier].below) this.setQuality(this.tier + 1);
  }
  resize() {
    const c = this.canvas, w = c.clientWidth || innerWidth, h = c.clientHeight || innerHeight, A = w / h;
    this.r.setSize(w, h, false); this.cam.aspect = A;
    // на широком экране мало высоты: обзор уже, камера смотрит круче вниз, чтобы машина целиком помещалась в кадр
    const k = clamp((A - 0.55) / 1.05, 0, 1); this.fit = 1 - k * 0.08; this.fovBase = 56 - k * 6; this.lookZ = -18 + k * 6; this.lookY = 1.2 - k * 0.2; this.follow = 0.68 - k * 0.13;
    this.tanH = Math.tan(((this.cam.fov + 6) * Math.PI) / 360) * A;
    this.cam.updateProjectionMatrix();
    if (Math.abs(A / (this.skyAspect || A) - 1) > 0.2) this.redrawSky(A);
    this.skyAspect = this.skyAspect && Math.abs(A / this.skyAspect - 1) <= 0.2 ? this.skyAspect : A;
  }
  redrawSky(A) {
    for (const z in this.themes) { const th = this.themes[z], old = th.sky; th.sky = skyTexture(this.T, THEMES[z], A); if (this.skyU.uA.value === old) this.skyU.uA.value = th.sky; if (this.skyU.uB.value === old) this.skyU.uB.value = th.sky; old.dispose(); }
  }
  // при смене размера канва очищается: рисуем сразу, иначе будет чёрная вспышка
  onResize() { this.resize(); if (this.skyU.uA.value && this.truckInfo && this.lastZ !== undefined) this.r.render(this.scene, this.cam); }
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
    const m = new Mesher(T); m.cyl(4.6, 4.8, 0.3, 0, -0.16, 0, 0x20252c, { seg: 48 }); m.cyl(4.72, 4.72, 0.04, 0, -0.01, 0, 0x2fd65c, { seg: 48 }); m.cyl(4.55, 4.55, 0.04, 0, 0, 0, 0x262b33, { seg: 48 });
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
