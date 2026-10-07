import { useCallback, useEffect, useState } from 'react';
import { FUEL_TYPE_LABELS } from '../../core/labels';
import { formatShortDate } from '../../core/time';
import type { FuelType } from '../../core/types';
import { api } from '../api';
import { ars, capitalize, ErrorBox, OfflineBanner, toast } from '../components/ui';

interface HistoryResponse {
  month: string;
  gross: number;
  saved: number;
  potential: number;
  message: string | null;
  transactions: Array<{
    id: string;
    date: string;
    fuelType: FuelType;
    litres: number | null;
    pricePerLitre: number | null;
    grossAmount: number;
    paymentMethodName: string;
    benefit: number;
    cashbackAmount: number;
    promotions: Array<{ promotionId: string; name: string; discountAmount: number; cashbackAmount: number; expectedBenefit?: number | null }>;
  }>;
}

function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function History() {
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (m: string | null) => {
    try {
      const r = await api.get<HistoryResponse>(`/transactions${m ? `?month=${m}` : ''}`);
      setData(r.data);
      setOffline(r.offlineSince);
      setMonth(r.data.month);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const remove = async (id: string) => {
    if (!confirm('¿Borrar esta carga? Se recalcularán los topes.')) return;
    await api.del(`/transactions/${id}`);
    toast('Carga borrada');
    void load(month);
  };

  const monthLabel = month ? new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`)) : '';

  return (
    <>
      <header className="topbar">
        <div>
          <div className="eyebrow">Historial</div>
          <h1>{capitalize(monthLabel)}</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="icon-btn" aria-label="Mes anterior" onClick={() => month && void load(shiftMonth(month, -1))}>
            ‹
          </button>
          <button className="icon-btn" aria-label="Mes siguiente" onClick={() => month && void load(shiftMonth(month, 1))}>
            ›
          </button>
        </div>
      </header>
      <OfflineBanner since={offline} />
      {error && <ErrorBox error={error} />}
      {data && (
        <>
          <section className="card">
            <div className="muted small" style={{ fontWeight: 600 }}>
              Ahorraste este mes
            </div>
            <div className="month-total">{ars(data.saved)}</div>
            <div className="muted small">en {ars(data.gross)} de combustible</div>
            {data.message && (
              <div className={`banner ${data.potential > data.saved ? 'info' : 'ok'}`} style={{ marginTop: 12, marginBottom: 0 }}>
                {data.message}
              </div>
            )}
          </section>
          <h2>Cargas</h2>
          <div className="card">
            {data.transactions.length === 0 && (
              <div className="empty">
                <div className="big">Sin cargas registradas</div>
                Registrá cada carga desde Hoy para que la app calcule tus topes sola.
              </div>
            )}
            {data.transactions.map((t) => (
              <div className="list-item" key={t.id}>
                <div>
                  <div className="title">
                    {formatShortDate(t.date)} · {ars(t.grossAmount)}
                  </div>
                  <div className="meta">
                    {t.paymentMethodName} · {FUEL_TYPE_LABELS[t.fuelType]}
                    {t.litres ? ` · ${String(t.litres).replace('.', ',')} L` : ''}
                    {t.pricePerLitre ? ` · ${ars(t.pricePerLitre)}/L` : ''}
                    <br />
                    {t.promotions.length ? t.promotions.map((p) => p.name).join(' + ') : 'Sin promoción'}
                    {t.promotions
                      .filter((p) => p.expectedBenefit != null && Math.abs(p.expectedBenefit - p.discountAmount - p.cashbackAmount) >= 100)
                      .map((p) => (
                        <div key={p.promotionId} style={{ color: 'var(--warn)' }}>
                          Calculado {ars(p.expectedBenefit!)} · recibido {ars(p.discountAmount + p.cashbackAmount)}
                        </div>
                      ))}
                    {t.cashbackAmount > 0 && ' · reintegro pendiente de acreditación'}
                  </div>
                  <button className="btn small danger" style={{ marginTop: 6, paddingLeft: 0, background: 'none' }} onClick={() => void remove(t.id)}>
                    Borrar
                  </button>
                </div>
                <div className="amount-save">{t.benefit > 0 ? `−${ars(t.benefit)}` : ars(0)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
