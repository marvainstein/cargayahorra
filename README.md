# Carga y Ahorra ⛽💸

PWA para iPhone que responde **«Necesito cargar combustible. ¿Qué hago?»**: cuándo, cuánto y con qué medio de pago cargar en Axion para maximizar el ahorro con tus promociones (Axion ON, Brubank, BBVA), considerando topes, días, reinicios y lo que ya usaste.

> No es una calculadora: es un **optimizador** (programación lineal entera) que nunca asume condiciones que no puede confirmar.

- Arquitectura, fuentes investigadas, modelo de datos y limitaciones: [`docs/ANALISIS.md`](docs/ANALISIS.md)

## Estado de los datos (leer primero)

Las promociones incluidas son **candidatas sin verificar** encontradas el 06/10/2026 (el entorno de desarrollo no tenía acceso a los sitios oficiales). La app **no las usa para recomendaciones definitivas** hasta que las verifiques:

1. Abrí **Ajustes → Administración de promociones**.
2. Entrá a cada promoción, abrí la **fuente oficial** y compará.
3. **Editar** → completá lo que falte y destildá las «condiciones que NO se pueden confirmar» que ya confirmaste → Guardar.
4. **Verificar**.

También respondé en **Ajustes** las preguntas de perfil (paquete Black+, nivel de Axion ON, si tu estación permite pagar en dos operaciones, tanque, provincia).

## Levantarlo

Requiere Node 22.5+.

```bash
npm install
npm run dev          # API en :8787 + frontend en :5173 (con proxy a /api)
```

Abrí http://localhost:5173. La base SQLite se crea sola en `data/` con el catálogo, tu perfil inicial y las promociones candidatas.

Producción local:

```bash
npm run build && npm start   # todo en http://localhost:8787
```

## Tests

```bash
npm test            # 89 tests: dinero, fechas, motor, optimizador (incl. fuerza bruta), API, importación, parser
npm run typecheck
```

## Actualizar promociones

- **Automático:** el servidor corre los jobs solo (importación cada 6 h, detección de desactualizadas cada 1 h, precios cada 24 h). Desactivable con `ENABLE_SCHEDULER=false`.
- **A mano:** `npm run import` (todas las fuentes), `npm run import -- brubank-help` (una), `npm run jobs` (todos los jobs), o desde Administración → «Ejecutar …».
- Los cambios detectados en promociones ya revisadas **no se aplican solos**: aparecen en Administración → «Cambios detectados para revisar».

## Agregar una promoción a mano

Administración → **+ Nueva**. Completá beneficio, topes (con período y, si se comparte con otros rubros, un id de *pool*), días, medios de pago, combustibles, segmentos y la URL oficial. Si algo no está claro, marcalo en «Condiciones que NO se pueden confirmar»: la promo se mostrará como «sin confirmar» y no se usará para recomendar. Cada edición crea una **versión nueva** (el historial queda).

## Agregar una fuente nueva (p. ej. YPF Serviclub, Shell Box, MODO)

1. Si es una página oficial con bases: agregá una entrada en `SOURCE_CONFIGS` (`src/server/sources/registry.ts`) con URLs, palabra clave, proveedor y mapeos de segmentos/combustibles.
2. Si tiene API o un formato propio: creá una clase que implemente `PromotionSource` (`fetch`, `parse`, `validate`) en `src/server/sources/` y sumala en `buildSources()`.
3. Agregá proveedor, medios de pago, segmentos y apps en el catálogo (`src/server/seed.ts`, es idempotente).
4. Escribí un test con HTML/JSON de ejemplo (ver `tests/sources.test.ts`).

El motor de reglas y el optimizador no cambian.

Las URLs también se pueden configurar sin tocar código: `SOURCE_<ID>_INDEX_URLS` y `SOURCE_<ID>_DETAIL_URLS` (ver `.env.example`). **BBVA** no tiene URL por defecto: configurá `SOURCE_BBVA_BENEFICIOS_DETAIL_URLS` con la página de bases vigente.

## Desplegar

Es un único proceso + un archivo SQLite. Cualquier servicio con disco persistente sirve.

**Docker (VPS, Fly.io, Railway, Render):**

```bash
docker build -t carga-y-ahorra .
docker run -d -p 8787:8787 -v cya-data:/data -e APP_TOKEN=un-token-largo carga-y-ahorra
```

**Fly.io** (ejemplo): `fly launch` (detecta el Dockerfile) → `fly volumes create data --size 1` → montarlo en `/data` en `fly.toml` → `fly secrets set APP_TOKEN=...` → `fly deploy`.

Poné siempre `APP_TOKEN` si queda expuesto a internet; la app lo pide una vez y lo recuerda.

**Instalar en el iPhone:** abrí la URL en Safari → Compartir → «Agregar a pantalla de inicio». Se abre a pantalla completa (`display: standalone`). Sin conexión muestra la última respuesta **marcada como desactualizada**, nunca como confirmada.

## Variables de entorno

Ver [`.env.example`](.env.example).

## Estructura

```
src/core/      dominio puro: dinero, fechas, tipos, motor de reglas, optimizador (sin I/O)
src/server/    SQLite, adapters de fuentes, importación, jobs, API (Hono)
src/web/       PWA React (sólo presenta resultados)
tests/         unitarios + integración (fixtures ficticios: "Banco A", "TEST", "EJEMPLO")
```
