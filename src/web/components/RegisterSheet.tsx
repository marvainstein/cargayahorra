import { useState } from 'react';
import type { PlannedTransaction } from '../../core/optimizer/planner';
import { FUEL_TYPE_LABELS } from '../../core/labels';
import { FUEL_TYPES, type FuelType } from '../../core/types';
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

  const submit = async () => {
    const cents = parsePesosInput(amount);
    if (!cents) return setError('Ingresá el monto cargado.');
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ evaluation: { totalBenefit: number }; warnings: string[] }>('/transactions', {
        amount: cents,
        paymentMethodId: method,
        fuelType: fuel,
        litres: litres ? Number(litres.replace(',', '.')) : null,
        pricePerLitre: !litres && price ? parsePesosInput(price) : null,
        date: date || undefined,
      });
      toast(r.data.evaluation.totalBenefit > 0 ? `Registrada. Ahorraste ${ars(r.data.evaluation.totalBenefit)}.` : 'Carga registrada (sin beneficio confirmado).');
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
      <label className="field">
        <span>Monto cargado ($)</span>
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus={!suggestion} />
      </label>
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
      {suggestion && suggestion.promotions.length > 0 && (
        <p className="small muted">Se aplicará automáticamente la mejor promoción confirmada para ese medio de pago: {suggestion.promotions.map((p) => p.name).join(' + ')}.</p>
      )}
      {error && <div className="banner danger">{error}</div>}
      <button className="btn primary block" onClick={submit} disabled={busy}>
        {busy ? 'Guardando…' : 'Guardar'}
      </button>
    </Sheet>
  );
}
