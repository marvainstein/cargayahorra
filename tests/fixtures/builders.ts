/**
 * Fixtures de prueba. TODAS las promociones acá son FICTICIAS ("Banco A",
 * "Banco B", "Programa X"): sirven para probar el motor, no describen
 * promociones reales.
 */
import { pesos } from '../../src/core/money';
import type { PaymentMethod, Promotion, PromotionRule, UserProfile, UserState, UsageEntry } from '../../src/core/types';

export const BANCO_A_VISA: PaymentMethod = { id: 'banco-a-visa', providerId: 'banco-a', name: 'Banco A Visa', type: 'CREDIT_CARD', network: 'VISA' };
export const BANCO_B_DEBITO: PaymentMethod = { id: 'banco-b-debito', providerId: 'banco-b', name: 'Banco B Débito', type: 'DEBIT_CARD', network: 'VISA' };
export const BANCO_C_MASTER: PaymentMethod = { id: 'banco-c-master', providerId: 'banco-c', name: 'Banco C Master', type: 'CREDIT_CARD', network: 'MASTERCARD' };

export function rule(overrides: Partial<PromotionRule> = {}): PromotionRule {
  return {
    discountType: 'PERCENTAGE',
    discountValue: 3000,
    delivery: 'INSTANT_DISCOUNT',
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
    stackable: 'NO',
    stackableWith: [],
    multipleOperationsPerDay: 'NO',
    weekStartsOn: 1,
    unknownConditions: [],
    notes: [],
    extra: {},
    ...overrides,
  };
}

let counter = 0;
export function promo(overrides: Partial<Omit<Promotion, 'rule'>> & { rule?: Partial<PromotionRule> } = {}): Promotion {
  const id = overrides.id ?? `promo-${++counter}`;
  const { rule: r, ...rest } = overrides;
  return {
    id,
    versionId: `${id}-v1`,
    version: 1,
    providerId: 'banco-a',
    fuelBrandId: 'marca',
    name: id,
    description: '',
    status: 'VERIFIED',
    validFrom: '2026-10-01',
    validUntil: '2026-10-31',
    sourceUrl: null,
    sourceName: 'fixture',
    retrievedAt: null,
    lastVerifiedAt: null,
    confidence: 'HIGH',
    pendingReview: false,
    ...rest,
    rule: rule(r),
  };
}

/** Banco A: 30% con tope mensual $15.000 (ficticio). */
export function bancoA30(over: Partial<PromotionRule> = {}): Promotion {
  return promo({
    id: 'banco-a-30',
    name: 'Banco A 30%',
    providerId: 'banco-a',
    rule: { discountValue: 3000, caps: [{ amount: pesos(15_000), period: 'MONTHLY' }], eligibleProviderIds: ['banco-a'], ...over },
  });
}

/** Banco B: 25% con tope mensual $10.000 (ficticio). */
export function bancoB25(over: Partial<PromotionRule> = {}): Promotion {
  return promo({
    id: 'banco-b-25',
    name: 'Banco B 25%',
    providerId: 'banco-b',
    rule: { discountValue: 2500, caps: [{ amount: pesos(10_000), period: 'MONTHLY' }], eligibleProviderIds: ['banco-b'], ...over },
  });
}

export function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'u1',
    timezone: 'America/Argentina/Buenos_Aires',
    currency: 'ARS',
    locale: 'es-AR',
    paymentMethods: [BANCO_A_VISA, BANCO_B_DEBITO],
    segments: {},
    loyaltyMemberships: [],
    apps: [],
    region: 'CABA',
    allowSplitPayment: 'YES',
    maxLoadAmount: null,
    estimatedMonthlyFuelBudget: null,
    defaultFuelType: 'SUPER',
    defaultStationId: null,
    ...overrides,
  };
}

export function state(p: Partial<UserProfile> = {}, usage: UsageEntry[] = []): UserState {
  return { profile: profile(p), usage };
}

export function used(promotionId: string, date: string, amountPesos: number, txId = `tx-${date}-${promotionId}`, poolIds: string[] = []): UsageEntry {
  return { promotionId, date, benefit: pesos(amountPesos), transactionId: txId, poolIds };
}
