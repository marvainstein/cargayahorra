# Verificación de datos de promociones

Estado al **7 de octubre de 2026**. Regla: una promoción se marca `VERIFIED` sólo si se leyeron sus **bases oficiales completas** y ninguna condición quedó ambigua. Si queda alguna duda, se guarda como `AUTOMATICALLY_IMPORTED` y la app **no la usa** para recomendar.

## Resumen

| Promoción | Fuente leída | Estado | Te aplica |
|---|---|---|---|
| Brubank — martes 10% en Axion | Bases oficiales (centro de ayuda) | ✅ `VERIFIED` | **Sí** (todos los clientes Brubank). Hay que elegir la estación |
| Brubank Plan Plus — viernes a domingo 20% | Bases oficiales | ⚠️ sin confirmar (1 duda) | No (exclusiva Plan Plus) |
| Brubank Plan Ultra — todos los días 30% | Bases oficiales | ✅ `VERIFIED` | No (exclusiva Plan Ultra) |
| Axion ON (Quantium lunes/viernes, súper 5%) | **No se pudo leer** | ⚠️ sin confirmar | — |
| BBVA (Black+ Save / All) | **No se pudo leer** | ⚠️ sin confirmar | — |

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

## Axion ON — no verificado

`www.axionenergy.com` tiene mal configurado su certificado HTTPS: no envía el certificado intermedio de DigiCert. Los navegadores lo resuelven solos, pero un servidor no puede validar la conexión.
- Para leerlo hace falta permitir `cacerts.digicert.com` y descargar ese intermedio público. Así se completa la cadena sin desactivar la verificación.
- Mientras tanto, las promos de Axion ON siguen como candidatas sin confirmar.

## BBVA — no verificado

`www.bbva.com.ar` rechaza las conexiones desde servidores (página «Algo salió mal» de su protección anti-bots), incluso con un navegador real. No se intentó saltar esa protección.
- Es probable que también bloquee al servidor donde se despliegue la app, así que la vía práctica es **Administración → Nueva promoción → «Pegar bases y condiciones»**: pegás el texto oficial (desde la app o la web de BBVA) y el sistema lo interpreta para revisar.
- No se encontró ninguna promoción de BBVA específica para Axion vigente en octubre de 2026. Lo único hallado fue el beneficio de 20% en combustible de los paquetes Black+ Save/All, sin confirmar.

## Datos que sólo podés confirmar vos (Ajustes)
- Estación donde cargás (necesaria para las promos de Brubank).
- Paquete BBVA (Black+ Save / All) y si cobrás el sueldo en BBVA.
- Nivel en Axion ON.
- Tarjetas exactas: hoy figuran Brubank Visa débito y BBVA Visa crédito; lo de BBVA es una suposición.
