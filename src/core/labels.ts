import type { CapPeriod, FuelType, PaymentMethodType, PromotionStatus, UnknownCondition } from './types';

export const FUEL_TYPE_LABELS: Record<FuelType, string> = {
  SUPER: 'Súper',
  PREMIUM: 'Premium',
  DIESEL: 'Diésel',
  DIESEL_PREMIUM: 'Diésel premium',
};

export const CAP_PERIOD_LABELS: Record<CapPeriod, string> = {
  PER_TRANSACTION: 'por operación',
  DAILY: 'diario',
  WEEKLY: 'semanal',
  MONTHLY: 'mensual',
  ANNUAL: 'anual',
  LIFETIME: 'total',
  PROMOTION_PERIOD: 'durante toda la promoción',
};

export const CAP_PERIOD_NOUN: Record<CapPeriod, string> = {
  PER_TRANSACTION: 'de la operación',
  DAILY: 'del día',
  WEEKLY: 'de la semana',
  MONTHLY: 'del mes',
  ANNUAL: 'del año',
  LIFETIME: 'total',
  PROMOTION_PERIOD: 'de la promoción',
};

export const PAYMENT_METHOD_TYPE_LABELS: Record<PaymentMethodType, string> = {
  DEBIT_CARD: 'tarjeta de débito',
  CREDIT_CARD: 'tarjeta de crédito',
  PREPAID_CARD: 'tarjeta prepaga',
  WALLET: 'billetera / QR',
  CASH: 'efectivo',
  OTHER: 'otro medio',
};

export const STATUS_LABELS: Record<PromotionStatus, string> = {
  VERIFIED: 'Verificada',
  AUTOMATICALLY_IMPORTED: 'Importada (sin revisar)',
  MANUALLY_REVIEWED: 'Revisada manualmente',
  STALE: 'Desactualizada',
  INVALID: 'Inválida',
};

export const UNKNOWN_CONDITION_LABELS: Record<UnknownCondition, string> = {
  BENEFIT_VALUE: 'el porcentaje o monto del beneficio',
  CAP: 'si tiene tope y de cuánto',
  CAP_PERIOD: 'cada cuánto se reinicia el tope',
  STACKABILITY: 'si es acumulable con otras promociones',
  MULTIPLE_OPERATIONS: 'si permite varias operaciones',
  PAYMENT_METHODS: 'con qué medios de pago aplica',
  FUEL_TYPES: 'a qué combustibles aplica',
  STATIONS: 'en qué estaciones aplica',
  REGIONS: 'en qué provincias aplica',
  SEGMENTS: 'a qué clientes/planes aplica',
  DAYS: 'qué días aplica',
  VALIDITY: 'la vigencia',
  MINIMUM_PURCHASE: 'si exige compra mínima',
  USAGE_LIMIT: 'cuántas veces se puede usar',
  DELIVERY: 'si es descuento en el momento o reintegro',
  OTHER: 'otras condiciones',
};
