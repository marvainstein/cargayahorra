import { useEffect, useState } from 'react';
import { STATUS_LABELS } from '../../core/labels';
import type { PromotionStatus } from '../../core/types';
import { api } from '../api';
import { ErrorBox, relativeTime } from '../components/ui';

const REPO = 'https://github.com/marvainstein/cargayahorra';

interface Status {
  generatedAt: string;
  promotions: Array<{ id: string; name: string; status: PromotionStatus; pendingReview: boolean; sourceUrl: string | null; validFrom: string; validUntil: string | null; lastVerifiedAt: string | null }>;
  sources: Array<{ id: string; name: string; lastSuccessAt: string | null; consecutiveFailures: number; lastError: string | null; configured: boolean; lastAttemptAt?: string | null }>;
  review: Array<{ promotionId: string; name: string; status: string; reason: string | null }>;
  candidates: Array<{ kind: string; sourceId: string; title: string | null }>;
  stations: number;
}

/** Estado de los datos publicados: fuentes, verificaciones y pendientes de revisión. */
export function Estado() {
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<Status>('/status')
      .then((r) => setS(r.data))
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <>
      <header className="topbar">
        <div>
          <a href="#/settings" className="small">
            ‹ Ajustes
          </a>
          <h1>Estado de los datos</h1>
        </div>
      </header>
      {error && <ErrorBox error={error} />}
      {s && (
        <>
          <div className="banner info">
            Datos publicados {relativeTime(s.generatedAt)} ({new Date(s.generatedAt).toLocaleString('es-AR')}). Se actualizan solos cada 6 horas desde las fuentes oficiales.
          </div>
          {(s.review.length > 0 || s.candidates.length > 0) && (
            <div className="banner warn">
              <strong>Hay cambios para revisar.</strong> Las promociones afectadas no se usan para recomendar hasta revisarlas.
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {s.review.map((r) => (
                  <li key={r.promotionId}>
                    {r.name}
                    {r.reason ? `: ${r.reason}` : ''}
                  </li>
                ))}
                {s.candidates.map((c, i) => (
                  <li key={i}>
                    Cambio en {c.sourceId}: {c.title ?? c.kind}
                  </li>
                ))}
              </ul>
              <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">
                Ver en GitHub
              </a>
            </div>
          )}

          <h2>Fuentes</h2>
          <div className="card">
            {s.sources.map((src) => {
              const ok = src.consecutiveFailures === 0 && !!src.lastSuccessAt;
              return (
                <div className="list-item" key={src.id}>
                  <div>
                    <div className="title">
                      {!src.configured ? '○' : ok ? '✓' : '⚠'} {src.name}
                    </div>
                    <div className="meta">
                      {!src.configured
                        ? 'Sin fuente automática: se carga a mano.'
                        : ok
                          ? `Actualizado ${relativeTime(src.lastSuccessAt)}`
                          : `Actualización fallida${src.lastSuccessAt ? ` · última correcta ${relativeTime(src.lastSuccessAt)}` : ''}`}
                      {src.lastError && src.configured && <div style={{ color: 'var(--danger)' }}>{src.lastError}</div>}
                    </div>
                  </div>
                </div>
              );
            })}
            <p className="small muted" style={{ marginBottom: 0 }}>
              {s.stations} estaciones en el catálogo oficial de Axion.
            </p>
          </div>

          <h2>Promociones</h2>
          <div className="card">
            {s.promotions.map((p) => (
              <div className="list-item" key={p.id}>
                <div>
                  <div className="title">{p.name}</div>
                  <div className="meta">
                    {p.validFrom} → {p.validUntil ?? 'sin fecha'}
                    {p.lastVerifiedAt ? ` · verificada ${new Date(p.lastVerifiedAt).toLocaleDateString('es-AR')}` : ''}
                    {p.sourceUrl && (
                      <>
                        {' · '}
                        <a href={p.sourceUrl} target="_blank" rel="noreferrer">
                          fuente
                        </a>
                      </>
                    )}
                  </div>
                </div>
                <span className={`tag ${p.pendingReview ? 'warn' : p.status}`}>{p.pendingReview ? 'para revisar' : STATUS_LABELS[p.status]}</span>
              </div>
            ))}
            <p className="small muted" style={{ marginBottom: 0 }}>
              Detalle de cada verificación:{' '}
              <a href={`${REPO}/blob/main/docs/VERIFICACION.md`} target="_blank" rel="noreferrer">
                docs/VERIFICACION.md
              </a>
            </p>
          </div>
        </>
      )}
    </>
  );
}
