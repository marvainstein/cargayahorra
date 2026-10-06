import { systemClock, type Clock } from '../core/time';
import { openDb } from './db/db';
import { seedAll } from './seed';
import type { AppContext, Config } from './services';
import { buildSources } from './sources/registry';
import { ensureSourceRow } from './jobs/import-promotions';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8787),
    dbPath: env.DATABASE_PATH ?? 'data/carga-y-ahorra.db',
    appToken: env.APP_TOKEN?.trim() || null,
    staleAfterHours: Number(env.STALE_AFTER_HOURS ?? 72),
    fuelBrandId: env.FUEL_BRAND_ID ?? 'axion',
    enableScheduler: env.ENABLE_SCHEDULER !== 'false',
  };
}

export function createContext(config: Config, clock: Clock = systemClock, opts: { seedPromotions?: boolean } = {}): AppContext {
  const db = openDb(config.dbPath);
  seedAll(db, clock, { promotions: opts.seedPromotions !== false && process.env.SEED_CANDIDATE_PROMOTIONS !== 'false' });
  const sources = buildSources();
  for (const s of sources) ensureSourceRow(db, s);
  return {
    db,
    clock,
    config,
    sources,
    sourceCtx: { fetch: globalThis.fetch, clock, userAgent: 'CargaYAhorra/0.1 (+uso personal; consulta de promociones publicas)' },
  };
}
