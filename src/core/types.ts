/**
 * Modelo de dominio. Estos tipos son el contrato entre:
 *  A. datos de promociones (fuentes / base de datos),
 *  B. motor de reglas,
 *  C. estado del usuario,
 *  D. motor de optimización,
 *  E. frontend (que sólo recibe resultados ya calculados).
 *
 * Ningún tipo menciona bancos concretos: BBVA, Brubank o Axion ON son datos.
 */
import type { Cents } from './money';
import type { IsoWeekday, LocalDate } from './time';

export const FUEL_TYPES = ['SUPER', 'PREMIUM', 'DIESEL', 'DIESEL_PREMIUM'] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const CAP_PERIODS = [
  'PER_TRANSACTION',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'ANNUAL',
  'LIFETIME',
  /** Todo el período de vigencia de la promoción (p. ej. "máximo 4 compras en la promoción"). */
  'PROMOTION_PERIOD',
] as const;
export type CapPeriod = (typeof CAP_PERIODS)[number];

export const PROMOTION_STATUSES = [
  'VERIFIED',
  'AUTOMATICALLY_IMPORTED',
  'MANUALLY_REVIEWED',
  'STALE',
  'INVALID',
] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/** Estados con los que una promoción puede usarse para una recomendación definitiva. */
export const CONFIRMED_STATUSES: readonly PromotionStatus[] = ['VERIFIED', 'MANUALLY_REVIEWED'];

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export const DISCOUNT_TYPES = ['PERCENTAGE', 'FIXED_AMOUNT', 'PER_LITRE'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

/** Descuento en el momento vs. reintegro posterior. Ambos cuentan como ahorro. */
export type BenefitDelivery = 'INSTANT_DISCOUNT' | 'CASHBACK';

/**
 * Etapa en la que se aplica el beneficio dentro de una misma operación:
 *  - PRICE: rebaja el precio en la estación (programa de fidelidad, promo de la marca).
 *  - PAYMENT: lo otorga el medio de pago sobre el monto efectivamente cobrado.
 */
export type BenefitStage = 'PRICE' | 'PAYMENT';

/** Para condiciones que pueden no estar confirmadas. */
export type TriState = 'YES' | 'NO' | 'UNKNOWN';

export const PAYMENT_METHOD_TYPES = ['DEBIT_CARD', 'CREDIT_CARD', 'PREPAID_CARD', 'WALLET', 'CASH', 'OTHER'] as const;
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];

export type CardNetwork = 'VISA' | 'MASTERCARD' | 'AMEX' | 'CABAL' | 'OTHER';

/**
 * Condiciones que una fuente puede no aclarar. Si una condición relevante está
 * en `unknownConditions`, el motor NO asume nada y la promoción no se usa para
 * una recomendación definitiva.
 */
export const UNKNOWN_CONDITIONS = [
  'BENEFIT_VALUE',
  'CAP',
  'CAP_PERIOD',
  'STACKABILITY',
  'MULTIPLE_OPERATIONS',
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
] as const;
export type UnknownCondition = (typeof UNKNOWN_CONDITIONS)[number];

export interface BenefitCap {
  /** Beneficio máximo (descuento + reintegro) en el período. */
  amount: Cents;
  period: CapPeriod;
  /**
   * Topes con el mismo poolId comparten consumo entre promociones (p. ej. un tope
   * mensual común a supermercados y combustible). Sin poolId el tope es propio
   * de la promoción.
   */
  poolId?: string | null;
}

export interface UsageLimit {
  maxTransactions: number;
  period: CapPeriod;
}

export interface PromotionRule {
  discountType: DiscountType;
  /** PERCENTAGE: bps · FIXED_AMOUNT: centavos · PER_LITRE: centavos por litro. */
  discountValue: number;
  delivery: BenefitDelivery;
  stage: BenefitStage;
  /** Lista vacía + 'CAP' ausente de unknownConditions = sin tope (confirmado). */
  caps: BenefitCap[];
  minimumPurchase: Cents | null;
  /** Monto máximo de la operación que genera beneficio. */
  maximumPurchase: Cents | null;
  minimumLitres: number | null;
  usageLimits: UsageLimit[];
  /** null = todos los días. */
  daysOfWeek: IsoWeekday[] | null;
  daysOfMonth: number[] | null;

  // Elegibilidad (null = sin restricción confirmada)
  eligibleProviderIds: string[] | null;
  eligiblePaymentMethodIds: string[] | null;
  eligiblePaymentMethodTypes: PaymentMethodType[] | null;
  eligibleNetworks: CardNetwork[] | null;
  eligibleFuelTypes: FuelType[] | null;
  eligibleStationIds: string[] | null;
  eligibleRegions: string[] | null;
  excludedRegions: string[] | null;
  /** El usuario debe pertenecer a AL MENOS UNO de estos segmentos. */
  eligibleCustomerSegments: string[] | null;
  requiredLoyaltyProgrammeId: string | null;

  // Requisitos operativos (se muestran como instrucciones y se validan contra el perfil)
  requiresApp: string | null;
  requiresQR: boolean;
  requiresNFC: boolean;
  requiresSpecificCard: boolean;

  // Combinación
  stackable: TriState;
  /** Promociones (ids) con las que la fuente confirma que se puede combinar. */
  stackableWith: string[];
  /** ¿Se puede usar más de una vez el mismo día? */
  multipleOperationsPerDay: TriState;

  weekStartsOn: IsoWeekday;
  unknownConditions: UnknownCondition[];
  /** Instrucciones para el usuario ("Girá la ruedita en la app el mismo día"). */
  notes: string[];
  /** Extensión sin migraciones. El motor ignora claves que no conoce. */
  extra: Record<string, unknown>;
}

export interface Promotion {
  id: string;
  versionId: string;
  version: number;
  /** Quién otorga el beneficio: banco, billetera o programa (p. ej. 'bbva', 'brubank', 'axion-on'). */
  providerId: string;
  /** Marca de combustible donde aplica (p. ej. 'axion'). */
  fuelBrandId: string | null;
  name: string;
  description: string;
  status: PromotionStatus;
  validFrom: LocalDate;
  validUntil: LocalDate | null;
  sourceUrl: string | null;
  sourceName: string | null;
  retrievedAt: string | null; // ISO instant
  lastVerifiedAt: string | null; // ISO instant
  confidence: Confidence;
  /** Hay cambios en la fuente pendientes de revisión: no usar como definitiva. */
  pendingReview: boolean;
  rule: PromotionRule;
}

export interface PaymentProvider {
  id: string;
  name: string;
  kind: 'BANK' | 'WALLET' | 'LOYALTY' | 'FUEL_BRAND' | 'OTHER';
}

export interface PaymentMethod {
  id: string;
  providerId: string;
  name: string;
  type: PaymentMethodType;
  network: CardNetwork | null;
}

export interface Station {
  id: string;
  brandId: string;
  name: string;
  address: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  /** Datos publicados por la fuente (servicios, programas, combustibles). */
  attributes?: Record<string, unknown>;
}

export interface UserProfile {
  id: string;
  timezone: string;
  currency: string;
  locale: string;
  /** Medios de pago que el usuario tiene y quiere usar. */
  paymentMethods: PaymentMethod[];
  /** Segmentos declarados: 'YES' lo tiene, 'NO' no lo tiene, ausente/UNKNOWN no se sabe. */
  segments: Record<string, TriState>;
  loyaltyMemberships: string[];
  apps: string[];
  region: string | null;
  /** ¿La estación permite pagar una carga en varias operaciones/medios? */
  allowSplitPayment: TriState;
  /** Monto máximo por carga (tanque). */
  maxLoadAmount: Cents | null;
  estimatedMonthlyFuelBudget: Cents | null;
  defaultFuelType: FuelType;
  defaultStationId: string | null;
}

/** Consumo de beneficio ya realizado (derivado del historial o ajuste manual). */
export interface UsageEntry {
  date: LocalDate;
  promotionId: string | null;
  /** Pools de tope afectados (snapshot de la versión aplicada). */
  poolIds: string[];
  benefit: Cents;
  /** Para contar operaciones (límites de uso). null en ajustes manuales. */
  transactionId: string | null;
}

export interface UserState {
  profile: UserProfile;
  usage: UsageEntry[];
}

export interface AppliedPromotion {
  promotionId: string;
  promotionVersionId: string;
  discountAmount: Cents;
  cashbackAmount: Cents;
  poolIds: string[];
}

export interface FuelTransaction {
  id: string;
  date: LocalDate;
  stationId: string | null;
  fuelType: FuelType;
  litres: number | null;
  pricePerLitre: Cents | null;
  grossAmount: Cents;
  paymentMethodId: string;
  promotionsApplied: AppliedPromotion[];
  discountAmount: Cents;
  cashbackAmount: Cents;
  /** Ahorro que el optimizador estimaba posible ese día con ese monto. */
  recommendedBenefit: Cents | null;
}

export interface CapUsageAdjustment {
  id: string;
  date: LocalDate;
  promotionId: string | null;
  poolId: string | null;
  amount: Cents;
  note: string;
}

