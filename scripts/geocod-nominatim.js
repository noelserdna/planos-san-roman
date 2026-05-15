#!/usr/bin/env node
/*
 * Geocodifica con Nominatim las direcciones del padrón habitantes que el cruce OSM
 * no pudo asignar, y mapea cada coordenada a la parcela catastral correspondiente.
 *
 * Lee:  data/_habitantes_geocod_osm.json (las que tienen method === 'NONE')
 *       data/parcelas.geojson
 * Escribe: data/_habitantes_geocod_nominatim.json
 *
 * Respeta el límite de 1 req/seg.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const F_PREV = path.join(DATA, '_habitantes_geocod_osm.json');
const F_PARC = path.join(DATA, 'parcelas.geojson');
const F_CACHE = path.join(DATA, '_nominatim_cache.json');
const F_OUT = path.join(DATA, '_habitantes_geocod_nominatim.json');

const RATE_MS = 1100; // > 1 segundo entre queries
const USER_AGENT = 'planos-san-roman/1.0 (noelserdna@gmail.com)';
const MUNICIPIO = 'San Román de los Montes, Toledo, España';

// ---------- helpers ----------

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
function bboxOf(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function visit(c) {
    if (typeof c[0] === 'number') {
      if (c[0] < minX) minX = c[0]; if (c[1] < minY) minY = c[1];
      if (c[0] > maxX) maxX = c[0]; if (c[1] > maxY) maxY = c[1];
    } else for (const x of c) visit(x);
  }
  visit(geom.coordinates);
  return { minX, minY, maxX, maxY };
}
function inBBox(p, b) { return p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY; }

// ---------- cargar parcelas ----------

console.log('▶ Cargando parcelas…');
const parc = JSON.parse(fs.readFileSync(F_PARC, 'utf8'));
const parcWithBBox = parc.features.map(f => {
  const refcat = f.properties.refcat || f.properties.localId || '';
  return { refcat: String(refcat).slice(0, 14), geom: f.geometry, bbox: bboxOf(f.geometry) };
});
console.log(`  ${parcWithBBox.length} parcelas indexadas con bbox`);

function findParcela(lngLat) {
  for (const p of parcWithBBox) {
    if (!inBBox(lngLat, p.bbox)) continue;
    if (pointInMultiPolygon(lngLat, p.geom)) return p.refcat;
  }
  return null;
}

// ---------- cargar previas y direcciones a geocodificar ----------

console.log('▶ Cargando match previo OSM…');
const prev = JSON.parse(fs.readFileSync(F_PREV, 'utf8'));
const sinMatch = prev.assignments.filter(a => a.method === 'NONE');
const direccionesUnicas = [...new Set(sinMatch.map(a => a.dir))];
console.log(`  ${sinMatch.length} habitantes sin match en ${direccionesUnicas.length} direcciones distintas`);

// caché en disco
let cache = {};
if (fs.existsSync(F_CACHE)) {
  try { cache = JSON.parse(fs.readFileSync(F_CACHE, 'utf8')); } catch (_) { cache = {}; }
}
console.log(`  caché Nominatim: ${Object.keys(cache).length} entradas`);

// ---------- geocodificar ----------

async function geocode(addr) {
  if (cache[addr]) return cache[addr];
  const q = `${addr}, ${MUNICIPIO}`;
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es' } });
  const data = await res.json();
  let result = null;
  if (Array.isArray(data) && data[0]) result = { lat: Number(data[0].lat), lon: Number(data[0].lon), name: data[0].display_name };
  cache[addr] = result;
  return result;
}

const results = {}; // dir → { lat, lon, refcat14, name }

(async () => {
  let i = 0;
  let hits = 0, misses = 0, outside = 0;
  for (const dir of direccionesUnicas) {
    i++;
    let cached = !!cache[dir];
    let r;
    try {
      r = await geocode(dir);
    } catch (e) {
      console.log(`  [${i}/${direccionesUnicas.length}] error: ${e.message} — ${dir}`);
      r = null;
    }
    if (r) {
      const ref = findParcela([r.lon, r.lat]);
      results[dir] = { ...r, refcat14: ref };
      if (ref) hits++; else outside++;
      console.log(`  [${i}/${direccionesUnicas.length}] ${cached ? '★' : '·'} ${dir}  →  ${ref || '(fuera de parcela)'}  ${cached ? '(cache)' : ''}`);
    } else {
      results[dir] = null;
      misses++;
      console.log(`  [${i}/${direccionesUnicas.length}] ${cached ? '★' : '·'} ${dir}  →  sin resultado`);
    }
    // persistir caché de forma incremental cada 20 queries
    if (i % 20 === 0) fs.writeFileSync(F_CACHE, JSON.stringify(cache, null, 2));
    if (!cached) await new Promise(r => setTimeout(r, RATE_MS));
  }
  fs.writeFileSync(F_CACHE, JSON.stringify(cache, null, 2));

  // emparejar a habitantes
  const assignments = sinMatch.map(a => {
    const r = results[a.dir];
    return {
      ...a,
      nominatim_lat: r ? r.lat : null,
      nominatim_lon: r ? r.lon : null,
      nominatim_name: r ? r.name : null,
      refcat14_nominatim: r ? r.refcat14 : null
    };
  });

  fs.writeFileSync(F_OUT, JSON.stringify({
    total_input: sinMatch.length,
    unique_addresses: direccionesUnicas.length,
    hits_with_refcat: hits,
    outside_municipal_parcel: outside,
    no_result: misses,
    generated_at: new Date().toISOString(),
    assignments
  }, null, 2));

  console.log(`\n✔ Nominatim:`);
  console.log(`   direcciones únicas geocodificadas: ${direccionesUnicas.length}`);
  console.log(`   con parcela asignada: ${hits}`);
  console.log(`   geocodificadas pero fuera de cualquier parcela: ${outside}`);
  console.log(`   sin resultado: ${misses}`);
  console.log(`\n  resultados → ${F_OUT}`);
})();
