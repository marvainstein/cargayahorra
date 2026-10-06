import { describe, expect, it } from 'vitest';
import { applyBps, pesos } from '../src/core/money';
import { optimizePlan, planPeriod, recommend } from '../src/core/optimizer/planner';
import type { Promotion } from '../src/core/types';
import { BANCO_A_VISA, BANCO_B_DEBITO, BANCO_C_MASTER, bancoA30, bancoB25, promo, state, used } from './fixtures/builders';

const TUE = '2026-10-06';

function rec(promotions: Promotion[], amount: number, st = state(), extra: Record<string, unknown> = {}) {
  return recommend({ date: TUE, amount: pesos(amount), fuelType: 'SUPER', pricePerLitre: null, promotions, userState: st, ...extra });
}

describe('optimizador de una carga', () => {
  it('una promoción: carga y tope', () => {
    const r = rec([bancoA30()], 50_000);
    const t = r.recommended.transactions;
    expect(t).toHaveLength(1);
    expect(t[0].paymentMethodId).toBe(BANCO_A_VISA.id);
    expect(t[0].amount).toBe(pesos(50_000));
    expect(r.recommended.totalBenefit).toBe(pesos(15_000));
    expect(r.recommended.netSpend).toBe(pesos(35_000));
    expect(t[0].explanation[0]).toContain('tope restante de $ 15.000');
    expect(t[0].explanation[0]).toContain('necesitás cargar $ 50.000');
  });

  it('dos promociones con división permitida: ejemplo $80.000', () => {
    const r = rec([bancoA30(), bancoB25()], 80_000);
    const t = r.recommended.transactions;
    expect(t.map((x) => [x.paymentMethodId, x.amount, x.benefit])).toEqual([
      [BANCO_A_VISA.id, pesos(50_000), pesos(15_000)],
      [BANCO_B_DEBITO.id, pesos(30_000), pesos(7_500)],
    ]);
    expect(r.recommended.totalBenefit).toBe(pesos(22_500));
    expect(r.recommended.netSpend).toBe(pesos(57_500));
    expect(r.recommended.explanation.join(' ')).toContain('beneficio marginal');
  });

  it('sin división del pago: una sola operación', () => {
    const r = rec([bancoA30(), bancoB25()], 80_000, state({ allowSplitPayment: 'NO' }));
    expect(r.recommended.transactions).toHaveLength(1);
    expect(r.recommended.transactions[0].amount).toBe(pesos(80_000));
    expect(r.recommended.totalBenefit).toBe(pesos(15_000));
    expect(r.splitAlternative).toBeNull();
  });

  it('división desconocida: recomienda una operación y ofrece la alternativa', () => {
    const r = rec([bancoA30(), bancoB25()], 80_000, state({ allowSplitPayment: 'UNKNOWN' }));
    expect(r.recommended.transactions).toHaveLength(1);
    expect(r.recommended.totalBenefit).toBe(pesos(15_000));
    expect(r.splitAlternative?.totalBenefit).toBe(pesos(22_500));
  });

  it('mejor porcentaje vs. mejor ahorro real', () => {
    const a = bancoA30({ caps: [{ amount: pesos(3_000), period: 'MONTHLY' }] });
    const b = bancoB25({ discountValue: 2000, caps: [{ amount: pesos(20_000), period: 'MONTHLY' }] });
    const r = rec([a, b], 50_000, state({ allowSplitPayment: 'NO' }));
    expect(r.recommended.transactions[0].paymentMethodId).toBe(BANCO_B_DEBITO.id);
    expect(r.recommended.totalBenefit).toBe(pesos(10_000));
  });

  it('promociones incompatibles en la misma operación', () => {
    const loyalty = promo({ id: 'prog-x', name: 'Programa X 10%', providerId: 'programa-x', rule: { stage: 'PRICE', discountValue: 1000, stackable: 'NO' } });
    const r = rec([loyalty, bancoA30()], 40_000, state({ allowSplitPayment: 'NO', paymentMethods: [BANCO_A_VISA] }));
    const t = r.recommended.transactions;
    expect(t).toHaveLength(1);
    expect(t[0].promotions.map((p) => p.id)).toEqual(['banco-a-30']);
    expect(r.recommended.totalBenefit).toBe(pesos(12_000));
  });

  it('promociones combinables se aplican juntas', () => {
    const loyalty = promo({ id: 'prog-x', providerId: 'programa-x', rule: { stage: 'PRICE', discountValue: 1000, stackable: 'YES', caps: [{ amount: pesos(7_000), period: 'MONTHLY' }] } });
    const bank = bancoA30({ stackable: 'YES' });
    const r = rec([loyalty, bank], 40_000, state({ allowSplitPayment: 'NO', paymentMethods: [BANCO_A_VISA] }));
    const t = r.recommended.transactions[0];
    expect(t.promotions.map((p) => p.id).sort()).toEqual(['banco-a-30', 'prog-x']);
    // 10% de 40.000 = 4.000; banco 30% sobre 36.000 = 10.800
    expect(t.benefit).toBe(pesos(14_800));
    // ambos son descuentos en el momento: se pagan 40.000 − 4.000 − 10.800
    expect(t.amountCharged).toBe(pesos(25_200));
  });

  it('topes agotados: usa la siguiente mejor opción', () => {
    const st = state({}, [used('banco-a-30', '2026-10-02', 15_000)]);
    const r = rec([bancoA30(), bancoB25()], 30_000, st);
    expect(r.recommended.transactions.map((t) => t.paymentMethodId)).toEqual([BANCO_B_DEBITO.id]);
    expect(r.recommended.totalBenefit).toBe(pesos(7_500));
    expect(r.ineligible.find((i) => i.promotionId === 'banco-a-30')?.reasons[0]).toContain('agotado');
  });

  it('monto superior a todos los topes', () => {
    const r = rec([bancoA30(), bancoB25()], 1_000_000);
    expect(r.recommended.totalBenefit).toBe(pesos(25_000));
    expect(r.recommended.grossSpend).toBe(pesos(1_000_000));
    const sum = r.recommended.transactions.reduce((s, t) => s + t.amount, 0);
    expect(sum).toBe(pesos(1_000_000));
  });

  it('$0 y montos pequeños', () => {
    expect(rec([bancoA30()], 0).recommended.totalBenefit).toBe(0);
    const small = rec([bancoA30()], 1_000);
    expect(small.recommended.totalBenefit).toBe(pesos(300));
    const tiny = recommend({ date: TUE, amount: 3, fuelType: 'SUPER', pricePerLitre: null, promotions: [bancoA30()], userState: state() });
    expect(tiny.recommended.totalBenefit).toBe(0);
  });

  it('promociones sin confirmar no se usan, pero se muestran', () => {
    const imported = { ...bancoB25({ discountValue: 4000 }), status: 'AUTOMATICALLY_IMPORTED' as const };
    const r = rec([bancoA30(), imported], 50_000);
    expect(r.recommended.transactions.every((t) => t.paymentMethodId === BANCO_A_VISA.id)).toBe(true);
    expect(r.tentative[0].promotionId).toBe('banco-b-25');
    expect(r.tentative[0].estimatedBenefit).toBe(pesos(10_000));
  });

  it('condición desconocida (tope) impide la recomendación definitiva', () => {
    const unknownCap = bancoB25({ unknownConditions: ['CAP'], caps: [] });
    const r = rec([unknownCap], 50_000);
    expect(r.recommended.transactions).toHaveLength(0);
    expect(r.tentative[0].uncertainties.join(' ')).toContain('tope');
  });

  it('descuento fijo con compra mínima', () => {
    const fixed = promo({ id: 'fijo', providerId: 'banco-c', rule: { discountType: 'FIXED_AMOUNT', discountValue: pesos(5_000), minimumPurchase: pesos(30_000), eligibleProviderIds: ['banco-c'] } });
    const st = state({ allowSplitPayment: 'NO', paymentMethods: [BANCO_A_VISA, BANCO_C_MASTER] });
    const r20 = rec([fixed, bancoA30()], 20_000, st);
    expect(r20.recommended.totalBenefit).toBe(pesos(6_000)); // A: 30% de 20.000
    const r40 = rec([fixed, bancoA30({ caps: [{ amount: pesos(3_000), period: 'MONTHLY' }] })], 40_000, st);
    expect(r40.recommended.transactions[0].paymentMethodId).toBe(BANCO_C_MASTER.id);
    expect(r40.recommended.totalBenefit).toBe(pesos(5_000));
  });
});

describe('¿me conviene esperar?', () => {
  it('sugiere esperar al viernes si ahorra más', () => {
    const tuesday10 = bancoB25({ discountValue: 1000, daysOfWeek: [2] });
    const friday30 = bancoA30({ daysOfWeek: [5] });
    const r = rec([tuesday10, friday30], 50_000);
    expect(r.recommended.totalBenefit).toBe(pesos(5_000));
    expect(r.wait.best?.date).toBe('2026-10-09');
    expect(r.wait.extraBenefit).toBe(pesos(10_000));
    expect(r.wait.message).toContain('viernes, 9 de octubre');
  });

  it('no sugiere esperar si hoy es lo mejor', () => {
    const r = rec([bancoA30()], 50_000);
    expect(r.wait.message).toBeNull();
  });

  it('considera el estado actual de los topes', () => {
    // El viernes tendría 30%, pero el tope mensual ya está casi agotado.
    const friday30 = bancoA30({ daysOfWeek: [5] });
    const today25 = bancoB25();
    const st = state({}, [used('banco-a-30', '2026-10-02', 14_000)]);
    const r = rec([friday30, today25], 40_000, st);
    expect(r.recommended.totalBenefit).toBe(pesos(10_000));
    expect(r.wait.message).toBeNull();
  });

  it('cambio de mes: el tope se renueva y conviene esperar', () => {
    const p = { ...bancoA30(), validUntil: '2026-11-30' };
    const st = state({ paymentMethods: [BANCO_A_VISA] }, [used('banco-a-30', '2026-10-02', 15_000)]);
    const r = recommend({ date: '2026-10-30', amount: pesos(50_000), fuelType: 'SUPER', pricePerLitre: null, promotions: [p], userState: st });
    expect(r.recommended.totalBenefit).toBe(0);
    expect(r.wait.best?.date).toBe('2026-11-01');
  });
});

describe('optimización intertemporal', () => {
  it('supera al greedy por porcentaje (capacidad por día)', () => {
    // A: 30% cualquier día, tope 15.000. B: 25% sólo martes, tope 12.500. Tanque: $50.000 por carga.
    const a = bancoA30();
    const b = bancoB25({ daysOfWeek: [2], caps: [{ amount: pesos(12_500), period: 'MONTHLY' }] });
    const { plan } = planPeriod({
      from: TUE,
      to: '2026-10-07',
      budget: pesos(100_000),
      fuelType: 'SUPER',
      pricePerLitre: null,
      promotions: [a, b],
      userState: state({ maxLoadAmount: pesos(50_000), allowSplitPayment: 'NO' }),
    });
    // Greedy (A el martes) daría 15.000; óptimo: B el martes + A el miércoles = 27.500.
    expect(plan.totalBenefit).toBe(pesos(27_500));
    expect(plan.transactions.map((t) => [t.date, t.paymentMethodId])).toEqual([
      [TUE, BANCO_B_DEBITO.id],
      ['2026-10-07', BANCO_A_VISA.id],
    ]);
  });

  it('distribuye en fines de semana con tope semanal', () => {
    const weekend = bancoB25({ discountValue: 2000, daysOfWeek: [5, 6, 7], caps: [{ amount: pesos(5_000), period: 'WEEKLY' }] });
    const { plan } = planPeriod({
      from: TUE,
      to: '2026-10-31',
      budget: pesos(250_000),
      fuelType: 'SUPER',
      pricePerLitre: null,
      promotions: [weekend, bancoA30()],
      userState: state({ allowSplitPayment: 'NO', maxLoadAmount: pesos(60_000) }),
    });
    // 4 fines de semana (9-11, 16-18, 23-25, 30-31) × 5.000 + Banco A 15.000
    expect(plan.totalBenefit).toBe(pesos(35_000));
    const weekendTx = plan.transactions.filter((t) => t.paymentMethodId === BANCO_B_DEBITO.id);
    expect(weekendTx).toHaveLength(4);
    expect(plan.grossSpend).toBe(pesos(250_000));
  });

  it('respeta límites de operaciones (1 por semana)', () => {
    const p = bancoB25({ discountValue: 1000, caps: [{ amount: pesos(2_000), period: 'PER_TRANSACTION' }], usageLimits: [{ maxTransactions: 1, period: 'WEEKLY' }] });
    const { plan } = planPeriod({
      from: '2026-10-05',
      to: '2026-10-18',
      budget: pesos(200_000),
      fuelType: 'SUPER',
      pricePerLitre: null,
      promotions: [p],
      userState: state({ allowSplitPayment: 'NO' }),
    });
    expect(plan.transactions).toHaveLength(2);
    expect(plan.totalBenefit).toBe(pesos(4_000));
  });

  it('los totales coinciden con el motor de reglas (centavos exactos)', () => {
    const { plan } = planPeriod({
      from: TUE,
      to: '2026-10-31',
      budget: pesos(123_456.78),
      fuelType: 'SUPER',
      pricePerLitre: null,
      promotions: [bancoA30(), bancoB25()],
      userState: state(),
    });
    const sum = plan.transactions.reduce((s, t) => s + t.benefit, 0);
    expect(plan.totalBenefit).toBe(sum);
    expect(plan.transactions.reduce((s, t) => s + t.amount, 0) + plan.unpromotedSpend).toBe(pesos(123_456.78));
  });
});

describe('propiedad: igual a fuerza bruta', () => {
  it('un día, división permitida, 3 promos con topes', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (let t = 0; t < 25; t++) {
      const rates = [1000 + Math.floor(rnd() * 25) * 100, 1000 + Math.floor(rnd() * 25) * 100, 1000 + Math.floor(rnd() * 25) * 100];
      const caps = [1 + Math.floor(rnd() * 20), 1 + Math.floor(rnd() * 20), 1 + Math.floor(rnd() * 20)].map((k) => pesos(k * 1000));
      const methods = [BANCO_A_VISA, BANCO_B_DEBITO, BANCO_C_MASTER];
      const promos = methods.map((m, i) => promo({ id: `p${i}`, providerId: m.providerId, rule: { discountValue: rates[i], caps: [{ amount: caps[i], period: 'MONTHLY' }], eligibleProviderIds: [m.providerId] } }));
      const budget = (5 + Math.floor(rnd() * 20)) * 5000; // múltiplos de $5.000
      const plan = optimizePlan({ dates: [TUE], totalSpend: pesos(budget), fuelType: 'SUPER', pricePerLitre: null, promotions: promos, userState: state({ paymentMethods: methods }), allowSplit: true, singleLoad: true });
      // fuerza bruta en pasos de $1.000
      let brute = 0;
      const step = 1000;
      for (let x0 = 0; x0 <= budget; x0 += step) {
        for (let x1 = 0; x0 + x1 <= budget; x1 += step) {
          const x2 = budget - x0 - x1;
          const b = [x0, x1, x2].reduce((s, x, i) => s + Math.min(applyBps(pesos(x), rates[i]), caps[i]), 0);
          brute = Math.max(brute, b);
        }
      }
      expect(plan.totalBenefit).toBeGreaterThanOrEqual(brute);
      // y nunca supera la cota teórica continua
      const cont = [...rates.keys()].reduce((s, i) => s + caps[i], 0);
      expect(plan.totalBenefit).toBeLessThanOrEqual(Math.max(cont, applyBps(pesos(budget), Math.max(...rates))));
    }
  });
});
