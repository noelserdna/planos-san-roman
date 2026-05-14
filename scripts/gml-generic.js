#!/usr/bin/env node
// Convertidor genérico GML (Catastro INSPIRE) → GeoJSON en EPSG:4326.
// Uso: node scripts/gml-generic.js <featureLocalName> <input.gml> <output.geojson>
//
// featureLocalName: nombre local (sin prefijo) del elemento feature.
//   cp:CadastralParcel  → CadastralParcel
//   cp:CadastralZoning  → CadastralZoning
//   bu:Building         → Building
//   ad:Address          → Address

const fs = require('fs');
const path = require('path');
const sax = require('sax');
const proj4 = require('proj4');

proj4.defs(
  'EPSG:25830',
  '+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
);

const FEATURE_LOCAL = process.argv[2];
const INPUT = process.argv[3];
const OUTPUT = process.argv[4];
if (!FEATURE_LOCAL || !INPUT || !OUTPUT) {
  console.error('Uso: node gml-generic.js <FeatureLocalName> <input.gml> <output.geojson>');
  process.exit(1);
}

function parsePosList(text) {
  const nums = text.trim().split(/\s+/).map(Number);
  const ring = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const [lng, lat] = proj4('EPSG:25830', 'EPSG:4326', [nums[i], nums[i + 1]]);
    ring.push([+lng.toFixed(7), +lat.toFixed(7)]);
  }
  return ring;
}

function parsePos(text) {
  const [x, y] = text.trim().split(/\s+/).map(Number);
  const [lng, lat] = proj4('EPSG:25830', 'EPSG:4326', [x, y]);
  return [+lng.toFixed(7), +lat.toFixed(7)];
}

const parser = sax.createStream(true, { trim: true, normalize: true });

let inFeature = false;
let depth = 0;
let currentProps = null;
let polygons = [];
let currentPolygon = null;
let inExterior = false;
let inInterior = false;
let inGeometry = false;
let pointCoord = null;
let textBuf = '';
let captureText = false;
let lastLeafName = null;

const features = [];

function localName(qName) {
  const i = qName.indexOf(':');
  return i >= 0 ? qName.slice(i + 1) : qName;
}

parser.on('opentag', (node) => {
  const ln = localName(node.name);

  if (!inFeature && ln === FEATURE_LOCAL) {
    inFeature = true;
    currentProps = {};
    polygons = [];
    pointCoord = null;
    depth = 0;
    textBuf = '';
    return;
  }
  if (!inFeature) return;

  depth++;

  if (ln === 'geometry' || ln === 'pos' && node.attributes && !inGeometry) {
    // some features have a top-level pos inside geometry
  }
  if (ln === 'geometry') { inGeometry = true; }
  if (inGeometry) {
    if (ln === 'PolygonPatch' || ln === 'Polygon') currentPolygon = { exterior: null, interiors: [] };
    else if (ln === 'exterior') inExterior = true;
    else if (ln === 'interior') inInterior = true;
    else if (ln === 'posList') { captureText = true; textBuf = ''; lastLeafName = 'posList'; }
    else if (ln === 'pos') { captureText = true; textBuf = ''; lastLeafName = 'pos'; }
    return;
  }
  // outside geometry: treat as potential property text
  captureText = true;
  textBuf = '';
  lastLeafName = ln;
});

parser.on('text', (t) => { if (captureText) textBuf += t; });
parser.on('cdata', (t) => { if (captureText) textBuf += t; });

parser.on('closetag', (qName) => {
  if (!inFeature) return;
  const ln = localName(qName);

  // Feature closes
  if (ln === FEATURE_LOCAL) {
    let geometry = null;
    if (polygons.length === 1) geometry = { type: 'Polygon', coordinates: polygons[0] };
    else if (polygons.length > 1) geometry = { type: 'MultiPolygon', coordinates: polygons };
    else if (pointCoord) geometry = { type: 'Point', coordinates: pointCoord };

    if (geometry) features.push({ type: 'Feature', properties: currentProps, geometry });

    inFeature = false;
    currentProps = null;
    polygons = [];
    pointCoord = null;
    inGeometry = false;
    return;
  }

  if (inGeometry) {
    if (ln === 'posList' && captureText) {
      const ring = parsePosList(textBuf);
      if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
        ring.push(ring[0]);
      }
      if (inExterior && currentPolygon) currentPolygon.exterior = ring;
      else if (inInterior && currentPolygon) currentPolygon.interiors.push(ring);
      captureText = false; textBuf = '';
      return;
    }
    if (ln === 'pos' && captureText) {
      // Point geometry (Addresses)
      pointCoord = parsePos(textBuf);
      captureText = false; textBuf = '';
      return;
    }
    if (ln === 'exterior') inExterior = false;
    if (ln === 'interior') inInterior = false;
    if (ln === 'PolygonPatch' || ln === 'Polygon') {
      if (currentPolygon && currentPolygon.exterior) {
        polygons.push([currentPolygon.exterior, ...currentPolygon.interiors]);
      }
      currentPolygon = null;
    }
    if (ln === 'geometry') inGeometry = false;
    return;
  }

  // Property leaf
  if (captureText && lastLeafName === ln) {
    const txt = textBuf.trim();
    if (txt && !currentProps[ln]) currentProps[ln] = txt;
    captureText = false; textBuf = '';
  }
  depth--;
});

parser.on('end', () => {
  const fc = { type: 'FeatureCollection', features };
  fs.writeFileSync(OUTPUT, JSON.stringify(fc));
  const sizeMB = (fs.statSync(OUTPUT).size / (1024 * 1024)).toFixed(2);
  console.log(`OK  ${FEATURE_LOCAL}  →  ${features.length} features  ·  ${OUTPUT}  ·  ${sizeMB} MB`);
});

parser.on('error', (err) => { console.error('Error:', err.message); process.exit(1); });

console.log(`Procesando ${INPUT} (feature: ${FEATURE_LOCAL}) …`);
fs.createReadStream(INPUT).pipe(parser);
