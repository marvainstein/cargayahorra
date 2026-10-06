import type { AppContext } from '../services';
import { updateFuelPrices } from './fuel-prices';
import { importAll } from './import-promotions';
import type { Job } from './scheduler';
import { detectStale } from './stale';

export interface JobDef {
  name: string;
  everyMinutes: number;
  description: string;
  build(ctx: AppContext): Job;
}

export const JOBS: JobDef[] = [
  {
    name: 'import-promotions',
    everyMinutes: 6 * 60,
    description: 'Importa promociones de las fuentes oficiales, valida y detecta cambios.',
    build: (ctx) => ({
      name: 'import-promotions',
      everyMinutes: 6 * 60,
      run: async () => {
        const res = await importAll(ctx.db, ctx.clock, ctx.sources, ctx.sourceCtx);
        return res.map((r) => `${r.sourceId}: ${r.status}${r.error ? ` (${r.error})` : ''} +${r.created} ~${r.changed} =${r.unchanged}`).join(' | ');
      },
    }),
  },
  {
    name: 'detect-stale',
    everyMinutes: 60,
    description: 'Marca como desactualizadas las promociones de fuentes caídas o no re-verificadas.',
    build: (ctx) => ({
      name: 'detect-stale',
      everyMinutes: 60,
      run: async () => {
        const r = detectStale(ctx.db, ctx.clock, ctx.config.staleAfterHours);
        return `fuentes vencidas: ${r.staleSources.join(', ') || 'ninguna'}; promociones marcadas: ${r.markedStale.length}`;
      },
    }),
  },
  {
    name: 'fuel-prices',
    everyMinutes: 24 * 60,
    description: 'Actualiza precios de referencia desde datos abiertos de la Secretaría de Energía.',
    build: (ctx) => ({
      name: 'fuel-prices',
      everyMinutes: 24 * 60,
      run: async () => {
        const r = await updateFuelPrices(ctx.db, ctx.clock, ctx.sourceCtx, { brandId: ctx.config.fuelBrandId, brandPattern: /axion/i, timeZone: 'America/Argentina/Buenos_Aires' });
        return `regiones actualizadas: ${r.regions}`;
      },
    }),
  },
];
