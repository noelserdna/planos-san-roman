#!/usr/bin/env node
/*
 * Cruza Padrón Habitantes con calles OSM.
 *
 * Estrategia: para cada calle nombrada de OSM dentro del término municipal,
 * recolecta los portales del catastro (direcciones.geojson) que están a <= 30 m de
 * la línea. Eso da un índice: nombre OSM normalizado → set de (refcat14, designator).
 * Luego, para cada habitante, busca el nombre de su calle en OSM y filtra los
 * portales con su número.
 *
 * Genera:
 *   data/_tmp_calle_to_portales.json      diagnóstico
 *   data/habitantes_geocodificados.json   refcat14 asignado por habitante (sólo para
 *                                          uso del unificador principal)
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DATA = path.join(__dirname, '..', 'data');
const OSM_FILE = path.join(DATA, '_tmp_osm_streets.json');
const LIM_FILE = path.join(DATA, 'limite.geojson');
const DIR_FILE = path.join(DATA, 'direcciones.geojson');
const HAB_FILE = path.join(DATA, 'listadoHabitantesListados.xlsx');

const BUFFER_M = 30;

// ---------- helpers ----------

const stripDiacritics = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const collapse = s => stripDiacritics(String(s || '')).toUpperCase()
  .replace(/[(),.;:]/g, ' ').replace(/\s+/g, ' ').trim();

const STOPWORDS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'Y']);
const norm = s => collapse(s).split(' ').filter(t => t && !STOPWORDS.has(t)).join(' ');

const SIGLA_FROM_HAB = {
  CALLE: 'CL', CALLEJON: 'CJ', AVENIDA: 'AV', PLAZA: 'PZ', RONDA: 'RD',
  CARRETERA: 'CR', CAMINO: 'CM', PASEO: 'PS', PASAJE: 'PJ', TRAVESIA: 'TR',
  FINCA: 'FN', LUGAR: 'LG', PARAJE: 'PR'
};

// elimina sigla en cabecera del nombre OSM (Calle, Avenida, Plaza...)
const OSM_PREFIXES = new Set([
  'CALLE', 'AVENIDA', 'PLAZA', 'RONDA', 'CARRETERA', 'CAMINO', 'PASEO',
  'PASAJE', 'TRAVESIA', 'FINCA', 'LUGAR', 'PARAJE', 'CALLEJON',
  'GLORIETA', 'CL', 'AV', 'PZ', 'RD', 'CR', 'CM', 'PS', 'PJ', 'TR', 'GR'
]);
function stripStreetPrefix(s) {
  const tokens = collapse(s).split(' ');
  if (tokens.length && OSM_PREFIXES.has(tokens[0])) tokens.shift();
  return tokens.filter(t => !STOPWORDS.has(t)).join(' ');
}

// Distancia gran círculo (m)
function haversine(a, b) {
  const R = 6371000;
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLng = (b[0] - a[0]) * Math.PI / 180;
  const lat1 = a[1] * Math.PI / 180, lat2 = b[1] * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Proyección local equirrectangular en metros centrada en latRef
function projector(latRef) {
  const R = 6371000;
  const cosLat = Math.cos(latRef * Math.PI / 180);
  return (lng, lat) => [
    R * (lng * Math.PI / 180) * cosLat,
    R * (lat * Math.PI / 180)
  ];
}

// Distancia punto-segmento en plano (todas las coords ya en metros)
function pointSegmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  const px = a[0] + t * dx, py = a[1] + t * dy;
  return Math.hypot(p[0] - px, p[1] - py);
}

// Point-in-polygon (ray casting)
function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function pointInPolygon(point, poly) {
  if (!pointInRing(point, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(point, poly[i])) return false;
  return true;
}
function pointInMultiPolygon(point, geom) {
  if (geom.type === 'Polygon') return pointInPolygon(point, geom.coordinates);
  if (geom.type === 'MultiPolygon') {
    for (const p of geom.coordinates) if (pointInPolygon(point, p)) return true;
  }
  return false;
}

// ---------- cargar fuentes ----------

console.log('▶ Cargando datos…');
const osm = JSON.parse(fs.readFileSync(OSM_FILE, 'utf8'));
const lim = JSON.parse(fs.readFileSync(LIM_FILE, 'utf8'));
const dir = JSON.parse(fs.readFileSync(DIR_FILE, 'utf8'));
const hab = XLSX.utils.sheet_to_json(XLSX.readFile(HAB_FILE).Sheets['Sheet1'], { defval: '' });
console.log(`  OSM ways: ${osm.elements.length} · Portales catastrales: ${dir.features.length} · Habitantes: ${hab.length}`);

// proyector centrado en la latitud media
const limGeom = lim.features[0].geometry;
function approxCentroidLat(geom) {
  let total = 0, n = 0;
  function visit(c) {
    if (typeof c[0] === 'number') { total += c[1]; n++; }
    else for (const x of c) visit(x);
  }
  visit(geom.coordinates);
  return total / n;
}
const latRef = approxCentroidLat(limGeom);
const proj = projector(latRef);
console.log(`  proyector centrado en lat ${latRef.toFixed(4)}`);

// ---------- filtrar vías OSM dentro del límite municipal ----------

const insideWays = [];
for (const w of osm.elements) {
  if (!w.geometry || !w.tags?.name) continue;
  // un way está "dentro" si al menos un nodo está dentro del polígono municipal
  let anyInside = false;
  for (const node of w.geometry) {
    if (pointInMultiPolygon([node.lon, node.lat], limGeom)) { anyInside = true; break; }
  }
  if (anyInside) insideWays.push(w);
}
console.log(`▶ Vías OSM dentro del término: ${insideWays.length}`);

// ---------- agrupar segmentos por nombre y proyectar ----------

const calles = new Map(); // nombreNormSinPrefix → { segments: [[ [x,y], [x,y] ], ...], displayName, bbox }
for (const w of insideWays) {
  const n = w.tags.name;
  const k = stripStreetPrefix(n);
  if (!k) continue;
  let entry = calles.get(k);
  if (!entry) {
    entry = { displayName: n, segments: [], bboxM: [Infinity, Infinity, -Infinity, -Infinity], names: new Set() };
    calles.set(k, entry);
  }
  entry.names.add(n);
  // proyectar nodos
  const pts = w.geometry.map(p => proj(p.lon, p.lat));
  for (let i = 0; i + 1 < pts.length; i++) entry.segments.push([pts[i], pts[i + 1]]);
  for (const p of pts) {
    if (p[0] < entry.bboxM[0]) entry.bboxM[0] = p[0];
    if (p[1] < entry.bboxM[1]) entry.bboxM[1] = p[1];
    if (p[0] > entry.bboxM[2]) entry.bboxM[2] = p[0];
    if (p[1] > entry.bboxM[3]) entry.bboxM[3] = p[1];
  }
}
console.log(`▶ Calles únicas (sin sigla): ${calles.size}`);

// ---------- asignar portales catastrales a cada calle ----------

// proyectar portales
const portalesProj = [];
for (const f of dir.features) {
  const p = f.properties;
  if (!p.refcat14 || !p.designator || !f.geometry?.coordinates) continue;
  const xy = proj(f.geometry.coordinates[0], f.geometry.coordinates[1]);
  portalesProj.push({
    xy,
    refcat14: p.refcat14,
    designator: p.designator,
    designatorNum: parseInt(p.designator, 10) || null,
    catStreetName: p.street_name ? norm(p.street_name) : null,
    catSigla: p.sigla || null
  });
}

const calleToPortales = new Map(); // nombre normalizado → [{ refcat14, designator, dist }]
let asignados = 0;
for (const [name, c] of calles) {
  const [minX, minY, maxX, maxY] = c.bboxM;
  const margin = BUFFER_M + 5;
  for (const portal of portalesProj) {
    const [x, y] = portal.xy;
    if (x < minX - margin || x > maxX + margin || y < minY - margin || y > maxY + margin) continue;
    // distancia mínima a cualquier segmento
    let best = Infinity;
    for (const [a, b] of c.segments) {
      const d = pointSegmentDistance(portal.xy, a, b);
      if (d < best) { best = d; if (best <= 0.5) break; }
    }
    if (best <= BUFFER_M) {
      let lst = calleToPortales.get(name);
      if (!lst) { lst = []; calleToPortales.set(name, lst); }
      lst.push({ refcat14: portal.refcat14, designator: portal.designator, designatorNum: portal.designatorNum, dist: best });
      asignados++;
    }
  }
}
console.log(`▶ Asignaciones portal-calle: ${asignados}  (${calleToPortales.size} calles con al menos 1 portal)`);

// Guardar diagnóstico
const diag = {};
for (const [k, v] of calleToPortales) diag[k] = {
  display: calles.get(k).displayName,
  n_portales: v.length,
  designators: [...new Set(v.map(x => x.designator))].sort()
};
fs.writeFileSync(path.join(DATA, '_tmp_calle_to_portales.json'), JSON.stringify(diag, null, 2));

// ---------- cruzar habitantes ----------

function parseHabDir(dir) {
  const s = collapse(dir);
  const tokens = s.split(' ');
  let sigla = null, rest = tokens;
  if (SIGLA_FROM_HAB[tokens[0]]) { sigla = SIGLA_FROM_HAB[tokens[0]]; rest = tokens.slice(1); }
  const restStr = rest.join(' ');
  const m = restStr.match(/^(.+?)\s+(\d+)(?:\s+(.*))?$/);
  if (m) return { sigla, nameRaw: m[1].trim(), name: norm(m[1].trim()), portal: parseInt(m[2], 10), tail: (m[3] || '').trim() };
  return { sigla, nameRaw: restStr, name: norm(restStr), portal: null, tail: '' };
}

const tokenIndex = new Map(); // token → set(nombre)
for (const k of calles.keys()) for (const tok of k.split(' ')) if (tok.length >= 4) {
  let s = tokenIndex.get(tok);
  if (!s) { s = new Set(); tokenIndex.set(tok, s); }
  s.add(k);
}

function findCalle(habName) {
  // exacto
  if (calles.has(habName)) return [habName];
  // contención
  const hits = new Set();
  for (const k of calles.keys()) {
    if (k.includes(habName) || habName.includes(k)) hits.add(k);
  }
  if (hits.size) return [...hits];
  // por tokens
  const toks = habName.split(' ').filter(t => t.length >= 4);
  const counts = new Map();
  for (const t of toks) {
    const matches = tokenIndex.get(t);
    if (!matches) continue;
    for (const k of matches) counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (!counts.size) return [];
  const max = Math.max(...counts.values());
  return [...counts.entries()].filter(([_, c]) => c === max).map(([k]) => k);
}

const assignments = []; // por habitante (sin PII)
let mExact = 0, mPartial = 0, mNone = 0;
const sinMatchEjemplos = [];

for (const h of hab) {
  if (h['Estado habitante'] !== 'Alta') continue;
  const sp = parseHabDir(h.Dirección);
  let resultRef = null;
  let method = 'NONE';
  let nCand = 0;

  if (sp.name && sp.portal !== null) {
    const calleCandidatas = findCalle(sp.name);
    let portalesElegidos = [];
    for (const k of calleCandidatas) {
      const lst = calleToPortales.get(k) || [];
      for (const p of lst) if (p.designatorNum === sp.portal) portalesElegidos.push({ ...p, calle: k });
    }
    if (!portalesElegidos.length && calleCandidatas.length) {
      // intentar portal ±1 ó letras del tail
      for (const k of calleCandidatas) {
        const lst = calleToPortales.get(k) || [];
        for (const p of lst) {
          if (Math.abs(p.designatorNum - sp.portal) <= 1) portalesElegidos.push({ ...p, calle: k, fuzzy: true });
        }
      }
    }
    if (portalesElegidos.length) {
      // dedup por refcat14, ordenar por distancia y quedarse con los más cercanos
      const byRef = new Map();
      for (const p of portalesElegidos) {
        if (!byRef.has(p.refcat14) || byRef.get(p.refcat14).dist > p.dist) byRef.set(p.refcat14, p);
      }
      const sorted = [...byRef.values()].sort((a, b) => a.dist - b.dist);
      resultRef = sorted.map(p => p.refcat14);
      method = portalesElegidos.some(p => p.fuzzy) ? 'fuzzy' : 'exact';
      nCand = resultRef.length;
      if (method === 'exact') mExact++; else mPartial++;
    } else {
      mNone++;
      if (sinMatchEjemplos.length < 30) sinMatchEjemplos.push(h.Dirección);
    }
  } else {
    mNone++;
    if (sinMatchEjemplos.length < 30) sinMatchEjemplos.push(h.Dirección);
  }

  assignments.push({
    dir: h.Dirección,
    sigla: sp.sigla || '',
    name: sp.name,
    portal: sp.portal,
    method,
    n_cand: nCand,
    refcat14_list: resultRef ? resultRef.join(';') : ''
  });
}

const totalAlta = assignments.length;
const matched = mExact + mPartial;
console.log(`▶ Habitantes (Alta=${totalAlta}):`);
console.log(`    exactos: ${mExact}  ·  fuzzy (±1 portal): ${mPartial}  ·  total con match: ${matched} (${(100*matched/totalAlta).toFixed(1)}%)`);
console.log(`    sin match: ${mNone}  (${(100*mNone/totalAlta).toFixed(1)}%)`);
console.log('\n  Ejemplos sin match:');
sinMatchEjemplos.slice(0, 15).forEach(d => console.log('    ' + d));

fs.writeFileSync(path.join(DATA, '_habitantes_geocod_osm.json'), JSON.stringify({
  total: totalAlta,
  matched, exact: mExact, partial: mPartial, none: mNone,
  buffer_m: BUFFER_M,
  generated_at: new Date().toISOString(),
  assignments
}, null, 2));

console.log('\n✔ Guardado data/_habitantes_geocod_osm.json');
console.log('  (lo consume scripts/unificar-civico.js para asignar habitantes_estimados a parcelas)');
