/**
 * Genera los datos de la web estática (GitHub Pages).
 *
 *   npm run data            # consulta las fuentes y publica public/data/app-data.json
 *   npm run data -- --offline   # sin consultar fuentes (sólo datos verificados del repo)
 *
 * Cada corrida parte de las promociones verificadas del repositorio (seed) y de
 * un estado mínimo entre corridas (salud de las fuentes, en .state/). Si una
 * fuente cambió, las promociones vinculadas salen marcadas "pendiente de
 * revisión" y se escribe .state/review.md para abrir un issue. Nada se
 * reemplaza solo: corregir una promoción = cambiarla en el repo.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { systemClock } from '../core/time';
import { all, run } from './db/db';
import { loadPromotions } from './db/promotions';
import { loadCatalog } from './db/user';
import { createContext, loadConfig } from './context';
import { syncAxionStations, watchAxionBenefits } from './jobs/axion';
import { updateFuelPrices } from './jobs/fuel-prices';
import { importAll, pendingCandidates } from './jobs/import-promotions';
import { detectStale } from './jobs/stale';
import { fuelPriceRows, sourceHealth } from './services';

export const APP_DATA_VERSION = 1;

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const stateDir = args.find((a) => a.startsWith('--state='))?.slice(8) ?? '.state';
const outFile = args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'public/data/app-data.json';

async function main() {
  const config = { ...loadConfig(), dbPath: ':memory:', enableScheduler: false };
  const ctx = createContext(config, systemClock);
  const log = (m: string) => console.log(m);

  // Estado entre corridas: salud de las fuentes.
  const stateFile = join(stateDir, 'sources.json');
  if (existsSync(stateFile)) {
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as Array<Record<string, unknown>>;
    for (const s of saved)
      run(
        ctx.db,
        `INSERT INTO source (id, name, kind, provider_id, last_attempt_at, last_success_at, consecutive_failures, last_error, structure_fingerprint)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at,
           consecutive_failures = excluded.consecutive_failures, last_error = excluded.last_error, structure_fingerprint = excluded.structure_fingerprint`,
        String(s.id),
        String(s.name),
        String(s.kind ?? 'OFFICIAL_PAGE'),
        (s.provider_id as string) ?? null,
        (s.last_attempt_at as string) ?? null,
        (s.last_success_at as string) ?? null,
        Number(s.consecutive_failures ?? 0),
        (s.last_error as string) ?? null,
        (s.structure_fingerprint as string) ?? null,
      );
    log(`Estado restaurado: ${saved.length} fuentes.`);
  }

  if (!offline) {
    // Primero el catálogo de estaciones: las demás fuentes cruzan contra él.
    const st = await syncAxionStations(ctx.db, ctx.clock, ctx.sourceCtx);
    log(`axion-estaciones: ${st.status} ${st.stations} ${st.error ?? ''}`);
    for (const r of await importAll(ctx.db, ctx.clock, ctx.sources, ctx.sourceCtx))
      log(`${r.sourceId}: ${r.status} nuevas ${r.created} cambiadas ${r.changed} sin cambios ${r.unchanged} ${r.error ?? ''}`);
    const w = await watchAxionBenefits(ctx.db, ctx.clock, ctx.sourceCtx);
    log(`axion-beneficios: ${w.status} bloques ${w.blocks} nuevos ${w.created} cambiados ${w.changed} eliminados ${w.missing} ${w.error ?? ''}`);
    try {
      const fp = await updateFuelPrices(ctx.db, ctx.clock, ctx.sourceCtx, { brandId: config.fuelBrandId, brandPattern: /axion/i, timeZone: 'America/Argentina/Buenos_Aires' });
      log(`precios: ${fp.regions} regiones`);
    } catch (e) {
      log(`precios: no disponibles (${(e as Error).message})`);
    }
  }
  const stale = detectStale(ctx.db, ctx.clock, config.staleAfterHours);
  if (stale.markedStale.length) log(`desactualizadas: ${stale.markedStale.join(', ')}`);

  // Guardar estado
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(all(ctx.db, 'SELECT * FROM source ORDER BY id'), null, 1) + '\n');

  // Datos públicos de la app (sin datos personales)
  const promotions = loadPromotions(ctx.db);
  const candidates = pendingCandidates(ctx.db);
  const review = promotions
    .filter((p) => p.pendingReview || p.status === 'STALE')
    .map((p) => ({ promotionId: p.id, name: p.name, status: p.status, reason: all(ctx.db, 'SELECT pending_review_reason r FROM promotion WHERE id = ?', p.id)[0]?.r ?? null }));
  const data = {
    version: APP_DATA_VERSION,
    generatedAt: ctx.clock.now().toISOString(),
    fuelBrandId: config.fuelBrandId,
    promotions,
    catalog: loadCatalog(ctx.db),
    fuelPrices: fuelPriceRows(ctx.db),
    sources: sourceHealth(ctx),
    review,
    candidates: candidates.map((c) => ({ kind: c.kind, sourceId: c.sourceId, sourceKey: c.sourceKey, promotionId: c.promotionId, title: c.payload?.title ?? c.payload?.draft?.name ?? null })),
  };
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(data));
  log(`Publicado ${outFile}: ${promotions.length} promociones, ${data.catalog.stations.length} estaciones, ${review.length} para revisar, ${candidates.length} cambios detectados.`);

  // Resumen para abrir un issue de revisión
  const reviewFile = join(stateDir, 'review.md');
  if (review.length || candidates.length) {
    const lines = [
      'La actualización automática detectó cambios o datos que no se pudieron volver a verificar. Las promociones afectadas **no se usan** para recomendar hasta revisarlas.',
      '',
      ...review.map((r) => `- **${r.name}** (\`${r.promotionId}\`): ${r.status === 'STALE' ? 'desactualizada' : 'pendiente de revisión'}${r.reason ? ` — ${r.reason}` : ''}`),
      ...candidates.map((c) => `- Cambio en fuente \`${c.sourceId}\` (${c.kind}): ${c.payload?.title ?? c.payload?.draft?.name ?? c.sourceKey}`),
      '',
      `Generado: ${data.generatedAt}`,
    ];
    writeFileSync(reviewFile, lines.join('\n') + '\n');
  } else if (existsSync(reviewFile)) writeFileSync(reviewFile, '');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
