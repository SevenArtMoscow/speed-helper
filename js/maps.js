// Яндекс Карты (JS API 2.1): загрузка по требованию, карта, геокодер (проверка адреса), выбор точки.
// Ключи — в config.js (публичные, ограничиваются по HTTP Referer в кабинете разработчика Яндекса).
import { CONFIG } from './config.js';
import { sheet } from './ui.js';
import { esc } from './util.js';

let loading = null;
export function loadYmaps() {
  if (window.ymaps && window.ymaps.Map) return Promise.resolve(window.ymaps);
  if (loading) return loading;
  const q = new URLSearchParams({ lang: 'ru_RU' });
  if (CONFIG.YANDEX_MAPS_KEY) q.set('apikey', CONFIG.YANDEX_MAPS_KEY);
  if (CONFIG.YANDEX_SUGGEST_KEY) q.set('suggest_apikey', CONFIG.YANDEX_SUGGEST_KEY);
  loading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://api-maps.yandex.ru/2.1/?' + q;
    s.onload = () => window.ymaps.ready(() => res(window.ymaps), rej);
    s.onerror = () => { loading = null; s.remove(); rej(new Error('Карты недоступны. Проверьте интернет')); };
    document.head.appendChild(s);
  });
  return loading;
}

const DEF = () => [CONFIG.DEFAULT_CITY.lat, CONFIG.DEFAULT_CITY.lng];
export const pinPreset = 'islands#greenDotIcon';

// Карта в контейнере el. Возвращает объект ymaps.Map (снимать — map.destroy()).
export async function createMap(el, { center, zoom = 10, controls = ['zoomControl', 'geolocationControl'] } = {}) {
  const ym = await loadYmaps();
  if (!el.isConnected) return null; // пользователь уже ушёл с экрана
  el.classList.add('ymap');
  return new ym.Map(el, { center: center || DEF(), zoom, controls }, { suppressMapOpenBlock: true, yandexMapDisablePoiInteractivity: true });
}

export async function placemark(map, lat, lng, props = {}, opts = {}) {
  const ym = await loadYmaps();
  const p = new ym.Placemark([lat, lng], props, { preset: pinPreset, ...opts });
  map.geoObjects.add(p); return p;
}

const addrLine = (g) => g.getAddressLine().replace(/^Россия,\s*/, '');
// Геокодер без действующего ключа отвечает ошибкой загрузки (scriptError)
const geoErr = () => new Error(CONFIG.YANDEX_MAPS_KEY ? 'геокодер Яндекса не отвечает' : 'не задан ключ Яндекс Карт');
// Точность геокодера: дом найден точно или почти точно — адрес существует
const HOUSE = ['exact', 'number', 'near'];

// Проверка адреса: { ok, lat, lng, address, precision } или null, если ничего не найдено
export async function geocode(query) {
  const q = String(query || '').trim(); if (q.length < 3) return null;
  const ym = await loadYmaps();
  const r = await ym.geocode(q, { results: 1, boundedBy: [[41, 19], [82, 180]] }).catch(() => { throw geoErr(); }); // Россия
  const g = r.geoObjects.get(0); if (!g) return null;
  const [lat, lng] = g.geometry.getCoordinates();
  const precision = g.properties.get('metaDataProperty.GeocoderMetaData.precision');
  return { ok: HOUSE.includes(precision), lat, lng, address: addrLine(g), precision };
}

// Адрес по точке на карте (ближайший дом)
export async function reverseGeocode(lat, lng) {
  const ym = await loadYmaps();
  const r = await ym.geocode([lat, lng], { kind: 'house', results: 1 }).catch(() => { throw geoErr(); });
  const g = r.geoObjects.get(0);
  return g ? addrLine(g) : null;
}

// Подсказки адресов под полем ввода (если задан ключ Геосаджеста). onPick(текст) — выбор из списка.
export async function attachSuggest(input, onPick) {
  if (!CONFIG.YANDEX_SUGGEST_KEY) return null;
  const ym = await loadYmaps();
  if (!input.isConnected) return null;
  const sv = new ym.SuggestView(input, { results: 5, boundedBy: [[41, 19], [82, 180]] });
  sv.events.add('select', (e) => onPick(e.get('item').value));
  return sv;
}

export const routeLink = (lat, lng) => `https://yandex.ru/maps/?rtext=~${lat},${lng}&rtt=auto`;

// Выбор точки на карте + поиск адреса. Возвращает {lat, lng, address, ok} или null
export function pickLocation({ lat, lng, query } = {}) {
  return new Promise((res) => {
    const s = sheet(`<h3>Место на карте</h3><div class="row gap"><input class="i" id="pq" placeholder="Город, улица, дом" value="${esc(query || '')}" autocomplete="off"><button class="btn sm" id="pgo">Найти</button></div>
      <div id="pmap" style="height:300px;margin:10px 0;border-radius:14px;overflow:hidden"></div><p class="mut sm" id="pinfo">Найдите адрес или нажмите на карту, чтобы поставить точку</p>
      <button class="btn pri block" id="pok" disabled>Готово</button>`);
    const $ = (id) => s.el.querySelector('#' + id);
    let cur = lat != null ? { lat, lng } : null, addr = '', ok = false, map = null, mk = null, done = false;
    const finish = (v) => { if (done) return; done = true; if (map) map.destroy(); res(v); };
    const info = (t, cls = 'mut') => { $('pinfo').className = 'sm ' + cls; $('pinfo').textContent = t; };
    const set = async (p, a, exact) => {
      cur = p; ok = !!exact;
      if (mk) mk.geometry.setCoordinates([p.lat, p.lng]); else mk = await placemark(map, p.lat, p.lng, {}, { draggable: true });
      if (!mk._drag) { mk._drag = true; mk.events.add('dragend', () => { const [la, ln] = mk.geometry.getCoordinates(); fromPoint({ lat: la, lng: ln }); }); }
      addr = a || addr; $('pok').disabled = false;
      info(addr ? '📍 ' + addr : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, addr ? 'g' : 'mut');
    };
    const fromPoint = async (p) => { await set(p, null); try { const a = await reverseGeocode(p.lat, p.lng); if (a) { $('pq').value = a; await set(p, a, true); } } catch {} };
    const search = async () => {
      const q = $('pq').value.trim(); if (!q || !map) return;
      try {
        const g = await geocode(q);
        if (!g) return info('Адрес не найден. Уточните запрос или поставьте точку на карте', 'r');
        map.setCenter([g.lat, g.lng], g.ok ? 17 : 14); $('pq').value = g.address;
        await set({ lat: g.lat, lng: g.lng }, g.address, g.ok);
        if (!g.ok) info('Не нашли дом — уточните номер дома или передвиньте точку на нужное здание', 'y');
      } catch { info('Поиск недоступен. Поставьте точку на карте вручную', 'r'); }
    };
    createMap($('pmap'), { center: cur ? [cur.lat, cur.lng] : null, zoom: cur ? 16 : 10 }).then(async (m) => {
      if (!m) return; map = m;
      if (cur) await set(cur, query, true); else if (query) search();
      map.events.add('click', (e) => { const [la, ln] = e.get('coords'); fromPoint({ lat: la, lng: ln }); });
    }).catch((e) => { info(e.message, 'r'); });
    $('pgo').onclick = search;
    $('pq').onkeydown = (e) => e.key === 'Enter' && search();
    attachSuggest($('pq'), () => search()).catch(() => {});
    $('pok').onclick = () => { s.close(); finish({ ...cur, address: addr, ok }); };
    s.el.parentElement.addEventListener('click', (e) => { if (e.target === s.el.parentElement) finish(null); });
  });
}
