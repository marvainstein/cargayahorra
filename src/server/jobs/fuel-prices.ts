/**
 * Precios de combustible.
 *
 * Fuente pública: dataset "Precios en surtidor" de la Secretaría de Energía
 * (portal CKAN datos.energia.gob.ar). Se toma la mediana por provincia y tipo
 * de combustible para la marca configurada. ATENCIÓN: la obligación de
 * informar precios fue derogada en 2025, por lo que el dataset puede estar
 * desactualizado; por eso se guarda la fecha de vigencia y la app avisa si el
 * precio es viejo. El precio más confiable suele ser el de tu última carga.
 */
import type { Cents } from '../../core/money';
import { pesos } from '../../core/money';
import { normalizeText, provinceCode } from '../../core/regions';
import { type Clock, diffDays, type LocalDate, localDateOf } from '../../core/time';
import type { FuelType } from '../../core/types';
import { all, type DB, get, run } from '../db/db';
import type { SourceContext } from '../sources/types';
import { fetchDocument } from '../sources/html';

export const ENERGIA_PACKAGE_URL = 'http://datos.energia.gob.ar/api/3/action/package_show?id=precios-en-surtidor';
export const PRICE_STALE_DAYS = 30;

export interface FuelPrice {
  id: number;
  stationId: string | null;
  brandId: string | null;
  region: string | null;
  fuelType: FuelType;
  price: Cents;
  effectiveFrom: LocalDate;
  source: string;
  lastUpdated: string;
}

/** CSV simple con comillas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

export function mapProduct(product: string): FuelType | null {
  const p = normalizeText(product);
  if (/super/.test(p) && /nafta/.test(p)) return 'SUPER';
  if (/premium/.test(p) && /nafta/.test(p)) return 'PREMIUM';
  if (/grado 2/.test(p) && /gas ?oil/.test(p)) return 'DIESEL';
  if (/grado 3/.test(p) && /gas ?oil/.test(p)) return 'DIESEL_PREMIUM';
  return null;
}

export interface RegionalPrice {
  region: string;
  fuelType: FuelType;
  price: Cents;
  effectiveFrom: LocalDate;
  samples: number;
}

/** Mediana por provincia y combustible para una marca (p. ej. "AXION"). */
export function regionalMedians(csv: string, brandPattern: RegExp, timeZone: string): RegionalPrice[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('CSV vacío');
  const header = rows[0].map((h) => normalizeText(h.trim()));
  const col = (name: string) => header.findIndex((h) => h === name);
  const idx = {
    brand: col('empresabandera'),
    province: col('provincia'),
    product: col('producto'),
    price: col('precio'),
    date: col('fecha_vigencia'),
  };
  const missing = Object.entries(idx).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) throw new Error(`Estructura del CSV cambió: faltan columnas ${missing.join(', ')}`);

  const groups = new Map<string, { prices: number[]; latest: string }>();
  for (const r of rows.slice(1)) {
    if (!brandPattern.test(r[idx.brand] ?? '')) continue;
    const fuel = mapProduct(r[idx.product] ?? '');
    const region = provinceCode(r[idx.province] ?? '');
    const price = Number(String(r[idx.price]).replace(',', '.'));
    const dt = new Date(r[idx.date] ?? '');
    if (!fuel || !region || !(price > 0) || Number.isNaN(dt.getTime())) continue;
    const key = `${region}|${fuel}`;
    const g = groups.get(key) ?? { prices: [], latest: '0000-01-01' };
    g.prices.push(price);
    const ld = localDateOf(dt, timeZone);
    if (ld > g.latest) g.latest = ld;
    groups.set(key, g);
  }
  return [...groups.entries()].map(([key, g]) => {
    const [region, fuelType] = key.split('|') as [string, FuelType];
    const sorted = g.prices.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { region, fuelType, price: pesos(median), effectiveFrom: g.latest, samples: sorted.length };
  });
}

export async function updateFuelPrices(db: DB, clock: Clock, ctx: SourceContext, opts: { brandId: string; brandPattern: RegExp; timeZone: string }) {
  const pkg = await fetchDocument(ctx, ENERGIA_PACKAGE_URL);
  const json = JSON.parse(pkg.body);
  const resources: Array<{ name?: string; url?: string; format?: string }> = json?.result?.resources ?? [];
  const res = resources.find((r) => /vigente/i.test(r.name ?? '') && /csv/i.test(r.format ?? r.url ?? '')) ?? resources.find((r) => /csv/i.test(r.format ?? ''));
  if (!res?.url) throw new Error('El dataset no tiene un recurso CSV reconocible (posible cambio de estructura).');
  const csv = await fetchDocument(ctx, res.url, 120_000);
  const medians = regionalMedians(csv.body, opts.brandPattern, opts.timeZone);
  const now = clock.now().toISOString();
  for (const m of medians) {
    const exists = get(
      db,
      'SELECT id FROM fuel_price WHERE station_id IS NULL AND brand_id = ? AND region = ? AND fuel_type = ? AND effective_from = ? AND price = ?',
      opts.brandId,
      m.region,
      m.fuelType,
      m.effectiveFrom,
      m.price,
    );
    if (exists) run(db, 'UPDATE fuel_price SET last_updated = ? WHERE id = ?', now, exists.id);
    else
      run(
        db,
        'INSERT INTO fuel_price (station_id, brand_id, region, fuel_type, price, effective_from, source, last_updated) VALUES (NULL,?,?,?,?,?,?,?)',
        opts.brandId,
        m.region,
        m.fuelType,
        m.price,
        m.effectiveFrom,
        `Secretaría de Energía — Precios en surtidor (mediana de ${m.samples} estaciones)`,
        now,
      );
  }
  return { regions: medians.length };
}

function rowToPrice(r: Record<string, any>): FuelPrice {
  return {
    id: Number(r.id),
    stationId: r.station_id ?? null,
    brandId: r.brand_id ?? null,
    region: r.region ?? null,
    fuelType: r.fuel_type,
    price: Number(r.price),
    effectiveFrom: r.effective_from,
    source: r.source,
    lastUpdated: r.last_updated,
  };
}

export function listPrices(db: DB): FuelPrice[] {
  return all(db, 'SELECT * FROM fuel_price ORDER BY effective_from DESC, id DESC LIMIT 200').map(rowToPrice);
}

export function insertManualPrice(db: DB, clock: Clock, p: { stationId: string | null; brandId: string | null; region: string | null; fuelType: FuelType; price: Cents; effectiveFrom: LocalDate; source?: string }) {
  run(
    db,
    'INSERT INTO fuel_price (station_id, brand_id, region, fuel_type, price, effective_from, source, last_updated) VALUES (?,?,?,?,?,?,?,?)',
    p.stationId,
    p.brandId,
    p.region,
    p.fuelType,
    p.price,
    p.effectiveFrom,
    p.source ?? 'Carga manual',
    clock.now().toISOString(),
  );
}

export interface ResolvedPrice {
  price: Cents;
  source: string;
  effectiveFrom: LocalDate;
  stale: boolean;
  ageDays: number;
}

/**
 * Precio a usar: última carga reciente > precio cargado a mano para la
 * estación/marca > mediana regional. Siempre informa la fecha.
 */
export function resolvePrice(
  db: DB,
  today: LocalDate,
  opts: { fuelType: FuelType; brandId: string; region: string | null; stationId: string | null; userId: string },
): ResolvedPrice | null {
  const candidates: Array<{ price: number; source: string; date: string }> = [];
  const lastTx = get(
    db,
    'SELECT price_per_litre, local_date FROM fuel_transaction WHERE user_id = ? AND fuel_type = ? AND price_per_litre IS NOT NULL ORDER BY local_date DESC, occurred_at DESC LIMIT 1',
    opts.userId,
    opts.fuelType,
  );
  if (lastTx) candidates.push({ price: Number(lastTx.price_per_litre), source: 'Tu última carga', date: lastTx.local_date });
  const manual = get(
    db,
    `SELECT * FROM fuel_price WHERE fuel_type = ? AND (station_id = ? OR (station_id IS NULL AND brand_id = ? AND (region = ? OR region IS NULL)))
     ORDER BY effective_from DESC, id DESC LIMIT 1`,
    opts.fuelType,
    opts.stationId,
    opts.brandId,
    opts.region,
  );
  if (manual) candidates.push({ price: Number(manual.price), source: manual.source, date: manual.effective_from });
  if (candidates.length === 0) return null;
  const best = candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
  const ageDays = diffDays(best.date, today);
  return { price: best.price, source: best.source, effectiveFrom: best.date, stale: ageDays > PRICE_STALE_DAYS, ageDays };
}
