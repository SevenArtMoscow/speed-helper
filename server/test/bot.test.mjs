// Приветственная анимация бота: проверка на подставном Bot API (без настоящего Telegram). Запуск: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
const log = []; let updates = [], failAnim = false, dropOnce = false;
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks); const method = req.url.split('/').pop(); const ct = req.headers['content-type'] || '';
    const reply = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (method === 'getUpdates') { const u = updates; updates = []; return setTimeout(() => reply({ ok: true, result: u }), u.length ? 0 : 300); }
    if (method === 'sendAnimation') {
      const multipart = ct.startsWith('multipart/form-data');
      log.push({ method, multipart, bytes: body.length, json: multipart ? null : JSON.parse(body.toString()) });
      if (dropOnce && multipart) { dropOnce = false; return req.socket.destroy(); }   // обрыв сети посреди загрузки
      if (failAnim) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, description: 'Bad Request: wrong file' })); }
      return reply({ ok: true, result: { message_id: 1, animation: { file_id: 'FILE_ID_123' } } });
    }
    if (method === 'sendMessage') { log.push({ method, text: JSON.parse(body.toString()).text.slice(0, 30) }); return reply({ ok: true, result: {} }); }
    reply({ ok: true, result: true });
  });
}).listen(3299, '127.0.0.1');

process.env.TG_API = 'http://127.0.0.1:3299';
process.env.WELCOME_ID_FILE = path.join(os.tmpdir(), 'sh-test-welcome-id-' + process.pid);
const { startBot } = await import('../bot.js');
const pool = { query: async () => ({ rows: [] }) };
startBot({ pool, token: 'TEST:TOKEN', appUrl: 'https://example.test', admins: [] });
const msg = (id) => ({ update_id: id, message: { chat: { id: 5, type: 'private' }, from: { first_name: 'Тест' }, text: '/start' } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok) => results.push((ok ? '✓ ' : '✗ ') + name);

test('бот: приветствие с анимацией', { timeout: 30000 }, async (t) => {
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
  assert.ok(!results.some((r) => r.startsWith('✗')), results.join(String.fromCharCode(10)));
});
