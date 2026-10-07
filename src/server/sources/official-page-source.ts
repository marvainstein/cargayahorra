/**
 * Adapter genérico para promociones publicadas en páginas oficiales
 * (centro de ayuda, página de beneficios, bases y condiciones).
 *
 * Flujo: página índice → links que matchean `linkPattern` y `keyword` →
 * cada página de detalle → texto → parser conservador → validación.
 *
 * Cada fuente concreta (Brubank, BBVA, Axion ON) es una configuración de esta
 * clase; si una fuente necesita lógica propia puede extenderla y redefinir
 * `parse`/`validate` sin tocar el resto del sistema.
 */
import { extractLinks, extractMainContent, extractTitle, fetchDocument, htmlToText, sha256, structureFingerprint } from './html';
import { parseStationAnnex, splitAnnex, type StationAnnexOptions } from './stations';
import { type LegalParseOptions, parseLegalText } from './legal-parser';
import type { ParsedPromotion, PromotionSource, RawDocument, SourceContext, ValidationIssue, ValidationResult } from './types';
import { SourceError } from './types';

export interface OfficialPageConfig {
  id: string;
  name: string;
  providerId: string;
  fuelBrandId: string;
  /** Páginas índice donde se listan las promociones. */
  indexUrls: string[];
  /** Páginas de detalle fijas (p. ej. bases y condiciones), además de las descubiertas. */
  detailUrls?: string[];
  /** Los links de detalle deben matchear este patrón (sobre la URL)… */
  linkPattern?: RegExp;
  /** …y mencionar esta palabra (en URL o texto del link). */
  keyword: RegExp;
  /** Clave estable a partir de la URL de detalle. */
  sourceKeyFromUrl?: (url: string) => string;
  /** Texto mínimo esperado en una página de detalle válida. */
  minTextLength?: number;
  maxDetails?: number;
  parse: LegalParseOptions;
  /** Nombre de la promoción si la página no tiene título. */
  defaultName: string;
  /** Anexo con la lista de estaciones adheridas, si la fuente lo publica. */
  stationAnnex?: StationAnnexOptions;
}

export class OfficialPageSource implements PromotionSource {
  readonly kind = 'OFFICIAL_PAGE' as const;
  constructor(readonly config: OfficialPageConfig) {}

  get id() {
    return this.config.id;
  }
  get name() {
    return this.config.name;
  }
  get providerId() {
    return this.config.providerId;
  }

  isConfigured(): boolean {
    return this.config.indexUrls.length > 0 || (this.config.detailUrls?.length ?? 0) > 0;
  }

  async fetch(ctx: SourceContext): Promise<RawDocument[]> {
    if (!this.isConfigured()) throw new SourceError(`${this.name}: falta configurar la URL oficial`, 'NOT_CONFIGURED');
    const docs: RawDocument[] = [];
    const detail = new Set(this.config.detailUrls ?? []);
    for (const url of this.config.indexUrls) {
      const index = await fetchDocument(ctx, url);
      docs.push(index);
      for (const link of extractLinks(index.body, url)) {
        const matchesPattern = this.config.linkPattern ? this.config.linkPattern.test(link.href) : true;
        const mentions = this.config.keyword.test(link.href) || this.config.keyword.test(link.text);
        if (matchesPattern && mentions) detail.add(link.href.split('#')[0]);
      }
    }
    for (const url of [...detail].slice(0, this.config.maxDetails ?? 20)) {
      docs.push(await fetchDocument(ctx, url));
    }
    return docs;
  }

  private isIndex(doc: RawDocument) {
    return this.config.indexUrls.includes(doc.url);
  }

  /**
   * Opciones de interpretación para una página. Una subclase puede reasignar
   * el proveedor (p. ej. una promo bancaria publicada por la estación) o
   * devolver null para ignorar la página.
   */
  protected classify(_text: string): { providerId: string; parse: LegalParseOptions } | null {
    return { providerId: this.config.providerId, parse: this.config.parse };
  }

  parse(docs: RawDocument[]): ParsedPromotion[] {
    const out: ParsedPromotion[] = [];
    for (const doc of docs) {
      if (this.isIndex(doc)) continue;
      const fullText = htmlToText(extractMainContent(doc.body));
      const title = extractTitle(doc.body) ?? this.config.defaultName;
      const annexCfg = this.config.stationAnnex;
      const { terms: text, annex } = annexCfg ? splitAnnex(fullText, annexCfg.marker) : { terms: fullText, annex: null };
      const cls = this.classify(`${title}\n${text}`);
      if (!cls) continue;
      const parsed = parseLegalText(`${title}\n${text}`, cls.parse);
      const stations = annex && annexCfg ? parseStationAnnex(annex, annexCfg) : [];
      if (stations.length > 0) {
        parsed.rule.eligibleStationIds = stations.map((st) => st.id);
        parsed.rule.notes = parsed.rule.notes.filter((n) => n !== 'Sólo en estaciones adheridas.');
        parsed.rule.notes.push(`Sólo en las ${stations.length} estaciones adheridas del anexo de las bases.`);
      } else if (annexCfg && /anexo/i.test(text) && /adherid/i.test(text)) {
        parsed.rule.unknownConditions = [...new Set([...parsed.rule.unknownConditions, 'STATIONS' as const])].sort();
        parsed.warnings.push('Las bases remiten a un anexo de estaciones que no se pudo leer.');
      }
      const sourceKey = this.config.sourceKeyFromUrl?.(doc.url) ?? sha256(doc.url).slice(0, 16);
      out.push({
        sourceKey,
        excerpt: text.slice(0, 4000),
        warnings: parsed.warnings,
        stations: stations.length ? stations : undefined,
        draft: {
          providerId: cls.providerId,
          fuelBrandId: this.config.fuelBrandId,
          name: title.slice(0, 140),
          description: text.slice(0, 280),
          // Nunca se verifica automáticamente: requiere revisión humana.
          status: 'AUTOMATICALLY_IMPORTED',
          confidence: parsed.confidence,
          validFrom: parsed.validFrom ?? doc.retrievedAt.slice(0, 10),
          validUntil: parsed.validUntil,
          sourceUrl: doc.url,
          sourceName: this.config.name,
          retrievedAt: doc.retrievedAt,
          lastVerifiedAt: null,
          rule: parsed.rule,
          rawExcerpt: text.slice(0, 4000),
        },
      });
    }
    return out;
  }

  validate(promotions: ParsedPromotion[], docs: RawDocument[]): ValidationResult {
    const issues: ValidationIssue[] = [];
    const index = docs.filter((d) => this.isIndex(d));
    const fingerprint = index.length ? index.map((d) => structureFingerprint(d.body)).join(':') : null;
    const details = docs.filter((d) => !this.isIndex(d));

    let structureOk = true;
    if (index.length > 0 && details.length === 0 && !(this.config.detailUrls?.length ?? 0)) {
      structureOk = false;
      issues.push({ level: 'ERROR', message: 'La página índice no contiene links a promociones: posible cambio de estructura.' });
    }
    const minLen = this.config.minTextLength ?? 200;
    const valid: ParsedPromotion[] = [];
    for (const p of promotions) {
      const errs: string[] = [];
      const r = p.draft.rule;
      if (p.excerpt.length < minLen) errs.push('Texto demasiado corto: la página no parece una promoción.');
      if (!r.unknownConditions.includes('BENEFIT_VALUE')) {
        if (r.discountType === 'PERCENTAGE' && (r.discountValue <= 0 || r.discountValue > 7000))
          errs.push(`Porcentaje fuera de rango: ${r.discountValue / 100}%`);
      }
      for (const c of r.caps) if (c.amount <= 0 || c.amount > 100_000_000_00) errs.push(`Tope fuera de rango: ${c.amount}`);
      if (p.draft.validUntil && p.draft.validUntil < p.draft.validFrom) errs.push('Vigencia inválida.');
      if (errs.length) {
        for (const e of errs) issues.push({ level: 'ERROR', sourceKey: p.sourceKey, message: e });
        continue;
      }
      for (const w of p.warnings) issues.push({ level: 'WARNING', sourceKey: p.sourceKey, message: w });
      valid.push(p);
    }
    if (details.length > 0 && valid.length === 0) {
      structureOk = false;
      issues.push({ level: 'ERROR', message: 'Ninguna página de detalle pudo interpretarse: posible cambio de estructura.' });
    }
    return { structureOk, valid, issues, fingerprint };
  }
}
