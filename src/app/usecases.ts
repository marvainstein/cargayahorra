/**
 * Casos de uso de la app. Independientes de dónde viven los datos: el servidor
 * los usa sobre SQLite y la web estática sobre los datos publicados más el
 * almacenamiento local del dispositivo (ver AppStore).
 */
import { type Cents, formatARS } from '../core/money';
import { optimizePlan, planPeriod, recommend, type Recommendation } from '../core/optimizer/planner';
import { evaluateTransaction } from '../core/rules/combine';
import { checkStaticEligibility, describeBenefit } from '../core/rules/engine';
import { CAP_PERIOD_LABELS } from '../core/labels';
import { addDays, endOfMonth, formatLongDate, type LocalDate, startOfMonth, today } from '../core/time';
import { CONFIRMED_STATUSES, type FuelType, type Promotion, type UserState } from '../core/types';
import { transactionsInPeriod, usageFromHistory, usedBenefitForCap } from '../core/usage';
import { type AppStore, type CatalogData, engineCatalog, type ResolvedPrice, resolvePriceFrom, type SourceHealth } from './types';

export function loadState(store: AppStore) {
  const profile = store.profile();
  const usage = usageFromHistory(store.transactions(), store.adjustments());
  const catalogData = store.catalog();
  const state: UserState = { profile, usage };
  return { profile, state, catalogData, catalog: engineCatalog(catalogData), promotions: store.promotions() };
}

export interface DataFreshness {
  sources: SourceHealth[];
  confirmedPromotions: number;
  unconfirmedPromotions: number;
  stalePromotions: number;
  pendingReview: number;
  warning: string | null;
}

export function dataFreshness(store: AppStore, promotions: Promotion[]): DataFreshness {
  const sources = store.sources();
  const confirmed = promotions.filter((p) => CONFIRMED_STATUSES.includes(p.status) && !p.pendingReview).length;
  const stale = promotions.filter((p) => p.status === 'STALE').length;
  const pending = promotions.filter((p) => p.pendingReview).length;
  let warning: string | null = null;
  if (confirmed === 0)
    warning = 'Todavía no hay promociones verificadas.';
  else if (stale > 0) warning = `${stale} promoción(es) no se pudieron volver a verificar y no se usan como confirmadas.`;
  return { sources, confirmedPromotions: confirmed, unconfirmedPromotions: promotions.length - confirmed, stalePromotions: stale, pendingReview: pending, warning };
}

/** Preguntas de perfil que destrabarían promociones (segmentos desconocidos). */
export function pendingQuestions(promotions: Promotion[], segments: Record<string, string>, catalogData: CatalogData, stationId: string | null = null) {
  const ids = new Set<string>();
  let needsStation = false;
  for (const p of promotions) {
    if (p.status === 'INVALID') continue;
    for (const s of p.rule.eligibleCustomerSegments ?? []) if (!segments[s] || segments[s] === 'UNKNOWN') ids.add(s);
    if (p.rule.eligibleStationIds?.length && !stationId) needsStation = true;
  }
  const questions = catalogData.segments.filter((s) => ids.has(s.id)).map((s) => ({ segmentId: s.id, question: s.question ?? `¿Tenés ${s.name}?` }));
  // La estación va primero: sin ella, las promos que sólo valen en estaciones adheridas no se pueden confirmar.
  if (needsStation) questions.unshift({ segmentId: 'station', question: '¿En qué estación cargás? Algunas promociones valen sólo en estaciones adheridas.' });
  return questions;
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
  /** Promos que podés usar y cuánto tope te queda (para "Ya la usé"). */
  myPromotions: MyPromotion[];
}

export interface MyPromotion {
  promotionId: string;
  name: string;
  summary: string;
  confirmed: boolean;
  /** Topes con período (mes, semana…) y lo usado en el período actual. */
  caps: Array<{ label: string; amount: Cents; used: Cents; remaining: Cents }>;
  /** Operaciones usadas / permitidas por período, si hay límite. */
  uses: Array<{ label: string; used: number; max: number }>;
  /** Gasto que todavía genera beneficio en el período (null = sin tope). */
  remainingEligibleSpend: Cents | null;
}

/** Motivos que significan "esta promo no es para vos" (distinto de "hoy no aplica"). */
const NOT_FOR_YOU = new Set(['WRONG_FUEL', 'WRONG_SEGMENT', 'WRONG_PROVIDER', 'NOT_A_MEMBER', 'APP_MISSING', 'WRONG_CARD', 'WRONG_CARD_TYPE', 'WRONG_NETWORK', 'EXPIRED', 'NOT_STARTED', 'STATUS_INVALID', 'WRONG_STATION', 'EXCLUDED_REGION', 'WRONG_REGION']);

export function myPromotions(promotions: Promotion[], state: UserState, date: LocalDate, fuelType: FuelType, stationId: string | null, catalog: ReturnType<typeof engineCatalog>): MyPromotion[] {
  const out: MyPromotion[] = [];
  for (const p of promotions) {
    if (p.status === 'INVALID') continue;
    const checks = state.profile.paymentMethods.map((m) => checkStaticEligibility(p, { date, paymentMethod: m, fuelType, stationId, profile: state.profile, catalog }));
    const usable = checks.some((c) => !c.reasons.some((r) => NOT_FOR_YOU.has(r.code)));
    if (!usable) continue;
    const caps = p.rule.caps
      .filter((c) => c.period !== 'PER_TRANSACTION')
      .map((c) => {
        const used = usedBenefitForCap(c, p, date, state.usage);
        return { label: CAP_PERIOD_LABELS[c.period], amount: c.amount, used, remaining: Math.max(0, c.amount - used) };
      });
    const uses = p.rule.usageLimits
      .filter((u) => u.period !== 'PER_TRANSACTION')
      .map((u) => ({ label: CAP_PERIOD_LABELS[u.period], used: transactionsInPeriod(u, p, date, state.usage), max: u.maxTransactions }));
    const remainingCap = caps.length ? Math.min(...caps.map((c) => c.remaining)) : null;
    out.push({
      promotionId: p.id,
      name: p.name,
      summary: describeBenefit(p),
      confirmed: CONFIRMED_STATUSES.includes(p.status) && !p.pendingReview,
      caps,
      uses,
      remainingEligibleSpend:
        remainingCap !== null && p.rule.discountType === 'PERCENTAGE' && p.rule.discountValue > 0 ? Math.ceil((remainingCap * 10_000) / p.rule.discountValue) : null,
    });
  }
  return out.sort((a, b) => Number(b.confirmed) - Number(a.confirmed));
}

export function home(store: AppStore, input: RecommendInput): HomeResponse {
  const { profile, state, catalog, catalogData, promotions } = loadState(store);
  const date = input.date ?? today({ now: () => store.now() }, profile.timezone);
  const fuelType = input.fuelType ?? profile.defaultFuelType;
  const resolved = resolvePriceFrom(store.transactions(), store.fuelPrices(), date, {
    fuelType,
    brandId: store.fuelBrandId,
    region: profile.region,
    stationId: input.stationId ?? profile.defaultStationId,
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
    // Si hoy no hay beneficio confirmado, se sugiere el monto del mejor día de la próxima semana
    // (así la recomendación puede decir "si podés esperar…").
    let suggested: Cents | null = null;
    for (let i = 0; i <= 6 && !suggested; i++)
      suggested = suggestAmount(addDays(date, i), fuelType, pricePerLitre, promotions, state, catalog, profile.maxLoadAmount, input.stationId ?? profile.defaultStationId);
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
    freshness: dataFreshness(store, promotions),
    questions: pendingQuestions(promotions, profile.segments, catalogData, input.stationId ?? profile.defaultStationId),
    myPromotions: myPromotions(promotions, state, date, fuelType, input.stationId ?? profile.defaultStationId, catalog),
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

export function monthlyPlan(store: AppStore, input: { budget?: Cents | null; from?: LocalDate; to?: LocalDate; fuelType?: FuelType; maxLoads?: number | null; pricePerLitre?: Cents | null }) {
  const { profile, state, catalog, promotions } = loadState(store);
  const date = today({ now: () => store.now() }, profile.timezone);
  const from = input.from ?? date;
  const to = input.to ?? endOfMonth(from);
  const fuelType = input.fuelType ?? profile.defaultFuelType;
  const spentThisMonth = store.transactions({ from: startOfMonth(from), to: endOfMonth(from) }).reduce((s, t) => s + t.grossAmount, 0);
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
    resolvePriceFrom(store.transactions(), store.fuelPrices(), date, { fuelType, brandId: store.fuelBrandId, region: profile.region, stationId: profile.defaultStationId })?.price ??
    profile.defaultPricePerLitre ??
    null;
  const { plan, splitAlternative } = planPeriod({ from, to, budget, fuelType, pricePerLitre: price, promotions, userState: state, catalog, maxLoads: input.maxLoads ?? null, stationId: profile.defaultStationId });
  return { from, to, budget, spentThisMonth, note, plan, splitAlternative };
}

export interface RegisterInput {
  date?: LocalDate;
  /** Monto bruto (antes de descuentos). Si no se conoce, informar amountPaid. */
  amount?: Cents | null;
  /** Lo que se pagó en el surtidor; con descuentos en el momento se reconstruye el bruto. */
  amountPaid?: Cents | null;
  paymentMethodId: string;
  fuelType?: FuelType;
  litres?: number | null;
  pricePerLitre?: Cents | null;
  stationId?: string | null;
  /** Promociones que efectivamente se aplicaron (si no se indica, se calcula la mejor confirmada). */
  promotionIds?: string[];
  /**
   * Beneficio real recibido por promoción (según el ticket o el resumen). Manda sobre el
   * cálculo: los topes se descuentan con lo real y las diferencias quedan registradas.
   */
  actualBenefits?: Array<{ promotionId: string; amount: Cents }>;
  notes?: string | null;
}

export interface BenefitDiscrepancy {
  promotionId: string;
  name: string;
  expected: Cents;
  actual: Cents;
}

export function registerTransaction(store: AppStore, input: RegisterInput) {
  const { profile, state, catalog, promotions } = loadState(store);
  const date = input.date ?? today({ now: () => store.now() }, profile.timezone);
  const fuelType = input.fuelType ?? profile.defaultFuelType;
  if (!profile.paymentMethods.some((m) => m.id === input.paymentMethodId)) throw new Error('Ese medio de pago no está configurado en tu perfil.');
  const stationId = input.stationId ?? profile.defaultStationId;

  const pickPromotions = (gross: Cents): Promotion[] => {
    if (input.promotionIds) return promotions.filter((p) => input.promotionIds!.includes(p.id));
    const best = optimizePlan({ dates: [date], totalSpend: gross, fuelType, pricePerLitre: input.pricePerLitre ?? null, stationId, promotions, userState: state, catalog, allowSplit: false, singleLoad: true, onlyPaymentMethodIds: [input.paymentMethodId] });
    const ids = new Set(best.transactions.flatMap((t) => t.promotions.map((p) => p.id)));
    return promotions.filter((p) => ids.has(p.id));
  };

  let gross = input.amount ?? null;
  let derivedFromPaid = false;
  if (gross == null) {
    if (!input.amountPaid) throw new Error('Indicá el monto cargado o lo que pagaste.');
    gross = grossFromPaid(input.amountPaid, (g) => {
      const t = { date, grossAmount: g, fuelType, paymentMethodId: input.paymentMethodId, stationId, litres: input.litres ?? null, pricePerLitre: input.pricePerLitre ?? null };
      return evaluateTransaction(t, pickPromotions(g), state, catalog).amountCharged;
    });
    derivedFromPaid = true;
  }
  const pricePerLitre = input.pricePerLitre ?? (input.litres ? Math.round(gross / input.litres) : null);
  const litres = input.litres ?? (pricePerLitre ? Math.round((gross / pricePerLitre) * 100) / 100 : null);
  const tx = { date, grossAmount: gross, fuelType, paymentMethodId: input.paymentMethodId, stationId, litres, pricePerLitre };
  const applied = pickPromotions(gross);
  if (input.actualBenefits) {
    for (const ab of input.actualBenefits) {
      if (!applied.some((p) => p.id === ab.promotionId)) {
        const p = promotions.find((x) => x.id === ab.promotionId);
        if (!p) throw new Error(`Promoción desconocida: ${ab.promotionId}`);
        applied.push(p);
      }
    }
  }
  const ev = evaluateTransaction(tx, applied, state, catalog);
  const recommended = recommend({ date, amount: gross, fuelType, pricePerLitre, stationId: tx.stationId, promotions, userState: state, catalog, lookaheadDays: 0 });
  const discrepancies: BenefitDiscrepancy[] = [];
  const promotionsApplied = ev.results
    .map((r) => {
      const p = applied.find((x) => x.id === r.promotionId)!;
      const actual = input.actualBenefits?.find((a) => a.promotionId === r.promotionId)?.amount;
      // Lo calculado sólo cuenta si la promo era elegible; lo real (si se informa) manda siempre.
      const expected = r.eligibility === 'INELIGIBLE' ? 0 : r.totalBenefit;
      const benefit = actual ?? expected;
      if (actual !== undefined && Math.abs(actual - expected) >= 100)
        discrepancies.push({ promotionId: p.id, name: p.name, expected, actual });
      const instant = p.rule.delivery === 'INSTANT_DISCOUNT';
      return {
        promotionId: r.promotionId,
        promotionVersionId: r.promotionVersionId,
        discountAmount: instant ? benefit : 0,
        cashbackAmount: instant ? 0 : benefit,
        poolIds: r.poolIds,
        expectedBenefit: expected,
      };
    })
    .filter((a) => a.discountAmount + a.cashbackAmount > 0 || input.actualBenefits?.some((x) => x.promotionId === a.promotionId));
  const id = store.insertTransaction({
    date,
    stationId: tx.stationId,
    fuelType,
    litres,
    pricePerLitre,
    grossAmount: gross,
    paymentMethodId: input.paymentMethodId,
    promotionsApplied,
    discountAmount: promotionsApplied.reduce((s, a) => s + a.discountAmount, 0),
    cashbackAmount: promotionsApplied.reduce((s, a) => s + a.cashbackAmount, 0),
    recommendedBenefit: Math.max(recommended.recommended.totalBenefit, ev.totalBenefit),
    notes: input.notes ?? null,
  });
  const totalBenefit = promotionsApplied.reduce((s, a) => s + a.discountAmount + a.cashbackAmount, 0);
  return {
    id,
    grossAmount: gross,
    derivedFromPaid,
    evaluation: ev,
    totalBenefit,
    discrepancies,
    warnings: ev.eligibility !== 'ELIGIBLE' ? [...ev.reasons, ...ev.uncertainties].map((r) => r.message) : [],
  };
}

/**
 * Monto bruto tal que lo cobrado en el surtidor sea `paid` (búsqueda binaria: lo
 * cobrado crece con el bruto). Si hay varias soluciones, el menor bruto posible.
 */
export function grossFromPaid(paid: Cents, chargedFor: (gross: Cents) => Cents): Cents {
  let lo = paid;
  let hi = paid * 3;
  if (chargedFor(lo) >= paid) return lo;
  while (chargedFor(hi) < paid) hi *= 2;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (chargedFor(mid) >= paid) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function historySummary(store: AppStore, month?: string) {
  const { profile, catalogData, promotions } = loadState(store);
  const date = today({ now: () => store.now() }, profile.timezone);
  const ref = month ? `${month}-01` : date;
  const from = startOfMonth(ref);
  const to = endOfMonth(ref);
  const txs = store.transactions({ from, to });
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
