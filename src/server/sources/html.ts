import { createHash } from 'node:crypto';
import { type RawDocument, type SourceContext, SourceError } from './types';

export async function fetchDocument(ctx: SourceContext, url: string, timeoutMs = 20_000): Promise<RawDocument> {
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      headers: { 'user-agent': ctx.userAgent, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
  } catch (e) {
    throw new SourceError(`No se pudo conectar con ${url}: ${(e as Error).message}`, 'NETWORK');
  }
  const body = await res.text();
  if (!res.ok) throw new SourceError(`HTTP ${res.status} en ${url}`, 'HTTP');
  return {
    url,
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body,
    retrievedAt: ctx.clock.now().toISOString(),
  };
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  iexcl: '¡',
  iquest: '¿',
  ordf: 'ª',
  ordm: 'º',
  deg: '°',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code] ?? m;
  });
}

/** Texto legible de un HTML (sin scripts, estilos ni etiquetas). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function extractTitle(html: string): string | null {
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const title = h1 ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return title ? htmlToText(title[1]).trim() || null : null;
}

/**
 * Contenido principal de la página (<article>, si no <main>, si no <body>).
 * Evita interpretar menús, pies o artículos relacionados como parte de las bases.
 */
export function extractMainContent(html: string): string {
  const pick = (tag: string) => {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html);
    return m && htmlToText(m[1]).length > 100 ? m[1] : null;
  };
  return pick('article') ?? pick('main') ?? pick('body') ?? html;
}

export function extractLinks(html: string, baseUrl: string): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const url = new URL(decodeEntities(m[1]), baseUrl);
      // Links http:// al mismo sitio (p. ej. el centro de ayuda de Brubank) se piden por https.
      if (url.protocol === 'http:' && new URL(baseUrl).protocol === 'https:') url.protocol = 'https:';
      out.push({ href: url.toString(), text: htmlToText(m[2]) });
    } catch {
      // href inválido: se ignora
    }
  }
  return out;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Huella estructural: secuencia de etiquetas y clases, sin el texto. Cambia si
 * se rediseña la página aunque el contenido sea parecido.
 */
export function structureFingerprint(html: string): string {
  const tags = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .match(/<([a-z0-9]+)(?:[^>]*\bclass\s*=\s*["']([^"']*)["'])?/gi);
  return sha256((tags ?? []).join('|')).slice(0, 16);
}
