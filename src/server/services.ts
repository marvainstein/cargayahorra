/**
 * Adaptador del servidor: implementa AppStore sobre SQLite y expone los casos de
 * uso compartidos (src/app/usecases.ts) con la firma que usan la API y el CLI.
 */
import type { Clock, LocalDate } from '../core/time';
import { today } from '../core/time';
import type { FuelType } from '../core/types';
import * as uc from '../app/usecases';
import type { AppStore, FuelPriceRow, SourceHealth } from '../app/types';
import { all, type DB } from './db/db';
import { loadPromotions } from './db/promotions';
import { DEFAULT_USER_ID, getProfile, insertTransaction, listAdjustments, listTransactions, loadCatalog } from './db/user';
import type { PromotionSource, SourceContext } from './sources/types';

export type { HomeResponse, MyPromotion, RecommendInput, RegisterInput, BenefitDiscrepancy, DataFreshness } from '../app/usecases';
export { grossFromPaid, pendingQuestions, myPromotions } from '../app/usecases';

export interface Config {
  port: number;
  dbPath: string;
  appToken: string | null;
  staleAfterHours: number;
  fuelBrandId: string;
  enableScheduler: boolean;
}

export interface AppContext {
  db: DB;
  clock: Clock;
  config: Config;
  sources: PromotionSource[];
  sourceCtx: SourceContext;
}

export function sourceHealth(ctx: AppContext): SourceHealth[] {
  return all(ctx.db, 'SELECT * FROM source ORDER BY name').map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    lastAttemptAt: s.last_attempt_at ?? null,
    lastSuccessAt: s.last_success_at ?? null,
    consecutiveFailures: Number(s.consecutive_failures),
    lastError: s.last_error ?? null,
    configured: ctx.sources.find((x) => x.id === s.id)?.isConfigured() ?? s.kind === 'STRUCTURED_FEED',
  }));
}

export function fuelPriceRows(db: DB): FuelPriceRow[] {
  return all(db, 'SELECT * FROM fuel_price ORDER BY effective_from DESC, id DESC').map((r) => ({
    stationId: r.station_id ?? null,
    brandId: r.brand_id ?? null,
    region: r.region ?? null,
    fuelType: r.fuel_type,
    price: Number(r.price),
    effectiveFrom: r.effective_from,
    source: r.source,
  }));
}

export function dbStore(ctx: AppContext, userId = DEFAULT_USER_ID): AppStore {
  return {
    now: () => ctx.clock.now(),
    profile: () => getProfile(ctx.db, userId),
    catalog: () => loadCatalog(ctx.db),
    promotions: () => loadPromotions(ctx.db),
    transactions: (range) => listTransactions(ctx.db, range ?? {}, userId),
    adjustments: () => listAdjustments(ctx.db, userId),
    fuelPrices: () => fuelPriceRows(ctx.db),
    sources: () => sourceHealth(ctx),
    insertTransaction: (tx) => insertTransaction(ctx.db, ctx.clock.now().toISOString(), tx, userId),
    fuelBrandId: ctx.config.fuelBrandId,
  };
}

export function localToday(ctx: AppContext, timezone: string): LocalDate {
  return today(ctx.clock, timezone);
}

export const loadState = (ctx: AppContext) => uc.loadState(dbStore(ctx));
export const home = (ctx: AppContext, input: uc.RecommendInput) => uc.home(dbStore(ctx), input);
export const monthlyPlan = (ctx: AppContext, input: Parameters<typeof uc.monthlyPlan>[1]) => uc.monthlyPlan(dbStore(ctx), input);
export const registerTransaction = (ctx: AppContext, input: uc.RegisterInput) => uc.registerTransaction(dbStore(ctx), input);
export const historySummary = (ctx: AppContext, month?: string) => uc.historySummary(dbStore(ctx), month);
export const dataFreshness = (ctx: AppContext) => uc.dataFreshness(dbStore(ctx), loadPromotions(ctx.db));
export type { FuelType };
