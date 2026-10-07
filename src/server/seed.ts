/**
 * Datos iniciales.
 *
 * - Catálogo (proveedores, medios de pago, segmentos, apps).
 * - Perfil inicial del usuario (editable en Ajustes).
 * - Brubank: verificadas el 2026-10-07 leyendo las bases oficiales completas
 *   (centro de ayuda), con la lista de estaciones adheridas del Anexo I.
 * - Axion ON y BBVA: CANDIDATAS de resúmenes de búsqueda web (2026-10-06), porque
 *   sus sitios no se pudieron leer desde el entorno de desarrollo. Se cargan como
 *   AUTOMATICALLY_IMPORTED con confianza LOW y las dudas marcadas como
 *   desconocidas. La app NO las usa para recomendaciones definitivas hasta que se
 *   verifiquen contra la fuente oficial.
 */
import { pesos } from '../core/money';
import type { Clock } from '../core/time';
import type { PromotionRule, Station } from '../core/types';
import brubankStations from './seed-data/brubank-axion-estaciones-2026-10.json';
import { upsertStations } from './db/stations';
import { type DB, get, run, transaction } from './db/db';
import { createPromotion, type PromotionDraft } from './db/promotions';
import { DEFAULT_USER_ID } from './db/user';
import { SOURCE_CONFIGS } from './sources/registry';

const SEED_SOURCE_NAME = 'Investigación inicial — resumen de búsqueda web, NO verificado en la fuente oficial';
const SEED_RETRIEVED_AT = '2026-10-06T20:00:00.000Z';

function base(overrides: Partial<PromotionRule>): PromotionRule {
  return {
    discountType: 'PERCENTAGE',
    discountValue: 0,
    delivery: 'CASHBACK',
    stage: 'PAYMENT',
    caps: [],
    minimumPurchase: null,
    maximumPurchase: null,
    minimumLitres: null,
    usageLimits: [],
    daysOfWeek: null,
    daysOfMonth: null,
    eligibleProviderIds: null,
    eligiblePaymentMethodIds: null,
    eligiblePaymentMethodTypes: null,
    eligibleNetworks: null,
    eligibleFuelTypes: null,
    eligibleStationIds: null,
    eligibleRegions: null,
    excludedRegions: null,
    eligibleCustomerSegments: null,
    requiredLoyaltyProgrammeId: null,
    requiresApp: null,
    requiresQR: false,
    requiresNFC: false,
    requiresSpecificCard: false,
    stackable: 'UNKNOWN',
    stackableWith: [],
    multipleOperationsPerDay: 'UNKNOWN',
    weekStartsOn: 1,
    unknownConditions: [],
    notes: [],
    extra: {},
    ...overrides,
  };
}

interface SeedPromotion {
  id: string;
  sourceId: string | null;
  sourceKey: string | null;
  /** Cómo se verificó (queda en la auditoría). */
  verification?: string;
  draft: PromotionDraft;
}

// Estaciones del Anexo I de las bases de Brubank (octubre 2026), extraídas del texto oficial.
const BRUBANK_STATIONS = brubankStations as { retrievedAt: string; stations: Array<Pick<Station, 'id' | 'brandId' | 'name' | 'address' | 'region'>> };
const BRUBANK_STATION_IDS = BRUBANK_STATIONS.stations.map((st) => st.id);
const BRUBANK_VERIFIED_AT = BRUBANK_STATIONS.retrievedAt;
const BRUBANK_URLS = {
  martes:
    'https://help.brubank.com/es/articles/9010023-todos-los-martes-10-off-en-la-carga-de-combustible-en-axion-energy-compra-con-tu-tarjeta-de-debito-y-credito-visa-brubank-y-gira-la-ruedita',
  finde: 'https://help.brubank.com/es/articles/9010641-viernes-sabados-y-domingos-20-off-en-axion-energy-compra-con-tu-tarjeta-de-debito-y-credito-visa-brubank',
  ultra: 'https://help.brubank.com/es/articles/12995968-todos-los-dias-30-off-en-axion-energy-compra-con-tu-tarjeta-de-debito-y-credito-visa-brubank',
};

/** Promoción leída en sus bases oficiales completas. Si queda alguna duda, no se marca verificada. */
function verified(
  d: Omit<PromotionDraft, 'status' | 'confidence' | 'sourceName' | 'retrievedAt' | 'lastVerifiedAt'>,
  status: PromotionDraft['status'] = 'VERIFIED',
): PromotionDraft {
  return {
    ...d,
    status: d.rule.unknownConditions.length ? 'AUTOMATICALLY_IMPORTED' : status,
    confidence: 'HIGH',
    sourceName: 'Brubank — Centro de ayuda (bases y condiciones)',
    retrievedAt: BRUBANK_VERIFIED_AT,
    lastVerifiedAt: d.rule.unknownConditions.length ? null : BRUBANK_VERIFIED_AT,
  };
}

function draft(d: Omit<PromotionDraft, 'status' | 'confidence' | 'sourceName' | 'retrievedAt' | 'lastVerifiedAt'>): PromotionDraft {
  return { ...d, status: 'AUTOMATICALLY_IMPORTED', confidence: 'LOW', sourceName: SEED_SOURCE_NAME, retrievedAt: SEED_RETRIEVED_AT, lastVerifiedAt: null };
}

export const SEED_PROMOTIONS: SeedPromotion[] = [
  // ── Brubank: verificadas contra las bases oficiales (centro de ayuda), 2026-10-07 ──
  {
    id: 'seed-brubank-martes-10',
    sourceId: 'brubank-help',
    sourceKey: '9010023',
    verification: 'Bases leídas completas en el centro de ayuda oficial de Brubank el 2026-10-07.',
    draft: verified({
      providerId: 'brubank',
      fuelBrandId: 'axion',
      name: 'Brubank: martes 10% en Axion',
      description:
        'Todos los clientes Brubank. Martes del 01/10 al 31/10/2026: 10% de reintegro en combustibles líquidos con tarjeta de débito o crédito Brubank, tope $4.000 por compra, 1 compra por semana y máximo 4 en el mes. Compras superiores a $200, en las estaciones del Anexo I.',
      validFrom: '2026-10-01',
      validUntil: '2026-10-31',
      sourceUrl: BRUBANK_URLS.martes,
      rule: base({
        discountValue: 1000,
        daysOfWeek: [2],
        caps: [{ amount: pesos(4_000), period: 'PER_TRANSACTION' }],
        usageLimits: [
          { maxTransactions: 1, period: 'WEEKLY' },
          { maxTransactions: 4, period: 'PROMOTION_PERIOD' },
        ],
        minimumPurchase: pesos(200) + 1,
        eligibleProviderIds: ['brubank'],
        eligiblePaymentMethodTypes: ['DEBIT_CARD', 'CREDIT_CARD'],
        eligibleStationIds: BRUBANK_STATION_IDS,
        multipleOperationsPerDay: 'NO',
        notes: [
          'El mismo día de la carga: entrá a la app de Brubank, tocá la compra con la leyenda "Promo" y elegí "Jugá y Participá por Premios". Sin ese paso no hay reintegro.',
          'Pagá con la tarjeta Brubank (física o virtual). No cuentan transferencias 3.0, pagos con QR desde la app con saldo en cuenta ni consumos con extracash.',
          'El reintegro se acredita en tu caja de ahorro en pesos hasta 72 hs hábiles después del 31/10.',
          'La promoción puede terminar antes si se agota el presupuesto total de reintegros.',
        ],
      }),
    }),
  },
  {
    id: 'seed-brubank-finde-20',
    sourceId: 'brubank-help',
    sourceKey: '9010641',
    verification:
      'Bases leídas completas el 2026-10-07. Queda sin confirmar cómo se cuenta la "semana" del límite (con viernes a domingo, si la semana arranca el domingo podrían ser 2 compras por fin de semana).',
    draft: verified({
      providerId: 'brubank',
      fuelBrandId: 'axion',
      name: 'Brubank Plan Plus: viernes a domingo 20% en Axion',
      description:
        'Sólo clientes con Plan Plus activo. Viernes, sábados y domingos del 01/10 al 31/10/2026: 20% de reintegro, tope $5.000 por compra, 1 compra por semana y máximo 4. Compras superiores a $200, en las estaciones del Anexo I.',
      validFrom: '2026-10-01',
      validUntil: '2026-10-31',
      sourceUrl: BRUBANK_URLS.finde,
      rule: base({
        discountValue: 2000,
        daysOfWeek: [5, 6, 7],
        caps: [{ amount: pesos(5_000), period: 'PER_TRANSACTION' }],
        usageLimits: [
          { maxTransactions: 1, period: 'WEEKLY' },
          { maxTransactions: 4, period: 'PROMOTION_PERIOD' },
        ],
        minimumPurchase: pesos(200) + 1,
        eligibleProviderIds: ['brubank'],
        eligiblePaymentMethodTypes: ['DEBIT_CARD', 'CREDIT_CARD'],
        eligibleCustomerSegments: ['brubank-plan-plus'],
        eligibleStationIds: BRUBANK_STATION_IDS,
        multipleOperationsPerDay: 'NO',
        unknownConditions: ['USAGE_LIMIT'],
        notes: [
          'Pagá con la tarjeta Brubank (física o virtual). No cuentan transferencias 3.0, pagos con QR desde la app con saldo en cuenta ni consumos con extracash.',
          'El reintegro se acredita hasta 72 hs hábiles después del 31/10.',
        ],
      }),
    }, 'AUTOMATICALLY_IMPORTED'),
  },
  {
    id: 'seed-brubank-ultra-30',
    sourceId: 'brubank-help',
    sourceKey: '12995968',
    verification: 'Bases leídas completas en el centro de ayuda oficial de Brubank el 2026-10-07.',
    draft: verified({
      providerId: 'brubank',
      fuelBrandId: 'axion',
      name: 'Brubank Plan Ultra: todos los días 30% en Axion',
      description:
        'Sólo clientes suscriptos a Plan Ultra. Todos los días del 01/10 al 31/10/2026: 30% de reintegro, tope $6.000 por compra, 1 compra por día y máximo 5 en el período. Compras superiores a $200, en las estaciones del Anexo I.',
      validFrom: '2026-10-01',
      validUntil: '2026-10-31',
      sourceUrl: BRUBANK_URLS.ultra,
      rule: base({
        discountValue: 3000,
        caps: [{ amount: pesos(6_000), period: 'PER_TRANSACTION' }],
        usageLimits: [
          { maxTransactions: 1, period: 'DAILY' },
          { maxTransactions: 5, period: 'PROMOTION_PERIOD' },
        ],
        minimumPurchase: pesos(200) + 1,
        eligibleProviderIds: ['brubank'],
        eligiblePaymentMethodTypes: ['DEBIT_CARD', 'CREDIT_CARD'],
        eligibleCustomerSegments: ['brubank-plan-ultra'],
        eligibleStationIds: BRUBANK_STATION_IDS,
        multipleOperationsPerDay: 'NO',
        notes: [
          'Pagá con la tarjeta Brubank (física o virtual). No cuentan transferencias 3.0, pagos con QR desde la app con saldo en cuenta ni consumos con extracash.',
          'El reintegro se acredita hasta 72 hs hábiles después del 31/10.',
          'La promoción puede terminar antes si se agota el presupuesto total de reintegros.',
        ],
      }),
    }),
  },
  {
    id: 'seed-axion-on-quantium-n12',
    sourceId: null,
    sourceKey: null,
    draft: draft({
      providerId: 'axion-on',
      fuelBrandId: 'axion',
      name: 'Axion ON: lunes y viernes 10% en Quantium (niveles 1 y 2)',
      description: '10% de descuento lunes y viernes en Quantium para usuarios ON niveles 1 y 2, tope mensual $7.000. No acumulable con otras promociones.',
      validFrom: '2026-10-01',
      validUntil: '2026-12-31',
      sourceUrl: 'https://www.axionenergy.com/beneficios-y-promociones/',
      rule: base({
        discountValue: 1000,
        delivery: 'INSTANT_DISCOUNT',
        stage: 'PRICE',
        daysOfWeek: [1, 5],
        caps: [{ amount: pesos(7_000), period: 'MONTHLY' }],
        eligibleFuelTypes: ['PREMIUM'],
        eligibleCustomerSegments: ['axion-on-level-1-2'],
        requiredLoyaltyProgrammeId: 'axion-on',
        requiresApp: 'axion-on',
        stackable: 'NO',
        notes: ['Identificate con la app ON antes de pagar. Pueden pedirte el DNI.', 'Sólo en estaciones adheridas.'],
      }),
    }),
  },
  {
    id: 'seed-axion-on-quantium-n35',
    sourceId: null,
    sourceKey: null,
    draft: draft({
      providerId: 'axion-on',
      fuelBrandId: 'axion',
      name: 'Axion ON: lunes y viernes 10% en Quantium (niveles 3 a 5)',
      description: '10% de descuento lunes y viernes en Quantium para usuarios ON niveles 3, 4 y 5, tope mensual $14.000. No acumulable con otras promociones.',
      validFrom: '2026-10-01',
      validUntil: '2026-12-31',
      sourceUrl: 'https://www.axionenergy.com/beneficios-y-promociones/',
      rule: base({
        discountValue: 1000,
        delivery: 'INSTANT_DISCOUNT',
        stage: 'PRICE',
        daysOfWeek: [1, 5],
        caps: [{ amount: pesos(14_000), period: 'MONTHLY' }],
        eligibleFuelTypes: ['PREMIUM'],
        eligibleCustomerSegments: ['axion-on-level-3-5'],
        requiredLoyaltyProgrammeId: 'axion-on',
        requiresApp: 'axion-on',
        stackable: 'NO',
        notes: ['Identificate con la app ON antes de pagar. Pueden pedirte el DNI.', 'Sólo en estaciones adheridas.'],
      }),
    }),
  },
  {
    id: 'seed-axion-on-quantium-diesel',
    sourceId: null,
    sourceKey: null,
    draft: draft({
      providerId: 'axion-on',
      fuelBrandId: 'axion',
      name: 'Axion ON: lunes y viernes 10% en Quantium Diesel X10',
      description: '10% de descuento lunes y viernes en Quantium Diesel X10 para usuarios ON. Tope informado: $7.000 "cada dos semanas" (no está claro si son quincenas calendario o 14 días corridos).',
      validFrom: '2026-10-01',
      validUntil: '2026-12-31',
      sourceUrl: 'https://www.axionenergy.com/beneficios-y-promociones/',
      rule: base({
        discountValue: 1000,
        delivery: 'INSTANT_DISCOUNT',
        stage: 'PRICE',
        daysOfWeek: [1, 5],
        eligibleFuelTypes: ['DIESEL_PREMIUM'],
        requiredLoyaltyProgrammeId: 'axion-on',
        requiresApp: 'axion-on',
        stackable: 'NO',
        unknownConditions: ['CAP_PERIOD'],
        notes: ['Identificate con la app ON antes de pagar.'],
      }),
    }),
  },
  {
    id: 'seed-axion-on-super-5',
    sourceId: null,
    sourceKey: null,
    draft: draft({
      providerId: 'axion-on',
      fuelBrandId: 'axion',
      name: 'Axion ON: 5% todos los días en nafta súper (≥ 25 L)',
      description: 'Mencionada en una nota periodística sin fecha clara: 5% todos los días en nafta súper para cargas de al menos 25 litros. Vigencia y tope sin confirmar.',
      validFrom: '2026-10-01',
      validUntil: null,
      sourceUrl: 'https://www.axionenergy.com/beneficios-y-promociones/',
      rule: base({
        discountValue: 500,
        delivery: 'INSTANT_DISCOUNT',
        stage: 'PRICE',
        minimumLitres: 25,
        eligibleFuelTypes: ['SUPER'],
        requiredLoyaltyProgrammeId: 'axion-on',
        requiresApp: 'axion-on',
        unknownConditions: ['VALIDITY', 'CAP', 'STACKABILITY'],
      }),
    }),
  },
  {
    id: 'seed-bbva-black-save-20',
    sourceId: null,
    sourceKey: null,
    draft: draft({
      providerId: 'bbva',
      fuelBrandId: null,
      name: 'BBVA Black+ Save: 20% en combustible (cualquier estación)',
      description: '20% de reintegro todos los días en combustible y supermercados, en cualquier estación del país, con tope de $100.000 por mes compartido entre ambos rubros. Requiere paquete Black+ Save.',
      validFrom: '2026-06-01',
      validUntil: null,
      sourceUrl: 'https://www.bbva.com.ar/personas/productos/paquetes/black-save.html',
      rule: base({
        discountValue: 2000,
        caps: [{ amount: pesos(100_000), period: 'MONTHLY', poolId: 'bbva-black-save-mensual' }],
        eligibleProviderIds: ['bbva'],
        eligiblePaymentMethodTypes: ['CREDIT_CARD'],
        eligibleNetworks: ['VISA'],
        eligibleCustomerSegments: ['bbva-black-save'],
        unknownConditions: ['VALIDITY'],
        notes: ['El tope se comparte con supermercados: registrá en Ajustes lo que uses fuera de la app.'],
      }),
    }),
  },
  {
    id: 'seed-bbva-black-all-20',
    sourceId: null,
    sourceKey: null,
    draft: draft({
      providerId: 'bbva',
      fuelBrandId: null,
      name: 'BBVA Black+ All: 20% en combustible (cualquier estación)',
      description: '20% de reintegro en supermercados, combustible y gastronomía, con reintegros de hasta $200.000 por mes compartidos. Requiere paquete Black+ All.',
      validFrom: '2026-06-01',
      validUntil: null,
      sourceUrl: 'https://www.bbva.com.ar/personas/productos/paquetes/black-all.html',
      rule: base({
        discountValue: 2000,
        caps: [{ amount: pesos(200_000), period: 'MONTHLY', poolId: 'bbva-black-all-mensual' }],
        eligibleProviderIds: ['bbva'],
        eligiblePaymentMethodTypes: ['CREDIT_CARD'],
        eligibleNetworks: ['VISA'],
        eligibleCustomerSegments: ['bbva-black-all'],
        unknownConditions: ['VALIDITY'],
        notes: ['El tope se comparte con supermercados y gastronomía: registrá en Ajustes lo que uses fuera de la app.'],
      }),
    }),
  },
];

export function seedCatalog(db: DB) {
  transaction(db, () => {
    const providers: Array<[string, string, string]> = [
      ['bbva', 'BBVA', 'BANK'],
      ['brubank', 'Brubank', 'BANK'],
      ['axion-on', 'Axion ON', 'LOYALTY'],
      ['axion', 'Axion energy', 'FUEL_BRAND'],
    ];
    for (const p of providers) run(db, 'INSERT OR IGNORE INTO payment_provider (id, name, kind) VALUES (?,?,?)', ...p);
    const methods: Array<[string, string, string, string, string | null]> = [
      ['brubank-visa-debito', 'brubank', 'Brubank Visa débito', 'DEBIT_CARD', 'VISA'],
      ['brubank-visa-credito', 'brubank', 'Brubank Visa crédito', 'CREDIT_CARD', 'VISA'],
      ['bbva-visa-credito', 'bbva', 'BBVA Visa crédito', 'CREDIT_CARD', 'VISA'],
      ['bbva-master-credito', 'bbva', 'BBVA Mastercard crédito', 'CREDIT_CARD', 'MASTERCARD'],
      ['bbva-visa-debito', 'bbva', 'BBVA Visa débito', 'DEBIT_CARD', 'VISA'],
    ];
    for (const m of methods) run(db, 'INSERT OR IGNORE INTO payment_method (id, provider_id, name, type, network) VALUES (?,?,?,?,?)', ...m);
    run(db, `INSERT OR IGNORE INTO loyalty_programme (id, name, fuel_brand_id) VALUES ('axion-on', 'Axion ON', 'axion')`);
    const segments: Array<[string, string | null, string, string]> = [
      ['brubank-plan-one', 'brubank', 'Brubank Plan One', '¿Tu plan de Brubank es One?'],
      ['brubank-plan-plus', 'brubank', 'Brubank Plan Plus', '¿Tu plan de Brubank es Plus?'],
      ['brubank-plan-ultra', 'brubank', 'Brubank Plan Ultra', '¿Tu plan de Brubank es Ultra?'],
      ['bbva-black-save', 'bbva', 'BBVA Black+ Save', '¿Tenés el paquete BBVA Black+ Save?'],
      ['bbva-black-all', 'bbva', 'BBVA Black+ All', '¿Tenés el paquete BBVA Black+ All?'],
      ['bbva-sueldo', 'bbva', 'Cobro de sueldo en BBVA', '¿Cobrás tu sueldo o jubilación en BBVA?'],
      ['axion-on-level-1-2', 'axion-on', 'Axion ON nivel 1 o 2', '¿Tu nivel en Axion ON es 1 o 2?'],
      ['axion-on-level-3-5', 'axion-on', 'Axion ON nivel 3, 4 o 5', '¿Tu nivel en Axion ON es 3, 4 o 5?'],
    ];
    for (const s of segments) run(db, 'INSERT OR IGNORE INTO customer_segment (id, provider_id, name, question) VALUES (?,?,?,?)', ...s);
    const apps: Array<[string, string]> = [
      ['axion-on', 'Axion ON'],
      ['modo', 'MODO'],
      ['bbva', 'App BBVA'],
      ['brubank', 'App Brubank'],
    ];
    for (const a of apps) run(db, 'INSERT OR IGNORE INTO app (id, name) VALUES (?,?)', ...a);
    for (const s of SOURCE_CONFIGS)
      run(db, 'INSERT OR IGNORE INTO source (id, name, kind, provider_id) VALUES (?,?,?,?)', s.id, s.name, 'OFFICIAL_PAGE', s.providerId);
  });
}

export function seedUser(db: DB, clock: Clock) {
  if (get(db, 'SELECT id FROM user WHERE id = ?', DEFAULT_USER_ID)) return;
  const now = clock.now().toISOString();
  transaction(db, () => {
    run(db, `INSERT INTO user (id, created_at, updated_at) VALUES (?,?,?)`, DEFAULT_USER_ID, now, now);
    // Lo que se sabe del pedido: Brubank One, BBVA y Axion ON. El resto se confirma en Ajustes.
    for (const m of ['brubank-visa-debito', 'bbva-visa-credito']) run(db, 'INSERT INTO user_payment_method (user_id, payment_method_id) VALUES (?,?)', DEFAULT_USER_ID, m);
    const segs: Array<[string, string]> = [
      ['brubank-plan-one', 'YES'],
      ['brubank-plan-plus', 'NO'],
      ['brubank-plan-ultra', 'NO'],
    ];
    for (const [s, st] of segs) run(db, 'INSERT INTO user_segment (user_id, segment_id, status) VALUES (?,?,?)', DEFAULT_USER_ID, s, st);
    run(db, `INSERT INTO user_loyalty_membership (user_id, programme_id) VALUES (?, 'axion-on')`, DEFAULT_USER_ID);
    for (const a of ['axion-on', 'bbva', 'brubank']) run(db, 'INSERT INTO user_app (user_id, app_id) VALUES (?,?)', DEFAULT_USER_ID, a);
  });
}

export function seedPromotions(db: DB, clock: Clock) {
  upsertStations(db, BRUBANK_STATIONS.stations.map((st) => ({ ...st, latitude: null, longitude: null, active: true })));
  for (const s of SEED_PROMOTIONS) {
    if (get(db, 'SELECT id FROM promotion WHERE id = ?', s.id)) continue;
    if (s.sourceId && s.sourceKey && get(db, 'SELECT id FROM promotion WHERE source_id = ? AND source_key = ?', s.sourceId, s.sourceKey)) continue;
    createPromotion(db, clock, s.draft, {
      id: s.id,
      sourceId: s.sourceId,
      sourceKey: s.sourceKey,
      actor: 'seed',
      reason: s.verification ?? 'Candidata de la investigación inicial (sin verificar)',
    });
  }
}

export function seedAll(db: DB, clock: Clock, opts: { promotions?: boolean } = {}) {
  seedCatalog(db);
  seedUser(db, clock);
  if (opts.promotions !== false) seedPromotions(db, clock);
}
