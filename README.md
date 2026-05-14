# planos — San Román de los Montes

Mapa interactivo del término municipal de San Román de los Montes (Toledo) con datos del Catastro, IGN, MITECO, FEGA e IGME, más cruce con CSV externo (Google Sheets, archivo local) para destacar parcelas según cualquier criterio.

## Qué hay

- 35 capas WMS/GeoJSON en 9 grupos colapsables.
- Parcelas catastrales con cruce por refcat contra CSV → coloreado dinámico por la columna que elijas.
- Edificios (huellas + plantas), portales, piscinas, zonificación, vías pecuarias, hidrografía, riesgo de inundación, espacios naturales protegidos, Natura 2000, SIGPAC, geología, uso del suelo, etc.
- Click en el mapa con capas WMS activas → GetFeatureInfo unificado que combina todas las fuentes.

## Estructura

```
planos/
├── index.html              Aplicación (Leaflet + PapaParse + WMS)
├── scripts/
│   ├── gml-to-geojson.js   Convertidor específico para parcelas (con dedup por refcat)
│   └── gml-generic.js      Convertidor genérico para cualquier feature INSPIRE
├── data/
│   ├── parcelas.geojson    3754 parcelas (Catastro INSPIRE)
│   ├── edificios.geojson   2253 edificios
│   ├── partes-edificio.geojson  7349 partes (con nº plantas)
│   ├── otras-construcciones.geojson  928 piscinas
│   ├── direcciones.geojson  2943 portales
│   ├── zonificacion.geojson  202 polígonos/manzanas
│   ├── limite.geojson      Límite municipal (Nominatim/OSM)
│   ├── san_roman.zip       Descarga original del Catastro (parcelas)
│   ├── buildings.zip       Descarga original del Catastro (edificios)
│   └── addresses.zip       Descarga original del Catastro (direcciones)
├── package.json
└── PENDIENTES.md           Inventario de fuentes no integradas / posibles mejoras
```

## Uso rápido

```bash
npm install
unzip -q data/san_roman.zip -d data/
unzip -q data/buildings.zip -d data/
unzip -q data/addresses.zip -d data/
node scripts/gml-to-geojson.js
# (Para edificios/partes/piscinas/direcciones/zoning hay scripts/gml-generic.js)
python3 -m http.server 8765
# Abre http://localhost:8765
```

Para regenerar todo desde cero (si actualizas el Catastro):

```bash
# Re-descargar el ZIP de un municipio cualquiera:
# https://www.catastro.hacienda.gob.es/INSPIRE/CadastralParcels/<provincia>/<código>-<NOMBRE>/A.ES.SDGC.CP.<código>.zip
```

## Cargar tu CSV de datos

Tres opciones en la app:
1. **Subida local**: botón "Seleccionar archivo".
2. **URL pública** (Google Sheets, GitHub raw, S3...): pegar URL en el campo y "Cargar URL". Para Sheets: `https://docs.google.com/spreadsheets/d/<ID>/export?format=csv` con la hoja compartida como "cualquiera con el enlace puede ver".
3. **CSV en el repo**: cualquier `data/*.csv` se sirve estáticamente, basta con la URL del servidor local.

El CSV debe tener una columna con la **referencia catastral** (14 caracteres). El sistema la detecta automáticamente si el nombre contiene `refcat`, `referencia` o `ref_catastral`. Cualquier otra columna pasa a aparecer en el dropdown "Colorear por columna".

## Fuentes de datos

| Capa | Fuente |
|---|---|
| Parcelas, edificios, direcciones, zonificación, partes, piscinas | Catastro INSPIRE (Sede Electrónica del Catastro) |
| Límite municipal | OpenStreetMap vía Nominatim |
| Ortofoto PNOA | IGN España |
| Hidrografía | IDEE / IGN |
| Zonas inundables (T=10/100/500) | MITECO SNCZI |
| Espacios protegidos, Natura 2000, Incendios, Mapa Forestal | MITECO Biodiversidad |
| Comarcas agrarias y ganaderas, climatología | MAPA |
| Vías pecuarias | MITECO |
| SIGPAC (uso agrícola, cultivos declarados) | FEGA via sigpac-hubcloud.es |
| Uso del suelo (LandCover/LandUse) | IDEE / IGN INSPIRE |
| Geología | IGME (Mapa Geológico 1M) |

Todos los datos son de fuente pública y libre uso conforme a sus licencias respectivas (CC-BY, IGN reuse, etc.).

## Pendientes

Ver [PENDIENTES.md](PENDIENTES.md) para el inventario de capas y features no integradas (JCCM regional caído, MUP estricto, PNOA histórico, edición de CSV en vivo, búsqueda por refcat, etc.).
