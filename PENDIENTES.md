# Pendientes / no integrado

Registro de fuentes y capas que se probaron o se mencionaron pero **no se integraron** en `index.html`, con motivo y posible camino de resolución.

Última actualización: 2026-05-15.

**Cambio 2026-05-15**: `data/limite.geojson` ahora viene del **WFS oficial IGN** (Líneas Límite Jurisdiccionales), no de OSM/Nominatim como antes. Se ha añadido también `data/limite-catastro.geojson` como capa adicional (contorno derivado del Catastro). La versión OSM se preserva en `data/limite-osm.geojson` para referencia histórica.

---

## 1. Endpoints caídos o no accesibles desde esta red

Todos respondían con timeout (HTTP 000) o errores que no se pudieron sortear. Pueden estar simplemente filtrados desde la conexión actual; conviene reintentar.

### 1.1 JCCM — Castilla-La Mancha (regionales)

Probados y caídos en la fecha del registro:

- `https://crtm.castillalamancha.es/crtm_be/services/sigpac/ImageServer/WMSServer`
- `https://crtm.castillalamancha.es/crtm_be/services/sigpac/MapServer/WMSServer`
- `https://crtm.castillalamancha.es/services/Hidrografia/MapServer/WMSServer`
- `https://crtm.castillalamancha.es/geoserver/wms`
- `https://idejccm.castillalamancha.es/geoserver/wms`
- `https://idejccm.castillalamancha.es/geoserver/ows`
- `https://idejccm.castillalamancha.es/sigpac`
- `https://ide.castillalamancha.es/geoserver/wms`
- `https://geoportal.castillalamancha.es/geoserver/wms`
- `https://idecm.castillalamancha.es/wms/sigpac/wms`
- `https://ideclm.castillalamancha.es/geoserver/sigpac/wms`

**Qué nos perdimos al no conectar**:
- **Montes de Utilidad Pública (MUP)** — el catálogo legal regional. Es lo más cercano a "montes protegidos" en sentido estricto.
- **Cartografía forestal regional** detallada (más fino que el MFE nacional).
- **SIGPAC** versión JCCM (puede tener atributos que la nacional no expone).
- **Sismología regional**, infraestructuras regionales, etc.

**Camino**: reintentar otro día desde otra red. Si el filtrado persiste, posiblemente cambiaron el dominio. Buscar a través del portal de datos abiertos:
- https://datosabiertos.castillalamancha.es

### 1.2 CHT — Confederación Hidrográfica del Tajo

- `https://servicios.chtajo.es/geoserver/wms`
- `https://servicios.chtajo.es/wms`
- `https://idesig.chtajo.es/geoserver/wms`
- `https://geoportal.chtajo.es/geoserver/wms`

**Qué nos perdimos**:
- **Zonas de Policía** (100 m alrededor del cauce, con limitaciones legales) y **Zonas de Servidumbre** (5 m) — específicas de la confederación, más detalladas que las inundables del SNCZI.
- **Concesiones de agua** y captaciones.
- **Inventario de presas y embalses** del Tajo.
- **Calidad del agua** por punto de muestreo.

**Camino**: viewer oficial https://mirame.chtajo.es/ permite descargar shapefiles manualmente; podríamos convertir a GeoJSON con el mismo pipeline que Catastro.

---

## 2. WMS oficiales que **están rotos** en su proxy `.aspx`

El servidor `wms.mapama.gob.es/sig/<tema>/<servicio>/wms.aspx` devuelve `ServiceException` con un `NullReferenceException` interno de .NET (visible en el código fuente: `c:\apps\Jenkins\workspace\003-mapama-wms-10.8-2.0\wms\wms.aspx.cs:línea 606`). No es nuestro problema.

**Endpoints rotos confirmados**:
- `https://wms.mapama.gob.es/sig/Agua/ZI_LMI/wms.aspx`
- `https://wms.mapama.gob.es/sig/Agua/ZI/wms.aspx`
- `https://wms.mapama.gob.es/sig/Agua/RiesgoInundacion/wms.aspx`
- `https://wms.mapama.gob.es/sig/Biodiversidad/MUP/wms.aspx`
- `https://wms.mapama.gob.es/sig/Biodiversidad/MontesUtilidadPublica/wms.aspx`
- `https://wms.mapama.gob.es/sig/Biodiversidad/RPN/wms.aspx`
- `https://wms.mapama.gob.es/sig/Biodiversidad/ENP/wms.aspx`
- `https://wms.mapama.gob.es/sig/CambioClimatico/Visor/wms.aspx`

**Excepción**: `https://wms.mapama.gob.es/sig/Biodiversidad/ViasPecuarias/wms.aspx` **sí funciona** (ya integrado). Probablemente está apuntando a un backend diferente.

**Workaround aplicado**: usar el ArcGIS REST directamente:
- `https://sig.mapama.gob.es/arcgis/services/25830/<servicio>/MapServer/WMSServer`

Así rescatamos zonas inundables, biodiversidad, agricultura, etc.

---

## 3. Capas existentes en MAPAMA que **no incluí** pero están disponibles

Catálogo completo de servicios MAPAMA en `https://sig.mapama.gob.es/arcgis/rest/services/25830?f=json`. De los exitosos en mi probe (con número de subcapas):

| Servicio | Capas | Posible utilidad |
|---|---|---|
| `WMS_CalidadAmbiental` | ~61 | Emisiones, calidad del aire, ruido |
| `WMS_Biodiv_Habitat` | ~102 | Distribución de hábitats por especie |
| `WMS_Biodiv_HabitatConsultas` | ? | Consultas detalladas a hábitats |
| `WMS_Biodiv_MFE` | ? | Mapa Forestal extendido |
| `WMS_BiodiversidadRaster` | 4 | Rasters de biodiversidad |
| `WMS_AguaRed_Seg` | ? | Red de seguimiento del agua |
| `WMS_Agua_GISPE` | ? | Gestión integrada |
| `WMS_Agua2` | ? | Aguas (variante) |
| `WMS_CA_Emisiones` | ? | Emisiones a la atmósfera |
| `WMS_Costa` | ? | (irrelevante para municipio interior) |
| `WMS_DesRural` | 3 | Desarrollo rural |
| `WMS_Alimentacion` | 19 | Industria alimentaria |
| `comunComarcasGanaderas` | 2 | Comarca ganadera (ya añadida) |

No las añadí porque saturan el menú y la mayoría son temáticas muy específicas. Añadir las que necesites con una sola línea:

```js
registerWms({
  group: 'Calidad ambiental',
  label: '…',
  url: 'https://sig.mapama.gob.es/arcgis/services/25830/WMS_CalidadAmbiental/MapServer/WMSServer',
  layers: 'NombreDeLaCapa',
  title: '…',
});
```

Las layer-names exactas se obtienen con:
```
curl 'https://sig.mapama.gob.es/arcgis/services/25830/<SERVICIO>/MapServer/WMSServer?SERVICE=WMS&REQUEST=GetCapabilities' | grep -oE '<Name>[^<]+</Name>'
```

---

## 4. IGN INSPIRE — slugs que **no funcionan**

Probados con el patrón `https://www.ign.es/wms-inspire/<slug>`:

| Slug | Estado | Comentario |
|---|---|---|
| `ocupacion-del-suelo` | 404 | Existe pero en otro slug: `servicios.idee.es/wms-inspire/ocupacion-suelo` (sí integrado) |
| `cubierta-terrestre` | 404 | Idem |
| `geologico` | 404 | Geología vive en IGME, no IGN (ya integrado) |
| `elevaciones-altitudes` | 404 | El MDT existe pero no por este nombre |
| `transportes` / `transporte` | 404 | El servicio existe en servicios.idee.es pero da capas vacías |
| `pnoa-historico` | 404 | Existe; el endpoint real probablemente sea `mosaicos-historicos` o un nombre interno del CNIG |
| `toponimia` | 404 | Existe; nombre real desconocido |
| `mtn50` | 404 | Existe en otro path |
| `corine-land-cover` / `clc` / `clc2018` | 404 | Existe como capa dentro de `ocupacion-suelo` |
| `carreteras` / `ferrocarriles` / `edificaciones` / `nombres-geograficos` | 404 | INSPIRE los tiene como sub-capas de `transportes` |
| `catastro-inspire` | 404 | Lo descargamos como datos, no como WMS |
| `sismologia` | 404 | IGN sí publica WMS de sismicidad — ruta exacta desconocida |

**Camino**: discovery vía catálogo CSW IDEE:
```
https://www.idee.es/csw-inspire-idee/srv/spa/csw?SERVICE=CSW&REQUEST=GetRecords&VERSION=2.0.2&TypeNames=csw:Record&ElementSetName=full
```

---

## 5. Capas con datos descargados pero no integrados

~~En `data/` se descargó del Catastro INSPIRE pero NO se carga en el mapa~~ — **integrados el 2026-05-14**:

- ✅ `partes-edificio.geojson` (7349 features, 3.9 MB) — convertido desde `buildingpart.gml`. Capa "Partes de edificio / plantas" en grupo Catastro, coloreado por `numberOfFloorsAboveGround` (gris=0 anexos, amarillo=1, naranja=2, rojo=3, púrpura=4).
- ✅ `otras-construcciones.geojson` (928 features, 0.6 MB) — convertido desde `otherconstruction.gml`. Capa "Piscinas / otras construcciones" en grupo Catastro. **Todas las 928 son `openAirPool`** — el pueblo es residencial de segunda vivienda con piscina particular.

Modificación del parser: `scripts/gml-generic.js` ahora soporta `<gml:Polygon>` directo además de `<gml:PolygonPatch>` (la `OtherConstruction` usa la forma corta sin Surface). Cambio mínimo en dos puntos del parser.

---

## 6. Cosas conceptualmente útiles pero **no son WMS abierto**

### 6.1 REE — líneas eléctricas
Red Eléctrica de España no publica WMS abierto del trazado de líneas de alta tensión. Existen aproximaciones:
- **OSM** ya tiene `power=line` y `power=tower` (subóptimo, depende de mappers voluntarios).
- **Geoportal del MITECO** tiene capa de "Infraestructura eléctrica" en `WMS_CalidadAmbiental` quizá.

### 6.2 SIGPAC vectorial
- `https://sigpac-hubcloud.es/wfs` devuelve 404 — el servicio solo expone WMS (visual + GetFeatureInfo).
- Para tener vectores SIGPAC habría que descargar el shapefile per-provincia desde FEGA (autorizado, ~GB por provincia).

### 6.3 PNOA histórico
El IGN tiene PNOA desde 1956 (vuelo americano), 1981 (interministerial), 2004-presente (anual). Permite ver evolución del territorio. **Endpoint exacto desconocido**. Investigar:
- `https://www.ign.es/wms-inspire/pnoa-ma` (actual — ya integrado)
- `https://www.ign.es/wms/pnoa-historico` (404)
- Posible servicio CNIG separado en su panel de descargas.

### 6.4 Cartografía catastral histórica
El Catastro tiene la cartografía catastral en años anteriores. No vía INSPIRE — habría que ir manualmente a la Sede Electrónica del Catastro.

### 6.5 Sismicidad / riesgo sísmico
El IGN tiene servicio de sismicidad. Endpoint no localizado.

### 6.6 Climatología detallada (AEMET)
- AEMET OpenData API: `https://opendata.aemet.es/` — REST, requiere API key gratuita.
- Datos por estación (San Román no tiene; las más cercanas son Talavera de la Reina y Arenas de San Pedro).
- No es WMS — sería un overlay distinto (markers de estaciones + datos series tiempo).

---

## 7. Features de la app no implementadas

- **Buscador por refcat**: no hay caja de búsqueda; para localizar una parcela hay que zoom manual.
- **Buscador por dirección/portal**: las direcciones están cargadas pero no hay autocomplete.
- **Filtros por CSV**: cuando hay un CSV cargado, no se puede filtrar parcelas (sólo colorear).
- **Leyenda automática de las capas WMS**: cada WMS tiene `?REQUEST=GetLegendGraphic` que devuelve PNG con la simbología — no se está mostrando.
- **Export del mapa**: no hay botón de imprimir / PNG / PDF.
- **Edición persistente del CSV**: el CSV se carga read-only; no se pueden editar valores desde el mapa.
- **Múltiples basemaps superpuestos**: el control actual permite sólo 1 base activa (radio). Podría ser checkbox con opacidad ajustable.
- **Histórico/comparación**: si se integrara PNOA histórico, sería útil un slider antes/después.

---

## 8. Notas operativas

- **Coste cero, pero dependencia de servicios públicos**: 6 de los 9 grupos de capas dependen de servidores oficiales (IGN, MITECO, MAPA, IGME). Si alguno cae, las capas correspondientes dejan de pintarse — el mapa sigue funcionando con el resto.
- **CORS**: ninguno de los WMS integrados ha dado problemas de CORS hasta ahora. Si se publica el mapa en producción y aparece bloqueo, la solución es un proxy server-side (Cloudflare Worker, ~10 líneas).
- **Cuotas**: ninguno de los servicios públicos tiene rate limits documentados, pero si el mapa se hace viral conviene moderar las queries (cache local de tiles).
