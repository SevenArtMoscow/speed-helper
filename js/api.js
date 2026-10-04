// Единая точка доступа к бэкенду. Экраны вызывают только api.<метод>(...).
//  - режим 'supabase': все вызовы идут через серверную функцию public.api(fn, args) (SECURITY DEFINER),
//    клиент напрямую в таблицы не пишет; личность берётся из JWT, выданного tg-auth после проверки initData.
//  - режим 'server': то же самое через собственный сервер (server/server.js): POST /api/auth и /api/rpc.
//  - режим 'local': localStorage-движок с теми же правилами (для разработки).
import { CONFIG } from './config.js';
import { localCall, localUsers } from './local-backend.js';

const forceLocal = new URLSearchParams(location.search).has('local') || location.port === '8765' || location.protocol === 'file:';
export const MODE = forceLocal ? 'local' : CONFIG.SUPABASE_URL ? 'supabase' : CONFIG.API_BASE ? 'server' : 'local';
const AUTH_URL = MODE === 'server' ? `${CONFIG.API_BASE}/auth` : `${CONFIG.SUPABASE_URL}/functions/v1/${CONFIG.AUTH_FUNCTION}`;
const RPC_URL = MODE === 'server' ? `${CONFIG.API_BASE}/rpc` : `${CONFIG.SUPABASE_URL}/rest/v1/rpc/api`;
export const tg = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData !== undefined ? window.Telegram.WebApp : null;

let session = { me: null, token: null, tgUser: null };
export const getSession = () => session;
export const setDevUser = (tgId) => { sessionStorage.setItem('sh_dev_tg', String(tgId)); location.reload(); };
export const devUsers = localUsers;

function tgIdentity() {
  const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  if (u && u.id) return { tg_id: u.id, first_name: u.first_name, username: u.username };
  const q = new URLSearchParams(location.search).get('u');
  if (q) sessionStorage.setItem('sh_dev_tg', q);
  const id = Number(sessionStorage.getItem('sh_dev_tg') || 1001);
  return { tg_id: id, first_name: id === 1 ? 'Админ' : 'Тест ' + id, username: null };
}

export async function login() {
  const ident = tgIdentity();
  session.tgUser = ident;
  if (MODE === 'local') {
    const u = await localCall('login', null, [ident]);
    session.me = u.id; return u;
  }
  const res = await fetch(AUTH_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_ANON_KEY },
    body: JSON.stringify({ initData: tg ? tg.initData : '' }),
  });
  const j = await res.json();
  if (!res.ok) throw Object.assign(new Error(j.error || (tg ? 'Не удалось войти' : 'Откройте приложение через Telegram-бота')), { code: j.code || 'unauthorized' });
  session.token = j.access_token; session.me = j.user_id;
  return call('me', []);
}

async function call(fn, args) {
  try {
    if (MODE === 'local') return await localCall(fn, session.me, args);
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + session.token },
      body: JSON.stringify({ fn, args }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(j.message || 'Ошибка сервера'), { code: j.hint || j.code || 'server', status: res.status });
    return j;
  } catch (e) {
    if (!['invalid', 'forbidden', 'closed', 'conflict', 'full', 'profile_required', 'own_shift'].includes(e.code) && fn !== 'logError') {
      // техническая ошибка — пишем в журнал: кто, где, в какой версии
      call('logError', [{ fn, message: e.message, code: e.code || null, screen: location.hash, ua: navigator.userAgent.slice(0, 120) }]).catch(() => {});
    }
    throw e;
  }
}

export const api = new Proxy({}, { get: (_, fn) => (...args) => call(fn, args) });
export const track = (event, props) => { if (session.me) call('track', [event, props]).catch(() => {}); };
