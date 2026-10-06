import { describe, expect, it } from 'vitest';
import { applyBps, ceilToPeso, formatARS, pesos, spendToReachBenefit } from '../src/core/money';
import { amountForLitres, effectivePricePerLitre, litresForAmount } from '../src/core/fuel';

describe('dinero en centavos', () => {
  it('convierte pesos sin errores de float', () => {
    expect(pesos(1.005)).toBe(101);
    expect(pesos(0.1 + 0.2)).toBe(30);
    expect(pesos(15_000)).toBe(1_500_000);
  });

  it('porcentajes redondean hacia abajo al centavo', () => {
    expect(applyBps(pesos(50_000), 3000)).toBe(pesos(15_000));
    expect(applyBps(333, 3000)).toBe(99); // 99,9 → 99 centavos
    expect(applyBps(1, 3000)).toBe(0); // monto mínimo: sin beneficio fraccionario
    expect(applyBps(0, 3000)).toBe(0);
  });

  it('calcula el gasto para agotar un tope (ejemplo del enunciado)', () => {
    // tope mensual 20.000, usado 12.000 → restante 8.000 → 8.000 / 0,30 = 26.666,67
    const remaining = pesos(20_000) - pesos(12_000);
    const spend = spendToReachBenefit(remaining, 3000);
    expect(spend).toBe(2_666_667);
    expect(applyBps(spend, 3000)).toBeGreaterThanOrEqual(remaining);
    expect(applyBps(spend - 1, 3000)).toBeLessThan(remaining);
  });

  it('divisiones con montos chicos', () => {
    expect(spendToReachBenefit(1, 2500)).toBe(4);
    expect(applyBps(4, 2500)).toBe(1);
    expect(ceilToPeso(2_666_667)).toBe(2_666_700);
  });

  it('formatea en es-AR', () => {
    expect(formatARS(pesos(15_000))).toBe('$ 15.000');
    expect(formatARS(2_666_667)).toBe('$ 26.666,67');
  });

  it('convierte pesos ↔ litros', () => {
    const price = pesos(1_250);
    expect(litresForAmount(pesos(50_000), price)).toBe(40);
    expect(amountForLitres(40, price)).toBe(pesos(50_000));
    expect(effectivePricePerLitre(pesos(50_000), pesos(15_000), price)).toBe(pesos(875));
  });
});
