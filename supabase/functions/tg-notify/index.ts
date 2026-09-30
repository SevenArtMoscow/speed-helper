// Edge Function: рассылка уведомлений в Telegram через Bot API.
// Берёт непереданные записи из notifications и отправляет пользователю сообщение с кнопкой «Открыть».
// Запуск: по расписанию (pg_cron каждую минуту вызывает функцию с заголовком X-Cron-Secret) или Database Webhook на INSERT в notifications.
// Secrets: TG_BOT_TOKEN, APP_URL (адрес мини-приложения), CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('forbidden', { status: 403 });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const token = Deno.env.get('TG_BOT_TOKEN')!, app = Deno.env.get('APP_URL')!;
  const { data: rows, error } = await db.from('notifications').select('id, text, link, user_id, users!inner(tg_id, blocked)').eq('tg_sent', false).order('id').limit(50);
  if (error) { console.error('tg-notify select failed', error); return new Response('error', { status: 500 }); }
  let sent = 0, failed = 0;
  for (const n of rows ?? []) {
    const user = (n as any).users;
    if (!user.blocked) {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: user.tg_id, text: n.text, reply_markup: { inline_keyboard: [[{ text: 'Открыть SPEED HELPER', web_app: { url: app + (n.link || '') } }]] } }),
      });
      if (res.ok) sent++;
      else { failed++; console.error('telegram send failed', n.id, res.status, await res.text()); }
      // 403 = пользователь не запускал бота/заблокировал его — повторять бессмысленно, остальное (429/5xx) повторим позже
      if (!res.ok && res.status !== 403 && res.status !== 400) continue;
    }
    await db.from('notifications').update({ tg_sent: true }).eq('id', n.id);
    await new Promise((r) => setTimeout(r, 40)); // лимит Bot API ~30 сообщений/сек
  }
  return new Response(JSON.stringify({ sent, failed }), { headers: { 'Content-Type': 'application/json' } });
});
