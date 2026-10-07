// Карты и адреса — бесплатные сервисы:
//  - карта: OpenFreeMap (данные OpenStreetMap) через MapLibre GL — без ключа и лимитов;
//  - адреса: «Подсказки» DaData — только существующие адреса (ФИАС/ГАР) с координатами, обратное геокодирование.
// Ключ DaData — в config.js (публичный, бесплатный тариф ~10 000 запросов в день).
import { CONFIG } from './config.js';
import { sheet } from './ui.js';
import { esc, debounce } from './util.js';

const MAPLIBRE = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl';
const STYLE = 'https://tiles.openfreemap.org/styles/dark';
const DADATA = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs';
const GREEN = '#39ff6a';

// ---------- карта ----------
let loading = null;
function loadMaplibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (loading) return loading;
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = MAPLIBRE + '.css'; document.head.appendChild(css);
  loading = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = MAPLIBRE + '.js';
    s.onload = () => res(window.maplibregl);
    s.onerror = () => { loading = null; s.remove(); rej(new Error('Карта не загрузилась. Проверьте интернет')); };
    document.head.appendChild(s);
  });
  return loading;
}

// Подгрузка библиотеки карты заранее (во время заставки), чтобы карта потом открывалась без задержки
export const warmMap = () => loadMaplibre().catch(() => {});

// Подписи на карте — по-русски (в стиле по умолчанию «Moskva / Москва»)
function russianLabels(map) {
  for (const l of map.getStyle().layers) {
    const tf = l.type === 'symbol' && map.getLayoutProperty(l.id, 'text-field');
    if (tf && JSON.stringify(tf).includes('name')) map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ru'], ['get', 'name']]);
  }
}

// Карта в контейнере el; center = [lat, lng]. Возвращает maplibregl.Map после загрузки стиля (снимать — map.remove()).
export async function createMap(el, { center, zoom = 10, interactive = true, geolocate = true } = {}) {
  const ml = await loadMaplibre();
  if (!el.isConnected) return null; // пользователь уже ушёл с экрана
  const [lat, lng] = center || [CONFIG.DEFAULT_CITY.lat, CONFIG.DEFAULT_CITY.lng];
  const map = new ml.Map({ container: el, style: STYLE, center: [lng, lat], zoom, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, cooperativeGestures: false, interactive });
  map.touchZoomRotate.disableRotation();
  if (interactive) {
    map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-left');
    if (geolocate) map.addControl(new ml.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-left');
  }
  await new Promise((res) => map.once('load', res));
  try { russianLabels(map); } catch {}
  return map;
}

const pinEl = (label) => {
  const d = document.createElement('div'); d.className = 'mpin';
  d.innerHTML = `<i></i>${label ? `<b>${esc(label)}</b>` : ''}`;
  return d;
};
// Метка; возвращает maplibregl.Marker (setLngLat / getLngLat / on('dragend'))
export function placemark(map, lat, lng, { label = '', draggable = false } = {}) {
  return new window.maplibregl.Marker({ element: pinEl(label), anchor: 'bottom', draggable }).setLngLat([lng, lat]).addTo(map);
}

// Круг радиуса поиска (км)
export function radiusCircle(map, lat, lng, km) {
  const pts = [], R = 6371, n = 72;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI, dLat = (km / R) * Math.cos(a), dLng = (km / R) * Math.sin(a) / Math.cos(lat * Math.PI / 180);
    pts.push([lng + dLng * 180 / Math.PI, lat + dLat * 180 / Math.PI]);
  }
  map.addSource('radius', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] } } });
  map.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius', paint: { 'fill-color': GREEN, 'fill-opacity': 0.05 } });
  map.addLayer({ id: 'radius-line', type: 'line', source: 'radius', paint: { 'line-color': GREEN, 'line-width': 1.5, 'line-opacity': 0.6 } });
}

// Смены на карте: близкие группируются в кластеры, у точки — подпись с оплатой. onPick(id) — нажатие на смену.
export function shiftsLayer(map, items, onPick) {
  const features = items.filter((s) => s.lat != null).map((s) => ({ type: 'Feature', properties: { id: s.id, pay: Number(s.pay).toLocaleString('ru-RU') + ' р' /* в шрифте карты нет знака ₽ */ }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } }));
  map.addSource('shifts', { type: 'geojson', data: { type: 'FeatureCollection', features }, cluster: true, clusterRadius: 44, clusterMaxZoom: 15 });
  // свечение: там, где есть работа, точки светятся и мягко пульсируют
  map.addLayer({ id: 'cluster-glow', type: 'circle', source: 'shifts', filter: ['has', 'point_count'], paint: { 'circle-color': GREEN, 'circle-radius': 32, 'circle-opacity': 0.25, 'circle-blur': 0.9 } });
  map.addLayer({ id: 'shift-glow', type: 'circle', source: 'shifts', filter: ['!', ['has', 'point_count']], paint: { 'circle-color': GREEN, 'circle-radius': 22, 'circle-opacity': 0.3, 'circle-blur': 1 } });
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let raf; const t0 = performance.now();
    const pulse = () => {
      const k = (Math.sin((performance.now() - t0) / 450) + 1) / 2;
      try { map.setPaintProperty('shift-glow', 'circle-radius', 15 + k * 15); map.setPaintProperty('shift-glow', 'circle-opacity', 0.38 - k * 0.2); map.setPaintProperty('cluster-glow', 'circle-radius', 26 + k * 14); map.setPaintProperty('cluster-glow', 'circle-opacity', 0.32 - k * 0.15); } catch { return; }
      raf = requestAnimationFrame(pulse);
    };
    pulse(); map.on('remove', () => cancelAnimationFrame(raf));
  }
  map.addLayer({ id: 'clusters', type: 'circle', source: 'shifts', filter: ['has', 'point_count'], paint: { 'circle-color': GREEN, 'circle-radius': ['step', ['get', 'point_count'], 16, 10, 20, 50, 26], 'circle-stroke-width': 4, 'circle-stroke-color': 'rgba(57,255,106,.25)' } });
  map.addLayer({ id: 'cluster-n', type: 'symbol', source: 'shifts', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 13 }, paint: { 'text-color': '#031407' } });
  map.addLayer({ id: 'shift-dot', type: 'circle', source: 'shifts', filter: ['!', ['has', 'point_count']], paint: { 'circle-color': GREEN, 'circle-radius': 7, 'circle-stroke-width': 2, 'circle-stroke-color': '#0b0c0e' } });
  map.addLayer({ id: 'shift-pay', type: 'symbol', source: 'shifts', filter: ['!', ['has', 'point_count']], layout: { 'text-field': ['get', 'pay'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, -1.5], 'text-anchor': 'bottom', 'text-allow-overlap': false }, paint: { 'text-color': '#fff', 'text-halo-color': '#0b0c0e', 'text-halo-width': 2 } });
  map.on('click', 'clusters', async (e) => {
    const f = e.features[0], z = await map.getSource('shifts').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom: z });
  });
  const pick = (e) => onPick(e.features[0].properties.id);
  map.on('click', 'shift-dot', pick); map.on('click', 'shift-pay', pick);
  for (const l of ['clusters', 'shift-dot', 'shift-pay']) { map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer')); map.on('mouseleave', l, () => (map.getCanvas().style.cursor = '')); }
}

export const routeLink = (lat, lng) => `https://yandex.ru/maps/?rtext=~${lat},${lng}&rtt=auto`;

// ---------- адреса (DaData) ----------
async function dadata(method, body) {
  if (!CONFIG.DADATA_KEY) throw new Error('не задан ключ DaData');
  const r = await fetch(`${DADATA}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Token ' + CONFIG.DADATA_KEY }, body: JSON.stringify(body) });
  if (r.status === 403 || r.status === 401) throw new Error('ключ DaData не принят');
  if (r.status === 429) throw new Error('превышен дневной лимит DaData');
  if (!r.ok) throw new Error('сервис адресов не отвечает');
  return (await r.json()).suggestions || [];
}
const strip = (v) => String(v || '').replace(/^Россия,\s*/, '');
// Адрес существует с точностью до дома и у него есть координаты
// Работаем только в Москве и Московской области: 'msk' / 'mo' / null (вне зоны)
const regionOf = (d) => { const c = d.region_iso_code || ''; if (c === 'RU-MOW') return 'msk'; if (c === 'RU-MOS') return 'mo'; const r = d.region || ''; return r === 'Москва' ? 'msk' : r === 'Московская' ? 'mo' : null; };
const ZONE = [{ kladr_id: '7700000000000' }, { kladr_id: '5000000000000' }]; // подсказки только по Москве и области
const toAddr = (s) => { const d = s.data || {}; const has = d.geo_lat != null && d.geo_lon != null; return { ok: !!d.house && has, house: !!d.house, lat: has ? +d.geo_lat : null, lng: has ? +d.geo_lon : null, address: strip(s.value), region: regionOf(d) }; };

export const suggestAddress = async (query, count = 6) => (String(query || '').trim().length < 3 ? [] : (await dadata('suggest/address', { query: String(query).trim(), count, locations: ZONE })).map((s) => ({ ...toAddr(s), raw: s })));

// Проверка введённого текста: {ok, lat, lng, address, house} лучшего совпадения или null, если такого адреса нет
export async function geocode(query) {
  const [s] = await suggestAddress(query, 1);
  return s || null;
}

// Адрес по точке на карте (ближайший дом)
export async function reverseGeocode(lat, lng) {
  const [s] = await dadata('geolocate/address', { lat, lon: lng, count: 1, radius_meters: 100 });
  return s ? { address: strip(s.value), region: regionOf(s.data || {}) } : null;
}

// Подсказки под полем ввода. onPick({ok, lat, lng, address}) — выбран адрес с домом.
// Если выбрана улица без дома — подставляем её и ждём номер дома (как принято в DaData).
export function attachSuggest(input, onPick) {
  const box = document.createElement('div'); box.className = 'sugg'; box.hidden = true;
  input.parentElement.style.position = 'relative'; input.after(box);
  let list = [], seq = 0;
  const hide = () => { box.hidden = true; };
  const show = () => {
    box.innerHTML = list.map((s, i) => `<div class="si" data-i="${i}">${esc(s.address)}${s.house ? '' : '<span class="mut"> — укажите дом</span>'}</div>`).join('') + '<div class="sb">Подсказки — DaData</div>';
    box.hidden = !list.length;
  };
  const load = debounce(async () => {
    const my = ++seq; let r = [];
    try { r = await suggestAddress(input.value); } catch (e) { list = []; box.innerHTML = `<div class="sb">${esc('Подсказки недоступны: ' + e.message)}</div>`; box.hidden = !CONFIG.DADATA_KEY; return; }
    if (my !== seq) return; list = r; show();
  }, 280);
  input.addEventListener('input', load);
  input.addEventListener('focus', () => { if (list.length) show(); });
  input.addEventListener('blur', () => setTimeout(hide, 180));
  box.addEventListener('pointerdown', (e) => {
    const it = e.target.closest('[data-i]'); if (!it) return; e.preventDefault();
    const s = list[+it.dataset.i];
    if (!s.house) { input.value = s.address + ', '; input.focus(); load(); return; }
    input.value = s.address; hide(); onPick(s);
  });
  return { hide };
}

// ---------- выбор точки на карте ----------
// Возвращает {lat, lng, address, ok} или null
export function pickLocation({ lat, lng, query } = {}) {
  return new Promise((res) => {
    const s = sheet(`<h3>Место на карте</h3><div><input class="i" id="pq" placeholder="Город, улица, дом" value="${esc(query || '')}" autocomplete="off"></div>
      <div id="pmap" style="height:300px;margin:10px 0;border-radius:14px;overflow:hidden"></div><p class="mut sm" id="pinfo">Выберите адрес из подсказок или нажмите на карту, чтобы поставить точку</p>
      <button class="btn pri block" id="pok" disabled>Готово</button>`);
    const $ = (id) => s.el.querySelector('#' + id);
    let cur = lat != null ? { lat, lng } : null, addr = '', ok = false, region = null, map = null, mk = null, done = false;
    const finish = (v) => { if (done) return; done = true; if (map) map.remove(); res(v); };
    const info = (t, cls = 'mut') => { $('pinfo').className = 'sm ' + cls; $('pinfo').textContent = t; };
    const set = (p, a, exact, reg) => {
      cur = p; ok = !!exact; addr = a || ''; if (reg !== undefined) region = reg;
      if (map) { if (mk) mk.setLngLat([p.lng, p.lat]); else { mk = placemark(map, p.lat, p.lng, { draggable: true }); mk.on('dragend', () => { const q = mk.getLngLat(); fromPoint({ lat: q.lat, lng: q.lng }); }); } }
      $('pok').disabled = false;
      info(addr ? '📍 ' + addr : `Точка: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, addr ? 'g' : 'mut');
    };
    const fromPoint = async (p) => {
      set(p, null); info('Ищем адрес точки…');
      try {
        const a = await reverseGeocode(p.lat, p.lng);
        if (a && !a.region) { $('pok').disabled = true; return info('Это вне Москвы и Московской области — работаем только здесь. Выберите другую точку', 'r'); }
        if (a) { $('pq').value = a.address; set(p, a.address, true, a.region); } else info(`Точка: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} — рядом нет адреса`, 'y');
      }
      catch (e) { info(`Точка: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} (адрес не определён: ${e.message})`, 'y'); }
    };
    const toAddrPoint = (g) => { if (g.lat == null) return info('У этого адреса нет координат — поставьте точку на карте', 'y'); map && map.flyTo({ center: [g.lng, g.lat], zoom: g.ok ? 17 : 14 }); set({ lat: g.lat, lng: g.lng }, g.address, g.ok, g.region); };
    createMap($('pmap'), { center: cur ? [cur.lat, cur.lng] : null, zoom: cur ? 16 : 10 }).then((m) => {
      if (!m) return; map = m;
      if (cur) set(cur, query, !!query);
      map.on('click', (e) => fromPoint({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    }).catch((e) => info(e.message, 'r'));
    attachSuggest($('pq'), toAddrPoint);
    $('pq').onkeydown = async (e) => { if (e.key !== 'Enter') return; try { const g = await geocode($('pq').value); if (g) toAddrPoint(g); else info('Адрес не найден', 'r'); } catch (er) { info(er.message, 'r'); } };
    $('pok').onclick = () => { s.close(); finish({ ...cur, address: addr, ok, region }); };
    s.el.parentElement.addEventListener('click', (e) => { if (e.target === s.el.parentElement) finish(null); });
  });
}
