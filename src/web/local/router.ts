/**
 * "API" local: mismas rutas y respuestas que el servidor, pero resueltas en el
 * dispositivo con los casos de uso compartidos (src/app/usecases.ts).
 */
import * as uc from '../../app/usecases';
import { isLocalDate } from '../../core/time';
import { FUEL_TYPES, type FuelType, type TriState } from '../../core/types';
import { PROVINCES } from '../../core/regions';
import { type AppData, buildStore, type LocalState, loadLocal, parseBackup, saveLocal } from './store';

export class LocalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Datos con más de este tiempo se marcan como posiblemente desactualizados. */
const DATA_STALE_HOURS = 30;

let dataPromise: Promise<{ data: AppData; offlineSince: string | null }> | null = null;
let local: LocalState | null = null;

function loadData() {
  dataPromise ??= fetch('./data/app-data.json', { cache: 'no-cache' }).then(async (res) => {
    if (!res.ok) throw new LocalApiError('No se pudieron cargar los datos de promociones.', 503);
    return { data: (await res.json()) as AppData, offlineSince: res.headers.get('x-offline-cache') };
  });
  return dataPromise.catch((e) => {
    dataPromise = null;
    throw e;
  });
}

function state(): LocalState {
  local ??= loadLocal();
  return local;
}

const fuel = (v: unknown): FuelType | undefined => (typeof v === 'string' && (FUEL_TYPES as readonly string[]).includes(v) ? (v as FuelType) : undefined);
const int = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new LocalApiError('Monto inválido.', 400);
  return n;
};

export function isConfigured(): boolean {
  return state().configured;
}

export async function handle(method: string, path: string, body: unknown): Promise<{ data: unknown; offlineSince: string | null }> {
  const { data, offlineSince } = await loadData();
  const st = state();
  const store = buildStore(data, st, saveLocal);
  const url = new URL(path, 'http://local');
  const q = Object.fromEntries(url.searchParams);
  const b = (body ?? {}) as Record<string, any>;
  const ok = (d: unknown) => ({ data: d, offlineSince });
  const route = `${method} ${url.pathname}`;

  if (route === 'GET /home') {
    const res = uc.home(store, {
      amount: int(q.amount),
      litres: q.litres ? Number(q.litres) : null,
      fuelType: fuel(q.fuelType),
      pricePerLitre: int(q.pricePerLitre),
      stationId: q.stationId || null,
      date: q.date && isLocalDate(q.date) ? q.date : undefined,
    });
    const ageHours = (Date.now() - Date.parse(data.generatedAt)) / 3_600_000;
    if (ageHours > DATA_STALE_HOURS && !res.freshness.warning)
      res.freshness.warning = `Los datos de promociones son del ${new Date(data.generatedAt).toLocaleString('es-AR')}: no se pudieron actualizar desde entonces.`;
    return ok({ ...res, configured: st.configured, generatedAt: data.generatedAt });
  }
  if (route === 'POST /plan') {
    return ok(uc.monthlyPlan(store, { budget: int(b.budget), from: b.from || undefined, to: b.to || undefined, fuelType: fuel(b.fuelType), maxLoads: typeof b.maxLoads === 'number' ? b.maxLoads : null }));
  }
  if (route === 'GET /profile') {
    const pools = new Map<string, string[]>();
    for (const p of data.promotions) for (const cap of p.rule.caps) if (cap.poolId) pools.set(cap.poolId, [...(pools.get(cap.poolId) ?? []), p.name]);
    return ok({
      profile: store.profile(),
      catalog: data.catalog,
      provinces: PROVINCES,
      adjustments: st.adjustments,
      pools: [...pools.entries()].map(([id, names]) => ({ id, promotions: names })),
      configured: st.configured,
    });
  }
  if (route === 'PUT /profile') {
    const p = st.profile;
    if ('region' in b) p.region = b.region || null;
    if (b.allowSplitPayment) p.allowSplitPayment = b.allowSplitPayment as TriState;
    if ('maxLoadAmount' in b) p.maxLoadAmount = int(b.maxLoadAmount);
    if ('estimatedMonthlyFuelBudget' in b) p.estimatedMonthlyFuelBudget = int(b.estimatedMonthlyFuelBudget);
    if ('defaultPricePerLitre' in b) p.defaultPricePerLitre = int(b.defaultPricePerLitre);
    if (fuel(b.defaultFuelType)) p.defaultFuelType = b.defaultFuelType;
    if ('defaultStationId' in b) p.defaultStationId = b.defaultStationId || null;
    if (Array.isArray(b.paymentMethodIds)) p.paymentMethodIds = b.paymentMethodIds.map(String).filter((id: string) => data.catalog.paymentMethods.some((m) => m.id === id));
    if (b.segments && typeof b.segments === 'object') p.segments = { ...p.segments, ...b.segments };
    if (Array.isArray(b.loyaltyMemberships)) p.loyaltyMemberships = b.loyaltyMemberships.map(String);
    if (Array.isArray(b.apps)) p.apps = b.apps.map(String);
    st.configured = true;
    saveLocal(st);
    return ok({ profile: store.profile() });
  }
  if (route === 'GET /transactions') return ok(uc.historySummary(store, q.month || undefined));
  if (route === 'POST /transactions') {
    if (!b.paymentMethodId) throw new LocalApiError('Elegí el medio de pago.', 400);
    if (b.amount == null && b.amountPaid == null) throw new LocalApiError('Indicá el monto cargado o lo que pagaste.', 400);
    try {
      const res = uc.registerTransaction(store, {
        date: b.date && isLocalDate(b.date) ? b.date : undefined,
        amount: int(b.amount),
        amountPaid: int(b.amountPaid),
        paymentMethodId: String(b.paymentMethodId),
        fuelType: fuel(b.fuelType),
        litres: b.litres ? Number(b.litres) : null,
        pricePerLitre: int(b.pricePerLitre),
        stationId: b.stationId || null,
        promotionIds: Array.isArray(b.promotionIds) ? b.promotionIds.map(String) : undefined,
        actualBenefits: Array.isArray(b.actualBenefits) ? b.actualBenefits.map((x: any) => ({ promotionId: String(x.promotionId), amount: int(x.amount) ?? 0 })) : undefined,
        notes: b.notes ? String(b.notes) : null,
      });
      return ok(res);
    } catch (e) {
      throw new LocalApiError((e as Error).message, 400);
    }
  }
  const delTx = /^DELETE \/transactions\/(.+)$/.exec(route);
  if (delTx) {
    st.transactions = st.transactions.filter((t) => t.id !== delTx[1]);
    saveLocal(st);
    return ok({ ok: true });
  }
  if (route === 'POST /adjustments') {
    const amount = int(b.amount);
    if (!amount || !b.date || !isLocalDate(b.date) || (!b.poolId && !b.promotionId)) throw new LocalApiError('Completá tope, monto y fecha.', 400);
    st.adjustments.push({ id: crypto.randomUUID(), date: b.date, amount, poolId: b.poolId || null, promotionId: b.promotionId || null, note: b.note || '' });
    saveLocal(st);
    return ok({ ok: true });
  }
  const delAdj = /^DELETE \/adjustments\/(.+)$/.exec(route);
  if (delAdj) {
    st.adjustments = st.adjustments.filter((a) => a.id !== delAdj[1]);
    saveLocal(st);
    return ok({ ok: true });
  }
  if (route === 'GET /promotions') return ok({ promotions: data.promotions });
  if (route === 'GET /status') {
    const { catalog: _c, fuelPrices: _f, ...rest } = data;
    return ok({ ...rest, stations: data.catalog.stations.length });
  }
  if (route === 'GET /backup') return ok(st);
  if (route === 'POST /backup') {
    local = parseBackup(typeof body === 'string' ? body : JSON.stringify(body));
    saveLocal(local);
    return ok({ ok: true });
  }
  throw new LocalApiError(`Ruta desconocida: ${route}`, 404);
}

/** Recargar datos publicados (p. ej. al volver a abrir la app). */
export function refreshData() {
  dataPromise = null;
}
