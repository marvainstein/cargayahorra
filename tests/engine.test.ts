import { describe, expect, it } from 'vitest';
import { pesos } from '../src/core/money';
import { calculatePromotionBenefit } from '../src/core/rules/engine';
import { canCombinePromotions, canSplitTransaction, evaluateTransaction } from '../src/core/rules/combine';
import { BANCO_A_VISA, BANCO_B_DEBITO, bancoA30, profile, promo, state, used } from './fixtures/builders';

const TUE = '2026-10-06';
const tx = (amount: number, over: Record<string, unknown> = {}) => ({
  date: TUE,
  grossAmount: pesos(amount),
  fuelType: 'SUPER' as const,
  paymentMethodId: BANCO_A_VISA.id,
  ...over,
});

describe('elegibilidad', () => {
  it('día incorrecto', () => {
    const p = bancoA30({ daysOfWeek: [5] });
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000), userState: state() });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('Sólo válida los viernes.');
    expect(r.totalBenefit).toBe(0);
  });

  it('promoción futura', () => {
    const p = { ...bancoA30(), validFrom: '2026-10-10' };
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000), userState: state() });
    expect(r.eligibility).toBe('INELIGIBLE');
    expect(r.reasons[0].code).toBe('NOT_STARTED');
  });

  it('promoción vencida', () => {
    const p = { ...bancoA30(), validUntil: '2026-10-05' };
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000), userState: state() });
    expect(r.reasons[0].code).toBe('EXPIRED');
  });

  it('promoción que vence ese día sigue vigente', () => {
    const p = { ...bancoA30(), validUntil: TUE };
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000), userState: state() });
    expect(r.eligible).toBe(true);
  });

  it('tarjeta incorrecta (otro banco)', () => {
    const r = calculatePromotionBenefit({ promotion: bancoA30(), transaction: tx(10_000, { paymentMethodId: BANCO_B_DEBITO.id }), userState: state() });
    expect(r.reasons[0].code).toBe('WRONG_PROVIDER');
  });

  it('tipo de tarjeta incorrecto', () => {
    const p = bancoA30({ eligiblePaymentMethodTypes: ['DEBIT_CARD'] });
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000), userState: state() });
    expect(r.reasons[0].code).toBe('WRONG_CARD_TYPE');
  });

  it('combustible incorrecto', () => {
    const p = bancoA30({ eligibleFuelTypes: ['PREMIUM', 'DIESEL_PREMIUM'] });
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000), userState: state() });
    expect(r.reasons[0].code).toBe('WRONG_FUEL');
  });

  it('estación incorrecta y estación no indicada', () => {
    const p = bancoA30({ eligibleStationIds: ['est-1'] });
    const wrong = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000, { stationId: 'est-2' }), userState: state() });
    expect(wrong.reasons[0].code).toBe('WRONG_STATION');
    const missing = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000), userState: state() });
    expect(missing.eligibility).toBe('UNCERTAIN');
  });

  it('estación sin confirmar: no se afirma que no aplique', () => {
    const incomplete = bancoA30({ eligibleStationIds: ['est-1'], extra: { stationListIncomplete: true } });
    expect(calculatePromotionBenefit({ promotion: incomplete, transaction: tx(10_000, { stationId: 'est-2' }), userState: state() }).eligibility).toBe('UNCERTAIN');
    const unknownFlag = bancoA30({ eligibleStationIds: ['est-1'], extra: { uncertainStationIds: ['est-3'] } });
    expect(calculatePromotionBenefit({ promotion: unknownFlag, transaction: tx(10_000, { stationId: 'est-3' }), userState: state() }).eligibility).toBe('UNCERTAIN');
    expect(calculatePromotionBenefit({ promotion: unknownFlag, transaction: tx(10_000, { stationId: 'est-2' }), userState: state() }).eligibility).toBe('INELIGIBLE');
  });

  it('región excluida', () => {
    const p = bancoA30({ excludedRegions: ['MENDOZA'] });
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000), userState: state({ region: 'MENDOZA' }) });
    expect(r.reasons[0].code).toBe('EXCLUDED_REGION');
  });

  it('segmento: tiene / no tiene / desconocido', () => {
    const p = bancoA30({ eligibleCustomerSegments: ['PLAN_PREMIUM'] });
    const yes = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000), userState: state({ segments: { PLAN_PREMIUM: 'YES' } }) });
    const no = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000), userState: state({ segments: { PLAN_PREMIUM: 'NO' } }) });
    const unk = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000), userState: state() });
    expect(yes.eligibility).toBe('ELIGIBLE');
    expect(no.eligibility).toBe('INELIGIBLE');
    expect(unk.eligibility).toBe('UNCERTAIN');
  });

  it('nunca asume: condición desconocida → UNCERTAIN', () => {
    const p = bancoA30({ unknownConditions: ['CAP'] });
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(100_000), userState: state() });
    expect(r.eligibility).toBe('UNCERTAIN');
    expect(r.eligible).toBe(false);
  });

  it('promoción no verificada o desactualizada → UNCERTAIN', () => {
    const imported = { ...bancoA30(), status: 'AUTOMATICALLY_IMPORTED' as const };
    const stale = { ...bancoA30(), status: 'STALE' as const };
    expect(calculatePromotionBenefit({ promotion: imported, transaction: tx(1000), userState: state() }).eligibility).toBe('UNCERTAIN');
    expect(calculatePromotionBenefit({ promotion: stale, transaction: tx(1000), userState: state() }).eligibility).toBe('UNCERTAIN');
    const invalid = { ...bancoA30(), status: 'INVALID' as const };
    expect(calculatePromotionBenefit({ promotion: invalid, transaction: tx(1000), userState: state() }).eligibility).toBe('INELIGIBLE');
  });

  it('compra mínima', () => {
    const p = bancoA30({ minimumPurchase: pesos(5_000) });
    expect(calculatePromotionBenefit({ promotion: p, transaction: tx(4_999), userState: state() }).reasons[0].code).toBe('BELOW_MINIMUM');
    expect(calculatePromotionBenefit({ promotion: p, transaction: tx(5_000), userState: state() }).eligible).toBe(true);
  });

  it('requiere programa de fidelidad / app', () => {
    const p = bancoA30({ requiredLoyaltyProgrammeId: 'programa-x', requiresApp: 'app-x' });
    expect(calculatePromotionBenefit({ promotion: p, transaction: tx(1000), userState: state() }).eligibility).toBe('INELIGIBLE');
    const ok = calculatePromotionBenefit({ promotion: p, transaction: tx(1000), userState: state({ loyaltyMemberships: ['programa-x'], apps: ['app-x'] }) });
    expect(ok.eligible).toBe(true);
  });

  it('límite de operaciones por semana', () => {
    const p = bancoA30({ usageLimits: [{ maxTransactions: 1, period: 'WEEKLY' }] });
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(1000), userState: state({}, [used(p.id, '2026-10-05', 100)]) });
    expect(r.reasons.map((x) => x.code)).toContain('USAGE_LIMIT_REACHED');
    // la semana siguiente vuelve a estar disponible
    const next = calculatePromotionBenefit({ promotion: p, transaction: tx(1000, { date: '2026-10-12' }), userState: state({}, [used(p.id, '2026-10-05', 100)]) });
    expect(next.eligible).toBe(true);
  });
});

describe('topes', () => {
  it('tope disponible', () => {
    const r = calculatePromotionBenefit({ promotion: bancoA30(), transaction: tx(50_000), userState: state() });
    expect(r.totalBenefit).toBe(pesos(15_000));
    expect(r.remainingCap).toBe(pesos(15_000));
    expect(r.remainingEligibleSpend).toBe(pesos(50_000));
    expect(r.netCost).toBe(pesos(35_000));
  });

  it('tope parcialmente utilizado (ejemplo 20.000 / 12.000)', () => {
    const p = bancoA30({ caps: [{ amount: pesos(20_000), period: 'MONTHLY' }] });
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(100_000), userState: state({}, [used(p.id, '2026-10-02', 12_000)]) });
    expect(r.remainingCap).toBe(pesos(8_000));
    expect(r.remainingEligibleSpend).toBe(2_666_667);
    expect(r.totalBenefit).toBe(pesos(8_000));
    expect(r.capLimited).toBe(true);
  });

  it('tope agotado', () => {
    const r = calculatePromotionBenefit({ promotion: bancoA30(), transaction: tx(10_000), userState: state({}, [used('banco-a-30', '2026-10-01', 15_000)]) });
    expect(r.eligible).toBe(false);
    expect(r.reasons[0].code).toBe('CAP_EXHAUSTED');
  });

  it('cambio de período: el tope mensual se reinicia', () => {
    const r = calculatePromotionBenefit({
      promotion: { ...bancoA30(), validUntil: '2026-11-30' },
      transaction: tx(10_000, { date: '2026-11-02' }),
      userState: state({}, [used('banco-a-30', '2026-10-30', 15_000)]),
    });
    expect(r.eligible).toBe(true);
    expect(r.totalBenefit).toBe(pesos(3_000));
  });

  it('cambio de semana: el tope semanal se reinicia', () => {
    const p = bancoA30({ caps: [{ amount: pesos(4_000), period: 'WEEKLY' }] });
    const usage = [used(p.id, '2026-10-04', 4_000)]; // domingo de la semana anterior
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(10_000), userState: state({}, usage) });
    expect(r.totalBenefit).toBe(pesos(3_000));
  });

  it('varios topes: manda el más restrictivo', () => {
    const p = bancoA30({ caps: [{ amount: pesos(2_000), period: 'PER_TRANSACTION' }, { amount: pesos(15_000), period: 'MONTHLY' }] });
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(50_000), userState: state() });
    expect(r.totalBenefit).toBe(pesos(2_000));
    expect(r.bindingCap?.period).toBe('PER_TRANSACTION');
  });

  it('pool compartido entre promociones', () => {
    const a = bancoA30({ caps: [{ amount: pesos(10_000), period: 'MONTHLY', poolId: 'pool-a' }] });
    const usage = [{ date: '2026-10-02', promotionId: null, poolIds: ['pool-a'], benefit: pesos(7_000), transactionId: null }];
    const r = calculatePromotionBenefit({ promotion: a, transaction: tx(50_000), userState: state({}, usage) });
    expect(r.totalBenefit).toBe(pesos(3_000));
  });
});

describe('cálculos', () => {
  it('descuento fijo', () => {
    const p = promo({ rule: { discountType: 'FIXED_AMOUNT', discountValue: pesos(5_000), minimumPurchase: pesos(30_000) } });
    expect(calculatePromotionBenefit({ promotion: p, transaction: tx(40_000), userState: state() }).totalBenefit).toBe(pesos(5_000));
    expect(calculatePromotionBenefit({ promotion: p, transaction: tx(20_000), userState: state() }).totalBenefit).toBe(0);
  });

  it('cashback / reintegro', () => {
    const p = bancoA30({ delivery: 'CASHBACK', discountValue: 2500 });
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(20_000), userState: state() });
    expect(r.cashbackAmount).toBe(pesos(5_000));
    expect(r.discountAmount).toBe(0);
    expect(r.totalBenefit).toBe(pesos(5_000));
  });

  it('beneficio por litro', () => {
    const p = promo({ rule: { discountType: 'PER_LITRE', discountValue: pesos(50) } });
    const r = calculatePromotionBenefit({ promotion: p, transaction: tx(25_000, { pricePerLitre: pesos(1_250) }), userState: state() });
    expect(r.totalBenefit).toBe(pesos(1_000)); // 20 L × $50
  });

  it('redondeo hacia abajo', () => {
    const p = promo({ rule: { discountValue: 1500 } });
    const r = calculatePromotionBenefit({ promotion: p, transaction: { ...tx(0), grossAmount: 12_345 }, userState: state() });
    expect(r.totalBenefit).toBe(1851); // 1851,75 → 1851
  });

  it('$0', () => {
    const r = calculatePromotionBenefit({ promotion: bancoA30(), transaction: tx(0), userState: state() });
    expect(r.totalBenefit).toBe(0);
    expect(r.netCost).toBe(0);
  });

  it('compra máxima limita la base', () => {
    const p = bancoA30({ caps: [], maximumPurchase: pesos(20_000) });
    expect(calculatePromotionBenefit({ promotion: p, transaction: tx(50_000), userState: state() }).totalBenefit).toBe(pesos(6_000));
  });
});

describe('combinación', () => {
  const loyalty = promo({ id: 'prog-x', providerId: 'programa-x', rule: { stage: 'PRICE', discountValue: 1000, stackable: 'YES' } });
  const bank = bancoA30({ stackable: 'YES' });

  it('no asume acumulables', () => {
    const unknown = promo({ id: 'u', rule: { stage: 'PRICE', stackable: 'UNKNOWN' } });
    expect(canCombinePromotions(unknown, bank).allowed).toBe('UNKNOWN');
    const no = promo({ id: 'n', rule: { stage: 'PRICE', stackable: 'NO' } });
    expect(canCombinePromotions(no, bank).allowed).toBe('NO');
    expect(canCombinePromotions(loyalty, bank).allowed).toBe('YES');
  });

  it('dos promos de medio de pago no se combinan en una operación', () => {
    const b2 = promo({ id: 'b2', rule: { stackable: 'YES' } });
    expect(canCombinePromotions(bank, b2).allowed).toBe('NO');
  });

  it('PRICE se aplica primero y PAYMENT sobre lo cobrado', () => {
    const ev = evaluateTransaction(tx(10_000), [bank, loyalty], state());
    expect(ev.eligibility).toBe('ELIGIBLE');
    expect(ev.results[0].promotionId).toBe('prog-x');
    expect(ev.results[0].discountAmount).toBe(pesos(1_000));
    expect(ev.results[1].baseAmount).toBe(pesos(9_000));
    expect(ev.results[1].discountAmount).toBe(pesos(2_700));
    expect(ev.totalBenefit).toBe(pesos(3_700));
  });

  it('dividir el pago depende de la estación', () => {
    expect(canSplitTransaction(profile({ allowSplitPayment: 'YES' })).allowed).toBe('YES');
    expect(canSplitTransaction(profile({ allowSplitPayment: 'UNKNOWN' })).allowed).toBe('UNKNOWN');
    expect(canSplitTransaction(profile({ allowSplitPayment: 'NO' })).allowed).toBe('NO');
  });
});
