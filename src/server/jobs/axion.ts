/**
 * Jobs de Axion:
 *  - watchAxionBenefits: vigila los bloques de la página oficial de beneficios.
 *    Un bloque nuevo, modificado o eliminado genera un candidato para revisión y
 *    marca como "pendiente de revisión" a las promociones vinculadas. Nunca
 *    modifica promociones por su cuenta.
 *  - syncAxionStations: actualiza el catálogo de estaciones desde el localizador
 *    oficial y avisa si cambió la lista de estaciones adheridas a ON.
 */
import type { Clock } from '../../core/time';
import { all, type DB, get, run } from '../db/db';
import { listBySource, setPendingReview } from '../db/promotions';
import { upsertStations } from '../db/stations';
import { AXION_BENEFITS_PAGE, fetchAxionStations, fetchBenefitBlocks } from '../sources/axion';
import type { SourceContext } from '../sources/types';
import { SourceError } from '../sources/types';

export const AXION_BENEFITS_SOURCE = { id: 'axion-beneficios', name: 'Axion energy — Beneficios y promociones (API oficial)', kind: 'STRUCTURED_FEED', providerId: 'axion-on' };
export const AXION_STATIONS_SOURCE = { id: 'axion-estaciones', name: 'Axion energy — Localizador de estaciones (API oficial)', kind: 'STRUCTURED_FEED', providerId: null };

function ensureSource(db: DB, s: { id: string; name: string; kind: string; providerId: string | null }) {
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

function startRun(db: DB, sourceId: string, now: string): number {
  return Number(run(db, `INSERT INTO import_run (source_id, started_at, status) VALUES (?,?, 'RUNNING')`, sourceId, now).lastInsertRowid);
}

function failRun(db: DB, clock: Clock, sourceId: string, runId: number, message: string) {
  const now = clock.now().toISOString();
  run(db, `UPDATE import_run SET status = 'FAILED', finished_at = ?, error = ? WHERE id = ?`, now, message, runId);
  run(db, 'UPDATE source SET last_attempt_at = ?, consecutive_failures = consecutive_failures + 1, last_error = ? WHERE id = ?', now, message, sourceId);
}

function okRun(db: DB, clock: Clock, sourceId: string, runId: number, status: string, counts: { created: number; changed: number; unchanged: number }, warnings: unknown[] = []) {
  const now = clock.now().toISOString();
  run(
    db,
    `UPDATE import_run SET status = ?, finished_at = ?, created = ?, changed = ?, unchanged = ?, warnings_json = ? WHERE id = ?`,
    status,
    now,
    counts.created,
    counts.changed,
    counts.unchanged,
    JSON.stringify(warnings),
    runId,
  );
  run(db, 'UPDATE source SET last_attempt_at = ?, last_success_at = ?, consecutive_failures = 0, last_error = NULL WHERE id = ?', now, now, sourceId);
}

function linkedPromotions(db: DB, blockKey: string) {
  return listBySource(db, AXION_BENEFITS_SOURCE.id).filter((p) => p.meta.active && (p.meta.sourceKey ?? '').split('#')[0] === blockKey);
}

export interface WatchSummary {
  status: 'SUCCESS' | 'NO_CHANGES' | 'FAILED';
  blocks: number;
  created: number;
  changed: number;
  missing: number;
  error?: string;
}

export async function watchAxionBenefits(db: DB, clock: Clock, ctx: SourceContext): Promise<WatchSummary> {
  const src = AXION_BENEFITS_SOURCE;
  ensureSource(db, src);
  const runId = startRun(db, src.id, clock.now().toISOString());
  let blocks;
  try {
    blocks = (await fetchBenefitBlocks(ctx)).blocks;
  } catch (e) {
    const msg = e instanceof SourceError ? e.message : `Error inesperado: ${(e as Error).message}`;
    failRun(db, clock, src.id, runId, msg);
    return { status: 'FAILED', blocks: 0, created: 0, changed: 0, missing: 0, error: msg };
  }
  const now = clock.now().toISOString();
  const summary: WatchSummary = { status: 'NO_CHANGES', blocks: blocks.length, created: 0, changed: 0, missing: 0 };
  const firstRun = !get(db, 'SELECT 1 FROM source_watch WHERE source_id = ? LIMIT 1', src.id);
  const candidate = (kind: 'NEW' | 'CHANGED' | 'MISSING', key: string, payload: unknown, promotionId: string | null) =>
    run(
      db,
      `INSERT INTO import_candidate (import_run_id, source_id, source_key, promotion_id, kind, payload_json, created_at) VALUES (?,?,?,?,?,?,?)`,
      runId,
      src.id,
      key,
      promotionId,
      kind,
      JSON.stringify(payload),
      now,
    );

  for (const b of blocks) {
    const prev = get(db, 'SELECT * FROM source_watch WHERE source_id = ? AND block_key = ?', src.id, b.key);
    if (!prev) {
      run(
        db,
        'INSERT INTO source_watch (source_id, block_key, title, text, text_hash, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)',
        src.id,
        b.key,
        b.title,
        b.text,
        b.hash,
        now,
        now,
      );
      // En la primera ejecución todo es "nuevo": se registra como línea de base sin avisar.
      if (!firstRun) {
        candidate('NEW', b.key, { title: b.title, text: b.text, sourceUrl: AXION_BENEFITS_PAGE }, null);
        summary.created++;
      }
      continue;
    }
    if (prev.text_hash === b.hash) {
      run(db, 'UPDATE source_watch SET last_seen_at = ?, missing_since = NULL WHERE source_id = ? AND block_key = ?', now, src.id, b.key);
      continue;
    }
    summary.changed++;
    run(db, 'UPDATE source_watch SET title = ?, text = ?, text_hash = ?, last_seen_at = ?, missing_since = NULL WHERE source_id = ? AND block_key = ?', b.title, b.text, b.hash, now, src.id, b.key);
    const linked = linkedPromotions(db, b.key);
    candidate('CHANGED', b.key, { title: b.title, text: b.text, previousText: prev.text, sourceUrl: AXION_BENEFITS_PAGE }, linked[0]?.id ?? null);
    for (const p of linked) setPendingReview(db, clock, p.id, `Axion cambió el texto de «${b.title}»: revisá las condiciones.`, `import:${src.id}`);
  }

  const seen = new Set(blocks.map((b) => b.key));
  for (const w of all(db, 'SELECT * FROM source_watch WHERE source_id = ? AND missing_since IS NULL', src.id)) {
    if (seen.has(w.block_key)) continue;
    summary.missing++;
    run(db, 'UPDATE source_watch SET missing_since = ? WHERE source_id = ? AND block_key = ?', now, src.id, w.block_key);
    const linked = linkedPromotions(db, w.block_key).filter((p) => !p.validUntil || p.validUntil >= now.slice(0, 10));
    candidate('MISSING', w.block_key, { title: w.title, text: w.text, sourceUrl: AXION_BENEFITS_PAGE }, linked[0]?.id ?? null);
    for (const p of linked) setPendingReview(db, clock, p.id, `«${w.title}» ya no aparece en la página oficial de Axion.`, `import:${src.id}`);
  }
  // Las promociones vinculadas a bloques presentes y sin cambios quedan re-confirmadas por la fuente.
  for (const b of blocks)
    for (const p of linkedPromotions(db, b.key))
      run(db, 'UPDATE promotion_version SET retrieved_at = ? WHERE id = ?', now, p.versionId);

  if (summary.created + summary.changed + summary.missing > 0) summary.status = 'SUCCESS';
  okRun(db, clock, src.id, runId, summary.status, { created: summary.created, changed: summary.changed, unchanged: blocks.length - summary.created - summary.changed });
  return summary;
}

export interface StationSyncSummary {
  status: 'SUCCESS' | 'FAILED';
  stations: number;
  onChangedFor: string[];
  error?: string;
}

/** Promociones cuya lista de estaciones sale de un atributo del localizador (extra.stationAttribute). */
export async function syncAxionStations(db: DB, clock: Clock, ctx: SourceContext): Promise<StationSyncSummary> {
  const src = AXION_STATIONS_SOURCE;
  ensureSource(db, src);
  const runId = startRun(db, src.id, clock.now().toISOString());
  let stations;
  try {
    stations = await fetchAxionStations(ctx);
  } catch (e) {
    const msg = e instanceof SourceError ? e.message : `Error inesperado: ${(e as Error).message}`;
    failRun(db, clock, src.id, runId, msg);
    return { status: 'FAILED', stations: 0, onChangedFor: [], error: msg };
  }
  upsertStations(db, stations, src.id);
  // estaciones del catálogo que ya no publica el localizador
  const ids = new Set(stations.map((s) => s.id));
  for (const r of all(db, `SELECT id FROM station WHERE source = ? AND active = 1`, src.id)) if (!ids.has(r.id)) run(db, 'UPDATE station SET active = 0 WHERE id = ?', r.id);

  const changed: string[] = [];
  for (const p of listBySource(db, AXION_BENEFITS_SOURCE.id)) {
    const attr = p.rule.extra?.stationAttribute;
    if (typeof attr !== 'string' || !p.meta.active) continue;
    const current = stations.filter((s) => s.attributes?.[attr] === true).map((s) => s.id).sort();
    const listed = [...(p.rule.eligibleStationIds ?? [])].sort();
    if (current.join(',') !== listed.join(',')) {
      changed.push(p.id);
      setPendingReview(db, clock, p.id, `Cambió la lista de estaciones adheridas (${listed.length} → ${current.length}) según el localizador oficial.`, `import:${src.id}`);
    }
  }
  okRun(db, clock, src.id, runId, changed.length ? 'SUCCESS' : 'NO_CHANGES', { created: 0, changed: changed.length, unchanged: stations.length });
  return { status: 'SUCCESS', stations: stations.length, onChangedFor: changed };
}
