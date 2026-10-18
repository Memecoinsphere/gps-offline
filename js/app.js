'use strict';
// GPS Hors Ligne — navigation 100 % dans le téléphone (MapLibre + PMTiles + routage local en Web Worker)
const $ = (s) => document.querySelector(s);
const BASE = location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
const PARAMS = new URLSearchParams(location.search);
const APP_VERSION = '1.0.0';
const S = { catalog: null, installed: new Map(), archives: [], remote: [], pos: null, heading: null, speed: 0, follow: true,
  dest: null, route: null, nav: false, progIdx: 0, along: 0, offCount: 0, lastReroute: 0, spoken: {}, wake: null, sim: null,
  lastSnapAt: 0, roadLimit: 0, tileVer: 0, downloads: new Map() };
const LS = { get: (k, d) => { try { const v = localStorage.getItem('gps.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: (k, v) => { try { localStorage.setItem('gps.' + k, JSON.stringify(v)); } catch (e) {} } };

// ---------------- utilitaires ----------------
function toast(t, ms = 2600) { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add('hidden'), ms); }
function fmtDist(m) { if (m < 950) { const r = m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50; return Math.max(r, 10) + ' m'; } return (m / 1000).toFixed(m < 9950 ? 1 : 0).replace('.', ',') + ' km'; }
function fmtDistSpeech(m) { if (m < 950) { const r = m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50; return Math.max(r, 10) + ' mètres'; }
  const km = m / 1000; if (km < 1.25) return 'un kilomètre'; return (Math.round(km * 2) / 2).toString().replace('.5', ' kilomètres et demi').replace(/^(\d+)$/, '$1 kilomètres'); }
function fmtDur(s) { const m = Math.round(s / 60); if (m < 60) return m + ' min'; return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0'); }
function fmtClock(d) { return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); }
function fmtMB(b) { return b >= 1e9 ? (b / 1e9).toFixed(2).replace('.', ',') + ' Go' : Math.round(b / 1e6) + ' Mo'; }
function hav(a, b, c, d) { const R = 6371008.8, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dp = p2 - p1, dl = (d - b) * Math.PI / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function brg(lat1, lon1, lat2, lon2) { const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
  return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360; }

// ---------------- worker de routage ----------------
const router = new Worker('js/router-worker.js');
let rpcId = 0; const pending = new Map();
router.onmessage = (ev) => { const p = pending.get(ev.data.id); if (!p) return; pending.delete(ev.data.id); ev.data.ok ? p.res(ev.data.r) : p.rej(new Error(ev.data.error)); };
const rpc = (cmd, args) => new Promise((res, rej) => { const id = ++rpcId; pending.set(id, { res, rej }); router.postMessage({ id, cmd, args }); });

// ---------------- sources PMTiles (téléphone + en ligne) ----------------
class BlobSource { constructor(key, blob) { this.key = key; this.blob = blob; }
  getKey() { return this.key; }
  async getBytes(off, len) { return { data: await this.blob.slice(off, off + len).arrayBuffer() }; } }
class PartsSource { // lecture en ligne d'un pack découpé en morceaux (Range HTTP)
  constructor(id, pj, base) { this.id = id; this.base = base; this.parts = pj.outputs.find(o => o.name === 'carte.pmtiles').parts.map(p => ({ ...p }));
    let o = 0; this.parts.forEach(p => { p.off = o; o += p.size; }); }
  getKey() { return 'remote:' + this.id; }
  async getBytes(off, len, signal) {
    const out = new Uint8Array(len); let done = 0;
    while (done < len) {
      const pos = off + done; const p = this.parts.find(p => pos >= p.off && pos < p.off + p.size); if (!p) break;
      const s = pos - p.off, e = Math.min(p.size, s + (len - done)) - 1;
      const r = await fetch(this.base + this.id + '/' + p.path, { headers: { Range: `bytes=${s}-${e}` }, signal, cache: 'no-store' });
      if (r.status !== 206 && r.status !== 200) throw new Error('HTTP ' + r.status);
      let b = new Uint8Array(await r.arrayBuffer()); if (r.status === 200) b = b.subarray(s, e + 1);
      out.set(b, done); done += b.byteLength;
    }
    return { data: out.buffer };
  } }
function tileBBox(z, x, y) { const n = 2 ** z; const lon = (x / n) * 360 - 180, lon2 = ((x + 1) / n) * 360 - 180;
  const lat = (t) => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) * 180 / Math.PI; return [lon, lat(y + 1), lon2, lat(y)]; }
const inter = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
maplibregl.addProtocol('packs', async (params, abort) => {
  const m = params.url.match(/packs:\/\/(\d+)\/(\d+)\/(\d+)/); const z = +m[1], x = +m[2], y = +m[3];
  const tb = tileBBox(z, x, y);
  const list = S.archives.concat(navigator.onLine ? S.remote.filter(r => !S.installed.has(r.id)) : []);
  for (const a of list) {
    if (!inter(tb, a.bbox) || z > a.maxzoom) continue;
    try { const r = await a.pm.getZxy(z, x, y, abort && abort.signal); if (r && r.data) return { data: new Uint8Array(r.data) }; } catch (e) { if (e.name === 'AbortError') throw e; }
  }
  return { data: new Uint8Array(0) };
});

// ---------------- carte ----------------
let map, meMarker, destMarker;
async function initMap() {
  const style = await (await fetch('assets/style.json')).json();
  style.glyphs = BASE + 'assets/fonts/{fontstack}/{range}.pbf';
  style.sprite = BASE + 'assets/sprites/dark';
  style.sources.protomaps = { type: 'vector', tiles: ['packs://{z}/{x}/{y}'], maxzoom: 14, attribution: '© OpenStreetMap · Protomaps' };
  const last = LS.get('view', { c: [-1.1517, 46.1591], z: 13 });
  map = new maplibregl.Map({ container: 'map', style, center: last.c, zoom: last.z, attributionControl: { compact: true }, maxPitch: 70, fadeDuration: 0 });
  map.on('styleimagemissing', (e) => { if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
  map.on('load', () => {
    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'route-case', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0b4a7a', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 16, 16] } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#33ccff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 16, 10] } });
    map.addSource('done', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'done-line', type: 'line', source: 'done', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#5a6470', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 16, 9] } });
  });
  const el = document.createElement('div'); el.className = 'me';
  el.innerHTML = '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#33ccff33"/><path d="M24 6 L37 38 L24 31 L11 38 Z" fill="#33ccff" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>';
  meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' });
  const de = document.createElement('div'); de.innerHTML = '<svg width="34" height="44" viewBox="0 0 34 44"><path d="M17 0C7.6 0 0 7.6 0 17c0 12.7 17 27 17 27s17-14.3 17-27C34 7.6 26.4 0 17 0z" fill="#ff4f6d"/><circle cx="17" cy="17" r="6.5" fill="#fff"/></svg>';
  destMarker = new maplibregl.Marker({ element: de, anchor: 'bottom' });
  const stopFollow = () => { if (S.follow) { S.follow = false; $('#btnRecenter').classList.remove('hidden'); } };
  map.on('dragstart', stopFollow); map.on('zoomstart', (e) => { if (e.originalEvent) stopFollow(); });
  map.on('moveend', () => LS.set('view', { c: map.getCenter().toArray(), z: map.getZoom() }));
  map.on('contextmenu', (e) => setDestination({ label: 'Point sur la carte', sub: e.lngLat.lat.toFixed(5) + ', ' + e.lngLat.lng.toFixed(5), lon: e.lngLat.lng, lat: e.lngLat.lat }));
}
function refreshTiles() { S.tileVer++; const src = map && map.getSource('protomaps'); if (src && src.setTiles) src.setTiles(['packs://{z}/{x}/{y}?v=' + S.tileVer]); }

// ---------------- packs installés ----------------
async function loadInstalled() {
  const metas = await PackStore.list();
  S.installed = new Map(metas.map(m => [m.id, m]));
  S.archives = [];
  for (const m of metas) {
    const blob = await PackStore.get(m.id, 'carte.pmtiles'); if (!blob) continue;
    S.archives.push({ id: m.id, bbox: m.bbox, maxzoom: m.maxzoom, pm: new pmtiles.PMTiles(new BlobSource('local:' + m.id + ':' + m.installed, blob)) });
  }
  const info = await rpc('load', { ids: metas.map(m => m.id) });
  console.log('routage chargé', info);
  S.routerInfo = info;
  refreshTiles();
  return metas;
}
async function loadCatalog() {
  try { const r = await fetch('catalog.json', { cache: 'no-cache' }); S.catalog = await r.json(); LS.set('catalog', S.catalog); }
  catch (e) { S.catalog = LS.get('catalog', null); }
  if (S.catalog && navigator.onLine && !PARAMS.has('noremote')) {
    // aperçu en ligne des packs publiés (lecture à la demande, rien n'est stocké)
    const built = S.catalog.groups.flatMap(g => g.packs).filter(p => p.built);
    S.remote = (await Promise.all(built.map(async p => { try { const base = packBase(p); const pj = await (await fetch(base + p.id + '/pack.json', { cache: 'no-cache' })).json();
      return { id: p.id, bbox: pj.bbox, maxzoom: pj.maxzoom, pm: new pmtiles.PMTiles(new PartsSource(p.id, pj, base)) }; } catch (e) { return null; } }))).filter(Boolean);
    refreshTiles();
  }
}

// un pack peut être hébergé ailleurs (autre dépôt GitHub Pages, CDN avec CORS) : champ "base" du catalogue
function findPack(id) { for (const g of (S.catalog ? S.catalog.groups : [])) for (const p of g.packs) if (p.id === id) return p; return { id }; }
function packBase(p) { const b = (p && p.base) || (S.catalog && S.catalog.packBase) || 'packs/'; return new URL(b, BASE).href.replace(/\/?$/, '/'); }
// ---------------- panneau des packs ----------------
function renderPacks() {
  const L = $('#packList'); if (!S.catalog) { L.innerHTML = '<p class="muted">Catalogue indisponible hors ligne. Connectez-vous une première fois.</p>'; return; }
  let h = '';
  const installedIds = new Set(S.installed.keys());
  for (const bd of (S.catalog.bundles || [])) {
    const all = bd.packs.every(id => installedIds.has(id)); const size = bd.packs.reduce((a, id) => a + (installedIds.has(id) ? 0 : (findPack(id).size || 0)), 0);
    h += `<div class="pk rec" data-bundle="${bd.packs.join(',')}"><div class="pn">${bd.name}<div class="ps">${bd.desc || ''}</div><div class="ps">${all ? 'Tout est installé ✔︎' : fmtMB(size) + ' à télécharger'}</div></div>${all ? '' : '<button data-act="bundle">Tout télécharger</button>'}</div>`;
  }
  const groups = S.catalog.groups.slice().sort((a, b) => (b.packs.some(p => p.built) ? 1 : 0) - (a.packs.some(p => p.built) ? 1 : 0));
  for (const g0 of groups) {
    const g = { ...g0, packs: g0.packs.slice().sort((a, b) => (installedIds.has(b.id) * 2 + !!b.built) - (installedIds.has(a.id) * 2 + !!a.built)) };
    const nb = g.packs.filter(p => installedIds.has(p.id)).length;
    h += `<div class="grp"><span>${g.name}</span><span class="muted small">${nb ? nb + ' installé' + (nb > 1 ? 's' : '') : ''}</span></div>`;
    for (const p of g.packs) {
      const inst = S.installed.get(p.id); const dl = S.downloads.get(p.id);
      const rec = p.id === 'poitou-charentes' ? ' rec' : '';
      h += `<div class="pk${rec}" data-id="${p.id}"><div class="pn">${p.name}${rec ? ' <span class="badge">Recommandé · La Rochelle</span>' : ''}<div class="ps">`;
      if (inst) h += `Installé · ${fmtMB(inst.size)} · version ${inst.version}`;
      else if (p.built) h += `${fmtMB(p.size)} à télécharger`;
      else h += `Pas encore disponible`;
      h += `</div></div>`;
      if (dl) h += `<button data-act="abort" class="del">Annuler</button><div class="bar"><i style="width:${(100 * dl.done / (dl.total || 1)).toFixed(1)}%"></i></div><div class="ps">${dl.queued ? 'En attente…' : fmtMB(dl.done) + ' / ' + fmtMB(dl.total)}</div>`;
      else if (inst) h += `<button data-act="del" class="del">Supprimer</button>` + (p.built && p.version && p.version !== inst.version ? `<button data-act="dl">Mettre à jour</button>` : '');
      else if (p.built) h += `<button data-act="dl">Télécharger</button>`;
      else h += `<span class="badge soon">bientôt</span>`;
      h += `</div>`;
    }
  }
  L.innerHTML = h;
  updateStorage();
}
async function updateStorage() {
  let t = ''; try { const e = await navigator.storage.estimate(); t = `Espace utilisé : ${fmtMB(e.usage || 0)}` + (e.quota ? ` sur ${fmtMB(e.quota)} disponibles` : ''); } catch (e) {}
  let p = ''; try { p = (await navigator.storage.persisted()) ? ' · stockage persistant ✔︎' : ''; } catch (e) {}
  $('#storageInfo').textContent = t + p;
}
$('#packList').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return; const id = b.closest('.pk').dataset.id;
  if (b.dataset.act === 'bundle') { b.closest('.pk').dataset.bundle.split(',').filter(x => !S.installed.has(x)).forEach(x => startDownload(x)); return; }
  if (b.dataset.act === 'dl') startDownload(id);
  else if (b.dataset.act === 'abort') { const d = S.downloads.get(id); if (d && d.worker) d.worker.postMessage({ cmd: 'abort' }); else if (d) { S.downloads.delete(id); renderPacks(); } }
  else if (b.dataset.act === 'del') { if (!confirm('Supprimer ce pack du téléphone ?')) return; await PackStore.remove(id); await loadInstalled(); renderPacks(); toast('Pack supprimé'); }
});
let dlChain = Promise.resolve();
function startDownload(id) {
  if (S.downloads.has(id)) return;
  const d = { worker: null, done: 0, total: findPack(id).size || 1, queued: true }; S.downloads.set(id, d); renderPacks();
  dlChain = dlChain.then(() => new Promise(res => { if (!S.downloads.has(id)) return res(); d.onEnd = res; runDownload(id, d); }));
}
async function runDownload(id, d) {
  if (!navigator.onLine) { toast('Pas de connexion : connectez-vous pour télécharger'); return; }
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  const w = new Worker('js/dl-worker.js'); d.worker = w; d.queued = false;
  let lastR = 0;
  w.onmessage = async (ev) => {
    const m = ev.data;
    if (m.type === 'progress') { d.done = m.done; d.total = m.total; const now = performance.now(); if (now - lastR > 250) { lastR = now; const el = document.querySelector(`.pk[data-id="${id}"] .bar i`); if (el) { el.style.width = (100 * m.done / m.total).toFixed(1) + '%'; el.parentElement.nextElementSibling.textContent = fmtMB(m.done) + ' / ' + fmtMB(m.total); } } }
    else if (m.type === 'done') { S.downloads.delete(id); w.terminate(); d.onEnd && d.onEnd(); await loadInstalled(); renderPacks(); toast('Carte installée ✔︎ Elle fonctionne maintenant hors ligne.'); $('#welcome').classList.add('hidden'); LS.set('welcomed', true); }
    else if (m.type === 'error') { S.downloads.delete(id); w.terminate(); d.onEnd && d.onEnd(); renderPacks(); toast(m.aborted ? 'Téléchargement annulé' : 'Erreur de téléchargement : ' + m.error, 5000); }
  };
  w.postMessage({ cmd: 'download', id, base: packBase(findPack(id)) });
}

// ---------------- recherche ----------------
let qTimer = null;
$('#q').addEventListener('input', () => { clearTimeout(qTimer); $('#qclear').classList.toggle('hidden', !$('#q').value); qTimer = setTimeout(doSearch, 160); });
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const f = document.querySelector('.res'); if (f) f.click(); } });
$('#qclear').addEventListener('click', () => { $('#q').value = ''; $('#results').classList.add('hidden'); $('#qclear').classList.add('hidden'); });
const KIND_ICON = { ville: '🏙️', lieu: '📍', rue: '🛣️', adresse: '🏠', poi: '⭐' };
async function doSearch() {
  const q = $('#q').value.trim(); const R = $('#results');
  if (q.length < 2) { R.classList.add('hidden'); return; }
  if (!S.installed.size) { R.innerHTML = '<div class="res"><div>Téléchargez une carte hors ligne pour activer la recherche.</div></div>'; R.classList.remove('hidden'); return; }
  const near = S.pos ? [S.pos.lon, S.pos.lat] : map.getCenter().toArray();
  const res = await rpc('search', { q, near });
  S.results = res;
  R.innerHTML = res.length ? res.map((r, i) => `<div class="res" data-i="${i}"><div class="k">${KIND_ICON[r.kind] || '📍'}</div><div><div class="l">${esc(r.label)}</div><div class="s">${esc(r.sub || '')}</div></div><div class="dist">${fmtDist(hav(near[1], near[0], r.lat, r.lon))}</div></div>`).join('')
    : '<div class="res"><div class="muted">Aucun résultat dans les cartes installées</div></div>';
  R.classList.remove('hidden');
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
$('#results').addEventListener('click', (e) => { const r = e.target.closest('.res'); if (!r || r.dataset.i == null) return; const it = S.results[+r.dataset.i];
  $('#results').classList.add('hidden'); $('#q').blur(); $('#q').value = it.label; setDestination(it); });

// ---------------- itinéraire ----------------
async function setDestination(it) {
  S.dest = it; destMarker.setLngLat([it.lon, it.lat]).addTo(map);
  $('#destName').textContent = it.label; $('#destSub').textContent = it.sub || '';
  $('#sheet').classList.remove('hidden'); document.body.classList.add('sheetopen');
  $('#rTime').textContent = '…'; $('#rDist').textContent = ''; $('#rEta').textContent = ''; $('#rErr').classList.add('hidden'); $('#btnGo').disabled = true;
  await computeRoute(true);
}
function startPoint() { if (S.pos) return [S.pos.lon, S.pos.lat]; return null; }
async function computeRoute(fit) {
  let from = startPoint();
  if (!from) { from = map.getCenter().toArray(); if (fit) toast('Position GPS inconnue : départ depuis le centre de la carte'); }
  try {
    const r = await rpc('route', { from, to: [S.dest.lon, S.dest.lat], heading: S.nav ? S.heading : null });
    setRoute(r);
    $('#rTime').textContent = fmtDur(r.duration); $('#rDist').textContent = fmtDist(r.distance);
    $('#rEta').textContent = 'arrivée ' + fmtClock(new Date(Date.now() + r.duration * 1000)); $('#btnGo').disabled = false;
    if (fit) { const b = new maplibregl.LngLatBounds(); r.coords.forEach(c => b.extend(c)); map.fitBounds(b, { padding: { top: 90, bottom: 260, left: 40, right: 40 }, maxZoom: 16, duration: 600 }); S.follow = false; $('#btnRecenter').classList.remove('hidden'); }
    return r;
  } catch (e) { $('#rTime').textContent = '–'; $('#rErr').textContent = e.message; $('#rErr').classList.remove('hidden'); throw e; }
}
function setRoute(r) {
  S.route = r; S.progIdx = 0; S.along = 0; S.spoken = {};
  map.getSource('route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords } });
  map.getSource('done').setData({ type: 'FeatureCollection', features: [] });
}
$('#btnCancel').addEventListener('click', clearRoute);
function clearRoute() {
  S.route = null; S.dest = null; destMarker.remove(); $('#sheet').classList.add('hidden'); document.body.classList.remove('sheetopen');
  map.getSource('route').setData({ type: 'FeatureCollection', features: [] }); map.getSource('done').setData({ type: 'FeatureCollection', features: [] });
}

// ---------------- voix ----------------
let voice = null;
function pickVoice() { const vs = speechSynthesis.getVoices(); voice = vs.find(v => v.lang === 'fr-FR' && /Thomas|Amélie|Audrey|Google/.test(v.name)) || vs.find(v => v.lang === 'fr-FR') || vs.find(v => /^fr/.test(v.lang)) || null; }
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function say(text, prio) {
  S.lastSpoken = text;
  if (!$('#optVoice').checked || !('speechSynthesis' in window)) return;
  if (prio) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = 'fr-FR'; if (voice) u.voice = voice; u.rate = 1.0; speechSynthesis.speak(u);
}
$('#btnTestVoice').addEventListener('click', () => say('Dans 300 mètres, tournez à droite sur Quai Duperré.', true));

// ---------------- navigation ----------------
$('#btnGo').addEventListener('click', startNav);
$('#btnStop').addEventListener('click', () => stopNav(false));
async function startNav() {
  if (!S.route) return;
  S.nav = true; document.body.classList.add('nav'); document.body.classList.remove('sheetopen');
  $('#sheet').classList.add('hidden'); $('#navbar').classList.remove('hidden'); $('#banner').classList.remove('hidden');
  S.follow = true; $('#btnRecenter').classList.add('hidden');
  try { if ('wakeLock' in navigator) S.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  requestCompass();
  if ($('#optSim').checked || PARAMS.has('sim')) startSim();
  const m = S.route.maneuvers; const first = m[0];
  say(first.text + (m[1] ? ', puis dans ' + fmtDistSpeech(m[1].d) + ', ' + lc(m[1].text) : ''), true);
  updateNav();
}
function lc(t) { return t.charAt(0).toLowerCase() + t.slice(1); }
function stopNav(arrived) {
  S.nav = false; document.body.classList.remove('nav'); $('#navbar').classList.add('hidden'); $('#banner').classList.add('hidden');
  if (S.wake) { S.wake.release().catch(() => {}); S.wake = null; }
  stopSim(); clearRoute(); map.easeTo({ pitch: 0, bearing: $('#optNorth').checked ? 0 : map.getBearing(), duration: 500 });
  if (!arrived) say('Navigation arrêtée.');
}
function progress(pos) { // projection sur l'itinéraire, fenêtre autour de la progression
  const r = S.route, c = r.coords; const k = Math.cos(pos.lat * Math.PI / 180);
  let best = { d: Infinity, i: S.progIdx, t: 0 };
  const i0 = Math.max(0, S.progIdx - 3), i1 = Math.min(c.length - 1, S.progIdx + 400);
  for (let i = i0; i < i1; i++) {
    const ax = c[i][0] * k, ay = c[i][1], bx = c[i + 1][0] * k, by = c[i + 1][1], px = pos.lon * k, py = pos.lat;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy; let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx - px, ay + t * dy - py) * 111320; if (d < best.d - 0.01) best = { d, i, t };
    if (r.cumD[i] - r.cumD[S.progIdx] > 3000 && best.d < 30) break;
  }
  return best;
}
function updateNav() {
  const r = S.route; if (!S.nav || !r) return;
  if (S.pos) {
    const p = progress(S.pos);
    const segLen = r.cumD[p.i + 1] - r.cumD[p.i];
    const along = r.cumD[p.i] + p.t * segLen;
    const tol = Math.max(35, Math.min(80, (S.pos.acc || 10) * 1.5));
    if (p.d > tol) S.offCount++; else { S.offCount = 0; if (along >= S.along - 30) { S.progIdx = p.i; S.along = along; } }
    if (S.offCount >= 3 && Date.now() - S.lastReroute > 6000) { reroute(); return; }
    // tracé déjà parcouru
    map.getSource('done').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords.slice(0, S.progIdx + 1).concat([[S.pos.lon, S.pos.lat]]) } });
  }
  const along = S.along, rem = Math.max(0, r.distance - along);
  const tAt = r.cumT[S.progIdx] + (r.cumT[Math.min(S.progIdx + 1, r.cumT.length - 1)] - r.cumT[S.progIdx]) * ((along - r.cumD[S.progIdx]) / ((r.cumD[S.progIdx + 1] - r.cumD[S.progIdx]) || 1));
  const remT = Math.max(0, r.duration - tAt);
  $('#nEta').textContent = fmtClock(new Date(Date.now() + remT * 1000)); $('#nTime').textContent = fmtDur(remT); $('#nDist').textContent = (rem / 1000).toFixed(1).replace('.', ',');
  // limitation de vitesse de la section actuelle
  const seg = r.segInfo.find(s => S.progIdx >= s[0] && S.progIdx < s[1]); showLimit(seg ? seg[2] : 0);
  // prochaine manœuvre
  const ms = r.maneuvers; let ni = ms.findIndex(m => m.d > along + 3 && m.type !== 'depart');
  if (ni < 0) ni = ms.length - 1;
  const m = ms[ni], dist = Math.max(0, m.d - along);
  $('#bIcon').innerHTML = arrowSVG(m); $('#bDist').textContent = fmtDist(dist);
  $('#bName').textContent = m.type === 'arrive' ? (S.dest ? S.dest.label : 'Destination') : (m.name || m.text);
  const nx = ms[ni + 1]; const th = $('#bThen');
  if (nx && nx.d - m.d < 250 && m.type !== 'arrive') { th.innerHTML = 'Puis ' + arrowSVG(nx); th.classList.remove('hidden'); } else th.classList.add('hidden');
  // annonces vocales
  const v = Math.max(S.speed || 0, 8); const key = ni + ':' + m.d.toFixed(0);
  const sp = S.spoken[key] || (S.spoken[key] = {});
  const far = v > 22 ? 1500 : v > 14 ? 800 : 400, near = Math.max(50, v * 5);
  if (m.type === 'arrive') {
    if (dist < 30 || (S.pos && S.dest && hav(S.pos.lat, S.pos.lon, S.dest.lat, S.dest.lon) < 25)) { say('Vous êtes arrivé à destination.', true); toast('Vous êtes arrivé 🎉', 4000); stopNav(true); return; }
    if (!sp.far && dist < far && dist > near * 1.5) { sp.far = 1; say('Dans ' + fmtDistSpeech(dist) + ', vous serez arrivé à destination.'); }
    return;
  }
  if (!sp.far && dist < far && dist > near * 2.2 && dist > 150) { sp.far = 1; say('Dans ' + fmtDistSpeech(dist) + ', ' + lc(m.text) + '.'); }
  else if (!sp.near && dist <= near) { sp.near = 1; sp.far = 1; say(m.text + (nx && nx.d - m.d < 200 ? ', puis ' + lc(nx.text) : '') + '.', true); }
}
async function reroute() {
  S.lastReroute = Date.now(); S.offCount = 0; say('Recalcul de l’itinéraire.', true); toast('Recalcul de l’itinéraire…');
  try { await computeRoute(false); const m = S.route.maneuvers[1]; if (m) say((m.d > 100 ? 'Dans ' + fmtDistSpeech(m.d) + ', ' + lc(m.text) : m.text) + '.'); updateNav(); }
  catch (e) { toast(e.message); }
}
function arrowSVG(m) {
  const P = 'M12 3l6 6h-4v12h-4V9H6z'; let rot = 0, d = P;
  if (m.type === 'roundabout') return `<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="5" fill="none" stroke="#fff" stroke-width="2.4"/><path d="M12 1l4 4h-3v4h-2V5H8z"/><text x="12" y="16" font-size="7" text-anchor="middle" fill="#fff" font-weight="700">${m.exit || ''}</text></svg>`;
  if (m.type === 'arrive') return '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 00-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z"/></svg>';
  if (m.type === 'uturn') return '<svg viewBox="0 0 24 24"><path d="M7 21V9a5 5 0 0110 0v4h3l-4 5-4-5h3V9a3 3 0 00-6 0v12z"/></svg>';
  const a = m.angle || 0; const sgn = m.side === 'gauche' ? -1 : 1;
  if (m.type === 'turn') rot = 90 * sgn; else if (m.type === 'sharp') rot = 135 * sgn; else if (m.type === 'slight' || m.type === 'exit' || m.type === 'ramp') rot = 40 * (m.side ? sgn : Math.sign(a) || 1);
  return `<svg viewBox="0 0 24 24"><g transform="rotate(${rot} 12 13)"><path d="${d}"/></g></svg>`;
}
function showLimit(v) { const L = $('#limit'); if (v > 0) { $('#limitV').textContent = v; L.classList.remove('hidden'); } else L.classList.add('hidden'); S.curLimit = v;
  $('#speed').classList.toggle('over', v > 0 && S.speed * 3.6 > v + 3); }

// ---------------- GPS ----------------
function onPosition(p) {
  const c = p.coords; const prev = S.pos;
  const pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: p.timestamp || Date.now() };
  let spd = c.speed != null && c.speed >= 0 ? c.speed : null;
  const moved = prev ? hav(prev.lat, prev.lon, pos.lat, pos.lon) : 0;
  if (spd == null && prev) { const dt = (pos.t - prev.t) / 1000; if (dt > 0.5) spd = moved / dt; else spd = S.speed; }
  S.speed = spd || 0;
  if (c.heading != null && !isNaN(c.heading) && S.speed > 1.5) S.heading = c.heading;
  else if (prev && moved > 4 && (S.speed > 1.5 || c.speed == null)) S.heading = brg(prev.lat, prev.lon, pos.lat, pos.lon);
  else if (S.compass != null && S.speed < 1.5) S.heading = S.compass;
  S.pos = pos;
  $('#speedV').textContent = Math.round(S.speed * 3.6);
  meMarker.setLngLat([pos.lon, pos.lat]).setRotation(S.heading || 0); if (!meMarker._map) meMarker.addTo(map);
  if (S.follow) followCam();
  if (S.nav) updateNav();
  else if (Date.now() - S.lastSnapAt > 3000 && S.installed.size) { S.lastSnapAt = Date.now(); rpc('snap', { lat: pos.lat, lon: pos.lon, heading: S.heading }).then(r => showLimit(r ? r.maxs : 0)).catch(() => {}); }
}
function followCam() {
  if (!S.pos) return;
  const navMode = S.nav; const v = S.speed * 3.6;
  const zoom = navMode ? (v > 100 ? 15 : v > 70 ? 15.6 : v > 40 ? 16.3 : 17) : Math.max(map.getZoom(), 15);
  const bearing = navMode || !$('#optNorth').checked ? (S.heading != null ? S.heading : map.getBearing()) : 0;
  const h = map.getContainer().clientHeight;
  map.easeTo({ center: [S.pos.lon, S.pos.lat], zoom, bearing, pitch: navMode ? 55 : 0, padding: { top: navMode ? h * 0.45 : 0, bottom: 0, left: 0, right: 0 }, duration: 900, easing: (t) => t });
}
function onPosError(e) { if (e.code === 1) toast('Autorisez la localisation : Réglages › Confidentialité › Service de localisation › Safari', 6000); }
function startGPS() {
  if (!('geolocation' in navigator) || PARAMS.has('nogps')) return;
  navigator.geolocation.watchPosition((p) => { if (!S.sim) onPosition(p); }, onPosError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
function requestCompass() {
  const h = (e) => { const v = e.webkitCompassHeading != null ? e.webkitCompassHeading : (e.absolute && e.alpha != null ? 360 - e.alpha : null); if (v != null) S.compass = v; };
  try { if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) DeviceOrientationEvent.requestPermission().then(s => { if (s === 'granted') addEventListener('deviceorientation', h); }).catch(() => {});
    else addEventListener('deviceorientationabsolute', h); } catch (e) {}
}
$('#btnRecenter').addEventListener('click', () => { S.follow = true; $('#btnRecenter').classList.add('hidden'); if (S.pos) followCam(); else toast('En attente du GPS…'); });

// ---------------- simulation (mode démo) ----------------
function startSim() {
  stopSim(); const r = S.route; if (!r) return; let d = 0; const t0 = Date.now(); let last = Date.now();
  S.sim = setInterval(() => {
    const now = Date.now(); const dt = (now - last) / 1000; last = now;
    const rr = S.route; if (!rr) return stopSim();
    const i = Math.max(0, S.progIdx); const seg = rr.segInfo.find(s => i >= s[0] && i < s[1]);
    const v = Math.min(seg && seg[2] ? seg[2] : 50, 90) / 3.6 * (PARAMS.get('simx') ? +PARAMS.get('simx') : 1);
    d = Math.max(d, S.along) + v * dt;
    let j = S.progIdx; while (j < rr.coords.length - 2 && rr.cumD[j + 1] < d) j++;
    const f = Math.min(1, (d - rr.cumD[j]) / ((rr.cumD[j + 1] - rr.cumD[j]) || 1));
    const lon = rr.coords[j][0] + f * (rr.coords[j + 1][0] - rr.coords[j][0]), lat = rr.coords[j][1] + f * (rr.coords[j + 1][1] - rr.coords[j][1]);
    onPosition({ coords: { latitude: lat, longitude: lon, accuracy: 5, speed: v, heading: brg(rr.coords[j][1], rr.coords[j][0], rr.coords[j + 1][1], rr.coords[j + 1][0]) }, timestamp: now });
  }, 1000);
}
function stopSim() { if (S.sim) { clearInterval(S.sim); S.sim = null; } }

// ---------------- panneaux ----------------
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $('#' + b.dataset.close).classList.add('hidden')));
$('#btnPacks').addEventListener('click', () => { renderPacks(); $('#packs').classList.remove('hidden'); });
$('#btnMenu').addEventListener('click', () => $('#menu').classList.remove('hidden'));
$('#btnWelcomeDl').addEventListener('click', () => { $('#welcome').classList.add('hidden'); renderPacks(); $('#packs').classList.remove('hidden'); });
$('#btnWelcomeLater').addEventListener('click', () => { $('#welcome').classList.add('hidden'); LS.set('welcomed', true); });
['optVoice', 'optNorth', 'optSim'].forEach(k => { const el = $('#' + k); el.checked = LS.get(k, el.checked); el.addEventListener('change', () => LS.set(k, el.checked)); });

// ---------------- démarrage ----------------
(async function main() {
  if ('serviceWorker' in navigator && !PARAMS.has('nosw')) navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  await initMap();
  await new Promise(r => map.loaded() ? r() : map.once('load', r));
  const metas = await loadInstalled().catch(e => { console.error(e); return []; });
  await loadCatalog();
  if (!metas.length && !LS.get('welcomed', false)) $('#welcome').classList.remove('hidden');
  $('#about').textContent = `Version ${APP_VERSION} · ${S.installed.size} pack(s) installé(s) · ${S.routerInfo ? S.routerInfo.nodes.toLocaleString('fr-FR') + ' intersections' : ''}`;
  startGPS();
  window.__app = { S, rpc, setDestination, startNav, stopNav, startDownload, loadInstalled, map: () => map, onPosition };
  document.body.dataset.ready = '1';
})();
