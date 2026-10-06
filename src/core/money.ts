/**
 * Dinero en centavos enteros (ARS). Nunca usamos floats para montos.
 *
 * - Los montos se representan como `Cents` (entero, 1 peso = 100 centavos).
 * - Los porcentajes se representan en puntos básicos (`Bps`): 30% = 3000 bps.
 * - Los beneficios se redondean SIEMPRE hacia abajo al centavo (criterio
 *   conservador: preferimos prometer un centavo menos que uno de más).
 * - El gasto necesario para alcanzar un beneficio se redondea hacia arriba.
 */

export type Cents = number;
export type Bps = number;

export const BPS_DENOMINATOR = 10_000;

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertCents(value: number, label = 'monto'): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} debe ser un entero en centavos (recibido: ${value})`);
  }
  return value;
}

/** Convierte pesos (puede tener decimales) a centavos, redondeando al centavo más cercano. */
export function pesos(amount: number): Cents {
  if (!Number.isFinite(amount)) throw new Error(`Monto inválido: ${amount}`);
  // toPrecision(15) descarta el ruido binario (1.005 * 100 = 100.49999999999999 → 100.5).
  return Math.round(Number((amount * 100).toPrecision(15)));
}

export function toPesos(cents: Cents): number {
  return cents / 100;
}

/** División entera hacia arriba para enteros no negativos. */
export function ceilDiv(a: number, b: number): number {
  if (b <= 0) throw new Error('El divisor debe ser positivo');
  if (a <= 0) return 0;
  return Math.floor((a + b - 1) / b);
}

/** División entera hacia abajo para enteros no negativos. */
export function floorDiv(a: number, b: number): number {
  if (b <= 0) throw new Error('El divisor debe ser positivo');
  return Math.floor(a / b);
}

/** amount × bps / 10000, redondeado hacia abajo al centavo. */
export function applyBps(amount: Cents, bps: Bps): Cents {
  assertCents(amount);
  if (amount <= 0 || bps <= 0) return 0;
  // amount ≤ ~1e12 centavos y bps ≤ 1e4 → producto < 2^53, aritmética exacta.
  return floorDiv(amount * bps, BPS_DENOMINATOR);
}

/**
 * Gasto mínimo para que applyBps(gasto, bps) alcance `benefit`.
 * Ej.: tope restante $8.000 con 30% → $26.666,67.
 */
export function spendToReachBenefit(benefit: Cents, bps: Bps): Cents {
  assertCents(benefit);
  if (benefit <= 0) return 0;
  if (bps <= 0) throw new Error('No se puede alcanzar un beneficio con 0%');
  return ceilDiv(benefit * BPS_DENOMINATOR, bps);
}

export function minCents(...values: Cents[]): Cents {
  return Math.min(...values);
}

export function clampCents(value: Cents, min: Cents, max: Cents): Cents {
  return Math.max(min, Math.min(max, value));
}

export function sumCents(values: Cents[]): Cents {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Redondea hacia arriba al peso entero (útil para montos a cargar en surtidor). */
export function ceilToPeso(cents: Cents): Cents {
  return ceilDiv(cents, 100) * 100;
}

/** Redondea al peso entero más cercano. */
export function roundToPeso(cents: Cents): Cents {
  return Math.round(cents / 100) * 100;
}

export function percentToBps(percent: number): Bps {
  return Math.round(percent * 100);
}

export function bpsToPercent(bps: Bps): number {
  return bps / 100;
}

const formatterNoCents = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const formatterCents = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$ 15.000" o "$ 26.666,67" si hay centavos. */
export function formatARS(cents: Cents, opts: { forceCents?: boolean } = {}): string {
  const hasCents = cents % 100 !== 0;
  const f = opts.forceCents || hasCents ? formatterCents : formatterNoCents;
  return f.format(cents / 100).replace(/ /g, ' ');
}

export function formatPercent(bps: Bps): string {
  const p = bps / 100;
  return `${Number.isInteger(p) ? p : p.toFixed(2).replace('.', ',')}%`;
}
