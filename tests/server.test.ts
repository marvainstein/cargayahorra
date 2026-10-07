/**
 * Tests de integración: base de datos en memoria + API + pipeline de importación.
 * Las promociones usadas acá son FICTICIAS (marcadas "TEST").
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { pesos } from '../src/core/money';
import type { Clock } from '../src/core/time';
import { createApi } from '../src/server/api';
import { createContext } from '../src/server/context';
import { getPromotion, listVersions } from '../src/server/db/promotions';
import { importFromSource } from '../src/server/jobs/import-promotions';
import { detectStale } from '../src/server/jobs/stale';
import type { AppContext } from '../src/server/services';
import type { ParsedPromotion, PromotionSource, RawDocument, ValidationResult } from '../src/server/sources/types';
import { rule } from './fixtures/builders';

function movableClock(iso: string) {
  let t = Date.parse(iso);
  const clock: Clock & { advanceHours(h: number): void } = {
    now: () => new Date(t),
    advanceHours: (h: number) => {
      t += h * 3_600_000;
    },
  };
  return clock;
}

const testDraft = (over: Record<string, unknown> = {}) => ({
  providerId: 'bbva',
  fuelBrandId: 'axion',
  name: 'TEST BBVA 30%',
  description: 'Promoción ficticia de prueba',
  status: 'VERIFIED',
  confidence: 'HIGH',
  validFrom: '2026-10-01',
  validUntil: '2026-10-31',
  sourceUrl: 'https://example.com/test',
  sourceName: 'test',
  rule: rule({ discountValue: 3000, delivery: 'CASHBACK', caps: [{ amount: pesos(15_000), period: 'MONTHLY' }], eligibleProviderIds: ['bbva'] }),
  ...over,
});

let clock: ReturnType<typeof movableClock>;
let ctx: AppContext;
let api: ReturnType<typeof createApi>;

async function call(method: string, path: string, body?: unknown) {
  const res = await api.request(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

beforeEach(() => {
  clock = movableClock('2026-10-06T15:00:00Z'); // martes 12:00 en Buenos Aires
  ctx = createContext({ port: 0, dbPath: ':memory:', appToken: null, staleAfterHours: 72, fuelBrandId: 'axion', enableScheduler: false }, clock, { seedPromotions: false });
  const app = createApi(ctx);
  api = { request: (p: string, init?: RequestInit) => app.request(p.replace(/^\/api/, ''), init) } as any;
});

describe('API de usuario', () => {
  it('sin promociones verificadas no recomienda nada y lo dice', async () => {
    const { json } = await call('GET', '/home?amount=5000000');
    expect(json.today).toBe('2026-10-06');
    expect(json.recommendation.recommended.transactions).toHaveLength(0);
    expect(json.freshness.warning).toContain('no hay promociones verificadas');
  });

  it('flujo completo: alta verificada → recomendación → registrar carga → tope restante', async () => {
    const created = await call('POST', '/admin/promotions', testDraft());
    expect(created.status).toBe(201);

    const h1 = await call('GET', '/home');
    expect(h1.json.amountSource).toBe('SUGGESTED');
    expect(h1.json.amount).toBe(pesos(50_000));
    expect(h1.json.recommendation.recommended.totalBenefit).toBe(pesos(15_000));

    const tx = await call('POST', '/transactions', { amount: pesos(20_000), paymentMethodId: 'bbva-visa-credito', fuelType: 'SUPER', litres: 16 });
    expect(tx.status).toBe(201);
    expect(tx.json.evaluation.totalBenefit).toBe(pesos(6_000));

    // La promo de prueba permite una sola operación por día: hoy ya no aplica…
    const today = await call('GET', '/home?amount=5000000');
    expect(today.json.recommendation.recommended.totalBenefit).toBe(0);
    expect(today.json.recommendation.ineligible[0].reasons.join(' ')).toContain('Ya la usaste hoy');
    // …mañana sí, con el tope restante del mes.
    const h2 = await call('GET', '/home?amount=5000000&date=2026-10-07');
    expect(h2.json.recommendation.recommended.totalBenefit).toBe(pesos(9_000));

    const hist = await call('GET', '/transactions');
    expect(hist.json.saved).toBe(pesos(6_000));
    expect(hist.json.transactions[0].pricePerLitre).toBe(pesos(1_250));
  });

  it('no permite verificar promociones con condiciones desconocidas', async () => {
    const created = await call('POST', '/admin/promotions', testDraft({ status: 'AUTOMATICALLY_IMPORTED', rule: rule({ unknownConditions: ['CAP'], eligibleProviderIds: ['bbva'] }) }));
    const res = await call('POST', `/admin/promotions/${created.json.promotion.id}/status`, { status: 'VERIFIED' });
    expect(res.status).toBe(409);
    const bad = await call('POST', '/admin/promotions', testDraft({ rule: rule({ unknownConditions: ['CAP'] }) }));
    expect(bad.status).toBe(400);
  });

  it('editar crea una nueva versión y conserva el historial', async () => {
    const created = await call('POST', '/admin/promotions', testDraft());
    const id = created.json.promotion.id;
    await call('PUT', `/admin/promotions/${id}`, { ...testDraft({ rule: rule({ discountValue: 2500, caps: [{ amount: pesos(12_000), period: 'MONTHLY' }], eligibleProviderIds: ['bbva'] }) }), changeReason: 'Cambió el tope' });
    const versions = listVersions(ctx.db, id);
    expect(versions.map((v) => [v.version, v.rule.discountValue, v.rule.caps[0].amount])).toEqual([
      [2, 2500, pesos(12_000)],
      [1, 3000, pesos(15_000)],
    ]);
    const detail = await call('GET', `/admin/promotions/${id}`);
    expect(detail.json.events.map((e: any) => e.type)).toContain('NEW_VERSION');
  });

  it('las cargas históricas conservan la versión aplicada', async () => {
    const created = await call('POST', '/admin/promotions', testDraft());
    const id = created.json.promotion.id;
    const v1 = created.json.promotion.versionId;
    await call('POST', '/transactions', { amount: pesos(10_000), paymentMethodId: 'bbva-visa-credito' });
    await call('PUT', `/admin/promotions/${id}`, testDraft({ rule: rule({ discountValue: 2000, caps: [], eligibleProviderIds: ['bbva'] }) }));
    const hist = await call('GET', '/transactions');
    expect(hist.json.transactions[0].promotionsApplied[0].promotionVersionId).toBe(v1);
    expect(hist.json.transactions[0].benefit).toBe(pesos(3_000));
  });

  it('interpreta bases pegadas a mano sin guardarlas', async () => {
    const text =
      'EJEMPLO SINTÉTICO. Clientes BBVA. Válida los días sábados desde el 01/11/2030 hasta el 30/11/2030, 20% de reintegro en la carga de combustible con tarjetas de crédito Visa, con un tope de reintegro mensual de $6.000. No acumulable con otras promociones.';
    const r = await call('POST', '/admin/parse-text', { providerId: 'bbva', text });
    expect(r.status).toBe(200);
    expect(r.json.draft.status).toBe('AUTOMATICALLY_IMPORTED');
    expect(r.json.draft.rule.discountValue).toBe(2000);
    expect(r.json.draft.rule.daysOfWeek).toEqual([6]);
    expect(r.json.draft.rule.caps).toEqual([{ amount: pesos(6_000), period: 'MONTHLY' }]);
    expect((await call('GET', '/admin/promotions')).json.promotions).toHaveLength(0);
    expect((await call('POST', '/admin/parse-text', { providerId: 'bbva', text: 'corto' })).status).toBe(400);
  });

  it('valida entradas', async () => {
    expect((await call('POST', '/transactions', { amount: 12.5, paymentMethodId: 'x' })).status).toBe(400);
    expect((await call('PUT', '/profile', { paymentMethodIds: ['no-existe'] })).status).toBe(400);
  });

  it('APP_TOKEN protege la API', async () => {
    const c2 = createContext({ port: 0, dbPath: ':memory:', appToken: 'secreto', staleAfterHours: 72, fuelBrandId: 'axion', enableScheduler: false }, clock, { seedPromotions: false });
    const app = createApi(c2);
    expect((await app.request('/home')).status).toBe(401);
    expect((await app.request('/home', { headers: { authorization: 'Bearer secreto' } })).status).toBe(200);
  });
});

// ───────── Pipeline de importación con una fuente falsa ─────────

class FakeSource implements PromotionSource {
  id = 'fake';
  name = 'Fuente falsa';
  providerId = 'bbva';
  kind = 'OFFICIAL_PAGE' as const;
  pct = 3000;
  broken = false;
  down = false;
  isConfigured() {
    return true;
  }
  async fetch(): Promise<RawDocument[]> {
    if (this.down) throw new Error('timeout');
    return [{ url: 'https://example.com/promo', status: 200, contentType: 'text/html', body: '<p>x</p>', retrievedAt: clock.now().toISOString() }];
  }
  parse(): ParsedPromotion[] {
    if (this.broken) return [];
    return [
      {
        sourceKey: 'promo-1',
        excerpt: 'texto',
        warnings: [],
        draft: {
          ...(testDraft({ status: 'AUTOMATICALLY_IMPORTED', confidence: 'MEDIUM' }) as any),
          retrievedAt: clock.now().toISOString(),
          lastVerifiedAt: null,
          rule: rule({ discountValue: this.pct, caps: [{ amount: pesos(15_000), period: 'MONTHLY' }], eligibleProviderIds: ['bbva'] }),
        },
      },
    ];
  }
  validate(p: ParsedPromotion[]): ValidationResult {
    return { structureOk: p.length > 0, valid: p, issues: [], fingerprint: 'f1' };
  }
}

describe('importación', () => {
  it('crea como no verificada, detecta cambios sin sobrescribir y marca STALE si la fuente cae', async () => {
    const src = new FakeSource();
    const r1 = await importFromSource(ctx.db, clock, src, ctx.sourceCtx);
    expect(r1.created).toBe(1);
    const promoId = (await call('GET', '/admin/promotions')).json.promotions[0].id;
    expect(getPromotion(ctx.db, promoId)!.status).toBe('AUTOMATICALLY_IMPORTED');

    // misma información → sin cambios
    clock.advanceHours(6);
    const r2 = await importFromSource(ctx.db, clock, src, ctx.sourceCtx);
    expect(r2.unchanged).toBe(1);

    // un humano la verifica
    await call('POST', `/admin/promotions/${promoId}/status`, { status: 'VERIFIED' });
    expect((await call('GET', '/home?amount=5000000')).json.recommendation.recommended.totalBenefit).toBe(pesos(15_000));

    // la fuente cambia el porcentaje → queda pendiente de revisión, no se sobrescribe
    src.pct = 2000;
    clock.advanceHours(6);
    const r3 = await importFromSource(ctx.db, clock, src, ctx.sourceCtx);
    expect(r3.changed).toBe(1);
    const p3 = getPromotion(ctx.db, promoId)!;
    expect(p3.rule.discountValue).toBe(3000);
    expect(p3.pendingReview).toBe(true);
    expect((await call('GET', '/home?amount=5000000')).json.recommendation.recommended.transactions).toHaveLength(0);
    const cands = (await call('GET', '/admin/candidates')).json.candidates;
    expect(cands[0].kind).toBe('CHANGED');

    // aceptar el cambio → nueva versión (sin verificar)
    await call('POST', `/admin/candidates/${cands[0].id}/apply`);
    const p4 = getPromotion(ctx.db, promoId)!;
    expect(p4.version).toBe(2);
    expect(p4.rule.discountValue).toBe(2000);
    expect(p4.status).toBe('AUTOMATICALLY_IMPORTED');
    expect(p4.pendingReview).toBe(false);

    // estructura rota → FAILED, no toca nada
    src.broken = true;
    const r5 = await importFromSource(ctx.db, clock, src, ctx.sourceCtx);
    expect(r5.status).toBe('FAILED');
    expect(getPromotion(ctx.db, promoId)!.version).toBe(2);

    // la fuente cae varios días → STALE
    src.broken = false;
    src.down = true;
    clock.advanceHours(80);
    await importFromSource(ctx.db, clock, src, ctx.sourceCtx);
    const report = detectStale(ctx.db, clock, 72);
    expect(report.markedStale).toContain(promoId);
    expect(getPromotion(ctx.db, promoId)!.status).toBe('STALE');
    const overview = (await call('GET', '/admin/overview')).json;
    expect(overview.sources.find((s: any) => s.id === 'fake').consecutiveFailures).toBeGreaterThan(0);

    // vuelve con la misma información → recupera el estado previo
    src.down = false;
    await importFromSource(ctx.db, clock, src, ctx.sourceCtx);
    expect(getPromotion(ctx.db, promoId)!.status).toBe('AUTOMATICALLY_IMPORTED');
  });

  it('una verificación humana reciente evita STALE aunque la fuente falle', async () => {
    const src = new FakeSource();
    await importFromSource(ctx.db, clock, src, ctx.sourceCtx);
    const promoId = (await call('GET', '/admin/promotions')).json.promotions[0].id;
    src.down = true;
    clock.advanceHours(100);
    await call('POST', `/admin/promotions/${promoId}/status`, { status: 'VERIFIED' });
    detectStale(ctx.db, clock, 72);
    expect(getPromotion(ctx.db, promoId)!.status).toBe('VERIFIED');
    clock.advanceHours(15 * 24);
    detectStale(ctx.db, clock, 72);
    expect(getPromotion(ctx.db, promoId)!.status).toBe('STALE');
  });
});
