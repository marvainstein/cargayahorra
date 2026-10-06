/**
 * Casos de uso. Une base de datos, estado del usuario y motor de optimización.
 * La API y el CLI sólo llaman a estas funciones.
 */
import { type Cents, formatARS } from '../core/money';
import { optimizePlan, planPeriod, recommend, type Recommendation } from '../core/optimizer/planner';
import { evaluateTransaction } from '../core/rules/combine';
import { type Clock, endOfMonth, formatLongDate, type LocalDate, startOfMonth, today } from '../core/time';
import { CONFIRMED_STATUSES, type FuelType, type Promotion, type UserState } from '../core/types';
import { usageFromHistory } from '../core/usage';
import { all, type DB } from './db/db';
import { loadPromotions } from './db/promotions';
import {
  type CatalogData,
  DEFAULT_USER_ID,
  engineCatalog,
  getProfile,
  insertTransaction,
  listAdjustments,
  listTransactions,
  loadCatalog,
} from './db/user';
import { resolvePrice, type ResolvedPrice } from './jobs/fuel-prices';
import type { PromotionSource, SourceContext } from './sources/types';

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

export function loadState(ctx: AppContext, userId = DEFAULT_USER_ID) {
  const profile = getProfile(ctx.db, userId);
  const usage = usageFromHistory(listTransactions(ctx.db, {}, userId), listAdjustments(ctx.db, userId));
  const catalogData = loadCatalog(ctx.db);
  const state: UserState = { profile, usage };
  return { profile, state, catalogData, catalog: engineCatalog(catalogData), promotions: loadPromotions(ctx.db) };
}

export function localToday(ctx: AppContext, timezone: string): LocalDate {
  return today(ctx.clock, timezone);
}

export interface DataFreshness {
  sources: Array<{ id: string; name: string; lastSuccessAt: string | null; consecutiveFailures: number; lastError: string | null; configured: boolean }>;
  confirmedPromotions: number;
  unconfirmedPromotions: number;
  stalePromotions: number;
  pendingReview: number;
  warning: string | null;
}

export function dataFreshness(ctx: AppContext, promotions: Promotion[]): DataFreshness {
  const sources = all(ctx.db, 'SELECT * FROM source ORDER BY name').map((s) => ({
    id: s.id,
    name: s.name,
    lastSuccessAt: s.last_success_at ?? null,
    consecutiveFailures: Number(s.consecutive_failures),
    lastError: s.last_error ?? null,
    configured: ctx.sources.find((x) => x.id === s.id)?.isConfigured() ?? false,
  }));
  const confirmed = promotions.filter((p) => CONFIRMED_STATUSES.includes(p.status) && !p.pendingReview).length;
  const stale = promotions.filter((p) => p.status === 'STALE').length;
  const pending = promotions.filter((p) => p.pendingReview).length;
  let warning: string | null = null;
  if (confirmed === 0)
    warning = 'Todavía no hay promociones verificadas. Revisalas en Administración para obtener recomendaciones confirmadas.';
  else if (stale > 0) warning = `${stale} promoción(es) no se pudieron volver a verificar y no se usan como confirmadas.`;
  return { sources, confirmedPromotions: confirmed, unconfirmedPromotions: promotions.length - confirmed, stalePromotions: stale, pendingReview: pending, warning };
}

/** Preguntas de perfil que destrabarían promociones (segmentos desconocidos). */
export function pendingQuestions(promotions: Promotion[], segments: Record<string, string>, catalogData: CatalogData) {
  const ids = new Set<string>();
  for (const p of promotions) {
    if (p.status === 'INVALID') continue;
    for (const s of p.rule.eligibleCustomerSegments ?? []) if (!segments[s] || segments[s] === 'UNKNOWN') ids.add(s);
  }
  return catalogData.segments.filter((s) => ids.has(s.id)).map((s) => ({ segmentId: s.id, question: s.question ?? `¿Tenés ${s.name}?` }));
}

export interface RecommendInput {
  amount?: Cents | null;
  litres?: number | null;
  fuelType?: FuelType;
  pricePerLitre?: Cents | null;
  stationId?: string | null;
  date?: LocalDate;
}

export interface HomeResponse {
  today: LocalDate;
  todayLabel: string;
  fuelType: FuelType;
  price: ResolvedPrice | null;
  amount: Cents;
  amountSource: 'USER' | 'SUGGESTED' | 'NONE';
  recommendation: Recommendation | null;
  freshness: DataFreshness;
  questions: Array<{ segmentId: string; question: string }>;
}

export function home(ctx: AppContext, input: RecommendInput): HomeResponse {
  const { profile, state, catalog, catalogData, promotions } = loadState(ctx);
  const date = input.date ?? localToday(ctx, profile.timezone);
  const fuelType = input.fuelType ?? profile.defaultFuelType;
  const resolved = resolvePrice(ctx.db, date, {
    fuelType,
    brandId: ctx.config.fuelBrandId,
    region: profile.region,
    stationId: input.stationId ?? profile.defaultStationId,
    userId: profile.id,
  });
  const manualPrice = input.pricePerLitre ?? null;
  const price: ResolvedPrice | null = manualPrice
    ? { price: manualPrice, source: 'Ingresado por vos', effectiveFrom: date, stale: false, ageDays: 0 }
    : resolved ?? (profile.defaultPricePerLitre ? { price: profile.defaultPricePerLitre, source: 'Precio por defecto (Ajustes)', effectiveFrom: date, stale: false, ageDays: 0 } : null);
  const pricePerLitre = price?.price ?? null;

  let amount: Cents = 0;
  let amountSource: HomeResponse['amountSource'] = 'NONE';
  if (input.amount != null && input.amount > 0) {
    amount = input.amount;
    amountSource = 'USER';
  } else if (input.litres && pricePerLitre) {
    amount = Math.round(input.litres * pricePerLitre);
    amountSource = 'USER';
  } else {
    const suggested = suggestAmount(date, fuelType, pricePerLitre, promotions, state, catalog, profile.maxLoadAmount, input.stationId ?? profile.defaultStationId);
    if (suggested) {
      amount = suggested;
      amountSource = 'SUGGESTED';
    }
  }

  const recommendation =
    amount > 0
      ? recommend({ date, amount, fuelType, pricePerLitre, stationId: input.stationId ?? profile.defaultStationId, promotions, userState: state, catalog })
      : null;
  return {
    today: date,
    todayLabel: formatLongDate(date),
    fuelType,
    price,
    amount,
    amountSource,
    recommendation,
    freshness: dataFreshness(ctx, promotions),
    questions: pendingQuestions(promotions, profile.segments, catalogData),
  };
}

/**
 * Monto sugerido antes de que el usuario escriba nada: el que aprovecha por
 * completo el mejor beneficio confirmado de hoy (limitado por el tanque).
 */
function suggestAmount(
  date: LocalDate,
  fuelType: FuelType,
  pricePerLitre: Cents | null,
  promotions: Promotion[],
  state: UserState,
  catalog: ReturnType<typeof engineCatalog>,
  maxLoad: Cents | null,
  stationId: string | null,
): Cents | null {
  const probe = maxLoad ?? 100_000_000; // $1.000.000 como sondeo si no hay tanque configurado
  const plan = optimizePlan({ dates: [date], totalSpend: probe, fuelType, pricePerLitre, stationId, promotions, userState: state, catalog, allowSplit: false, singleLoad: true });
  const t = plan.transactions[0];
  if (!t || t.benefit === 0) return null;
  if (t.fullCapSpend && t.fullCapSpend > 0) return Math.min(Math.ceil(t.fullCapSpend / 100) * 100, probe);
  return maxLoad ?? null;
}

export function monthlyPlan(ctx: AppContext, input: { budget?: Cents | null; from?: LocalDate; to?: LocalDate; fuelType?: FuelType; maxLoads?: number | null; pricePerLitre?: Cents | null }) {
  const { profile, state, catalog, promotions } = loadState(ctx);
  const date = localToday(ctx, profile.timezone);
  const from = input.from ?? date;
  const to = input.to ?? endOfMonth(from);
  const fuelType = input.fuelType ?? profile.defaultFuelType;
  const spentThisMonth = listTransactions(ctx.db, { from: startOfMonth(from), to: endOfMonth(from) }).reduce((s, t) => s + t.grossAmount, 0);
  let budget = input.budget ?? null;
  let note: string | null = null;
  if (budget == null && profile.estimatedMonthlyFuelBudget) {
    budget = Math.max(0, profile.estimatedMonthlyFuelBudget - spentThisMonth);
    if (spentThisMonth > 0)
      note = `Presupuesto mensual ${formatARS(profile.estimatedMonthlyFuelBudget)} − ya cargado este mes ${formatARS(spentThisMonth)} = ${formatARS(budget)} por planificar.`;
  }
  if (!budget) return { from, to, budget: 0, spentThisMonth, note: 'Indicá cuánto pensás gastar.', plan: null, splitAlternative: null };
  const price =
    input.pricePerLitre ??
    resolvePrice(ctx.db, date, { fuelType, brandId: ctx.config.fuelBrandId, region: profile.region, stationId: profile.defaultStationId, userId: profile.id })?.price ??
    profile.defaultPricePerLitre ??
    null;
  const { plan, splitAlternative } = planPeriod({ from, to, budget, fuelType, pricePerLitre: price, promotions, userState: state, catalog, maxLoads: input.maxLoads ?? null, stationId: profile.defaultStationId });
  return { from, to, budget, spentThisMonth, note, plan, splitAlternative };
}

export interface RegisterInput {
  date?: LocalDate;
  amount: Cents;
  paymentMethodId: string;
  fuelType?: FuelType;
  litres?: number | null;
  pricePerLitre?: Cents | null;
  stationId?: string | null;
  /** Promociones que efectivamente se aplicaron (si no se indica, se calcula la mejor confirmada). */
  promotionIds?: string[];
  notes?: string | null;
}

export function registerTransaction(ctx: AppContext, input: RegisterInput) {
  const { profile, state, catalog, promotions } = loadState(ctx);
  const date = input.date ?? localToday(ctx, profile.timezone);
  const fuelType = input.fuelType ?? profile.defaultFuelType;
  if (!profile.paymentMethods.some((m) => m.id === input.paymentMethodId)) throw new Error('Ese medio de pago no está configurado en tu perfil.');
  const pricePerLitre = input.pricePerLitre ?? (input.litres ? Math.round(input.amount / input.litres) : null);
  const litres = input.litres ?? (pricePerLitre ? Math.round((input.amount / pricePerLitre) * 100) / 100 : null);
  const tx = { date, grossAmount: input.amount, fuelType, paymentMethodId: input.paymentMethodId, stationId: input.stationId ?? null, litres, pricePerLitre };

  let applied: Promotion[];
  if (input.promotionIds) {
    applied = promotions.filter((p) => input.promotionIds!.includes(p.id));
  } else {
    const best = optimizePlan({ dates: [date], totalSpend: input.amount, fuelType, pricePerLitre, stationId: tx.stationId, promotions, userState: state, catalog, allowSplit: false, singleLoad: true, onlyPaymentMethodIds: [input.paymentMethodId] });
    const ids = new Set(best.transactions.flatMap((t) => t.promotions.map((p) => p.id)));
    applied = promotions.filter((p) => ids.has(p.id));
  }
  const ev = evaluateTransaction(tx, applied, state, catalog);
  const recommended = recommend({ date, amount: input.amount, fuelType, pricePerLitre, stationId: tx.stationId, promotions, userState: state, catalog, lookaheadDays: 0 });
  const promotionsApplied = ev.results
    .filter((r) => r.totalBenefit > 0)
    .map((r) => ({ promotionId: r.promotionId, promotionVersionId: r.promotionVersionId, discountAmount: r.discountAmount, cashbackAmount: r.cashbackAmount, poolIds: r.poolIds }));
  const id = insertTransaction(ctx.db, ctx.clock.now().toISOString(), {
    date,
    stationId: tx.stationId,
    fuelType,
    litres,
    pricePerLitre,
    grossAmount: input.amount,
    paymentMethodId: input.paymentMethodId,
    promotionsApplied,
    discountAmount: promotionsApplied.reduce((s, a) => s + a.discountAmount, 0),
    cashbackAmount: promotionsApplied.reduce((s, a) => s + a.cashbackAmount, 0),
    recommendedBenefit: Math.max(recommended.recommended.totalBenefit, ev.totalBenefit),
    notes: input.notes ?? null,
  });
  return { id, evaluation: ev, warnings: ev.eligibility !== 'ELIGIBLE' ? [...ev.reasons, ...ev.uncertainties].map((r) => r.message) : [] };
}

export function historySummary(ctx: AppContext, month?: string) {
  const { profile, catalogData, promotions } = loadState(ctx);
  const date = localToday(ctx, profile.timezone);
  const ref = month ? `${month}-01` : date;
  const from = startOfMonth(ref);
  const to = endOfMonth(ref);
  const txs = listTransactions(ctx.db, { from, to });
  const methods = new Map(catalogData.paymentMethods.map((m) => [m.id, m.name]));
  const promoNames = new Map(promotions.map((p) => [p.id, p.name]));
  const saved = txs.reduce((s, t) => s + t.discountAmount + t.cashbackAmount, 0);
  const potential = txs.reduce((s, t) => s + Math.max(t.recommendedBenefit ?? 0, t.discountAmount + t.cashbackAmount), 0);
  return {
    month: from.slice(0, 7),
    from,
    to,
    gross: txs.reduce((s, t) => s + t.grossAmount, 0),
    saved,
    potential,
    message:
      potential > saved
        ? `Si hubieras seguido las recomendaciones, podrías haber ahorrado ${formatARS(potential)}.`
        : txs.length > 0
          ? 'Aprovechaste el mejor beneficio disponible en cada carga.'
          : null,
    transactions: txs.map((t) => ({
      ...t,
      paymentMethodName: methods.get(t.paymentMethodId) ?? t.paymentMethodId,
      promotions: t.promotionsApplied.map((a) => ({ ...a, name: promoNames.get(a.promotionId) ?? a.promotionId })),
      benefit: t.discountAmount + t.cashbackAmount,
    })),
  };
}
