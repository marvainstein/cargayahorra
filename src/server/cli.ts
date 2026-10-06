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
import { runJob } from './jobs/scheduler';

const [cmd, arg] = process.argv.slice(2);
const ctx = createContext(loadConfig());

async function main() {
  switch (cmd) {
    case 'import': {
      const sources = arg ? ctx.sources.filter((s) => s.id === arg) : ctx.sources;
      if (arg && sources.length === 0) throw new Error(`Fuente desconocida: ${arg}. Disponibles: ${ctx.sources.map((s) => s.id).join(', ')}`);
      const res = arg ? [await importFromSource(ctx.db, ctx.clock, sources[0], ctx.sourceCtx)] : await importAll(ctx.db, ctx.clock, sources, ctx.sourceCtx);
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
      console.log('Comandos: import [fuente] | jobs | seed');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
