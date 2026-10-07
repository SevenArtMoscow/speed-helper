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
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(ROOT, 'server', '.env'));
const env = process.env;
for (const k of ['DATABASE_URL', 'TG_BOT_TOKEN', 'JWT_SECRET']) if (!env[k]) { console.error(`Не задана переменная ${k}`); process.exit(1); }
const PORT = Number(env.PORT || 3000);
const ADMINS = (env.ADMIN_TG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const VERSION = (() => { try { return fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').startsWith('ref:') ? fs.readFileSync(path.join(ROOT, '.git', fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').slice(5).trim()), 'utf8').slice(0, 7) : 'dev'; } catch { return 'dev'; } })();

// ---------- ограничение частоты запросов (скользящее окно, в памяти процесса) ----------
const hits = new Map();
const RATE_MULT = Number(env.RATE_MULT || 1); // множитель лимитов (в автотестах увеличивается)
function limited(key, max, windowMs) {
  max = Math.ceil(max * RATE_MULT);
  const now = Date.now(); let a = hits.get(key); if (!a) { a = []; hits.set(key, a); }
  while (a.length && a[0] <= now - windowMs) a.shift();
  if (a.length >= max) return true; a.push(now); return false;
}
setInterval(() => { const t = Date.now() - 3600e3; for (const [k, a] of hits) if (!a.length || a[a.length - 1] < t) hits.delete(k); }, 60e3).unref();
// запросы за nginx: реальный адрес приходит в X-Real-IP (порт 3000 наружу закрыт и слушает только 127.0.0.1)
const clientIp = (req) => String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
// дополнительные лимиты на «дорогие» и спам-опасные методы: [запросов, окно в мс]
const FN_LIMITS = { sendMessage: [40, 60e3], createShift: [15, 3600e3], apply: [150, 3600e3], report: [10, 3600e3], saveWorker: [30, 3600e3], saveContractor: [30, 3600e3], logError: [30, 60e3], deleteAccount: [3, 3600e3] };
const RATE_MSG = { message: 'Слишком много действий подряд — подождите минуту и повторите', hint: 'rate' };

// «Сегодня/завтра» и проверка даты смены — по московскому времени, а не по UTC сервера (параметр соединения)
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.PG_POOL_MAX || 10), options: `-c timezone=${(env.TZ_DB || 'Europe/Moscow').replace(/[^\w/+-]/g, '')}` });
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
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), payment=()', 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups' };
// CSP: скрипты только свои, Telegram и CDN карты; карта (OpenFreeMap) и подсказки адресов (DaData) — по списку; встраивать приложение можно только в Telegram
const CSP = ["default-src 'self'", "script-src 'self' https://telegram.org https://cdn.jsdelivr.net", "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net", "img-src 'self' data: blob: https://tiles.openfreemap.org",
  "font-src 'self' data:", "connect-src 'self' https://tiles.openfreemap.org https://suggestions.dadata.ru", "worker-src 'self' blob:", "child-src blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  'frame-ancestors https://web.telegram.org https://*.telegram.org https://telegram.org'].join('; ');
const json = (res, status, o) => { res.writeHead(status, { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
function readBody(req, limit = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(Object.assign(new Error('Неверный JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

async function auth(req, res) {
  if (limited('auth:' + clientIp(req), 40, 60e3)) return json(res, 429, RATE_MSG);
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
  if (limited('rpc:' + claims.sub, 400, 60e3)) return json(res, 429, RATE_MSG);
  const { fn, args } = await readBody(req);
  if (typeof fn !== 'string' || !/^[a-zA-Z]{1,40}$/.test(fn)) return json(res, 400, { message: 'Неизвестный метод', hint: 'invalid' });
  const fl = FN_LIMITS[fn]; if (fl && limited(`fn:${fn}:${claims.sub}`, fl[0], fl[1])) return json(res, 429, RATE_MSG);
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
    // 22xxx — неверный формат/длина значения, 23514 — нарушено ограничение (например, слишком длинный текст)
    if (/^22/.test(e.code || '') || e.code === '23514') return json(res, 400, { message: 'Некорректные данные: проверьте длину и формат полей', hint: 'invalid' });
    console.error('rpc failed', fn, e.message);
    json(res, 500, { message: 'Ошибка сервера', hint: 'server' });
  } finally { c.release(); }
}

// Статика: только файлы приложения (server/, supabase/, legacy/, .git — не раздаются)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const PUBLIC = /^\/(index\.html|manifest\.json|sw\.js|(css|js|icons|legal)\/[\w.\-]+)$/;
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  if (!PUBLIC.test(p)) { p = '/index.html'; }
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, SEC); return res.end('Not found'); }
    // код приложения (html/js/css) — всегда свежий: модули без версий в URL, иначе после обновления смешаются старые и новые файлы
    const code = /\.(html|js|css)$/.test(p);
    const html = p.endsWith('.html');
    // реквизиты оператора подставляются в юридические страницы из настроек сервера
    if (p.startsWith('/legal/')) data = Buffer.from(data.toString().replace(/\{\{OPERATOR\}\}/g, esc(env.OPERATOR_NAME || '[укажите оператора: OPERATOR_NAME в server/.env]')).replace(/\{\{CONTACT\}\}/g, esc(env.OPERATOR_CONTACT || '[укажите контакт: OPERATOR_CONTACT в server/.env]')).replace(/\{\{DOMAIN\}\}/g, esc(new URL(env.APP_URL || 'https://localhost').host)));
    res.writeHead(200, { ...SEC, ...(html ? { 'Content-Security-Policy': CSP } : {}), 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': code ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (url === '/api/health') { await pool.query('select 1'); return json(res, 200, { ok: true }); }
    if (url === '/api/config') return json(res, 200, { support_url: env.SUPPORT_URL || '', prizes: env.PRIZES_TEXT || '', version: VERSION });
    if (req.method === 'POST' && url === '/api/auth') return await auth(req, res);
    if (req.method === 'POST' && url === '/api/rpc') return await rpc(req, res);
    if (url.startsWith('/api/') && req.method !== 'POST' && req.method !== 'GET') return json(res, 405, { message: 'Method not allowed', hint: 'invalid' });
    if (url.startsWith('/api/')) return json(res, 404, { message: 'Not found', hint: 'invalid' });
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    json(res, 405, { message: 'Method not allowed' });
  } catch (e) {
    console.error('request failed', req.url, e);
    if (!res.headersSent) json(res, e.status || 500, { message: e.status ? e.message : 'Ошибка сервера', hint: e.status ? 'invalid' : 'server' });
  }
});

server.requestTimeout = 30e3; server.headersTimeout = 15e3; server.keepAliveTimeout = 65e3;

await migrate(pool, [path.join(ROOT, 'server', 'migrations'), path.join(ROOT, 'supabase', 'migrations')]);
server.listen(PORT, '127.0.0.1', () => console.log(`SPEED HELPER слушает 127.0.0.1:${PORT}`));
const bot = env.DISABLE_BOT === '1' ? { alert: async () => {} } : startBot({ pool, token: env.TG_BOT_TOKEN, appUrl: env.APP_URL, admins: ADMINS });

// оповещения админам в Telegram; не чаще раза в 10 минут на один вид события (защита от лавины при перезапусках)
const alertFile = (k) => path.join(os.tmpdir(), 'speedhelper-alert-' + k);
async function alertAdmins(kind, text) {
  try { const f = alertFile(kind); if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 600e3) return; fs.writeFileSync(f, String(Date.now())); await bot.alert(text); } catch (e) { console.error('alert failed', e.message); }
}
if (env.NODE_ENV === 'production') alertAdmins('start', `🔄 SPEED HELPER запущен (версия ${VERSION})`);

// очистка старых событий/ключей/уведомлений: через минуту после старта и раз в 6 часов
const maintain = () => pool.query('select maintenance() as r').then((r) => console.log('обслуживание БД:', JSON.stringify(r.rows[0].r))).catch((e) => console.error('maintenance failed', e.message));
setTimeout(maintain, 60e3).unref(); setInterval(maintain, 6 * 3600e3).unref();

// мягкая остановка (systemctl restart): дорабатываем текущие запросы
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  if (stopping) return; stopping = true; console.log('останавливаюсь…');
  server.close(); setTimeout(() => process.exit(0), 8000).unref();
  pool.end().finally(() => process.exit(0));
});
process.on('unhandledRejection', (e) => { console.error('unhandledRejection', e); alertAdmins('rejection', '⚠️ SPEED HELPER: необработанная ошибка (unhandledRejection). Подробности: journalctl -u speedhelper'); });
process.on('uncaughtException', async (e) => { console.error('uncaughtException', e); await alertAdmins('crash', '🛑 SPEED HELPER упал с ошибкой и будет перезапущен. Подробности: journalctl -u speedhelper'); process.exit(1); });
