# Pendientes — pipeline cívico (IBIU + Tasas + Habitantes)

_Última sesión: 2026-05-15_

## Estado actual

Pipeline funcionando end-to-end. Cobertura:

- **IBIU ↔ parcelas.geojson** (refcat 14): 99.8 % de cobertura
- **Habitantes ↔ parcelas**: **2 005/2 236 = 89.7 %** vía OSM + Nominatim
  - OSM exacto: 1 728
  - OSM fuzzy (±1 portal): 183
  - Nominatim contención exacta: 4
  - Nominatim snap ≤ 50 m: 90
  - **Sin match: 231 (10.3 %)**

Mapa con `data/parcelas_agregadas.csv` operativo desde el botón "Cargar datos cívicos
del municipio". Coloreado cuantílico (numérico) y categorical detectados automáticamente.

## Lo que queda pendiente

### 1. Los 231 habitantes sin match

Concentrados en calles que ni OSM ni Nominatim conocen. Top calles afectadas (ver
`data/_civic_unificacion_report.md` para la lista completa):

- `HERREN DE HOYEROS` — 50 habitantes
- `TAHONA` — 32
- `GUADMORA` (tramos altos > 290) — 31
- `CAROY` — 16
- `CASTILLA LA MANCHA` — 16
- `JARDINES` — 15
- `BAJAMAR`, `MAR CANTABRICO`, `VIRGEN BUEN CAMINO` — ~9 cada una

**Vías para resolverlo (por orden de coste/beneficio):**

1. **Callejero municipal oficial**. Pedir al ayto el listado calle ↔ refcat (lo
   tienen para emitir el IBI). Resuelve el 100 % en una sola vez.
2. **Editar OSM**. Las calles existen físicamente — añadirlas a OSM con `name=*`
   beneficia al municipio y al mapa a perpetuidad. Sesión típica de mapper
   tarda 1-2 horas.
3. **Cruce manual por urbanización**. Para Serranillos Playa, hacer una tabla
   `nombre_calle → set(refcat14)` mirando catastro/PNOA. ~50 calles a revisar.
4. **Asignar a la urbanización completa** (refcat14 con sigla=UR). Pierde
   resolución pero no deja huecos en el coloreado.

### 2. Mejoras del coloreado en el mapa

- Leyenda numérica muestra "0 – 0" repetidos cuando muchos valores son cero
  (`habitantes_estimados`, `n_exentos`). Mejorar lógica para colapsar bins
  iguales o cambiar a escala logarítmica.
- Falta forma rápida de exportar la vista actual (capa coloreada) a PNG/PDF.
- No hay tooltip al pasar el ratón con el valor de la columna activa — sólo en
  el click. Útil para explorar.

### 3. Datos por explorar

Quedan columnas del IBIU/Padrón que no he expuesto y podrían ser interesantes:

- IBIU: `BASE_LIQ_IIBU`, `BON` (bonificaciones), `EXENTO` — ya están agregadas
  como `n_exentos`/`n_bonificados`, pero podría desglosarse por motivo.
- IBIU: la propia mediana del valor catastral por uso es interesante (1 columna
  más en el CSV).

### 4. DB privada — explotación pendiente

El CSV `data/_privado/personas_dni.csv` cruza DNI/NIF entre las 3 fuentes pero
no se ha explotado en consultas concretas. Ideas:

- "Top 20 propietarios por cuota IBI" — quién paga más al ayto.
- "Propietarios IBIU no empadronados" — segundas residencias. Útil para censo
  de vivienda turística / vacaciones.
- "Empadronados sin propiedad" — familiares, inquilinos, residentes en pisos
  alquilados.
- Cuadrar el padrón con la facturación del agua (otra fuente que el ayto
  tendrá) para detectar empadronamientos fantasmas o viviendas no declaradas.

### 5. Operación recurrente

Si esto se va a regenerar cada año (IBIU 2025, padrón anual…):

- Hacer un `npm run civic` que llame:
  ```
  node scripts/build-direcciones-enriquecidas.js
  node scripts/cruzar-habitantes-osm.js
  node scripts/geocod-nominatim.js
  node scripts/unificar-civico.js
  ```
- Cachear las queries Overpass + Nominatim entre años (ya hay caché en
  `data/_nominatim_cache.json`).
- Documentar en README la fuente exacta de cada XLS y dónde pedirlo.

## 6. Hacia un gemelo digital municipal completo

Hoy el sistema encaja con lo que la literatura llama **"urban information model"**
o **"digital twin foundational layer"**: capa física multi-escala (parcela →
edificio → planta → portal) con identificadores estables (refcat 14/20) y capa
semántica acoplada (valor catastral, IBI, uso, habitantes, propietarios). Es un
**gemelo digital incipiente**.

Para subir de nivel hacen falta tres saltos:

### 6.1 De snapshot a stream

Hoy se regenera manualmente con `node scripts/unificar-civico.js`. Para que sea
"vivo":

- **Cron de ingesta** que detecte XLS nuevos en `data/` (cada vez que el ayto
  exporte IBIU/Padrón) y regenere el pipeline sin intervención.
- **Telemetría municipal en vivo**, si el ayto tiene acceso:
  - Lecturas de contadores de agua por inmueble
  - Consumo eléctrico agregado por sector
  - Residuos generados (pesaje de contenedores)
  - Llamadas al 112 / incidencias urbanas
- **Sincronización con el padrón electrónico** (altas/bajas mensuales) en vez
  de re-importar XLS anuales.
- **Alertas hidrológicas** (caudal Alberche, AEMET) integradas con la capa
  "Zonas inundables" para predicción operativa.

### 6.2 De inventario a simulación

Tenemos el sustrato; falta el motor. Posibles módulos:

- **Simulador fiscal**: "¿qué pasa si el IBI sube un 5 % o cambian las
  bonificaciones?" — recalcular cuotas por parcela y agregados municipales.
- **Simulador hidrológico ligero**: cruzar T=10/100/500 con `habitantes_estimados`
  y `valor_catastral_eur` → cuántas personas + cuánto valor expuesto a cada
  período de retorno.
- **Simulador de cobertura de servicios**: para un nuevo punto (colegio, centro
  médico, parada de bus), calcular cuántos habitantes quedan a < 5/10/15 min
  caminando, usando red de calles OSM.
- **Densidad y sobrecarga**: detectar parcelas con `densidad_hab_por_unidad`
  anómala respecto al uso declarado (posibles infraviviendas o uso turístico
  no declarado).

### 6.3 De lectura a lazo cerrado

Un gemelo digital maduro **actúa** sobre lo físico. Pasos progresivos:

- **API REST** para que servicios municipales consulten "dame la refcat y datos
  de la dirección X" — útil para padrón, atención al ciudadano, registro de
  entrada.
- **Dashboard operativo** con métricas en vivo (no sólo mapa estático): KPIs
  fiscales, ocupación, alertas activas.
- **Integración con expedientes de obras**: cuando se concede una licencia, el
  modelo sabe qué parcela se verá modificada y avisa al recalcular IBI tras
  la finalización.
- **Acoplamiento bidireccional**: el modelo lanza tareas (riego, recogida
  selectiva, alumbrado) cuando se cumplen condiciones — esto ya es smart-city
  pura y dura, requiere actuadores físicos.

### 6.4 Estandarización del modelo

- Considerar pasar el output a **CityGML LOD2** (incluye volumetría 3D real
  de edificios) en vez de GeoJSON puro. Compatible con muchas herramientas
  europeas de gemelo digital urbano (UDX, Digital Twin Hub UK).
- Cumplir **INSPIRE Building 3D** completo (hoy usamos sólo BU/CP/AD).
- Documentar el esquema en un `MODEL.md` con ontología de identificadores
  y relaciones.

### 6.5 Quick wins de bajo coste

Pasos pequeños que mueven la aguja sin cambios estructurales:

- Añadir **fecha de generación** a cada CSV público → permite versionado.
- **Tooltip al hover** en el mapa que muestre 3-4 métricas clave sin click.
- **Exportar PDF de parcela**: ficha de una sola parcela con todos sus
  atributos + ubicación. Útil para gestión municipal diaria.
- **Búsqueda por refcat** en la URL: `?refcat=2670101UK5327S` → centra y
  resalta la parcela.

## Archivos relevantes

```
scripts/
  build-direcciones-enriquecidas.js   GML → data/direcciones.geojson con calle+refcat14
  cruzar-habitantes-osm.js            Overpass + buffer 30m → asignaciones OSM
  geocod-nominatim.js                 fallback geocoding 1 req/s
  unificar-civico.js                  pipeline principal

data/                                 (públicos, sin PII)
  parcelas_agregadas.csv              2922 parcelas, 15 columnas
  unidades_catastrales.csv            3152 unidades
  habitantes_por_calle.csv            957 calles
  _civic_unificacion_report.md        diagnóstico

data/_privado/                        (gitignored)
  inmuebles_titular.csv               IBIU + NIF + nombre
  habitantes_geocodificados.csv       cada habitante con refcat14
  personas_dni.csv                    cruce por documento
```
