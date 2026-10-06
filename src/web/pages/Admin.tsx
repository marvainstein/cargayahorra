import { useCallback, useEffect, useState } from 'react';
import { CAP_PERIOD_LABELS, FUEL_TYPE_LABELS, PAYMENT_METHOD_TYPE_LABELS, STATUS_LABELS, UNKNOWN_CONDITION_LABELS } from '../../core/labels';
import {
  CAP_PERIODS,
  FUEL_TYPES,
  PAYMENT_METHOD_TYPES,
  PROMOTION_STATUSES,
  type Promotion,
  type PromotionRule,
  UNKNOWN_CONDITIONS,
} from '../../core/types';
import { formatWeekdays } from '../../core/time';
import type { CatalogData } from '../../server/db/user';
import { api } from '../api';
import { ars, ErrorBox, parsePesosInput, pesosText, relativeTime, toast } from '../components/ui';

type AdminPromotion = Promotion & { meta: { sourceId: string | null; sourceKey: string | null; active: boolean; pendingReviewReason: string | null; createdAt: string } };

interface Overview {
  now: string;
  sources: Array<{ id: string; name: string; configured: boolean; lastAttemptAt: string | null; lastSuccessAt: string | null; consecutiveFailures: number; lastError: string | null; promotions: number; pendingCandidates: number }>;
  jobs: Array<{ name: string; everyMinutes: number; last: { startedAt: string; status: string; detail: string | null } | null }>;
  promotions: { total: number; byStatus: Record<string, number>; pendingReview: number };
  candidates: number;
}

function subRoute(): { view: 'home' | 'promo' | 'new'; id?: string } {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  if (parts[1] === 'promo' && parts[2]) return { view: 'promo', id: decodeURIComponent(parts[2]) };
  if (parts[1] === 'new') return { view: 'new' };
  return { view: 'home' };
}

export function Admin() {
  const [route, setRoute] = useState(subRoute());
  useEffect(() => {
    const on = () => setRoute(subRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  if (route.view === 'promo' && route.id) return <PromotionDetail id={route.id} />;
  if (route.view === 'new') return <PromotionEditor initial={null} />;
  return <AdminHome />;
}

function AdminHome() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [promos, setPromos] = useState<AdminPromotion[]>([]);
  const [cands, setCands] = useState<Array<{ id: number; sourceId: string; kind: string; promotionId: string | null; payload: { draft?: { name: string; description: string; rule: PromotionRule }; warnings?: string[] } }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, p, c] = await Promise.all([api.get<Overview>('/admin/overview'), api.get<{ promotions: AdminPromotion[] }>('/admin/promotions'), api.get<{ candidates: typeof cands }>('/admin/candidates')]);
      setOv(o.data);
      setPromos(p.data.promotions);
      setCands(c.data.candidates);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const runJob = async (name: string) => {
    setBusy(name);
    try {
      const r = await api.post<{ ok: boolean; detail: string }>(`/admin/jobs/${name}/run`);
      toast(r.data.ok ? 'Listo' : `Error: ${r.data.detail}`);
    } finally {
      setBusy(null);
      void load();
    }
  };

  const resolve = async (id: number, action: 'apply' | 'reject') => {
    await api.post(`/admin/candidates/${id}/${action}`);
    void load();
  };

  return (
    <>
      <header className="topbar">
        <div>
          <div className="eyebrow">Administración</div>
          <h1>Promociones y fuentes</h1>
        </div>
      </header>
      {error && <ErrorBox error={error} onRetry={load} />}

      <h2>Fuentes</h2>
      <div className="card">
        {ov?.sources.map((s) => {
          const ok = s.consecutiveFailures === 0 && !!s.lastSuccessAt;
          return (
            <div className="list-item" key={s.id}>
              <div>
                <div className="title">
                  {!s.configured ? '○' : ok ? '✓' : '⚠'} {s.name}
                </div>
                <div className="meta">
                  {!s.configured
                    ? 'Sin configurar: falta la URL oficial (ver README).'
                    : !s.lastAttemptAt
                      ? 'Todavía no se ejecutó la importación.'
                      : ok
                      ? `Actualizado ${relativeTime(s.lastSuccessAt)}`
                      : `Actualización fallida${s.lastSuccessAt ? ` · última correcta ${relativeTime(s.lastSuccessAt)}` : ' · nunca se actualizó con éxito'}`}
                  {s.lastError && s.configured && <div style={{ color: 'var(--danger)' }}>{s.lastError}</div>}
                  {s.pendingCandidates > 0 && <div>{s.pendingCandidates} cambio(s) para revisar</div>}
                </div>
              </div>
              <span className="tag">{s.promotions}</span>
            </div>
          );
        })}
        <div className="spacer" />
        <div className="grid2">
          {ov?.jobs.map((j) => (
            <button key={j.name} className="btn small" onClick={() => void runJob(j.name)} disabled={busy !== null}>
              {busy === j.name ? '…' : `Ejecutar ${j.name}`}
            </button>
          ))}
        </div>
        <div className="small muted" style={{ marginTop: 10 }}>
          {ov?.jobs.map((j) => (
            <div key={j.name}>
              {j.name}: {j.last ? `${j.last.status} ${relativeTime(j.last.startedAt)}` : 'nunca'}
              {j.last?.detail ? ` — ${j.last.detail}` : ''}
            </div>
          ))}
        </div>
      </div>

      {cands.length > 0 && (
        <>
          <h2>Cambios detectados para revisar ({cands.length})</h2>
          <div className="card">
            {cands.map((c) => (
              <div className="list-item" key={c.id}>
                <div>
                  <div className="title">
                    {c.kind === 'CHANGED' ? 'Cambió' : c.kind === 'MISSING' ? 'Ya no aparece' : 'Nueva'}: {c.payload.draft?.name ?? c.promotionId}
                  </div>
                  {c.payload.draft && <div className="meta">{ruleSummary(c.payload.draft.rule)}</div>}
                  {c.payload.warnings?.map((w, i) => (
                    <div className="meta" key={i} style={{ color: 'var(--warn)' }}>
                      {w}
                    </div>
                  ))}
                  <div className="row" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
                    <button className="btn small primary" onClick={() => void resolve(c.id, 'apply')}>
                      {c.kind === 'MISSING' ? 'Desactivar' : 'Aceptar cambio'}
                    </button>
                    <button className="btn small" onClick={() => void resolve(c.id, 'reject')}>
                      Descartar
                    </button>
                    {c.promotionId && (
                      <a className="btn small" href={`#/admin/promo/${c.promotionId}`}>
                        Ver
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="row" style={{ margin: '26px 4px 10px' }}>
        <h2 style={{ margin: 0 }}>Promociones ({promos.length})</h2>
        <a className="btn small primary" href="#/admin/new">
          + Nueva
        </a>
      </div>
      <div className="card">
        {promos.map((p) => (
          <a key={p.id} href={`#/admin/promo/${encodeURIComponent(p.id)}`} className="list-item" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div>
              <div className="title">{p.name}</div>
              <div className="meta">
                {ruleSummary(p.rule)} · {p.validFrom} → {p.validUntil ?? 'sin fecha'}
                {p.pendingReview && <div style={{ color: 'var(--warn)' }}>{p.meta.pendingReviewReason ?? 'Pendiente de revisión'}</div>}
              </div>
            </div>
            <div style={{ display: 'grid', gap: 4, justifyItems: 'end' }}>
              <span className={`tag ${p.status}`}>{STATUS_LABELS[p.status]}</span>
              {!p.meta.active && <span className="tag">inactiva</span>}
              {p.rule.unknownConditions.length > 0 && (
                <span className="tag warn">
                  {p.rule.unknownConditions.length} {p.rule.unknownConditions.length === 1 ? 'duda' : 'dudas'}
                </span>
              )}
            </div>
          </a>
        ))}
      </div>
    </>
  );
}

function ruleSummary(r: PromotionRule): string {
  const v = r.discountType === 'PERCENTAGE' ? `${r.discountValue / 100}%` : r.discountType === 'FIXED_AMOUNT' ? ars(r.discountValue) : `${ars(r.discountValue)}/L`;
  const caps = r.caps.map((c) => `tope ${CAP_PERIOD_LABELS[c.period]} ${ars(c.amount)}`).join(', ');
  const days = r.daysOfWeek ? formatWeekdays(r.daysOfWeek) : 'todos los días';
  return [v, r.delivery === 'CASHBACK' ? 'reintegro' : 'descuento', caps || (r.unknownConditions.includes('CAP') || r.unknownConditions.includes('CAP_PERIOD') ? 'tope ?' : 'sin tope'), days].join(' · ');
}

function PromotionDetail({ id }: { id: string }) {
  const [data, setData] = useState<{
    promotion: AdminPromotion;
    versions: Array<AdminPromotion & { createdAt: string; createdBy: string; changeReason: string | null }>;
    events: Array<{ id: number; at: string; actor: string; type: string; detail: string | null }>;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<NonNullable<typeof data>>(`/admin/promotions/${encodeURIComponent(id)}`);
      setData(r.data);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="skeleton" />;
  if (editing) return <PromotionEditor initial={data.promotion} onDone={() => { setEditing(false); void load(); }} />;
  const p = data.promotion;

  const setStatus = async (status: string) => {
    try {
      await api.post(`/admin/promotions/${encodeURIComponent(id)}/status`, { status });
      toast(`Estado: ${STATUS_LABELS[status as keyof typeof STATUS_LABELS]}`);
      void load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const setActive = async (active: boolean) => {
    await api.post(`/admin/promotions/${encodeURIComponent(id)}/active`, { active });
    void load();
  };

  return (
    <>
      <header className="topbar">
        <div>
          <a href="#/admin" className="small">
            ‹ Administración
          </a>
          <h1>{p.name}</h1>
        </div>
      </header>
      <div className="card">
        <div className="row" style={{ justifyContent: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
          <span className={`tag ${p.status}`}>{STATUS_LABELS[p.status]}</span>
          <span className="tag">v{p.version}</span>
          <span className="tag">confianza {p.confidence}</span>
          {!p.meta.active && <span className="tag danger">inactiva</span>}
        </div>
        {p.pendingReview && <div className="banner warn" style={{ marginTop: 12 }}>{p.meta.pendingReviewReason}</div>}
        <p className="sub">{p.description}</p>
        <div className="small">
          <div>
            <strong>Condiciones:</strong> {ruleSummary(p.rule)}
          </div>
          <div>
            <strong>Vigencia:</strong> {p.validFrom} → {p.validUntil ?? 'sin fecha'}
          </div>
          {p.rule.eligibleCustomerSegments && (
            <div>
              <strong>Segmentos:</strong> {p.rule.eligibleCustomerSegments.join(', ')}
            </div>
          )}
          {p.rule.eligibleFuelTypes && (
            <div>
              <strong>Combustibles:</strong> {p.rule.eligibleFuelTypes.map((f) => FUEL_TYPE_LABELS[f]).join(', ')}
            </div>
          )}
          <div>
            <strong>Acumulable:</strong> {p.rule.stackable} · <strong>Varias operaciones por día:</strong> {p.rule.multipleOperationsPerDay}
          </div>
          <div>
            <strong>Fuente:</strong> {p.sourceName ?? '—'}{' '}
            {p.sourceUrl && (
              <a href={p.sourceUrl} target="_blank" rel="noreferrer">
                abrir
              </a>
            )}
          </div>
          <div>
            <strong>Obtenida:</strong> {p.retrievedAt ?? '—'} · <strong>Verificada:</strong> {p.lastVerifiedAt ?? 'nunca'}
          </div>
        </div>
        {p.rule.unknownConditions.length > 0 && (
          <div className="banner warn" style={{ marginTop: 12 }}>
            <strong>No se puede confirmar:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {p.rule.unknownConditions.map((c) => (
                <li key={c}>{UNKNOWN_CONDITION_LABELS[c]}</li>
              ))}
            </ul>
            Revisá la fuente oficial, completá los datos con «Editar» y después verificala.
          </div>
        )}
        <div className="grid2" style={{ marginTop: 12 }}>
          <button className="btn small primary" onClick={() => void setStatus('VERIFIED')} disabled={p.rule.unknownConditions.length > 0}>
            Verificar
          </button>
          <button className="btn small" onClick={() => void setStatus('MANUALLY_REVIEWED')} disabled={p.rule.unknownConditions.length > 0}>
            Marcar revisada
          </button>
          <button className="btn small" onClick={() => setEditing(true)}>
            Editar (nueva versión)
          </button>
          <button className="btn small" onClick={() => void setActive(!p.meta.active)}>
            {p.meta.active ? 'Desactivar' : 'Activar'}
          </button>
          <button className="btn small danger" onClick={() => void setStatus('INVALID')}>
            Marcar inválida
          </button>
          <button className="btn small" onClick={() => void setStatus('STALE')}>
            Marcar desactualizada
          </button>
        </div>
      </div>

      <h2>Historial de versiones</h2>
      <div className="card">
        {data.versions.map((v) => (
          <div className="list-item" key={v.versionId}>
            <div>
              <div className="title">
                v{v.version} · {v.createdAt.slice(0, 10)}
              </div>
              <div className="meta">
                {ruleSummary(v.rule)}
                <br />
                {v.createdBy}
                {v.changeReason ? ` — ${v.changeReason}` : ''}
              </div>
            </div>
            <span className={`tag ${v.status}`}>{STATUS_LABELS[v.status]}</span>
          </div>
        ))}
      </div>

      <h2>Auditoría</h2>
      <div className="card">
        {data.events.map((e) => (
          <div className="list-item" key={e.id}>
            <div>
              <div className="title small">{e.type}</div>
              <div className="meta">
                {new Date(e.at).toLocaleString('es-AR')} · {e.actor}
                {e.detail ? ` — ${e.detail}` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ───────── Editor ─────────

const EMPTY_RULE: PromotionRule = {
  discountType: 'PERCENTAGE',
  discountValue: 0,
  delivery: 'CASHBACK',
  stage: 'PAYMENT',
  caps: [],
  minimumPurchase: null,
  maximumPurchase: null,
  minimumLitres: null,
  usageLimits: [],
  daysOfWeek: null,
  daysOfMonth: null,
  eligibleProviderIds: null,
  eligiblePaymentMethodIds: null,
  eligiblePaymentMethodTypes: null,
  eligibleNetworks: null,
  eligibleFuelTypes: null,
  eligibleStationIds: null,
  eligibleRegions: null,
  excludedRegions: null,
  eligibleCustomerSegments: null,
  requiredLoyaltyProgrammeId: null,
  requiresApp: null,
  requiresQR: false,
  requiresNFC: false,
  requiresSpecificCard: false,
  stackable: 'UNKNOWN',
  stackableWith: [],
  multipleOperationsPerDay: 'UNKNOWN',
  weekStartsOn: 1,
  unknownConditions: [],
  notes: [],
  extra: {},
};

function Checks<T extends string>({ values, selected, label, onChange }: { values: readonly T[]; selected: T[] | null; label: (v: T) => string; onChange: (v: T[] | null) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {values.map((v) => {
        const on = selected?.includes(v) ?? false;
        return (
          <button
            type="button"
            key={v}
            className={`chip ${on ? 'active' : ''}`}
            onClick={() => {
              const next = on ? (selected ?? []).filter((x) => x !== v) : [...(selected ?? []), v];
              onChange(next.length ? next : null);
            }}
          >
            {label(v)}
          </button>
        );
      })}
    </div>
  );
}

function PromotionEditor({ initial, onDone }: { initial: AdminPromotion | null; onDone?: () => void }) {
  const [catalog, setCatalog] = useState<CatalogData | null>(null);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [providerId, setProviderId] = useState(initial?.providerId ?? 'bbva');
  const [fuelBrandId, setFuelBrandId] = useState(initial?.fuelBrandId ?? 'axion');
  const [validFrom, setValidFrom] = useState(initial?.validFrom ?? '');
  const [validUntil, setValidUntil] = useState(initial?.validUntil ?? '');
  const [sourceUrl, setSourceUrl] = useState(initial?.sourceUrl ?? '');
  const [sourceName, setSourceName] = useState(initial?.sourceName ?? '');
  const [status, setStatus] = useState<string>(initial ? (initial.rule.unknownConditions.length ? initial.status : 'VERIFIED') : 'VERIFIED');
  const [rule, setRule] = useState<PromotionRule>(initial?.rule ?? EMPTY_RULE);
  const [valueText, setValueText] = useState(
    initial ? (initial.rule.discountType === 'PERCENTAGE' ? String(initial.rule.discountValue / 100) : pesosText(initial.rule.discountValue)) : '',
  );
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    void api.get<{ catalog: CatalogData }>('/admin/promotions').then((r) => setCatalog(r.data.catalog));
  }, []);

  const set = <K extends keyof PromotionRule>(k: K, v: PromotionRule[K]) => setRule((r) => ({ ...r, [k]: v }));

  const save = async () => {
    const discountValue = rule.discountType === 'PERCENTAGE' ? Math.round(Number(valueText.replace(',', '.')) * 100) : parsePesosInput(valueText) ?? 0;
    const body = {
      name,
      description,
      providerId,
      fuelBrandId: fuelBrandId || null,
      validFrom,
      validUntil: validUntil || null,
      sourceUrl: sourceUrl || null,
      sourceName: sourceName || null,
      status,
      confidence: 'HIGH',
      rule: { ...rule, discountValue },
      changeReason: reason,
    };
    try {
      if (initial) await api.put(`/admin/promotions/${encodeURIComponent(initial.id)}`, body);
      else {
        const r = await api.post<{ promotion: { id: string } }>('/admin/promotions', body);
        window.location.hash = `#/admin/promo/${encodeURIComponent(r.data.promotion.id)}`;
      }
      toast('Guardado');
      onDone?.();
    } catch (e) {
      setErrors([(e as Error).message]);
    }
  };

  if (!catalog) return <div className="skeleton" />;
  return (
    <>
      <header className="topbar">
        <div>
          <a href="#/admin" className="small" onClick={(e) => { if (onDone) { e.preventDefault(); onDone(); } }}>
            ‹ Volver
          </a>
          <h1>{initial ? 'Editar promoción' : 'Nueva promoción'}</h1>
        </div>
      </header>
      {initial && <div className="banner info">Guardar crea una versión nueva; las anteriores quedan en el historial.</div>}
      <div className="card">
        <label className="field">
          <span>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Descripción</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="grid2">
          <label className="field">
            <span>Otorga</span>
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {catalog.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Marca de estación</span>
            <input value={fuelBrandId ?? ''} onChange={(e) => setFuelBrandId(e.target.value)} placeholder="axion (vacío = cualquiera)" />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Desde</span>
            <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>Hasta</span>
            <input type="date" value={validUntil ?? ''} onChange={(e) => setValidUntil(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>URL oficial (bases y condiciones)</span>
          <input value={sourceUrl ?? ''} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://…" />
        </label>
        <label className="field">
          <span>Nombre de la fuente</span>
          <input value={sourceName ?? ''} onChange={(e) => setSourceName(e.target.value)} />
        </label>
      </div>

      <h2>Beneficio</h2>
      <div className="card">
        <div className="grid2">
          <label className="field">
            <span>Tipo</span>
            <select value={rule.discountType} onChange={(e) => set('discountType', e.target.value as PromotionRule['discountType'])}>
              <option value="PERCENTAGE">Porcentaje</option>
              <option value="FIXED_AMOUNT">Monto fijo</option>
              <option value="PER_LITRE">Por litro</option>
            </select>
          </label>
          <label className="field">
            <span>{rule.discountType === 'PERCENTAGE' ? 'Porcentaje (%)' : 'Monto ($)'}</span>
            <input inputMode="decimal" value={valueText} onChange={(e) => setValueText(e.target.value)} />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Entrega</span>
            <select value={rule.delivery} onChange={(e) => set('delivery', e.target.value as PromotionRule['delivery'])}>
              <option value="CASHBACK">Reintegro posterior</option>
              <option value="INSTANT_DISCOUNT">Descuento en el momento</option>
            </select>
          </label>
          <label className="field">
            <span>Etapa</span>
            <select value={rule.stage} onChange={(e) => set('stage', e.target.value as PromotionRule['stage'])}>
              <option value="PAYMENT">Medio de pago (banco/billetera)</option>
              <option value="PRICE">Precio (programa de la estación)</option>
            </select>
          </label>
        </div>

        <div className="field">
          <span>Topes</span>
          {rule.caps.map((c, i) => (
            <div className="grid2" key={i} style={{ gridTemplateColumns: '1fr 1fr auto', alignItems: 'center' }}>
              <input
                inputMode="decimal"
                value={pesosText(c.amount)}
                onChange={(e) => set('caps', rule.caps.map((x, j) => (j === i ? { ...x, amount: parsePesosInput(e.target.value) ?? 0 } : x)))}
                placeholder="$"
              />
              <select value={c.period} onChange={(e) => set('caps', rule.caps.map((x, j) => (j === i ? { ...x, period: e.target.value as typeof c.period } : x)))}>
                {CAP_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {CAP_PERIOD_LABELS[p]}
                  </option>
                ))}
              </select>
              <button type="button" className="btn small danger" onClick={() => set('caps', rule.caps.filter((_, j) => j !== i))}>
                ✕
              </button>
              <input
                style={{ gridColumn: '1 / -1' }}
                value={c.poolId ?? ''}
                onChange={(e) => set('caps', rule.caps.map((x, j) => (j === i ? { ...x, poolId: e.target.value || null } : x)))}
                placeholder="Tope compartido (id de pool, opcional)"
              />
            </div>
          ))}
          <button type="button" className="btn small" onClick={() => set('caps', [...rule.caps, { amount: 0, period: 'MONTHLY', poolId: null }])}>
            + Agregar tope
          </button>
        </div>

        <div className="field">
          <span>Límites de operaciones</span>
          {rule.usageLimits.map((u, i) => (
            <div className="grid2" key={i} style={{ gridTemplateColumns: '1fr 1fr auto' }}>
              <input
                inputMode="numeric"
                value={u.maxTransactions}
                onChange={(e) => set('usageLimits', rule.usageLimits.map((x, j) => (j === i ? { ...x, maxTransactions: Number(e.target.value) || 1 } : x)))}
              />
              <select value={u.period} onChange={(e) => set('usageLimits', rule.usageLimits.map((x, j) => (j === i ? { ...x, period: e.target.value as typeof u.period } : x)))}>
                {CAP_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {CAP_PERIOD_LABELS[p]}
                  </option>
                ))}
              </select>
              <button type="button" className="btn small danger" onClick={() => set('usageLimits', rule.usageLimits.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="btn small" onClick={() => set('usageLimits', [...rule.usageLimits, { maxTransactions: 1, period: 'WEEKLY' }])}>
            + Agregar límite
          </button>
        </div>

        <div className="grid2">
          <label className="field">
            <span>Compra mínima ($)</span>
            <input inputMode="decimal" value={pesosText(rule.minimumPurchase)} onChange={(e) => set('minimumPurchase', parsePesosInput(e.target.value))} />
          </label>
          <label className="field">
            <span>Compra máxima con beneficio ($)</span>
            <input inputMode="decimal" value={pesosText(rule.maximumPurchase)} onChange={(e) => set('maximumPurchase', parsePesosInput(e.target.value))} />
          </label>
        </div>
      </div>

      <h2>Condiciones</h2>
      <div className="card">
        <div className="field">
          <span>Días (ninguno = todos)</span>
          <Checks values={['1', '2', '3', '4', '5', '6', '7'] as const} selected={rule.daysOfWeek?.map(String) as never} label={(v) => formatWeekdays([Number(v)]).slice(0, 3)} onChange={(v) => set('daysOfWeek', v ? (v.map(Number) as PromotionRule['daysOfWeek']) : null)} />
        </div>
        <div className="field">
          <span>Bancos / proveedores del medio de pago (ninguno = cualquiera)</span>
          <Checks values={catalog.providers.map((p) => p.id)} selected={rule.eligibleProviderIds} label={(v) => catalog.providers.find((p) => p.id === v)?.name ?? v} onChange={(v) => set('eligibleProviderIds', v)} />
        </div>
        <div className="field">
          <span>Tipo de tarjeta</span>
          <Checks values={PAYMENT_METHOD_TYPES} selected={rule.eligiblePaymentMethodTypes} label={(v) => PAYMENT_METHOD_TYPE_LABELS[v]} onChange={(v) => set('eligiblePaymentMethodTypes', v)} />
        </div>
        <div className="field">
          <span>Red</span>
          <Checks values={['VISA', 'MASTERCARD', 'AMEX', 'CABAL'] as const} selected={rule.eligibleNetworks as never} label={(v) => v} onChange={(v) => set('eligibleNetworks', v)} />
        </div>
        <div className="field">
          <span>Combustibles (ninguno = todos)</span>
          <Checks values={FUEL_TYPES} selected={rule.eligibleFuelTypes} label={(v) => FUEL_TYPE_LABELS[v]} onChange={(v) => set('eligibleFuelTypes', v)} />
        </div>
        <div className="field">
          <span>Segmentos (el usuario debe tener alguno)</span>
          <Checks values={catalog.segments.map((s) => s.id)} selected={rule.eligibleCustomerSegments} label={(v) => catalog.segments.find((s) => s.id === v)?.name ?? v} onChange={(v) => set('eligibleCustomerSegments', v)} />
        </div>
        <div className="grid2">
          <label className="field">
            <span>Requiere programa</span>
            <select value={rule.requiredLoyaltyProgrammeId ?? ''} onChange={(e) => set('requiredLoyaltyProgrammeId', e.target.value || null)}>
              <option value="">No</option>
              {catalog.programmes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Requiere app</span>
            <select value={rule.requiresApp ?? ''} onChange={(e) => set('requiresApp', e.target.value || null)}>
              <option value="">No</option>
              {catalog.apps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={rule.requiresQR} onChange={(e) => set('requiresQR', e.target.checked)} /> Requiere QR
        </label>
        <label className="check">
          <input type="checkbox" checked={rule.requiresNFC} onChange={(e) => set('requiresNFC', e.target.checked)} /> Requiere NFC
        </label>
        <div className="grid2" style={{ marginTop: 10 }}>
          <label className="field">
            <span>¿Acumulable?</span>
            <select value={rule.stackable} onChange={(e) => set('stackable', e.target.value as PromotionRule['stackable'])}>
              <option value="UNKNOWN">No se sabe</option>
              <option value="YES">Sí</option>
              <option value="NO">No</option>
            </select>
          </label>
          <label className="field">
            <span>¿Varias operaciones por día?</span>
            <select value={rule.multipleOperationsPerDay} onChange={(e) => set('multipleOperationsPerDay', e.target.value as PromotionRule['multipleOperationsPerDay'])}>
              <option value="UNKNOWN">No se sabe</option>
              <option value="YES">Sí</option>
              <option value="NO">No</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>Provincias excluidas (códigos separados por coma)</span>
          <input value={(rule.excludedRegions ?? []).join(', ')} onChange={(e) => set('excludedRegions', e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).length ? e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null)} />
        </label>
        <label className="field">
          <span>Instrucciones para el usuario (una por línea)</span>
          <textarea value={rule.notes.join('\n')} onChange={(e) => set('notes', e.target.value.split('\n'))} />
        </label>
        <div className="field">
          <span>Condiciones que NO se pueden confirmar</span>
          <Checks values={UNKNOWN_CONDITIONS} selected={rule.unknownConditions} label={(v) => UNKNOWN_CONDITION_LABELS[v]} onChange={(v) => set('unknownConditions', v ?? [])} />
        </div>
      </div>

      <h2>Estado</h2>
      <div className="card">
        <label className="field">
          <span>Estado</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {PROMOTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        {initial && (
          <label className="field">
            <span>Motivo del cambio</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej. el banco bajó el tope" />
          </label>
        )}
        {errors.length > 0 && <div className="banner danger">{errors.join(' ')}</div>}
        <button className="btn primary block" onClick={save}>
          Guardar
        </button>
      </div>
    </>
  );
}
