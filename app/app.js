/* Rota de Vendas — acha restaurantes perto de você e monta a melhor rota de carro.
 * Fontes: TomTom ao vivo (opcional, chave grátis só no aparelho) ou OpenStreetMap (base salva / Overpass)
 *         + dados do scraper do Google Maps (restaurantes.json ou CSV importado).
 * Rota: OSRM /trip (problema do caixeiro-viajante em ruas reais); se falhar, vizinho mais próximo + 2-opt local.
 */
'use strict';

// ---------- config ----------
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const PHOTON = 'https://photon.komoot.io/api/';
const OSRM = 'https://router.project-osrm.org';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

const TOMTOM = 'https://api.tomtom.com/search/2';
const TT_TARGET = 150;         // para de buscar quando os 150 mais próximos estão garantidos (a rota usa 99)
const TT_CACHE_DAYS = 7;
const TT_MAX_CALLS = 40;       // buscas por rota, no máximo
const TT_CACHE_MAX = 300;      // buscas guardadas no cache

// Tipos de estabelecimento (na ordem dos botões). osm: etiquetas do OpenStreetMap; food: na TomTom fica dentro
// de "Restaurant" (7315); tt: nomes de categoria da TomTom; txt: palavras no nome ou na categoria (sem acento);
// words: busca por nome no plano B (Photon).
const CATS = {
  restaurante: { label: 'Restaurantes', on: true, food: true, osm: ['amenity=restaurant', 'amenity=food_court'], tt: /^restaurant$/i, txt: null, words: ['restaurante', 'comida', 'cantina', 'buffet'] },
  pizzaria: { label: 'Pizzarias', on: true, food: true, osm: ['amenity=restaurant', 'amenity=fast_food'], tt: /pizza/i, txt: /pizz/, words: ['pizzaria'] },
  churrascaria: { label: 'Churrascarias', on: true, food: true, osm: ['amenity=restaurant'], tt: /barbecue|steak house|grill/i, txt: /churrasc|steak|barbecue|bbq|espeto|galeto|costela|parrilla|assados|\bgrill/, words: ['churrascaria', 'espeto', 'galeto'] },
  japones: { label: 'Japonês', on: true, food: true, osm: ['amenity=restaurant'], tt: /japanese|sushi|teppanyaki/i, txt: /japon|japan|sushi|temak|sashimi|yakisoba|teppan|\bpoke\b|ramen/, words: ['sushi', 'japonês', 'temakeria'] },
  hamburgueria: { label: 'Hamburguerias', on: true, food: true, osm: ['amenity=fast_food', 'amenity=restaurant'], tt: /hamburger/i, txt: /hamburg|burger|smash/, words: ['hamburgueria', 'burger'] },
  lanchonete: { label: 'Lanchonetes', on: true, food: true, osm: ['amenity=fast_food'], tt: /fast food|snacks|sandwich|takeout/i, txt: /lanch|fast food|snack|sanduich|sandwich|pastel|esfiha|cachorro|hot ?dog|takeout|take ?away|salgad/, words: ['lanchonete', 'lanches', 'pastel', 'esfiha'] },
  bar: { label: 'Bares', on: true, osm: ['amenity=bar', 'amenity=pub', 'amenity=biergarten'], tt: /^(bar|pub|cocktail bar|wine bar)$/i, txt: /\bbar\b|boteco|botequim|\bpub\b|choperia|chopp|cervejaria|petiscaria|nightlife/, words: ['bar', 'boteco', 'choperia'] },
  sorveteria: { label: 'Sorveterias e açaí', on: false, food: true, osm: ['amenity=ice_cream'], tt: /ice cream|yogurt/i, txt: /sorvet|gelato|ice cream|acai|yogurt|iogurte|frozen|paleteria/, words: ['sorveteria', 'açaí', 'gelato'] },
  padaria: { label: 'Padarias', on: false, osm: ['shop=bakery', 'shop=pastry'], tt: /^bakery$/i, txt: /padaria|panificadora|panificacao|confeitaria|bakery|baker|pastry|doceria/, words: ['padaria', 'panificadora', 'confeitaria'] },
  cafe: { label: 'Cafés', on: false, osm: ['amenity=cafe'], tt: /^caf[eé]$|coffee shop|cafeteria|tea house/i, txt: /\bcafe\b|cafeteria|coffee|tea house/, words: ['café', 'cafeteria'] },
  acougue: { label: 'Açougues', on: false, osm: ['shop=butcher'], tt: /^butcher$/i, txt: /acougue|butcher|casa de carnes/, words: ['açougue', 'carnes'] },
};
// Ordem de classificação: o tipo mais específico primeiro ("Pizzaria e Lanchonete" é pizzaria).
const CAT_PRIORITY = ['sorveteria', 'pizzaria', 'japones', 'churrascaria', 'hamburgueria', 'padaria', 'acougue',
  'cafe', 'lanchonete', 'bar', 'restaurante'];
const STATUS = {
  visitado: 'Visitado', interessado: 'Interessado', cliente: 'Cliente', sem_interesse: 'Sem interesse',
};
const MAX_STOPS = 99;          // o OSRM público aceita até 100 pontos por rota (99 paradas + você)
const MAX_LIST = 400;          // itens na aba "Todos por perto" (raios grandes trazem milhares)

// ---------- storage ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('rv:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rv:' + k, JSON.stringify(v)); } catch { /* sem espaço / modo privado */ } },
};

const state = {
  origin: store.get('origin', null),       // {lat, lon, label}
  cats: { ...Object.fromEntries(Object.entries(CATS).map(([k, c]) => [k, c.on])), ...store.get('cats', {}) },
  marks: store.get('marks', {}),           // id -> {s: status, n: nota, t: timestamp}
  imported: store.get('imported', []),     // lugares do CSV importado
  bundled: [],                             // lugares de restaurantes.json
  region: null,                            // base OSM salva (regiao-osm.json): {name, bbox, updated, places}
  nearby: [],                              // todos na região (ordenados por distância)
  route: null,                             // {stops, legs, geometry, km, min, engine}
  tab: 'rota',
  selected: null,
  horario: { modo: 'qualquer', dia: 0, hora: '10:00', semInfo: true, ...store.get('horario', {}) },
};

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtKm = (m) => (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const fmtDist = (m) => (m < 1000 ? Math.round(m) + ' m' : fmtKm(m) + ' km');

function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(restaurante|lanchonete|bar|e|de|do|da|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function sameName(a, b) {
  const x = normName(a), y = normName(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

async function fetchJson(url, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// ---------- categorias ----------
// Tipo pelas palavras do nome/categoria; se nenhuma bater, fica o tipo da fonte (etiqueta OSM, categoria TomTom).
function classify(text, base = 'restaurante') {
  const t = fold(text);
  return CAT_PRIORITY.find((k) => CATS[k].txt?.test(t)) || base;
}
const OSM_BASE = {
  'amenity=restaurant': 'restaurante', 'amenity=food_court': 'restaurante', 'amenity=fast_food': 'lanchonete',
  'amenity=bar': 'bar', 'amenity=pub': 'bar', 'amenity=biergarten': 'bar', 'amenity=ice_cream': 'sorveteria',
  'shop=bakery': 'padaria', 'shop=pastry': 'padaria', 'amenity=cafe': 'cafe', 'shop=butcher': 'acougue',
};
function catFromOsm(tags) {
  const kv = Object.keys(OSM_BASE).find((x) => { const [a, b] = x.split('='); return tags[a] === b; });
  return classify(`${tags.cuisine || ''} ${tags.name || ''}`, OSM_BASE[kv] || 'restaurante');
}

// ---------- fontes de dados ----------
async function fetchOsm(origin, radius) {
  const filters = [...new Set(Object.entries(CATS).filter(([k]) => state.cats[k]).flatMap(([, c]) => c.osm))];
  if (!filters.length) return [];
  const around = `(around:${radius},${origin.lat},${origin.lon})`;
  const q = `[out:json][timeout:60];(${filters.map((f) => {
    const [k, v] = f.split('=');
    return `nwr["${k}"="${v}"]${around};`;
  }).join('')});out center tags;`;
  // Os servidores Overpass são gratuitos e às vezes ficam lentos: pergunta a todos e usa o primeiro que responder.
  const data = await Promise.any(OVERPASS.map((url) =>
    fetchJson(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 60000)));
  return data.elements
    .map((e) => {
      const t = e.tags || {};
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      if (lat == null || !t.name) return null;
      const addr = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ')
        + (t['addr:suburb'] ? ' - ' + t['addr:suburb'] : '');
      return {
        id: `osm:${e.type}/${e.id}`, src: 'osm', name: t.name, cat: catFromOsm(t),
        catText: t.cuisine ? t.cuisine.replace(/_/g, ' ').replace(/;/g, ', ') : '',
        lat, lon, phone: t.phone || t['contact:phone'] || '', website: t.website || t['contact:website'] || '',
        address: addr, hours: hoursFromOsm(t.opening_hours),
      };
    })
    .filter(Boolean);
}

// Plano B quando o Overpass cai: Photon busca por nome, então acha menos lugares (só quem tem a palavra no nome).
async function fetchPhoton(origin) {
  const reqs = Object.entries(CATS).filter(([k]) => state.cats[k]).flatMap(([k, c]) => {
    const tags = c.osm.map((kv) => '&osm_tag=' + kv.replace('=', ':')).join('');
    return c.words.map((w) => fetchJson(`${PHOTON}?q=${encodeURIComponent(w)}&lat=${origin.lat}&lon=${origin.lon}`
      + `&limit=50&zoom=16&location_bias_scale=0.1${tags}`, {}, 15000)
      .then((j) => j.features.map((f) => ({ f, cat: k }))).catch(() => []));
  });
  const seen = new Map();
  for (const { f, cat } of (await Promise.all(reqs)).flat()) {
    const pr = f.properties;
    const id = `osm:${{ N: 'node', W: 'way', R: 'relation' }[pr.osm_type]}/${pr.osm_id}`;
    if (!pr.name || seen.has(id)) continue;
    const [lon, lat] = f.geometry.coordinates;
    seen.set(id, {
      id, src: 'osm', name: pr.name, cat: classify(pr.name, cat), catText: '', lat, lon, phone: '', website: '',
      address: [pr.street, pr.housenumber].filter(Boolean).join(', ') + (pr.district ? ' - ' + pr.district : ''),
    });
  }
  return [...seen.values()];
}

function fromScraperRow(r) {
  const lat = parseFloat(r.latitude ?? r.lat), lon = parseFloat(r.longitude ?? r.lon ?? r.lng);
  const name = r.title || r.name;
  if (!isFinite(lat) || !isFinite(lon) || !name) return null;
  const key = r.place_id || r.cid || r.data_id || `${name}@${lat.toFixed(5)},${lon.toFixed(5)}`;
  return {
    id: 'g:' + key, src: 'google', name, cat: classify((r.category || '') + ' ' + name), catText: r.category || '',
    lat, lon, phone: r.phone || '', website: r.website || '', address: r.address || '',
    rating: parseFloat(r.review_rating ?? r.rating) || null, reviews: parseInt(r.review_count ?? r.reviews, 10) || null,
    link: r.link || '', hours: hoursFromGoogle(r.open_hours),
  };
}

async function loadBundled() {
  try {
    const rows = await fetchJson('restaurantes.json', { cache: 'no-cache' }, 15000);
    state.bundled = (Array.isArray(rows) ? rows : []).map(fromScraperRow).filter(Boolean);
  } catch { state.bundled = []; }
}

// Base do OpenStreetMap salva no site (scripts/osm_region.py): dentro da região, não depende do Overpass.
async function loadRegion() {
  try {
    const r = await fetchJson('regiao-osm.json', { cache: 'no-cache' }, 20000);
    r.places = r.places.map(([id, name, cat, lat, lon, phone, website, address, cuisine, hours]) => ({
      id, src: 'osm', name, cat: classify(`${cuisine} ${name}`, CATS[cat] ? cat : 'restaurante'), catText: cuisine,
      lat, lon, phone, website, address, hours: hoursFromOsm(hours),
    }));
    state.region = r;
  } catch { state.region = null; }
}

function inRegion(p) {
  const b = state.region?.bbox;
  return !!b && p.lat >= b[0] && p.lat <= b[2] && p.lon >= b[1] && p.lon <= b[3];
}

function scraperPlaces() {
  const byId = new Map();
  for (const p of [...state.bundled, ...state.imported]) byId.set(p.id, p);
  return [...byId.values()];
}

// Junta OSM + Google: se for o mesmo lugar (perto e nome parecido), fica o do Google (tem nota e telefone).
function merge(osm, google) {
  const out = [...google];
  for (const o of osm) {
    const dup = google.find((g) => haversine(o, g) < 120 && sameName(o.name, g.name));
    if (dup) {
      if (!dup.phone && o.phone) dup.phone = o.phone;
      if (!dup.hours && o.hours) dup.hours = o.hours;
    } else out.push(o);
  }
  return out;
}

// ---------- TomTom ao vivo (Search API, plano grátis: 2.500 buscas/dia, sem cartão) ----------
// Chave padrão do site (config.js); uma chave colada no menu ⋯ tem prioridade neste aparelho.
const SITE_TT_KEY = window.RV_CONFIG?.tomtomKey || '';
const ttcfg = () => {
  const s = store.get('tomtom', {});
  return { on: !!SITE_TT_KEY, daily: 2000, ...s, key: s.key || SITE_TT_KEY };
};

function ttusage() {
  const now = new Date(), month = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
  const u = store.get('ttusage', {});
  return { month, day, monthCalls: u.month === month ? u.monthCalls : 0, dayCalls: u.day === day ? u.dayCalls : 0 };
}

async function ttFetch(path, params, key) {
  const r = await fetch(`${TOMTOM}/${path}?` + new URLSearchParams({ ...params, key }));
  const u = ttusage();
  store.set('ttusage', { month: u.month, monthCalls: u.monthCalls + 1, day: u.day, dayCalls: u.dayCalls + 1 });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.errorText || data.detailedError?.message || data.error?.description || 'HTTP ' + r.status;
    throw new Error('TomTom: ' + msg);
  }
  return data;
}

// Os códigos numéricos de categoria da TomTom não são fixos na documentação: baixa a lista oficial
// uma vez (1 busca) e escolhe os códigos pelo nome de cada categoria.
async function ttCategories(key) {
  const c = store.get('ttcats2', null);
  if (c && Date.now() - c.t < 30 * 864e5) return c.byCat;
  const data = await ttFetch('poiCategories.json', { language: 'en-US' }, key);
  const byCat = Object.fromEntries(Object.entries(CATS).map(([k, cat]) =>
    [k, data.poiCategories.filter((pc) => cat.tt.test(pc.name)).map((pc) => pc.id)]));
  store.set('ttcats2', { t: Date.now(), byCat });
  return byCat;
}

// Tipo de um lugar da TomTom: palavras do nome/categorias primeiro; senão, o código de categoria.
function ttClassify(p, byCat) {
  const base = CAT_PRIORITY.find((k) => byCat?.[k]?.some((id) => p.catIds.includes(id))) || 'restaurante';
  return classify(`${p.cats.join(' ')} ${p.name}`, base);
}

// Cache = lista de "círculos conhecidos": dentro de cada um já sabemos todos os lugares (da TomTom).
// Vale para qualquer ponto de partida, então andar alguns quarteirões não gasta buscas de novo.
function ttcacheLoad() {
  const limit = Date.now() - TT_CACHE_DAYS * 864e5;
  const c = store.get('ttcache2', []);
  return (Array.isArray(c) ? c : []).filter((d) => d.t > limit);
}

function ttPlace(r) {
  const poi = r.poi || {}, cats = poi.categories || [];
  const name = poi.name || '?', address = r.address?.freeformAddress || '';
  const url = poi.url ? (/^https?:/i.test(poi.url) ? poi.url : 'http://' + poi.url) : '';
  return {
    id: 'tt:' + r.id, src: 'tomtom', live: true, name, cats, catIds: (poi.categorySet || []).map((c) => c.id),
    catText: cats[0] ? cats[0][0].toUpperCase() + cats[0].slice(1) : '',
    hours: hoursFromTomTom(poi.openingHours),
    lat: r.position.lat, lon: r.position.lon, phone: poi.phone || '', website: url, address,
    // Nota e avaliações: abre a busca do lugar no Google Maps (grátis).
    link: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name + ' ' + address)}`,
  };
}

// A TomTom devolve só os 100 lugares mais próximos de cada ponto (sem paginar além disso). A cada passo,
// busca no ponto ainda não coberto mais perto de você. Para quando os TT_TARGET mais próximos estão
// garantidos, quando cobriu o raio todo ou quando acaba o limite do dia (aí falta só a parte mais distante).
async function fetchTomTomLive(origin, radius, keep) {
  const cfg = ttcfg();
  const byCat = await ttCategories(cfg.key);
  const all = [...new Set(Object.keys(CATS).filter((k) => state.cats[k])
    .flatMap((k) => (CATS[k].food ? byCat.restaurante : byCat[k]) || []))];
  // Subcategoria (7 dígitos) já vem junto com a categoria-mãe (4 dígitos): 7315015 ⊂ 7315.
  const ids = all.filter((id) => !(id >= 1e6 && all.includes(Math.floor(id / 1000)))).sort((a, b) => a - b);
  const out = { places: new Map(), calls: 0, cached: 0, truncated: false, enough: false };
  // A TomTom aceita no máximo 10 categorias por busca: divide em grupos se precisar.
  for (let g = 0; g < ids.length && !out.truncated; g += 10) {
    await ttSearchGroup(origin, radius, ids.slice(g, g + 10).join(','), byCat, cfg, out, keep);
  }
  out.places = [...out.places.values()].map((p) => ({ ...p, cat: ttClassify(p, byCat) }));
  return out;
}

async function ttSearchGroup(origin, radius, group, byCat, cfg, out, keep) {
  // Coordenadas planas em metros a partir de você (precisas o bastante para alguns km).
  const kx = 111320 * Math.cos(origin.lat * Math.PI / 180), ky = 111320;
  const xy = (p) => [(p.lon - origin.lon) * kx, (p.lat - origin.lat) * ky];
  const toLL = ([x, y]) => ({ lat: origin.lat + y / ky, lon: origin.lon + x / kx });

  // Uma busca com mais categorias também vale para um subconjunto delas.
  const ids = group.split(',');
  const disks = ttcacheLoad().filter((d) => ids.every((id) => d.group.split(',').includes(id))).map((d) => ({ ...d, c: xy(d) }))
    .filter((d) => Math.hypot(...d.c) - d.r < radius);
  out.cached += disks.length;
  const found = new Map();
  for (const d of disks) for (const p of d.places) found.set(p.id, p);

  const covered = ([x, y]) => disks.some((d) => Math.hypot(x - d.c[0], y - d.c[1]) < d.r);
  const nearestUncovered = () => {
    let best = null, bestD = Infinity;
    const test = (pt) => {
      const d = Math.hypot(...pt);
      if (d < bestD && d <= radius && !covered(pt)) { best = pt; bestD = d; }
    };
    test([0, 0]);
    for (const d of disks) {
      if (Math.hypot(...d.c) - d.r - 1 > bestD) continue;   // borda toda mais longe que o melhor ponto
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * 2 * Math.PI, rr = d.r + 1;
        test([d.c[0] + rr * Math.cos(a), d.c[1] + rr * Math.sin(a)]);
      }
    }
    return best && { pt: best, d: bestD };
  };

  for (;;) {
    const next = nearestUncovered();
    if (!next) break;                                   // raio todo coberto
    // Conta só os que passam nos filtros (tipo e horário): com filtro apertado, busca mais longe.
    const closer = [...found.values()].filter((p) => haversine(origin, p) < next.d && keep({ ...p, cat: ttClassify(p, byCat) })).length;
    if (closer >= TT_TARGET) { out.enough = true; break; }
    if (ttusage().dayCalls >= cfg.daily || out.calls >= TT_MAX_CALLS) { out.truncated = true; break; }
    const pt = toLL(next.pt), qr = Math.round(radius + next.d);
    const data = await ttFetch('nearbySearch/.json', {
      lat: pt.lat.toFixed(6), lon: pt.lon.toFixed(6), radius: qr, limit: 100, categorySet: group,
      language: 'pt-BR', countrySet: 'BR', openingHours: 'nextSevenDays',
    }, cfg.key);
    out.calls++;
    const results = (data.results || []).filter((r) => r.position);
    const far = results.reduce((m, r) => Math.max(m, haversine(pt, r.position)), 0);
    const full = (data.summary?.totalResults ?? 0) >= 100;
    const places = results.map(ttPlace);
    // Vários lugares no mesmo prédio podem dar raio ~0: garante um mínimo para a busca sempre avançar.
    const disk = { lat: pt.lat, lon: pt.lon, r: full ? Math.max(25, far * 0.999) : qr, t: Date.now(), group, places };
    const cache = [...ttcacheLoad(), disk].slice(-TT_CACHE_MAX);
    store.set('ttcache2', cache);
    if (store.get('ttcache2', null)?.length !== cache.length) store.set('ttcache2', cache.slice(-Math.floor(cache.length / 2)));
    disks.push({ ...disk, c: next.pt });
    for (const p of places) found.set(p.id, p);
  }
  for (const [id, p] of found) out.places.set(id, p);
}

function updateTomTomInfo() {
  const cfg = ttcfg(), u = ttusage();
  $('#txtTTUso').textContent = `Uso neste aparelho: ${u.dayCalls} de ${cfg.daily} buscas hoje · ${u.monthCalls} neste mês. `
    + `Buscas guardadas no cache: ${ttcacheLoad().length}.`;
}

// ---------- rota ----------
async function osrmTrip(origin, stops) {
  const pts = [origin, ...stops];
  const coords = pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${OSRM}/trip/v1/driving/${coords}?source=first&roundtrip=false&destination=any`
    + '&overview=full&geometries=geojson';
  const data = await fetchJson(url, {}, 30000);
  if (data.code !== 'Ok' || !data.trips?.length) throw new Error(data.message || data.code);
  const order = [];
  data.waypoints.forEach((w, i) => { order[w.waypoint_index] = i; });
  const trip = data.trips[0];
  return {
    stops: order.slice(1).map((i) => stops[i - 1]),
    legs: trip.legs.map((l) => ({ m: l.distance, s: l.duration })),
    geometry: trip.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    km: trip.distance, min: trip.duration / 60, engine: 'osrm',
  };
}

// Plano B sem internet do OSRM: vizinho mais próximo + 2-opt em linha reta.
function localTrip(origin, stops) {
  const pts = [origin, ...stops];
  const n = pts.length;
  const D = pts.map((a) => pts.map((b) => haversine(a, b) * 1.35));
  let tour = [0];
  const left = new Set(pts.map((_, i) => i).slice(1));
  while (left.size) {
    const last = tour[tour.length - 1];
    let best = null;
    for (const j of left) if (best === null || D[last][j] < D[last][best]) best = j;
    tour.push(best); left.delete(best);
  }
  const cost = (t) => t.reduce((s, v, i) => (i ? s + D[t[i - 1]][v] : 0), 0);
  let improved = true, guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const cand = [...tour.slice(0, i), ...tour.slice(i, k + 1).reverse(), ...tour.slice(k + 1)];
        if (cost(cand) + 1e-6 < cost(tour)) { tour = cand; improved = true; }
      }
    }
  }
  const seq = tour;
  const legs = seq.slice(1).map((v, i) => { const m = D[seq[i]][v]; return { m, s: m / (22 / 3.6) }; });
  const km = legs.reduce((s, l) => s + l.m, 0);
  return {
    stops: tour.slice(1).map((i) => stops[i - 1]), legs,
    geometry: seq.map((i) => [pts[i].lat, pts[i].lon]),
    km, min: legs.reduce((s, l) => s + l.s, 0) / 60, engine: 'local',
  };
}

// ---------- mapa ----------
const map = L.map('mapa', { zoomControl: true, preferCanvas: true }).setView([-27.59, -48.6], 11); // Grande Florianópolis
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap',
}).addTo(map);
new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById('mapa'));
const layers = { all: L.layerGroup().addTo(map), route: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map) };
const markerById = new Map();

const ST_COLOR = { visitado: '#2f7d4a', interessado: '#c48a12', cliente: '#2b62b8', sem_interesse: '#9a9a9a' };

function drawOrigin() {
  layers.me.clearLayers();
  if (!state.origin) return;
  const { lat, lon } = state.origin;
  L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18] }), zIndexOffset: 1000 })
    .addTo(layers.me).bindTooltip('Você está aqui');
  L.circle([lat, lon], { radius: +$('#selRaio').value, color: '#1f6feb', weight: 1, fillOpacity: 0.04, interactive: false }).addTo(layers.me);
}

function popupHtml(p) {
  const m = state.marks[p.id];
  return `<b>${esc(p.name)}</b><br>${esc(CATS[p.cat]?.label || '')}${p.catText ? ' · ' + esc(p.catText) : ''}`
    + (p.hours ? `<br>${esc(describeHours(p.hours, new Date()))}` : '')
    + (p.rating ? `<br>⭐ ${p.rating} (${p.reviews || 0})` : '')
    + (p.phone ? `<br><a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : '')
    + (m?.s ? `<br><i>${STATUS[m.s]}</i>` : '')
    + `<br><a href="${navUrl(p)}" target="_blank" rel="noopener">Ir até lá</a>`;
}

function drawMarkers() {
  layers.all.clearLayers();
  layers.route.clearLayers();
  markerById.clear();
  const inRoute = new Map((state.route?.stops || []).map((p, i) => [p.id, i + 1]));
  for (const p of state.nearby) {
    if (inRoute.has(p.id)) continue;
    const st = state.marks[p.id]?.s;
    const mk = L.circleMarker([p.lat, p.lon], {
      radius: 6, weight: 1.5, color: '#fff', fillColor: ST_COLOR[st] || '#7a6f66', fillOpacity: 0.9,
    }).bindPopup(() => popupHtml(p)).addTo(layers.all);
    mk.on('click', () => select(p.id, false));
    markerById.set(p.id, mk);
  }
  if (state.route) {
    L.polyline(state.route.geometry, { color: '#b4441f', weight: 5, opacity: 0.8, dashArray: state.route.engine === 'local' ? '8 8' : null })
      .addTo(layers.route);
    state.route.stops.forEach((p, i) => {
      const done = !!state.marks[p.id]?.s;
      const mk = L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: '', html: `<div class="pin${done ? ' done' : ''}">${i + 1}</div>`, iconSize: [26, 26] }),
      }).bindPopup(() => popupHtml(p)).addTo(layers.route);
      mk.on('click', () => select(p.id, false));
      markerById.set(p.id, mk);
    });
  }
}

// ---------- links externos ----------
const ll = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
function navUrl(p) {
  return `https://www.google.com/maps/dir/?api=1&destination=${ll(p)}&travelmode=driving`;
}
function wazeUrl(p) { return `https://waze.com/ul?ll=${ll(p)}&navigate=yes`; }

// Google Maps aceita poucas paradas por link (3 no celular, 9 no computador): divide a rota em trechos.
function gmapsLinks(origin, stops) {
  const seq = stops;
  const per = matchMedia('(pointer: coarse)').matches ? 4 : 10;
  const links = [];
  let from = origin;
  for (let i = 0; i < seq.length; i += per) {
    const chunk = seq.slice(i, i + per);
    const dest = chunk[chunk.length - 1];
    const wps = chunk.slice(0, -1).map(ll).join('|');
    links.push({
      label: `Paradas ${i + 1}–${Math.min(i + per, stops.length)}`,
      url: `https://www.google.com/maps/dir/?api=1&origin=${ll(from)}&destination=${ll(dest)}`
        + (wps ? `&waypoints=${encodeURIComponent(wps)}` : '') + '&travelmode=driving',
    });
    from = dest;
  }
  return links;
}

// ---------- fluxo principal ----------
function setOrigin(lat, lon, label) {
  state.origin = { lat, lon, label: label || `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
  store.set('origin', state.origin);
  $('#txtOrigem').textContent = '📍 ' + state.origin.label;
  $('#btnRota').disabled = false;
  drawOrigin();
  map.setView([lat, lon], 15);
}

async function buildRoute() {
  if (!state.origin) return toast('Diga primeiro onde você está.');
  const btn = $('#btnRota');
  const radius = +$('#selRaio').value;
  btn.disabled = true;
  btn.textContent = '⏳ Procurando restaurantes...';
  try {
    await regionReady;
    const cfg = ttcfg();
    const when = horarioAlvo();
    const keep = (p) => state.cats[p.cat] && passaHorario(p, when);
    let live = null;
    if (cfg.on && cfg.key) {
      btn.textContent = '⏳ Buscando na TomTom...';
      try { live = await fetchTomTomLive(state.origin, radius, keep); } catch (e) {
        console.warn(e);
        toast(e.message + ' — usando a base do OpenStreetMap.', 7000);
      }
    }
    let osm = [], fallback = false;
    const saved = !live && inRegion(state.origin);
    if (live) {
      // TomTom ao vivo substitui o OpenStreetMap (que pode estar desatualizado).
      osm = live.places;
    } else if (saved) {
      osm = state.region.places;
    } else {
      try { osm = await fetchOsm(state.origin, radius); } catch (e) {
        console.warn('Overpass falhou, usando Photon', e);
        fallback = true;
        osm = await fetchPhoton(state.origin);
      }
    }
    const google = scraperPlaces().map((p) => ({ ...p }));
    const inRadius = merge(osm, google)
      .map((p) => ({ ...p, dist: haversine(state.origin, p) }))
      .filter((p) => p.dist <= radius);
    const all = inRadius.filter(keep).sort((a, b) => a.dist - b.dist);
    state.nearby = all;
    state.when = when;

    const nG = all.filter((p) => p.src === 'google').length;
    const nLive = all.filter((p) => p.live).length;
    const updated = saved ? state.region.updated.split('-').reverse().join('/') : '';
    const semInfo = when ? all.filter((p) => !p.hours).length : 0;
    const filtroTxt = (when ? ` · ${all.length - semInfo} abertos ${descreveAlvo(when)}`
      + (semInfo ? ` + ${semInfo} sem horário informado` : '') : '')
      + (inRadius.length > all.length ? ` · ${inRadius.length - all.length} fora dos filtros` : '');
    $('#txtFonte').textContent = live
      ? `${nLive} da TomTom ao vivo (${live.calls} buscas novas, ${live.cached} do cache · `
        + `hoje ${ttusage().dayCalls}/${cfg.daily}) · ${nG} do scraper (Google Maps)`
        + (live.enough ? ` · mostrando os ${TT_TARGET} mais próximos para economizar buscas` : '')
        + (live.truncated ? ' · ⚠️ limite de buscas atingido: a parte mais distante pode estar incompleta' : '')
      : `${all.length - nG} do OpenStreetMap`
      + (saved ? ` (base salva de ${state.region.name}, ${updated})` : '')
      + ` · ${nG} do scraper (Google Maps)`
      + (fallback ? ' · ⚠️ OpenStreetMap lento: busca reduzida, tente de novo mais tarde' : '')
      + (all.length < 30 && !nG && !fallback ? ' · ⚠️ O OpenStreetMap tem poucos lugares cadastrados nesta região. '
        + 'Para ver todos, use os dados do Google Maps (scraper): menu ⋯ → Importar CSV.' : '');
    $('#txtFonte').textContent += filtroTxt;

    const cands = all.slice(0, MAX_STOPS);
    if (!cands.length) {
      state.route = null;
      render();
      return toast(inRadius.length ? 'Nenhum lugar passa nos filtros. Mude o tipo ou o horário.' : 'Nenhum restaurante encontrado. Aumente o raio.');
    }

    btn.textContent = '⏳ Calculando a melhor rota...';
    try {
      state.route = await osrmTrip(state.origin, cands);
    } catch (e) {
      console.warn('OSRM falhou, usando rota local', e);
      state.route = localTrip(state.origin, cands);
      toast('Servidor de rotas indisponível: ordem calculada em linha reta (aproximada).');
    }
    state.tab = 'rota';
    render();
    const b = L.latLngBounds([[state.origin.lat, state.origin.lon], ...cands.map((p) => [p.lat, p.lon])]);
    map.fitBounds(b, { padding: [30, 30] });
  } finally {
    btn.disabled = false;
    btn.textContent = '🚗 Buscar restaurantes e montar rota';
  }
}

// ---------- filtro de horário ----------
const sameDay = (a, b) => a.toDateString() === b.toDateString();

// Data/hora que o lugar precisa estar aberto, ou null (qualquer horário).
function horarioAlvo() {
  const h = state.horario;
  if (h.modo === 'agora') return new Date();
  if (h.modo !== 'hora') return null;
  const d = new Date();
  d.setDate(d.getDate() + (+h.dia || 0));
  const [hh, mm] = (h.hora || '10:00').split(':').map(Number);
  d.setHours(hh, mm, 0, 0);
  return d;
}
function passaHorario(p, when) {
  if (!when) return true;
  const o = openAt(p.hours, when);
  return o === true || (o === null && state.horario.semInfo);
}
function descreveAlvo(when) {
  if (state.horario.modo === 'agora') return 'agora';
  const dia = sameDay(when, new Date()) ? 'hoje' : DIAS[when.getDay()];
  return `${dia} às ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
}

// ---------- lista ----------
function itemHtml(p, idx, leg) {
  const m = state.marks[p.id] || {};
  const meta = [
    CATS[p.cat]?.label + (p.catText && fold(p.catText) !== fold(CATS[p.cat]?.label) ? ` (${p.catText})` : ''),
    p.rating ? `⭐ ${p.rating}${p.reviews ? ` (${p.reviews})` : ''}` : '',
    leg ? `+${fmtDist(leg.m)} · ${Math.max(1, Math.round(leg.s / 60))} min` : fmtDist(p.dist),
    p.closedNow ? '⚠️ fechado temporariamente' : '',
  ].filter(Boolean).join(' · ');
  const now = new Date();
  const hor = p.hours ? `${describeHours(p.hours, now)} · hoje ${hoursOfDay(p.hours, now)}`
    + (state.when && !sameDay(state.when, now) ? ` · ${DIAS[state.when.getDay()]} ${hoursOfDay(p.hours, state.when)}` : '')
    : 'Horário não informado';
  return `<li class="item${state.selected === p.id ? ' sel' : ''}" data-id="${esc(p.id)}" data-st="${m.s || ''}">
    <div class="item-top">
      <span class="num${idx ? '' : ' dot'}">${idx || '•'}</span>
      <div>
        <h3 data-act="focus">${esc(p.name)}</h3>
        <div class="meta">${esc(meta)}</div>
        ${p.address ? `<div class="meta">${esc(p.address)}</div>` : ''}
        <div class="meta hor${p.hours ? '' : ' unknown'}">${esc(hor)}</div>
      </div>
    </div>
    <div class="acts">
      <a href="${navUrl(p)}" target="_blank" rel="noopener">🧭 Google Maps</a>
      <a href="${wazeUrl(p)}" target="_blank" rel="noopener">🚙 Waze</a>
      ${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">⭐ Ficha Google</a>` : ''}
      ${p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">📞 Ligar</a>` : ''}
      ${p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener">🌐 Site</a>` : ''}
    </div>
    <div class="status">${Object.entries(STATUS).map(([k, v]) =>
      `<button data-act="status" data-s="${k}" class="${m.s === k ? 'on' : ''}">${v}</button>`).join('')}</div>
    <textarea class="nota" data-act="nota" rows="1" placeholder="Anotação (falou com quem, retorno...)">${esc(m.n || '')}</textarea>
  </li>`;
}

function render() {
  const r = state.route;
  $('#resumo').classList.toggle('hidden', !state.nearby.length && !r);
  $('#tabs').classList.toggle('hidden', !state.nearby.length);
  $('#stTotal').textContent = state.nearby.length;
  $('#stParadas').textContent = r ? r.stops.length : 0;
  $('#stKm').textContent = r ? fmtKm(r.km) : 0;
  $('#stMin').textContent = r ? Math.round(r.min) : 0;
  $('#linksGmaps').innerHTML = r
    ? gmapsLinks(state.origin, r.stops).map((l) => `<a href="${l.url}" target="_blank" rel="noopener">▶ ${esc(l.label)}</a>`).join('')
    : '';
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));

  const list = $('#lista');
  if (state.tab === 'rota' && r) {
    list.innerHTML = r.stops.map((p, i) => itemHtml(p, i + 1, r.legs[i])).join('');
  } else if (state.nearby.length) {
    const inRoute = new Map((r?.stops || []).map((p, i) => [p.id, i + 1]));
    list.innerHTML = state.nearby.slice(0, MAX_LIST).map((p) => itemHtml(p, inRoute.get(p.id), null)).join('')
      + (state.nearby.length > MAX_LIST
        ? `<li class="empty">Mostrando os ${MAX_LIST} mais próximos de ${state.nearby.length}. Todos aparecem no mapa.</li>` : '');
  } else {
    list.innerHTML = state.origin ? '' : '<li class="empty">Comece dizendo onde você está 👆</li>';
  }
  drawMarkers();
}

function findPlace(id) {
  return state.nearby.find((p) => p.id === id) || state.route?.stops.find((p) => p.id === id);
}

function select(id, pan = true) {
  state.selected = id;
  document.querySelectorAll('.item.sel').forEach((el) => el.classList.remove('sel'));
  const el = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  if (el) { el.classList.add('sel'); if (!pan) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  const p = findPlace(id);
  if (p && pan) {
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16));
    markerById.get(id)?.openPopup();
    if (matchMedia('(max-width: 760px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function setMark(id, patch) {
  const cur = state.marks[id] || {};
  const next = { ...cur, ...patch, t: Date.now() };
  if (!next.s && !next.n) delete state.marks[id]; else state.marks[id] = next;
  store.set('marks', state.marks);
}

// ---------- CSV / backup ----------
function exportCsv() {
  const r = state.route;
  if (!r) return;
  const rows = r.stops.map((p, i) => ({
    ordem: i + 1, nome: p.name, tipo: CATS[p.cat]?.label, categoria: p.catText, endereco: p.address, telefone: p.phone,
    horario_hoje: p.hours ? hoursOfDay(p.hours, new Date()) : '',
    nota_google: p.rating ?? '', avaliacoes: p.reviews ?? '', status: STATUS[state.marks[p.id]?.s] || '',
    anotacao: state.marks[p.id]?.n || '', latitude: p.lat, longitude: p.lon, google_maps: navUrl(p),
  }));
  download(`rota-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + Papa.unparse(rows), 'text/csv');
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importCsv(file) {
  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete: (res) => {
      const fields = res.meta.fields || [];
      if (!fields.includes('latitude') && !fields.includes('lat')) {
        $('#txtImport').textContent = '⚠️ Esse CSV não tem latitude/longitude. Rode o scraper com --full.';
        return;
      }
      const rows = res.data.map(fromScraperRow).filter(Boolean);
      const byId = new Map(state.imported.map((p) => [p.id, p]));
      rows.forEach((p) => byId.set(p.id, p));
      state.imported = [...byId.values()];
      store.set('imported', state.imported);
      updateImportInfo();
      toast(`${rows.length} lugares importados do scraper.`);
      if (state.origin && state.nearby.length) buildRoute();
    },
    error: (e) => { $('#txtImport').textContent = '⚠️ Erro lendo o CSV: ' + e.message; },
  });
}

function updateImportInfo() {
  $('#txtImport').textContent = `Importados neste aparelho: ${state.imported.length}`
    + (state.bundled.length ? ` · no site (restaurantes.json): ${state.bundled.length}` : '');
}

// ---------- eventos ----------
function renderChips() {
  $('#chipsCat').innerHTML = Object.entries(CATS).map(([k, c]) =>
    `<button class="chip${state.cats[k] ? ' on' : ''}" data-cat="${k}">${c.label}</button>`).join('');
}
$('#chipsCat').addEventListener('click', (e) => {
  const k = e.target.dataset.cat;
  if (!k) return;
  state.cats[k] = !state.cats[k];
  store.set('cats', state.cats);
  renderChips();
  refazerRota();
});

// Mudou um filtro depois de já ter uma rota: refaz (as buscas da TomTom vêm do cache).
let refazerTimer;
function refazerRota() {
  if (!state.origin || (!state.nearby.length && !state.route)) return;
  clearTimeout(refazerTimer);
  refazerTimer = setTimeout(buildRoute, 600);
}

function renderHorario() {
  const h = state.horario, hoje = new Date();
  $('#selDia').innerHTML = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = new Date(hoje);
    d.setDate(hoje.getDate() + i);
    const nome = i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : DIAS[d.getDay()];
    return `<option value="${i}">${nome} (${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')})</option>`;
  }).join('');
  $('#selHorario').value = h.modo;
  $('#selDia').value = String(h.dia);
  $('#txtHora').value = h.hora;
  $('#chkSemInfo').checked = h.semInfo;
  $('#rowHora').classList.toggle('hidden', h.modo !== 'hora');
  $('#rowSemInfo').classList.toggle('hidden', h.modo === 'qualquer');
}
['#selHorario', '#selDia', '#txtHora', '#chkSemInfo'].forEach((sel) => $(sel).addEventListener('change', () => {
  state.horario = {
    modo: $('#selHorario').value, dia: +$('#selDia').value, hora: $('#txtHora').value || '10:00',
    semInfo: $('#chkSemInfo').checked,
  };
  store.set('horario', state.horario);
  renderHorario();
  refazerRota();
}));

$('#btnGps').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Seu navegador não tem GPS.');
  $('#btnGps').textContent = '⏳ Localizando...';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('#btnGps').textContent = '📍 Usar minha localização';
      setOrigin(pos.coords.latitude, pos.coords.longitude, 'Minha localização (GPS)');
    },
    (err) => {
      $('#btnGps').textContent = '📍 Usar minha localização';
      toast(err.code === 1 ? 'Permita o acesso à localização no navegador.' : 'Não consegui pegar o GPS. Digite o endereço.');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
});

async function searchAddress() {
  const q = $('#txtEndereco').value.trim();
  if (!q) return;
  try {
    const res = await fetchJson(`${NOMINATIM}?format=json&limit=1&countrycodes=br&accept-language=pt-BR&q=${encodeURIComponent(q)}`, {}, 15000);
    if (!res.length) return toast('Endereço não encontrado.');
    setOrigin(+res[0].lat, +res[0].lon, res[0].display_name.split(',').slice(0, 3).join(','));
  } catch { toast('Falha ao buscar o endereço. Verifique a internet.'); }
}
$('#btnBuscarEnd').addEventListener('click', searchAddress);
$('#txtEndereco').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchAddress(); });

map.on('click', (e) => setOrigin(e.latlng.lat, e.latlng.lng, 'Ponto marcado no mapa'));
$('#selRaio').addEventListener('change', drawOrigin);
$('#btnRota').addEventListener('click', buildRoute);
$('#btnCsv').addEventListener('click', exportCsv);

$('#tabs').addEventListener('click', (e) => {
  if (!e.target.dataset.tab) return;
  state.tab = e.target.dataset.tab;
  render();
});

$('#lista').addEventListener('click', (e) => {
  const li = e.target.closest('.item');
  if (!li) return;
  const id = li.dataset.id;
  const act = e.target.dataset.act;
  if (act === 'focus') select(id);
  if (act === 'status') {
    const s = e.target.dataset.s;
    setMark(id, { s: state.marks[id]?.s === s ? undefined : s });
    li.dataset.st = state.marks[id]?.s || '';
    li.querySelectorAll('.status button').forEach((b) => b.classList.toggle('on', b.dataset.s === state.marks[id]?.s));
    drawMarkers();
  }
});
$('#lista').addEventListener('change', (e) => {
  if (e.target.dataset.act !== 'nota') return;
  setMark(e.target.closest('.item').dataset.id, { n: e.target.value.trim() });
});

$('#btnMenu').addEventListener('click', () => {
  const cfg = ttcfg();
  $('#chkTT').checked = cfg.on;
  $('#txtTTKey').value = store.get('tomtom', {}).key || '';
  $('#txtTTKey').placeholder = SITE_TT_KEY ? 'Usando a chave do site' : 'Cole a chave aqui';
  $('#numTTDia').value = cfg.daily;
  updateImportInfo();
  updateTomTomInfo();
  $('#dlgMenu').showModal();
});
['#chkTT', '#txtTTKey', '#numTTDia'].forEach((sel) => $(sel).addEventListener('change', () => {
  store.set('tomtom', {
    on: $('#chkTT').checked, key: $('#txtTTKey').value.trim(),
    daily: Math.min(2500, Math.max(0, +$('#numTTDia').value || 0)),
  });
  if ($('#chkTT').checked && !$('#txtTTKey').value.trim() && !SITE_TT_KEY) toast('Cole a chave da TomTom para ativar.');
}));
$('#btnTTCache').addEventListener('click', () => {
  store.set('ttcache2', []);
  store.set('ttcats2', null);
  updateTomTomInfo();
  toast('Cache da TomTom limpo.');
});
$('#fileCsv').addEventListener('change', (e) => { if (e.target.files[0]) importCsv(e.target.files[0]); e.target.value = ''; });
$('#btnLimparImport').addEventListener('click', () => {
  state.imported = [];
  store.set('imported', []);
  updateImportInfo();
});
$('#btnBackup').addEventListener('click', () => {
  download(`rota-vendas-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ marks: state.marks }, null, 1), 'application/json');
});
$('#fileBackup').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    for (const [id, m] of Object.entries(data.marks || {})) {
      if (!state.marks[id] || (m.t || 0) > (state.marks[id].t || 0)) state.marks[id] = m;
    }
    store.set('marks', state.marks);
    toast('Backup importado.');
    render();
  } catch { toast('Arquivo de backup inválido.'); }
  e.target.value = '';
});

// ---------- início ----------
renderChips();
renderHorario();
if (state.origin) setOrigin(state.origin.lat, state.origin.lon, state.origin.label);
render();
loadBundled();
const regionReady = loadRegion();
