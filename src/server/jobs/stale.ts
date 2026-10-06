/**
 * Detección de información desactualizada.
 *
 *  - Si una fuente no se actualiza con éxito durante STALE_AFTER_HOURS, todas
 *    sus promociones pasan a STALE (nunca se muestran como confirmadas).
 *  - Si una promoción importada no se re-verifica hace STALE_AFTER_HOURS,
 *    también pasa a STALE.
 *  - Una verificación reciente (humana o de la fuente, < VERIFICATION_VALID_DAYS)
 *    evita marcarla, para no obligar a re-verificar cada 3 días.
 * Las promociones cargadas a mano (sin fuente) no caducan por esto: tienen su
 * propia vigencia (validUntil).
 */
import type { Clock } from '../../core/time';
import { all, type DB } from '../db/db';
import { getPromotion, setStatus } from '../db/promotions';

export const DEFAULT_STALE_AFTER_HOURS = 72;
/** Una verificación (humana o confirmada por la fuente) vale este tiempo aunque la fuente falle. */
export const VERIFICATION_VALID_DAYS = 14;

export interface StaleReport {
  staleSources: string[];
  markedStale: string[];
}

export function detectStale(db: DB, clock: Clock, staleAfterHours = DEFAULT_STALE_AFTER_HOURS): StaleReport {
  const now = clock.now().getTime();
  const limit = staleAfterHours * 3_600_000;
  const report: StaleReport = { staleSources: [], markedStale: [] };

  for (const s of all(db, 'SELECT * FROM source WHERE enabled = 1')) {
    const promos = all(db, 'SELECT id FROM promotion WHERE source_id = ? AND active = 1', s.id).map((r) => getPromotion(db, r.id)!).filter(Boolean);
    if (promos.length === 0) continue;
    const lastSuccess = s.last_success_at ? Date.parse(s.last_success_at) : 0;
    const sourceStale = now - lastSuccess > limit;
    if (sourceStale) report.staleSources.push(s.id);
    for (const p of promos) {
      if (p.status === 'STALE' || p.status === 'INVALID') continue;
      const checked = p.retrievedAt ? Date.parse(p.retrievedAt) : 0;
      const verified = p.lastVerifiedAt ? Date.parse(p.lastVerifiedAt) : 0;
      const verificationFresh = now - verified <= VERIFICATION_VALID_DAYS * 86_400_000;
      if (!verificationFresh && (sourceStale || now - checked > limit)) {
        const since = s.last_success_at ? `última actualización correcta: ${s.last_success_at}` : 'la fuente nunca se actualizó con éxito';
        setStatus(db, clock, p.id, 'STALE', 'job:stale', `prev=${p.status}; ${since}`);
        report.markedStale.push(p.id);
      }
    }
  }
  return report;
}
