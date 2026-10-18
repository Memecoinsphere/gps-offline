// Offline routing + geocoding worker. Loads any number of packs and stitches them via shared border nodes (OSM ids).
importScripts('storage.js');
const CLASS_NAMES = ['motorway','trunk','primary','secondary','tertiary','unclassified','residential','living_street','service',
  'motorway_link','trunk_link','primary_link','secondary_link','tertiary_link','road'];
let G = null;        // merged graph
let GEO = [];        // search entries
const MAXV = 130 / 3.6; // m/s for A* heuristic

function parseGraph(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== 'GRF2' && magic !== 'GRF3') throw new Error('bad graph');
  const N = dv.getUint32(4, true), E = dv.getUint32(8, true), Gp = dv.getUint32(12, true), B = dv.getUint32(16, true);
  let o = 20;
  const take = (T, n) => { const a = new T(buf.slice(o, o + n * T.BYTES_PER_ELEMENT)); o += n * T.BYTES_PER_ELEMENT; return a; };
  return { N, E, Gp, B, lat: take(Int32Array, N), lon: take(Int32Array, N), eu: take(Uint32Array, E), ev: take(Uint32Array, E),
    len: take(Float32Array, E), name: take(Uint32Array, E), goff: take(Uint32Array, E + 1), glat: take(Int32Array, Gp), glon: take(Int32Array, Gp),
    bnode: take(Uint32Array, B), bosm: take(Float64Array, B), speed: take(Uint8Array, E), maxs: take(Uint8Array, E), cls: take(Uint8Array, E), flags: take(Uint8Array, E) };
}
function decodeGeom(g, delta) { // GRF3: intermediate points are deltas from the previous point (first one from node u)
  if (!delta) return g;
  for (let e = 0; e < g.E; e++) { let pl = g.lat[g.eu[e]], po = g.lon[g.eu[e]];
    for (let i = g.goff[e]; i < g.goff[e + 1]; i++) { pl += g.glat[i]; po += g.glon[i]; g.glat[i] = pl; g.glon[i] = po; } }
  return g;
}

function merge(parts) {
  let N = 0, E = 0, Gp = 0; const names = [];
  for (const p of parts) { N += p.g.N; E += p.g.E; Gp += p.g.Gp; }
  const M = { N, E, lat: new Int32Array(N), lon: new Int32Array(N), eu: new Uint32Array(E), ev: new Uint32Array(E), len: new Float32Array(E),
    name: new Uint32Array(E), goff: new Uint32Array(E + 1), glat: new Int32Array(Gp), glon: new Int32Array(Gp), speed: new Uint8Array(E),
    maxs: new Uint8Array(E), cls: new Uint8Array(E), flags: new Uint8Array(E), names };
  const osmToNode = new Map();
  let nb = 0, eb = 0, gb = 0, stitched = 0;
  for (const { g, names: nm } of parts) {
    const map = new Uint32Array(g.N); for (let i = 0; i < g.N; i++) map[i] = nb + i;
    for (let k = 0; k < g.B; k++) {
      const osm = g.bosm[k], loc = g.bnode[k]; const ex = osmToNode.get(osm);
      if (ex !== undefined) { map[loc] = ex; stitched++; } else osmToNode.set(osm, nb + loc);
    }
    M.lat.set(g.lat, nb); M.lon.set(g.lon, nb);
    const nameBase = names.length; for (const s of nm) names.push(s);
    for (let e = 0; e < g.E; e++) {
      M.eu[eb + e] = map[g.eu[e]]; M.ev[eb + e] = map[g.ev[e]]; M.name[eb + e] = g.name[e] + nameBase;
      M.goff[eb + e] = g.goff[e] + gb;
    }
    M.len.set(g.len, eb); M.speed.set(g.speed, eb); M.maxs.set(g.maxs, eb); M.cls.set(g.cls, eb); M.flags.set(g.flags, eb);
    M.glat.set(g.glat, gb); M.glon.set(g.glon, gb);
    nb += g.N; eb += g.E; gb += g.Gp;
  }
  M.goff[E] = gb; M.stitched = stitched;
  // adjacency (outgoing, directed), entries = e*2 + dir (dir 0: u->v, 1: v->u)
  const deg = new Uint32Array(N + 1);
  for (let e = 0; e < E; e++) { const f = M.flags[e]; if (f & 1) deg[M.eu[e]]++; if (f & 2) deg[M.ev[e]]++; }
  const off = new Uint32Array(N + 1); for (let i = 0; i < N; i++) off[i + 1] = off[i] + deg[i];
  const adj = new Uint32Array(off[N]); const fill = off.slice(0, N);
  for (let e = 0; e < E; e++) { const f = M.flags[e]; if (f & 1) adj[fill[M.eu[e]]++] = e * 2; if (f & 2) adj[fill[M.ev[e]]++] = e * 2 + 1; }
  // undirected degree for maneuver decisions
  const udeg = new Uint8Array(N); for (let e = 0; e < E; e++) { if (udeg[M.eu[e]] < 255) udeg[M.eu[e]]++; if (udeg[M.ev[e]] < 255) udeg[M.ev[e]]++; }
  M.off = off; M.adj = adj; M.udeg = udeg;
  M.cost = new Float32Array(E); for (let e = 0; e < E; e++) M.cost[e] = M.len[e] / (M.speed[e] / 3.6);
  buildGrid(M);
  M.dist = new Float64Array(N); M.prev = new Int32Array(N); M.stamp = new Uint32Array(N); M.closed = new Uint32Array(N); M.epoch = 0;
  return M;
}

// ---- edge geometry helpers (points incl. endpoints, oriented u->v) ----
function edgePts(M, e) {
  const pts = [[M.lon[M.eu[e]] / 1e6, M.lat[M.eu[e]] / 1e6]];
  for (let i = M.goff[e]; i < M.goff[e + 1]; i++) pts.push([M.glon[i] / 1e6, M.glat[i] / 1e6]);
  pts.push([M.lon[M.ev[e]] / 1e6, M.lat[M.ev[e]] / 1e6]); return pts;
}
const CELL = 0.01;
function cellKey(lat, lon) { return (Math.floor(lat / CELL) + 20000) * 40000 + (Math.floor(lon / CELL) + 20000); }
function buildGrid(M) {
  const cells = new Map();
  const add = (k, e) => { let a = cells.get(k); if (!a) { a = []; cells.set(k, a); } if (a[a.length - 1] !== e) a.push(e); };
  for (let e = 0; e < M.E; e++) {
    if (!(M.flags[e] & 3)) continue;
    let plat = M.lat[M.eu[e]] / 1e6, plon = M.lon[M.eu[e]] / 1e6; add(cellKey(plat, plon), e);
    const n = M.goff[e + 1] - M.goff[e];
    for (let j = 0; j <= n; j++) {
      const i = M.goff[e] + j; const lat = j < n ? M.glat[i] / 1e6 : M.lat[M.ev[e]] / 1e6, lon = j < n ? M.glon[i] / 1e6 : M.lon[M.ev[e]] / 1e6;
      // densify long segments so every crossed cell knows the edge
      const steps = Math.ceil(Math.max(Math.abs(lat - plat), Math.abs(lon - plon)) / (CELL * 0.5));
      for (let s = 1; s <= steps; s++) add(cellKey(plat + (lat - plat) * s / steps, plon + (lon - plon) * s / steps), e);
      plat = lat; plon = lon;
    }
  }
  M.grid = cells;
}
function proj(px, py, ax, ay, bx, by) { // planar (scaled) projection; returns [t, d2]
  const dx = bx - ax, dy = by - ay; const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py; return [t, qx * qx + qy * qy];
}
function snap(lat, lon, heading, maxRing = 3) {
  const M = G; if (!M) return null;
  const k = Math.cos(lat * Math.PI / 180); const mPerDeg = 111320;
  let best = null;
  for (let ring = 0; ring <= maxRing; ring++) {
    const cy = Math.floor(lat / CELL), cx = Math.floor(lon / CELL);
    for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
      const a = M.grid.get((cy + dy + 20000) * 40000 + (cx + dx + 20000)); if (!a) continue;
      for (const e of a) {
        const pts = edgePts(M, e); let along = 0;
        for (let i = 0; i < pts.length - 1; i++) {
          const ax = pts[i][0] * k, ay = pts[i][1], bx = pts[i + 1][0] * k, by = pts[i + 1][1];
          const [t, d2] = proj(lon * k, lat, ax, ay, bx, by);
          const segLen = Math.hypot(bx - ax, by - ay) * mPerDeg;
          let d = Math.sqrt(d2) * mPerDeg;
          if (heading != null && !isNaN(heading)) { // prefer edges aligned with travel direction
            const brg = bearing(pts[i][1], pts[i][0], pts[i + 1][1], pts[i + 1][0]);
            let diff = Math.abs(((heading - brg) % 360 + 540) % 360 - 180); // 0..180, 0 = same dir
            const okF = M.flags[e] & 1, okB = M.flags[e] & 2;
            const pen = Math.min(diff < 90 ? (okF ? diff : 180) : (okB ? 180 - diff : 180), 180);
            d += pen * 0.15;
          }
          if (!best || d < best.score) best = { score: d, e, seg: i, t, alongM: along + t * segLen, lon: pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), lat: pts[i][1] + t * (pts[i + 1][1] - pts[i][1]) };
          along += segLen;
        }
      }
    }
    if (best && best.score < (ring + 0.5) * CELL * mPerDeg * k) break;
  }
  if (!best) return null;
  best.frac = M.len[best.e] > 0 ? Math.min(1, best.alongM / M.len[best.e]) : 0;
  best.dist = haversine(lat, lon, best.lat, best.lon);
  return best;
}
function haversine(a, b, c, d) {
  const R = 6371008.8, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dp = p2 - p1, dl = (d - b) * Math.PI / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x));
}
function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ---- binary heap ----
class Heap { constructor() { this.k = new Float64Array(1024); this.v = new Int32Array(1024); this.n = 0; }
  push(key, val) { if (this.n >= this.k.length) { const k = new Float64Array(this.k.length * 2); k.set(this.k); this.k = k; const v = new Int32Array(this.v.length * 2); v.set(this.v); this.v = v; }
    let i = this.n++; while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; } this.k[i] = key; this.v[i] = val; }
  pop() { const top = this.v[0]; const key = this.k[--this.n], val = this.v[this.n]; let i = 0;
    for (;;) { let c = 2 * i + 1; if (c >= this.n) break; if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++; if (this.k[c] >= key) break; this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c; }
    this.k[i] = key; this.v[i] = val; return top; } }

// A* from virtual source (on edge s) to virtual target (on edge t)
function route(from, to, heading) {
  const M = G; if (!M) throw new Error('Aucune carte chargée');
  const S = snap(from[1], from[0], heading), T = snap(to[1], to[0], null);
  if (!S || S.dist > 3000) throw new Error('Départ trop loin d’une route connue (carte non téléchargée ?)');
  if (!T || T.dist > 3000) throw new Error('Destination hors des cartes téléchargées');
  const ep = ++M.epoch; const dist = M.dist, prev = M.prev, stamp = M.stamp, closed = M.closed;
  const tlat = T.lat, tlon = T.lon, coslat = Math.cos(tlat * Math.PI / 180);
  const h = (n) => { const dy = (M.lat[n] / 1e6 - tlat) * 111320, dx = (M.lon[n] / 1e6 - tlon) * 111320 * coslat; return Math.sqrt(dx * dx + dy * dy) / MAXV; };
  const heap = new Heap();
  const relax = (n, d, pe) => { if (stamp[n] !== ep || d < dist[n]) { stamp[n] = ep; dist[n] = d; prev[n] = pe; heap.push(d + h(n), n); } };
  const ce = M.cost[S.e];
  if (M.flags[S.e] & 1) relax(M.ev[S.e], ce * (1 - S.frac), -1);       // leave towards v
  if (M.flags[S.e] & 2) relax(M.eu[S.e], ce * S.frac, -2);             // leave towards u
  // target: reach T.e endpoints then traverse partial edge
  const tc = M.cost[T.e];
  const tU = M.eu[T.e], tV = M.ev[T.e];
  let best = Infinity, bestEnd = -1, bestDir = 0;
  // same edge direct
  let direct = null;
  if (S.e === T.e) {
    if ((M.flags[S.e] & 1) && T.frac >= S.frac) direct = { cost: tc * (T.frac - S.frac), dir: 0 };
    else if ((M.flags[S.e] & 2) && T.frac <= S.frac) direct = { cost: tc * (S.frac - T.frac), dir: 1 };
    if (direct) best = direct.cost;
  }
  let settled = 0;
  while (heap.n > 0) {
    const n = heap.pop();
    if (closed[n] === ep) continue; closed[n] = ep; settled++;
    const d = dist[n];
    if (d + h(n) >= best) break;
    if (n === tU && (M.flags[T.e] & 1)) { const c = d + tc * T.frac; if (c < best) { best = c; bestEnd = n; bestDir = 0; direct = null; } }
    if (n === tV && (M.flags[T.e] & 2)) { const c = d + tc * (1 - T.frac); if (c < best) { best = c; bestEnd = n; bestDir = 1; direct = null; } }
    for (let i = M.off[n]; i < M.off[n + 1]; i++) {
      const a = M.adj[i], e = a >> 1, dir = a & 1; const m = dir ? M.eu[e] : M.ev[e];
      // tiny penalty for U-turn on same edge is implicit; add 3 s per intersection to favour simpler routes
      const nd = d + M.cost[e] + (M.udeg[n] > 2 ? 2 : 0);
      if (closed[m] !== ep) relax(m, nd, a);
    }
  }
  if (best === Infinity) throw new Error('Aucun itinéraire trouvé');
  // reconstruct edge list: [{e, dir, f0, f1}]
  const legs = [];
  if (direct) legs.push({ e: S.e, dir: direct.dir, f0: S.frac, f1: T.frac });
  else {
    legs.push({ e: T.e, dir: bestDir, f0: bestDir ? 1 : 0, f1: T.frac });
    let n = bestEnd;
    while (true) {
      const a = prev[n];
      if (a === -1) { legs.push({ e: S.e, dir: 0, f0: S.frac, f1: 1 }); break; }
      if (a === -2) { legs.push({ e: S.e, dir: 1, f0: S.frac, f1: 0 }); break; }
      const e = a >> 1, dir = a & 1; legs.push({ e, dir, f0: dir ? 1 : 0, f1: dir ? 0 : 1 });
      n = dir ? M.ev[e] : M.eu[e];
    }
    legs.reverse();
  }
  return buildResult(legs, S, T, settled, from, to);
}

function cutEdge(M, e, f0, f1) { // points along edge between fractions (oriented f0->f1)
  const pts = edgePts(M, e); const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]));
  const L = cum[cum.length - 1] || 1;
  const at = (f) => { const t = f * L; let i = 1; while (i < cum.length - 1 && cum[i] < t) i++; const s = (t - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    return { i, p: [pts[i - 1][0] + s * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + s * (pts[i][1] - pts[i - 1][1])] }; };
  const A = at(Math.min(f0, f1)), B = at(Math.max(f0, f1));
  let out = [A.p]; for (let i = A.i; i < B.i; i++) out.push(pts[i]); out.push(B.p);
  if (f0 > f1) out.reverse();
  return out;
}

function buildResult(legs, S, T, settled, from, to) {
  const M = G; const coords = []; const segs = []; // segs: per leg info with start index
  let totalTime = 0;
  for (const L of legs) {
    let pts = (L.f0 === 0 && L.f1 === 1) ? edgePts(M, L.e) : (L.f0 === 1 && L.f1 === 0) ? edgePts(M, L.e).reverse() : cutEdge(M, L.e, L.f0, L.f1);
    const start = coords.length ? coords.length - 1 : 0;
    if (coords.length) pts = pts.slice(1);
    for (const p of pts) coords.push(p);
    const t = M.cost[L.e] * Math.abs(L.f1 - L.f0); totalTime += t;
    segs.push({ e: L.e, start, end: coords.length - 1, time: t, name: M.names[M.name[L.e]] || '', cls: M.cls[L.e], maxs: M.maxs[L.e], rb: (M.flags[L.e] & 4) ? 1 : 0, node: L.dir ? M.eu[L.e] : M.ev[L.e] });
  }
  // cumulative distance & time per coordinate
  const cumD = new Float64Array(coords.length), cumT = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) cumD[i] = cumD[i - 1] + haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  let tAcc = 0;
  for (const s of segs) { const d0 = cumD[s.start], d1 = cumD[s.end]; for (let i = s.start + 1; i <= s.end; i++) cumT[i] = tAcc + s.time * ((cumD[i] - d0) / ((d1 - d0) || 1)); tAcc += s.time; }
  const maneuvers = buildManeuvers(segs, coords, cumD);
  const segInfo = segs.map(s => [s.start, s.end, s.maxs, s.cls]);
  return { coords, cumD: Array.from(cumD), cumT: Array.from(cumT), distance: cumD[coords.length - 1], duration: totalTime, maneuvers, segInfo, settled,
    snapStart: [S.lon, S.lat], snapEnd: [T.lon, T.lat] };
}

const ORD = ['', 'première', 'deuxième', 'troisième', 'quatrième', 'cinquième', 'sixième', 'septième', 'huitième'];
function displayName(n) { return n || ''; }
function buildManeuvers(segs, coords, cumD) {
  const M = G; const out = [];
  const brgAt = (i, back) => { // bearing near coord i, looking back or forward ~20 m
    let j = i; if (back) { while (j > 0 && cumD[i] - cumD[j] < 15) j--; return bearing(coords[j][1], coords[j][0], coords[i][1], coords[i][0]); }
    while (j < coords.length - 1 && cumD[j] - cumD[i] < 15) j++; return bearing(coords[i][1], coords[i][0], coords[j][1], coords[j][0]); };
  const first = segs[0];
  out.push({ i: 0, d: 0, type: 'depart', text: 'Partez' + (first.name ? ' sur ' + first.name : ''), name: first.name });
  let i = 1;
  while (i < segs.length) {
    const a = segs[i - 1], b = segs[i]; const node = a.node; const ci = b.start;
    if (b.rb && !a.rb) { // roundabout: count exits until leaving
      let j = i, exits = 0;
      while (j < segs.length && segs[j].rb) {
        const n = segs[j].node; // node at end of this rb seg
        // count drivable non-roundabout outgoing edges at this node
        let has = false; const takenSvc = j + 1 < segs.length && !segs[j + 1].rb && M.cls[segs[j + 1].e] === 8;
        for (let k = M.off[n]; k < M.off[n + 1]; k++) { const e = M.adj[k] >> 1; if (!(M.flags[e] & 4) && (M.cls[e] !== 8 || takenSvc)) { has = true; break; } }
        if (has) exits++;
        j++;
      }
      const outName = j < segs.length ? segs[j].name : '';
      const nth = Math.max(1, exits);
      out.push({ i: ci, d: cumD[ci], type: 'roundabout', exit: nth, name: outName,
        text: `Au rond-point, prenez la ${ORD[nth] || nth + 'e'} sortie` + (outName ? ' vers ' + outName : '') });
      i = j + 1; continue;
    }
    if (a.rb && b.rb) { i++; continue; }
    const bin = brgAt(ci, true), bout = brgAt(ci, false);
    const ang = ((bout - bin + 540) % 360) - 180; // + right, - left
    // alternatives at this node: other outgoing drivable edges (excluding the way we came from)
    const alts = [];
    for (let k = M.off[node]; k < M.off[node + 1]; k++) {
      const ad = M.adj[k], e = ad >> 1, dir = ad & 1; if (e === b.e) continue; if (e === a.e) continue;
      const pts = edgePts(M, e); if (dir) pts.reverse();
      let j = 1, acc = 0; while (j < pts.length - 1 && acc < 15) { acc += haversine(pts[j - 1][1], pts[j - 1][0], pts[j][1], pts[j][0]); if (acc < 15) j++; }
      const br = bearing(pts[0][1], pts[0][0], pts[j][1], pts[j][0]);
      const aa = ((br - bin + 540) % 360) - 180; if (Math.abs(aa) < 170) alts.push({ aa, cls: M.cls[e] });
    }
    const choice = alts.length > 0;
    const straightest = alts.every(x => Math.abs(x.aa) > Math.abs(ang) + 10);
    const nameChange = b.name !== a.name;
    const abs = Math.abs(ang); const side = ang > 0 ? 'droite' : 'gauche';
    let m = null;
    const isLink = (c) => c >= 9 && c <= 13;
    const ahead = () => { let dd = 0; for (let j = i; j < segs.length && dd < 3000; j++) { if (segs[j].name && !isLink(segs[j].cls)) return segs[j].name; dd += cumD[segs[j].end] - cumD[segs[j].start]; } return ''; };
    if (choice || abs > 60) {
      if (isLink(b.cls) && !isLink(a.cls) && a.cls <= 1) { const v = b.name || ahead(); m = { type: 'exit', side, text: 'Prenez la sortie' + (abs > 8 ? ' à ' + side : '') + (v ? ' vers ' + v : '') }; }
      else if (isLink(b.cls) && !isLink(a.cls)) { const v = b.name || ahead(); m = { type: 'ramp', side, text: 'Prenez la bretelle' + (abs > 8 ? ' à ' + side : '') + (v ? ' vers ' + v : '') }; }
      else if (isLink(a.cls) && b.cls <= 1 && !isLink(b.cls)) m = { type: 'merge', text: 'Rejoignez ' + (b.name || 'la voie rapide') };
      else if (isLink(a.cls) && isLink(b.cls)) { if (!straightest && abs > 8) m = { type: 'slight', side, text: `Serrez à ${side}` }; }
      else if (abs >= 150) m = { type: 'uturn', text: 'Faites demi-tour' };
      else if (abs >= 110) m = { type: 'sharp', side, text: `Tournez fortement à ${side}` };
      else if (abs >= 50 && !(straightest && !nameChange && abs < 70)) m = { type: 'turn', side, text: `Tournez à ${side}` };
      else if (abs >= 15 && !straightest) m = { type: 'slight', side, text: nameChange ? `Tournez légèrement à ${side}` : `Serrez à ${side}` };
      else if (!straightest && nameChange) m = { type: 'straight', text: 'Continuez tout droit' };
      if (m && b.name && ['turn', 'sharp', 'slight', 'straight', 'uturn'].includes(m.type) && (nameChange || m.type !== 'slight')) m.text += ' sur ' + b.name;
    }
    if (m) { m.i = ci; m.d = cumD[ci]; m.name = b.name; m.angle = Math.round(ang); out.push(m); }
    i++;
  }
  const last = coords.length - 1;
  out.push({ i: last, d: cumD[last], type: 'arrive', text: 'Vous êtes arrivé à destination', name: '' });
  // merge maneuvers that are very close (dual carriageways, split junctions)
  const res = [];
  for (const m of out) { const p = res[res.length - 1];
    if (p && p.type !== 'depart' && m.type !== 'arrive' && m.d - p.d < 30 && (m.name === p.name || m.type === p.type)) continue;
    res.push(m); }
  return res;
}

// ---------------- geocoding ----------------
function norm(s) { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
const ABBR = { st: 'saint', ste: 'sainte', av: 'avenue', bd: 'boulevard', bld: 'boulevard', r: 'rue', pl: 'place', che: 'chemin', imp: 'impasse', rte: 'route', all: 'allee', fbg: 'faubourg', lr: 'la rochelle' };
const POI_FR = { 'amenity=fuel': 'Station-service', 'amenity=parking': 'Parking', 'amenity=hospital': 'Hôpital', 'amenity=pharmacy': 'Pharmacie',
  'amenity=restaurant': 'Restaurant', 'amenity=cafe': 'Café', 'amenity=bar': 'Bar', 'amenity=fast_food': 'Restauration rapide', 'amenity=bank': 'Banque',
  'amenity=post_office': 'Bureau de poste', 'amenity=townhall': 'Mairie', 'amenity=school': 'École', 'amenity=police': 'Police', 'amenity=doctors': 'Médecin',
  'amenity=dentist': 'Dentiste', 'amenity=place_of_worship': 'Lieu de culte', 'amenity=cinema': 'Cinéma', 'amenity=library': 'Bibliothèque',
  'shop=supermarket': 'Supermarché', 'shop=doityourself': 'Bricolage', 'shop=hardware': 'Quincaillerie', 'shop=trade': 'Négoce matériaux',
  'shop=bakery': 'Boulangerie', 'shop=car_repair': 'Garage', 'shop=furniture': 'Meubles', 'shop=kitchen': 'Cuisiniste', 'shop=convenience': 'Épicerie',
  'tourism=hotel': 'Hôtel', 'tourism=camp_site': 'Camping', 'tourism=museum': 'Musée', 'railway=station': 'Gare', 'aeroway=aerodrome': 'Aéroport',
  'craft=carpenter': 'Menuisier', 'craft=joiner': 'Menuisier', 'office=company': 'Entreprise', 'amenity=marketplace': 'Marché' };
function poiLabel(c) { return POI_FR[c] || c.split('=')[1].replace(/_/g, ' '); }
let IDX = null;
function addGeo(packId, geo) {
  const towns = geo.towns;
  for (const p of geo.places) {
    const [name, la, lo, rank, pop, ti] = p; const ctx = ti >= 0 ? towns[ti] : '';
    GEO.push({ k: rank >= 3 ? 'ville' : 'lieu', n: name, s: ctx, lat: la / 1e5, lon: lo / 1e5, w: 10 + rank * 4 + Math.min(10, Math.log10(pop + 1) * 2), t: norm(name + ' ' + ctx), nn: norm(name) });
  }
  for (const s of geo.streets) {
    const [name, ti, la, lo, nums] = s; const town = towns[ti] || '';
    GEO.push({ k: 'rue', n: name, s: town, lat: la / 1e5, lon: lo / 1e5, w: 8, t: norm(name + ' ' + town), nn: norm(name), nums: nums.length ? nums : null });
  }
  for (const p of geo.pois) {
    const [name, c, la, lo, ti] = p; const town = towns[ti] || '';
    GEO.push({ k: 'poi', n: name, s: poiLabel(c) + (town ? ' · ' + town : ''), lat: la / 1e5, lon: lo / 1e5, w: 6, t: norm(name + ' ' + town + ' ' + poiLabel(c)), nn: norm(name) });
  }
}
function search(q, near, limit = 12) {
  let nq = norm(q); if (!nq) return [];
  let toks = nq.split(' ').map(t => ABBR[t] || t);
  let num = null; if (/^\d+[a-z]?$/.test(toks[0]) && toks.length > 1) { num = toks[0]; toks = toks.slice(1); }
  if (toks.length && /^(bis|ter)$/.test(toks[0]) && num) { num += toks[0][0]; toks = toks.slice(1); }
  toks = toks.join(' ').split(' ').filter(Boolean);
  const res = [];
  for (const g of GEO) {
    const t = ' ' + g.t; let ok = true;
    for (const tok of toks) { if (t.indexOf(' ' + tok) < 0) { ok = false; break; } }
    if (!ok) continue;
    let sc = g.w;
    if (g.nn.startsWith(toks[0] || '')) sc += 6;
    if (g.nn === toks.join(' ')) sc += 8;
    if (near) { const d = haversine(near[1], near[0], g.lat, g.lon) / 1000; sc += 14 - Math.min(14, Math.log2(1 + d) * 2); }
    if (num && g.k === 'rue') sc += g.nums ? 6 : -2;
    res.push([sc, g]);
  }
  res.sort((a, b) => b[0] - a[0]);
  const out = []; const seen = new Set();
  for (const [sc, g] of res) {
    const key = g.n + '|' + g.s; if (seen.has(key)) continue; seen.add(key);
    let item = { label: g.n, sub: g.s, kind: g.k, lon: g.lon, lat: g.lat };
    if (num && g.k === 'rue' && g.nums) {
      const h = g.nums.find(x => norm(x[0]).replace(/ /g, '') === num) || g.nums.find(x => parseInt(x[0]) === parseInt(num));
      if (h) item = { label: h[0] + ' ' + g.n, sub: g.s, kind: 'adresse', lat: (g.lat * 1e5 + h[1]) / 1e5, lon: (g.lon * 1e5 + h[2]) / 1e5 };
    }
    out.push(item); if (out.length >= limit) break;
  }
  return out;
}

// --------------- loading ---------------
async function loadPacks(ids) {
  const t0 = performance.now(); const parts = []; GEO = [];
  for (const id of ids) {
    const gb = await PackStore.get(id, 'graph.bin'); const nb = await PackStore.get(id, 'names.json'); const geob = await PackStore.get(id, 'geo.json');
    if (!gb || !nb) continue;
    const ab = await gb.arrayBuffer(); const mg = String.fromCharCode(...new Uint8Array(ab, 0, 4));
    parts.push({ g: decodeGeom(parseGraph(ab), mg === 'GRF3'), names: JSON.parse(await nb.text()) });
    if (geob) addGeo(id, JSON.parse(await geob.text()));
  }
  G = parts.length ? merge(parts) : null;
  return { nodes: G ? G.N : 0, edges: G ? G.E : 0, stitched: G ? G.stitched : 0, entries: GEO.length, ms: Math.round(performance.now() - t0) };
}

self.onmessage = async (ev) => {
  const { id, cmd, args } = ev.data;
  try {
    let r;
    if (cmd === 'load') r = await loadPacks(args.ids);
    else if (cmd === 'route') { const t0 = performance.now(); r = route(args.from, args.to, args.heading); r.ms = Math.round(performance.now() - t0); }
    else if (cmd === 'search') r = search(args.q, args.near);
    else if (cmd === 'snap') { const s = snap(args.lat, args.lon, args.heading, 1); r = s && s.dist < 60 ? { maxs: G.maxs[s.e], name: G.names[G.name[s.e]], cls: G.cls[s.e], dist: s.dist } : null; }
    self.postMessage({ id, ok: true, r });
  } catch (e) { self.postMessage({ id, ok: false, error: String(e && e.message || e) }); }
};
