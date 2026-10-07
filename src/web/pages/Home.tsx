import { useCallback, useEffect, useRef, useState } from 'react';
import type { Plan, PlannedTransaction, Recommendation } from '../../core/optimizer/planner';
import { FUEL_TYPE_LABELS } from '../../core/labels';
import { FUEL_TYPES, type FuelType } from '../../core/types';
import { formatShortDate } from '../../core/time';
import type { HomeResponse } from '../../server/services';
import { api } from '../api';
import type { ProfileData } from '../App';
import { ars, capitalize, ErrorBox, OfflineBanner, parsePesosInput, pesosText } from '../components/ui';
import { RegisterSheet } from '../components/RegisterSheet';

const QUICK_AMOUNTS = [20_000, 30_000, 50_000, 80_000];

export function Home({ profile }: { profile: ProfileData | null }) {
  const [data, setData] = useState<HomeResponse | null>(null);
  const [offlineSince, setOfflineSince] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [amountText, setAmountText] = useState('');
  const [mode, setMode] = useState<'pesos' | 'litres'>('pesos');
  const [fuelType, setFuelType] = useState<FuelType | null>(null);
  const [priceText, setPriceText] = useState('');
  const [editPrice, setEditPrice] = useState(false);
  const [register, setRegister] = useState<PlannedTransaction | 'manual' | null>(null);
  const userTyped = useRef(false);
  const reqId = useRef(0);

  const load = useCallback(
    async (opts: { amountText?: string; mode?: 'pesos' | 'litres'; fuelType?: FuelType | null; priceText?: string } = {}) => {
      const id = ++reqId.current;
      const q = new URLSearchParams();
      const m = opts.mode ?? mode;
      const t = opts.amountText ?? amountText;
      if (userTyped.current && t) {
        if (m === 'pesos') {
          const c = parsePesosInput(t);
          if (c) q.set('amount', String(c));
        } else {
          const l = Number(t.replace(',', '.'));
          if (l > 0) q.set('litres', String(l));
        }
      }
      const ft = opts.fuelType ?? fuelType;
      if (ft) q.set('fuelType', ft);
      const pt = opts.priceText ?? priceText;
      const pc = parsePesosInput(pt);
      if (pc) q.set('pricePerLitre', String(pc));
      setLoading(true);
      try {
        const r = await api.get<HomeResponse>(`/home?${q.toString()}`);
        if (id !== reqId.current) return;
        setData(r.data);
        setOfflineSince(r.offlineSince);
        setError(null);
        if (!userTyped.current && r.data.amount > 0) setAmountText(pesosText(r.data.amount));
      } catch (e) {
        if (id === reqId.current) setError((e as Error).message);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [amountText, mode, fuelType, priceText],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // recalcular al escribir (con pausa)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const schedule = (next: Parameters<typeof load>[0]) => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(next), 350);
  };

  const onAmount = (text: string) => {
    userTyped.current = true;
    setAmountText(text);
    schedule({ amountText: text });
  };

  const rec = data?.recommendation ?? null;
  const ft = fuelType ?? data?.fuelType ?? 'SUPER';

  return (
    <>
      <header className="topbar">
        <div>
          <div className="eyebrow">Hoy</div>
          <h1>{data ? capitalize(data.todayLabel) : '…'}</h1>
        </div>
      </header>

      <OfflineBanner since={offlineSince} />
      {error && <ErrorBox error={error} onRetry={() => void load()} />}
      {data?.freshness.warning && <div className="banner warn">{data.freshness.warning}</div>}
      {data && data.questions.length > 0 && (
        <a href="#/settings" className="banner info" style={{ display: 'block', textDecoration: 'none' }}>
          <strong>
            {data.questions.length === 1 ? 'Respondé 1 pregunta' : `Respondé ${data.questions.length} preguntas`} para mejorar la recomendación ›
          </strong>
          <div className="small" style={{ marginTop: 4 }}>
            {data.questions[0].question}
          </div>
        </a>
      )}

      {profile && <ProfileSummary profile={profile} />}

      <section className="card amount-card" aria-label="Cuánto vas a cargar">
        <div className="row" style={{ marginBottom: 8 }}>
          <label htmlFor="amount" style={{ margin: 0 }}>
            ¿Cuánto vas a cargar?
          </label>
          <div className="segmented" style={{ width: 120 }}>
            <button className={mode === 'pesos' ? 'active' : ''} onClick={() => { setMode('pesos'); setAmountText(''); }}>
              $
            </button>
            <button className={mode === 'litres' ? 'active' : ''} disabled={!data?.price} onClick={() => { setMode('litres'); setAmountText(''); }}>
              Litros
            </button>
          </div>
        </div>
        <div className="amount-input">
          <span>{mode === 'pesos' ? '$' : 'L'}</span>
          <input
            id="amount"
            inputMode="decimal"
            enterKeyHint="done"
            placeholder={mode === 'pesos' ? '50.000' : '40'}
            value={amountText}
            onChange={(e) => onAmount(e.target.value)}
            onFocus={(e) => e.target.select()}
            autoComplete="off"
          />
        </div>
        {mode === 'pesos' && (
          <div className="chips">
            {QUICK_AMOUNTS.map((a) => (
              <button key={a} className={`chip ${parsePesosInput(amountText) === a * 100 ? 'active' : ''}`} onClick={() => onAmount(pesosText(a * 100))}>
                {ars(a * 100)}
              </button>
            ))}
            {profile?.profile.maxLoadAmount ? (
              <button className="chip" onClick={() => onAmount(pesosText(profile.profile.maxLoadAmount))}>
                Tanque lleno
              </button>
            ) : null}
          </div>
        )}
        {data?.amountSource === 'SUGGESTED' && !userTyped.current && (
          <p className="small muted" style={{ margin: '10px 2px 0' }}>
            Monto sugerido: el que aprovecha todo el beneficio disponible hoy.
          </p>
        )}
        <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <select
            aria-label="Combustible"
            value={ft}
            onChange={(e) => {
              const v = e.target.value as FuelType;
              setFuelType(v);
              void load({ fuelType: v });
            }}
            className="chip"
          >
            {FUEL_TYPES.map((f) => (
              <option key={f} value={f}>
                {FUEL_TYPE_LABELS[f]}
              </option>
            ))}
          </select>
          <button className="chip" onClick={() => setEditPrice((v) => !v)}>
            {data?.price ? `${ars(data.price.price)}/L` : 'Precio por litro'}
          </button>
        </div>
        {data?.price && !editPrice && (
          <p className="small muted" style={{ margin: '8px 2px 0' }}>
            {data.price.source} · {formatShortDate(data.price.effectiveFrom)}
            {data.price.stale && <span style={{ color: 'var(--warn)' }}> · precio de hace {data.price.ageDays} días, puede haber cambiado</span>}
          </p>
        )}
        {editPrice && (
          <div className="amount-input" style={{ marginTop: 10 }}>
            <span style={{ fontSize: 18 }}>$/L</span>
            <input
              inputMode="decimal"
              style={{ fontSize: 22 }}
              placeholder="Precio por litro"
              value={priceText}
              onChange={(e) => {
                setPriceText(e.target.value);
                schedule({ priceText: e.target.value });
              }}
            />
          </div>
        )}
      </section>

      {loading && !data && <div className="skeleton" style={{ marginTop: 14 }} />}

      {rec && <RecommendationView rec={rec} onRegister={(t) => setRegister(t)} />}

      {data && !rec && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="empty">
            <div className="big">Ingresá cuánto querés cargar</div>
            No hay un beneficio confirmado que sugiera un monto para hoy.
          </div>
        </div>
      )}

      <div className="spacer" />
      <button className="btn block" onClick={() => setRegister('manual')}>
        Registrar una carga
      </button>

      {register && profile && (
        <RegisterSheet
          profile={profile}
          suggestion={register === 'manual' ? null : register}
          fuelType={ft}
          pricePerLitre={data?.price?.price ?? null}
          onClose={() => setRegister(null)}
          onSaved={() => {
            setRegister(null);
            void load();
          }}
        />
      )}
    </>
  );
}

function capInfo(t: PlannedTransaction): string | null {
  const capped = t.promotions.find((p) => p.remainingCapBefore !== null);
  return capped ? `Tope disponible: ${ars(capped.remainingCapBefore)}` : null;
}

function RecommendationView({ rec, onRegister }: { rec: Recommendation; onRegister: (t: PlannedTransaction) => void }) {
  const plan = rec.recommended;
  const txs = plan.transactions;
  return (
    <>
      {txs.length === 0 ? (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="eyebrow">Hoy</div>
          <div className="method" style={{ fontSize: 24 }}>
            No hay un beneficio confirmado para esta carga
          </div>
          <p className="sub">
            Cargá con el medio que prefieras: con las promociones verificadas y tus topes actuales, hoy no hay descuento asegurado para {ars(rec.requiredSpend)}.
          </p>
        </div>
      ) : (
        <HeroCard plan={plan} rec={rec} onRegister={onRegister} />
      )}

      {rec.splitAlternative && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="eyebrow">Si tu estación permite pagar en dos operaciones</div>
          <p style={{ margin: '8px 0' }}>
            Podrías ahorrar <span className="amount-save">{ars(rec.splitAlternative.totalBenefit)}</span> (
            {ars(rec.splitAlternative.totalBenefit - plan.totalBenefit)} más):
          </p>
          <Steps plan={rec.splitAlternative} />
          <p className="small muted" style={{ marginBottom: 0 }}>
            Indicá en Ajustes si en tu estación se puede dividir el pago.
          </p>
        </div>
      )}

      <h2>Si podés esperar</h2>
      <div className="card">
        {rec.wait.message ? (
          <>
            <p style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>{rec.wait.message}</p>
            {rec.wait.best && rec.wait.best.plan.transactions[0] && (
              <p className="small muted" style={{ marginBottom: 0 }}>
                Ese día: {rec.wait.best.plan.transactions.map((t) => `${t.paymentMethodName} (${t.promotions.map((p) => p.name).join(' + ')})`).join(' y ')} · ahorro{' '}
                {ars(rec.wait.best.bestBenefit)}. Supone que las promociones y el precio se mantienen.
              </p>
            )}
          </>
        ) : (
          <p style={{ margin: 0 }}>Hoy es igual o mejor que los próximos {rec.wait.options.length} días para esta carga.</p>
        )}
        <WaitBars rec={rec} />
      </div>

      {rec.alternatives.length > 0 && (
        <>
          <h2>Otras opciones</h2>
          <div className="card">
            {rec.alternatives.map((alt, i) => (
              <div className="list-item" key={i}>
                <div>
                  <div className="title">{alt.transactions.map((t) => t.paymentMethodName).join(' + ')}</div>
                  <div className="meta">{alt.transactions.flatMap((t) => t.promotions.map((p) => p.summary)).join(' · ')}</div>
                </div>
                <div className="amount-save">{ars(alt.totalBenefit)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {rec.tentative.length > 0 && (
        <>
          <h2>Posibles beneficios sin confirmar</h2>
          <div className="card">
            {rec.tentative.map((t) => (
              <div className="list-item" key={t.promotionId}>
                <div>
                  <div className="title">{t.name}</div>
                  <div className="meta">{t.summary}</div>
                  <ul className="meta" style={{ paddingLeft: 18, margin: '6px 0 0' }}>
                    {t.uncertainties.map((u, i) => (
                      <li key={i}>{u}</li>
                    ))}
                  </ul>
                  {t.sourceUrl && (
                    <a className="small" href={t.sourceUrl} target="_blank" rel="noreferrer">
                      Ver fuente
                    </a>
                  )}
                </div>
                <div className="center">
                  <div className="amount-strong muted">≈ {ars(t.estimatedBenefit)}</div>
                  <span className="tag warn">sin confirmar</span>
                </div>
              </div>
            ))}
            <p className="small muted" style={{ marginBottom: 0 }}>
              No se usan en la recomendación hasta que se puedan verificar.
            </p>
          </div>
        </>
      )}

      {rec.ineligible.length > 0 && (
        <details className="card why" style={{ marginTop: 26 }}>
          <summary>No aplican hoy ({rec.ineligible.length})</summary>
          {rec.ineligible.map((p) => (
            <div className="list-item" key={p.promotionId} style={{ paddingTop: 12 }}>
              <div>
                <div className="title">{p.name}</div>
                <div className="meta">{p.reasons.join(' ')}</div>
              </div>
            </div>
          ))}
        </details>
      )}
    </>
  );
}

function HeroCard({ plan, rec, onRegister }: { plan: Plan; rec: Recommendation; onRegister: (t: PlannedTransaction) => void }) {
  const txs = plan.transactions;
  const single = txs.length === 1 ? txs[0] : null;
  const cashback = plan.totalCashback;
  const charged = txs.reduce((s, t) => s + t.amountCharged, 0) + plan.unpromotedSpend;
  const litres = rec.pricePerLitre ? rec.requiredSpend / rec.pricePerLitre : null;
  return (
    <section className="card hero" style={{ marginTop: 14 }} aria-label="Recomendación">
      <div className="badge">🥇 Hoy te conviene</div>
      {single ? (
        <>
          <div className="method">{single.paymentMethodMatters ? single.paymentMethodName : single.promotions[0]?.providerName}</div>
          <div className="benefit-line">{single.promotions.map((p) => p.summary).join(' + ')}</div>
          {!single.paymentMethodMatters && <div className="sub">Pagá con el medio que quieras.</div>}
          {capInfo(single) && <div className="sub">{capInfo(single)}</div>}
        </>
      ) : (
        <>
          <div className="method">Dividí la carga</div>
          <Steps plan={plan} />
        </>
      )}

      <div className="big-grid">
        <div className="stat load full">
          <div className="label">Cargá</div>
          <div className="value">{ars(plan.grossSpend)}</div>
          {litres && <div className="small muted">≈ {litres.toFixed(1).replace('.', ',')} litros</div>}
        </div>
        <div className="stat save">
          <div className="label">Ahorrás</div>
          <div className="value">{ars(plan.totalBenefit)}</div>
        </div>
        <div className="stat">
          <div className="label">{cashback > 0 ? 'Costo final' : 'Pagás'}</div>
          <div className="value">{ars(plan.netSpend)}</div>
        </div>
      </div>
      {cashback > 0 && (
        <p className="small muted" style={{ margin: '10px 2px 0' }}>
          En el surtidor pagás {ars(charged)}; te reintegran {ars(cashback)} después.
        </p>
      )}
      {single?.effectivePricePerLitre && (
        <p className="small muted" style={{ margin: '6px 2px 0' }}>
          Precio efectivo: {ars(single.effectivePricePerLitre)}/L
        </p>
      )}

      {txs.some((t) => t.requirements.length > 0) && (
        <ul className="small" style={{ margin: '12px 0 0', paddingLeft: 18 }}>
          {[...new Set(txs.flatMap((t) => t.requirements))].map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      <details className="why">
        <summary>¿Por qué?</summary>
        <ul>
          {txs.flatMap((t) => t.explanation).map((l, i) => (
            <li key={`t${i}`}>{l}</li>
          ))}
          {plan.explanation.map((l, i) => (
            <li key={`p${i}`}>{l}</li>
          ))}
          {plan.unpromotedSpend === 0 && plan.grossSpend > 0 && txs.length === 1 && single && single.fullCapSpend && single.fullCapSpend < single.amount && (
            <li>Cargar más de {ars(single.fullCapSpend)} con este medio no suma ahorro: el tope ya queda agotado.</li>
          )}
          {plan.warnings.map((w, i) => (
            <li key={`w${i}`}>{w}</li>
          ))}
        </ul>
      </details>

      <div className="spacer" />
      <button className="btn primary block" onClick={() => onRegister(txs[0])}>
        Ya cargué: registrar
      </button>
    </section>
  );
}

function Steps({ plan }: { plan: Plan }) {
  return (
    <ol className="steps">
      {plan.transactions.map((t, i) => (
        <li key={i}>
          <span className="n">{i + 1}</span>
          <div>
            <div className="amt">
              {ars(t.amount)} con {t.paymentMethodMatters ? t.paymentMethodName : `${t.promotions[0]?.providerName} (cualquier medio)`}
            </div>
            <div className="small muted">{t.promotions.map((p) => p.name).join(' + ')}</div>
          </div>
          <span className="save">−{ars(t.benefit)}</span>
        </li>
      ))}
      {plan.unpromotedSpend > 0 && (
        <li>
          <span className="n">·</span>
          <div className="amt">{ars(plan.unpromotedSpend)} con cualquier medio</div>
          <span className="save muted">sin beneficio</span>
        </li>
      )}
    </ol>
  );
}

function WaitBars({ rec }: { rec: Recommendation }) {
  const all = [{ date: rec.date, label: 'hoy', bestBenefit: rec.recommended.totalBenefit }, ...rec.wait.options];
  const max = Math.max(1, ...all.map((o) => o.bestBenefit));
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 14 }} aria-label="Ahorro posible por día">
      {all.map((o, i) => (
        <div key={o.date} style={{ display: 'grid', gridTemplateColumns: '86px 1fr 84px', alignItems: 'center', gap: 8 }} className="small">
          <span className="muted">
            {i === 0 ? 'Hoy' : capitalize(o.label.split(',')[0]).slice(0, 3)} {formatShortDate(o.date)}
          </span>
          <div style={{ background: 'var(--surface-2)', borderRadius: 6, height: 10, overflow: 'hidden' }}>
            <div
              style={{
                width: `${(o.bestBenefit / max) * 100}%`,
                height: '100%',
                background: rec.wait.best?.date === o.date ? 'var(--gold)' : i === 0 ? 'var(--brand)' : 'color-mix(in srgb, var(--brand) 45%, transparent)',
                borderRadius: 6,
              }}
            />
          </div>
          <span className="amount-strong" style={{ textAlign: 'right' }}>
            {ars(o.bestBenefit)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** "Calculado para: Brubank Visa débito (Plan One) · BBVA Visa crédito · Axion ON nivel 3, 4 o 5 · estación" */
function ProfileSummary({ profile }: { profile: ProfileData }) {
  const p = profile.profile;
  const cat = profile.catalog;
  const yes = (providerId: string) =>
    cat.segments.filter((sg) => sg.providerId === providerId && p.segments[sg.id] === 'YES').map((sg) => sg.name);
  const items: string[] = [];
  for (const m of p.paymentMethods) {
    const plans = yes(m.providerId);
    items.push(plans.length ? `${m.name} (${plans.join(', ')})` : m.name);
  }
  for (const id of p.loyaltyMemberships) {
    const prog = cat.programmes.find((pg) => pg.id === id);
    const lvl = yes(id);
    items.push(`${prog?.name ?? id}${lvl.length ? ` ${lvl.join(', ').toLowerCase()}` : ''}`);
  }
  const station = p.defaultStationId ? cat.stations.find((st) => st.id === p.defaultStationId) : null;
  return (
    <a href="#/settings" className="small muted" style={{ display: 'block', margin: '0 4px 12px', textDecoration: 'none' }}>
      Calculado para: <strong style={{ color: 'var(--text)' }}>{items.join(' · ') || 'sin medios de pago'}</strong>
      {station ? ` · ${station.name}` : ' · sin estación'} <span style={{ color: 'var(--brand-strong)' }}>Cambiar ›</span>
    </a>
  );
}
