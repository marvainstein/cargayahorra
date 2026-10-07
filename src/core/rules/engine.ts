/**
 * Motor de reglas: interpreta las condiciones estructuradas de una promoción.
 *
 * Principios:
 *  - Jamás asume elegibilidad: cada condición se verifica explícitamente.
 *  - Una condición desconocida produce `UNCERTAIN`, nunca `ELIGIBLE`.
 *  - Todos los montos en centavos enteros.
 */
import { applyBps, type Cents, formatARS, formatPercent, spendToReachBenefit } from '../money';
import { CAP_PERIOD_LABELS, CAP_PERIOD_NOUN, FUEL_TYPE_LABELS, PAYMENT_METHOD_TYPE_LABELS, UNKNOWN_CONDITION_LABELS } from '../labels';
import { dayOfMonth, dayOfWeek, formatShortDate, formatWeekdays, type LocalDate } from '../time';
import {
  CONFIRMED_STATUSES,
  type BenefitCap,
  type FuelType,
  type PaymentMethod,
  type Promotion,
  type UnknownCondition,
  type UserProfile,
  type UserState,
} from '../types';
import { poolIdsOf, transactionsInPeriod, usedBenefitForCap } from '../usage';

export type Eligibility = 'ELIGIBLE' | 'INELIGIBLE' | 'UNCERTAIN';

export interface Reason {
  code: string;
  message: string;
}

/** Nombres legibles para explicar resultados (el motor no conoce marcas). */
export interface Catalog {
  providerName(id: string): string;
  segmentName(id: string): string;
  programmeName(id: string): string;
  paymentMethodName(id: string): string;
}

export const idCatalog: Catalog = {
  providerName: (id) => id,
  segmentName: (id) => id,
  programmeName: (id) => id,
  paymentMethodName: (id) => id,
};

export interface StaticContext {
  date: LocalDate;
  paymentMethod: PaymentMethod;
  fuelType: FuelType;
  stationId: string | null;
  profile: UserProfile;
  catalog?: Catalog;
}

export interface StaticEligibility {
  eligibility: Eligibility;
  reasons: Reason[];
  uncertainties: Reason[];
  requirements: string[];
}

/** Condiciones desconocidas que impiden calcular el beneficio de una operación simple. */
const BLOCKING_UNKNOWN: UnknownCondition[] = [
  'BENEFIT_VALUE',
  'CAP',
  'CAP_PERIOD',
  'PAYMENT_METHODS',
  'FUEL_TYPES',
  'STATIONS',
  'REGIONS',
  'SEGMENTS',
  'DAYS',
  'VALIDITY',
  'MINIMUM_PURCHASE',
  'USAGE_LIMIT',
  'DELIVERY',
  'OTHER',
];

function list(ids: string[], name: (id: string) => string): string {
  const names = ids.map(name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} o ${names[names.length - 1]}`;
}

/**
 * Condiciones que no dependen del monto: vigencia, día, medio de pago,
 * combustible, estación, región, segmento, programa, app, estado.
 */
export function checkStaticEligibility(promotion: Promotion, ctx: StaticContext): StaticEligibility {
  const cat = ctx.catalog ?? idCatalog;
  const r = promotion.rule;
  const reasons: Reason[] = [];
  const uncertainties: Reason[] = [];
  const requirements: string[] = [];
  const unknown = new Set(r.unknownConditions);
  const no = (code: string, message: string) => reasons.push({ code, message });
  const maybe = (code: string, message: string) => uncertainties.push({ code, message });

  // Estado de la información
  if (promotion.status === 'INVALID') no('STATUS_INVALID', 'La promoción está marcada como inválida.');
  else if (promotion.status === 'STALE')
    maybe('STATUS_STALE', 'La información de esta promoción está desactualizada: no se pudo volver a verificar en la fuente.');
  else if (!CONFIRMED_STATUSES.includes(promotion.status))
    maybe('STATUS_UNCONFIRMED', 'Promoción importada automáticamente y todavía no verificada.');
  if (promotion.pendingReview) maybe('PENDING_REVIEW', 'La fuente publicó cambios que todavía no fueron revisados.');

  // Vigencia
  if (ctx.date < promotion.validFrom) no('NOT_STARTED', `La promoción empieza el ${formatShortDate(promotion.validFrom)}.`);
  if (promotion.validUntil && ctx.date > promotion.validUntil)
    no('EXPIRED', `La promoción venció el ${formatShortDate(promotion.validUntil)}.`);

  // Días
  if (r.daysOfWeek && r.daysOfWeek.length > 0 && !r.daysOfWeek.includes(dayOfWeek(ctx.date)))
    no('WRONG_DAY', `Sólo válida los ${formatWeekdays(r.daysOfWeek)}.`);
  if (r.daysOfMonth && r.daysOfMonth.length > 0 && !r.daysOfMonth.includes(dayOfMonth(ctx.date)))
    no('WRONG_DAY_OF_MONTH', `Sólo válida los días ${r.daysOfMonth.join(', ')} de cada mes.`);

  // Medio de pago
  const pm = ctx.paymentMethod;
  if (r.eligibleProviderIds && r.eligibleProviderIds.length > 0 && !r.eligibleProviderIds.includes(pm.providerId))
    no('WRONG_PROVIDER', `Requiere pagar con ${list(r.eligibleProviderIds, cat.providerName)}.`);
  if (r.eligiblePaymentMethodIds && r.eligiblePaymentMethodIds.length > 0 && !r.eligiblePaymentMethodIds.includes(pm.id))
    no('WRONG_CARD', `Requiere ${list(r.eligiblePaymentMethodIds, cat.paymentMethodName)}.`);
  if (r.eligiblePaymentMethodTypes && r.eligiblePaymentMethodTypes.length > 0 && !r.eligiblePaymentMethodTypes.includes(pm.type))
    no('WRONG_CARD_TYPE', `Sólo con ${list(r.eligiblePaymentMethodTypes, (t) => PAYMENT_METHOD_TYPE_LABELS[t as keyof typeof PAYMENT_METHOD_TYPE_LABELS] ?? t)}.`);
  if (r.eligibleNetworks && r.eligibleNetworks.length > 0) {
    if (!pm.network) maybe('NETWORK_UNKNOWN', `Requiere tarjeta ${r.eligibleNetworks.join(' o ')} y no sabemos la red de ${pm.name}.`);
    else if (!r.eligibleNetworks.includes(pm.network)) no('WRONG_NETWORK', `Sólo con tarjetas ${r.eligibleNetworks.join(' o ')}.`);
  }

  // Combustible
  if (r.eligibleFuelTypes && r.eligibleFuelTypes.length > 0 && !r.eligibleFuelTypes.includes(ctx.fuelType))
    no('WRONG_FUEL', `No aplica a ${FUEL_TYPE_LABELS[ctx.fuelType]} (sólo ${r.eligibleFuelTypes.map((f) => FUEL_TYPE_LABELS[f]).join(', ')}).`);

  // Estación
  if (r.eligibleStationIds && r.eligibleStationIds.length > 0) {
    const uncertainStations = Array.isArray(r.extra?.uncertainStationIds) ? (r.extra.uncertainStationIds as string[]) : [];
    if (!ctx.stationId) maybe('STATION_UNKNOWN', 'Sólo aplica en algunas estaciones y no indicaste en cuál cargás.');
    else if (!r.eligibleStationIds.includes(ctx.stationId)) {
      // La fuente no informa si esta estación adhiere, o su lista no se pudo cruzar completa
      // con el catálogo: no se puede afirmar que NO aplique.
      if (uncertainStations.includes(ctx.stationId))
        maybe('STATION_UNCONFIRMED', 'La fuente no informa si tu estación adhiere a esta promoción.');
      else if (r.extra?.stationListIncomplete === true)
        maybe('STATION_UNCONFIRMED', 'No pude confirmar que tu estación figure en la lista de estaciones adheridas: revisala en las bases.');
      else no('WRONG_STATION', 'No aplica en esta estación.');
    }
  }

  // Región
  const region = ctx.profile.region;
  if (r.excludedRegions && r.excludedRegions.length > 0) {
    if (!region) maybe('REGION_UNKNOWN', `No aplica en ${r.excludedRegions.join(', ')}; indicá tu provincia en Ajustes.`);
    else if (r.excludedRegions.includes(region)) no('EXCLUDED_REGION', `No aplica en ${region}.`);
  }
  if (r.eligibleRegions && r.eligibleRegions.length > 0) {
    if (!region) maybe('REGION_UNKNOWN', `Sólo aplica en ${r.eligibleRegions.join(', ')}; indicá tu provincia en Ajustes.`);
    else if (!r.eligibleRegions.includes(region)) no('WRONG_REGION', `Sólo aplica en ${r.eligibleRegions.join(', ')}.`);
  }

  // Segmento (plan, paquete, cobro de sueldo…)
  if (r.eligibleCustomerSegments && r.eligibleCustomerSegments.length > 0) {
    const statuses = r.eligibleCustomerSegments.map((s) => ctx.profile.segments[s] ?? 'UNKNOWN');
    const names = list(r.eligibleCustomerSegments, cat.segmentName);
    if (statuses.includes('YES')) {
      // ok
    } else if (statuses.every((s) => s === 'NO')) no('WRONG_SEGMENT', `Exclusiva para ${names}.`);
    else maybe('SEGMENT_UNKNOWN', `Exclusiva para ${names}. Indicá en Ajustes si lo tenés.`);
  }

  // Programa de fidelidad
  if (r.requiredLoyaltyProgrammeId && !ctx.profile.loyaltyMemberships.includes(r.requiredLoyaltyProgrammeId))
    no('NOT_A_MEMBER', `Requiere ser socio de ${cat.programmeName(r.requiredLoyaltyProgrammeId)}.`);

  // App
  if (r.requiresApp) {
    if (!ctx.profile.apps.includes(r.requiresApp))
      no('APP_MISSING', `Requiere pagar con la app ${cat.programmeName(r.requiresApp)} (agregala en Ajustes si la usás).`);
    requirements.push(`Usá la app ${cat.programmeName(r.requiresApp)}.`);
  }
  if (r.requiresQR) requirements.push('Pagá con QR.');
  if (r.requiresNFC) requirements.push('Pagá acercando la tarjeta o el celular (NFC).');
  if (r.requiresSpecificCard) requirements.push(`Pagá con ${pm.name}.`);
  if (r.minimumPurchase) requirements.push(`Compra mínima ${formatARS(r.minimumPurchase)}.`);
  if (r.minimumLitres) requirements.push(`Carga mínima ${r.minimumLitres} litros.`);
  requirements.push(...r.notes);

  // Condiciones que la fuente no aclara
  for (const c of BLOCKING_UNKNOWN) {
    if (unknown.has(c)) maybe(`UNKNOWN_${c}`, `No puedo confirmar ${UNKNOWN_CONDITION_LABELS[c]}.`);
  }

  const eligibility: Eligibility = reasons.length > 0 ? 'INELIGIBLE' : uncertainties.length > 0 ? 'UNCERTAIN' : 'ELIGIBLE';
  return { eligibility, reasons, uncertainties, requirements };
}

export interface TransactionInput {
  date: LocalDate;
  grossAmount: Cents;
  fuelType: FuelType;
  paymentMethodId: string;
  stationId?: string | null;
  litres?: number | null;
  pricePerLitre?: Cents | null;
}

export interface CapStatus {
  cap: BenefitCap;
  used: Cents;
  remaining: Cents;
}

export interface BenefitResult {
  promotionId: string;
  promotionVersionId: string;
  eligibility: Eligibility;
  eligible: boolean;
  reason?: string;
  reasons: Reason[];
  uncertainties: Reason[];
  requirements: string[];
  grossAmount: Cents;
  /** Monto sobre el que se calcula (cobrado con el medio de pago para promos PAYMENT). */
  baseAmount: Cents;
  discountAmount: Cents;
  cashbackAmount: Cents;
  totalBenefit: Cents;
  netCost: Cents;
  /** Tope disponible ANTES de esta operación (null = sin tope). */
  remainingCap: Cents | null;
  /** Gasto que todavía genera beneficio antes de esta operación (null = ilimitado). */
  remainingEligibleSpend: Cents | null;
  /** Tope disponible DESPUÉS de esta operación. */
  remainingCapAfter: Cents | null;
  /** El beneficio quedó limitado por un tope. */
  capLimited: boolean;
  bindingCap: BenefitCap | null;
  caps: CapStatus[];
  poolIds: string[];
}

export interface CalculateInput {
  promotion: Promotion;
  transaction: TransactionInput;
  userState: UserState;
  /** Monto sobre el que aplica (por defecto grossAmount). */
  baseAmount?: Cents;
  catalog?: Catalog;
}

function findPaymentMethod(profile: UserProfile, id: string): PaymentMethod | null {
  return profile.paymentMethods.find((m) => m.id === id) ?? null;
}

export function capStatuses(promotion: Promotion, date: LocalDate, userState: UserState): CapStatus[] {
  return promotion.rule.caps.map((cap) => {
    const used = cap.period === 'PER_TRANSACTION' ? 0 : usedBenefitForCap(cap, promotion, date, userState.usage);
    return { cap, used, remaining: Math.max(0, cap.amount - used) };
  });
}

function litresOf(tx: TransactionInput, amount: Cents): number | null {
  if (tx.litres != null && tx.litres > 0) {
    // Si el monto base es menor al bruto (descuento previo), los litros son los mismos.
    return tx.litres;
  }
  if (tx.pricePerLitre && tx.pricePerLitre > 0) return amount / tx.pricePerLitre;
  return null;
}

/** Beneficio bruto (antes de topes) para un monto base. */
function rawBenefit(promotion: Promotion, base: Cents, tx: TransactionInput): { value: Cents; uncertain?: Reason } {
  const r = promotion.rule;
  const eligibleBase = r.maximumPurchase != null ? Math.min(base, r.maximumPurchase) : base;
  if (eligibleBase <= 0) return { value: 0 };
  switch (r.discountType) {
    case 'PERCENTAGE':
      return { value: applyBps(eligibleBase, r.discountValue) };
    case 'FIXED_AMOUNT':
      return { value: Math.min(r.discountValue, base) };
    case 'PER_LITRE': {
      const totalLitres = litresOf(tx, tx.grossAmount);
      if (totalLitres == null)
        return { value: 0, uncertain: { code: 'PRICE_UNKNOWN', message: 'Beneficio por litro: falta el precio por litro.' } };
      const share = tx.grossAmount > 0 ? eligibleBase / tx.grossAmount : 0;
      return { value: Math.floor(totalLitres * Math.min(1, share) * r.discountValue) };
    }
  }
}

/**
 * Calcula el beneficio de UNA promoción para UNA operación.
 * Nunca asume elegibilidad; si no es elegible, `reasons` explica por qué.
 */
export function calculatePromotionBenefit(input: CalculateInput): BenefitResult {
  const { promotion, transaction: tx, userState } = input;
  const r = promotion.rule;
  const gross = tx.grossAmount;
  const base = input.baseAmount ?? gross;
  if (!Number.isSafeInteger(gross) || gross < 0) throw new Error(`grossAmount inválido: ${gross}`);

  const pm = findPaymentMethod(userState.profile, tx.paymentMethodId);
  const reasons: Reason[] = [];
  const uncertainties: Reason[] = [];
  let requirements: string[] = [];

  if (!pm) {
    reasons.push({ code: 'UNKNOWN_PAYMENT_METHOD', message: 'Medio de pago no configurado.' });
  } else {
    const st = checkStaticEligibility(promotion, {
      date: tx.date,
      paymentMethod: pm,
      fuelType: tx.fuelType,
      stationId: tx.stationId ?? null,
      profile: userState.profile,
      catalog: input.catalog,
    });
    reasons.push(...st.reasons);
    uncertainties.push(...st.uncertainties);
    requirements = st.requirements;
  }

  // Varias operaciones el mismo día
  const usedToday = userState.usage.some((e) => e.promotionId === promotion.id && e.date === tx.date && e.transactionId);
  if (usedToday) {
    if (r.multipleOperationsPerDay === 'NO') reasons.push({ code: 'ALREADY_USED_TODAY', message: 'Ya la usaste hoy y sólo permite una operación por día.' });
    else if (r.multipleOperationsPerDay === 'UNKNOWN' || r.unknownConditions.includes('MULTIPLE_OPERATIONS'))
      uncertainties.push({ code: 'MULTIPLE_OPERATIONS_UNKNOWN', message: 'Ya la usaste hoy y no puedo confirmar si permite otra operación el mismo día.' });
  }

  // Límites de cantidad de operaciones
  for (const limit of r.usageLimits) {
    const count = transactionsInPeriod(limit, promotion, tx.date, userState.usage);
    if (count >= limit.maxTransactions) {
      reasons.push({
        code: 'USAGE_LIMIT_REACHED',
        message: `Ya usaste ${count} de ${limit.maxTransactions} operación(es) permitidas (${CAP_PERIOD_LABELS[limit.period]}).`,
      });
    }
  }

  // Montos mínimos
  if (gross > 0 && r.minimumPurchase != null && base < r.minimumPurchase)
    reasons.push({ code: 'BELOW_MINIMUM', message: `Requiere una compra mínima de ${formatARS(r.minimumPurchase)}.` });
  if (gross > 0 && r.minimumLitres != null) {
    const l = litresOf(tx, gross);
    if (l == null) uncertainties.push({ code: 'LITRES_UNKNOWN', message: `Requiere cargar al menos ${r.minimumLitres} L y no conozco el precio por litro.` });
    else if (l + 1e-9 < r.minimumLitres) reasons.push({ code: 'BELOW_MIN_LITRES', message: `Requiere cargar al menos ${r.minimumLitres} litros.` });
  }

  // Topes
  const caps = capStatuses(promotion, tx.date, userState);
  const capUnknown = r.unknownConditions.includes('CAP');
  let remainingCap: Cents | null = caps.length > 0 ? Math.min(...caps.map((c) => c.remaining)) : null;
  if (capUnknown) remainingCap = null;
  const bindingBefore = caps.length > 0 ? caps.reduce((a, b) => (b.remaining < a.remaining ? b : a)) : null;
  if (remainingCap !== null && remainingCap <= 0 && bindingBefore) {
    reasons.push({ code: 'CAP_EXHAUSTED', message: `Tope ${CAP_PERIOD_LABELS[bindingBefore.cap.period]} agotado.` });
  }

  // Beneficio
  const raw = rawBenefit(promotion, base, tx);
  if (raw.uncertain) uncertainties.push(raw.uncertain);
  let benefit = raw.value;
  let capLimited = false;
  if (remainingCap !== null && benefit > remainingCap) {
    benefit = remainingCap;
    capLimited = true;
  }
  benefit = Math.max(0, Math.min(benefit, base));

  const eligibility: Eligibility = reasons.length > 0 ? 'INELIGIBLE' : uncertainties.length > 0 ? 'UNCERTAIN' : 'ELIGIBLE';
  if (eligibility === 'INELIGIBLE') benefit = 0;

  // Gasto que todavía genera beneficio
  let remainingEligibleSpend: Cents | null = null;
  if (r.discountType === 'PERCENTAGE' && remainingCap !== null && r.discountValue > 0) {
    remainingEligibleSpend = spendToReachBenefit(remainingCap, r.discountValue);
  }
  if (r.maximumPurchase != null) {
    remainingEligibleSpend = remainingEligibleSpend === null ? r.maximumPurchase : Math.min(remainingEligibleSpend, r.maximumPurchase);
  }
  if (eligibility === 'INELIGIBLE') remainingEligibleSpend = remainingEligibleSpend === null ? null : 0;

  const discountAmount = r.delivery === 'INSTANT_DISCOUNT' ? benefit : 0;
  const cashbackAmount = r.delivery === 'CASHBACK' ? benefit : 0;
  const bindingCap = capLimited && bindingBefore ? bindingBefore.cap : null;

  return {
    promotionId: promotion.id,
    promotionVersionId: promotion.versionId,
    eligibility,
    eligible: eligibility === 'ELIGIBLE',
    reason: reasons[0]?.message ?? uncertainties[0]?.message,
    reasons,
    uncertainties,
    requirements,
    grossAmount: gross,
    baseAmount: base,
    discountAmount,
    cashbackAmount,
    totalBenefit: benefit,
    netCost: gross - benefit,
    remainingCap,
    remainingEligibleSpend,
    remainingCapAfter: remainingCap === null ? null : Math.max(0, remainingCap - benefit),
    capLimited,
    bindingCap,
    caps,
    poolIds: poolIdsOf(promotion),
  };
}

/** Texto corto del beneficio: "30% de reintegro, tope mensual $15.000". */
export function describeBenefit(promotion: Promotion): string {
  const r = promotion.rule;
  let value: string;
  switch (r.discountType) {
    case 'PERCENTAGE':
      value = `${formatPercent(r.discountValue)} ${r.delivery === 'CASHBACK' ? 'de reintegro' : 'de descuento'}`;
      break;
    case 'FIXED_AMOUNT':
      value = `${formatARS(r.discountValue)} ${r.delivery === 'CASHBACK' ? 'de reintegro' : 'de descuento'}`;
      break;
    case 'PER_LITRE':
      value = `${formatARS(r.discountValue)} por litro`;
      break;
  }
  if (r.unknownConditions.includes('CAP') || r.unknownConditions.includes('CAP_PERIOD')) return `${value}, tope sin confirmar`;
  if (r.caps.length === 0) return `${value}, sin tope`;
  const caps = r.caps.map((c) => `tope ${CAP_PERIOD_LABELS[c.period]} ${formatARS(c.amount)}`).join(' y ');
  return `${value}, ${caps}`;
}

export function capNoun(cap: BenefitCap): string {
  return CAP_PERIOD_NOUN[cap.period];
}
