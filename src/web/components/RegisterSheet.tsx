import { useEffect, useState } from 'react';
import type { PlannedTransaction } from '../../core/optimizer/planner';
import { FUEL_TYPE_LABELS } from '../../core/labels';
import { FUEL_TYPES, type FuelType, type Promotion } from '../../core/types';
import { api } from '../api';
import type { ProfileData } from '../App';
import { ars, parsePesosInput, pesosText, Sheet, toast } from './ui';

export function RegisterSheet({
  profile,
  suggestion,
  fuelType,
  pricePerLitre,
  onClose,
  onSaved,
}: {
  profile: ProfileData;
  suggestion: PlannedTransaction | null;
  fuelType: FuelType;
  pricePerLitre: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const methods = profile.profile.paymentMethods;
  const [amount, setAmount] = useState(suggestion ? pesosText(suggestion.amount) : '');
  const [method, setMethod] = useState(suggestion?.paymentMethodId ?? methods[0]?.id ?? '');
  const [fuel, setFuel] = useState<FuelType>(fuelType);
  const [litres, setLitres] = useState('');
  const [price, setPrice] = useState(pricePerLitre ? pesosText(pricePerLitre) : '');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amountMode, setAmountMode] = useState<'gross' | 'paid'>('gross');
  const [promoChoice, setPromoChoice] = useState<string>(suggestion?.promotions[0]?.id ?? 'AUTO');
  const [actual, setActual] = useState('');
  const [promos, setPromos] = useState<Promotion[]>([]);

  useEffect(() => {
    void api.get<{ promotions: Promotion[] }>('/promotions').then((r) => setPromos(r.data.promotions));
  }, []);

  const submit = async () => {
    const cents = parsePesosInput(amount);
    if (!cents) return setError('Ingresá el monto cargado.');
    setBusy(true);
    setError(null);
    try {
      const promotionIds = promoChoice === 'AUTO' ? undefined : promoChoice === 'NONE' ? [] : [promoChoice];
      const actualCents = parsePesosInput(actual);
      const r = await api.post<{ totalBenefit: number; grossAmount: number; derivedFromPaid: boolean; discrepancies: Array<{ name: string; expected: number; actual: number }> }>('/transactions', {
        ...(amountMode === 'gross' ? { amount: cents } : { amountPaid: cents }),
        promotionIds,
        actualBenefits: actualCents != null && promotionIds?.length ? [{ promotionId: promotionIds[0], amount: actualCents }] : undefined,
        paymentMethodId: method,
        fuelType: fuel,
        litres: litres ? Number(litres.replace(',', '.')) : null,
        pricePerLitre: !litres && price ? parsePesosInput(price) : null,
        date: date || undefined,
      });
      const d = r.data;
      const parts = [d.totalBenefit > 0 ? `Registrada. Ahorraste ${ars(d.totalBenefit)}.` : 'Carga registrada (sin beneficio).'];
      if (d.derivedFromPaid) parts.push(`Monto cargado: ${ars(d.grossAmount)}.`);
      for (const x of d.discrepancies) parts.push(`Ojo: «${x.name}» debía dar ${ars(x.expected)} y diste ${ars(x.actual)}.`);
      toast(parts.join(' '));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Registrar carga" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>
        Con esto la app descuenta lo usado de cada tope automáticamente.
      </p>
      <div className="field">
        <div className="segmented">
          <button type="button" className={amountMode === 'gross' ? 'active' : ''} onClick={() => setAmountMode('gross')}>
            Monto cargado
          </button>
          <button type="button" className={amountMode === 'paid' ? 'active' : ''} onClick={() => setAmountMode('paid')}>
            Lo que pagué
          </button>
        </div>
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus={!suggestion} placeholder="$" />
        {amountMode === 'paid' && <span className="small">Con un descuento en el surtidor, la app calcula el monto cargado.</span>}
      </div>
      <label className="field">
        <span>Promoción usada</span>
        <select value={promoChoice} onChange={(e) => setPromoChoice(e.target.value)}>
          <option value="AUTO">Calcular automáticamente</option>
          <option value="NONE">Ninguna</option>
          {promos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {promoChoice !== 'AUTO' && promoChoice !== 'NONE' && (
        <label className="field">
          <span>Ahorro real según el ticket o el resumen ($, opcional)</span>
          <input inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value)} placeholder="Si lo dejás vacío, se usa el calculado" />
        </label>
      )}
      <label className="field">
        <span>Medio de pago</span>
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {methods.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Combustible</span>
        <select value={fuel} onChange={(e) => setFuel(e.target.value as FuelType)}>
          {FUEL_TYPES.map((f) => (
            <option key={f} value={f}>
              {FUEL_TYPE_LABELS[f]}
            </option>
          ))}
        </select>
      </label>
      <div className="grid2">
        <label className="field">
          <span>Litros (opcional)</span>
          <input inputMode="decimal" value={litres} onChange={(e) => setLitres(e.target.value)} />
        </label>
        <label className="field">
          <span>Precio por litro</span>
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} disabled={!!litres} />
        </label>
      </div>
      <label className="field">
        <span>Fecha (vacío = hoy)</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      {error && <div className="banner danger">{error}</div>}
      <button className="btn primary block" onClick={submit} disabled={busy}>
        {busy ? 'Guardando…' : 'Guardar'}
      </button>
    </Sheet>
  );
}
