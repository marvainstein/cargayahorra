/**
 * Conversiones de combustible. Los precios por litro están en centavos.
 */
import { type Cents, assertCents } from './money';

/** Litros que se obtienen con un monto (redondeado a 2 decimales). */
export function litresForAmount(amount: Cents, pricePerLitre: Cents): number {
  assertCents(amount);
  if (pricePerLitre <= 0) throw new Error('Precio por litro inválido');
  return Math.round((amount / pricePerLitre) * 100) / 100;
}

/** Monto para cargar una cantidad de litros (redondeado al centavo). */
export function amountForLitres(litres: number, pricePerLitre: Cents): Cents {
  if (!(litres >= 0)) throw new Error('Litros inválidos');
  if (pricePerLitre <= 0) throw new Error('Precio por litro inválido');
  return Math.round(litres * pricePerLitre);
}

/** Precio efectivo por litro luego del beneficio. */
export function effectivePricePerLitre(grossAmount: Cents, benefit: Cents, pricePerLitre: Cents): Cents {
  if (grossAmount <= 0) return pricePerLitre;
  const litres = grossAmount / pricePerLitre;
  return Math.round((grossAmount - benefit) / litres);
}
