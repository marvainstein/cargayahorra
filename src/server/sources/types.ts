import type { Clock } from '../../core/time';
import type { Station } from '../../core/types';
import type { PromotionDraft } from '../db/promotions';

export interface RawDocument {
  url: string;
  status: number;
  contentType: string;
  body: string;
  retrievedAt: string;
}

export interface ParsedPromotion {
  /** Clave estable dentro de la fuente (p. ej. id del artículo). */
  sourceKey: string;
  draft: PromotionDraft;
  /** Fragmento del texto original usado (trazabilidad). */
  excerpt: string;
  warnings: string[];
  /** Estaciones adheridas publicadas en las bases (se guardan antes que la promoción). */
  stations?: Station[];
}

export interface ValidationIssue {
  level: 'ERROR' | 'WARNING';
  sourceKey?: string;
  message: string;
}

export interface ValidationResult {
  /** La estructura de la fuente es la esperada (si no, no se toca nada). */
  structureOk: boolean;
  valid: ParsedPromotion[];
  issues: ValidationIssue[];
  /** Huella de la estructura para detectar cambios de diseño de la página. */
  fingerprint: string | null;
}

export interface SourceContext {
  fetch: typeof fetch;
  clock: Clock;
  userAgent: string;
}

/**
 * Adapter de una fuente de promociones. Cada fuente queda aislada del resto
 * del sistema: sólo produce borradores validados que el pipeline de
 * importación decide si aplicar o dejar pendientes de revisión.
 */
export interface PromotionSource {
  id: string;
  name: string;
  providerId: string | null;
  kind: 'API' | 'STRUCTURED_FEED' | 'OFFICIAL_PAGE' | 'PUBLIC_DATA' | 'SCRAPING';
  /** false si falta configuración (p. ej. URL oficial). */
  isConfigured(): boolean;
  fetch(ctx: SourceContext): Promise<RawDocument[]>;
  parse(docs: RawDocument[], ctx: SourceContext): ParsedPromotion[];
  validate(promotions: ParsedPromotion[], docs: RawDocument[]): ValidationResult;
}

export class SourceError extends Error {
  constructor(
    message: string,
    readonly kind: 'NETWORK' | 'HTTP' | 'STRUCTURE' | 'NOT_CONFIGURED',
  ) {
    super(message);
  }
}
