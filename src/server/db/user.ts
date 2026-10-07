/**
 * Catálogo, perfil del usuario, historial de cargas y ajustes de topes.
 * Nunca se guardan números de tarjeta, CVV ni credenciales: sólo qué medios
 * de pago y beneficios tiene el usuario.
 */
import { randomUUID } from 'node:crypto';
import type { Catalog } from '../../core/rules/engine';
import type { Cents } from '../../core/money';
import type {
  AppliedPromotion,
  CapUsageAdjustment,
  FuelTransaction,
  FuelType,
  PaymentMethod,
  PaymentProvider,
  Station,
  TriState,
  UserProfile,
} from '../../core/types';
import { all, type DB, get, run, transaction } from './db';

export const DEFAULT_USER_ID = 'default';

export interface CatalogData {
  providers: PaymentProvider[];
  paymentMethods: PaymentMethod[];
  segments: Array<{ id: string; providerId: string | null; name: string; question: string | null; groupId: string | null }>;
  segmentGroups: Array<{ id: string; providerId: string | null; label: string; allowNone: boolean; noneLabel: string | null }>;
  programmes: Array<{ id: string; name: string; fuelBrandId: string | null }>;
  apps: Array<{ id: string; name: string }>;
  stations: Station[];
}

export function loadCatalog(db: DB): CatalogData {
  return {
    providers: all(db, 'SELECT * FROM payment_provider ORDER BY name').map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
    paymentMethods: all(db, 'SELECT * FROM payment_method ORDER BY name').map((r) => ({
      id: r.id,
      providerId: r.provider_id,
      name: r.name,
      type: r.type,
      network: r.network ?? null,
    })),
    segments: all(db, 'SELECT * FROM customer_segment ORDER BY provider_id, name').map((r) => ({
      id: r.id,
      providerId: r.provider_id ?? null,
      name: r.name,
      question: r.question ?? null,
      groupId: r.group_id ?? null,
    })),
    segmentGroups: all(db, 'SELECT * FROM customer_segment_group ORDER BY id').map((r) => ({
      id: r.id,
      providerId: r.provider_id ?? null,
      label: r.label,
      allowNone: !!r.allow_none,
      noneLabel: r.none_label ?? null,
    })),
    programmes: all(db, 'SELECT * FROM loyalty_programme ORDER BY name').map((r) => ({ id: r.id, name: r.name, fuelBrandId: r.fuel_brand_id ?? null })),
    apps: all(db, 'SELECT * FROM app ORDER BY name').map((r) => ({ id: r.id, name: r.name })),
    stations: all(db, 'SELECT * FROM station WHERE active = 1 ORDER BY name').map((r) => ({
      id: r.id,
      brandId: r.brand_id,
      name: r.name,
      address: r.address ?? null,
      region: r.region ?? null,
      latitude: r.latitude ?? null,
      longitude: r.longitude ?? null,
      active: !!r.active,
      attributes: JSON.parse(r.attributes_json ?? '{}'),
    })),
  };
}

/** Nombres legibles para las explicaciones del motor. */
export function engineCatalog(c: CatalogData): Catalog {
  const byId = <T extends { id: string; name: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x.name]));
  const providers = byId(c.providers);
  const segments = byId(c.segments);
  const programmes = new Map([...byId(c.programmes), ...byId(c.apps)]);
  const methods = byId(c.paymentMethods);
  return {
    providerName: (id) => providers.get(id) ?? id,
    segmentName: (id) => segments.get(id) ?? id,
    programmeName: (id) => programmes.get(id) ?? id,
    paymentMethodName: (id) => methods.get(id) ?? id,
  };
}

export interface ProfileExtras {
  defaultPricePerLitre: Cents | null;
}

export function getProfile(db: DB, userId = DEFAULT_USER_ID): UserProfile & ProfileExtras {
  const u = get(db, 'SELECT * FROM user WHERE id = ?', userId);
  if (!u) throw new Error(`Usuario inexistente: ${userId}`);
  const methods = all(
    db,
    `SELECT pm.* FROM user_payment_method upm JOIN payment_method pm ON pm.id = upm.payment_method_id
     WHERE upm.user_id = ? AND upm.active = 1 ORDER BY pm.name`,
    userId,
  ).map((r) => ({ id: r.id, providerId: r.provider_id, name: r.name, type: r.type, network: r.network ?? null }));
  const segments: Record<string, TriState> = {};
  for (const s of all(db, 'SELECT segment_id, status FROM user_segment WHERE user_id = ?', userId)) segments[s.segment_id] = s.status;
  return {
    id: u.id,
    timezone: u.timezone,
    currency: u.currency,
    locale: u.locale,
    paymentMethods: methods,
    segments,
    loyaltyMemberships: all(db, 'SELECT programme_id FROM user_loyalty_membership WHERE user_id = ?', userId).map((r) => r.programme_id),
    apps: all(db, 'SELECT app_id FROM user_app WHERE user_id = ?', userId).map((r) => r.app_id),
    region: u.region ?? null,
    allowSplitPayment: u.allow_split_payment,
    maxLoadAmount: u.max_load_amount ?? null,
    estimatedMonthlyFuelBudget: u.estimated_monthly_fuel_budget ?? null,
    defaultFuelType: u.default_fuel_type,
    defaultStationId: u.default_station_id ?? null,
    defaultPricePerLitre: u.default_price_per_litre ?? null,
  };
}

export interface ProfilePatch {
  region?: string | null;
  allowSplitPayment?: TriState;
  maxLoadAmount?: Cents | null;
  estimatedMonthlyFuelBudget?: Cents | null;
  defaultFuelType?: FuelType;
  defaultStationId?: string | null;
  defaultPricePerLitre?: Cents | null;
  paymentMethodIds?: string[];
  segments?: Record<string, TriState>;
  loyaltyMemberships?: string[];
  apps?: string[];
}

export function updateProfile(db: DB, now: string, patch: ProfilePatch, userId = DEFAULT_USER_ID) {
  transaction(db, () => {
    const cols: Array<[string, unknown]> = [];
    if ('region' in patch) cols.push(['region', patch.region]);
    if (patch.allowSplitPayment) cols.push(['allow_split_payment', patch.allowSplitPayment]);
    if ('maxLoadAmount' in patch) cols.push(['max_load_amount', patch.maxLoadAmount]);
    if ('estimatedMonthlyFuelBudget' in patch) cols.push(['estimated_monthly_fuel_budget', patch.estimatedMonthlyFuelBudget]);
    if (patch.defaultFuelType) cols.push(['default_fuel_type', patch.defaultFuelType]);
    if ('defaultStationId' in patch) cols.push(['default_station_id', patch.defaultStationId]);
    if ('defaultPricePerLitre' in patch) cols.push(['default_price_per_litre', patch.defaultPricePerLitre]);
    cols.push(['updated_at', now]);
    run(db, `UPDATE user SET ${cols.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map(([, v]) => v ?? null), userId);
    if (patch.paymentMethodIds) {
      run(db, 'UPDATE user_payment_method SET active = 0 WHERE user_id = ?', userId);
      for (const id of patch.paymentMethodIds)
        run(db, 'INSERT INTO user_payment_method (user_id, payment_method_id, active) VALUES (?,?,1) ON CONFLICT DO UPDATE SET active = 1', userId, id);
    }
    if (patch.segments) {
      for (const [seg, status] of Object.entries(patch.segments))
        run(db, 'INSERT INTO user_segment (user_id, segment_id, status) VALUES (?,?,?) ON CONFLICT DO UPDATE SET status = excluded.status', userId, seg, status);
    }
    if (patch.loyaltyMemberships) {
      run(db, 'DELETE FROM user_loyalty_membership WHERE user_id = ?', userId);
      for (const id of patch.loyaltyMemberships) run(db, 'INSERT INTO user_loyalty_membership (user_id, programme_id) VALUES (?,?)', userId, id);
    }
    if (patch.apps) {
      run(db, 'DELETE FROM user_app WHERE user_id = ?', userId);
      for (const id of patch.apps) run(db, 'INSERT INTO user_app (user_id, app_id) VALUES (?,?)', userId, id);
    }
  });
}

// ───────────── Historial ─────────────

export function listTransactions(db: DB, opts: { from?: string; to?: string } = {}, userId = DEFAULT_USER_ID): FuelTransaction[] {
  const rows = all(
    db,
    `SELECT * FROM fuel_transaction WHERE user_id = ? AND local_date >= ? AND local_date <= ? ORDER BY local_date DESC, occurred_at DESC`,
    userId,
    opts.from ?? '0000-01-01',
    opts.to ?? '9999-12-31',
  );
  return rows.map((r) => ({
    id: r.id,
    date: r.local_date,
    stationId: r.station_id ?? null,
    fuelType: r.fuel_type,
    litres: r.litres ?? null,
    pricePerLitre: r.price_per_litre ?? null,
    grossAmount: Number(r.gross_amount),
    paymentMethodId: r.payment_method_id,
    discountAmount: Number(r.discount_amount),
    cashbackAmount: Number(r.cashback_amount),
    recommendedBenefit: r.recommended_benefit ?? null,
    promotionsApplied: all(db, 'SELECT * FROM fuel_transaction_promotion WHERE transaction_id = ?', r.id).map(
      (a): AppliedPromotion => ({
        promotionId: a.promotion_id,
        promotionVersionId: a.promotion_version_id,
        discountAmount: Number(a.discount_amount),
        cashbackAmount: Number(a.cashback_amount),
        poolIds: JSON.parse(a.pool_ids_json),
      }),
    ),
  }));
}

export function insertTransaction(db: DB, now: string, tx: Omit<FuelTransaction, 'id'> & { notes?: string | null }, userId = DEFAULT_USER_ID): string {
  const id = randomUUID();
  transaction(db, () => {
    run(
      db,
      `INSERT INTO fuel_transaction (id, user_id, occurred_at, local_date, station_id, fuel_type, litres, price_per_litre, gross_amount,
        payment_method_id, discount_amount, cashback_amount, recommended_benefit, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      userId,
      now,
      tx.date,
      tx.stationId,
      tx.fuelType,
      tx.litres,
      tx.pricePerLitre,
      tx.grossAmount,
      tx.paymentMethodId,
      tx.discountAmount,
      tx.cashbackAmount,
      tx.recommendedBenefit,
      tx.notes ?? null,
    );
    for (const a of tx.promotionsApplied)
      run(
        db,
        'INSERT INTO fuel_transaction_promotion (transaction_id, promotion_id, promotion_version_id, discount_amount, cashback_amount, pool_ids_json) VALUES (?,?,?,?,?,?)',
        id,
        a.promotionId,
        a.promotionVersionId,
        a.discountAmount,
        a.cashbackAmount,
        JSON.stringify(a.poolIds),
      );
  });
  return id;
}

export function deleteTransaction(db: DB, id: string, userId = DEFAULT_USER_ID): boolean {
  return Number(run(db, 'DELETE FROM fuel_transaction WHERE id = ? AND user_id = ?', id, userId).changes) > 0;
}

export function listAdjustments(db: DB, userId = DEFAULT_USER_ID): CapUsageAdjustment[] {
  return all(db, 'SELECT * FROM cap_usage_adjustment WHERE user_id = ? ORDER BY local_date DESC', userId).map((r) => ({
    id: r.id,
    date: r.local_date,
    promotionId: r.promotion_id ?? null,
    poolId: r.pool_id ?? null,
    amount: Number(r.amount),
    note: r.note,
  }));
}

export function insertAdjustment(db: DB, a: Omit<CapUsageAdjustment, 'id'>, userId = DEFAULT_USER_ID): string {
  const id = randomUUID();
  run(db, 'INSERT INTO cap_usage_adjustment (id, user_id, local_date, promotion_id, pool_id, amount, note) VALUES (?,?,?,?,?,?,?)', id, userId, a.date, a.promotionId, a.poolId, a.amount, a.note);
  return id;
}

export function deleteAdjustment(db: DB, id: string, userId = DEFAULT_USER_ID): boolean {
  return Number(run(db, 'DELETE FROM cap_usage_adjustment WHERE id = ? AND user_id = ?', id, userId).changes) > 0;
}
