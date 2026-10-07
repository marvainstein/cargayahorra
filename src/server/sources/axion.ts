/**
 * Axion energy: dos fuentes estructuradas oficiales del sitio (WordPress).
 *
 * 1. Página «Beneficios y promociones» vía API JSON de WordPress
 *    (/wp-json/wp/v2/pages/604). Publica varias promociones en un mismo texto
 *    (p. ej. Axion ON con topes distintos por nivel y por combustible), así que
 *    NO se interpreta automáticamente: se vigila cada bloque (título + bases) y
 *    cualquier cambio, alta o baja queda pendiente de revisión.
 *
 * 2. Localizador de estaciones (/wp-json/axion/v1/estaciones): lista oficial de
 *    estaciones con coordenadas, combustibles y adhesión a ON y a bancos.
 *
 * El sitio no envía el certificado intermedio de su cadena TLS: ver certs/README.md.
 */
import { normalizeText, provinceCode } from '../../core/regions';
import type { Station } from '../../core/types';
import { decodeEntities, fetchDocument, htmlToText, sha256 } from './html';
import type { SourceContext } from './types';
import { SourceError } from './types';

export const AXION_BENEFITS_API = 'https://www.axionenergy.com/wp-json/wp/v2/pages/604';
export const AXION_BENEFITS_PAGE = 'https://www.axionenergy.com/beneficios-y-promociones/';
export const AXION_STATIONS_API = `https://www.axionenergy.com/wp-json/axion/v1/estaciones?top=1000&filters=${encodeURIComponent("Title eq 'EESS'")}`;

export interface WatchedBlock {
  /** Clave estable derivada del título (p. ej. "lunes-y-viernes-10-de-descuento"). */
  key: string;
  title: string;
  /** Bases y condiciones del bloque. */
  text: string;
  hash: string;
}

function blockKey(title: string): string {
  return normalizeText(title)
    .replace(/[^a-z0-9%]+/g, '-')
    .replace(/%/g, '')
    .replace(/^-|-$/g, '');
}

const TITLE_LINE = /%|descuento|^hasta\b|^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/i;

/**
 * Separa la página en bloques. Estructura publicada: título (1-2 líneas cortas),
 * "HASTA EL dd/mm/aaaa", "VER EN EL MAPA", "VER MÁS", bases.
 */
export function splitBenefitBlocks(text: string): WatchedBlock[] {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/[​\s]+/g, ' ').trim())
    .filter(Boolean);
  const mapIdx = lines.map((l, i) => (/^ver en el mapa$/i.test(l) ? i : -1)).filter((i) => i >= 0);
  const starts = mapIdx.map((m) => {
    let s = m;
    while (s - 1 >= 0 && lines[s - 1].length <= 70 && TITLE_LINE.test(lines[s - 1]) && !/^ver m[aá]s$/i.test(lines[s - 1])) s--;
    return s;
  });
  const blocks: WatchedBlock[] = [];
  mapIdx.forEach((m, k) => {
    const titleLines = lines.slice(starts[k], m).filter((l) => !/^hasta\b|^\d{1,2}\/\d{1,2}\/\d{2,4}$/i.test(l));
    const title = titleLines.join(' ').trim();
    const bodyStart = /^ver m[aá]s$/i.test(lines[m + 1] ?? '') ? m + 2 : m + 1;
    const bodyEnd = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const body = lines.slice(bodyStart, bodyEnd).join('\n').trim();
    if (!title || body.length < 80) return;
    blocks.push({ key: blockKey(title), title, text: body, hash: sha256(normalizeText(body).replace(/\s+/g, ' ')).slice(0, 24) });
  });
  // claves únicas (por si dos promos tienen el mismo título)
  const seen = new Map<string, number>();
  for (const b of blocks) {
    const n = (seen.get(b.key) ?? 0) + 1;
    seen.set(b.key, n);
    if (n > 1) b.key = `${b.key}-${n}`;
  }
  return blocks;
}

export async function fetchBenefitBlocks(ctx: SourceContext): Promise<{ blocks: WatchedBlock[]; modified: string | null; retrievedAt: string }> {
  const doc = await fetchDocument(ctx, AXION_BENEFITS_API);
  let json: { content?: { rendered?: string }; modified?: string };
  try {
    json = JSON.parse(doc.body);
  } catch {
    throw new SourceError('La API de la página de beneficios no devolvió JSON.', 'STRUCTURE');
  }
  const html = json.content?.rendered;
  if (!html) throw new SourceError('La API de la página de beneficios no tiene contenido.', 'STRUCTURE');
  const blocks = splitBenefitBlocks(htmlToText(html));
  if (blocks.length < 2) throw new SourceError(`Se esperaban varios bloques de promociones y se encontraron ${blocks.length}: posible cambio de estructura.`, 'STRUCTURE');
  return { blocks, modified: json.modified ?? null, retrievedAt: doc.retrievedAt };
}

// ───────── Estaciones ─────────

type Flag = boolean | null;
function flag(v: unknown): Flag {
  if (v === '1' || v === 1 || v === true) return true;
  if (v === '0' || v === 0 || v === false) return false;
  return null;
}

function num(v: unknown): number | null {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

const PRODUCT_FLAGS = ['AXIONSUPER', 'QUANTIUM', 'AXIONDIESELX10', 'QUANTIUMDIESELX10', 'GNC'] as const;

export function mapAxionStation(x: Record<string, unknown>): Station | null {
  // El id de la lista es único y estable; el PBL se repite en algunas estaciones.
  const code = String(x.id ?? '').trim();
  const address = decodeEntities(String(x.Direccion ?? '')).replace(/\s+/g, ' ').trim();
  const locality = decodeEntities(String(x.Localidad ?? '')).replace(/\s+/g, ' ').trim();
  if (!code || !address) return null;
  // La API informa CABA como localidad ("CABA", "CAPITAL FED ZONA 2") con provincia "Buenos Aires".
  const region = /\bcaba\b|capital fed|ciudad aut[oó]noma/i.test(locality) ? 'CABA' : provinceCode(String(x.Provincia ?? ''));
  return {
    id: `axion-${code}`,
    brandId: 'axion',
    name: `Axion ${address}, ${locality}`,
    address: `${address}, ${locality}${x.Provincia ? `, ${x.Provincia}` : ''}`,
    region,
    latitude: num(x.Latitud),
    longitude: num(x.Longitud),
    active: x.estado === undefined || x.estado === null || /abierta/i.test(String(x.estado)),
    attributes: {
      on: flag(x.ONAXION),
      brubank: flag(x.Brubank),
      bbvaGo: flag(x.BbvaGo),
      modo: flag(x.Modo),
      bna: flag(x.Bna),
      products: PRODUCT_FLAGS.filter((p) => flag(x[p]) === true),
      pbl: x.PBL ? String(x.PBL) : null,
    },
  };
}

export async function fetchAxionStations(ctx: SourceContext): Promise<Station[]> {
  const doc = await fetchDocument(ctx, AXION_STATIONS_API, 90_000);
  let json: { ok?: boolean; items?: Array<Record<string, unknown>> };
  try {
    json = JSON.parse(doc.body);
  } catch {
    throw new SourceError('El localizador de estaciones no devolvió JSON.', 'STRUCTURE');
  }
  if (!json.ok || !Array.isArray(json.items)) throw new SourceError('El localizador de estaciones cambió de formato.', 'STRUCTURE');
  const stations = json.items.map(mapAxionStation).filter((s): s is Station => !!s);
  if (stations.length < 100) throw new SourceError(`El localizador devolvió sólo ${stations.length} estaciones: no se actualiza el catálogo.`, 'STRUCTURE');
  return stations;
}
