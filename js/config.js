// Настройки. Публичные значения (publishable/anon key) можно хранить во фронтенде.
// Секреты (service_role, токен бота) — ТОЛЬКО в переменных окружения Edge Functions.
export const CONFIG = {
  // Бэкенд: собственный сервер (server/) по адресу API_BASE того же домена.
  // Локальный движок (localStorage, для разработки без сервера) включается параметром ?local=1 или при открытии через python http.server (порт 8765).
  API_BASE: '/api',
  // Альтернатива — Supabase (supabase/): если SUPABASE_URL задан, используется он.
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  // Edge Function, которая проверяет Telegram initData и выдаёт сессию
  AUTH_FUNCTION: 'tg-auth',
  APP_VERSION: '1.0.0',
  DEFAULT_CITY: { name: 'Москва', lat: 55.7558, lng: 37.6173 },
  // DaData «Подсказки»: проверка и подсказки адресов. API-ключ из личного кабинета https://dadata.ru (публичный, бесплатно ~10 000 запросов в день).
  // Карта — OpenFreeMap, ключ не нужен.
  DADATA_KEY: '4170050c9a35f2b42a7f4224ac6d446f933d04cf',
  MIN_VERIFIED_PERCENT: 80,
  POLL_MS: 4000,
};
