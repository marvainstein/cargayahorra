import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { createApi } from './api';
import { createContext, loadConfig } from './context';
import { JOBS } from './jobs';
import { startScheduler } from './jobs/scheduler';

const config = loadConfig();
const ctx = createContext(config);
const app = new Hono();
app.route('/api', createApi(ctx));

// En producción el mismo proceso sirve el frontend compilado (dist/).
if (existsSync('dist/index.html')) {
  app.use('/*', serveStatic({ root: './dist' }));
  const index = readFileSync('dist/index.html', 'utf8');
  app.get('*', (c) => c.html(index));
}

if (config.enableScheduler) startScheduler(ctx.db, ctx.clock, JOBS.map((j) => j.build(ctx)));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Carga y Ahorra escuchando en http://localhost:${info.port}${config.appToken ? ' (con APP_TOKEN)' : ''}`);
});
