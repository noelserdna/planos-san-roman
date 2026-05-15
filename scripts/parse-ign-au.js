#!/usr/bin/env node
// Parse the IGN AdministrativeUnit GML response into a GeoJSON FeatureCollection.
// Source CRS is EPSG:4258 (ETRS89 geographic, lat,lng order), output is GeoJSON
// (lng,lat order, WGS84 — equivalent for visualization, both within cm of each other).

const fs = require('fs');
const path = require('path');

const INPUT = process.argv[2] || '/tmp/san_roman_au.xml';
const OUTPUT = process.argv[3] || path.join(__dirname, '..', 'data', 'limite.geojson');

const xml = fs.readFileSync(INPUT, 'utf8');

function ringCoords(posListText) {
  const nums = posListText.trim().split(/\s+/).map(Number);
  const ring = [];
  // EPSG:4258 in WFS 2.0 uses lat,lng order. Swap to lng,lat for GeoJSON.
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const lat = nums[i], lng = nums[i + 1];
    ring.push([+lng.toFixed(7), +lat.toFixed(7)]);
  }
  if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
    ring.push(ring[0]);
  }
  return ring;
}

// Extract metadata
const name = (xml.match(/<gn:text>([^<]+)<\/gn:text>/) || [])[1] || 'unknown';
const nationalCode = (xml.match(/<au:nationalCode>([^<]+)<\/au:nationalCode>/) || [])[1];
const namespace = (xml.match(/<base:namespace>([^<]+)<\/base:namespace>/) || [])[1];

// Find all gml:Polygon blocks within au:geometry
const geomMatch = xml.match(/<au:geometry>([\s\S]*?)<\/au:geometry>/);
if (!geomMatch) throw new Error('No au:geometry found in input');
const geomXml = geomMatch[1];

// Extract every Polygon (exterior + optional interiors)
const polygons = [];
const polygonRe = /<gml:Polygon[^>]*>([\s\S]*?)<\/gml:Polygon>/g;
let pm;
while ((pm = polygonRe.exec(geomXml)) !== null) {
  const block = pm[1];
  const ext = block.match(/<gml:exterior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>[\s\S]*?<\/gml:exterior>/);
  if (!ext) continue;
  const exterior = ringCoords(ext[1]);
  const interiors = [];
  const intRe = /<gml:interior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>[\s\S]*?<\/gml:interior>/g;
  let im;
  while ((im = intRe.exec(block)) !== null) {
    interiors.push(ringCoords(im[1]));
  }
  polygons.push([exterior, ...interiors]);
}

if (!polygons.length) throw new Error('No polygons extracted');

const geometry = polygons.length === 1
  ? { type: 'Polygon', coordinates: polygons[0] }
  : { type: 'MultiPolygon', coordinates: polygons };

const fc = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: {
      name,
      nationalCode,
      namespace,
      source: 'IGN — Líneas Límite Jurisdiccionales (WFS INSPIRE Unidades Administrativas)',
      sourceUrl: 'https://www.ign.es/wfs-inspire/unidades-administrativas',
      authoritative: true,
      retrievedAt: new Date().toISOString().slice(0, 10),
    },
    geometry,
  }],
};

fs.writeFileSync(OUTPUT, JSON.stringify(fc));
const nPoints = polygons.reduce((a, p) => a + p[0].length, 0);
console.log(`OK  ${name} (${nationalCode})  →  ${OUTPUT}  ·  ${polygons.length} polígono(s), ${nPoints} puntos exterior`);
