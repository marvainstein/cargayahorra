/** Provincias argentinas (códigos normalizados usados en reglas y perfil). */
export const PROVINCES: Array<{ code: string; name: string }> = [
  { code: 'CABA', name: 'Ciudad de Buenos Aires' },
  { code: 'BUENOS_AIRES', name: 'Buenos Aires' },
  { code: 'CATAMARCA', name: 'Catamarca' },
  { code: 'CHACO', name: 'Chaco' },
  { code: 'CHUBUT', name: 'Chubut' },
  { code: 'CORDOBA', name: 'Córdoba' },
  { code: 'CORRIENTES', name: 'Corrientes' },
  { code: 'ENTRE_RIOS', name: 'Entre Ríos' },
  { code: 'FORMOSA', name: 'Formosa' },
  { code: 'JUJUY', name: 'Jujuy' },
  { code: 'LA_PAMPA', name: 'La Pampa' },
  { code: 'LA_RIOJA', name: 'La Rioja' },
  { code: 'MENDOZA', name: 'Mendoza' },
  { code: 'MISIONES', name: 'Misiones' },
  { code: 'NEUQUEN', name: 'Neuquén' },
  { code: 'RIO_NEGRO', name: 'Río Negro' },
  { code: 'SALTA', name: 'Salta' },
  { code: 'SAN_JUAN', name: 'San Juan' },
  { code: 'SAN_LUIS', name: 'San Luis' },
  { code: 'SANTA_CRUZ', name: 'Santa Cruz' },
  { code: 'SANTA_FE', name: 'Santa Fe' },
  { code: 'SANTIAGO_DEL_ESTERO', name: 'Santiago del Estero' },
  { code: 'TIERRA_DEL_FUEGO', name: 'Tierra del Fuego' },
  { code: 'TUCUMAN', name: 'Tucumán' },
];

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** "Río Negro" → "RIO_NEGRO"; null si no se reconoce. */
export function provinceCode(name: string): string | null {
  const n = normalizeText(name).replace(/\bprovincia de\b/, '').trim();
  if (/\b(caba|capital federal|ciudad (autonoma )?de buenos aires)\b/.test(n)) return 'CABA';
  for (const p of PROVINCES) {
    if (n === normalizeText(p.name) || n.includes(normalizeText(p.name))) return p.code;
  }
  return null;
}
