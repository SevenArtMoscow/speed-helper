// Telegram-бот SPEED HELPER (long polling — вебхук и отдельный порт не нужны).
//  - /start, /app — приветствие и кнопка открытия мини-приложения; кнопка меню чата тоже открывает приложение;
//  - рассылка: непереданные записи notifications → sendMessage с кнопкой «Открыть» (бывший tg-notify).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WELCOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'welcome.mp4'); // приветственная анимация (assets/render-welcome.cjs)
const API = process.env.TG_API || 'https://api.telegram.org';

export function startBot({ pool, token, appUrl, admins = [] }) {
  // Сетевой сбой (DNS, обрыв) — пробуем ещё до 3 раз с паузой; ответ Telegram с ошибкой (есть status) повторять не нужно. getUpdates повторяет цикл опроса.
  const tg = async (method, body) => {
    for (let i = 1; ; i++) {
      try {
        const res = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        const j = await res.json().catch(() => ({ ok: false, description: 'bad json' }));
        if (!j.ok) throw Object.assign(new Error(`${method}: ${j.description}`), { status: res.status, retryAfter: j.parameters?.retry_after });
        return j.result;
      } catch (e) { if (e.status || i >= 3 || method === 'getUpdates') throw e; await sleep(600 * 3 ** (i - 1)); }
    }
  };
  // Ссылка на экран передаётся через ?r=, а не #: в hash Telegram кладёт данные запуска (tgWebAppData)
  const openBtn = (text, link = '') => ({ inline_keyboard: [[{ text, web_app: { url: appUrl + (link ? '/?r=' + encodeURIComponent(link.replace(/^#/, '')) : '') } }]] });

  // Приветствие с анимацией: первый раз файл загружается в Telegram, дальше отправляется по file_id (мгновенно).
  // file_id запоминается на диске, чтобы не загружать файл заново после каждого перезапуска сервиса.
  // У сервера бывают сетевые сбои до Telegram: загрузка повторяется, а запомненный file_id сбрасывается только
  // если Telegram сказал, что он не подходит (а не при обрыве сети). Если совсем не вышло — обычное сообщение.
  const ID_FILE = process.env.WELCOME_ID_FILE || path.join(path.dirname(WELCOME), '..', 'server', '.welcome-file-id');
  const fileSize = () => { try { return fs.statSync(WELCOME).size; } catch { return 0; } };
  let animId = null;
  try { const o = JSON.parse(fs.readFileSync(ID_FILE, 'utf8')); if (o.id && o.size === fileSize()) animId = o.id; } catch { /* ещё не загружали */ }
  const rememberId = (id) => { animId = id; try { id ? fs.writeFileSync(ID_FILE, JSON.stringify({ id, size: fileSize() })) : fs.rmSync(ID_FILE, { force: true }); } catch { /* только в памяти */ } };
  async function uploadWelcome(chatId, caption, markup) {
    for (let i = 1; ; i++) {
      try {
        const fd = new FormData();
        fd.append('chat_id', String(chatId)); fd.append('caption', caption); fd.append('reply_markup', JSON.stringify(markup));
        fd.append('width', '1280'); fd.append('height', '720'); fd.append('duration', '6');
        fd.append('animation', new Blob([fs.readFileSync(WELCOME)], { type: 'video/mp4' }), 'welcome.mp4');
        const res = await fetch(`${API}/bot${token}/sendAnimation`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
        const j = await res.json().catch(() => ({ ok: false, description: 'bad json' }));
        if (!j.ok) throw Object.assign(new Error(j.description), { status: res.status });
        rememberId((j.result.animation || j.result.document || {}).file_id || null);
        return j.result;
      } catch (e) { if (e.status || i >= 3) throw e; await sleep(700 * 2 ** (i - 1)); }  // обрыв сети — ещё попытка
    }
  }
  async function sendWelcome(chatId, caption, markup) {
    try {
      if (animId) {
        try { return await tg('sendAnimation', { chat_id: chatId, animation: animId, caption, reply_markup: markup, width: 1280, height: 720, duration: 6 }); }
        catch (e) { if (!e.status) throw e; rememberId(null); }   // Telegram не принял file_id — загрузим файл заново
      }
      if (!fs.existsSync(WELCOME)) throw new Error('нет файла ' + WELCOME);
      return await uploadWelcome(chatId, caption, markup);
    } catch (e) {
      console.error('welcome animation failed:', e.message, e.cause ? '(' + (e.cause.code || e.cause.message) + ')' : '');
      if (e.status) rememberId(null);                              // отказ Telegram — кэш недействителен; обрыв сети кэш не трогает
      return tg('sendMessage', { chat_id: chatId, text: caption, reply_markup: markup });
    }
  }

  let username = '';
  async function setup() {
    await tg('deleteWebhook', {});
    username = (await tg('getMe', {})).username || '';
    await tg('setMyCommands', { commands: [{ command: 'start', description: 'Открыть SPEED HELPER' }, { command: 'help', description: 'Как это работает' }, { command: 'privacy', description: 'Политика конфиденциальности' }] });
    if (appUrl) await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: appUrl } } });
    await tg('setMyDescription', { description: 'SPEED HELPER — краткосрочные смены и исполнители. Найди работу на завтра или людей на смену за минуту.' }).catch(() => {});
  }

  // Подтверждение номера: человек сам нажимает «Поделиться номером»; принимаем, только если контакт его собственный.
  const phoneKeyboard = { keyboard: [[{ text: 'Поделиться номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
  async function onContact(m) {
    const c = m.contact;
    if (!c || c.user_id !== m.from.id) {
      return tg('sendMessage', { chat_id: m.chat.id, text: 'Нужен именно ваш номер. Нажмите кнопку «Поделиться номером» внизу — не пересылайте чужой контакт.', reply_markup: phoneKeyboard });
    }
    const { rows } = await pool.query('select bot_verify_phone($1, $2) as r', [m.from.id, c.phone_number]);
    const r = rows[0] && rows[0].r;
    const say = (text, markup) => tg('sendMessage', { chat_id: m.chat.id, text, reply_markup: markup || { remove_keyboard: true } });
    if (r === 'ok') { await say('Номер подтверждён ✅ Теперь можно публиковать смены.'); return tg('sendMessage', { chat_id: m.chat.id, text: 'Вернитесь в приложение — экран обновится сам.', reply_markup: openBtn('Открыть SPEED HELPER') }); }
    if (r === 'taken') return say('Этот номер уже привязан к другому аккаунту. Один номер — один аккаунт. Если это ваш старый аккаунт, удалите его в приложении (Профиль → Удалить аккаунт) и подтвердите номер снова.');
    if (r === 'no_user') return say('Сначала откройте приложение и заполните профиль, затем подтвердите номер.', openBtn('Открыть SPEED HELPER'));
    if (r === 'foreign') return say('Пока принимаем только российские номера (+7).');
    return say('Не удалось прочитать номер. Попробуйте ещё раз.', phoneKeyboard);
  }

  async function onMessage(m) {
    const text = (m.text || '').trim();
    if (m.chat.type !== 'private') return;
    if (m.contact) return onContact(m);
    if (/^\/start\s+verify\b/.test(text)) {
      return tg('sendMessage', { chat_id: m.chat.id, text: 'Чтобы публиковать смены, подтвердите номер телефона: нажмите кнопку «Поделиться номером» внизу. Это защита от спама и подставных аккаунтов. Номер видим только мы и не показываем его другим пользователям.', reply_markup: phoneKeyboard });
    }
    if (/^\/(start|app)\b/.test(text)) {
      return sendWelcome(m.chat.id, `Привет, ${m.from.first_name || 'друг'}! 👋\n\nSPEED HELPER — смены на завтра и исполнители за минуту.\n• Исполнителям: свайпайте смены, откликайтесь, получайте подтверждение.\n• Подрядчикам: публикуйте смену и собирайте команду.\n\nУведомления об откликах и сменах будут приходить сюда.`, openBtn('🚀 Открыть SPEED HELPER'));
    }
    if (/^\/privacy\b/.test(text)) {
      return tg('sendMessage', { chat_id: m.chat.id, text: `Политика конфиденциальности: ${appUrl}/legal/privacy.html\nПользовательское соглашение: ${appUrl}/legal/terms.html\n\nУдалить аккаунт и все данные можно в приложении: Профиль → Удалить аккаунт.` });
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
        const { rows } = await pool.query(`select n.id, n.text, n.link, u.tg_id, u.blocked, u.is_fake from notifications n join users u on u.id = n.user_id
          where not n.tg_sent and n.created_at > now() - interval '1 day' order by n.id limit 50`);
        for (const n of rows) {
          if (!n.blocked && !n.is_fake) { // тестовым (выдуманным) пользователям сообщения не отправляются
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

  // стартовая настройка бота (команды, кнопка меню): при сбое сети повторяем, пока не получится
  (async () => { for (let i = 0; i < 30; i++) { try { await setup(); return; } catch (e) { console.error('bot setup failed', e.message); await sleep(10000); } } })();
  poll();
  notifyLoop();
  // оповещение владельцев (сбои, перезапуски); не падает, если кто-то из них не запускал бота
  return { get username() { return username; }, alert: async (text) => { for (const id of admins) await tg('sendMessage', { chat_id: id, text }).catch(() => {}); } };
}
