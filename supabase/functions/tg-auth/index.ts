// Edge Function: проверка Telegram initData на сервере и выдача сессии (JWT).
// Секреты (Supabase secrets): TG_BOT_TOKEN, JWT_SECRET (JWT secret проекта), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Во фронтенде их НЕТ.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const enc = new TextEncoder();
const hmac = async (key: ArrayBuffer | Uint8Array, data: string) => {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
};
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64u = (b: Uint8Array | string) => btoa(typeof b === 'string' ? b : String.fromCharCode(...b)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, apikey, authorization' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function verifyInitData(initData: string, botToken: string) {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const calc = hex(await hmac(secret, check));
  if (calc !== hash) return null;                                  // подпись не совпала — данные подделаны
  const age = Date.now() / 1000 - Number(p.get('auth_date'));
  if (!(age >= 0 && age < 24 * 3600)) return null;                 // защита от повторного использования старых данных
  return JSON.parse(p.get('user') || 'null');
}

async function signJwt(payload: Record<string, unknown>, secret: string) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b = b64u(JSON.stringify(payload));
  return `${h}.${b}.${b64u(await hmac(enc.encode(secret), `${h}.${b}`))}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { initData } = await req.json();
    const user = await verifyInitData(String(initData || ''), Deno.env.get('TG_BOT_TOKEN')!);
    if (!user?.id) return json({ error: 'Неверные данные Telegram', code: 'unauthorized' }, 401);
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    // один Telegram-пользователь = один аккаунт (unique tg_id, upsert — без дублей)
    const { data, error } = await db.from('users').upsert({ tg_id: user.id, first_name: user.first_name, username: user.username ?? null }, { onConflict: 'tg_id' }).select('id, blocked').single();
    if (error) throw error;
    if (data.blocked) return json({ error: 'Аккаунт заблокирован', code: 'blocked' }, 403);
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    const access_token = await signJwt({ role: 'authenticated', aud: 'authenticated', sub: String(data.id), exp }, Deno.env.get('JWT_SECRET')!);
    return json({ access_token, user_id: data.id, expires_at: exp });
  } catch (e) {
    console.error('tg-auth failed', e);
    return json({ error: 'Ошибка сервера', code: 'server' }, 500);
  }
});
