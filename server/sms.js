// Доставка кода подтверждения номера. Провайдер выбирается в server/.env (SMS_PROVIDER):
//  - smsru       — SMS через sms.ru: SMSRU_API_ID (ключ из личного кабинета), необязательно SMSRU_FROM (согласованное имя отправителя);
//  - tg_gateway  — код приходит в Telegram того аккаунта, на который зарегистрирован номер (Telegram Gateway): TG_GATEWAY_TOKEN;
//  - log         — только для разработки: код пишется в журнал (в production не включается).
// Без настроенного провайдера подтверждение по коду выключено — остаётся подтверждение контактом через бота.
const text = (code) => `SPEED HELPER: код подтверждения ${code}. Никому его не сообщайте.`;

export function smsProvider(env) {
  const p = String(env.SMS_PROVIDER || '').trim();
  if (p === 'smsru' && env.SMSRU_API_ID) return { name: p, send: (phone, code) => smsru(env, phone, code) };
  if (p === 'tg_gateway' && env.TG_GATEWAY_TOKEN) return { name: p, send: (phone, code) => tgGateway(env, phone, code) };
  if (p === 'log' && env.NODE_ENV !== 'production') return { name: p, send: async (phone, code) => console.log(`[код подтверждения] +7${phone}: ${code}`) };
  if (p) console.error(`SMS_PROVIDER=${p}: провайдер не настроен (нет ключа или неизвестное имя) — подтверждение по коду выключено`);
  return null;
}

// https://sms.ru/api/send — параметры в теле запроса (ключ не попадает в журналы адресов)
async function smsru(env, phone, code) {
  const body = new URLSearchParams({ api_id: env.SMSRU_API_ID, to: '7' + phone, msg: text(code), json: '1' });
  if (env.SMSRU_FROM) body.set('from', env.SMSRU_FROM);
  const res = await fetch((env.SMSRU_URL || 'https://sms.ru') + '/sms/send', { method: 'POST', body, signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  const st = j.sms && j.sms['7' + phone];
  if (j.status !== 'OK' || !st || st.status !== 'OK') throw new Error(`sms.ru: ${(st && st.status_text) || j.status_text || 'HTTP ' + res.status}`);
}

// https://core.telegram.org/gateway/api#sendverificationmessage — отправляем свой код, срок жизни 10 минут
async function tgGateway(env, phone, code) {
  const res = await fetch((env.TG_GATEWAY_URL || 'https://gatewayapi.telegram.org') + '/sendVerificationMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TG_GATEWAY_TOKEN },
    body: JSON.stringify({ phone_number: '+7' + phone, code, ttl: 600 }), signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram Gateway: ${j.error || 'HTTP ' + res.status}`);
}
