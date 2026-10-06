/**
 * Motor de optimización.
 *
 * Un único modelo resuelve los tres casos:
 *  - una carga hoy (un solo día),
 *  - "¿me conviene esperar?" (una carga en cada día candidato),
 *  - plan mensual (varios días, topes semanales/mensuales compartidos).
 *
 * Formulación (programación lineal entera mixta):
 *
 *   Para cada operación candidata T = (día d, medio de pago m, conjunto S de
 *   promociones combinables entre sí y elegibles ese día con ese medio):
 *     x_T      ≥ 0   gasto bruto de la operación
 *     e_{T,p}  ≥ 0   gasto que genera beneficio para p ∈ S
 *   Beneficio de p = tasa_p · e_{T,p}  (FIXED_AMOUNT usa una binaria)
 *
 *   max Σ beneficio
 *   s.a.  e_{T,p} ≤ x_T                         (etapa PRICE)
 *         e_{T,p} ≤ x_T − Σ_{q∈S,PRICE} r_q e_{T,q}  (etapa PAYMENT: sobre lo cobrado)
 *         e_{T,p} ≤ compra máxima
 *         Σ beneficio en el período ≤ tope restante   (por tope / pool / período)
 *         Σ x_T + resto = gasto total
 *         límites de operaciones, compra mínima, una operación por día si no se
 *         puede dividir el pago, cantidad máxima de cargas → binarias.
 *
 * El solver sólo elige la asignación. Los montos finales se recalculan
 * simulando cada operación con el motor de reglas, en centavos enteros.
 */
import { ceilToPeso, type Cents, formatARS, formatPercent } from '../money';
import { addDays, formatLongDate, type LocalDate } from '../time';
import type { CapPeriod, FuelType, PaymentMethod, Promotion, UserState } from '../types';
import { checkStaticEligibility, type Catalog, describeBenefit, idCatalog, type Reason } from '../rules/engine';
import { canCombinePromotions, evaluateTransaction, type TransactionEvaluation } from '../rules/combine';
import { periodKey, transactionsInPeriod, usedBenefitForCap } from '../usage';
import { CAP_PERIOD_LABELS } from '../labels';
import { type Constraint, solveMILP } from './lp';

/** Unidad del modelo: $1.000 (100.000 centavos), para mantener números bien condicionados. */
const UNIT = 100_000;

export type PlanMode = 'CONFIRMED' | 'INCLUDE_UNCERTAIN';

export interface PlanRequest {
  dates: LocalDate[];
  totalSpend: Cents;
  fuelType: FuelType;
  pricePerLitre: Cents | null;
  stationId?: string | null;
  promotions: Promotion[];
  userState: UserState;
  catalog?: Catalog;
  mode?: PlanMode;
  /** Varias operaciones (distintos medios/promos) el mismo día. */
  allowSplit: boolean;
  /** Tope de gasto por día (tanque). null = sin límite. */
  maxPerDay?: Cents | null;
  maxLoads?: number | null;
  /** Una sola carga: el resto sin beneficio se suma a la operación del día. */
  singleLoad?: boolean;
  /** Restringir a ciertos medios de pago (para alternativas). */
  onlyPaymentMethodIds?: string[];
}

export interface PlannedPromotion {
  id: string;
  versionId: string;
  name: string;
  providerId: string;
  summary: string;
  discountAmount: Cents;
  cashbackAmount: Cents;
  benefit: Cents;
  capLimited: boolean;
  /** Esta operación agota el tope disponible. */
  capReached: boolean;
  remainingCapBefore: Cents | null;
  remainingEligibleSpend: Cents | null;
}

export interface PlannedTransaction {
  date: LocalDate;
  paymentMethodId: string;
  paymentMethodName: string;
  promotions: PlannedPromotion[];
  amount: Cents;
  litres: number | null;
  discountAmount: Cents;
  cashbackAmount: Cents;
  benefit: Cents;
  amountCharged: Cents;
  netCost: Cents;
  effectivePricePerLitre: Cents | null;
  /** Monto con el que se aprovecha todo el tope disponible (si hay tope). */
  fullCapSpend: Cents | null;
  explanation: string[];
  requirements: string[];
  evaluation: TransactionEvaluation;
}

export interface Plan {
  mode: PlanMode;
  dates: LocalDate[];
  requestedSpend: Cents;
  transactions: PlannedTransaction[];
  /** Gasto sin beneficio (en plan multi-día no tiene fecha asignada). */
  unpromotedSpend: Cents;
  grossSpend: Cents;
  totalBenefit: Cents;
  totalDiscount: Cents;
  totalCashback: Cents;
  netSpend: Cents;
  explanation: string[];
  warnings: string[];
  feasible: boolean;
  provenOptimal: boolean;
}

interface Candidate {
  index: number;
  date: LocalDate;
  dayIndex: number;
  method: PaymentMethod;
  promos: Promotion[];
}

interface PromoUse {
  candidate: Candidate;
  promo: Promotion;
  /** índice de la variable e (o binaria y para FIXED_AMOUNT). */
  varIndex: number;
  /** beneficio por unidad de e (o por unidad de y en FIXED). */
  rate: number;
  fixed: boolean;
}

function isUsable(eligibility: string, mode: PlanMode): boolean {
  return eligibility === 'ELIGIBLE' || (mode === 'INCLUDE_UNCERTAIN' && eligibility === 'UNCERTAIN');
}

/** Elegibilidad independiente del monto, incluyendo estado (usos del día, límites). */
function dayEligibility(p: Promotion, date: LocalDate, method: PaymentMethod, req: PlanRequest): { eligibility: string; reasons: Reason[]; uncertainties: Reason[] } {
  const st = checkStaticEligibility(p, {
    date,
    paymentMethod: method,
    fuelType: req.fuelType,
    stationId: req.stationId ?? null,
    profile: req.userState.profile,
    catalog: req.catalog,
  });
  const reasons = [...st.reasons];
  const uncertainties = [...st.uncertainties];
  const usage = req.userState.usage;
  const usedToday = usage.some((e) => e.promotionId === p.id && e.date === date && e.transactionId);
  if (usedToday) {
    if (p.rule.multipleOperationsPerDay === 'NO') reasons.push({ code: 'ALREADY_USED_TODAY', message: 'Ya la usaste hoy.' });
    else if (p.rule.multipleOperationsPerDay !== 'YES')
      uncertainties.push({ code: 'MULTIPLE_OPERATIONS_UNKNOWN', message: 'Ya la usaste hoy y no sé si permite otra operación.' });
  }
  for (const l of p.rule.usageLimits) {
    if (transactionsInPeriod(l, p, date, usage) >= l.maxTransactions)
      reasons.push({ code: 'USAGE_LIMIT_REACHED', message: `Ya usaste las ${l.maxTransactions} operación(es) permitidas (${CAP_PERIOD_LABELS[l.period]}).` });
  }
  if (!p.rule.unknownConditions.includes('CAP')) {
    for (const cap of p.rule.caps) {
      if (cap.period === 'PER_TRANSACTION') continue;
      if (usedBenefitForCap(cap, p, date, usage) >= cap.amount)
        reasons.push({ code: 'CAP_EXHAUSTED', message: `Tope ${CAP_PERIOD_LABELS[cap.period]} agotado.` });
    }
  }
  if (p.rule.discountType === 'PER_LITRE' && !req.pricePerLitre)
    uncertainties.push({ code: 'PRICE_UNKNOWN', message: 'Beneficio por litro: falta el precio del combustible.' });
  const eligibility = reasons.length ? 'INELIGIBLE' : uncertainties.length ? 'UNCERTAIN' : 'ELIGIBLE';
  return { eligibility, reasons, uncertainties };
}

/** Conjuntos maximales de promociones combinables entre sí (hasta 4). */
function maximalCombinableSets(promos: Promotion[]): Promotion[][] {
  // Sólo combinaciones CONFIRMADAS: nunca se asume que dos promociones son acumulables.
  const ok = (a: Promotion, b: Promotion) => canCombinePromotions(a, b).allowed === 'YES';
  const sets: Promotion[][] = [];
  const n = Math.min(promos.length, 12);
  const extend = (start: number, current: Promotion[]) => {
    let extended = false;
    for (let i = start; i < n; i++) {
      if (current.length < 4 && current.every((c) => ok(c, promos[i]))) {
        extended = true;
        extend(i + 1, [...current, promos[i]]);
      }
    }
    if (!extended && current.length > 0) sets.push(current);
  };
  extend(0, []);
  // quitar subconjuntos de otros conjuntos
  return sets.filter((s, i) => !sets.some((t, j) => j !== i && t.length > s.length && s.every((x) => t.includes(x))));
}

function priceRate(p: Promotion): number {
  // fracción del bruto que una promo PRICE descuenta en el momento (sólo % instantáneos)
  if (p.rule.stage !== 'PRICE' || p.rule.delivery !== 'INSTANT_DISCOUNT' || p.rule.discountType !== 'PERCENTAGE') return 0;
  return p.rule.discountValue / 10_000;
}

function benefitRate(p: Promotion, pricePerLitre: Cents | null): number {
  switch (p.rule.discountType) {
    case 'PERCENTAGE':
      return p.rule.discountValue / 10_000;
    case 'PER_LITRE':
      return pricePerLitre ? p.rule.discountValue / pricePerLitre : 0;
    case 'FIXED_AMOUNT':
      return p.rule.discountValue / UNIT; // por unidad de la binaria
  }
}

export function optimizePlan(req: PlanRequest): Plan {
  const mode: PlanMode = req.mode ?? 'CONFIRMED';
  const catalog = req.catalog ?? idCatalog;
  const total = req.totalSpend;
  const warnings: string[] = [];
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('totalSpend inválido');

  const methods = req.userState.profile.paymentMethods.filter((m) => !req.onlyPaymentMethodIds || req.onlyPaymentMethodIds.includes(m.id));
  const maxPerDay = req.maxPerDay ?? null;

  // 1) Operaciones candidatas
  const candidates: Candidate[] = [];
  if (total > 0) {
    req.dates.forEach((date, dayIndex) => {
      for (const method of methods) {
        const usable = req.promotions.filter((p) => isUsable(dayEligibility(p, date, method, req).eligibility, mode));
        if (usable.length === 0) continue;
        for (const set of maximalCombinableSets(usable)) {
          candidates.push({ index: candidates.length, date, dayIndex, method, promos: set });
        }
      }
    });
  }

  // 2-7) Modelo con restricciones enteras "perezosas": las binarias (compra mínima,
  // límites de operaciones, una operación por día, no dividir el pago, máximo de
  // cargas) se agregan sólo donde la solución las viola, y se vuelve a resolver.
  // La solución final cumple todas las restricciones y es óptima para un problema
  // relajado del original, por lo tanto óptima para el original.
  const bigM = Math.max(Math.min(total, maxPerDay ?? total), 1) / UNIT;
  const active = { minPurchase: new Set<string>(), usageLimit: new Set<string>(), onePerDay: new Set<string>(), noSplitDays: new Set<string>(), maxLoads: false };
  let model = buildModel(candidates, req, active, bigM, maxPerDay, total);
  let res = solveMILP(model.lp);
  let provenOptimal = res.provenOptimal;
  for (let iter = 0; iter < 12 && res.status === 'OPTIMAL'; iter++) {
    const added = findViolations(model, res.x, candidates, req, active);
    if (!added) break;
    model = buildModel(candidates, req, active, bigM, maxPerDay, total);
    res = solveMILP(model.lp);
    provenOptimal = provenOptimal && res.provenOptimal;
  }
  if (res.status !== 'OPTIMAL') {
    warnings.push('No se encontró una asignación factible con las restricciones indicadas.');
    return emptyPlan(req, mode, warnings);
  }
  if (res.status === 'OPTIMAL' && findViolations(model, res.x, candidates, req, active)) {
    // No convergió: se activan todas las restricciones enteras (nunca se devuelve un plan que las viole).
    for (const u of model.uses) if (u.promo.rule.minimumPurchase) active.minPurchase.add(useKey(u));
    for (const u of model.uses) {
      if (u.promo.rule.usageLimits.length) active.usageLimit.add(u.promo.id);
      active.onePerDay.add(`${u.promo.id}|${u.candidate.date}`);
    }
    for (const c of candidates) active.noSplitDays.add(c.date);
    active.maxLoads = true;
    model = buildModel(candidates, req, active, bigM, maxPerDay, total);
    res = solveMILP(model.lp);
    provenOptimal = provenOptimal && res.provenOptimal;
  }
  const { xVar, uses } = model;
  if (!provenOptimal) warnings.push('El cálculo se cortó por tiempo: la estrategia es buena pero podría no ser la óptima.');

  // 8) Reconstruir operaciones y recalcular con el motor (centavos exactos)
  const chosen: Array<{ c: Candidate; amount: Cents }> = [];
  for (const c of candidates) {
    const x = res.x[xVar.get(c.index)!];
    const usedPromos = c.promos.filter((p) => {
      const u = uses.find((uu) => uu.candidate === c && uu.promo === p)!;
      return res.x[u.varIndex] > 1e-7;
    });
    if (x * UNIT < 50 || usedPromos.length === 0) continue;
    chosen.push({ c: { ...c, promos: usedPromos }, amount: ceilToPeso(Math.round(x * UNIT)) });
  }
  chosen.sort((a, b) => (a.c.date < b.c.date ? -1 : a.c.date > b.c.date ? 1 : b.amount - a.amount));

  let assigned = chosen.reduce((s, t) => s + t.amount, 0);
  if (assigned > total) {
    // el redondeo a pesos enteros no puede superar el gasto pedido
    let excess = assigned - total;
    for (let i = chosen.length - 1; i >= 0 && excess > 0; i--) {
      const take = Math.min(excess, chosen[i].amount);
      chosen[i].amount -= take;
      excess -= take;
    }
    assigned = total;
  }
  let unpromoted = total - assigned;
  if (req.singleLoad && unpromoted > 0 && chosen.length > 0) {
    chosen[0].amount += unpromoted;
    unpromoted = 0;
  }

  const transactions = simulate(chosen.filter((t) => t.amount > 0), req, catalog);
  const totalDiscount = transactions.reduce((s, t) => s + t.discountAmount, 0);
  const totalCashback = transactions.reduce((s, t) => s + t.cashbackAmount, 0);
  const totalBenefit = totalDiscount + totalCashback;
  const plan: Plan = {
    mode,
    dates: req.dates,
    requestedSpend: total,
    transactions,
    unpromotedSpend: unpromoted,
    grossSpend: total,
    totalBenefit,
    totalDiscount,
    totalCashback,
    netSpend: total - totalBenefit,
    explanation: [],
    warnings,
    feasible: true,
    provenOptimal,
  };
  plan.explanation = explainPlan(plan, req);
  return plan;
}

interface Model {
  lp: { numVars: number; objective: number[]; constraints: Constraint[]; binaries: number[] };
  xVar: Map<number, number>;
  uses: PromoUse[];
}

interface ActiveSets {
  minPurchase: Set<string>;
  usageLimit: Set<string>;
  onePerDay: Set<string>;
  noSplitDays: Set<string>;
  maxLoads: boolean;
}

const useKey = (u: PromoUse) => `${u.candidate.index}|${u.promo.id}`;

function buildModel(candidates: Candidate[], req: PlanRequest, active: ActiveSets, U: number, maxPerDay: Cents | null, total: Cents): Model {
  let nv = 0;
  const objective: number[] = [];
  const binaries: number[] = [];
  const newVar = (obj = 0, binary = false) => {
    objective.push(obj);
    if (binary) binaries.push(nv);
    return nv++;
  };
  const constraints: Constraint[] = [];
  const xVar = new Map<number, number>();
  const uses: PromoUse[] = [];

  const byDay = new Map<string, Candidate[]>();
  for (const c of candidates) byDay.set(c.date, [...(byDay.get(c.date) ?? []), c]);

  for (const c of candidates) {
    // leve preferencia por días más cercanos (desempate determinístico)
    const x = newVar(-1e-7 * (c.dayIndex + 1));
    xVar.set(c.index, x);
    if (maxPerDay !== null && byDay.get(c.date)!.length === 1) constraints.push({ terms: [[x, 1]], op: '<=', rhs: maxPerDay / UNIT });
    const priceUses: PromoUse[] = [];
    const ordered = [...c.promos].sort((a, b) => (a.rule.stage === b.rule.stage ? 0 : a.rule.stage === 'PRICE' ? -1 : 1));
    for (const p of ordered) {
      const fixed = p.rule.discountType === 'FIXED_AMOUNT';
      const rate = benefitRate(p, req.pricePerLitre);
      const v = newVar(rate, fixed);
      const use: PromoUse = { candidate: c, promo: p, varIndex: v, rate, fixed };
      uses.push(use);
      if (fixed) {
        const minP = Math.max(p.rule.minimumPurchase ?? 0, 100) / UNIT;
        constraints.push({ terms: [[x, 1], [v, -minP]], op: '>=', rhs: 0, label: 'fixed-min' });
      } else {
        // e ≤ x  (PRICE)   |   e ≤ x − Σ r_q e_q  (PAYMENT)
        const terms: Array<[number, number]> = [[v, 1], [x, -1]];
        if (p.rule.stage === 'PAYMENT') for (const pu of priceUses) if (!pu.fixed) terms.push([pu.varIndex, priceRate(pu.promo)]);
        constraints.push({ terms, op: '<=', rhs: 0, label: 'base' });
        if (p.rule.maximumPurchase != null) constraints.push({ terms: [[v, 1]], op: '<=', rhs: p.rule.maximumPurchase / UNIT });
        if (p.rule.minimumPurchase != null && p.rule.minimumPurchase > 0 && active.minPurchase.has(useKey(use))) {
          // semi-continua: o no se usa, o la operación alcanza la compra mínima
          const z = newVar(-1e-6, true);
          constraints.push({ terms: [[v, 1], [z, -U]], op: '<=', rhs: 0 });
          constraints.push({ terms: [[x, 1], [z, -p.rule.minimumPurchase / UNIT]], op: '>=', rhs: 0 });
        }
      }
      if (p.rule.stage === 'PRICE') priceUses.push(use);
    }
  }
  const rest = newVar(0);

  // Gasto total
  constraints.push({ terms: [...[...xVar.values()].map((x) => [x, 1] as [number, number]), [rest, 1]], op: '=', rhs: total / UNIT, label: 'budget' });

  // Topes (por promoción o pool, por período)
  const benefitTerm = (u: PromoUse): [number, number] => [u.varIndex, u.fixed ? u.promo.rule.discountValue / UNIT : u.rate];
  const capGroups = new Map<string, { remaining: number; terms: Array<[number, number]> }>();
  for (const u of uses) {
    const p = u.promo;
    if (p.rule.unknownConditions.includes('CAP')) continue; // sólo en modo INCLUDE_UNCERTAIN llega acá
    for (const cap of p.rule.caps) {
      if (cap.period === 'PER_TRANSACTION') {
        constraints.push({ terms: [benefitTerm(u)], op: '<=', rhs: cap.amount / UNIT, label: 'cap-tx' });
        continue;
      }
      const owner = cap.poolId ? `pool:${cap.poolId}` : `promo:${p.id}`;
      const key = `${owner}|${periodKey(cap.period, u.candidate.date, p, p.rule.weekStartsOn)}`;
      const used = usedBenefitForCap(cap, p, u.candidate.date, req.userState.usage);
      const remaining = Math.max(0, cap.amount - used);
      const g = capGroups.get(key);
      if (!g) capGroups.set(key, { remaining, terms: [benefitTerm(u)] });
      else {
        g.remaining = Math.min(g.remaining, remaining);
        g.terms.push(benefitTerm(u));
      }
    }
  }
  for (const g of capGroups.values()) constraints.push({ terms: g.terms, op: '<=', rhs: g.remaining / UNIT, label: 'cap' });

  // Indicadores de uso (límites de operaciones / una por día)
  const useIndicator = new Map<PromoUse, number>();
  const indicatorFor = (u: PromoUse): number => {
    let z = useIndicator.get(u);
    if (z !== undefined) return z;
    if (u.fixed) z = u.varIndex;
    else {
      z = newVar(-1e-6, true);
      constraints.push({ terms: [[u.varIndex, 1], [z, -U]], op: '<=', rhs: 0 });
    }
    useIndicator.set(u, z);
    return z;
  };
  for (const [promoId, list] of usesByPromo(uses)) {
    const p = list[0].promo;
    if (active.usageLimit.has(promoId)) {
      for (const limit of p.rule.usageLimits) {
        for (const g of groupUsesByPeriod(list, limit.period, p).values()) {
          const already = limit.period === 'PER_TRANSACTION' ? 0 : transactionsInPeriod(limit, p, g[0].candidate.date, req.userState.usage);
          const left = Math.max(0, limit.maxTransactions - already);
          constraints.push({ terms: g.map((u) => [indicatorFor(u), 1] as [number, number]), op: '<=', rhs: left, label: 'usage-limit' });
        }
      }
    }
    // misma promoción en varias operaciones el mismo día
    if (p.rule.multipleOperationsPerDay !== 'YES') {
      const days = new Map<string, PromoUse[]>();
      for (const u of list) days.set(u.candidate.date, [...(days.get(u.candidate.date) ?? []), u]);
      for (const [date, g] of days) {
        if (g.length > 1 && active.onePerDay.has(`${promoId}|${date}`))
          constraints.push({ terms: g.map((u) => [indicatorFor(u), 1] as [number, number]), op: '<=', rhs: 1, label: 'one-per-day' });
      }
    }
  }

  // Tanque por día, una operación por día si no se puede dividir el pago, máximo de cargas
  for (const [date, list] of byDay) {
    if (maxPerDay !== null && list.length > 1)
      constraints.push({ terms: list.map((c) => [xVar.get(c.index)!, 1] as [number, number]), op: '<=', rhs: maxPerDay / UNIT, label: 'tank' });
    if (!req.allowSplit && list.length > 1 && active.noSplitDays.has(date)) {
      const ws = list.map((c) => {
        const w = newVar(-1e-6, true);
        constraints.push({ terms: [[xVar.get(c.index)!, 1], [w, -U]], op: '<=', rhs: 0 });
        return w;
      });
      constraints.push({ terms: ws.map((w) => [w, 1] as [number, number]), op: '<=', rhs: 1, label: 'no-split' });
    }
  }
  if (req.maxLoads != null && active.maxLoads) {
    const terms: Array<[number, number]> = [];
    for (const list of byDay.values()) {
      const l = newVar(-1e-6, true);
      for (const c of list) constraints.push({ terms: [[xVar.get(c.index)!, 1], [l, -U]], op: '<=', rhs: 0 });
      terms.push([l, 1]);
    }
    if (terms.length) constraints.push({ terms, op: '<=', rhs: req.maxLoads, label: 'max-loads' });
  }

  return { lp: { numVars: nv, objective, constraints, binaries }, xVar, uses };
}

function usesByPromo(uses: PromoUse[]): Map<string, PromoUse[]> {
  const m = new Map<string, PromoUse[]>();
  for (const u of uses) m.set(u.promo.id, [...(m.get(u.promo.id) ?? []), u]);
  return m;
}

function groupUsesByPeriod(list: PromoUse[], period: CapPeriod, p: Promotion): Map<string, PromoUse[]> {
  const groups = new Map<string, PromoUse[]>();
  for (const u of list) {
    const k = period === 'PER_TRANSACTION' ? `tx:${u.candidate.index}` : periodKey(period, u.candidate.date, p, p.rule.weekStartsOn);
    groups.set(k, [...(groups.get(k) ?? []), u]);
  }
  return groups;
}

/** Activa las restricciones enteras que la solución viola. Devuelve true si agregó alguna. */
function findViolations(model: Model, x: number[], candidates: Candidate[], req: PlanRequest, active: ActiveSets): boolean {
  const EPS = 1e-7;
  let added = false;
  const used = (u: PromoUse) => x[u.varIndex] > EPS;
  const spend = (c: Candidate) => x[model.xVar.get(c.index)!];
  for (const u of model.uses) {
    const min = u.promo.rule.minimumPurchase;
    if (!u.fixed && min && used(u) && spend(u.candidate) * UNIT < min - 1 && !active.minPurchase.has(useKey(u))) {
      active.minPurchase.add(useKey(u));
      added = true;
    }
  }
  for (const [promoId, list] of usesByPromo(model.uses)) {
    const p = list[0].promo;
    if (!active.usageLimit.has(promoId)) {
      for (const limit of p.rule.usageLimits) {
        for (const g of groupUsesByPeriod(list, limit.period, p).values()) {
          const already = limit.period === 'PER_TRANSACTION' ? 0 : transactionsInPeriod(limit, p, g[0].candidate.date, req.userState.usage);
          if (g.filter(used).length > limit.maxTransactions - already && !active.usageLimit.has(promoId)) {
            active.usageLimit.add(promoId);
            added = true;
          }
        }
      }
    }
    if (p.rule.multipleOperationsPerDay !== 'YES') {
      const counts = new Map<string, number>();
      for (const u of list) if (used(u)) counts.set(u.candidate.date, (counts.get(u.candidate.date) ?? 0) + 1);
      for (const [date, n] of counts) {
        const key = `${promoId}|${date}`;
        if (n > 1 && !active.onePerDay.has(key)) {
          active.onePerDay.add(key);
          added = true;
        }
      }
    }
  }
  const daysUsed = new Map<string, number>();
  for (const c of candidates) if (spend(c) > EPS) daysUsed.set(c.date, (daysUsed.get(c.date) ?? 0) + 1);
  if (!req.allowSplit) {
    for (const [date, n] of daysUsed) {
      if (n > 1 && !active.noSplitDays.has(date)) {
        active.noSplitDays.add(date);
        added = true;
      }
    }
  }
  if (req.maxLoads != null && !active.maxLoads && daysUsed.size > req.maxLoads) {
    active.maxLoads = true;
    added = true;
  }
  return added;
}

function emptyPlan(req: PlanRequest, mode: PlanMode, warnings: string[]): Plan {
  return {
    mode,
    dates: req.dates,
    requestedSpend: req.totalSpend,
    transactions: [],
    unpromotedSpend: req.totalSpend,
    grossSpend: req.totalSpend,
    totalBenefit: 0,
    totalDiscount: 0,
    totalCashback: 0,
    netSpend: req.totalSpend,
    explanation: [],
    warnings,
    feasible: false,
    provenOptimal: false,
  };
}

/** Ejecuta las operaciones en orden, acumulando consumo de topes, con el motor de reglas. */
function simulate(chosen: Array<{ c: Candidate; amount: Cents }>, req: PlanRequest, catalog: Catalog): PlannedTransaction[] {
  const usage = [...req.userState.usage];
  const out: PlannedTransaction[] = [];
  chosen.forEach((t, i) => {
    const state = { profile: req.userState.profile, usage };
    const tx = {
      date: t.c.date,
      grossAmount: t.amount,
      fuelType: req.fuelType,
      paymentMethodId: t.c.method.id,
      stationId: req.stationId ?? null,
      pricePerLitre: req.pricePerLitre,
    };
    const ev = evaluateTransaction(tx, t.c.promos, state, catalog);
    const litres = req.pricePerLitre ? t.amount / req.pricePerLitre : null;
    const promotions: PlannedPromotion[] = ev.results.map((r) => {
      const p = t.c.promos.find((pp) => pp.id === r.promotionId)!;
      return {
        id: p.id,
        versionId: p.versionId,
        name: p.name,
        providerId: p.providerId,
        summary: describeBenefit(p),
        discountAmount: r.discountAmount,
        cashbackAmount: r.cashbackAmount,
        benefit: r.totalBenefit,
        capLimited: r.capLimited,
        capReached: r.remainingCap !== null && r.totalBenefit > 0 && r.totalBenefit >= r.remainingCap,
        remainingCapBefore: r.remainingCap,
        remainingEligibleSpend: r.remainingEligibleSpend,
      };
    });
    const fullCapSpend = fullCapSpendOf(ev);
    const planned: PlannedTransaction = {
      date: t.c.date,
      paymentMethodId: t.c.method.id,
      paymentMethodName: t.c.method.name,
      promotions,
      amount: t.amount,
      litres,
      discountAmount: ev.discountAmount,
      cashbackAmount: ev.cashbackAmount,
      benefit: ev.totalBenefit,
      amountCharged: ev.amountCharged,
      netCost: ev.netCost,
      effectivePricePerLitre: litres ? Math.round(ev.netCost / litres) : null,
      fullCapSpend,
      explanation: [],
      requirements: [...new Set(ev.results.flatMap((r) => r.requirements))],
      evaluation: ev,
    };
    planned.explanation = explainTransaction(planned, t.c.promos);
    out.push(planned);
    for (const r of ev.results) {
      if (r.totalBenefit > 0)
        usage.push({ date: t.c.date, promotionId: r.promotionId, poolIds: r.poolIds, benefit: r.totalBenefit, transactionId: `plan-${i}` });
    }
  });
  return out;
}

function fullCapSpendOf(ev: TransactionEvaluation): Cents | null {
  const spends = ev.results.map((r) => r.remainingEligibleSpend).filter((v): v is number => v !== null);
  if (spends.length === 0) return null;
  return Math.max(...spends);
}

function benefitWord(p: Promotion): string {
  return p.rule.delivery === 'CASHBACK' ? 'reintegro' : 'descuento';
}

function explainTransaction(t: PlannedTransaction, promos: Promotion[]): string[] {
  const lines: string[] = [];
  for (const pp of t.promotions) {
    const p = promos.find((x) => x.id === pp.id)!;
    const r = p.rule;
    const val = r.discountType === 'PERCENTAGE' ? formatPercent(r.discountValue) : formatARS(r.discountValue);
    const who = `«${p.name}»`;
    if (r.discountType === 'PERCENTAGE' && pp.remainingCapBefore !== null && pp.remainingEligibleSpend !== null) {
      if (pp.capReached) {
        lines.push(
          `${who} te da ${val} de ${benefitWord(p)} con un tope restante de ${formatARS(pp.remainingCapBefore)}. Para usarlo completo necesitás cargar ${formatARS(pp.remainingEligibleSpend)}${r.stage === 'PAYMENT' && t.discountAmount > 0 && pp.discountAmount === 0 ? ' (sobre lo que pagás con la tarjeta)' : ''}.`,
        );
      } else {
        const left = pp.remainingCapBefore - pp.benefit;
        lines.push(
          `${who} te da ${val} de ${benefitWord(p)}: con ${formatARS(t.amount)} ahorrás ${formatARS(pp.benefit)} y te quedan ${formatARS(left)} de tope (aprovechable cargando hasta ${formatARS(pp.remainingEligibleSpend)}).`,
        );
      }
    } else if (r.discountType === 'PERCENTAGE') {
      lines.push(`${who} te da ${val} de ${benefitWord(p)} sin tope confirmado: ahorrás ${formatARS(pp.benefit)}.`);
    } else if (r.discountType === 'FIXED_AMOUNT') {
      lines.push(`${who} te da ${val} de ${benefitWord(p)}${r.minimumPurchase ? ` con una compra mínima de ${formatARS(r.minimumPurchase)}` : ''}.`);
    } else {
      lines.push(`${who} te da ${val} por litro: ahorrás ${formatARS(pp.benefit)}.`);
    }
    if (r.delivery === 'CASHBACK') lines.push(`El reintegro de «${p.name}» no se ve en el surtidor: llega después (según las condiciones de la promoción).`);
  }
  return lines;
}

function explainPlan(plan: Plan, req: PlanRequest): string[] {
  const lines: string[] = [];
  const txs = plan.transactions;
  if (txs.length === 0) {
    lines.push('Ninguna promoción confirmada aplica con estas condiciones.');
    return lines;
  }
  if (txs.length > 1) {
    const sorted = [...txs].sort((a, b) => marginalRate(b) - marginalRate(a));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev.date === cur.date && prev.promotions.some((p) => p.capReached)) {
        lines.push(
          `${prev.paymentMethodName} alcanza su tope con ${formatARS(prev.amount)}; el resto conviene con ${cur.paymentMethodName} porque su beneficio marginal (${formatPercent(Math.round(marginalRate(cur) * 10_000))}) es el mayor entre lo que queda disponible.`,
        );
      }
    }
  }
  if (req.allowSplit && new Set(txs.map((t) => t.date)).size < txs.length)
    lines.push('Dividir la carga en varias operaciones es posible porque indicaste que tu estación lo permite y ninguna promoción lo prohíbe.');
  if (plan.unpromotedSpend > 0)
    lines.push(`${formatARS(plan.unpromotedSpend)} no tienen beneficio disponible con tus topes y promociones actuales.`);
  return lines;
}

function marginalRate(t: PlannedTransaction): number {
  return t.amount > 0 ? t.benefit / t.amount : 0;
}

// ───────────────────────── API de alto nivel ─────────────────────────

export interface IneligibleOption {
  promotionId: string;
  name: string;
  providerId: string;
  summary: string;
  reasons: string[];
}

export interface TentativeOption {
  promotionId: string;
  name: string;
  providerId: string;
  summary: string;
  paymentMethodName: string | null;
  estimatedBenefit: Cents;
  uncertainties: string[];
  sourceUrl: string | null;
}

export interface WaitOption {
  date: LocalDate;
  label: string;
  bestBenefit: Cents;
  plan: Plan;
}

export interface Recommendation {
  date: LocalDate;
  requiredSpend: Cents;
  fuelType: FuelType;
  pricePerLitre: Cents | null;
  litres: number | null;
  recommended: Plan;
  /** Estrategia con división del pago, si es mejor y la división no está confirmada. */
  splitAlternative: Plan | null;
  splitStatus: 'ALLOWED' | 'NOT_ALLOWED' | 'UNKNOWN';
  /** Mejor opción usando un solo medio de pago, por medio. */
  alternatives: Plan[];
  ineligible: IneligibleOption[];
  tentative: TentativeOption[];
  wait: { options: WaitOption[]; best: WaitOption | null; extraBenefit: Cents; message: string | null };
}

export interface RecommendRequest {
  date: LocalDate;
  amount: Cents;
  fuelType: FuelType;
  pricePerLitre: Cents | null;
  stationId?: string | null;
  promotions: Promotion[];
  userState: UserState;
  catalog?: Catalog;
  /** Días hacia adelante a comparar para "¿me conviene esperar?". */
  lookaheadDays?: number;
}

function singleDay(req: RecommendRequest, date: LocalDate, allowSplit: boolean, extra: Partial<PlanRequest> = {}): Plan {
  return optimizePlan({
    dates: [date],
    totalSpend: req.amount,
    fuelType: req.fuelType,
    pricePerLitre: req.pricePerLitre,
    stationId: req.stationId,
    promotions: req.promotions,
    userState: req.userState,
    catalog: req.catalog,
    allowSplit,
    singleLoad: true,
    ...extra,
  });
}

/** "Necesito cargar combustible. ¿Qué hago?" */
export function recommend(req: RecommendRequest): Recommendation {
  const catalog = req.catalog ?? idCatalog;
  const profile = req.userState.profile;
  const splitStatus = profile.allowSplitPayment === 'YES' ? 'ALLOWED' : profile.allowSplitPayment === 'NO' ? 'NOT_ALLOWED' : 'UNKNOWN';

  const recommended = singleDay(req, req.date, splitStatus === 'ALLOWED');
  let splitAlternative: Plan | null = null;
  if (splitStatus === 'UNKNOWN') {
    const s = singleDay(req, req.date, true);
    if (s.totalBenefit > recommended.totalBenefit) splitAlternative = s;
  }

  // Alternativas: mejor opción con cada medio de pago por separado
  const alternatives: Plan[] = [];
  const recMethods = new Set(recommended.transactions.map((t) => t.paymentMethodId));
  for (const m of profile.paymentMethods) {
    const p = singleDay(req, req.date, false, { onlyPaymentMethodIds: [m.id] });
    if (p.transactions.length === 0) continue;
    if (recMethods.size === 1 && recMethods.has(m.id) && p.totalBenefit === recommended.totalBenefit) continue;
    alternatives.push(p);
  }
  alternatives.sort((a, b) => b.totalBenefit - a.totalBenefit);

  // Promociones que no aplican hoy (con motivo) y posibles sin confirmar
  const ineligible: IneligibleOption[] = [];
  const tentative: TentativeOption[] = [];
  for (const p of req.promotions) {
    let best: { eligibility: string; reasons: Reason[]; uncertainties: Reason[]; method: PaymentMethod } | null = null;
    for (const m of profile.paymentMethods) {
      const e = { ...dayEligibility(p, req.date, m, { ...baseReq(req) }), method: m };
      const rank = (x: string) => (x === 'ELIGIBLE' ? 3 : x === 'UNCERTAIN' ? 2 : 1);
      // el medio de pago "más cercano" a aplicar: mejor estado y, a igual estado, menos motivos
      if (!best || rank(e.eligibility) > rank(best.eligibility) || (rank(e.eligibility) === rank(best.eligibility) && e.reasons.length < best.reasons.length))
        best = e;
    }
    if (!best) continue;
    if (best.eligibility === 'INELIGIBLE') {
      ineligible.push({ promotionId: p.id, name: p.name, providerId: p.providerId, summary: describeBenefit(p), reasons: [...new Set(best.reasons.map((r) => r.message))] });
    } else if (best.eligibility === 'UNCERTAIN') {
      const est = optimizePlan({ ...baseReq(req), dates: [req.date], promotions: [p], mode: 'INCLUDE_UNCERTAIN', allowSplit: false, singleLoad: true, onlyPaymentMethodIds: [best.method.id] });
      tentative.push({
        promotionId: p.id,
        name: p.name,
        providerId: p.providerId,
        summary: describeBenefit(p),
        paymentMethodName: best.method.name,
        estimatedBenefit: est.totalBenefit,
        uncertainties: [...new Set(best.uncertainties.map((u) => u.message))],
        sourceUrl: p.sourceUrl,
      });
    }
  }
  tentative.sort((a, b) => b.estimatedBenefit - a.estimatedBenefit);

  // ¿Me conviene esperar?
  const lookahead = req.lookaheadDays ?? 6;
  const options: WaitOption[] = [];
  for (let i = 1; i <= lookahead; i++) {
    const d = addDays(req.date, i);
    const plan = singleDay(req, d, splitStatus === 'ALLOWED');
    options.push({ date: d, label: formatLongDate(d), bestBenefit: plan.totalBenefit, plan });
  }
  const best = options.reduce<WaitOption | null>((acc, o) => (!acc || o.bestBenefit > acc.bestBenefit ? o : acc), null);
  const extra = best ? best.bestBenefit - recommended.totalBenefit : 0;
  const threshold = Math.max(50_000, Math.round(req.amount * 0.01)); // $500 o 1% del monto
  let message: string | null = null;
  let bestWorth: WaitOption | null = null;
  if (best && extra >= threshold) {
    bestWorth = best;
    message = `Si no necesitás cargar hoy, te conviene esperar al ${best.label}. Podrías ahorrar aproximadamente ${formatARS(extra)} adicionales.`;
  }

  return {
    date: req.date,
    requiredSpend: req.amount,
    fuelType: req.fuelType,
    pricePerLitre: req.pricePerLitre,
    litres: req.pricePerLitre ? req.amount / req.pricePerLitre : null,
    recommended,
    splitAlternative,
    splitStatus,
    alternatives: alternatives.slice(0, 4),
    ineligible,
    tentative,
    wait: { options, best: bestWorth, extraBenefit: bestWorth ? extra : 0, message },
  };

  function baseReq(r: RecommendRequest): PlanRequest {
    return {
      dates: [r.date],
      totalSpend: r.amount,
      fuelType: r.fuelType,
      pricePerLitre: r.pricePerLitre,
      stationId: r.stationId,
      promotions: r.promotions,
      userState: r.userState,
      catalog,
      allowSplit: false,
    };
  }
}

export interface MonthlyPlanRequest {
  from: LocalDate;
  to: LocalDate;
  budget: Cents;
  fuelType: FuelType;
  pricePerLitre: Cents | null;
  stationId?: string | null;
  promotions: Promotion[];
  userState: UserState;
  catalog?: Catalog;
  maxLoads?: number | null;
}

/** Plan óptimo de cargas para un período (p. ej. lo que queda del mes). */
export function planPeriod(req: MonthlyPlanRequest): { plan: Plan; splitAlternative: Plan | null } {
  const dates: LocalDate[] = [];
  for (let d = req.from; d <= req.to; d = addDays(d, 1)) dates.push(d);
  const profile = req.userState.profile;
  const base: PlanRequest = {
    dates,
    totalSpend: req.budget,
    fuelType: req.fuelType,
    pricePerLitre: req.pricePerLitre,
    stationId: req.stationId,
    promotions: req.promotions,
    userState: req.userState,
    catalog: req.catalog,
    allowSplit: profile.allowSplitPayment === 'YES',
    maxPerDay: profile.maxLoadAmount,
    maxLoads: req.maxLoads ?? null,
  };
  const plan = optimizePlan(base);
  let splitAlternative: Plan | null = null;
  if (profile.allowSplitPayment === 'UNKNOWN') {
    const s = optimizePlan({ ...base, allowSplit: true });
    if (s.totalBenefit > plan.totalBenefit) splitAlternative = s;
  }
  return { plan, splitAlternative };
}

