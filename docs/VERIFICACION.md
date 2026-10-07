# Verificación de datos de promociones

Estado al **7 de octubre de 2026** (Brubank y Axion leídos ese día). Regla: una promoción se marca `VERIFIED` sólo si se leyeron sus **bases oficiales completas** y ninguna condición quedó ambigua. Si queda alguna duda, se guarda como `AUTOMATICALLY_IMPORTED` y la app **no la usa** para recomendar.

## Resumen

| Promoción | Fuente leída | Estado | Te aplica |
|---|---|---|---|
| Brubank — martes 10% en Axion | Bases oficiales (centro de ayuda) | ✅ `VERIFIED` | **Sí** (todos los clientes Brubank) |
| Brubank Plan Plus — viernes a domingo 20% | Bases oficiales | ⚠️ sin confirmar (1 duda) | No (exclusiva Plan Plus) |
| Brubank Plan Ultra — todos los días 30% | Bases oficiales | ✅ `VERIFIED` | No (exclusiva Plan Ultra) |
| Axion ON — lunes y viernes 10% Quantium (niveles 3, 4 y 5) | Página oficial de beneficios (API) | ✅ `VERIFIED` | **Sí**, si cargás Quantium (Premium) |
| Axion ON — lunes y viernes 10% Quantium (niveles 1 y 2) | Página oficial de beneficios (API) | ✅ `VERIFIED` | No (sos nivel 4 o 5) |
| Axion ON — lunes y viernes 10% Quantium Diesel X10 | Página oficial de beneficios (API) | ⚠️ sin confirmar (1 duda) | Sólo si cargás diésel premium |
| Axion ON — «5% todos los días en súper» | — | ❌ eliminada: no figura en la página oficial | — |
| BBVA Black+ Save / All — 20% en combustible | **No se pudo leer** | ⚠️ sin confirmar | No (tenés cuenta base, sin Black+) |

## Brubank (leído el 2026-10-07)

Fuente: centro de ayuda oficial, colección «Promociones». Hay **tres** artículos de Axion; los tres traen el **Anexo I** con la misma lista de **522 estaciones adheridas** (se guardó en `src/server/seed-data/brubank-axion-estaciones-2026-10.json`).

### Martes 10% — [artículo 9010023](https://help.brubank.com/es/articles/9010023-todos-los-martes-10-off-en-la-carga-de-combustible-en-axion-energy-compra-con-tu-tarjeta-de-debito-y-credito-visa-brubank-y-gira-la-ruedita)
- **Quién:** «Clientes Brubank» (sin restricción de plan → aplica a Plan One).
- **Cuándo:** martes, del 01/10/2026 al 31/10/2026, o hasta agotar el presupuesto total de reintegros.
- **Beneficio:** 10% de **reintegro**, **tope $4.000 por compra**, **1 compra por semana**, **máximo 4** en el mes.
- **Compra mínima:** superior a $200.
- **Medio:** tarjeta de **débito o crédito** Brubank (física o virtual), combustibles líquidos, estaciones del Anexo I.
- **No cuentan:** transferencias 3.0, pagos con QR desde la app con saldo en cuenta, consumos con extracash.
- **Paso obligatorio:** el mismo día, en la app: tocar la compra con la leyenda «Promo» → «Jugá y Participá por Premios». A pesar del nombre del botón, las bases fijan el reintegro en el 10% de la compra.
- **Acreditación:** caja de ahorro en pesos, hasta 72 hs hábiles después del fin de la promoción.
- **Incoherencia en las bases:** el presupuesto total dice «$12.000.000 (pesos dos millones cuatrocientos mil)»: el número y las palabras no coinciden. No afecta tu beneficio, sólo cuándo podría terminarse antes.

### Viernes a domingo 20% (Plan Plus) — [artículo 9010641](https://help.brubank.com/es/articles/9010641-viernes-sabados-y-domingos-20-off-en-axion-energy-compra-con-tu-tarjeta-de-debito-y-credito-visa-brubank)
- 20% de reintegro, **tope $5.000 por compra**, 1 compra por semana, máximo 4. Mínimo > $200. Mismas exclusiones y estaciones.
- **Duda (por eso no se verificó):** no aclara cuándo empieza la «semana». Con viernes, sábado y domingo, eso cambia cuántas compras entran por fin de semana.

### Todos los días 30% (Plan Ultra) — [artículo 12995968](https://help.brubank.com/es/articles/12995968-todos-los-dias-30-off-en-axion-energy-compra-con-tu-tarjeta-de-debito-y-credito-visa-brubank)
- 30% de reintegro, **tope $6.000 por compra**, **1 compra por día**, **máximo 5** en el período. Mínimo > $200. Mismas exclusiones y estaciones.

### Qué estaba mal en la carga anterior (resúmenes de búsqueda)
| Dato | Antes (búsqueda web) | Bases oficiales |
|---|---|---|
| Martes: medio de pago | sólo débito Visa | débito **o crédito** Brubank |
| Martes: tope | «$4.000 semanal» o «$2.000 por compra» | **$4.000 por compra**, 1 por semana, máx. 4 |
| Plan Plus: tope | $5.000 **semanal** | $5.000 **por compra** (+ 1 por semana, máx. 4) |
| Plan Plus: provincias excluidas | TdF, Río Negro, Mendoza, Neuquén, Salta | las bases **no excluyen provincias**; el Anexo I no tiene estaciones en esas provincias |
| Plan Ultra: tope por cliente | desconocido | **$6.000 por compra**, 1 por día, máx. 5 |
| Estaciones | «adheridas» (sin lista) | lista cerrada de 522 estaciones |

## Axion (leído el 2026-10-07)

Su sitio no envía el certificado intermedio de su cadena HTTPS. Se completa con el intermedio público de DigiCert, incluido en `certs/`, sin desactivar la verificación. Se usan dos fuentes **estructuradas** oficiales del sitio:

- **Beneficios y promociones** (`/wp-json/wp/v2/pages/604`, modificada el 2026-10-02). Trae 12 promociones vigentes. La de **Axion ON** dice textualmente:
  > Promoción válida los lunes y viernes del 01/10/2026 al 31/12/2026 para usuarios ON en estaciones adheridas, en la carga de combustibles QUANTIUM Y QUANTIUM DIESEL X10. El beneficio es intransferible y se solicitará DNI para su uso y acreditación de puntos. No es acumulable con otras promociones. El tope de descuento para Quantium (nafta) es de $7.000 mensuales para niveles 1 y 2 y de $14.000 mensuales para niveles 3, 4 y 5. Para Quantium (Diesel) el tope es de $7.000 quincenal.
  - **Quantium nafta:** verificada; para vos rige el tope de **$14.000 por mes**.
  - **Quantium Diesel:** «quincenal» no aclara si es por quincena del mes o cada 15 días, así que queda sin confirmar.
  - **Forma del beneficio:** dice «descuento», pero no aclara si se aplica en el surtidor o como reintegro. El ahorro calculado es el mismo; la app lo avisa.
  - **No acumulable:** el día que usás ON, no se suma la promo del banco en esa carga.
  - **Promos que salen:** el «5% en súper» que había aparecido en notas periodísticas **no figura**, así que se eliminó.
  - **BBVA:** ninguna de las 12 promociones es de BBVA.
- **Localizador de estaciones** (`/wp-json/axion/v1/estaciones`): **574 estaciones** con coordenadas, combustibles y adhesión a ON. Hay 539 con ON, 9 sin ON y 26 que no lo informan; en esas 26 la promo queda «sin confirmar».

**Vigilancia automática:** la página de beneficios mezcla varias promociones en un mismo texto, así que no se interpreta sola.
- Se vigila cada bloque: si cambia, aparece uno nuevo o desaparece, avisa en Administración y deja pendientes de revisión las promos vinculadas.
- El catálogo de estaciones se actualiza todos los días; si cambia la lista de estaciones con ON, la promo de ON queda pendiente de revisión.

### Estaciones de Brubank vs. catálogo de Axion
El Anexo I de Brubank (522 líneas de texto) se cruza con el catálogo oficial con un criterio estricto: misma provincia, misma altura y misma calle.
- **423 estaciones** cruzan con certeza.
- Si tu estación no está entre ellas, la promo de Brubank queda «sin confirmar», nunca «no aplica». Si me decís en qué estación cargás, la confirmo a mano.

### Diferencias entre la página de Axion y las bases de Brubank
La página de Axion resume las promos de Brubank con datos distintos de las bases de Brubank:
- Para los martes dice «sólo débito Visa» y «tope semanal».
- Para el Plan Plus excluye 5 provincias.

Se toman **las bases de Brubank** (el que otorga el beneficio) como fuente principal.

## BBVA — no verificado

`www.bbva.com.ar` rechaza las conexiones desde servidores (protección anti-bots); no se intentó saltarla.
- No hay ninguna promoción de BBVA en la página oficial de Axion para octubre de 2026.
- El localizador de Axion marca 324 estaciones con «BBVA Go», lo que sugiere que existe o existió algún beneficio de BBVA en Axion.
- Para cargarla: Administración → + Nueva → **«Pegar bases y condiciones»**.

Dónde buscar las bases:
- Web: https://www.bbva.com.ar/beneficios/ (a esa dirección redirige go.bbva.com.ar). Buscá «Axion» o «Combustible», entrá al beneficio y abrí «Bases y condiciones» / «Legales».
- App BBVA: Beneficios → buscar «Axion» o «Combustible» → abrir el beneficio → legales.

## Tu perfil (Ajustes → ¿Qué tenés?)
- Brubank Plan One con Visa débito.
- BBVA cuenta base (sin Black+) con Visa crédito; falta indicar si cobrás el sueldo en BBVA.
- Axion ON nivel 3, 4 o 5.
- **Falta:** tu estación habitual y el combustible que cargás (Súper o Premium/Quantium). Con Súper, la promo de Axion ON no aplica.
