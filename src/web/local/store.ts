/**
 * Almacenamiento de la web estática.
 *
 *  - Datos públicos (promociones verificadas, estaciones, estado de fuentes):
 *    ./data/app-data.json, generado por GitHub Actions (src/server/export-static.ts).
 *  - Datos personales (perfil, cargas, ajustes de topes): sólo en este
 *    dispositivo (localStorage), con exportar/importar como respaldo.
 */
import type { AppProfile, AppStore, CatalogData, FuelPriceRow, SourceHealth } from '../../app/types';
import type { CapUsageAdjustment, FuelTransaction, FuelType, Promotion, TriState } from '../../core/types';
import { DEFAULT_TIMEZONE } from '../../core/time';

export interface AppData {
  version: number;
  generatedAt: string;
  fuelBrandId: string;
  promotions: Promotion[];
  catalog: CatalogData;
  fuelPrices: FuelPriceRow[];
  sources: SourceHealth[];
  review: Array<{ promotionId: string; name: string; status: string; reason: string | null }>;
  candidates: Array<{ kind: string; sourceId: string; sourceKey: string; promotionId: string | null; title: string | null }>;
}

export interface LocalProfile {
  paymentMethodIds: string[];
  segments: Record<string, TriState>;
  loyaltyMemberships: string[];
  apps: string[];
  region: string | null;
  allowSplitPayment: TriState;
  maxLoadAmount: number | null;
  estimatedMonthlyFuelBudget: number | null;
  defaultFuelType: FuelType;
  defaultStationId: string | null;
  defaultPricePerLitre: number | null;
}

export interface LocalState {
  version: 1;
  /** false hasta que el usuario configura qué tiene. */
  configured: boolean;
  profile: LocalProfile;
  transactions: FuelTransaction[];
  adjustments: CapUsageAdjustment[];
}

const KEY = 'cya-local-v1';

export const EMPTY_PROFILE: LocalProfile = {
  paymentMethodIds: [],
  segments: {},
  loyaltyMemberships: [],
  apps: [],
  region: null,
  allowSplitPayment: 'UNKNOWN',
  maxLoadAmount: null,
  estimatedMonthlyFuelBudget: null,
  defaultFuelType: 'SUPER',
  defaultStationId: null,
  defaultPricePerLitre: null,
};

export function emptyState(): LocalState {
  return { version: 1, configured: false, profile: { ...EMPTY_PROFILE }, transactions: [], adjustments: [] };
}

export function loadLocal(): LocalState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    const s = JSON.parse(raw) as LocalState;
    return { ...emptyState(), ...s, profile: { ...EMPTY_PROFILE, ...s.profile } };
  } catch {
    return emptyState();
  }
}

export function saveLocal(s: LocalState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // almacenamiento lleno o bloqueado: los cambios duran hasta cerrar la app
  }
}

/** Valida un respaldo importado. */
export function parseBackup(text: string): LocalState {
  const s = JSON.parse(text) as Partial<LocalState>;
  if (!s || typeof s !== 'object' || !s.profile || !Array.isArray(s.transactions)) throw new Error('El archivo no es un respaldo de Carga y Ahorra.');
  return { ...emptyState(), ...s, version: 1, configured: true, profile: { ...EMPTY_PROFILE, ...s.profile } } as LocalState;
}

export function buildStore(data: AppData, local: LocalState, persist: (s: LocalState) => void): AppStore {
  const profile = (): AppProfile => {
    const p = local.profile;
    return {
      id: 'local',
      timezone: DEFAULT_TIMEZONE,
      currency: 'ARS',
      locale: 'es-AR',
      paymentMethods: data.catalog.paymentMethods.filter((m) => p.paymentMethodIds.includes(m.id)),
      segments: p.segments,
      loyaltyMemberships: p.loyaltyMemberships,
      apps: p.apps,
      region: p.region,
      allowSplitPayment: p.allowSplitPayment,
      maxLoadAmount: p.maxLoadAmount,
      estimatedMonthlyFuelBudget: p.estimatedMonthlyFuelBudget,
      defaultFuelType: p.defaultFuelType,
      defaultStationId: p.defaultStationId,
      defaultPricePerLitre: p.defaultPricePerLitre,
    };
  };
  return {
    now: () => new Date(),
    profile,
    catalog: () => data.catalog,
    promotions: () => data.promotions,
    transactions: (range) =>
      local.transactions
        .filter((t) => (!range?.from || t.date >= range.from) && (!range?.to || t.date <= range.to))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    adjustments: () => local.adjustments,
    fuelPrices: () => data.fuelPrices,
    sources: () => data.sources,
    insertTransaction: (tx) => {
      const id = crypto.randomUUID();
      local.transactions.push({ ...tx, id });
      persist(local);
      return id;
    },
    fuelBrandId: data.fuelBrandId,
  };
}
