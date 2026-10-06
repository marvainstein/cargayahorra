/**
 * Scheduler en proceso (sin colas ni servicios extra). Cada job guarda su
 * última ejecución en job_run; al arrancar se ponen al día los atrasados.
 * También se pueden correr a mano: `npm run jobs`.
 */
import type { Clock } from '../../core/time';
import { type DB, get, run } from '../db/db';

export interface Job {
  name: string;
  everyMinutes: number;
  run: () => Promise<string | void>;
}

export async function runJob(db: DB, clock: Clock, job: Job): Promise<{ ok: boolean; detail: string }> {
  const started = clock.now().toISOString();
  const id = Number(run(db, `INSERT INTO job_run (job, started_at, status) VALUES (?,?, 'RUNNING')`, job.name, started).lastInsertRowid);
  try {
    const detail = (await job.run()) ?? '';
    run(db, `UPDATE job_run SET finished_at = ?, status = 'SUCCESS', detail = ? WHERE id = ?`, clock.now().toISOString(), detail, id);
    return { ok: true, detail };
  } catch (e) {
    const detail = (e as Error).message;
    run(db, `UPDATE job_run SET finished_at = ?, status = 'FAILED', detail = ? WHERE id = ?`, clock.now().toISOString(), detail, id);
    return { ok: false, detail };
  }
}

export function lastRun(db: DB, job: string): { startedAt: string; status: string; detail: string | null } | null {
  const r = get(db, 'SELECT * FROM job_run WHERE job = ? ORDER BY id DESC LIMIT 1', job);
  return r ? { startedAt: r.started_at, status: r.status, detail: r.detail ?? null } : null;
}

export function startScheduler(db: DB, clock: Clock, jobs: Job[], log: (m: string) => void = console.log): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const job of jobs) {
        const last = lastRun(db, job.name);
        const due = !last || clock.now().getTime() - Date.parse(last.startedAt) >= job.everyMinutes * 60_000;
        if (!due) continue;
        const r = await runJob(db, clock, job);
        log(`[job] ${job.name}: ${r.ok ? 'ok' : 'ERROR'} ${r.detail}`);
      }
    } finally {
      running = false;
    }
  };
  void tick();
  const handle = setInterval(() => void tick(), 5 * 60_000);
  return () => clearInterval(handle);
}
