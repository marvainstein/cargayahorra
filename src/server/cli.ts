/**
 * CLI de mantenimiento:
 *   npm run import            importa todas las fuentes
 *   npm run import -- <id>    importa una fuente
 *   npm run jobs              corre todos los jobs una vez
 *   npm run seed              crea catálogo/usuario (idempotente)
 */
import { createContext, loadConfig } from './context';
import { JOBS } from './jobs';
import { importAll, importFromSource } from './jobs/import-promotions';
import { syncAxionStations, watchAxionBenefits } from './jobs/axion';
import { runJob } from './jobs/scheduler';

const [cmd, arg] = process.argv.slice(2);
const ctx = createContext(loadConfig());

async function main() {
  switch (cmd) {
    case 'axion': {
      const st = await syncAxionStations(ctx.db, ctx.clock, ctx.sourceCtx);
      console.log(`axion-estaciones: ${st.status} — ${st.stations} estaciones${st.error ? ` — ${st.error}` : ''}`);
      const w = await watchAxionBenefits(ctx.db, ctx.clock, ctx.sourceCtx);
      console.log(`axion-beneficios: ${w.status} — bloques ${w.blocks}, nuevos ${w.created}, cambiados ${w.changed}, eliminados ${w.missing}${w.error ? ` — ${w.error}` : ''}`);
      break;
    }
    case 'import': {
      const sources = arg ? ctx.sources.filter((s) => s.id === arg) : ctx.sources;
      if (arg && sources.length === 0 && arg !== 'axion-beneficios') throw new Error(`Fuente desconocida: ${arg}. Disponibles: ${ctx.sources.map((s) => s.id).join(', ')}`);
      const res = arg && sources.length === 0 ? [] : arg ? [await importFromSource(ctx.db, ctx.clock, sources[0], ctx.sourceCtx)] : await importAll(ctx.db, ctx.clock, sources, ctx.sourceCtx);
      if (!arg || arg === 'axion-beneficios') {
        const w = await watchAxionBenefits(ctx.db, ctx.clock, ctx.sourceCtx);
        console.log(`axion-beneficios: ${w.status} — bloques ${w.blocks}, nuevos ${w.created}, cambiados ${w.changed}, eliminados ${w.missing}${w.error ? ` — ${w.error}` : ''}`);
      }
      for (const r of res) {
        console.log(`${r.sourceId}: ${r.status} — nuevas ${r.created}, cambiadas ${r.changed}, sin cambios ${r.unchanged}, desaparecidas ${r.missing}${r.error ? ` — ${r.error}` : ''}`);
        for (const i of r.issues) console.log(`   ${i.level} ${i.sourceKey ?? ''} ${i.message}`);
      }
      break;
    }
    case 'jobs':
      for (const j of JOBS) {
        const r = await runJob(ctx.db, ctx.clock, j.build(ctx));
        console.log(`${j.name}: ${r.ok ? 'ok' : 'ERROR'} ${r.detail}`);
      }
      break;
    case 'seed':
      console.log('Catálogo y usuario listos.');
      break;
    default:
      console.log('Comandos: import [fuente] | axion | jobs | seed');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
