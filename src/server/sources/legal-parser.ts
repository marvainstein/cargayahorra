/**
 * Intérprete conservador de bases y condiciones en castellano.
 *
 * Extrae sólo lo que puede reconocer con certeza razonable. Todo lo que no
 * encuentra queda en `unknownConditions`: el motor de reglas nunca usará una
 * promoción con condiciones desconocidas para una recomendación definitiva.
 * Las promociones importadas así quedan como AUTOMATICALLY_IMPORTED hasta que
 * alguien las revise en el panel de administración.
 */
import { pesos } from '../../core/money';
import { normalizeText, provinceCode } from '../../core/regions';
import type { IsoWeekday, LocalDate } from '../../core/time';
import { isLocalDate } from '../../core/time';
import type {
  BenefitCap,
  BenefitStage,
  CapPeriod,
  CardNetwork,
  Confidence,
  FuelType,
  PaymentMethodType,
  PromotionRule,
  UnknownCondition,
  UsageLimit,
} from '../../core/types';

export interface LegalParseOptions {
  stage: BenefitStage;
  eligibleProviderIds: string[] | null;
  requiredLoyaltyProgrammeId?: string | null;
  segmentKeywords?: Array<{ pattern: RegExp; segmentId: string }>;
  /** Frases que indican que la promoción es para todos los clientes. */
  generalAudiencePatterns?: RegExp[];
  fuelKeywords?: Array<{ pattern: RegExp; fuelTypes: FuelType[] }>;
  appKeywords?: Array<{ pattern: RegExp; appId: string; qr?: boolean }>;
}

export interface LegalParseResult {
  rule: PromotionRule;
  validFrom: LocalDate | null;
  validUntil: LocalDate | null;
  confidence: Confidence;
  warnings: string[];
  /** Fragmentos reconocidos, para auditoría. */
  found: Record<string, string>;
}

const WEEKDAYS: Array<[RegExp, IsoWeekday]> = [
  [/^lunes$/, 1],
  [/^martes$/, 2],
  [/^miercoles$/, 3],
  [/^jueves$/, 4],
  [/^viernes$/, 5],
  [/^sabados?$/, 6],
  [/^domingos?$/, 7],
];
const WEEKDAY_WORD = '(?:lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)';
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "$ 12.000,50" → centavos. */
export function parseArs(s: string): number | null {
  const m = /\$?\s*([\d.]+(?:,\d{1,2})?)/.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? pesos(n) : null;
}

function weekday(word: string): IsoWeekday | null {
  for (const [re, d] of WEEKDAYS) if (re.test(word)) return d;
  return null;
}

function date(d: string, m: string, y: string): LocalDate | null {
  const s = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isLocalDate(s) ? s : null;
}

function capPeriodFrom(window: string): CapPeriod | 'AMBIGUOUS' | null {
  if (/quincen|cada dos semanas|cada 15 dias|cada catorce/.test(window)) return 'AMBIGUOUS';
  if (/por (transaccion|operacion|compra|ticket|carga)|por cada (compra|transaccion|operacion)/.test(window)) return 'PER_TRANSACTION';
  if (/semanal|por semana|cada semana/.test(window)) return 'WEEKLY';
  if (/mensual|por mes|cada mes|por cuenta por mes|mes calendario/.test(window)) return 'MONTHLY';
  if (/diari|por dia\b/.test(window)) return 'DAILY';
  if (/anual|por ano\b/.test(window)) return 'ANNUAL';
  if (/(durante|en) (toda )?(la )?(vigencia|promocion|periodo)/.test(window)) return 'PROMOTION_PERIOD';
  return null;
}

export function parseLegalText(original: string, opts: LegalParseOptions): LegalParseResult {
  const text = normalizeText(original).replace(/\s+/g, ' ');
  const unknown = new Set<UnknownCondition>();
  const warnings: string[] = [];
  const found: Record<string, string> = {};
  const notes: string[] = [];

  // ── Porcentaje / monto ──
  let discountType: PromotionRule['discountType'] = 'PERCENTAGE';
  let discountValue = 0;
  const pctMatches = [...text.matchAll(/(\d{1,2}(?:[.,]\d+)?)\s?%/g)];
  const relevantPct = pctMatches.filter((m) => {
    const around = text.slice(Math.max(0, m.index! - 40), m.index! + 40);
    return /descuento|reintegro|off|ahorr|bonific|devoluci/.test(around);
  });
  const distinct = [...new Set(relevantPct.map((m) => m[1].replace(',', '.')))];
  if (distinct.length === 1) {
    discountValue = Math.round(Number(distinct[0]) * 100);
    found.percentage = relevantPct[0][0];
  } else if (distinct.length > 1) {
    unknown.add('BENEFIT_VALUE');
    warnings.push(`Se encontraron varios porcentajes (${distinct.join('%, ')}%): pueden depender del plan o del día.`);
    discountValue = Math.round(Math.min(...distinct.map(Number)) * 100);
  } else {
    const perLitre = /\$\s?([\d.,]+)\s*(?:de descuento\s*)?por litro/.exec(text);
    if (perLitre) {
      discountType = 'PER_LITRE';
      discountValue = parseArs(perLitre[0]) ?? 0;
      found.perLitre = perLitre[0];
    } else {
      unknown.add('BENEFIT_VALUE');
    }
  }

  // ── Forma de entrega ──
  let delivery: PromotionRule['delivery'] = 'INSTANT_DISCOUNT';
  if (/reintegr|devoluci|cashback|se acreditara|seran acreditad/.test(text)) {
    delivery = 'CASHBACK';
    found.delivery = 'reintegro';
  } else if (/descuento/.test(text)) {
    delivery = 'INSTANT_DISCOUNT';
  } else unknown.add('DELIVERY');

  // ── Topes ──
  const caps: BenefitCap[] = [];
  if (/sin tope/.test(text)) {
    found.cap = 'sin tope';
  } else {
    const capRe = /tope[^$]{0,90}?\$\s?([\d.]+(?:,\d{1,2})?)([^.;]{0,60})/g;
    for (const m of text.matchAll(capRe)) {
      const before = m[0].slice(0, m[0].indexOf('$'));
      const after = m[2];
      const window = `${before} ${after}`;
      if (/otorgad|presupuesto|en total de reintegros|hasta agotar/.test(window)) continue;
      const amount = parseArs(`$${m[1]}`);
      if (!amount) continue;
      const period = capPeriodFrom(after) ?? capPeriodFrom(before);
      if (period === 'AMBIGUOUS' || period === null) {
        unknown.add('CAP_PERIOD');
        warnings.push(`Tope de $${m[1]} sin período claro: «${m[0].trim()}».`);
        continue;
      }
      caps.push({ amount, period });
      found[`cap_${caps.length}`] = m[0].trim();
    }
    if (caps.length === 0 && !unknown.has('CAP_PERIOD')) unknown.add('CAP');
  }
  const budget = /hasta (alcanzar|agotar|completar)[^.]{0,60}\$\s?[\d.]+/.exec(text);
  if (budget) notes.push('La promoción puede terminar antes de su vigencia si se agota el presupuesto total.');

  // ── Vigencia ──
  let validFrom: LocalDate | null = null;
  let validUntil: LocalDate | null = null;
  const range =
    /(?:desde el|del|a partir del)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(?:y\s+)?(?:hasta el|al|y el)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  if (range) {
    validFrom = date(range[1], range[2], range[3]);
    validUntil = date(range[4], range[5], range[6]);
    found.validity = range[0];
  } else {
    const textual = new RegExp(`del (\\d{1,2}) al (\\d{1,2}) de (${MONTHS.join('|')})(?: de| del)? (\\d{4})`).exec(text);
    if (textual) {
      const mm = String(MONTHS.indexOf(textual[3]) + 1);
      validFrom = date(textual[1], mm, textual[4]);
      validUntil = date(textual[2], mm, textual[4]);
      found.validity = textual[0];
    }
  }
  if (!validFrom || !validUntil || validFrom > validUntil) {
    unknown.add('VALIDITY');
    validFrom = validFrom && validUntil && validFrom <= validUntil ? validFrom : null;
  }

  // ── Días ──
  let daysOfWeek: IsoWeekday[] | null = null;
  if (/todos los dias/.test(text)) {
    found.days = 'todos los días';
  } else {
    const rangeDays = new RegExp(`de (${WEEKDAY_WORD}) a (${WEEKDAY_WORD})`).exec(text);
    const listRe = new RegExp(`(?:todos los |los |cada )?(${WEEKDAY_WORD}(?:(?:\\s*,\\s*|\\s+y\\s+|\\s+o\\s+)${WEEKDAY_WORD})*)`);
    const list = listRe.exec(text);
    if (rangeDays && (!list || rangeDays.index <= list.index)) {
      const a = weekday(rangeDays[1])!;
      const b = weekday(rangeDays[2])!;
      daysOfWeek = [];
      for (let d = a; ; d = ((d % 7) + 1) as IsoWeekday) {
        daysOfWeek.push(d);
        if (d === b) break;
      }
      found.days = rangeDays[0];
    } else if (list) {
      daysOfWeek = [...new Set(list[1].split(/\s*,\s*|\s+y\s+|\s+o\s+/).map(weekday).filter((d): d is IsoWeekday => d !== null))].sort();
      found.days = list[0];
    } else unknown.add('DAYS');
  }

  // ── Compra mínima / litros ──
  let minimumPurchase: number | null = null;
  const minP = /(?:compras?|consumos?|cargas?|operaciones?|transacciones?)\s+(?:minimas?\s+de|superiores\s+a|mayores\s+a|iguales\s+o\s+superiores\s+a|de\s+al\s+menos|desde)\s+\$\s?([\d.]+(?:,\d{1,2})?)/.exec(text);
  if (minP) {
    minimumPurchase = parseArs(`$${minP[1]}`);
    found.minimumPurchase = minP[0];
  }
  let minimumLitres: number | null = null;
  const minL = /(?:minimo de|al menos|cargas? (?:de|superiores a|mayores a))\s+(\d+)\s*(?:litros|lts?\b)/.exec(text);
  if (minL) {
    minimumLitres = Number(minL[1]);
    found.minimumLitres = minL[0];
  }

  // ── Medio de pago ──
  let types: PaymentMethodType[] | null = null;
  const debit = /debito/.test(text);
  const credit = /credito/.test(text);
  const prepaid = /prepaga/.test(text);
  if (debit || credit || prepaid) {
    types = [];
    if (debit) types.push('DEBIT_CARD');
    if (credit) types.push('CREDIT_CARD');
    if (prepaid) types.push('PREPAID_CARD');
  } else if (opts.stage === 'PAYMENT') unknown.add('PAYMENT_METHODS');
  let networks: CardNetwork[] | null = null;
  if (/\bvisa\b/.test(text) || /mastercard/.test(text)) {
    networks = [];
    if (/\bvisa\b/.test(text)) networks.push('VISA');
    if (/mastercard/.test(text)) networks.push('MASTERCARD');
  }
  let requiresApp: string | null = null;
  let requiresQR = /\bqr\b/.test(text);
  for (const k of opts.appKeywords ?? []) {
    if (k.pattern.test(text)) {
      requiresApp = k.appId;
      if (k.qr) requiresQR = true;
      break;
    }
  }
  const requiresNFC = /\bnfc\b|contactless|sin contacto/.test(text);

  // ── Segmentos ──
  let segments: string[] | null = null;
  const matchedSegments = (opts.segmentKeywords ?? []).filter((k) => k.pattern.test(text)).map((k) => k.segmentId);
  if (matchedSegments.length > 0) {
    segments = [...new Set(matchedSegments)];
    found.segments = segments.join(', ');
  } else if (!(opts.generalAudiencePatterns ?? []).some((p) => p.test(text))) {
    unknown.add('SEGMENTS');
  }

  // ── Combustibles ──
  let fuelTypes: FuelType[] | null = null;
  const fuelMatches = (opts.fuelKeywords ?? []).filter((k) => k.pattern.test(text)).flatMap((k) => k.fuelTypes);
  if (fuelMatches.length > 0) fuelTypes = [...new Set(fuelMatches)].sort() as FuelType[];
  else if (!/combustibles? liquidos|todos los combustibles|carga de combustible|combustible|nafta/.test(text)) unknown.add('FUEL_TYPES');

  // ── Regiones excluidas ──
  let excludedRegions: string[] | null = null;
  const exc = /(?:excepto|salvo|con excepcion de|excluye(?:ndo)?)\s+(?:las provincias de\s+)?([^.()]{3,160})/.exec(text);
  if (exc) {
    const codes = exc[1]
      .split(/\s*,\s*|\s+y\s+/)
      .map((s) => provinceCode(s))
      .filter((c): c is string => !!c);
    if (codes.length > 0) {
      excludedRegions = [...new Set(codes)];
      found.excludedRegions = exc[0];
    }
  }

  // ── Límites de uso ──
  const usageLimits: UsageLimit[] = [];
  let multipleOperationsPerDay: PromotionRule['multipleOperationsPerDay'] = 'UNKNOWN';
  const perPeriod = /(\d+|una|un)\s*(?:\(\s*\w+\s*\)\s*)?(?:transaccion|operacion|compra|carga)(?:es)?\s+(?:participantes?\s+)?por\s+(semana|mes|dia)/.exec(text);
  if (perPeriod) {
    const n = /^\d+$/.test(perPeriod[1]) ? Number(perPeriod[1]) : 1;
    const period: CapPeriod = perPeriod[2] === 'semana' ? 'WEEKLY' : perPeriod[2] === 'mes' ? 'MONTHLY' : 'DAILY';
    usageLimits.push({ maxTransactions: n, period });
    if (period === 'DAILY' && n === 1) multipleOperationsPerDay = 'NO';
    found.usageLimit = perPeriod[0];
  }
  const maxTotal = /maximo de (\d+)\s*(?:\(\s*\w+\s*\)\s*)?(?:compras|transacciones|operaciones|cargas)/.exec(text);
  if (maxTotal) {
    usageLimits.push({ maxTransactions: Number(maxTotal[1]), period: 'PROMOTION_PERIOD' });
    found.usageLimitTotal = maxTotal[0];
  }

  // ── Acumulabilidad ──
  let stackable: PromotionRule['stackable'] = 'UNKNOWN';
  if (/no (es |son |sera |seran )?acumulables?|no se acumula|no podra acumularse/.test(text)) stackable = 'NO';

  // ── Condiciones especiales ──
  if (/ruedita|girar y participar|participa(r)? por premios|sorteo/.test(text)) {
    unknown.add('OTHER');
    notes.push('Requiere "girar la ruedita" (o participar) en la app el mismo día: verificá si el beneficio está garantizado.');
  }
  if (/adherid/.test(text)) notes.push('Sólo en estaciones adheridas.');
  if (/dni/.test(text)) notes.push('Pueden pedirte el DNI.');

  const rule: PromotionRule = {
    discountType,
    discountValue,
    delivery,
    stage: opts.stage,
    caps,
    minimumPurchase,
    maximumPurchase: null,
    minimumLitres,
    usageLimits,
    daysOfWeek,
    daysOfMonth: null,
    eligibleProviderIds: opts.eligibleProviderIds,
    eligiblePaymentMethodIds: null,
    eligiblePaymentMethodTypes: types,
    eligibleNetworks: networks,
    eligibleFuelTypes: fuelTypes,
    eligibleStationIds: null,
    eligibleRegions: null,
    excludedRegions,
    eligibleCustomerSegments: segments,
    requiredLoyaltyProgrammeId: opts.requiredLoyaltyProgrammeId ?? null,
    requiresApp,
    requiresQR,
    requiresNFC,
    requiresSpecificCard: false,
    stackable,
    stackableWith: [],
    multipleOperationsPerDay,
    weekStartsOn: 1,
    unknownConditions: [...unknown].sort(),
    notes,
    extra: {},
  };
  // Siempre falta confirmar algo de un texto libre; la confianza nunca es HIGH.
  const confidence: Confidence = unknown.size <= 1 ? 'MEDIUM' : 'LOW';
  return { rule, validFrom, validUntil, confidence, warnings, found };
}
