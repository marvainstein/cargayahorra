/**
 * Repositorio de promociones con historial de versiones.
 *
 * - Cambiar condiciones (porcentaje, tope, días…) crea una NUEVA versión: nunca
 *   se sobrescribe una versión existente, así los cálculos históricos se pueden
 *   reconstruir con la versión que estaba vigente.
 * - Cambios de estado (verificar, revisar, marcar desactualizada) se registran
 *   como eventos de auditoría.
 */
import { randomUUID } from 'node:crypto';
import type { Clock, IsoWeekday } from '../../core/time';
import type {
  BenefitCap,
  CardNetwork,
  Confidence,
  FuelType,
  PaymentMethodType,
  Promotion,
  PromotionRule,
  PromotionStatus,
  UnknownCondition,
  UsageLimit,
} from '../../core/types';
import { all, type DB, get, type Row, run, transaction } from './db';

export interface PromotionDraft {
  providerId: string;
  fuelBrandId: string | null;
  name: string;
  description: string;
  status: PromotionStatus;
  confidence: Confidence;
  validFrom: string;
  validUntil: string | null;
  sourceUrl: string | null;
  sourceName: string | null;
  retrievedAt: string | null;
  lastVerifiedAt: string | null;
  rule: PromotionRule;
  rawExcerpt?: string | null;
}

export interface PromotionMeta {
  sourceId: string | null;
  sourceKey: string | null;
  active: boolean;
  pendingReviewReason: string | null;
  sourceFingerprint: string | null;
  createdAt: string;
}

export interface PromotionEvent {
  id: number;
  promotionId: string;
  versionId: string | null;
  at: string;
  actor: string;
  type: string;
  detail: string | null;
}

const ELIGIBILITY_DIMENSIONS = {
  PROVIDER: 'eligibleProviderIds',
  PAYMENT_METHOD: 'eligiblePaymentMethodIds',
  PAYMENT_METHOD_TYPE: 'eligiblePaymentMethodTypes',
  NETWORK: 'eligibleNetworks',
  FUEL_TYPE: 'eligibleFuelTypes',
  STATION: 'eligibleStationIds',
  REGION: 'eligibleRegions',
  EXCLUDED_REGION: 'excludedRegions',
  SEGMENT: 'eligibleCustomerSegments',
  DAY_OF_WEEK: 'daysOfWeek',
  DAY_OF_MONTH: 'daysOfMonth',
} as const;
type Dimension = keyof typeof ELIGIBILITY_DIMENSIONS;

function rowToPromotion(db: DB, v: Row, p: Row): Promotion {
  const vid = v.id as string;
  const caps: BenefitCap[] = all(db, 'SELECT amount, period, pool_id FROM promotion_cap WHERE version_id = ? ORDER BY id', vid).map((c) => ({
    amount: Number(c.amount),
    period: c.period,
    poolId: c.pool_id ?? null,
  }));
  const usageLimits: UsageLimit[] = all(db, 'SELECT max_transactions, period FROM promotion_usage_limit WHERE version_id = ? ORDER BY id', vid).map((u) => ({
    maxTransactions: Number(u.max_transactions),
    period: u.period,
  }));
  const elig = all(db, 'SELECT dimension, value FROM promotion_eligibility WHERE version_id = ?', vid);
  const lists: Record<string, string[]> = {};
  for (const e of elig) (lists[e.dimension] ??= []).push(e.value);
  const listOf = (d: Dimension) => (lists[d] ? [...lists[d]].sort() : null);
  const unknown = all(db, 'SELECT condition FROM promotion_unknown_condition WHERE version_id = ?', vid).map((r) => r.condition as UnknownCondition);
  const stackableWith = all(db, 'SELECT other_promotion_id FROM promotion_stackable_with WHERE version_id = ?', vid).map((r) => r.other_promotion_id as string);

  const rule: PromotionRule = {
    discountType: v.discount_type,
    discountValue: Number(v.discount_value),
    delivery: v.delivery,
    stage: v.stage,
    caps,
    minimumPurchase: v.minimum_purchase == null ? null : Number(v.minimum_purchase),
    maximumPurchase: v.maximum_purchase == null ? null : Number(v.maximum_purchase),
    minimumLitres: v.minimum_litres == null ? null : Number(v.minimum_litres),
    usageLimits,
    daysOfWeek: (listOf('DAY_OF_WEEK')?.map(Number).sort((a, b) => a - b) ?? null) as IsoWeekday[] | null,
    daysOfMonth: listOf('DAY_OF_MONTH')?.map(Number).sort((a, b) => a - b) ?? null,
    eligibleProviderIds: listOf('PROVIDER'),
    eligiblePaymentMethodIds: listOf('PAYMENT_METHOD'),
    eligiblePaymentMethodTypes: listOf('PAYMENT_METHOD_TYPE') as PaymentMethodType[] | null,
    eligibleNetworks: listOf('NETWORK') as CardNetwork[] | null,
    eligibleFuelTypes: listOf('FUEL_TYPE') as FuelType[] | null,
    eligibleStationIds: listOf('STATION'),
    eligibleRegions: listOf('REGION'),
    excludedRegions: listOf('EXCLUDED_REGION'),
    eligibleCustomerSegments: listOf('SEGMENT'),
    requiredLoyaltyProgrammeId: v.required_loyalty_programme_id ?? null,
    requiresApp: v.requires_app ?? null,
    requiresQR: !!v.requires_qr,
    requiresNFC: !!v.requires_nfc,
    requiresSpecificCard: !!v.requires_specific_card,
    stackable: v.stackable,
    stackableWith,
    multipleOperationsPerDay: v.multiple_operations_per_day,
    weekStartsOn: Number(v.week_starts_on) as PromotionRule['weekStartsOn'],
    unknownConditions: unknown.sort(),
    notes: JSON.parse(v.notes_json ?? '[]'),
    extra: JSON.parse(v.extra_json ?? '{}'),
  };
  return {
    id: p.id,
    versionId: vid,
    version: Number(v.version),
    providerId: p.provider_id,
    fuelBrandId: p.fuel_brand_id ?? null,
    name: v.name,
    description: v.description ?? '',
    status: v.status,
    validFrom: v.valid_from,
    validUntil: v.valid_until ?? null,
    sourceUrl: v.source_url ?? null,
    sourceName: v.source_name ?? null,
    retrievedAt: v.retrieved_at ?? null,
    lastVerifiedAt: v.last_verified_at ?? null,
    confidence: v.confidence,
    pendingReview: !!p.pending_review,
    rule,
  };
}

export function loadPromotions(db: DB, opts: { includeInactive?: boolean } = {}): Promotion[] {
  const ps = all(db, `SELECT * FROM promotion ${opts.includeInactive ? '' : 'WHERE active = 1'} ORDER BY created_at, id`);
  return ps
    .filter((p) => p.current_version_id)
    .map((p) => rowToPromotion(db, get(db, 'SELECT * FROM promotion_version WHERE id = ?', p.current_version_id)!, p));
}

export function getPromotion(db: DB, id: string): (Promotion & { meta: PromotionMeta }) | null {
  const p = get(db, 'SELECT * FROM promotion WHERE id = ?', id);
  if (!p || !p.current_version_id) return null;
  const v = get(db, 'SELECT * FROM promotion_version WHERE id = ?', p.current_version_id)!;
  return { ...rowToPromotion(db, v, p), meta: metaOf(p) };
}

function metaOf(p: Row): PromotionMeta {
  return {
    sourceId: p.source_id ?? null,
    sourceKey: p.source_key ?? null,
    active: !!p.active,
    pendingReviewReason: p.pending_review_reason ?? null,
    sourceFingerprint: p.source_fingerprint ?? null,
    createdAt: p.created_at,
  };
}

export function getPromotionMeta(db: DB, id: string): PromotionMeta | null {
  const p = get(db, 'SELECT * FROM promotion WHERE id = ?', id);
  return p ? metaOf(p) : null;
}

export function findBySourceKey(db: DB, sourceId: string, sourceKey: string): (Promotion & { meta: PromotionMeta }) | null {
  const p = get(db, 'SELECT id FROM promotion WHERE source_id = ? AND source_key = ?', sourceId, sourceKey);
  return p ? getPromotion(db, p.id) : null;
}

export function listBySource(db: DB, sourceId: string): Array<Promotion & { meta: PromotionMeta }> {
  return all(db, 'SELECT id FROM promotion WHERE source_id = ?', sourceId)
    .map((r) => getPromotion(db, r.id))
    .filter((p): p is Promotion & { meta: PromotionMeta } => !!p);
}

export function getVersion(db: DB, versionId: string): Promotion | null {
  const v = get(db, 'SELECT * FROM promotion_version WHERE id = ?', versionId);
  if (!v) return null;
  const p = get(db, 'SELECT * FROM promotion WHERE id = ?', v.promotion_id)!;
  return rowToPromotion(db, v, p);
}

export function listVersions(db: DB, promotionId: string): Array<Promotion & { createdAt: string; createdBy: string; changeReason: string | null }> {
  const p = get(db, 'SELECT * FROM promotion WHERE id = ?', promotionId);
  if (!p) return [];
  return all(db, 'SELECT * FROM promotion_version WHERE promotion_id = ? ORDER BY version DESC', promotionId).map((v) => ({
    ...rowToPromotion(db, v, p),
    createdAt: v.created_at,
    createdBy: v.created_by,
    changeReason: v.change_reason ?? null,
  }));
}

export function listEvents(db: DB, promotionId: string): PromotionEvent[] {
  return all(db, 'SELECT * FROM promotion_event WHERE promotion_id = ? ORDER BY id DESC', promotionId).map((e) => ({
    id: Number(e.id),
    promotionId: e.promotion_id,
    versionId: e.version_id ?? null,
    at: e.at,
    actor: e.actor,
    type: e.type,
    detail: e.detail ?? null,
  }));
}

function insertVersion(db: DB, promotionId: string, version: number, d: PromotionDraft, actor: string, reason: string | null, now: string): string {
  const id = randomUUID();
  const r = d.rule;
  run(
    db,
    `INSERT INTO promotion_version (id, promotion_id, version, name, description, status, confidence, valid_from, valid_until,
      source_url, source_name, retrieved_at, last_verified_at, discount_type, discount_value, delivery, stage,
      minimum_purchase, maximum_purchase, minimum_litres, required_loyalty_programme_id, requires_app, requires_qr, requires_nfc,
      requires_specific_card, stackable, multiple_operations_per_day, week_starts_on, notes_json, extra_json, raw_excerpt,
      created_at, created_by, change_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    promotionId,
    version,
    d.name,
    d.description,
    d.status,
    d.confidence,
    d.validFrom,
    d.validUntil,
    d.sourceUrl,
    d.sourceName,
    d.retrievedAt,
    d.lastVerifiedAt,
    r.discountType,
    r.discountValue,
    r.delivery,
    r.stage,
    r.minimumPurchase,
    r.maximumPurchase,
    r.minimumLitres,
    r.requiredLoyaltyProgrammeId,
    r.requiresApp,
    r.requiresQR ? 1 : 0,
    r.requiresNFC ? 1 : 0,
    r.requiresSpecificCard ? 1 : 0,
    r.stackable,
    r.multipleOperationsPerDay,
    r.weekStartsOn,
    JSON.stringify(r.notes ?? []),
    JSON.stringify(r.extra ?? {}),
    d.rawExcerpt ?? null,
    now,
    actor,
    reason,
  );
  for (const c of r.caps) run(db, 'INSERT INTO promotion_cap (version_id, amount, period, pool_id) VALUES (?,?,?,?)', id, c.amount, c.period, c.poolId ?? null);
  for (const u of r.usageLimits) run(db, 'INSERT INTO promotion_usage_limit (version_id, max_transactions, period) VALUES (?,?,?)', id, u.maxTransactions, u.period);
  for (const [dim, key] of Object.entries(ELIGIBILITY_DIMENSIONS)) {
    const values = (r as unknown as Record<string, unknown[] | null>)[key];
    if (values) for (const val of new Set(values.map(String))) run(db, 'INSERT INTO promotion_eligibility (version_id, dimension, value) VALUES (?,?,?)', id, dim, val);
  }
  for (const c of new Set(r.unknownConditions)) run(db, 'INSERT INTO promotion_unknown_condition (version_id, condition) VALUES (?,?)', id, c);
  for (const o of new Set(r.stackableWith)) run(db, 'INSERT INTO promotion_stackable_with (version_id, other_promotion_id) VALUES (?,?)', id, o);
  return id;
}

export function logEvent(db: DB, promotionId: string, versionId: string | null, actor: string, type: string, detail: string | null, now: string) {
  run(db, 'INSERT INTO promotion_event (promotion_id, version_id, at, actor, type, detail) VALUES (?,?,?,?,?,?)', promotionId, versionId, now, actor, type, detail);
}

export function createPromotion(
  db: DB,
  clock: Clock,
  draft: PromotionDraft,
  opts: { id?: string; sourceId?: string | null; sourceKey?: string | null; actor: string; reason?: string; pendingReviewReason?: string | null },
): Promotion {
  const now = clock.now().toISOString();
  const id = opts.id ?? randomUUID();
  return transaction(db, () => {
    run(
      db,
      'INSERT INTO promotion (id, provider_id, fuel_brand_id, source_id, source_key, pending_review, pending_review_reason, active, created_at) VALUES (?,?,?,?,?,?,?,1,?)',
      id,
      draft.providerId,
      draft.fuelBrandId,
      opts.sourceId ?? null,
      opts.sourceKey ?? null,
      opts.pendingReviewReason ? 1 : 0,
      opts.pendingReviewReason ?? null,
      now,
    );
    const vid = insertVersion(db, id, 1, draft, opts.actor, opts.reason ?? 'Alta', now);
    run(db, 'UPDATE promotion SET current_version_id = ? WHERE id = ?', vid, id);
    logEvent(db, id, vid, opts.actor, 'CREATED', opts.reason ?? null, now);
    return getPromotion(db, id)!;
  });
}

/** Crea una nueva versión (las anteriores quedan intactas en el historial). */
export function addVersion(db: DB, clock: Clock, promotionId: string, draft: PromotionDraft, opts: { actor: string; reason: string; clearPendingReview?: boolean }): Promotion {
  const now = clock.now().toISOString();
  return transaction(db, () => {
    const p = get(db, 'SELECT * FROM promotion WHERE id = ?', promotionId);
    if (!p) throw new Error(`Promoción inexistente: ${promotionId}`);
    const max = get(db, 'SELECT MAX(version) AS v FROM promotion_version WHERE promotion_id = ?', promotionId)!;
    const version = Number(max.v ?? 0) + 1;
    const vid = insertVersion(db, promotionId, version, draft, opts.actor, opts.reason, now);
    run(db, 'UPDATE promotion SET current_version_id = ?, provider_id = ?, fuel_brand_id = ? WHERE id = ?', vid, draft.providerId, draft.fuelBrandId, promotionId);
    if (opts.clearPendingReview) run(db, 'UPDATE promotion SET pending_review = 0, pending_review_reason = NULL WHERE id = ?', promotionId);
    logEvent(db, promotionId, vid, opts.actor, 'NEW_VERSION', `v${version}: ${opts.reason}`, now);
    return getPromotion(db, promotionId)!;
  });
}

/** Cambia el estado de la versión vigente (verificar, revisar, desactualizada, inválida). */
export function setStatus(db: DB, clock: Clock, promotionId: string, status: PromotionStatus, actor: string, detail: string | null = null) {
  const now = clock.now().toISOString();
  transaction(db, () => {
    const p = get(db, 'SELECT current_version_id FROM promotion WHERE id = ?', promotionId);
    if (!p) throw new Error(`Promoción inexistente: ${promotionId}`);
    const verified = status === 'VERIFIED' || status === 'MANUALLY_REVIEWED';
    run(
      db,
      `UPDATE promotion_version SET status = ?${verified ? ', last_verified_at = ?' : ''} WHERE id = ?`,
      ...(verified ? [status, now, p.current_version_id] : [status, p.current_version_id]),
    );
    if (verified) run(db, 'UPDATE promotion SET pending_review = 0, pending_review_reason = NULL WHERE id = ?', promotionId);
    logEvent(db, promotionId, p.current_version_id, actor, `STATUS_${status}`, detail, now);
  });
}

/** La fuente confirmó que la promoción sigue igual. */
export function touchVerified(db: DB, clock: Clock, promotionId: string, retrievedAt: string) {
  const p = get(db, 'SELECT current_version_id FROM promotion WHERE id = ?', promotionId);
  if (!p) return;
  const v = get(db, 'SELECT status FROM promotion_version WHERE id = ?', p.current_version_id)!;
  // Una promoción STALE vuelve a su estado anterior sólo por revisión humana; acá sólo
  // registramos que la fuente la volvió a mostrar sin cambios.
  run(db, 'UPDATE promotion_version SET retrieved_at = ? WHERE id = ?', retrievedAt, p.current_version_id);
  if (v.status === 'VERIFIED') run(db, 'UPDATE promotion_version SET last_verified_at = ? WHERE id = ?', clock.now().toISOString(), p.current_version_id);
}

export function setActive(db: DB, clock: Clock, promotionId: string, active: boolean, actor: string, detail: string | null = null) {
  const now = clock.now().toISOString();
  run(db, 'UPDATE promotion SET active = ? WHERE id = ?', active ? 1 : 0, promotionId);
  logEvent(db, promotionId, null, actor, active ? 'ACTIVATED' : 'DEACTIVATED', detail, now);
}

export function setPendingReview(db: DB, clock: Clock, promotionId: string, reason: string | null, actor: string) {
  const now = clock.now().toISOString();
  run(db, 'UPDATE promotion SET pending_review = ?, pending_review_reason = ? WHERE id = ?', reason ? 1 : 0, reason, promotionId);
  logEvent(db, promotionId, null, actor, reason ? 'PENDING_REVIEW' : 'REVIEW_CLEARED', reason, now);
}

export function draftFromPromotion(p: Promotion): PromotionDraft {
  return {
    providerId: p.providerId,
    fuelBrandId: p.fuelBrandId,
    name: p.name,
    description: p.description,
    status: p.status,
    confidence: p.confidence,
    validFrom: p.validFrom,
    validUntil: p.validUntil,
    sourceUrl: p.sourceUrl,
    sourceName: p.sourceName,
    retrievedAt: p.retrievedAt,
    lastVerifiedAt: p.lastVerifiedAt,
    rule: p.rule,
  };
}

export function setSourceFingerprint(db: DB, promotionId: string, fingerprint: string | null) {
  run(db, 'UPDATE promotion SET source_fingerprint = ? WHERE id = ?', fingerprint, promotionId);
}
