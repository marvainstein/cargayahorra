/**
 * Tipos y utilidades compartidos por el servidor (SQLite) y la app web estática
 * (datos publicados + almacenamiento local del dispositivo).
 */
import type { Cents } from '../core/money';
import type { Catalog } from '../core/rules/engine';
import { diffDays, type LocalDate } from '../core/time';
import type {
  CapUsageAdjustment,
  FuelTransaction,
  FuelType,
  PaymentMethod,
  PaymentProvider,
  Promotion,
  Station,
  UserProfile,
} from '../core/types';

export interface CatalogData {
  providers: PaymentProvider[];
  paymentMethods: PaymentMethod[];
  segments: Array<{ id: string; providerId: string | null; name: string; question: string | null; groupId: string | null }>;
  segmentGroups: Array<{ id: string; providerId: string | null; label: string; allowNone: boolean; noneLabel: string | null }>;
  programmes: Array<{ id: string; name: string; fuelBrandId: string | null }>;
  apps: Array<{ id: string; name: string }>;
  stations: Station[];
}

export type AppProfile = UserProfile & { defaultPricePerLitre: Cents | null };

export interface FuelPriceRow {
  stationId: string | null;
  brandId: string | null;
  region: string | null;
  fuelType: FuelType;
  price: Cents;
  effectiveFrom: LocalDate;
  source: string;
}

export interface ResolvedPrice {
  price: Cents;
  source: string;
  effectiveFrom: LocalDate;
  stale: boolean;
  ageDays: number;
}

export interface SourceHealth {
  id: string;
  name: string;
  kind?: string;
  lastAttemptAt?: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  configured: boolean;
}

/** Lo que necesitan los casos de uso, venga de SQLite o del dispositivo. */
export interface AppStore {
  now(): Date;
  profile(): AppProfile;
  catalog(): CatalogData;
  promotions(): Promotion[];
  transactions(range?: { from?: LocalDate; to?: LocalDate }): FuelTransaction[];
  adjustments(): CapUsageAdjustment[];
  fuelPrices(): FuelPriceRow[];
  sources(): SourceHealth[];
  insertTransaction(tx: Omit<FuelTransaction, 'id'> & { notes?: string | null }): string;
  fuelBrandId: string;
}

export const PRICE_STALE_DAYS = 30;

/** Nombres legibles para las explicaciones del motor. */
export function engineCatalog(c: CatalogData): Catalog {
  const byId = <T extends { id: string; name: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x.name]));
  const providers = byId(c.providers);
  const segments = byId(c.segments);
  const programmes = new Map([...byId(c.programmes), ...byId(c.apps)]);
  const methods = byId(c.paymentMethods);
  return {
    providerName: (id) => providers.get(id) ?? id,
    segmentName: (id) => segments.get(id) ?? id,
    programmeName: (id) => programmes.get(id) ?? id,
    paymentMethodName: (id) => methods.get(id) ?? id,
  };
}

/**
 * Precio a usar: el más reciente entre tu última carga y los precios publicados
 * para tu estación / marca y provincia. Siempre informa la fecha.
 */
export function resolvePriceFrom(
  transactions: FuelTransaction[],
  prices: FuelPriceRow[],
  today: LocalDate,
  opts: { fuelType: FuelType; brandId: string; region: string | null; stationId: string | null },
): ResolvedPrice | null {
  const candidates: Array<{ price: number; source: string; date: string }> = [];
  const lastTx = transactions
    .filter((t) => t.fuelType === opts.fuelType && t.pricePerLitre != null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
  if (lastTx) candidates.push({ price: lastTx.pricePerLitre!, source: 'Tu última carga', date: lastTx.date });
  const published = prices
    .filter(
      (p) =>
        p.fuelType === opts.fuelType &&
        (p.stationId === opts.stationId || (p.stationId === null && p.brandId === opts.brandId && (p.region === opts.region || p.region === null))),
    )
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
  if (published) candidates.push({ price: published.price, source: published.source, date: published.effectiveFrom });
  if (candidates.length === 0) return null;
  const best = candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
  const ageDays = diffDays(best.date, today);
  return { price: best.price, source: best.source, effectiveFrom: best.date, stale: ageDays > PRICE_STALE_DAYS, ageDays };
}
