/**
 * Lista de estaciones adheridas publicada como anexo de las bases
 * (p. ej. "ANEXO I — Axion Energy Av. Congreso 4801, Villa Urquiza CABA Buenos Aires 1431").
 */
import { normalizeText, PROVINCES } from '../../core/regions';
import type { Station } from '../../core/types';
import { sha256 } from './html';

export interface StationAnnexOptions {
  /** Encabezado a partir del cual empieza la lista. */
  marker: RegExp;
  /** Líneas que son estaciones. */
  linePattern: RegExp;
  brandId: string;
}

/** Id estable: no cambia por espacios, mayúsculas ni acentos. */
export function stationId(brandId: string, line: string): string {
  return `${brandId}-${sha256(normalizeText(line).replace(/[^a-z0-9]/g, '')).slice(0, 12)}`;
}

/** Provincia a partir del final de la línea ("… Villa Urquiza CABA Buenos Aires 1431"). */
export function regionFromAddress(line: string): string | null {
  const n = ` ${normalizeText(line).replace(/\d{4,}\s*$/, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (/ (caba|capital federal|ciudad autonoma de buenos aires) /.test(n)) return 'CABA';
  let best: { code: string; len: number } | null = null;
  for (const p of PROVINCES) {
    const name = ` ${normalizeText(p.name)} `;
    if (n.endsWith(name) && (!best || name.length > best.len)) best = { code: p.code, len: name.length };
  }
  if (best) return best.code;
  // nombre de provincia pegado a la localidad ("San Miguel de TucumánTucumán")
  for (const p of PROVINCES) if (n.trimEnd().endsWith(normalizeText(p.name))) return p.code;
  return null;
}

export function splitAnnex(text: string, marker: RegExp): { terms: string; annex: string | null } {
  const m = marker.exec(text);
  if (!m) return { terms: text, annex: null };
  return { terms: text.slice(0, m.index), annex: text.slice(m.index + m[0].length) };
}

export function parseStationAnnex(annex: string, opts: StationAnnexOptions): Station[] {
  const seen = new Map<string, Station>();
  for (const raw of annex.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!opts.linePattern.test(line)) continue;
    const id = stationId(opts.brandId, line);
    if (seen.has(id)) continue;
    seen.set(id, {
      id,
      brandId: opts.brandId,
      name: line,
      address: line.replace(opts.linePattern, '').trim() || null,
      region: regionFromAddress(line),
      latitude: null,
      longitude: null,
      active: true,
    });
  }
  return [...seen.values()];
}

// ───────── Cruce de un anexo (texto) con el catálogo oficial de estaciones ─────────

const STREET_STOPWORDS = new Set([
  'axion', 'energy', 'avenida', 'avda', 'esquina', 'entre', 'ruta', 'nacional', 'provincial', 'calle',
  'buenos', 'aires', 'capital', 'federal', 'zona', 'provincia', 'del', 'los', 'las', 'san', 'santa', 'km',
]);

function normAddress(s: string): string {
  return ` ${normalizeText(s).replace(/\bav(da)?\.?/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')} `;
}
const addressNumbers = (s: string) => new Set(normAddress(s).match(/\b\d{2,5}\b/g) ?? []);
// Los nombres de provincia no sirven para distinguir estaciones dentro de una misma provincia.
const PROVINCE_WORDS = new Set(PROVINCES.flatMap((p) => normalizeText(p.name).split(/\s+/)));
const addressWords = (s: string) =>
  new Set(normAddress(s).split(' ').filter((w) => w.length >= 4 && !STREET_STOPWORDS.has(w) && !PROVINCE_WORDS.has(w) && !/^\d+$/.test(w)));

export interface AnnexMatch {
  /** Estaciones del catálogo que coinciden sin ambigüedad con una línea del anexo. */
  matchedIds: string[];
  /** Líneas del anexo que no se pudieron cruzar con certeza (sin coincidencia o ambiguas). */
  unmatched: string[];
}

/**
 * Cruce estricto: misma provincia y, si la línea tiene altura, misma altura y al
 * menos una palabra de la calle; si es una esquina sin altura, dos palabras en
 * común. Sólo cuenta si hay exactamente una candidata.
 */
export function matchAnnexToCatalog(annexLines: string[], catalog: Station[]): AnnexMatch {
  const matched = new Set<string>();
  const unmatched: string[] = [];
  for (const line of annexLines) {
    const text = line.replace(/\s\d{4}\s*$/, ''); // código postal final
    const region = regionFromAddress(line);
    const nums = addressNumbers(text);
    const words = addressWords(text);
    const candidates = catalog.filter((st) => {
      if (!region || st.region !== region) return false;
      const t = st.name; // "Axion <dirección>, <localidad>" (sin provincia)
      const sharedWords = [...words].filter((w) => addressWords(t).has(w)).length;
      const sharedNums = [...nums].filter((n) => addressNumbers(t).has(n)).length;
      return nums.size > 0 ? sharedNums >= 1 && sharedWords >= 1 : sharedWords >= 2;
    });
    if (candidates.length === 1) matched.add(candidates[0].id);
    else unmatched.push(line);
  }
  return { matchedIds: [...matched].sort(), unmatched };
}
