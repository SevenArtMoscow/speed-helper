// Настройки. Публичные значения (publishable/anon key) можно хранить во фронтенде.
// Секреты (service_role, токен бота) — ТОЛЬКО в переменных окружения Edge Functions.
export const CONFIG = {
  // Если SUPABASE_URL пустой — приложение работает на локальном движке (localStorage) для разработки и проверки.
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  // Edge Function, которая проверяет Telegram initData и выдаёт сессию
  AUTH_FUNCTION: 'tg-auth',
  APP_VERSION: '1.0.0',
  DEFAULT_CITY: { name: 'Москва', lat: 55.7558, lng: 37.6173 },
  MIN_VERIFIED_PERCENT: 80,
  POLL_MS: 4000,
};
