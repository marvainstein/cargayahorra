# Carga y Ahorra — análisis inicial, arquitectura y decisiones

Fecha del análisis: **martes 6 de octubre de 2026**.

## 1. Repositorio

El repositorio donde se inició la sesión (`wishlistcumple-`) es una wishlist de cumpleaños (React + Vite + Supabase) sin relación con este producto. Por eso el proyecto se creó desde cero en un repositorio propio.

## 2. Fuentes de promociones investigadas

> Limitación importante: el entorno de desarrollo **no tenía acceso de red** a `axionenergy.com`, `help.brubank.com` ni `bbva.com.ar` (bloqueados por la política de red del contenedor). Sólo se pudieron ver **resúmenes de buscador**. Por eso **ninguna promoción se cargó como verificada**.

| Proveedor | ¿API oficial? | ¿Feed estructurado? | Página oficial | Estrategia |
|---|---|---|---|---|
| **Axion / Axion ON** | No se encontró API pública | No | `axionenergy.com/beneficios-y-promociones/` (lista promos propias y de bancos; bases en `axionenergy.com`) | Adapter de página oficial (`AxionSource`). Reasigna promos de BBVA/Brubank publicadas por Axion a esos proveedores e ignora otros bancos. |
| **Brubank** | No | No | Centro de ayuda (Intercom): colección «Promociones» `help.brubank.com/es/collections/2846519-promociones`, un artículo por promoción con bases completas | Adapter de página oficial: índice → artículos que mencionan «Axion» → parser de bases. Clave estable = id del artículo. |
| **BBVA Argentina** | No se encontró API pública documentada | No | Páginas de paquetes Black+ (`bbva.com.ar/personas/productos/paquetes/...`) y BBVA Go | **No se pudo confirmar una URL oficial estable de la promoción en Axion.** El adapter existe pero queda «sin configurar» hasta definir la URL (`SOURCE_BBVA_BENEFICIOS_DETAIL_URLS`). |
| **Precios** | API CKAN de datos abiertos | CSV «Precios en surtidor» (Secretaría de Energía) | — | Adapter de datos públicos. **Advertencia:** la obligación de informar precios se derogó en 2025, el dataset puede estar desactualizado: se guarda y muestra la fecha. El precio de la última carga del usuario tiene prioridad. |

### Qué se encontró (sin verificar) y cómo quedó cargado

Todas se cargaron como `AUTOMATICALLY_IMPORTED`, confianza `LOW`, con la URL oficial para revisar:

- **Brubank — martes 10% en Axion** (oct-2026, débito Visa, clientes en general). Las fuentes no coinciden sobre el tope ($4.000 semanal vs. $2.000 por compra / 1 por semana / máx. 4) y exige «girar la ruedita» en la app → tope, límite de uso y «otras condiciones» marcados **desconocidos**.
- **Brubank Plan Plus — viernes a domingo 20%**, tope semanal $5.000, excluye 5 provincias. No aplica al usuario (tiene Plan One) → aparece como «no aplica: exclusiva para Plan Plus».
- **Brubank Plan Ultra — todos los días 30%**, compras > $200, presupuesto total $12.000.000, tope por cliente **desconocido**. No aplica (Plan One).
- **Axion ON — lunes y viernes 10% en Quantium** (oct–dic 2026): tope mensual $7.000 (niveles 1–2) / $14.000 (niveles 3–5); Quantium Diesel $7.000 «cada dos semanas» (período **ambiguo**). No acumulable.
- **Axion ON — 5% todos los días en súper con ≥ 25 L**: mencionada en una nota sin fecha → vigencia y tope **desconocidos**.
- **BBVA Black+ Save / Black+ All — 20% en combustible en cualquier estación**, tope mensual $100.000 / $200.000 **compartido** con supermercado (y gastronomía en All). Requiere el paquete → la app pregunta si lo tenés.
- No se encontró una promoción específica de BBVA en Axion vigente en octubre de 2026 (sólo una de 2024, que se descartó por antigua).

## 3. Arquitectura

```
Fuente oficial ──► Scheduled job ──► Adapter (fetch/parse) ──► Validación ──► SQLite (versionado)
                                                                                   │
                         Estado del usuario (perfil + historial) ─────────────────►│
                                                                                   ▼
                                                      Motor de reglas ──► Optimizador (LP/MILP)
                                                                                   │
                                                                         API JSON (Hono)
                                                                                   │
                                                                     PWA React (sólo presenta)
```

Un único proceso Node (API + jobs + frontend estático) y un archivo SQLite. Sin microservicios, colas ni Kubernetes: se despliega en cualquier VPS / Fly.io / Railway con un volumen.

| Capa | Ubicación | Responsabilidad |
|---|---|---|
| A. Datos de promociones | `src/server/sources/`, `src/server/jobs/import-promotions.ts` | Adapters aislados (`PromotionSource`: `fetch`, `parse`, `validate`), importación segura |
| B. Motor de reglas | `src/core/rules/` | Elegibilidad, topes, cálculo, combinación |
| C. Estado del usuario | `src/core/usage.ts`, `src/server/db/user.ts` | Perfil, medios de pago, segmentos, consumo derivado del historial |
| D. Optimizador | `src/core/optimizer/` | Programación lineal entera mixta propia |
| E. Frontend | `src/web/` | Muestra resultados. **No contiene reglas de bancos.** |

`src/core` es TypeScript puro sin I/O: 100% testeable.

### Stack
Node 22 + TypeScript, **Hono** (HTTP), **node:sqlite** (SQLite embebido, sin dependencias nativas), **React 19 + Vite** (PWA), **Vitest**. Dinero en **centavos enteros**; porcentajes en **puntos básicos**.

## 4. Modelo de datos (SQLite, `src/server/db/schema.sql`)

- Catálogo: `payment_provider`, `payment_method` (un banco puede tener varias tarjetas), `loyalty_programme`, `customer_segment` (plan/paquete/nivel), `app`, `station`.
- Usuario: `user` (timezone, currency, región, ¿se puede dividir el pago?, tanque, presupuesto), `user_payment_method`, `user_segment` (SÍ/NO/NO SÉ), `user_loyalty_membership`, `user_app`.
- Promociones versionadas: `promotion` (identidad estable, fuente, clave en la fuente, revisión pendiente) → `promotion_version` (condiciones escalares, estado, confianza, `source_url`, `retrieved_at`, `last_verified_at`, vigencia) → `promotion_cap` (monto, período, pool compartido), `promotion_usage_limit`, `promotion_eligibility` (dimensión/valor: proveedor, tarjeta, tipo, red, combustible, estación, región, segmento, día…), `promotion_unknown_condition`, `promotion_stackable_with`, `promotion_event` (auditoría).
- Fuentes: `source`, `import_run`, `import_candidate` (cambios pendientes de revisión), `job_run`.
- `fuel_price`, `fuel_transaction` + `fuel_transaction_promotion` (guarda la **versión** aplicada), `cap_usage_adjustment` (consumo de topes fuera de la app).

Nunca se guardan números de tarjeta, CVV, claves ni credenciales.

## 5. Motor de reglas

`calculatePromotionBenefit({ promotion, transaction, userState })` devuelve `eligibility` (`ELIGIBLE` | `INELIGIBLE` | `UNCERTAIN`), motivos legibles, descuento, reintegro, costo neto, tope restante y gasto que todavía genera beneficio.

- Nunca asume: cada condición se chequea; una condición desconocida ⇒ `UNCERTAIN` (no se usa para recomendaciones definitivas).
- Estados `AUTOMATICALLY_IMPORTED`, `STALE` o con revisión pendiente ⇒ `UNCERTAIN`. `INVALID` ⇒ `INELIGIBLE`.
- Topes por período (`PER_TRANSACTION`, `DAILY`, `WEEKLY`, `MONTHLY`, `ANNUAL`, `LIFETIME`, `PROMOTION_PERIOD`), varios topes simultáneos (manda el más restrictivo) y **pools compartidos** entre promociones.
- `canCombinePromotions()`: sólo si ambas lo confirman; dos promos de medio de pago nunca en una misma operación salvo declaración explícita. Las de etapa `PRICE` (programa de la estación) se aplican primero y las `PAYMENT` sobre lo efectivamente cobrado.
- `canSplitTransaction()`: depende de que la estación permita pagar en dos operaciones (dato del usuario, por defecto «no sé») y de que ninguna promo lo prohíba.
- Redondeo: beneficios hacia abajo al centavo (conservador); gasto para agotar un tope hacia arriba.

## 6. Optimizador

Un único modelo (`optimizePlan`) resuelve **una carga**, **¿me conviene esperar?** y **plan mensual**:

- Variables por operación candidata (día × medio de pago × conjunto de promos combinables): gasto `x` y gasto que genera beneficio `e` por promo.
- Maximiza el ahorro monetario total sujeto a: topes por período/pool (con lo ya consumido), vigencia y días, compra mínima/máxima, límites de operaciones, una operación por día si no se puede dividir el pago, tanque por carga, cantidad máxima de cargas y gasto total.
- Se resuelve con un **simplex de dos fases + branch & bound propio** (~200 líneas, sin dependencias), porque un greedy por porcentaje **no es correcto** (hay un test con el contraejemplo: greedy 15.000 vs. óptimo 27.500).
- El solver sólo elige la asignación: los montos finales se **recalculan con el motor de reglas en centavos**, simulando las operaciones en orden.
- Cada resultado incluye explicaciones auditables («X te da 30% con un tope restante de $15.000; para usarlo completo necesitás cargar $50.000», «el resto conviene con Y porque su beneficio marginal es mayor»).

## 7. Actualización de promociones

- Jobs en el mismo proceso: importación cada 6 h, detección de desactualizadas cada 1 h, precios cada 24 h. También `npm run import` / `npm run jobs`.
- Nada se consulta afuera cuando el usuario abre la app.
- Seguridad de la importación: si la estructura de la fuente cambió no se toca nada; una promo nueva entra sin verificar; si una promo revisada cambia, **no se sobrescribe**: se crea un candidato y la promo queda «pendiente de revisión» (deja de usarse como definitiva); si desaparece, también se marca.
- Si una fuente falla más de `STALE_AFTER_HOURS` (72 h), sus promociones pasan a `STALE`, salvo verificación reciente (< 14 días). Cuando la fuente vuelve a confirmar las mismas condiciones, se restaura el estado previo.

## 8. Riesgos y limitaciones

1. **Ninguna promoción está verificada todavía.** Hay que revisarlas una vez contra las bases oficiales (Administración → promoción → «Editar» para resolver dudas → «Verificar»). Hasta entonces la app dice «no hay beneficio confirmado» y muestra los posibles beneficios aparte.
2. Los adapters de Brubank y Axion se escribieron sin poder ver el HTML real: la primera importación puede fallar o interpretar mal. Está diseñado para que eso **no rompa nada** (falla cerrada, queda registrado en Administración).
3. Las bases legales en texto libre no se pueden interpretar con certeza: el parser es conservador y nunca marca nada como verificado.
4. El plan mensual supone que podés cargar cualquier día; no modela consumo diario del auto (se puede limitar con «tanque» y «máximo de cargas»).
5. «¿Me conviene esperar?» supone que promociones y precio se mantienen.
6. Algunos topes se comparten con otros rubros (supermercado): hay que cargar esos consumos en Ajustes para que el cálculo sea exacto.
