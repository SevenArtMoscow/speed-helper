// Приветственная анимация бота: проверка на подставном Bot API (без настоящего Telegram). Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
const log = []; let updates = [], oldUpdates = [], failAnim = false, dropOnce = false;
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks); const method = req.url.split('/').pop(); const ct = req.headers['content-type'] || '';
    const isOld = req.url.split('/')[1] === 'botOLD:TOKEN';   // прежний бот (переезд)
    const reply = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (method === 'getUpdates') { const u = isOld ? oldUpdates : updates; if (isOld) oldUpdates = []; else updates = []; return setTimeout(() => reply({ ok: true, result: u }), u.length ? 0 : 300); }
    if (method === 'getMe') return reply({ ok: true, result: { username: isOld ? 'old_bot' : 'new_bot' } });
    if (method === 'sendAnimation') {
      const multipart = ct.startsWith('multipart/form-data');
      log.push({ method, multipart, bytes: body.length, json: multipart ? null : JSON.parse(body.toString()) });
      if (dropOnce && multipart) { dropOnce = false; return req.socket.destroy(); }   // обрыв сети посреди загрузки
      if (failAnim) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, description: 'Bad Request: wrong file' })); }
      return reply({ ok: true, result: { message_id: 1, animation: { file_id: 'FILE_ID_123' } } });
    }
    if (method === 'sendMessage') {
      const b = JSON.parse(body.toString()); log.push({ method, old: isOld, chat: b.chat_id, text: b.text.slice(0, 30), full: b.text, markup: b.reply_markup });
      if (!isOld && b.chat_id === 555) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, description: "Forbidden: bot can't initiate conversation with a user" })); }
      return reply({ ok: true, result: {} });
    }
    reply({ ok: true, result: true });
  });
}).listen(3299, '127.0.0.1');

process.env.TG_API = 'http://127.0.0.1:3299';
process.env.WELCOME_ID_FILE = path.join(os.tmpdir(), 'sh-test-welcome-id-' + process.pid);
const { startBot } = await import('../bot.js');
let verifyResult = 'ok', supportRows = [], notifRows = []; const poolCalls = [];
const pool = { query: async (sql, args) => {
  poolCalls.push({ sql, args }); sql = String(sql);
  if (sql.includes('bot_verify_phone')) return { rows: [{ r: verifyResult }] };
  if (sql.includes('bot_support_reply')) return { rows: [{ r: 'ok' }] };
  if (sql.includes('not m.support_fwd')) { const r = supportRows; supportRows = []; return { rows: r }; }
  if (sql.includes('from notifications n')) { const r = notifRows; notifRows = []; return { rows: r }; }
  return { rows: [] };
} };
startBot({ pool, token: 'TEST:TOKEN', appUrl: 'https://example.test', admins: [], support: ['42'], oldToken: 'OLD:TOKEN' });
const msg = (id) => ({ update_id: id, message: { chat: { id: 5, type: 'private' }, from: { id: 5, first_name: 'Тест' }, text: '/start' } });
const contact = (id, userId) => ({ update_id: id, message: { chat: { id: 5, type: 'private' }, from: { id: 5, first_name: 'Тест' }, contact: { phone_number: '79161234567', user_id: userId } } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok) => results.push((ok ? '✓ ' : '✗ ') + name);

test('бот: приветствие с анимацией', { timeout: 45000 }, async (t) => {
  t.after(() => setTimeout(() => process.exit(process.exitCode || 0), 500));
  await wait(500); updates = [msg(1)]; await wait(900);
  check('1-й /start: файл загружен (multipart, > 1 МБ)', log[0] && log[0].method === 'sendAnimation' && log[0].multipart && log[0].bytes > 1_000_000);
  updates = [msg(2)]; await wait(900);
  check('2-й /start: по file_id, без загрузки', log[1] && log[1].method === 'sendAnimation' && !log[1].multipart && log[1].json.animation === 'FILE_ID_123' && log[1].json.caption.includes('Привет, Тест'));
  check('кнопка «Открыть» прикреплена', log[1] && JSON.stringify(log[1].json.reply_markup).includes('web_app'));
  failAnim = true; updates = [msg(3)]; await wait(900);
  check('сбой анимации → обычное сообщение, а не тишина', log.at(-1).method === 'sendMessage' && log.at(-1).text.startsWith('Привет, Тест'));
  failAnim = false; updates = [msg(4)]; await wait(900);
  check('после сбоя: файл загружается заново (кэш сброшен)', log.at(-1).method === 'sendAnimation' && log.at(-1).multipart);
  // сеть до Telegram оборвалась на загрузке: должна быть повторная попытка, а не обычное сообщение вместо гифки
  failAnim = true; updates = [msg(5)]; await wait(900); failAnim = false;
  const before = log.length; dropOnce = true; updates = [msg(6)]; await wait(3000);
  const after = log.slice(before);
  check('обрыв сети на загрузке → повтор, гифка всё равно доходит', after.filter((x) => x.method === 'sendAnimation' && x.multipart).length === 2 && !after.some((x) => x.method === 'sendMessage'));
  updates = [msg(7)]; await wait(900);
  check('после повтора файл запомнен (дальше по file_id)', log.at(-1).method === 'sendAnimation' && !log.at(-1).multipart);
  // подтверждение номера подрядчика
  updates = [{ update_id: 20, message: { chat: { id: 5, type: 'private' }, from: { id: 5, first_name: 'Тест' }, text: '/start verify' } }]; await wait(900);
  check('/start verify: просит поделиться номером (кнопка request_contact)', log.at(-1).method === 'sendMessage' && JSON.stringify(log.at(-1).markup).includes('request_contact'));
  const calls0 = poolCalls.length; updates = [contact(21, 777)]; await wait(900);
  check('чужой контакт отклонён и в базу не попадает', poolCalls.length === calls0 && log.at(-1).full.includes('именно ваш номер'));
  verifyResult = 'ok'; updates = [contact(22, 5)]; await wait(900);
  const vc = poolCalls.filter((c) => String(c.sql).includes('bot_verify_phone')).at(-1);
  check('свой контакт: номер уходит в базу вместе с id отправителя', vc && vc.args[0] === 5 && vc.args[1] === '79161234567');
  check('свой контакт: бот подтверждает и зовёт назад в приложение', log.some((x) => x.method === 'sendMessage' && (x.full || '').includes('Номер подтверждён')) && log.at(-1).full.includes('Вернитесь в приложение'));
  verifyResult = 'taken'; updates = [contact(23, 5)]; await wait(900);
  check('номер уже у другого аккаунта: понятное сообщение', log.at(-1).full.includes('другому аккаунту'));
  verifyResult = 'foreign'; updates = [contact(24, 5)]; await wait(900);
  check('не российский номер: понятное сообщение', log.at(-1).full.includes('российские'));
  // флуд в чат с ботом: одному человеку отвечаем не больше 20 раз в минуту (общий лимит Bot API нужен для уведомлений)
  const replies = () => log.filter((x) => (x.full || '').startsWith('Всё самое интересное')).length;
  const n0 = replies();
  updates = Array.from({ length: 25 }, (_, i) => ({ update_id: 100 + i, message: { chat: { id: 9, type: 'private' }, from: { id: 9, first_name: 'Флуд' }, text: 'привет' } })); await wait(1500);
  check('флуд от одного человека: не больше 20 ответов в минуту', replies() - n0 === 20);
  // служба поддержки: обращение уходит сотруднику (42), его реплай — пользователю
  supportRows = [{ id: 501, text: 'Не могу откликнуться', uid: '15', username: 'ivan', name: 'Иван' }]; await wait(3500);
  const fwd = log.find((x) => x.method === 'sendMessage' && x.chat === '42');
  check('поддержка: обращение переслано сотруднику', fwd && fwd.full.includes('Обращение #15') && fwd.full.includes('Не могу откликнуться') && fwd.full.includes('@ivan'));
  check('поддержка: кнопка открывает обращение в приложении', fwd && JSON.stringify(fwd.markup).includes(encodeURIComponent('/support/15')));
  check('поддержка: обращение помечено пересланным', poolCalls.some((c) => String(c.sql).includes('support_fwd = true') && c.args[0] === 501));
  updates = [{ update_id: 300, message: { message_id: 9, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Серёга' }, text: 'Проверьте профиль', reply_to_message: { from: { id: 1, is_bot: true }, text: fwd ? fwd.full : '' } } }]; await wait(900);
  const rc = poolCalls.filter((c) => String(c.sql).includes('bot_support_reply')).at(-1);
  check('поддержка: реплай сотрудника уходит пользователю #15', rc && rc.args[0] === 42 && rc.args[2] === 15 && rc.args[3] === 'Проверьте профиль');
  check('поддержка: сотруднику — подтверждение', log.at(-1).chat === 42 && log.at(-1).full.includes('Ответ отправлен'));
  const repliesBefore = poolCalls.filter((c) => String(c.sql).includes('bot_support_reply')).length;
  updates = [{ update_id: 301, message: { message_id: 10, chat: { id: 77, type: 'private' }, from: { id: 77, first_name: 'Хитрый' }, text: 'Я тоже поддержка', reply_to_message: { from: { id: 1, is_bot: true }, text: 'Обращение #15' } } }]; await wait(900);
  check('поддержка: не сотрудник ответить за поддержку не может', poolCalls.filter((c) => String(c.sql).includes('bot_support_reply')).length === repliesBefore);
  // переезд на новый бот: прежний бот отвечает, куда идти; уведомление тому, кто не нажал Start в новом, уходит через прежний
  oldUpdates = [{ update_id: 1, message: { message_id: 1, chat: { id: 66, type: 'private' }, from: { id: 66, first_name: 'Старый' }, text: '/start' } }]; await wait(900);
  const mv = log.find((x) => x.old && x.chat === 66);
  check('переезд: прежний бот отвечает «переехали» и ведёт в новый', mv && mv.full.includes('переехал в @new_bot') && JSON.stringify(mv.markup).includes('https://t.me/new_bot'));
  check('переезд: из прежнего бота можно открыть приложение', mv && JSON.stringify(mv.markup).includes('web_app'));
  notifRows = [{ id: 900, text: 'Вас приняли: «Склад»', link: '#/team/7', tg_id: 555, blocked: false, is_fake: false }]; await wait(3500);
  const viaOld = log.find((x) => x.old && x.chat === 555);
  check('переезд: новый бот не может написать (нет Start) — уведомление пришло через прежний', viaOld && viaOld.full.startsWith('Вас приняли: «Склад»') && viaOld.full.includes('@new_bot'));
  check('переезд: кнопка уведомления ведёт на нужный экран', viaOld && JSON.stringify(viaOld.markup).includes(encodeURIComponent('/team/7')));
  check('переезд: уведомление помечено отправленным', poolCalls.some((c) => String(c.sql).includes('tg_sent = true where id') && c.args[0] === 900));
  assert.ok(!results.some((r) => r.startsWith('✗')), results.join(String.fromCharCode(10)));
});
