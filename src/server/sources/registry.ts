/**
 * Fuentes configuradas. Agregar una nueva fuente = agregar una entrada acá
 * (o una clase que implemente PromotionSource). El motor no cambia.
 *
 * Las URLs se pueden sobrescribir por variables de entorno (lista separada por
 * comas) sin tocar código:
 *   SOURCE_<ID>_INDEX_URLS, SOURCE_<ID>_DETAIL_URLS
 */
import type { FuelType } from '../../core/types';
import { normalizeText } from '../../core/regions';
import type { LegalParseOptions } from './legal-parser';
import { OfficialPageSource, type OfficialPageConfig } from './official-page-source';
import type { PromotionSource } from './types';

const AXION_FUELS: Array<{ pattern: RegExp; fuelTypes: FuelType[] }> = [
  { pattern: /quantium diesel/, fuelTypes: ['DIESEL_PREMIUM'] },
  { pattern: /quantium(?! diesel)/, fuelTypes: ['PREMIUM'] },
  { pattern: /(?<!quantium )diesel x10/, fuelTypes: ['DIESEL'] },
  { pattern: /\bnafta super\b|\baxion super\b/, fuelTypes: ['SUPER'] },
];

const APPS = [
  { pattern: /\bmodo\b/, appId: 'modo', qr: true },
  { pattern: /app(licacion)? on\b|\bapp de on\b/, appId: 'axion-on' },
];

function envList(name: string): string[] | null {
  const v = process.env[name];
  if (v === undefined) return null;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function withEnv(c: OfficialPageConfig): OfficialPageConfig {
  const key = c.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return {
    ...c,
    indexUrls: envList(`SOURCE_${key}_INDEX_URLS`) ?? c.indexUrls,
    detailUrls: envList(`SOURCE_${key}_DETAIL_URLS`) ?? c.detailUrls,
  };
}

export const SOURCE_CONFIGS: OfficialPageConfig[] = [
  {
    id: 'brubank-help',
    name: 'Brubank — Centro de ayuda (Promociones)',
    providerId: 'brubank',
    fuelBrandId: 'axion',
    indexUrls: ['https://help.brubank.com/es/collections/2846519-promociones'],
    linkPattern: /help\.brubank\.com\/es\/articles\/\d+/,
    keyword: /axion/i,
    sourceKeyFromUrl: (url) => /articles\/(\d+)/.exec(url)?.[1] ?? url,
    defaultName: 'Brubank en Axion',
    parse: {
      stage: 'PAYMENT',
      eligibleProviderIds: ['brubank'],
      segmentKeywords: [
        { pattern: /plan ultra/, segmentId: 'brubank-plan-ultra' },
        { pattern: /plan plus/, segmentId: 'brubank-plan-plus' },
        { pattern: /plan one/, segmentId: 'brubank-plan-one' },
      ],
      generalAudiencePatterns: [/clientes en general|todos los clientes|clientes generales/],
      fuelKeywords: AXION_FUELS,
      appKeywords: APPS,
    },
  },
  {
    id: 'bbva-beneficios',
    name: 'BBVA Argentina — Beneficios',
    providerId: 'bbva',
    fuelBrandId: 'axion',
    // Sin URL por defecto: no se pudo confirmar una URL oficial estable y estructurada
    // de la promoción de BBVA en Axion. Configurar SOURCE_BBVA_BENEFICIOS_DETAIL_URLS
    // con la página de bases y condiciones vigente.
    indexUrls: [],
    detailUrls: [],
    keyword: /axion/i,
    defaultName: 'BBVA en Axion',
    parse: {
      stage: 'PAYMENT',
      eligibleProviderIds: ['bbva'],
      segmentKeywords: [
        { pattern: /black\s?\+?\s?save/, segmentId: 'bbva-black-save' },
        { pattern: /black\s?\+?\s?all/, segmentId: 'bbva-black-all' },
        { pattern: /(cobr[ae]n?|acreditan?) (su |el )?(sueldo|haberes)|plan sueldo|cuenta sueldo/, segmentId: 'bbva-sueldo' },
      ],
      generalAudiencePatterns: [/clientes bbva|todos los clientes/],
      fuelKeywords: AXION_FUELS,
      appKeywords: APPS,
    },
  },
  {
    id: 'axion-beneficios',
    name: 'Axion energy — Beneficios y promociones',
    providerId: 'axion-on',
    fuelBrandId: 'axion',
    indexUrls: ['https://www.axionenergy.com/beneficios-y-promociones/'],
    linkPattern: /axionenergy\.com/,
    keyword: /\bon\b|legales|bases|condiciones|promo/i,
    maxDetails: 25,
    defaultName: 'Axion ON',
    parse: {
      stage: 'PRICE',
      eligibleProviderIds: null,
      requiredLoyaltyProgrammeId: 'axion-on',
      segmentKeywords: [
        { pattern: /nivel(es)? (1|uno) y (2|dos)/, segmentId: 'axion-on-level-1-2' },
        { pattern: /nivel(es)? (3|tres),? (4|cuatro) y (5|cinco)/, segmentId: 'axion-on-level-3-5' },
      ],
      generalAudiencePatterns: [/usuarios (de )?on\b|socios (de )?on\b|clientes on\b/],
      fuelKeywords: AXION_FUELS,
      appKeywords: APPS,
    },
  },
];

/**
 * La página de Axion publica también promociones de bancos y billeteras.
 * Las de BBVA/Brubank se reasignan a ese proveedor; las de otros bancos se
 * ignoran por ahora (agregarlas = sumar el proveedor acá y en el catálogo).
 */
class AxionSource extends OfficialPageSource {
  protected classify(text: string): { providerId: string; parse: LegalParseOptions } | null {
    const t = normalizeText(text);
    const bank = (id: string) => SOURCE_CONFIGS.find((c) => c.providerId === id)!;
    if (/\bbbva\b/.test(t)) return { providerId: 'bbva', parse: bank('bbva').parse };
    if (/brubank/.test(t)) return { providerId: 'brubank', parse: bank('brubank').parse };
    if (/\bbanco\b|mercado pago|cuenta dni|naranja x|uala|\bmodo\b|tarjeta/.test(t)) return null;
    return super.classify(text);
  }
}

export function buildSources(): PromotionSource[] {
  return SOURCE_CONFIGS.map((c) => (c.id === 'axion-beneficios' ? new AxionSource(withEnv(c)) : new OfficialPageSource(withEnv(c))));
}
