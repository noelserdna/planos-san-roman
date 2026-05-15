#!/usr/bin/env node
/*
 * Construye data/direcciones.geojson enriquecido con:
 *   - street        nombre real de la calle (ThoroughfareName)
 *   - sigla         sigla (CL/AV/PZ/...) extraída del prefijo del nombre catastral
 *   - street_name   nombre sin sigla, normalizado
 *   - designator    número de portal
 *   - refcat14      referencia catastral de la parcela a la que pertenece el portal
 *
 * Reemplaza la versión actual que sólo expone metadatos INSPIRE crudos.
 *
 * Entrada:  data/A.ES.SDGC.AD.45155.gml
 * Salida:   data/direcciones.geojson
 */

const fs = require('fs');
const path = require('path');
const sax = require('sax');
const proj4 = require('proj4');

proj4.defs(
  'EPSG:25830',
  '+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
);

const INPUT  = path.join(__dirname, '..', 'data', 'A.ES.SDGC.AD.45155.gml');
const OUTPUT = path.join(__dirname, '..', 'data', 'direcciones.geojson');

function parsePos(text) {
  const [x, y] = text.trim().split(/\s+/).map(Number);
  const [lng, lat] = proj4('EPSG:25830', 'EPSG:4326', [x, y]);
  return [+lng.toFixed(7), +lat.toFixed(7)];
}

const localName = q => { const i = q.indexOf(':'); return i >= 0 ? q.slice(i + 1) : q; };

// Primera pasada: indexar ThoroughfareName id -> texto crudo
console.log('▶ Pasada 1: ThoroughfareName…');

const tnIndex = new Map(); // id -> raw text (ej " CL ABAJO")
{
  const parser = sax.parser(true, { trim: true, normalize: true });
  let inTN = null;     // id activo
  let inText = false;  // dentro de <GN:text>
  let buf = '';
  parser.onopentag = (node) => {
    const ln = localName(node.name);
    if (ln === 'ThoroughfareName') {
      inTN = (node.attributes['gml:id'] && node.attributes['gml:id'].value) || node.attributes['gml:id'] || null;
      // sax 1.x: en strict mode, attributes son strings simples
      if (typeof inTN !== 'string') inTN = node.attributes['gml:id'];
    } else if (ln === 'text' && inTN) {
      inText = true;
      buf = '';
    }
  };
  parser.ontext = t => { if (inText) buf += t; };
  parser.oncdata = t => { if (inText) buf += t; };
  parser.onclosetag = (q) => {
    const ln = localName(q);
    if (ln === 'text' && inText) {
      if (inTN && !tnIndex.has(inTN)) tnIndex.set(inTN, buf.trim());
      inText = false;
      buf = '';
    } else if (ln === 'ThoroughfareName') {
      inTN = null;
    }
  };
  parser.write(fs.readFileSync(INPUT, 'utf8')).close();
}
console.log(`  → ${tnIndex.size} ThoroughfareName indexadas`);

// Segunda pasada: Addresses
console.log('▶ Pasada 2: Address…');

const features = [];
{
  const parser = sax.parser(true, { trim: true, normalize: true });
  let inAddress = false;
  let current = null;
  let captureText = false;
  let buf = '';
  let lastLeaf = null;
  let designatorPath = []; // para distinguir AD:designator anidado
  let inDesignatorLeaf = false;

  parser.onopentag = (node) => {
    const ln = localName(node.name);
    if (ln === 'Address') {
      inAddress = true;
      const gmlId = node.attributes['gml:id'];
      current = {
        gmlId,
        localId: null,
        designator: null,
        type: null,
        specification: null,
        method: null,
        default: null,
        level: null,
        coord: null,
        tnRef: null,
        pdRef: null
      };
      return;
    }
    if (!inAddress) return;

    if (ln === 'component') {
      const href = node.attributes['xlink:href'];
      if (href && typeof href === 'string') {
        const id = href.startsWith('#') ? href.slice(1) : href;
        if (id.includes('.TN.')) current.tnRef = id;
        else if (id.includes('.PD.')) current.pdRef = id;
      }
      return;
    }
    if (ln === 'pos') {
      captureText = true; buf = ''; lastLeaf = 'pos'; return;
    }
    if (ln === 'localId') { captureText = true; buf = ''; lastLeaf = 'localId'; return; }
    if (ln === 'designator') {
      // hay dos: <AD:designator><AD:LocatorDesignator><AD:designator>1
      designatorPath.push(ln);
      // sólo capturamos el hoja (el segundo, dentro de LocatorDesignator)
      if (designatorPath.length === 2) { captureText = true; buf = ''; lastLeaf = 'designator'; inDesignatorLeaf = true; }
      return;
    }
    if (['type','specification','method','default','level'].includes(ln)) {
      captureText = true; buf = ''; lastLeaf = ln; return;
    }
  };

  parser.ontext = t => { if (captureText) buf += t; };
  parser.oncdata = t => { if (captureText) buf += t; };

  parser.onclosetag = (q) => {
    const ln = localName(q);
    if (!inAddress) return;

    if (captureText && ln === lastLeaf) {
      const txt = buf.trim();
      if (ln === 'pos') current.coord = parsePos(txt);
      else if (ln === 'localId') current.localId = txt;
      else if (ln === 'designator' && inDesignatorLeaf) current.designator = txt;
      else if (current[ln] === null || current[ln] === undefined) current[ln] = txt;
      captureText = false; buf = '';
      if (ln === 'designator') inDesignatorLeaf = false;
    }
    if (ln === 'designator') {
      designatorPath.pop();
    }

    if (ln === 'Address') {
      // emit feature
      if (current && current.coord) {
        // refcat14 = últimos 14 chars del localId
        const refcat14 = current.localId ? current.localId.slice(-14) : null;
        const rawStreet = current.tnRef ? (tnIndex.get(current.tnRef) || '') : '';
        // rawStreet típico: " CL ABAJO" o "AV PLAYA" → primer token = sigla
        const cleaned = rawStreet.trim();
        const parts = cleaned.split(/\s+/);
        let sigla = '';
        let streetName = cleaned;
        if (parts.length > 1 && /^[A-Z]{2,3}$/.test(parts[0])) {
          sigla = parts[0];
          streetName = parts.slice(1).join(' ');
        }
        features.push({
          type: 'Feature',
          properties: {
            localId: current.localId,
            refcat14,
            street: cleaned || null,
            sigla: sigla || null,
            street_name: streetName || null,
            designator: current.designator || null,
            type: current.type || null,
            specification: current.specification || null,
            method: current.method || null,
            default: current.default || null,
            level: current.level || null
          },
          geometry: { type: 'Point', coordinates: current.coord }
        });
      }
      inAddress = false;
      current = null;
    }
  };

  parser.write(fs.readFileSync(INPUT, 'utf8')).close();
}

console.log(`  → ${features.length} portales`);

// Estadísticas
const conCalle = features.filter(f => f.properties.street).length;
const conRefcat = features.filter(f => f.properties.refcat14).length;
const conDesignator = features.filter(f => f.properties.designator).length;
console.log(`  → con street: ${conCalle}/${features.length}`);
console.log(`  → con refcat14: ${conRefcat}/${features.length}`);
console.log(`  → con designator: ${conDesignator}/${features.length}`);

fs.writeFileSync(OUTPUT, JSON.stringify({ type: 'FeatureCollection', features }));
const sizeMB = (fs.statSync(OUTPUT).size / (1024 * 1024)).toFixed(2);
console.log(`✔ Escrito ${OUTPUT}  (${sizeMB} MB)`);
