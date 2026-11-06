// Общие утилиты
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Смены в приложении — по московскому времени (как на сервере), независимо от часового пояса телефона
const MSK = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
export const todayISO = () => MSK.format(new Date());
export const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoDate(d); };

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export function dateLabel(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const short = `${d}.${m}`;
  const t = todayISO();
  if (iso === t) return `Сегодня · ${short}`;
  if (iso === addDays(t, 1)) return `Завтра · ${short}`;
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}
export const dateLong = (iso) => { const [, m, d] = iso.split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]}`; };
export function isWeekend(iso) { const w = new Date(iso + 'T00:00:00').getDay(); return w === 0 || w === 6; }

export const money = (n) => `${Number(n || 0).toLocaleString('ru-RU')} ₽`;
// время смены: «09:00–18:00» или «с 09:00 · до выполнения задачи»; оплата: «3 000 ₽» или «500 ₽/час»
export const timeRange = (s) => (s.until_done ? `с ${s.start} · до выполнения задачи` : `${s.start}–${s.end}`);
export const payLabel = (s) => (s.pay_type === 'hour' ? `${money(s.pay)}/час` : money(s.pay));
export const payNote = (s) => (s.pay_type === 'hour' ? `≈ ${money(s.total)} за ${s.until_done ? '8 часов' : 'смену'}` : '');
// Текст смены: описание «Что нужно сделать?»; у старых смен без описания — прежнее название
export const shiftText = (s) => (s.description || '').trim() || s.title || '';

// ---------- срок выплаты ----------
// Порядок вариантов задан ТЗ от 05.11.2026. Срок — обещание подрядчика: оплату через приложение он не запускает и выплату не подтверждает
export const PAYOUT = [['date', 'Указать дату'], ['after_shift', 'Сразу после смены'], ['same_day', 'В день смены'], ['next_day', 'На следующий день'], ['week', 'Через неделю после смены'], ['month', 'Через месяц после смены']];
const PAYOUT_TEXT = { after_shift: 'сразу после смены', same_day: 'в день смены', next_day: 'на следующий день', week: 'через неделю после смены', month: 'через месяц после смены' };
// календарный месяц вперёд; если такого числа нет — последний день месяца
export const addMonths = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return isoDate(new Date(y, m - 1 + n, Math.min(d, new Date(y, m + n, 0).getDate()))); };
// день окончания: ночная смена заканчивается на следующий день; у «до выполнения задачи» — день фактического завершения, пока его нет — null
export const shiftEndDay = (s) => (s.until_done ? (s.completed_at ? MSK.format(new Date(s.completed_at)) : null) : s.end <= s.start ? addDays(s.date, 1) : s.date);
// раньше этого дня конкретную дату выплаты поставить нельзя
export const payoutMinDay = (s) => shiftEndDay({ ...s, completed_at: null }) || s.date;
// когда обещана выплата: для относительных сроков — от окончания смены; null, если окончание ещё неизвестно
export function payoutDay(s) {
  if (s.payout_kind === 'date') return s.payout_date || null;
  const end = s.payout_kind ? shiftEndDay(s) : null;
  if (!end) return null;
  return { after_shift: end, same_day: end, next_day: addDays(end, 1), week: addDays(end, 7), month: addMonths(end, 1) }[s.payout_kind] || null;
}
// «Выплата: 7 ноября», «Выплата: на следующий день»; у старых смен — «Срок выплаты не указан»
export const payoutLabel = (s) => (!s.payout_kind ? 'Срок выплаты не указан' : `Выплата: ${s.payout_kind === 'date' ? dateLong(s.payout_date) : PAYOUT_TEXT[s.payout_kind] || ''}`);
// подробно: для относительного срока показываем и день, если окончание уже известно
export function payoutDetail(s) {
  if (!s.payout_kind || s.payout_kind === 'date') return payoutLabel(s);
  const day = payoutDay(s);
  return payoutLabel(s) + (day ? ` (${dateLong(day)})` : s.until_done ? ' (от фактического завершения)' : '');
}
export const plural = (n, a, b, c) => { const k = Math.abs(n) % 100, l = k % 10; return k > 10 && k < 20 ? c : l > 1 && l < 5 ? b : l === 1 ? a : c; };

export function dist(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
export const kmLabel = (km) => (km == null ? '' : km < 1 ? `${Math.round(km * 1000)} м` : `${km.toFixed(km < 10 ? 1 : 0)} км`);

export function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return new Date(ts).toLocaleDateString('ru-RU');
}
// короткое время для списков: сегодня — 14:05, вчера — «вчера», раньше — 05.10
export const shortTime = (ts) => {
  const d = new Date(ts), now = new Date(), day = (x) => Math.floor((x.getTime() - x.getTimezoneOffset() * 6e4) / 864e5);
  const diff = day(now) - day(d); if (diff <= 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`; if (diff === 1) return 'вчера'; return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
};
export const dayLabel = (ts) => { const d = new Date(ts), now = new Date(), day = (x) => Math.floor((x.getTime() - x.getTimezoneOffset() * 6e4) / 864e5), diff = day(now) - day(d); return diff <= 0 ? 'Сегодня' : diff === 1 ? 'Вчера' : `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
export const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Сжатие фото до квадрата 256px (dataURL)
export function resizeImage(file, size = 256) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      res(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

// Телефон РФ: храним 10 цифр без кода страны, показываем «+7 (916) 123-45-67»
export const phone10 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 11 && /^[78]/.test(d) ? d.slice(1, 11) : d.slice(0, 10); };
export function fmtPhone(v) {
  const d = phone10(v); if (!d) return '';
  return '+7 (' + d.slice(0, 3) + (d.length >= 3 ? ') ' : '') + d.slice(3, 6) + (d.length > 6 ? '-' + d.slice(6, 8) : '') + (d.length > 8 ? '-' + d.slice(8, 10) : '');
}

export const initials =(name) => (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
