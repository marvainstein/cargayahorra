/**
 * Estado del usuario: cuánto de cada tope ya se consumió.
 *
 * Se deriva del historial de cargas (FuelTransaction) más ajustes manuales
 * (consumos fuera de la app, p. ej. un tope compartido con supermercados).
 */
import type { Cents } from './money';
import type { BenefitCap, CapPeriod, CapUsageAdjustment, FuelTransaction, Promotion, UsageEntry, UsageLimit } from './types';
import {
  endOfMonth,
  endOfWeek,
  type IsoWeekday,
  type LocalDate,
  startOfMonth,
  startOfWeek,
} from './time';

export interface DateRange {
  start: LocalDate;
  end: LocalDate;
}

const MIN_DATE = '0000-01-01';
const MAX_DATE = '9999-12-31';

/** Rango del período de un tope que contiene `date`. null para PER_TRANSACTION. */
export function periodRange(
  period: CapPeriod,
  date: LocalDate,
  promotion: Pick<Promotion, 'validFrom' | 'validUntil'>,
  weekStartsOn: IsoWeekday = 1,
): DateRange | null {
  switch (period) {
    case 'PER_TRANSACTION':
      return null;
    case 'DAILY':
      return { start: date, end: date };
    case 'WEEKLY':
      return { start: startOfWeek(date, weekStartsOn), end: endOfWeek(date, weekStartsOn) };
    case 'MONTHLY':
      return { start: startOfMonth(date), end: endOfMonth(date) };
    case 'ANNUAL':
      return { start: `${date.slice(0, 4)}-01-01`, end: `${date.slice(0, 4)}-12-31` };
    case 'LIFETIME':
      return { start: MIN_DATE, end: MAX_DATE };
    case 'PROMOTION_PERIOD':
      return { start: promotion.validFrom, end: promotion.validUntil ?? MAX_DATE };
  }
}

/** Clave estable del período (para agrupar topes en el optimizador). */
export function periodKey(
  period: CapPeriod,
  date: LocalDate,
  promotion: Pick<Promotion, 'validFrom' | 'validUntil'>,
  weekStartsOn: IsoWeekday = 1,
): string {
  const r = periodRange(period, date, promotion, weekStartsOn);
  return r ? `${period}:${r.start}` : `${period}:${date}`;
}

function inRange(d: LocalDate, r: DateRange): boolean {
  return d >= r.start && d <= r.end;
}

function entryMatchesCap(entry: UsageEntry, cap: BenefitCap, promotionId: string): boolean {
  if (cap.poolId) return entry.poolIds.includes(cap.poolId);
  return entry.promotionId === promotionId;
}

/** Beneficio ya consumido del tope `cap` en el período que contiene `date`. */
export function usedBenefitForCap(cap: BenefitCap, promotion: Promotion, date: LocalDate, usage: UsageEntry[]): Cents {
  const range = periodRange(cap.period, date, promotion, promotion.rule.weekStartsOn);
  if (!range) return 0;
  let used = 0;
  for (const e of usage) {
    if (inRange(e.date, range) && entryMatchesCap(e, cap, promotion.id)) used += e.benefit;
  }
  return used;
}

/** Cantidad de operaciones con esta promoción en el período del límite. */
export function transactionsInPeriod(limit: UsageLimit, promotion: Promotion, date: LocalDate, usage: UsageEntry[]): number {
  const range = periodRange(limit.period, date, promotion, promotion.rule.weekStartsOn);
  if (!range) return 0;
  const ids = new Set<string>();
  for (const e of usage) {
    if (e.promotionId === promotion.id && e.transactionId && inRange(e.date, range)) ids.add(e.transactionId);
  }
  return ids.size;
}

/** Construye el ledger de consumo a partir del historial y los ajustes manuales. */
export function usageFromHistory(transactions: FuelTransaction[], adjustments: CapUsageAdjustment[] = []): UsageEntry[] {
  const entries: UsageEntry[] = [];
  for (const tx of transactions) {
    for (const ap of tx.promotionsApplied) {
      entries.push({
        date: tx.date,
        promotionId: ap.promotionId,
        poolIds: ap.poolIds,
        benefit: ap.discountAmount + ap.cashbackAmount,
        transactionId: tx.id,
      });
    }
  }
  for (const adj of adjustments) {
    entries.push({
      date: adj.date,
      promotionId: adj.promotionId,
      poolIds: adj.poolId ? [adj.poolId] : [],
      benefit: adj.amount,
      transactionId: null,
    });
  }
  return entries;
}

export function poolIdsOf(promotion: Promotion): string[] {
  return [...new Set(promotion.rule.caps.map((c) => c.poolId).filter((p): p is string => !!p))];
}
