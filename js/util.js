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
