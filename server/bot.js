// Telegram-бот SPEED HELPER (long polling — вебхук и отдельный порт не нужны).
//  - /start, /app — приветствие и кнопка открытия мини-приложения; кнопка меню чата тоже открывает приложение;
//  - рассылка: непереданные записи notifications → sendMessage с кнопкой «Открыть» (бывший tg-notify).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startBot({ pool, token, appUrl }) {
  const tg = async (method, body) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await res.json().catch(() => ({ ok: false, description: 'bad json' }));
    if (!j.ok) throw Object.assign(new Error(`${method}: ${j.description}`), { status: res.status, retryAfter: j.parameters?.retry_after });
    return j.result;
  };
  // Ссылка на экран передаётся через ?r=, а не #: в hash Telegram кладёт данные запуска (tgWebAppData)
  const openBtn = (text, link = '') => ({ inline_keyboard: [[{ text, web_app: { url: appUrl + (link ? '/?r=' + encodeURIComponent(link.replace(/^#/, '')) : '') } }]] });

  async function setup() {
    await tg('deleteWebhook', {});
    await tg('setMyCommands', { commands: [{ command: 'start', description: 'Открыть SPEED HELPER' }, { command: 'help', description: 'Как это работает' }] });
    if (appUrl) await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: appUrl } } });
    await tg('setMyDescription', { description: 'SPEED HELPER — краткосрочные смены и исполнители. Найди работу на завтра или людей на смену за минуту.' }).catch(() => {});
  }

  async function onMessage(m) {
    const text = (m.text || '').trim();
    if (m.chat.type !== 'private') return;
    if (/^\/(start|app)\b/.test(text)) {
      return tg('sendMessage', { chat_id: m.chat.id, text: `Привет, ${m.from.first_name || 'друг'}! 👋\n\nSPEED HELPER — смены на завтра и исполнители за минуту.\n• Исполнителям: свайпайте смены, откликайтесь, получайте подтверждение.\n• Подрядчикам: публикуйте смену и собирайте команду.\n\nУведомления об откликах и сменах будут приходить сюда.`, reply_markup: openBtn('🚀 Открыть SPEED HELPER') });
    }
    if (/^\/help\b/.test(text)) {
      return tg('sendMessage', { chat_id: m.chat.id, text: 'Нажмите кнопку «Открыть» внизу чата или кнопку ниже. В приложении выберите роль — исполнитель или подрядчик — и заполните анкету. По вопросам и жалобам используйте кнопку «Пожаловаться» в приложении.', reply_markup: openBtn('Открыть SPEED HELPER') });
    }
    return tg('sendMessage', { chat_id: m.chat.id, text: 'Всё самое интересное — в приложении 👇', reply_markup: openBtn('Открыть SPEED HELPER') });
  }

  async function poll() {
    let offset = 0;
    for (;;) {
      try {
        const ups = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of ups) {
          offset = u.update_id + 1;
          if (u.message) onMessage(u.message).catch((e) => console.error('bot reply failed', e.message));
        }
      } catch (e) { console.error('getUpdates failed', e.message); await sleep(5000); }
    }
  }

  async function notifyLoop() {
    for (;;) {
      try {
        const { rows } = await pool.query(`select n.id, n.text, n.link, u.tg_id, u.blocked from notifications n join users u on u.id = n.user_id
          where not n.tg_sent and n.created_at > now() - interval '1 day' order by n.id limit 50`);
        for (const n of rows) {
          if (!n.blocked) {
            try {
              await tg('sendMessage', { chat_id: n.tg_id, text: n.text, reply_markup: openBtn('Открыть SPEED HELPER', n.link || '') });
            } catch (e) {
              // 400/403 — пользователь не запускал бота или заблокировал его: повторять бессмысленно; 429/5xx — повторим позже
              if (e.status !== 400 && e.status !== 403) { console.error('notify failed', n.id, e.message); if (e.retryAfter) await sleep(e.retryAfter * 1000); break; }
            }
          }
          await pool.query('update notifications set tg_sent = true where id = $1', [n.id]);
          await sleep(40); // лимит Bot API ~30 сообщений/сек
        }
        // старые неотправленные (например, после простоя) не шлём пачкой
        await pool.query(`update notifications set tg_sent = true where not tg_sent and created_at <= now() - interval '1 day'`);
      } catch (e) { console.error('notify loop failed', e.message); }
      await sleep(3000);
    }
  }

  setup().catch((e) => console.error('bot setup failed', e.message));
  poll();
  notifyLoop();
}
