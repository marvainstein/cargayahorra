/**
 * Pipeline: fuente → parser → validación → base de datos.
 *
 * Reglas de seguridad:
 *  - Si la validación detecta un cambio de estructura, no se modifica nada.
 *  - Una promoción nueva entra como AUTOMATICALLY_IMPORTED (nunca verificada).
 *  - Si una promoción ya revisada cambia en la fuente, NO se sobrescribe: se
 *    crea un candidato pendiente de revisión y la promoción queda marcada
 *    (el motor deja de usarla como definitiva hasta que alguien la revise).
 *  - Si una promoción desaparece de la fuente, se marca para revisión.
 */
import type { Clock } from '../../core/time';
import type { Promotion } from '../../core/types';
import { all, type DB, get, run } from '../db/db';
import {
  addVersion,
  createPromotion,
  findBySourceKey,
  getPromotion,
  listBySource,
  listEvents,
  setPendingReview,
  setStatus,
  touchVerified,
} from '../db/promotions';
import type { ParsedPromotion, PromotionSource, SourceContext, ValidationIssue } from '../sources/types';
import { SourceError } from '../sources/types';

export interface ImportSummary {
  sourceId: string;
  status: 'SUCCESS' | 'NO_CHANGES' | 'PARTIAL' | 'FAILED' | 'NOT_CONFIGURED';
  created: number;
  changed: number;
  unchanged: number;
  missing: number;
  issues: ValidationIssue[];
  error?: string;
}

export function ensureSourceRow(db: DB, s: PromotionSource) {
  run(
    db,
    `INSERT INTO source (id, name, kind, provider_id) VALUES (?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, provider_id = excluded.provider_id`,
    s.id,
    s.name,
    s.kind,
    s.providerId,
  );
}

/** Representación comparable de las condiciones (ignora metadatos de importación). */
export function comparableTerms(p: Pick<Promotion, 'providerId' | 'validFrom' | 'validUntil' | 'rule'>): string {
  const r = p.rule;
  const norm = (xs: unknown[] | null) => (xs ? [...xs].map(String).sort() : null);
  return JSON.stringify({
    providerId: p.providerId,
    validFrom: p.validFrom,
    validUntil: p.validUntil,
    discountType: r.discountType,
    discountValue: r.discountValue,
    delivery: r.delivery,
    stage: r.stage,
    caps: [...r.caps].map((c) => `${c.period}:${c.amount}:${c.poolId ?? ''}`).sort(),
    minimumPurchase: r.minimumPurchase,
    maximumPurchase: r.maximumPurchase,
    minimumLitres: r.minimumLitres,
    usageLimits: [...r.usageLimits].map((u) => `${u.period}:${u.maxTransactions}`).sort(),
    daysOfWeek: norm(r.daysOfWeek),
    daysOfMonth: norm(r.daysOfMonth),
    types: norm(r.eligiblePaymentMethodTypes),
    networks: norm(r.eligibleNetworks),
    fuels: norm(r.eligibleFuelTypes),
    excludedRegions: norm(r.excludedRegions),
    segments: norm(r.eligibleCustomerSegments),
    stackable: r.stackable,
    unknown: norm(r.unknownConditions),
  });
}

function recordCandidate(db: DB, runId: number, sourceId: string, p: ParsedPromotion | null, sourceKey: string, promotionId: string | null, kind: 'NEW' | 'CHANGED' | 'MISSING', now: string) {
  run(
    db,
    `INSERT INTO import_candidate (import_run_id, source_id, source_key, promotion_id, kind, payload_json, created_at) VALUES (?,?,?,?,?,?,?)`,
    runId,
    sourceId,
    sourceKey,
    promotionId,
    kind,
    JSON.stringify(p ? { draft: p.draft, warnings: p.warnings } : {}),
    now,
  );
}

export async function importFromSource(db: DB, clock: Clock, source: PromotionSource, ctx: SourceContext): Promise<ImportSummary> {
  ensureSourceRow(db, source);
  const started = clock.now().toISOString();
  const summary: ImportSummary = { sourceId: source.id, status: 'SUCCESS', created: 0, changed: 0, unchanged: 0, missing: 0, issues: [] };

  if (!source.isConfigured()) {
    run(db, 'UPDATE source SET last_attempt_at = ?, last_error = ? WHERE id = ?', started, 'Fuente sin configurar (falta URL oficial).', source.id);
    return { ...summary, status: 'NOT_CONFIGURED', error: 'Fuente sin configurar (falta URL oficial).' };
  }

  const runId = Number(
    run(db, `INSERT INTO import_run (source_id, started_at, status) VALUES (?,?, 'RUNNING')`, source.id, started).lastInsertRowid,
  );
  const fail = (message: string): ImportSummary => {
    const now = clock.now().toISOString();
    run(db, `UPDATE import_run SET status = 'FAILED', finished_at = ?, error = ?, warnings_json = ? WHERE id = ?`, now, message, JSON.stringify(summary.issues), runId);
    run(
      db,
      'UPDATE source SET last_attempt_at = ?, consecutive_failures = consecutive_failures + 1, last_error = ? WHERE id = ?',
      now,
      message,
      source.id,
    );
    return { ...summary, status: 'FAILED', error: message };
  };

  let docs;
  try {
    docs = await source.fetch(ctx);
  } catch (e) {
    return fail(e instanceof SourceError ? e.message : `Error inesperado: ${(e as Error).message}`);
  }

  let parsed: ParsedPromotion[];
  try {
    parsed = source.parse(docs, ctx);
  } catch (e) {
    return fail(`Error al interpretar la fuente: ${(e as Error).message}`);
  }
  const validation = source.validate(parsed, docs);
  summary.issues = validation.issues;
  run(db, 'UPDATE import_run SET documents = ?, parsed = ?, valid = ? WHERE id = ?', docs.length, parsed.length, validation.valid.length, runId);

  const prev = get(db, 'SELECT structure_fingerprint FROM source WHERE id = ?', source.id);
  if (prev?.structure_fingerprint && validation.fingerprint && prev.structure_fingerprint !== validation.fingerprint) {
    summary.issues.push({ level: 'WARNING', message: 'La estructura de la página cambió desde la última importación: revisá los resultados.' });
  }
  if (!validation.structureOk) return fail('La fuente cambió de estructura o no contiene promociones reconocibles. No se modificó ninguna promoción.');

  const now = clock.now().toISOString();
  const seen = new Set<string>();
  for (const p of validation.valid) {
    seen.add(p.sourceKey);
    const existing = findBySourceKey(db, source.id, p.sourceKey);
    if (!existing) {
      createPromotion(db, clock, p.draft, { sourceId: source.id, sourceKey: p.sourceKey, actor: `import:${source.id}`, reason: 'Importada automáticamente' });
      recordCandidate(db, runId, source.id, p, p.sourceKey, null, 'NEW', now);
      summary.created++;
      continue;
    }
    if (comparableTerms(existing) === comparableTerms(p.draft)) {
      touchVerified(db, clock, existing.id, p.draft.retrievedAt ?? now);
      restoreIfStale(db, clock, existing.id, source.id);
      summary.unchanged++;
      continue;
    }
    summary.changed++;
    if (existing.status === 'AUTOMATICALLY_IMPORTED' && !existing.pendingReview) {
      // Nunca fue revisada: se versiona directamente (sigue sin estar confirmada).
      addVersion(db, clock, existing.id, p.draft, { actor: `import:${source.id}`, reason: 'Cambio detectado en la fuente' });
    } else {
      recordCandidate(db, runId, source.id, p, p.sourceKey, existing.id, 'CHANGED', now);
      setPendingReview(db, clock, existing.id, 'La fuente publicó condiciones distintas: revisá el cambio pendiente.', `import:${source.id}`);
    }
  }

  // Promociones que ya no aparecen
  if (validation.valid.length > 0) {
    for (const p of listBySource(db, source.id)) {
      if (!p.meta.active || !p.meta.sourceKey || seen.has(p.meta.sourceKey)) continue;
      if (p.validUntil && p.validUntil < now.slice(0, 10)) continue; // vencida: es esperable que desaparezca
      if (!p.pendingReview) {
        recordCandidate(db, runId, source.id, null, p.meta.sourceKey, p.id, 'MISSING', now);
        setPendingReview(db, clock, p.id, 'La promoción ya no aparece en la fuente oficial.', `import:${source.id}`);
        summary.missing++;
      }
    }
  }

  const hasErrors = validation.issues.some((i) => i.level === 'ERROR');
  summary.status = hasErrors ? 'PARTIAL' : summary.created + summary.changed + summary.missing === 0 ? 'NO_CHANGES' : 'SUCCESS';
  run(
    db,
    `UPDATE import_run SET status = ?, finished_at = ?, created = ?, changed = ?, unchanged = ?, warnings_json = ? WHERE id = ?`,
    summary.status,
    clock.now().toISOString(),
    summary.created,
    summary.changed,
    summary.unchanged,
    JSON.stringify(summary.issues),
    runId,
  );
  run(
    db,
    'UPDATE source SET last_attempt_at = ?, last_success_at = ?, consecutive_failures = 0, last_error = NULL, structure_fingerprint = ? WHERE id = ?',
    now,
    now,
    validation.fingerprint,
    source.id,
  );
  return summary;
}

/** Si la promoción estaba STALE por falla de la fuente y la fuente la confirma igual, vuelve a su estado previo. */
function restoreIfStale(db: DB, clock: Clock, promotionId: string, sourceId: string) {
  const p = getPromotion(db, promotionId);
  if (!p || p.status !== 'STALE') return;
  const ev = listEvents(db, promotionId).find((e) => e.type === 'STATUS_STALE');
  const prev = ev?.detail && /prev=(\w+)/.exec(ev.detail)?.[1];
  if (prev === 'VERIFIED' || prev === 'MANUALLY_REVIEWED' || prev === 'AUTOMATICALLY_IMPORTED')
    setStatus(db, clock, promotionId, prev, `import:${sourceId}`, 'La fuente volvió a confirmar las mismas condiciones.');
}

export async function importAll(db: DB, clock: Clock, sources: PromotionSource[], ctx: SourceContext): Promise<ImportSummary[]> {
  const out: ImportSummary[] = [];
  for (const s of sources) out.push(await importFromSource(db, clock, s, ctx));
  return out;
}

export function pendingCandidates(db: DB) {
  return all(db, `SELECT * FROM import_candidate WHERE status = 'PENDING_REVIEW' ORDER BY id DESC`).map((c) => ({
    id: Number(c.id),
    importRunId: Number(c.import_run_id),
    sourceId: c.source_id,
    sourceKey: c.source_key,
    promotionId: c.promotion_id ?? null,
    kind: c.kind,
    payload: JSON.parse(c.payload_json),
    createdAt: c.created_at,
  }));
}
