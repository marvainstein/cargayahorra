/**
 * Validación de entradas de la API (sin dependencias). Todo lo que entra a la
 * base de datos pasa por acá.
 */
import { isLocalDate } from '../core/time';
import {
  CAP_PERIODS,
  DISCOUNT_TYPES,
  FUEL_TYPES,
  PAYMENT_METHOD_TYPES,
  PROMOTION_STATUSES,
  type PromotionRule,
  UNKNOWN_CONDITIONS,
} from '../core/types';
import type { PromotionDraft } from './db/promotions';

export class ValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join(' '));
  }
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const TRI = ['YES', 'NO', 'UNKNOWN'];

export function cents(v: unknown, field: string, errors: string[], opts: { nullable?: boolean; min?: number } = {}): number | null {
  if (v === null || v === undefined || v === '') {
    if (opts.nullable) return null;
    errors.push(`${field} es obligatorio.`);
    return null;
  }
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    errors.push(`${field} debe ser un entero en centavos.`);
    return null;
  }
  if (v < (opts.min ?? 0)) errors.push(`${field} no puede ser negativo.`);
  return v;
}

function enumOf<T extends string>(v: unknown, values: readonly T[], field: string, errors: string[]): T {
  if (typeof v !== 'string' || !values.includes(v as T)) errors.push(`${field} inválido (${String(v)}).`);
  return v as T;
}

function list<T extends string>(v: unknown, field: string, errors: string[], values?: readonly T[]): T[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) {
    errors.push(`${field} debe ser una lista.`);
    return null;
  }
  const out = v.map(String) as T[];
  if (values) for (const x of out) if (!values.includes(x)) errors.push(`${field}: valor inválido ${x}.`);
  return out.length ? out : null;
}

export function parseRule(v: unknown, errors: string[]): PromotionRule {
  if (!isObj(v)) {
    errors.push('rule es obligatorio.');
    return {} as PromotionRule;
  }
  const discountType = enumOf(v.discountType, DISCOUNT_TYPES, 'discountType', errors);
  const discountValue = cents(v.discountValue, 'discountValue', errors) ?? 0;
  if (discountType === 'PERCENTAGE' && (discountValue <= 0 || discountValue > 10_000)) errors.push('El porcentaje (en bps) debe estar entre 1 y 10000.');
  const caps = Array.isArray(v.caps)
    ? v.caps.map((c, i) => {
        const o = isObj(c) ? c : {};
        return {
          amount: cents(o.amount, `caps[${i}].amount`, errors) ?? 0,
          period: enumOf(o.period, CAP_PERIODS, `caps[${i}].period`, errors),
          poolId: typeof o.poolId === 'string' && o.poolId ? o.poolId : null,
        };
      })
    : [];
  const usageLimits = Array.isArray(v.usageLimits)
    ? v.usageLimits.map((u, i) => {
        const o = isObj(u) ? u : {};
        const n = Number(o.maxTransactions);
        if (!Number.isInteger(n) || n < 1) errors.push(`usageLimits[${i}].maxTransactions inválido.`);
        return { maxTransactions: n, period: enumOf(o.period, CAP_PERIODS, `usageLimits[${i}].period`, errors) };
      })
    : [];
  const days = list(v.daysOfWeek, 'daysOfWeek', errors)?.map(Number) ?? null;
  if (days?.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) errors.push('daysOfWeek debe tener valores 1 (lunes) a 7 (domingo).');
  const dom = list(v.daysOfMonth, 'daysOfMonth', errors)?.map(Number) ?? null;
  const minLitres = v.minimumLitres == null || v.minimumLitres === '' ? null : Number(v.minimumLitres);
  if (minLitres !== null && !(minLitres > 0)) errors.push('minimumLitres inválido.');
  const week = v.weekStartsOn == null ? 1 : Number(v.weekStartsOn);
  return {
    discountType,
    discountValue,
    delivery: enumOf(v.delivery, ['INSTANT_DISCOUNT', 'CASHBACK'] as const, 'delivery', errors),
    stage: enumOf(v.stage, ['PRICE', 'PAYMENT'] as const, 'stage', errors),
    caps,
    minimumPurchase: cents(v.minimumPurchase, 'minimumPurchase', errors, { nullable: true }),
    maximumPurchase: cents(v.maximumPurchase, 'maximumPurchase', errors, { nullable: true }),
    minimumLitres: minLitres,
    usageLimits,
    daysOfWeek: days as PromotionRule['daysOfWeek'],
    daysOfMonth: dom,
    eligibleProviderIds: list(v.eligibleProviderIds, 'eligibleProviderIds', errors),
    eligiblePaymentMethodIds: list(v.eligiblePaymentMethodIds, 'eligiblePaymentMethodIds', errors),
    eligiblePaymentMethodTypes: list(v.eligiblePaymentMethodTypes, 'eligiblePaymentMethodTypes', errors, PAYMENT_METHOD_TYPES),
    eligibleNetworks: list(v.eligibleNetworks, 'eligibleNetworks', errors, ['VISA', 'MASTERCARD', 'AMEX', 'CABAL', 'OTHER'] as const),
    eligibleFuelTypes: list(v.eligibleFuelTypes, 'eligibleFuelTypes', errors, FUEL_TYPES),
    eligibleStationIds: list(v.eligibleStationIds, 'eligibleStationIds', errors),
    eligibleRegions: list(v.eligibleRegions, 'eligibleRegions', errors),
    excludedRegions: list(v.excludedRegions, 'excludedRegions', errors),
    eligibleCustomerSegments: list(v.eligibleCustomerSegments, 'eligibleCustomerSegments', errors),
    requiredLoyaltyProgrammeId: typeof v.requiredLoyaltyProgrammeId === 'string' && v.requiredLoyaltyProgrammeId ? v.requiredLoyaltyProgrammeId : null,
    requiresApp: typeof v.requiresApp === 'string' && v.requiresApp ? v.requiresApp : null,
    requiresQR: !!v.requiresQR,
    requiresNFC: !!v.requiresNFC,
    requiresSpecificCard: !!v.requiresSpecificCard,
    stackable: enumOf(v.stackable ?? 'UNKNOWN', TRI, 'stackable', errors) as PromotionRule['stackable'],
    stackableWith: list(v.stackableWith, 'stackableWith', errors) ?? [],
    multipleOperationsPerDay: enumOf(v.multipleOperationsPerDay ?? 'UNKNOWN', TRI, 'multipleOperationsPerDay', errors) as PromotionRule['multipleOperationsPerDay'],
    weekStartsOn: (Number.isInteger(week) && week >= 1 && week <= 7 ? week : 1) as PromotionRule['weekStartsOn'],
    unknownConditions: list(v.unknownConditions, 'unknownConditions', errors, UNKNOWN_CONDITIONS) ?? [],
    notes: (list(v.notes, 'notes', errors) ?? []).filter(Boolean),
    extra: isObj(v.extra) ? v.extra : {},
  };
}

export function parseDraft(v: unknown, opts: { now: string }): PromotionDraft {
  const errors: string[] = [];
  if (!isObj(v)) throw new ValidationError(['Cuerpo inválido.']);
  const str = (x: unknown, field: string, required = true) => {
    if (typeof x === 'string' && x.trim()) return x.trim();
    if (required) errors.push(`${field} es obligatorio.`);
    return null;
  };
  const validFrom = str(v.validFrom, 'validFrom');
  if (validFrom && !isLocalDate(validFrom)) errors.push('validFrom debe ser YYYY-MM-DD.');
  const validUntil = str(v.validUntil, 'validUntil', false);
  if (validUntil && !isLocalDate(validUntil)) errors.push('validUntil debe ser YYYY-MM-DD.');
  if (validFrom && validUntil && validUntil < validFrom) errors.push('validUntil es anterior a validFrom.');
  const status = enumOf(v.status ?? 'MANUALLY_REVIEWED', PROMOTION_STATUSES, 'status', errors);
  const rule = parseRule(v.rule, errors);
  const sourceUrl = str(v.sourceUrl, 'sourceUrl', false);
  if (sourceUrl && !/^https?:\/\//.test(sourceUrl)) errors.push('sourceUrl debe ser una URL http(s).');
  if ((status === 'VERIFIED' || status === 'MANUALLY_REVIEWED') && rule.unknownConditions?.length)
    errors.push('Una promoción con condiciones desconocidas no puede marcarse como verificada: resolvé las condiciones o dejala como importada.');
  if (errors.length) throw new ValidationError(errors);
  const verified = status === 'VERIFIED' || status === 'MANUALLY_REVIEWED';
  return {
    providerId: str(v.providerId, 'providerId')!,
    fuelBrandId: str(v.fuelBrandId, 'fuelBrandId', false),
    name: str(v.name, 'name')!,
    description: typeof v.description === 'string' ? v.description : '',
    status,
    confidence: enumOf(v.confidence ?? 'HIGH', ['HIGH', 'MEDIUM', 'LOW'] as const, 'confidence', errors),
    validFrom: validFrom!,
    validUntil,
    sourceUrl,
    sourceName: str(v.sourceName, 'sourceName', false),
    retrievedAt: typeof v.retrievedAt === 'string' ? v.retrievedAt : null,
    lastVerifiedAt: verified ? opts.now : null,
    rule,
  };
}
