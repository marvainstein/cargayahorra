import { Hono } from 'hono';
import type { Context } from 'hono';
import { isLocalDate } from '../core/time';
import { FUEL_TYPES, type FuelType, PROMOTION_STATUSES, type PromotionStatus, type TriState } from '../core/types';
import { PROVINCES } from '../core/regions';
import { all, get, run } from './db/db';
import {
  addVersion,
  createPromotion,
  draftFromPromotion,
  getPromotion,
  listEvents,
  listVersions,
  loadPromotions,
  setActive,
  setPendingReview,
  setStatus,
} from './db/promotions';
import { deleteAdjustment, deleteTransaction, getProfile, insertAdjustment, listAdjustments, loadCatalog, updateProfile } from './db/user';
import { importAll, importFromSource, pendingCandidates } from './jobs/import-promotions';
import { insertManualPrice, listPrices } from './jobs/fuel-prices';
import { lastRun } from './jobs/scheduler';
import { type AppContext, historySummary, home, monthlyPlan, registerTransaction } from './services';
import { cents, parseDraft, ValidationError } from './validation';
import { JOBS } from './jobs';

function intParam(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function fuelParam(v: unknown): FuelType | undefined {
  return typeof v === 'string' && (FUEL_TYPES as readonly string[]).includes(v) ? (v as FuelType) : undefined;
}

function bad(c: Context, errors: string[] | string, status: 400 | 404 | 409 = 400) {
  return c.json({ error: Array.isArray(errors) ? errors.join(' ') : errors, errors: Array.isArray(errors) ? errors : [errors] }, status);
}

export function createApi(ctx: AppContext) {
  const api = new Hono();
  const now = () => ctx.clock.now().toISOString();

  api.onError((err, c) => {
    if (err instanceof ValidationError) return bad(c, err.errors);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  api.get('/health', (c) => c.json({ ok: true, time: now() }));

  // Autenticación simple por token (si APP_TOKEN está configurado).
  api.use('*', async (c, next) => {
    if (!ctx.config.appToken) return next();
    const header = c.req.header('authorization') ?? '';
    if (header !== `Bearer ${ctx.config.appToken}`) return c.json({ error: 'No autorizado' }, 401);
    return next();
  });

  // ───────── Usuario ─────────
  api.get('/home', (c) => {
    const q = c.req.query();
    return c.json(
      home(ctx, {
        amount: intParam(q.amount),
        litres: q.litres ? Number(q.litres) : null,
        fuelType: fuelParam(q.fuelType),
        pricePerLitre: intParam(q.pricePerLitre),
        stationId: q.stationId || null,
        date: q.date && isLocalDate(q.date) ? q.date : undefined,
      }),
    );
  });

  api.post('/plan', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const errors: string[] = [];
    const budget = cents(b.budget, 'budget', errors, { nullable: true });
    if (b.from && !isLocalDate(String(b.from))) errors.push('from inválido.');
    if (b.to && !isLocalDate(String(b.to))) errors.push('to inválido.');
    if (errors.length) return bad(c, errors);
    return c.json(
      monthlyPlan(ctx, {
        budget,
        from: (b.from as string) || undefined,
        to: (b.to as string) || undefined,
        fuelType: fuelParam(b.fuelType),
        maxLoads: typeof b.maxLoads === 'number' ? b.maxLoads : null,
        pricePerLitre: typeof b.pricePerLitre === 'number' ? b.pricePerLitre : null,
      }),
    );
  });

  api.get('/profile', (c) => {
    // Topes compartidos (pools) para poder cargar consumos hechos fuera de la app.
    const pools = new Map<string, string[]>();
    for (const p of loadPromotions(ctx.db))
      for (const cap of p.rule.caps) if (cap.poolId) pools.set(cap.poolId, [...(pools.get(cap.poolId) ?? []), p.name]);
    return c.json({
      profile: getProfile(ctx.db),
      catalog: loadCatalog(ctx.db),
      provinces: PROVINCES,
      adjustments: listAdjustments(ctx.db),
      pools: [...pools.entries()].map(([id, names]) => ({ id, promotions: names })),
    });
  });

  api.put('/profile', async (c) => {
    const b = (await c.req.json()) as Record<string, unknown>;
    const errors: string[] = [];
    const catalog = loadCatalog(ctx.db);
    const patch: Parameters<typeof updateProfile>[2] = {};
    if ('region' in b) patch.region = b.region ? String(b.region) : null;
    if (b.allowSplitPayment) {
      if (!['YES', 'NO', 'UNKNOWN'].includes(String(b.allowSplitPayment))) errors.push('allowSplitPayment inválido.');
      patch.allowSplitPayment = b.allowSplitPayment as TriState;
    }
    if ('maxLoadAmount' in b) patch.maxLoadAmount = cents(b.maxLoadAmount, 'maxLoadAmount', errors, { nullable: true });
    if ('estimatedMonthlyFuelBudget' in b) patch.estimatedMonthlyFuelBudget = cents(b.estimatedMonthlyFuelBudget, 'estimatedMonthlyFuelBudget', errors, { nullable: true });
    if ('defaultPricePerLitre' in b) patch.defaultPricePerLitre = cents(b.defaultPricePerLitre, 'defaultPricePerLitre', errors, { nullable: true });
    if (b.defaultFuelType) {
      if (!fuelParam(b.defaultFuelType)) errors.push('defaultFuelType inválido.');
      patch.defaultFuelType = b.defaultFuelType as FuelType;
    }
    if ('defaultStationId' in b) patch.defaultStationId = b.defaultStationId ? String(b.defaultStationId) : null;
    if (Array.isArray(b.paymentMethodIds)) {
      const ids = b.paymentMethodIds.map(String);
      for (const id of ids) if (!catalog.paymentMethods.some((m) => m.id === id)) errors.push(`Medio de pago desconocido: ${id}`);
      patch.paymentMethodIds = ids;
    }
    if (b.segments && typeof b.segments === 'object') {
      const segs: Record<string, TriState> = {};
      for (const [k, v] of Object.entries(b.segments as Record<string, unknown>)) {
        if (!catalog.segments.some((s) => s.id === k)) errors.push(`Segmento desconocido: ${k}`);
        if (!['YES', 'NO', 'UNKNOWN'].includes(String(v))) errors.push(`Estado inválido para ${k}`);
        segs[k] = v as TriState;
      }
      patch.segments = segs;
    }
    if (Array.isArray(b.loyaltyMemberships)) patch.loyaltyMemberships = b.loyaltyMemberships.map(String);
    if (Array.isArray(b.apps)) patch.apps = b.apps.map(String);
    if (errors.length) return bad(c, errors);
    updateProfile(ctx.db, now(), patch);
    return c.json({ profile: getProfile(ctx.db) });
  });

  api.get('/transactions', (c) => c.json(historySummary(ctx, c.req.query('month') || undefined)));

  api.post('/transactions', async (c) => {
    const b = (await c.req.json()) as Record<string, unknown>;
    const errors: string[] = [];
    const amount = cents(b.amount, 'amount', errors, { min: 1 });
    if (!b.paymentMethodId) errors.push('paymentMethodId es obligatorio.');
    if (b.date && !isLocalDate(String(b.date))) errors.push('date inválida.');
    const pricePerLitre = cents(b.pricePerLitre, 'pricePerLitre', errors, { nullable: true });
    const litres = b.litres == null || b.litres === '' ? null : Number(b.litres);
    if (litres !== null && !(litres > 0)) errors.push('litres inválido.');
    if (errors.length) return bad(c, errors);
    try {
      return c.json(
        registerTransaction(ctx, {
          date: (b.date as string) || undefined,
          amount: amount!,
          paymentMethodId: String(b.paymentMethodId),
          fuelType: fuelParam(b.fuelType),
          litres,
          pricePerLitre,
          stationId: b.stationId ? String(b.stationId) : null,
          promotionIds: Array.isArray(b.promotionIds) ? b.promotionIds.map(String) : undefined,
          notes: b.notes ? String(b.notes) : null,
        }),
        201,
      );
    } catch (e) {
      return bad(c, (e as Error).message);
    }
  });

  api.delete('/transactions/:id', (c) => (deleteTransaction(ctx.db, c.req.param('id')) ? c.json({ ok: true }) : bad(c, 'No existe', 404)));

  api.post('/adjustments', async (c) => {
    const b = (await c.req.json()) as Record<string, unknown>;
    const errors: string[] = [];
    const amount = cents(b.amount, 'amount', errors, { min: 1 });
    if (!b.date || !isLocalDate(String(b.date))) errors.push('date inválida.');
    if (!b.poolId && !b.promotionId) errors.push('Indicá el tope (poolId) o la promoción.');
    if (errors.length) return bad(c, errors);
    const id = insertAdjustment(ctx.db, {
      date: String(b.date),
      amount: amount!,
      poolId: b.poolId ? String(b.poolId) : null,
      promotionId: b.promotionId ? String(b.promotionId) : null,
      note: b.note ? String(b.note) : '',
    });
    return c.json({ id }, 201);
  });
  api.delete('/adjustments/:id', (c) => (deleteAdjustment(ctx.db, c.req.param('id')) ? c.json({ ok: true }) : bad(c, 'No existe', 404)));

  api.get('/promotions', (c) => {
    const promos = loadPromotions(ctx.db);
    return c.json({ promotions: promos });
  });

  // ───────── Administración ─────────
  const admin = new Hono();

  admin.get('/overview', (c) => {
    const promos = loadPromotions(ctx.db, { includeInactive: true });
    const sources = all(ctx.db, 'SELECT * FROM source ORDER BY name').map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      enabled: !!s.enabled,
      configured: ctx.sources.find((x) => x.id === s.id)?.isConfigured() ?? false,
      lastAttemptAt: s.last_attempt_at ?? null,
      lastSuccessAt: s.last_success_at ?? null,
      consecutiveFailures: Number(s.consecutive_failures),
      lastError: s.last_error ?? null,
      promotions: Number(get(ctx.db, 'SELECT COUNT(*) AS n FROM promotion WHERE source_id = ?', s.id)!.n),
      pendingCandidates: Number(get(ctx.db, `SELECT COUNT(*) AS n FROM import_candidate WHERE source_id = ? AND status = 'PENDING_REVIEW'`, s.id)!.n),
    }));
    const byStatus: Record<string, number> = {};
    for (const p of promos) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    return c.json({
      now: now(),
      sources,
      jobs: JOBS.map((j) => ({ name: j.name, everyMinutes: j.everyMinutes, last: lastRun(ctx.db, j.name) })),
      promotions: { total: promos.length, byStatus, pendingReview: promos.filter((p) => p.pendingReview).length },
      candidates: pendingCandidates(ctx.db).length,
    });
  });

  admin.get('/promotions', (c) => {
    const promos = loadPromotions(ctx.db, { includeInactive: true }).map((p) => getPromotion(ctx.db, p.id)!);
    return c.json({ promotions: promos, catalog: loadCatalog(ctx.db) });
  });

  admin.get('/promotions/:id', (c) => {
    const p = getPromotion(ctx.db, c.req.param('id'));
    if (!p) return bad(c, 'No existe', 404);
    return c.json({ promotion: p, versions: listVersions(ctx.db, p.id), events: listEvents(ctx.db, p.id) });
  });

  admin.post('/promotions', async (c) => {
    const draft = parseDraft(await c.req.json(), { now: now() });
    const p = createPromotion(ctx.db, ctx.clock, draft, { actor: 'admin', reason: 'Alta manual' });
    return c.json({ promotion: p }, 201);
  });

  admin.put('/promotions/:id', async (c) => {
    const id = c.req.param('id');
    if (!getPromotion(ctx.db, id)) return bad(c, 'No existe', 404);
    const body = (await c.req.json()) as Record<string, unknown>;
    const draft = parseDraft(body, { now: now() });
    const reason = typeof body.changeReason === 'string' && body.changeReason.trim() ? body.changeReason.trim() : 'Edición manual';
    const p = addVersion(ctx.db, ctx.clock, id, draft, { actor: 'admin', reason, clearPendingReview: draft.status === 'VERIFIED' || draft.status === 'MANUALLY_REVIEWED' });
    return c.json({ promotion: p });
  });

  admin.post('/promotions/:id/status', async (c) => {
    const id = c.req.param('id');
    const p = getPromotion(ctx.db, id);
    if (!p) return bad(c, 'No existe', 404);
    const b = (await c.req.json()) as Record<string, unknown>;
    const status = String(b.status) as PromotionStatus;
    if (!PROMOTION_STATUSES.includes(status)) return bad(c, 'Estado inválido');
    if ((status === 'VERIFIED' || status === 'MANUALLY_REVIEWED') && p.rule.unknownConditions.length > 0)
      return bad(c, 'No se puede verificar: la promoción tiene condiciones desconocidas. Editala y completalas primero.', 409);
    setStatus(ctx.db, ctx.clock, id, status, 'admin', typeof b.note === 'string' ? b.note : null);
    return c.json({ promotion: getPromotion(ctx.db, id) });
  });

  admin.post('/promotions/:id/active', async (c) => {
    const id = c.req.param('id');
    if (!getPromotion(ctx.db, id)) return bad(c, 'No existe', 404);
    const b = (await c.req.json()) as Record<string, unknown>;
    setActive(ctx.db, ctx.clock, id, !!b.active, 'admin', typeof b.note === 'string' ? b.note : null);
    return c.json({ promotion: getPromotion(ctx.db, id) });
  });

  admin.get('/candidates', (c) => c.json({ candidates: pendingCandidates(ctx.db) }));

  admin.post('/candidates/:id/:action', async (c) => {
    const id = Number(c.req.param('id'));
    const action = c.req.param('action');
    const cand = get(ctx.db, `SELECT * FROM import_candidate WHERE id = ? AND status = 'PENDING_REVIEW'`, id);
    if (!cand) return bad(c, 'Candidato inexistente o ya resuelto', 404);
    const payload = JSON.parse(cand.payload_json);
    if (action === 'apply') {
      if (cand.kind === 'CHANGED' && cand.promotion_id) {
        // Se aplica como nueva versión, sin verificar: queda para revisión/edición.
        addVersion(ctx.db, ctx.clock, cand.promotion_id, { ...payload.draft, status: 'AUTOMATICALLY_IMPORTED', lastVerifiedAt: null }, { actor: 'admin', reason: 'Cambio de la fuente aceptado', clearPendingReview: true });
      } else if (cand.kind === 'MISSING' && cand.promotion_id) {
        setActive(ctx.db, ctx.clock, cand.promotion_id, false, 'admin', 'Ya no figura en la fuente oficial');
        setPendingReview(ctx.db, ctx.clock, cand.promotion_id, null, 'admin');
      }
    } else if (action === 'reject') {
      if (cand.promotion_id) setPendingReview(ctx.db, ctx.clock, cand.promotion_id, null, 'admin');
    } else return bad(c, 'Acción inválida');
    run(ctx.db, `UPDATE import_candidate SET status = ?, resolved_at = ? WHERE id = ?`, action === 'apply' ? 'APPLIED' : 'REJECTED', now(), id);
    return c.json({ ok: true });
  });

  admin.get('/imports', (c) =>
    c.json({
      runs: all(ctx.db, 'SELECT * FROM import_run ORDER BY id DESC LIMIT 50').map((r) => ({ ...r, warnings: JSON.parse(r.warnings_json ?? '[]') })),
    }),
  );

  admin.post('/imports/run', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const sourceId = typeof b.sourceId === 'string' ? b.sourceId : null;
    if (sourceId) {
      const s = ctx.sources.find((x) => x.id === sourceId);
      if (!s) return bad(c, 'Fuente desconocida', 404);
      return c.json({ results: [await importFromSource(ctx.db, ctx.clock, s, ctx.sourceCtx)] });
    }
    return c.json({ results: await importAll(ctx.db, ctx.clock, ctx.sources, ctx.sourceCtx) });
  });

  admin.post('/jobs/:name/run', async (c) => {
    const job = JOBS.find((j) => j.name === c.req.param('name'));
    if (!job) return bad(c, 'Job desconocido', 404);
    const { runJob } = await import('./jobs/scheduler');
    return c.json(await runJob(ctx.db, ctx.clock, job.build(ctx)));
  });

  admin.get('/fuel-prices', (c) => c.json({ prices: listPrices(ctx.db) }));
  admin.post('/fuel-prices', async (c) => {
    const b = (await c.req.json()) as Record<string, unknown>;
    const errors: string[] = [];
    const price = cents(b.price, 'price', errors, { min: 1 });
    const fuelType = fuelParam(b.fuelType);
    if (!fuelType) errors.push('fuelType inválido.');
    if (!b.effectiveFrom || !isLocalDate(String(b.effectiveFrom))) errors.push('effectiveFrom inválida.');
    if (errors.length) return bad(c, errors);
    insertManualPrice(ctx.db, ctx.clock, {
      stationId: b.stationId ? String(b.stationId) : null,
      brandId: b.brandId ? String(b.brandId) : ctx.config.fuelBrandId,
      region: b.region ? String(b.region) : null,
      fuelType: fuelType!,
      price: price!,
      effectiveFrom: String(b.effectiveFrom),
    });
    return c.json({ ok: true }, 201);
  });

  admin.post('/stations', async (c) => {
    const b = (await c.req.json()) as Record<string, unknown>;
    if (!b.id || !b.name) return bad(c, 'id y name son obligatorios');
    run(
      ctx.db,
      'INSERT INTO station (id, brand_id, name, address, region, latitude, longitude, active) VALUES (?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name, address=excluded.address, region=excluded.region, latitude=excluded.latitude, longitude=excluded.longitude',
      String(b.id),
      String(b.brandId ?? ctx.config.fuelBrandId),
      String(b.name),
      b.address ? String(b.address) : null,
      b.region ? String(b.region) : null,
      typeof b.latitude === 'number' ? b.latitude : null,
      typeof b.longitude === 'number' ? b.longitude : null,
    );
    return c.json({ ok: true }, 201);
  });

  admin.get('/promotions/:id/draft', (c) => {
    const p = getPromotion(ctx.db, c.req.param('id'));
    return p ? c.json({ draft: draftFromPromotion(p) }) : bad(c, 'No existe', 404);
  });

  api.route('/admin', admin);
  return api;
}
