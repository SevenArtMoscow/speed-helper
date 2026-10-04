// SPEED HELPER — собственный сервер (замена Supabase для хостинга на VPS).
//  - раздаёт статику мини-приложения;
//  - POST /api/auth  {initData} → проверка подписи Telegram, upsert users(tg_id), выдача JWT (sub = users.id);
//  - POST /api/rpc   {fn, args} + Bearer JWT → select public.api(fn, args) с request.jwt.claims (как в PostgREST);
//  - бот: /start с кнопкой мини-приложения и рассылка таблицы notifications (см. bot.js).
// Настройки — в server/.env (см. .env.example). Секреты во фронтенд не попадают.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from './env.js';
import { migrate } from './migrate.js';
import { startBot } from './bot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(ROOT, 'server', '.env'));
const env = process.env;
for (const k of ['DATABASE_URL', 'TG_BOT_TOKEN', 'JWT_SECRET']) if (!env[k]) { console.error(`Не задана переменная ${k}`); process.exit(1); }
const PORT = Number(env.PORT || 3000);
const ADMINS = (env.ADMIN_TG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.PG_POOL_MAX || 10) });
pool.on('error', (e) => console.error('pg idle client error', e.message)); // обрыв соединения не роняет сервер

// ---------- Telegram initData ----------
function verifyInitData(initData, botToken) {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null; // подделка
  const age = Date.now() / 1000 - Number(p.get('auth_date'));
  if (!(age >= 0 && age < 24 * 3600)) return null;                                                                    // старые данные
  return JSON.parse(p.get('user') || 'null');
}

// ---------- JWT (HS256) ----------
const b64u = (b) => Buffer.from(b).toString('base64url');
function signJwt(payload) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b = b64u(JSON.stringify(payload));
  return `${h}.${b}.${crypto.createHmac('sha256', env.JWT_SECRET).update(`${h}.${b}`).digest('base64url')}`;
}
function verifyJwt(token) {
  const [h, b, s] = String(token || '').split('.');
  if (!s) return null;
  const calc = crypto.createHmac('sha256', env.JWT_SECRET).update(`${h}.${b}`).digest('base64url');
  if (calc.length !== s.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(s))) return null;
  const p = JSON.parse(Buffer.from(b, 'base64url').toString());
  return p.exp > Date.now() / 1000 ? p : null;
}

// ---------- HTTP ----------
const json = (res, status, o) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
function readBody(req, limit = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(Object.assign(new Error('Неверный JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

async function auth(req, res) {
  const { initData } = await readBody(req);
  const user = verifyInitData(String(initData || ''), env.TG_BOT_TOKEN);
  if (!user?.id) return json(res, 401, { error: 'Неверные данные Telegram', code: 'unauthorized' });
  // один Telegram-пользователь = один аккаунт (unique tg_id); владельцы из ADMIN_TG_IDS получают права админа
  const { rows: [u] } = await pool.query(
    `insert into users(tg_id, first_name, username, is_admin) values ($1, $2, $3, $4)
     on conflict (tg_id) do update set first_name = excluded.first_name, username = excluded.username, is_admin = users.is_admin or excluded.is_admin
     returning id, blocked`, [user.id, user.first_name || null, user.username || null, ADMINS.includes(String(user.id))]);
  if (u.blocked) return json(res, 403, { error: 'Аккаунт заблокирован', code: 'blocked' });
  const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  json(res, 200, { access_token: signJwt({ sub: String(u.id), exp }), user_id: Number(u.id), expires_at: exp });
}

async function rpc(req, res) {
  const claims = verifyJwt((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!claims) return json(res, 401, { message: 'Сессия истекла, откройте приложение заново', hint: 'unauthorized' });
  const { fn, args } = await readBody(req);
  if (typeof fn !== 'string' || !/^[a-zA-Z]{1,40}$/.test(fn)) return json(res, 400, { message: 'Неизвестный метод', hint: 'invalid' });
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: claims.sub })]);
    const { rows } = await c.query('select public.api($1, $2::jsonb) as r', [fn, JSON.stringify(Array.isArray(args) ? args : [])]);
    await c.query('commit');
    json(res, 200, rows[0].r);
  } catch (e) {
    await c.query('rollback').catch(() => {});
    // P0001 — raise exception из _fail(): текст для пользователя, код ошибки в hint
    if (e.code === 'P0001' && e.hint) return json(res, e.hint === 'unauthorized' || e.hint === 'blocked' ? 401 : 400, { message: e.message, hint: e.hint });
    if (e.code === '23505') return json(res, 409, { message: 'Уже сделано', hint: 'conflict' });
    console.error('rpc failed', fn, e.message);
    json(res, 500, { message: 'Ошибка сервера', hint: 'server' });
  } finally { c.release(); }
}

// Статика: только файлы приложения (server/, supabase/, legacy/, .git — не раздаются)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const PUBLIC = /^\/(index\.html|manifest\.json|sw\.js|(css|js|icons)\/[\w.\-]+)$/;
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  if (!PUBLIC.test(p)) { p = '/index.html'; }
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const html = p.endsWith('.html') || p === '/sw.js';
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': html ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (url === '/api/health') { await pool.query('select 1'); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && url === '/api/auth') return await auth(req, res);
    if (req.method === 'POST' && url === '/api/rpc') return await rpc(req, res);
    if (url.startsWith('/api/')) return json(res, 404, { message: 'Not found', hint: 'invalid' });
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    json(res, 405, { message: 'Method not allowed' });
  } catch (e) {
    console.error('request failed', req.url, e);
    if (!res.headersSent) json(res, e.status || 500, { message: e.status ? e.message : 'Ошибка сервера', hint: e.status ? 'invalid' : 'server' });
  }
});

await migrate(pool, [path.join(ROOT, 'server', 'migrations'), path.join(ROOT, 'supabase', 'migrations')]);
server.listen(PORT, '127.0.0.1', () => console.log(`SPEED HELPER слушает 127.0.0.1:${PORT}`));
startBot({ pool, token: env.TG_BOT_TOKEN, appUrl: env.APP_URL });
