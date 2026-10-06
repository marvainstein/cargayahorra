import { type ReactNode, useEffect, useState } from 'react';
import { formatARS } from '../../core/money';

export const ars = (cents: number | null | undefined) => (cents == null ? '—' : formatARS(cents));

/** Texto en pesos (sin centavos) → centavos. "50.000" → 5_000_000. */
export function parsePesosInput(text: string): number | null {
  const clean = text.replace(/[^\d,]/g, '').replace(',', '.');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function pesosText(cents: number | null | undefined): string {
  if (cents == null) return '';
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(cents / 100);
}

/** "martes, 6 de octubre" → "Martes, 6 de octubre" */
export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'nunca';
  const diff = Date.now() - Date.parse(iso);
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 6 }}>
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

let toastSetter: ((m: string | null) => void) | null = null;
export function toast(message: string) {
  toastSetter?.(message);
}
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    toastSetter = setMsg;
    return () => {
      toastSetter = null;
    };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3200);
    return () => clearTimeout(t);
  }, [msg]);
  return msg ? (
    <div className="toast" role="status">
      {msg}
    </div>
  ) : null;
}

export function OfflineBanner({ since }: { since: string | null }) {
  if (!since) return null;
  return (
    <div className="banner danger">
      <strong>Sin conexión.</strong> Estos datos son de {since !== 'desconocida' ? new Date(since).toLocaleString('es-AR') : 'una consulta anterior'} y pueden estar
      desactualizados. No los tomes como confirmados.
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="banner danger">
      {error}
      {onRetry && (
        <div style={{ marginTop: 8 }}>
          <button className="btn small" onClick={onRetry}>
            Reintentar
          </button>
        </div>
      )}
    </div>
  );
}

export function Tri({ value, onChange }: { value: string; onChange: (v: 'YES' | 'NO' | 'UNKNOWN') => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {(
        [
          ['YES', 'Sí'],
          ['NO', 'No'],
          ['UNKNOWN', 'No sé'],
        ] as const
      ).map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'active' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}
