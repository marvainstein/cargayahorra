/**
 * Combinación de promociones.
 *
 *  - "Combinar" (stacking): aplicar dos promociones sobre la MISMA operación
 *    (p. ej. descuento del programa de fidelidad + reintegro del banco).
 *  - "Dividir" (split): pagar una carga en varias operaciones con distintos
 *    medios de pago el mismo día.
 *
 * Nunca se asume que dos promociones son acumulables.
 */
import type { Cents } from '../money';
import type { Promotion, TriState, UserProfile, UserState } from '../types';
import { calculatePromotionBenefit, type BenefitResult, type Catalog, type Eligibility, type Reason, type TransactionInput } from './engine';

export interface Decision {
  allowed: TriState;
  reason: string;
}

function allowsWith(p: Promotion, other: Promotion): TriState {
  if (p.rule.stackableWith.includes(other.id)) return 'YES';
  if (p.rule.unknownConditions.includes('STACKABILITY')) return 'UNKNOWN';
  return p.rule.stackable;
}

export function canCombinePromotions(a: Promotion, b: Promotion): Decision {
  if (a.id === b.id) return { allowed: 'NO', reason: 'Es la misma promoción.' };
  if (a.rule.stage === 'PAYMENT' && b.rule.stage === 'PAYMENT') {
    // Dos beneficios de medio de pago en una sola operación sólo si ambos lo confirman
    // explícitamente (p. ej. billetera + tarjeta asociada).
    const explicit = a.rule.stackableWith.includes(b.id) && b.rule.stackableWith.includes(a.id);
    if (!explicit)
      return { allowed: 'NO', reason: 'Una operación se paga con un solo medio de pago; estas promociones no declaran ser combinables entre sí.' };
  }
  const x = allowsWith(a, b);
  const y = allowsWith(b, a);
  if (x === 'NO' || y === 'NO') {
    const who = x === 'NO' ? a : b;
    return { allowed: 'NO', reason: `«${who.name}» no es acumulable con otras promociones.` };
  }
  if (x === 'YES' && y === 'YES') return { allowed: 'YES', reason: 'Ambas promociones declaran ser acumulables.' };
  return { allowed: 'UNKNOWN', reason: 'No puedo confirmar que estas promociones sean acumulables.' };
}

/**
 * ¿Se puede dividir la carga en varias operaciones el mismo día?
 * Depende de que la estación lo permita (dato del usuario) y de que ninguna
 * promoción involucrada lo prohíba.
 */
export function canSplitTransaction(profile: UserProfile, promotions: Promotion[] = []): Decision {
  if (profile.allowSplitPayment === 'NO')
    return { allowed: 'NO', reason: 'Indicaste que en tu estación no se puede dividir el pago.' };
  for (const p of promotions) {
    if (p.rule.extra?.forbidsSplitPayment === true)
      return { allowed: 'NO', reason: `«${p.name}» no permite dividir el pago.` };
  }
  if (profile.allowSplitPayment === 'UNKNOWN')
    return { allowed: 'UNKNOWN', reason: 'No sé si tu estación permite pagar una carga en dos operaciones. Podés indicarlo en Ajustes.' };
  return { allowed: 'YES', reason: 'Indicaste que tu estación permite dividir el pago en varias operaciones.' };
}

export interface TransactionEvaluation {
  eligibility: Eligibility;
  results: BenefitResult[];
  combination: Decision;
  grossAmount: Cents;
  discountAmount: Cents;
  cashbackAmount: Cents;
  totalBenefit: Cents;
  /** Lo que se paga en el surtidor (bruto - descuentos instantáneos). */
  amountCharged: Cents;
  /** Costo real (bruto - todo el beneficio, incluidos reintegros). */
  netCost: Cents;
  reasons: Reason[];
  uncertainties: Reason[];
}

/**
 * Evalúa una operación con un conjunto de promociones aplicadas juntas.
 * Primero las de etapa PRICE (rebajan lo cobrado), luego las PAYMENT sobre lo cobrado.
 */
export function evaluateTransaction(
  transaction: TransactionInput,
  promotions: Promotion[],
  userState: UserState,
  catalog?: Catalog,
): TransactionEvaluation {
  let combination: Decision = { allowed: 'YES', reason: '' };
  for (let i = 0; i < promotions.length; i++) {
    for (let j = i + 1; j < promotions.length; j++) {
      const d = canCombinePromotions(promotions[i], promotions[j]);
      if (d.allowed === 'NO' || (d.allowed === 'UNKNOWN' && combination.allowed === 'YES')) combination = d;
      if (d.allowed === 'NO') break;
    }
  }

  const ordered = [...promotions].sort((a, b) => (a.rule.stage === b.rule.stage ? 0 : a.rule.stage === 'PRICE' ? -1 : 1));
  const results: BenefitResult[] = [];
  let charged = transaction.grossAmount;
  for (const p of ordered) {
    const base = p.rule.stage === 'PAYMENT' ? charged : transaction.grossAmount;
    const res = calculatePromotionBenefit({ promotion: p, transaction, userState, baseAmount: base, catalog });
    results.push(res);
    if (p.rule.stage === 'PRICE') charged -= res.discountAmount;
  }

  const reasons: Reason[] = results.flatMap((r) => r.reasons);
  const uncertainties: Reason[] = results.flatMap((r) => r.uncertainties);
  if (combination.allowed === 'NO') reasons.push({ code: 'NOT_COMBINABLE', message: combination.reason });
  if (combination.allowed === 'UNKNOWN') uncertainties.push({ code: 'COMBINATION_UNKNOWN', message: combination.reason });

  let eligibility: Eligibility = 'ELIGIBLE';
  if (results.some((r) => r.eligibility === 'INELIGIBLE') || combination.allowed === 'NO') eligibility = 'INELIGIBLE';
  else if (results.some((r) => r.eligibility === 'UNCERTAIN') || combination.allowed === 'UNKNOWN') eligibility = 'UNCERTAIN';

  const discountAmount = results.reduce((a, r) => a + r.discountAmount, 0);
  const cashbackAmount = results.reduce((a, r) => a + r.cashbackAmount, 0);
  const totalBenefit = discountAmount + cashbackAmount;
  return {
    eligibility,
    results,
    combination,
    grossAmount: transaction.grossAmount,
    discountAmount,
    cashbackAmount,
    totalBenefit,
    amountCharged: transaction.grossAmount - discountAmount,
    netCost: transaction.grossAmount - totalBenefit,
    reasons,
    uncertainties,
  };
}
