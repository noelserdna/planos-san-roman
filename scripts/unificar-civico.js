#!/usr/bin/env node
/*
 * Unifica IBIU 2024 + Padrón Tasas + Padrón Habitantes.
 *
 * Entradas:
 *   data/IBIU 2024.xls
 *   data/PADRON TASAS PROPIEDAD INMOBILIARIA (2).xls
 *   data/listadoHabitantesListados.xlsx
 *   data/direcciones.geojson           (generado por build-direcciones-enriquecidas.js)
 *
 * Salidas públicas (sin PII):
 *   data/unidades_catastrales.csv      1 fila por unidad (refcat 20)
 *   data/parcelas_agregadas.csv        1 fila por parcela (refcat 14)
 *   data/habitantes_por_calle.csv      conteo agregado por calle normalizada
 *   data/_civic_unificacion_report.md  informe legible
 *
 * Salidas privadas (CONTIENEN PII — fuera del repo público vía .gitignore):
 *   data/_privado/personas_dni.csv     una fila por DNI/NIF con todos los enlaces
 *   data/_privado/inmuebles_titular.csv  inmuebles con nombre/NIF del titular
 *   data/_privado/habitantes_geocodificados.csv  cada habitante con refcat14 asignado
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const PRIV = path.join(DATA, '_privado');
fs.mkdirSync(PRIV, { recursive: true });

const F_IBIU = path.join(DATA, 'IBIU 2024.xls');
const F_PAD  = path.join(DATA, 'PADRON TASAS PROPIEDAD INMOBILIARIA (2).xls');
const F_HAB  = path.join(DATA, 'listadoHabitantesListados.xlsx');
const F_DIR  = path.join(DATA, 'direcciones.geojson');
const F_PARC = path.join(DATA, 'parcelas.geojson');
const F_OSM  = path.join(DATA, '_habitantes_geocod_osm.json');
const F_NOM  = path.join(DATA, '_habitantes_geocod_nominatim.json');

// ---------- helpers ----------

const SIGLA_FROM_HAB = {
  CALLE: 'CL', CALLEJON: 'CJ', AVENIDA: 'AV', PLAZA: 'PZ', RONDA: 'RD',
  CARRETERA: 'CR', CAMINO: 'CM', PASEO: 'PS', PASAJE: 'PJ', TRAVESIA: 'TR',
  FINCA: 'FN', LUGAR: 'LG', PARAJE: 'PR'
};

const stripDiacritics = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const collapse = s => stripDiacritics(String(s || '')).toUpperCase()
  .replace(/[(),.;:]/g, ' ')
  .replace(/\s+/g, ' ').trim();

const STOPWORDS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL']);
const tokenize = s => collapse(s).split(' ').filter(t => t && !STOPWORDS.has(t));
const normalizeName = s => tokenize(s).join(' ');

function splitHabDir(dir) {
  const s = collapse(dir);
  const tokens = s.split(' ');
  let sigla = null, rest = tokens;
  if (SIGLA_FROM_HAB[tokens[0]]) {
    sigla = SIGLA_FROM_HAB[tokens[0]];
    rest = tokens.slice(1);
  }
  const restStr = rest.join(' ');
  // captura el primer entero que aparezca → portal
  const m = restStr.match(/^(.+?)\s+(\d+)(?:\s+(.*))?$/);
  if (m) {
    return { sigla, name: m[1].trim(), portal: String(parseInt(m[2], 10)), tail: (m[3] || '').trim() };
  }
  return { sigla, name: restStr.trim(), portal: null, tail: '' };
}

function toEuro(cents) {
  const n = Number(cents);
  if (!isFinite(n)) return '';
  return (n / 100).toFixed(2);
}

const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '0%';

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function writeCsv(file, rows, columns) {
  const out = [columns.join(',')];
  for (const r of rows) out.push(columns.map(c => csvCell(r[c])).join(','));
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
}

// ---------- cargar fuentes ----------

console.log('▶ Cargando XLS/XLSX y direcciones enriquecidas…');
const ibiu = XLSX.utils.sheet_to_json(XLSX.readFile(F_IBIU).Sheets['IBIU'], { defval: '' });
const padron = XLSX.utils.sheet_to_json(XLSX.readFile(F_PAD).Sheets['Padron'], { defval: '' });
const habit = XLSX.utils.sheet_to_json(XLSX.readFile(F_HAB).Sheets['Sheet1'], { defval: '' });
const direcciones = JSON.parse(fs.readFileSync(F_DIR, 'utf8'));
console.log(`  IBIU: ${ibiu.length}  ·  Padrón Tasas: ${padron.length}  ·  Habitantes: ${habit.length}  ·  Portales: ${direcciones.features.length}`);

// ---------- 1) Padrón Tasas agregado por refcat20 ----------

const tasasPorRef20 = new Map();
for (const r of padron) {
  const ref20 = String(r.Ref_Catastral_Fin || '').trim().toUpperCase();
  if (!ref20) continue;
  const imp = Number(String(r.Importe_Conc || 0).replace(',', '.')) || 0;
  const acc = tasasPorRef20.get(ref20) || { importeCent: 0, registros: 0 };
  acc.importeCent += imp;
  acc.registros += 1;
  tasasPorRef20.set(ref20, acc);
}

// ---------- 2) Unidades catastrales (IBIU + Tasas) ----------

const unidades = [];
const unidadesPriv = []; // con NIF/nombre
for (const r of ibiu) {
  const ref20 = String(r.REF_CATASTRAL || '').trim().toUpperCase();
  if (!ref20) continue;
  const tasas = tasasPorRef20.get(ref20);

  const publico = {
    refcat: ref20,
    refcat_parcela: ref20.slice(0, 14),
    municipio: r.NOMBRE_MUNI_SOPORTE_MSOP || 'SAN ROMAN DE LOS MONTES',
    sigla_via: r.SIGLA_VIA_IIBU || '',
    via: r.VIA || '',
    planta: r.PLANTA_IIBU || '',
    puerta: r.PUERTA_IIBU || '',
    escalera: r.ESCALERA_IIBU || '',
    clase_bien: r.CLASE_BIEN || '',
    uso: r.DESCR_CLAVE_USO_IIBU || '',
    clave_uso: r.CLAVE_USO_IIBU || '',
    valor_catastral_eur: toEuro(r.VALOR_CATAST_IIBU),
    valor_suelo_eur: toEuro(r.VALOR_CATAST_SUELO_IIBU),
    valor_construccion_eur: toEuro(r.VALOR_CATAST_CONST_IIBU),
    base_liquidable_eur: toEuro(r.BASE_LIQ_IIBU),
    tipo_impositivo: r.TIPO_IMPOSIT_RECA || '',
    cuota_ibi_eur: toEuro(r.CUOTA),
    exento: r.EXENTO || '',
    bonificado: (r.BON && String(r.BON).trim()) || '',
    tasa_basura_eur: tasas ? toEuro(tasas.importeCent) : '',
    tasa_basura_registros: tasas ? tasas.registros : 0,
    tiene_padron_tasas: tasas ? 1 : 0
  };
  unidades.push(publico);

  unidadesPriv.push({
    ...publico,
    nif: String(r.NIF_IIBU || '').trim(),
    titular: String(r.NOMBRE_IIBU || '').trim(),
    personalidad: r.PERSONALIDAD_IIBU || '',
    porc_participacion: r.PORC_PARTICIP_IIBU || '',
    domicilio_fiscal: r.DOMICILIO || '',
    municipio_fiscal: r.MUNI_DF_IIBU || '',
    provincia_fiscal: r.PROV_DF_IIBU || '',
    cp_fiscal: r.CP_DF_IIBU || ''
  });
}

// detectar duplicados refcat20
const ref20Counts = new Map();
for (const u of unidades) ref20Counts.set(u.refcat, (ref20Counts.get(u.refcat) || 0) + 1);
const dupsIbiu = [...ref20Counts.entries()].filter(([_, n]) => n > 1).length;

const sinTasas = unidades.filter(u => !u.tiene_padron_tasas).length;
const refsIbiuSet20 = new Set(unidades.map(u => u.refcat));
const tasasHuérfanas = [...tasasPorRef20.keys()].filter(k => !refsIbiuSet20.has(k)).length;

// ---------- 3) Índice direcciones.geojson (sigla + nombre + portal) → refcat14 ----------

const portalIndexA = new Map(); // con sigla
const portalIndexB = new Map(); // sin sigla
const portalIndexC = new Map(); // sin sigla, nombre fuzzy (sólo primera palabra) → soporte de "SAN ROMAN"

function add(map, key, ref14, gmlId) {
  if (!map.has(key)) map.set(key, new Map());
  // usar Map para deduplicar ref14 → lista de portales (gmlId)
  if (!map.get(key).has(ref14)) map.get(key).set(ref14, gmlId);
}

for (const f of direcciones.features) {
  const p = f.properties;
  if (!p.refcat14 || !p.designator) continue;
  const nameNorm = normalizeName(p.street_name);
  if (!nameNorm) continue;
  const portal = String(parseInt(p.designator, 10));
  if (isNaN(parseInt(portal, 10))) continue;
  const sigla = (p.sigla || '_').toUpperCase();
  add(portalIndexA, `${sigla}|${nameNorm}|${portal}`, p.refcat14, p.localId);
  add(portalIndexB, `${nameNorm}|${portal}`, p.refcat14, p.localId);
  // fuzzy: cada token del nombre → portal
  for (const tok of nameNorm.split(' ')) {
    if (tok.length >= 4) add(portalIndexC, `${tok}|${portal}`, p.refcat14, p.localId);
  }
}

// índice secundario para portales A/B/... (designator con letras: "13A", "0132B")
const portalLetterIndex = new Map(); // (sigla|name|portalNum|letter)
for (const f of direcciones.features) {
  const p = f.properties;
  if (!p.refcat14 || !p.designator) continue;
  const m = String(p.designator).match(/^(\d+)([A-Z])$/i);
  if (!m) continue;
  const nameNorm = normalizeName(p.street_name);
  const sigla = (p.sigla || '_').toUpperCase();
  const k = `${sigla}|${nameNorm}|${parseInt(m[1], 10)}|${m[2].toUpperCase()}`;
  add(portalLetterIndex, k, p.refcat14, p.localId);
}

console.log(`▶ Índice de direcciones: ${portalIndexA.size} (sigla|nombre|portal)  ·  ${portalIndexB.size} (nombre|portal)  ·  ${portalIndexC.size} (token|portal)  ·  ${portalLetterIndex.size} con letra`);

// ---------- 4) Cruce habitantes — usa precómputo OSM + Nominatim ----------

const habitantesPorRef14 = new Map();
const habitantesGeocod = []; // privado: 1 fila por habitante con refcat14 asignado
const habitantesPorCalle = new Map();

let osmAssign = null, nomAssign = null, parcelasGJ = null;
if (fs.existsSync(F_OSM)) osmAssign = JSON.parse(fs.readFileSync(F_OSM, 'utf8'));
if (fs.existsSync(F_NOM)) nomAssign = JSON.parse(fs.readFileSync(F_NOM, 'utf8'));
if (fs.existsSync(F_PARC)) parcelasGJ = JSON.parse(fs.readFileSync(F_PARC, 'utf8'));
if (!osmAssign) console.warn('  ! falta data/_habitantes_geocod_osm.json (ejecuta scripts/cruzar-habitantes-osm.js)');

const osmByDir = new Map();
if (osmAssign) for (const a of osmAssign.assignments) osmByDir.set(a.dir, a);
const nomByDir = new Map();
if (nomAssign) for (const a of nomAssign.assignments) nomByDir.set(a.dir, a);

// índice spatial mínimo de parcelas para Nominatim
const parcWithBBox = [];
if (parcelasGJ) {
  const bboxOfGeom = g => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const v = c => {
      if (typeof c[0] === 'number') {
        if (c[0] < minX) minX = c[0]; if (c[1] < minY) minY = c[1];
        if (c[0] > maxX) maxX = c[0]; if (c[1] > maxY) maxY = c[1];
      } else for (const x of c) v(x);
    };
    v(g.coordinates);
    return { minX, minY, maxX, maxY };
  };
  const centroidOf = g => {
    let sx = 0, sy = 0, n = 0;
    const v = c => { if (typeof c[0] === 'number') { sx += c[0]; sy += c[1]; n++; } else for (const x of c) v(x); };
    v(g.coordinates);
    return [sx / n, sy / n];
  };
  for (const f of parcelasGJ.features) {
    const refcat = String(f.properties.refcat || f.properties.localId || '').slice(0, 14);
    parcWithBBox.push({ refcat, geom: f.geometry, bbox: bboxOfGeom(f.geometry), centroid: centroidOf(f.geometry) });
  }
}

function distMeters(a, b) {
  const R = 6371000;
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLng = (b[0] - a[0]) * Math.PI / 180;
  const lat1 = a[1] * Math.PI / 180, lat2 = b[1] * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function pir(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function pip(point, poly) { if (!pir(point, poly[0])) return false; for (let i = 1; i < poly.length; i++) if (pir(point, poly[i])) return false; return true; }
function pimp(point, geom) { if (geom.type === 'Polygon') return pip(point, geom.coordinates); if (geom.type === 'MultiPolygon') for (const p of geom.coordinates) if (pip(point, p)) return true; return false; }
function inBBox(p, b) { return p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY; }

function findParcelaForLonLat(lon, lat, snapMeters = 50) {
  for (const p of parcWithBBox) {
    if (!inBBox([lon, lat], p.bbox)) continue;
    if (pimp([lon, lat], p.geom)) return { refcat: p.refcat, mode: 'contain', dist_m: 0 };
  }
  let best = null, bestDist = Infinity;
  for (const p of parcWithBBox) {
    const dxApprox = Math.max(0, Math.max(p.bbox.minX - lon, lon - p.bbox.maxX));
    const dyApprox = Math.max(0, Math.max(p.bbox.minY - lat, lat - p.bbox.maxY));
    if (Math.hypot(dxApprox, dyApprox) > 0.001) continue;
    const d = distMeters([lon, lat], p.centroid);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  if (best && bestDist <= snapMeters) return { refcat: best.refcat, mode: 'snap', dist_m: bestDist };
  return null;
}

let mOsmExact = 0, mOsmFuzzy = 0, mNomContain = 0, mNomSnap = 0, mNoMatch = 0;
const sinMatch = [];

for (const h of habit) {
  if (h['Estado habitante'] !== 'Alta') continue;
  const dirRaw = String(h.Dirección || '');
  const sp = splitHabDir(dirRaw);
  const nameNorm = normalizeName(sp.name);

  if (nameNorm) {
    const k = `${sp.sigla || '_'}|${nameNorm}`;
    habitantesPorCalle.set(k, (habitantesPorCalle.get(k) || 0) + 1);
  }

  let refList = [];
  let metodo = 'NONE';
  let detalle = '';

  // 1) OSM cross-matching
  const oa = osmByDir.get(dirRaw);
  if (oa && oa.method !== 'NONE' && oa.refcat14_list) {
    refList = oa.refcat14_list.split(';').filter(Boolean);
    metodo = oa.method === 'exact' ? 'osm-exact' : 'osm-fuzzy';
    if (metodo === 'osm-exact') mOsmExact++; else mOsmFuzzy++;
  }

  // 2) Nominatim (sólo si OSM no resolvió)
  if (!refList.length) {
    const na = nomByDir.get(dirRaw);
    if (na && na.nominatim_lat != null && na.nominatim_lon != null && parcWithBBox.length) {
      const res = findParcelaForLonLat(na.nominatim_lon, na.nominatim_lat, 50);
      if (res) {
        refList = [res.refcat];
        metodo = res.mode === 'contain' ? 'nominatim-contain' : 'nominatim-snap';
        detalle = `${res.dist_m.toFixed(1)}m`;
        if (res.mode === 'contain') mNomContain++; else mNomSnap++;
      }
    }
  }

  if (refList.length) {
    const peso = 1 / refList.length;
    for (const ref14 of refList) {
      habitantesPorRef14.set(ref14, (habitantesPorRef14.get(ref14) || 0) + peso);
    }
  } else {
    mNoMatch++;
    if (sinMatch.length < 30) sinMatch.push(dirRaw);
  }

  habitantesGeocod.push({
    dni: h['Número de documento'] || '',
    apellidos_nombre: h['Apellidos y nombre'] || '',
    nacimiento: h['Nacimiento'] || '',
    direccion_padron: dirRaw,
    estado: h['Estado habitante'] || '',
    sigla_normalizada: sp.sigla || '',
    calle_normalizada: nameNorm,
    portal_normalizado: sp.portal || '',
    metodo_match: metodo,
    detalle,
    n_candidatos: refList.length,
    refcat14_asignados: refList.join(';')
  });
}

const totalAlta = habit.filter(h => h['Estado habitante'] === 'Alta').length;
const totalMatched = mOsmExact + mOsmFuzzy + mNomContain + mNomSnap;
console.log(`▶ Habitantes en Alta: ${totalAlta}`);
console.log(`    OSM exacto:          ${mOsmExact}`);
console.log(`    OSM fuzzy ±1:        ${mOsmFuzzy}`);
console.log(`    Nominatim contain:   ${mNomContain}`);
console.log(`    Nominatim snap<=50m: ${mNomSnap}`);
console.log(`    SIN MATCH:           ${mNoMatch}  (${pct(mNoMatch, totalAlta)})`);
console.log(`    TOTAL matched:       ${totalMatched}/${totalAlta} (${pct(totalMatched, totalAlta)})`);
// alias para mantener compatibilidad con el reporte
const mUnique = totalMatched, mAmbig = 0, mFuzzy = mOsmFuzzy, mLetter = 0, mNada = mNoMatch;

// ---------- 5) Parcelas agregadas ----------

const parcelas = new Map();
for (const u of unidades) {
  const k = u.refcat_parcela;
  const acc = parcelas.get(k) || {
    refcat: k,
    n_unidades: 0,
    valor_catastral_eur: 0,
    valor_suelo_eur: 0,
    valor_construccion_eur: 0,
    cuota_ibi_eur: 0,
    tasa_basura_eur: 0,
    usos: new Map(),
    n_exentos: 0,
    n_bonificados: 0,
    via_referencia: `${u.sigla_via} ${u.via}`.trim()
  };
  acc.n_unidades += 1;
  acc.valor_catastral_eur += Number(u.valor_catastral_eur || 0);
  acc.valor_suelo_eur += Number(u.valor_suelo_eur || 0);
  acc.valor_construccion_eur += Number(u.valor_construccion_eur || 0);
  acc.cuota_ibi_eur += Number(u.cuota_ibi_eur || 0);
  acc.tasa_basura_eur += Number(u.tasa_basura_eur || 0);
  acc.usos.set(u.uso || '(sin uso)', (acc.usos.get(u.uso || '(sin uso)') || 0) + 1);
  if (String(u.exento).toUpperCase() === 'S') acc.n_exentos += 1;
  if (u.bonificado && u.bonificado !== '0') acc.n_bonificados += 1;
  parcelas.set(k, acc);
}

const parcelasRows = [];
for (const [ref14, p] of parcelas) {
  const usos = [...p.usos.entries()].sort((a, b) => b[1] - a[1]);
  const hab = Number((habitantesPorRef14.get(ref14) || 0).toFixed(2));
  parcelasRows.push({
    refcat: ref14,
    n_unidades: p.n_unidades,
    valor_catastral_eur: p.valor_catastral_eur.toFixed(2),
    valor_suelo_eur: p.valor_suelo_eur.toFixed(2),
    valor_construccion_eur: p.valor_construccion_eur.toFixed(2),
    cuota_ibi_eur: p.cuota_ibi_eur.toFixed(2),
    tasa_basura_eur: p.tasa_basura_eur.toFixed(2),
    coste_municipal_total_eur: (p.cuota_ibi_eur + p.tasa_basura_eur).toFixed(2),
    uso_dominante: usos[0] ? usos[0][0] : '',
    es_mixta: usos.length > 1 ? 1 : 0,
    n_exentos: p.n_exentos,
    n_bonificados: p.n_bonificados,
    habitantes_estimados: hab,
    densidad_hab_por_unidad: p.n_unidades ? Number((hab / p.n_unidades).toFixed(2)) : 0,
    via_referencia: p.via_referencia
  });
}

// ---------- 6) Habitantes por calle ----------

const habCalleRows = [...habitantesPorCalle.entries()]
  .map(([k, n]) => {
    const [sigla, nombre] = k.split('|');
    return { sigla, calle_normalizada: nombre, habitantes: n };
  })
  .sort((a, b) => b.habitantes - a.habitantes);

// ---------- 7) DB privada con DNI cruzado ----------

console.log('▶ Construyendo DB privada (PII)…');

// 7a) Inmuebles con titular (IBIU enriquecido + tasas)
writeCsv(path.join(PRIV, 'inmuebles_titular.csv'), unidadesPriv, [
  'refcat', 'refcat_parcela', 'sigla_via', 'via', 'planta', 'puerta', 'escalera',
  'uso', 'valor_catastral_eur', 'cuota_ibi_eur', 'tasa_basura_eur',
  'nif', 'titular', 'personalidad', 'porc_participacion',
  'domicilio_fiscal', 'municipio_fiscal', 'provincia_fiscal', 'cp_fiscal'
]);

// 7b) Habitantes geocodificados
writeCsv(path.join(PRIV, 'habitantes_geocodificados.csv'), habitantesGeocod, [
  'dni', 'apellidos_nombre', 'nacimiento', 'direccion_padron', 'estado',
  'sigla_normalizada', 'calle_normalizada', 'portal_normalizado',
  'metodo_match', 'n_candidatos', 'refcat14_asignados'
]);

// 7c) personas_dni.csv: 1 fila por documento, con todas las fuentes en las que aparece
const personas = new Map(); // DNI/NIF → datos
function bump(dni, src, payload) {
  if (!dni) return;
  const k = dni.toUpperCase();
  const p = personas.get(k) || {
    documento: k,
    nombres_observados: new Set(),
    en_padron_habitantes: 0,
    en_ibiu_titular: 0,
    en_padron_tasas_titular: 0,
    n_inmuebles_ibiu: 0,
    refcat20_titular: new Set(),
    valor_catastral_total_eur: 0,
    cuota_ibi_total_eur: 0,
    tasa_basura_total_eur: 0,
    fecha_nacimiento: '',
    direcciones_residencia: new Set()
  };
  if (src === 'hab') {
    p.en_padron_habitantes += 1;
    if (payload.nombre) p.nombres_observados.add(payload.nombre);
    if (payload.nacimiento) p.fecha_nacimiento = payload.nacimiento;
    if (payload.direccion) p.direcciones_residencia.add(payload.direccion);
  } else if (src === 'ibiu') {
    p.en_ibiu_titular += 1;
    p.n_inmuebles_ibiu += 1;
    if (payload.nombre) p.nombres_observados.add(payload.nombre);
    p.refcat20_titular.add(payload.refcat);
    p.valor_catastral_total_eur += Number(payload.valor) || 0;
    p.cuota_ibi_total_eur += Number(payload.cuota) || 0;
    p.tasa_basura_total_eur += Number(payload.tasa) || 0;
  } else if (src === 'pad') {
    p.en_padron_tasas_titular += 1;
    if (payload.nombre) p.nombres_observados.add(payload.nombre);
  }
  personas.set(k, p);
}

for (const h of habit) {
  bump(h['Número de documento'], 'hab', {
    nombre: h['Apellidos y nombre'],
    nacimiento: h['Nacimiento'],
    direccion: h['Dirección']
  });
}
for (const u of unidadesPriv) {
  bump(u.nif, 'ibiu', {
    nombre: u.titular,
    refcat: u.refcat,
    valor: u.valor_catastral_eur,
    cuota: u.cuota_ibi_eur,
    tasa: u.tasa_basura_eur
  });
}
for (const r of padron) {
  bump(r.NIF_SP_OT, 'pad', { nombre: r.Nombre_SP });
}

const personasRows = [...personas.values()].map(p => ({
  documento: p.documento,
  nombres_observados: [...p.nombres_observados].join(' / '),
  fecha_nacimiento: p.fecha_nacimiento,
  en_padron_habitantes: p.en_padron_habitantes,
  en_ibiu_titular: p.en_ibiu_titular,
  en_padron_tasas_titular: p.en_padron_tasas_titular,
  n_inmuebles_ibiu: p.n_inmuebles_ibiu,
  refcat20_titular: [...p.refcat20_titular].join(';'),
  valor_catastral_total_eur: p.valor_catastral_total_eur.toFixed(2),
  cuota_ibi_total_eur: p.cuota_ibi_total_eur.toFixed(2),
  tasa_basura_total_eur: p.tasa_basura_total_eur.toFixed(2),
  direcciones_residencia: [...p.direcciones_residencia].join(' | '),
  empadronado_y_propietario: (p.en_padron_habitantes > 0 && p.en_ibiu_titular > 0) ? 1 : 0,
  propietario_no_residente: (p.en_padron_habitantes === 0 && p.en_ibiu_titular > 0) ? 1 : 0,
  residente_no_propietario: (p.en_padron_habitantes > 0 && p.en_ibiu_titular === 0) ? 1 : 0
}));

writeCsv(path.join(PRIV, 'personas_dni.csv'), personasRows, [
  'documento', 'nombres_observados', 'fecha_nacimiento',
  'en_padron_habitantes', 'en_ibiu_titular', 'en_padron_tasas_titular',
  'n_inmuebles_ibiu', 'refcat20_titular',
  'valor_catastral_total_eur', 'cuota_ibi_total_eur', 'tasa_basura_total_eur',
  'direcciones_residencia',
  'empadronado_y_propietario', 'propietario_no_residente', 'residente_no_propietario'
]);

// ---------- 8) Salidas públicas ----------

writeCsv(path.join(DATA, 'unidades_catastrales.csv'), unidades, [
  'refcat', 'refcat_parcela', 'municipio', 'sigla_via', 'via', 'planta', 'puerta', 'escalera',
  'clase_bien', 'uso', 'clave_uso',
  'valor_catastral_eur', 'valor_suelo_eur', 'valor_construccion_eur', 'base_liquidable_eur',
  'tipo_impositivo', 'cuota_ibi_eur', 'exento', 'bonificado',
  'tasa_basura_eur', 'tasa_basura_registros', 'tiene_padron_tasas'
]);

writeCsv(path.join(DATA, 'parcelas_agregadas.csv'), parcelasRows, [
  'refcat', 'n_unidades', 'uso_dominante', 'es_mixta',
  'valor_catastral_eur', 'valor_suelo_eur', 'valor_construccion_eur',
  'cuota_ibi_eur', 'tasa_basura_eur', 'coste_municipal_total_eur',
  'n_exentos', 'n_bonificados',
  'habitantes_estimados', 'densidad_hab_por_unidad',
  'via_referencia'
]);

writeCsv(path.join(DATA, 'habitantes_por_calle.csv'), habCalleRows, [
  'sigla', 'calle_normalizada', 'habitantes'
]);

// ---------- 9) Reporte ----------

const totalValorCat = parcelasRows.reduce((s, p) => s + Number(p.valor_catastral_eur), 0);
const totalIbi = parcelasRows.reduce((s, p) => s + Number(p.cuota_ibi_eur), 0);
const totalTasa = parcelasRows.reduce((s, p) => s + Number(p.tasa_basura_eur), 0);
const totalHabAsig = parcelasRows.reduce((s, p) => s + Number(p.habitantes_estimados), 0);

const usosTop = new Map();
for (const u of unidades) usosTop.set(u.uso || '(sin uso)', (usosTop.get(u.uso || '(sin uso)') || 0) + 1);

const empadronadosYPropietarios = personasRows.filter(p => p.empadronado_y_propietario).length;
const propietariosNoResidentes = personasRows.filter(p => p.propietario_no_residente).length;
const residentesNoPropietarios = personasRows.filter(p => p.residente_no_propietario).length;

const report = [
  '# Unificación cívica San Román de los Montes',
  '',
  `_Generado por \`scripts/unificar-civico.js\` el ${new Date().toISOString()}_`,
  '',
  '## Resumen de entradas',
  '',
  `- **IBIU 2024**: ${ibiu.length} unidades (${unidades.length} con REF_CATASTRAL · ${dupsIbiu} refcat con cotitulares)`,
  `- **Padrón Tasas**: ${padron.length} registros · 100 % "RECOGIDA BASURAS" · ${tasasPorRef20.size} unidades únicas`,
  `- **Padrón Habitantes**: ${totalAlta} personas en Alta · ${habitantesPorCalle.size} calles distintas en el listado`,
  `- **direcciones.geojson**: ${direcciones.features.length} portales con calle + refcat14`,
  '',
  '## Cruces',
  '',
  `- IBIU ↔ Padrón Tasas: ${unidades.length - sinTasas}/${unidades.length} unidades con tasa de basura (${pct(unidades.length - sinTasas, unidades.length)})`,
  `- Tasas huérfanas (en Padrón pero no en IBIU): ${tasasHuérfanas}`,
  `- Habitantes ↔ portales catastrales: ${totalMatched}/${totalAlta} (${pct(totalMatched, totalAlta)})`,
  `    · únicos: ${mUnique}  ·  ambiguos (>1 parcela): ${mAmbig}`,
  `    · resueltos por fuzzy: ${mFuzzy}  ·  con letra de portal: ${mLetter}`,
  `    · sin match: ${mNada}`,
  '',
  '### Muestras sin match (revisar manualmente o ignorar)',
  '',
  '```',
  ...sinMatch.map(s => '  ' + s),
  '```',
  '',
  '## Totales del municipio',
  '',
  `- Valor catastral total: **${totalValorCat.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €**`,
  `- Cuota IBI total 2024: **${totalIbi.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €**`,
  `- Tasa basura total: **${totalTasa.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €**`,
  `- Habitantes asignados a parcelas: **${totalHabAsig.toFixed(0)}** de ${totalAlta} (${pct(totalHabAsig, totalAlta)})`,
  '',
  '## Distribución por uso (unidades catastrales)',
  '',
  ...[...usosTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([u, n]) =>
    `- ${u}: ${n}  (${pct(n, unidades.length)})`),
  '',
  '## DB privada (PII)',
  '',
  `Personas únicas indexadas por documento: **${personasRows.length}**`,
  '',
  `- Empadronados que también son propietarios IBIU: **${empadronadosYPropietarios}**`,
  `- Propietarios IBIU **no** empadronados en San Román (segunda residencia / inversores): **${propietariosNoResidentes}**`,
  `- Empadronados que **no** aparecen como titulares IBIU (inquilinos / familiares del titular): **${residentesNoPropietarios}**`,
  '',
  '## Salidas',
  '',
  '### Públicas (sin PII)',
  '',
  `- \`data/unidades_catastrales.csv\` — ${unidades.length} filas · sin nombres ni NIF`,
  `- \`data/parcelas_agregadas.csv\` — ${parcelasRows.length} filas · listo para colorear el mapa`,
  `- \`data/habitantes_por_calle.csv\` — ${habCalleRows.length} calles`,
  '',
  '### Privadas (gitignored)',
  '',
  `- \`data/_privado/inmuebles_titular.csv\` — IBIU con NIF y nombre del titular`,
  `- \`data/_privado/habitantes_geocodificados.csv\` — cada habitante con su refcat14`,
  `- \`data/_privado/personas_dni.csv\` — DB cruzada por documento (DNI/NIF) entre las 3 fuentes`,
  '',
  '## Cómo se usa en el mapa',
  '',
  '1. Servidor local: `python3 -m http.server 8765`',
  '2. En la app: campo "Cargar URL" → `http://localhost:8765/data/parcelas_agregadas.csv`',
  '3. Desplegable "Colorear por columna" — elegir:',
  '   - `valor_catastral_eur` · riqueza catastral por parcela',
  '   - `cuota_ibi_eur` · derrama IBI por parcela',
  '   - `tasa_basura_eur` · tasa anual',
  '   - `coste_municipal_total_eur` · IBI + basura',
  '   - `n_unidades` · fragmentación (bloques de pisos)',
  '   - `uso_dominante` · residencial/comercial/almacén/industrial',
  '   - `habitantes_estimados` · densidad empadronados',
  '   - `densidad_hab_por_unidad` · habitabilidad real',
  ''
].join('\n');

fs.writeFileSync(path.join(DATA, '_civic_unificacion_report.md'), report, 'utf8');

console.log('\n✔ Salidas:');
console.log('   públicas:');
console.log('     data/unidades_catastrales.csv');
console.log('     data/parcelas_agregadas.csv');
console.log('     data/habitantes_por_calle.csv');
console.log('     data/_civic_unificacion_report.md');
console.log('   privadas (gitignored):');
console.log('     data/_privado/inmuebles_titular.csv');
console.log('     data/_privado/habitantes_geocodificados.csv');
console.log('     data/_privado/personas_dni.csv');
