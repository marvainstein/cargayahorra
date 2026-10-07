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
