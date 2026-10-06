import { useEffect, useState } from 'react';
import type { Plan as PlanT } from '../../core/optimizer/planner';
import { formatLongDate } from '../../core/time';
import { api } from '../api';
import type { ProfileData } from '../App';
import { ars, capitalize, ErrorBox, OfflineBanner, parsePesosInput, pesosText } from '../components/ui';

interface PlanResponse {
  from: string;
  to: string;
  budget: number;
  spentThisMonth: number;
  note: string | null;
  plan: PlanT | null;
  splitAlternative: PlanT | null;
}

export function Plan({ profile }: { profile: ProfileData | null }) {
  const [budget, setBudget] = useState('');
  const [maxLoads, setMaxLoads] = useState('');
  const [data, setData] = useState<PlanResponse | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (profile?.profile.estimatedMonthlyFuelBudget && !budget) setBudget(pesosText(profile.profile.estimatedMonthlyFuelBudget));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<PlanResponse>('/plan', {
        budget: parsePesosInput(budget),
        maxLoads: maxLoads ? Number(maxLoads) : null,
      });
      setData(r.data);
      setOffline(r.offlineSince);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const plan = data?.plan;
  return (
    <>
      <header className="topbar">
        <div>
          <div className="eyebrow">Planificación</div>
          <h1>Plan del mes</h1>
        </div>
      </header>
      <OfflineBanner since={offline} />
      <section className="card">
        <label className="field">
          <span>¿Cuánto pensás gastar en combustible en lo que queda del mes?</span>
          <div className="amount-input">
            <span>$</span>
            <input inputMode="decimal" placeholder="250.000" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </div>
        </label>
        <label className="field">
          <span>Máximo de cargas (opcional)</span>
          <input inputMode="numeric" placeholder="Sin límite" value={maxLoads} onChange={(e) => setMaxLoads(e.target.value)} />
        </label>
        {!profile?.profile.maxLoadAmount && (
          <p className="small muted" style={{ marginTop: 0 }}>
            Tip: configurá en Ajustes cuánto entra en tu tanque para que el plan no proponga cargas imposibles.
          </p>
        )}
        <button className="btn primary block" onClick={run} disabled={busy}>
          {busy ? 'Calculando…' : 'Calcular plan óptimo'}
        </button>
      </section>

      {error && <ErrorBox error={error} />}
      {data?.note && <div className="banner info" style={{ marginTop: 12 }}>{data.note}</div>}

      {plan && (
        <>
          <h2>Resultado</h2>
          <div className="card">
            <div className="big-grid" style={{ marginTop: 0 }}>
              <div className="stat">
                <div className="label">Total a cargar</div>
                <div className="value">{ars(plan.grossSpend)}</div>
              </div>
              <div className="stat save">
                <div className="label">Total ahorrado</div>
                <div className="value">{ars(plan.totalBenefit)}</div>
              </div>
            </div>
            {plan.warnings.map((w, i) => (
              <div key={i} className="banner warn" style={{ marginTop: 12, marginBottom: 0 }}>
                {w}
              </div>
            ))}
          </div>

          {plan.transactions.length > 0 && <h2>Cargas recomendadas</h2>}
          {plan.transactions.length > 0 && (
            <div className="card">
              {plan.transactions.map((t, i) => (
                <div className="list-item" key={i}>
                  <div>
                    <div className="title">
                      {capitalize(formatLongDate(t.date))}
                    </div>
                    <div className="meta">
                      <strong>{ars(t.amount)}</strong> con {t.paymentMethodName}
                      <br />
                      {t.promotions.map((p) => p.name).join(' + ')}
                    </div>
                  </div>
                  <div className="amount-save">−{ars(t.benefit)}</div>
                </div>
              ))}
            </div>
          )}

          {plan.unpromotedSpend > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="title">
                <strong>{ars(plan.unpromotedSpend)}</strong> sin beneficio disponible
              </div>
              <p className="small muted" style={{ marginBottom: 0 }}>
                Con tus topes y las promociones confirmadas no hay más ahorro posible este período. Cargalo cuando lo necesites.
              </p>
            </div>
          )}

          {data?.splitAlternative && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="eyebrow">Si tu estación permite dividir el pago</div>
              <p style={{ marginBottom: 0 }}>
                Podrías ahorrar {ars(data.splitAlternative.totalBenefit)} ({ars(data.splitAlternative.totalBenefit - plan.totalBenefit)} más). Indicalo en Ajustes para verlo
                detallado.
              </p>
            </div>
          )}

          {plan.explanation.length > 0 && (
            <details className="card why" style={{ marginTop: 12 }}>
              <summary>¿Cómo se calculó?</summary>
              <ul>
                <li>
                  Se probaron todas las combinaciones de días, medios de pago y promociones confirmadas entre {data?.from} y {data?.to}, respetando topes, reinicios
                  semanales/mensuales, límites de operaciones y lo que ya usaste.
                </li>
                {plan.explanation.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
                {plan.transactions.flatMap((t) => t.explanation).map((l, i) => (
                  <li key={`t${i}`}>{l}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </>
  );
}
