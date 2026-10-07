# Carga y Ahorra ⛽💸

PWA para iPhone que responde **«Necesito cargar combustible. ¿Qué hago?»**: cuándo, cuánto y con qué medio de pago cargar en Axion para maximizar el ahorro con tus promociones (Axion ON, Brubank, BBVA), considerando topes, días, reinicios y lo que ya usaste.

> No es una calculadora: es un **optimizador** (programación lineal entera) que nunca asume condiciones que no puede confirmar.

- Arquitectura, fuentes investigadas, modelo de datos y limitaciones: [`docs/ANALISIS.md`](docs/ANALISIS.md)

## Estado de los datos (leer primero)

Detalle completo en [`docs/VERIFICACION.md`](docs/VERIFICACION.md).

- **Brubank y Axion ON:** verificados contra sus fuentes oficiales (7/10/2026), con estaciones adheridas. La importación y vigilancia automáticas funcionan.
- **BBVA:** **sin verificar**: su sitio bloquea servidores. Usá **Administración → + Nueva → «Pegar bases y condiciones»**.
- Lo que no está verificado no se usa para recomendar; se muestra aparte como «sin confirmar».

En **Ajustes → ¿Qué tenés?** elegí tus tarjetas, planes y nivel de Axion ON, tu **estación** y tu combustible: la recomendación se calcula sólo con eso.

## Cómo funciona (gratis)

- **Web:** GitHub Pages. La app es estática y el motor de cálculo corre en el teléfono.
- **Datos de promociones:** GitHub Actions (`.github/workflows/pages.yml`), cada 6 horas.
  1. Parte de las promociones verificadas del repo (`src/server/seed.ts`).
  2. Consulta las fuentes oficiales: estaciones y beneficios de Axion, centro de ayuda de Brubank y precios.
  3. Detecta cambios y datos desactualizados.
  4. Publica `data/app-data.json` junto con la app.

  Si una fuente cambió, abre o actualiza un *issue* «Revisar cambios en promociones». Las promos afectadas no se usan hasta revisarlas.
- **Tus datos** (perfil, cargas, ajustes de topes): sólo en tu teléfono (almacenamiento local). Se pueden exportar e importar desde Ajustes. **Nunca** van al repo, que es público.

### Publicar (una sola vez)

1. En GitHub: **Settings → Pages → Build and deployment → Source: «GitHub Actions»**.
2. **Actions → «Actualizar datos y publicar» → Run workflow** (o hacer cualquier push a `main`).
3. La app queda en **https://marvainstein.github.io/cargayahorra/**. En el iPhone: abrila en Safari → Compartir → «Agregar a pantalla de inicio».

## Desarrollo local

Requiere Node 22.5+.

```bash
npm install
npm run dev          # genera datos sin consultar fuentes (--offline) y abre la app en :5173
npm run data         # consulta las fuentes oficiales y genera public/data/app-data.json
npm test             # 95 tests
npm run typecheck
npm run build        # app estática en dist/
```

Hay además un modo servidor (`npm run dev:server`, `npm start`, Dockerfile) con base SQLite y API. No hace falta para la versión publicada.

## Actualizar o corregir una promoción

- **Automático:** el workflow corre solo cada 6 horas. También a mano: Actions → «Actualizar datos y publicar» → Run workflow.
- **Cuando hay un issue de revisión:** se compara con las bases oficiales y se actualiza la promoción en `src/server/seed.ts`. Eso incluye la huella `sourceFingerprint` (Brubank) o la línea de base en `src/server/seed-data/` (Axion). Al subir el cambio se republica sola.
- **Promos que no se pueden leer automáticamente (BBVA):** se cargan en `src/server/seed.ts` a partir de las bases pegadas. `parseLegalText` (`src/server/sources/legal-parser.ts`) ayuda a interpretarlas y marca lo dudoso como desconocido.

## Agregar una fuente nueva (p. ej. YPF Serviclub, Shell Box, MODO)

1. **Página oficial con bases:** una entrada en `SOURCE_CONFIGS` (`src/server/sources/registry.ts`).
2. **API o formato propio:** una clase que implemente `PromotionSource` (`fetch`, `parse`, `validate`) en `src/server/sources/`. Si la página mezcla promos, un vigilante por bloques como el de Axion (`src/server/jobs/axion.ts`).
3. **Catálogo:** proveedor, tarjetas, segmentos y grupos en `src/server/seed.ts`.
4. **Test:** con un texto de ejemplo, en `tests/`.

El motor y la interfaz no cambian.

## Variables de entorno (modo servidor y generación de datos)

Ver [`.env.example`](.env.example).

## Estructura

```
src/core/      dominio puro: dinero, fechas, tipos, motor de reglas, optimizador (sin I/O)
src/app/       casos de uso compartidos (recomendación, plan, registro, historial)
src/server/    fuentes oficiales, importación, vigilancia, generación de datos (y modo servidor opcional)
src/web/       PWA React: presenta resultados; datos personales en el dispositivo
tests/         unitarios + integración (fixtures ficticios: "Banco A", "TEST", "EJEMPLO")
```
