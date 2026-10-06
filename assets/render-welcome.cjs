// SPEED HELPER — приветственный ролик для бота: молния-логотип, из неё вылетают слова про работу и удобство.
// Рисует кадры на холсте и кодирует в MP4 (H.264, для Telegram) и GIF.
// Нужны: npm i @napi-rs/canvas ffmpeg-static (шрифты Segoe UI из Windows). Запуск: node render-welcome.cjs → папка out/
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const ffmpeg = require('ffmpeg-static');

GlobalFonts.registerFromPath('C:/Windows/Fonts/segoeuib.ttf', 'SH-Bold');
GlobalFonts.registerFromPath('C:/Windows/Fonts/segoeui.ttf', 'SH-Reg');
const W = 1280, H = 720, FPS = 30, T = 6.0, N = Math.round(FPS * T);
const G = '#39ff6a', BG = '#0b0c0e';
const CX = 640, CY = 250; // центр логотипа

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const eOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const eInCubic = (t) => t * t * t;
const eOutBack = (t) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const bez = (p0, c, p1, t) => ({ x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * c.x + t * t * p1.x, y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * c.y + t * t * p1.y });

// слова: [текст, x, y, цвет, размер, сторона дуги]
const WORDS = [
  ['Быстро', 'L', 100, G, 46, -1],
  ['Удобно', 'R', 100, '#ffffff', 46, 1],
  ['Смены на завтра', 'L', 240, '#ffffff', 40, -1],
  ['Рядом с тобой', 'R', 240, G, 40, 1],
  ['Без лишних шагов', 'L', 380, G, 38, -1],
  ['Надёжные подрядчики', 'R', 380, '#ffffff', 36, 1],
  ['Чат с командой', 'L', 565, '#ffffff', 30, -1],
  ['Рейтинг и отзывы', 'R', 565, '#ffcc33', 29, 1],
];
// x центра плашки: прижимаем к левому/правому краю с отступом
(() => { const m = createCanvas(10, 10).getContext('2d'); for (const w of WORDS) { m.font = `${w[4]}px SH-Bold`; const bw = m.measureText(w[0]).width + w[4] * 0.85 * 2; w[1] = w[1] === 'L' ? 36 + bw / 2 : W - 36 - bw / 2; } })();
const LAUNCH = [0.55, 0.85, 1.15, 1.45, 1.75, 2.05, 2.35, 2.65]; // моменты вылета
const FLY = 0.95;
const BACK = WORDS.map((_, i) => 4.55 + i * 0.055); // моменты возврата в логотип
const BACK_D = 0.42;
const pulses = [...LAUNCH, ...BACK.map((b) => b + BACK_D - 0.05)]; // вспышки логотипа

// детерминированные «искры» на фоне (периодичны по циклу — петля бесшовная)
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const PARTS = Array.from({ length: 46 }, () => ({ x: rnd() * W, y: rnd() * H, r: 1 + rnd() * 2.2, k: 1 + Math.floor(rnd() * 2), ph: rnd() * Math.PI * 2, a: 0.18 + rnd() * 0.4 }));

const BOLT = [[13, 2], [4, 14], [10, 14], [9, 22], [18, 10], [12, 10]];
function boltPath(ctx, cx, cy, s) {
  ctx.beginPath();
  BOLT.forEach(([x, y], i) => { const px = cx + (x - 11) * s, py = cy + (y - 12) * s; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.closePath();
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

function chip(ctx, text, x, y, size, color, scale, alpha, glow = 1) {
  if (alpha <= 0.01 || scale <= 0.01) return;
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale); ctx.globalAlpha = alpha;
  ctx.font = `${size}px SH-Bold`; const tw = ctx.measureText(text).width, ph = size * 0.62, pw = size * 0.85, w = tw + pw * 2, h = size + ph;
  ctx.shadowColor = color; ctx.shadowBlur = 26 * glow; roundRect(ctx, -w / 2, -h / 2, w, h, h / 2);
  ctx.fillStyle = 'rgba(14,18,22,.88)'; ctx.fill(); ctx.shadowBlur = 0;
  ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.globalAlpha = alpha * 0.85; ctx.stroke(); ctx.globalAlpha = alpha;
  ctx.fillStyle = color === '#ffffff' ? '#ffffff' : color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 0, size * 0.04);
  ctx.restore();
}

function wordState(i, t) {
  const [, rx, ry, , , side] = WORDS[i], P0 = { x: CX, y: CY }, P1 = { x: rx, y: ry };
  const mid = { x: (P0.x + P1.x) / 2, y: (P0.y + P1.y) / 2 }, dx = P1.x - P0.x, dy = P1.y - P0.y, len = Math.hypot(dx, dy) || 1;
  const C = { x: mid.x + (-dy / len) * 110 * side, y: mid.y + (dx / len) * 110 * side - 30 };
  const s = LAUNCH[i], b = BACK[i];
  if (t < s) return null;
  const float = { x: Math.sin(t * 2 * Math.PI / T * 2 + i) * 6, y: Math.cos(t * 2 * Math.PI / T * 3 + i * 1.7) * 7 };
  if (t < s + FLY) { // вылет
    const u = clamp((t - s) / FLY), q = eOutCubic(u), p = bez(P0, C, P1, q);
    return { x: p.x, y: p.y, scale: lerp(0.12, 1, eOutBack(u)), alpha: clamp(u * 5), u, q, trail: (j) => { const qq = eOutCubic(clamp(u - j * 0.035)); const pp = bez(P0, C, P1, qq); return { ...pp, scale: lerp(0.12, 1, eOutBack(clamp(u - j * 0.035))) }; }, flying: u < 0.82 };
  }
  if (t < b) return { x: rx + float.x, y: ry + float.y, scale: 1, alpha: 1, flying: false };
  const v = clamp((t - b) / BACK_D); // возврат
  if (v >= 1) return null;
  const q = 1 - eInCubic(v), p = bez(P0, C, P1, q);
  return { x: p.x, y: p.y, scale: lerp(1, 0.1, eInCubic(v)), alpha: 1 - v * v, flying: true, trail: (j) => { const qq = 1 - eInCubic(clamp(v - j * 0.04)); const pp = bez(P0, C, P1, qq); return { ...pp, scale: lerp(1, 0.1, eInCubic(clamp(v - j * 0.04))) }; }, v };
}

function frame(ctx, t) {
  // фон + дыхание свечения
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  const breathe = 0.045 * Math.sin(t / T * Math.PI * 2);
  const pulse = pulses.reduce((a, p) => a + (t > p ? Math.exp(-(t - p) * 6.5) : 0), 0);
  let g = ctx.createRadialGradient(CX, CY, 0, CX, CY, 620); g.addColorStop(0, `rgba(57,255,106,${0.2 + breathe + pulse * 0.1})`); g.addColorStop(0.45, 'rgba(57,255,106,.05)'); g.addColorStop(1, 'rgba(57,255,106,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // искры
  for (const p of PARTS) { const a = p.a * (0.6 + 0.4 * Math.sin(t / T * Math.PI * 2 * p.k + p.ph)); ctx.fillStyle = `rgba(57,255,106,${a})`; ctx.beginPath(); ctx.arc(p.x + Math.sin(t / T * Math.PI * 2 + p.ph) * 14, p.y + Math.cos(t / T * Math.PI * 2 * p.k + p.ph) * 10, p.r, 0, 7); ctx.fill(); }

  // кольца-импульсы от логотипа
  for (const p of pulses) { const d = t - p; if (d > 0 && d < 1.0) { ctx.strokeStyle = `rgba(57,255,106,${0.5 * (1 - d)})`; ctx.lineWidth = 3 * (1 - d) + 1; ctx.beginPath(); ctx.arc(CX, CY, 85 + d * 330, 0, 7); ctx.stroke(); } }

  // слова (под логотипом): шлейф + сам чип
  for (let i = 0; i < WORDS.length; i++) {
    const st = wordState(i, t); if (!st) continue; const [text, , , color, size] = WORDS[i];
    if (st.flying && st.trail) for (let j = 6; j >= 1; j--) { const tr = st.trail(j); chip(ctx, text, tr.x, tr.y, size, color, tr.scale, st.alpha * 0.1 * (1 - j / 7), 0.5); }
    chip(ctx, text, st.x, st.y, size, color, st.scale, st.alpha, st.flying ? 1.5 : 1);
  }

  // молния-логотип
  const sc = 1 + pulse * 0.1;
  ctx.save(); ctx.translate(CX, CY); ctx.scale(sc, sc); ctx.translate(-CX, -CY);
  // подложка-диск
  ctx.beginPath(); ctx.arc(CX, CY, 92, 0, 7); ctx.fillStyle = 'rgba(11,12,14,.78)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(57,255,106,.28)'; ctx.stroke();
  const glow = 30 + pulse * 40; ctx.shadowColor = G; ctx.shadowBlur = glow; ctx.fillStyle = G; boltPath(ctx, CX, CY, 8); ctx.fill(); ctx.shadowBlur = glow * 0.6; ctx.fill();
  ctx.shadowBlur = 0; ctx.restore();

  // название: буквы появляются по очереди, к концу гаснут
  const out = 1 - clamp((t - 5.35) / 0.45);
  const title = 'SPEED HELPER'; ctx.font = '58px SH-Bold'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const gap = 12, widths = [...title].map((c) => ctx.measureText(c).width), total = widths.reduce((a, b) => a + b, 0) + gap * (title.length - 1);
  let x = CX - total / 2; const ty = 505;
  [...title].forEach((c, i) => { const u = clamp((t - (0.95 + i * 0.05)) / 0.45); const e = eOutBack(u); ctx.globalAlpha = u * out; ctx.fillStyle = '#fff'; if (c !== ' ') ctx.fillText(c, x, ty + (1 - e) * 26); x += widths[i] + gap; });
  // подпись
  const tu = clamp((t - 2.2) / 0.7) * out; ctx.globalAlpha = tu; ctx.font = '29px SH-Reg'; ctx.fillStyle = '#c9cfd6'; ctx.textAlign = 'center';
  ctx.fillText('Работа на завтра. Найди смену за минуту.', CX, 566 + (1 - tu) * 10);
  // «Rodionov production»
  const ru = clamp((t - 3.0) / 0.8) * out; ctx.globalAlpha = ru * 0.9; ctx.font = '22px SH-Reg'; ctx.fillStyle = '#8b939e'; ctx.fillText('Rodionov production', CX, 692);
  ctx.globalAlpha = 1;
}

(async () => {
  const out = __dirname + '/out';
  fs.mkdirSync(out, { recursive: true });
  const cv = createCanvas(W, H), ctx = cv.getContext('2d');
  // стоп-кадры для проверки глазами
  for (const s of [0.9, 1.6, 2.6, 3.6, 4.9, 5.7]) { frame(ctx, s); fs.writeFileSync(`${out}/frame-${s}.png`, cv.toBuffer('image/png')); }
  // видео: кадры напрямую в ffmpeg
  const mp4 = `${out}/welcome.mp4`;
  const ff = spawn(ffmpeg, ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((r) => ff.on('close', r));
  for (let i = 0; i < N; i++) { frame(ctx, i / FPS); const ok = ff.stdin.write(cv.data()); if (!ok) await new Promise((r) => ff.stdin.once('drain', r)); }
  ff.stdin.end(); await done;
  console.log('mp4:', (fs.statSync(mp4).size / 1024).toFixed(0), 'КБ');
  // GIF 640x360 (для обложки бота в @BotFather и как запасной вариант)
  const gif = `${out}/welcome.gif`;
  const r = spawnSync(ffmpeg, ['-y', '-i', mp4, '-vf', 'fps=20,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', gif], { stdio: 'inherit' });
  console.log('gif:', (fs.statSync(gif).size / 1024).toFixed(0), 'КБ');
})();
