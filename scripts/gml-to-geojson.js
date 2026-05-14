#!/usr/bin/env node
// Convierte el GML INSPIRE de Catastro (EPSG:25830) a GeoJSON (EPSG:4326).
// Streaming con sax para soportar archivos grandes sin reventar memoria.

const fs = require('fs');
const path = require('path');
const sax = require('sax');
const proj4 = require('proj4');

proj4.defs(
  'EPSG:25830',
  '+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
);

const INPUT = process.argv[2] || path.join(__dirname, '..', 'data', 'A.ES.SDGC.CP.45155.cadastralparcel.gml');
const OUTPUT = process.argv[3] || path.join(__dirname, '..', 'data', 'parcelas.geojson');

function parsePosList(text) {
  // Devuelve [[lng,lat], ...] desde "x1 y1 x2 y2 ..." en EPSG:25830
  const nums = text.trim().split(/\s+/).map(Number);
  const ring = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const [lng, lat] = proj4('EPSG:25830', 'EPSG:4326', [nums[i], nums[i + 1]]);
    ring.push([+lng.toFixed(7), +lat.toFixed(7)]);
  }
  return ring;
}

const parser = sax.createStream(true, { trim: true, normalize: true });

let current = null;          // parcela en construcción
let inGeometry = false;
let inExterior = false;
let inInterior = false;
let polygons = [];           // [[ext, ...holes], ...] por parcela
let currentPolygon = null;   // ring de exterior + interiors actual
let textBuf = '';
let collect = null;          // qué hacer con el texto cuando cierre un tag

const byRefcat = new Map();

parser.on('opentag', (node) => {
  const name = node.name;

  if (name === 'cp:CadastralParcel') {
    current = {
      refcat: null,
      areaValue: null,
      label: null,
      beginLifespanVersion: null,
    };
    polygons = [];
    currentPolygon = null;
  }
  if (!current) return;

  if (name === 'cp:areaValue') collect = 'areaValue';
  else if (name === 'cp:label') collect = 'label';
  else if (name === 'cp:beginLifespanVersion') collect = 'beginLifespanVersion';
  else if (name === 'cp:nationalCadastralReference') collect = 'refcat';
  else if (name === 'cp:geometry') inGeometry = true;
  else if (name === 'gml:PolygonPatch' && inGeometry) currentPolygon = { exterior: null, interiors: [] };
  else if (name === 'gml:exterior' && inGeometry) inExterior = true;
  else if (name === 'gml:interior' && inGeometry) inInterior = true;
  else if (name === 'gml:posList' && inGeometry) collect = 'posList';
  textBuf = '';
});

parser.on('text', (t) => { textBuf += t; });
parser.on('cdata', (t) => { textBuf += t; });

parser.on('closetag', (name) => {
  if (!current) return;

  if (collect && (
    name === 'cp:areaValue' || name === 'cp:label' ||
    name === 'cp:beginLifespanVersion' || name === 'cp:nationalCadastralReference'
  )) {
    current[collect] = textBuf.trim();
    collect = null;
    textBuf = '';
    return;
  }
  if (collect === 'posList' && name === 'gml:posList') {
    const ring = parsePosList(textBuf);
    // Cerrar el anillo si el origen no lo cierra
    if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
      ring.push(ring[0]);
    }
    if (inExterior) currentPolygon.exterior = ring;
    else if (inInterior) currentPolygon.interiors.push(ring);
    collect = null;
    textBuf = '';
    return;
  }
  if (name === 'gml:exterior') inExterior = false;
  if (name === 'gml:interior') inInterior = false;
  if (name === 'gml:PolygonPatch') {
    if (currentPolygon && currentPolygon.exterior) {
      polygons.push([currentPolygon.exterior, ...currentPolygon.interiors]);
    }
    currentPolygon = null;
  }
  if (name === 'cp:geometry') inGeometry = false;

  if (name === 'cp:CadastralParcel') {
    if (polygons.length && current.refcat) {
      const area = current.areaValue ? Number(current.areaValue) : 0;
      const existing = byRefcat.get(current.refcat);
      if (existing) {
        existing.polygons.push(...polygons);
        existing.areaValue += area;
      } else {
        byRefcat.set(current.refcat, {
          refcat: current.refcat,
          label: current.label,
          areaValue: area,
          beginLifespanVersion: current.beginLifespanVersion || null,
          polygons: [...polygons],
        });
      }
    }
    current = null;
    polygons = [];
  }
});

parser.on('end', () => {
  let merged = 0;
  const features = [];
  for (const p of byRefcat.values()) {
    if (p.polygons.length > 1 && p._sourceCount > 1) merged++;
    const geometry = p.polygons.length === 1
      ? { type: 'Polygon', coordinates: p.polygons[0] }
      : { type: 'MultiPolygon', coordinates: p.polygons };
    features.push({
      type: 'Feature',
      id: p.refcat,
      properties: {
        refcat: p.refcat,
        label: p.label,
        areaValue: p.areaValue || null,
        beginLifespanVersion: p.beginLifespanVersion,
      },
      geometry,
    });
  }
  const fc = { type: 'FeatureCollection', features };
  fs.writeFileSync(OUTPUT, JSON.stringify(fc));
  const sizeMB = (fs.statSync(OUTPUT).size / (1024 * 1024)).toFixed(2);
  console.log(`OK  →  ${features.length} parcelas (refcats únicos)  ·  ${OUTPUT}  ·  ${sizeMB} MB`);
});

parser.on('error', (err) => {
  console.error('Parser error:', err.message);
  process.exit(1);
});

console.log(`Procesando ${INPUT} …`);
fs.createReadStream(INPUT).pipe(parser);
