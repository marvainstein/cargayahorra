/**
 * Capa centralizada de fechas.
 *
 * Todo el dominio trabaja con fechas locales (`LocalDate`, 'YYYY-MM-DD') en la
 * zona horaria del usuario (por defecto America/Argentina/Buenos_Aires).
 * Nunca usamos implícitamente la zona horaria del servidor: el único punto de
 * contacto con el reloj real es `Clock`, que es inyectable para tests.
 *
 * La aritmética de calendario (sumar días, día de la semana, semanas, meses)
 * se hace sobre fechas "civiles" usando UTC como calendario neutro, por lo que
 * no depende del huso ni de cambios de horario de verano.
 */

export type LocalDate = string; // 'YYYY-MM-DD'
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7; // 1 = lunes … 7 = domingo

export const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';
export const DEFAULT_LOCALE = 'es-AR';
export const DEFAULT_CURRENCY = 'ARS';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(instant: string | Date): Clock {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) throw new Error(`Instante inválido: ${instant}`);
  return { now: () => new Date(d.getTime()) };
}

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== 'string') return false;
  const m = LOCAL_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function assertLocalDate(value: string): LocalDate {
  if (!isLocalDate(value)) throw new Error(`Fecha inválida (se espera YYYY-MM-DD): ${value}`);
  return value;
}

function parts(d: LocalDate): [number, number, number] {
  const m = LOCAL_DATE_RE.exec(d);
  if (!m) throw new Error(`Fecha inválida: ${d}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function toUtc(d: LocalDate): Date {
  const [y, m, day] = parts(d);
  return new Date(Date.UTC(y, m - 1, day));
}

function fromUtc(dt: Date): LocalDate {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${m}-${day}`;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtfFor(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** Fecha local de un instante en una zona horaria IANA. */
export function localDateOf(instant: Date, timeZone: string = DEFAULT_TIMEZONE): LocalDate {
  const p = dtfFor(timeZone).formatToParts(instant);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Hoy, en la zona horaria indicada. */
export function today(clock: Clock = systemClock, timeZone: string = DEFAULT_TIMEZONE): LocalDate {
  return localDateOf(clock.now(), timeZone);
}

export function addDays(d: LocalDate, n: number): LocalDate {
  const dt = toUtc(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUtc(dt);
}

/** Días entre a y b (b - a). */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isBetween(d: LocalDate, from: LocalDate, until: LocalDate | null): boolean {
  return d >= from && (until === null || d <= until);
}

export function dayOfWeek(d: LocalDate): IsoWeekday {
  const js = toUtc(d).getUTCDay(); // 0 domingo
  return (js === 0 ? 7 : js) as IsoWeekday;
}

export function dayOfMonth(d: LocalDate): number {
  return parts(d)[2];
}

export function startOfWeek(d: LocalDate, weekStartsOn: IsoWeekday = 1): LocalDate {
  const dow = dayOfWeek(d);
  const back = (dow - weekStartsOn + 7) % 7;
  return addDays(d, -back);
}

export function endOfWeek(d: LocalDate, weekStartsOn: IsoWeekday = 1): LocalDate {
  return addDays(startOfWeek(d, weekStartsOn), 6);
}

export function startOfMonth(d: LocalDate): LocalDate {
  const [y, m] = parts(d);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

export function endOfMonth(d: LocalDate): LocalDate {
  const [y, m] = parts(d);
  return fromUtc(new Date(Date.UTC(y, m, 0)));
}

export function monthKey(d: LocalDate): string {
  return d.slice(0, 7);
}

export function yearKey(d: LocalDate): string {
  return d.slice(0, 4);
}

export function eachDay(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const longFormatters = new Map<string, Intl.DateTimeFormat>();
/** "martes 6 de octubre" (sin depender del huso: la fecha ya es local). */
export function formatLongDate(d: LocalDate, locale: string = DEFAULT_LOCALE): string {
  let f = longFormatters.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    longFormatters.set(locale, f);
  }
  return f.format(toUtc(d));
}

export function formatShortDate(d: LocalDate): string {
  const [, m, day] = parts(d);
  return `${String(day).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

const WEEKDAY_NAMES_ES = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
export function weekdayName(dow: number): string {
  return WEEKDAY_NAMES_ES[dow] ?? '?';
}

const WEEKDAY_PLURAL_ES = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados', 'domingos'];

/** "lunes y viernes", "viernes, sábados y domingos". */
export function formatWeekdays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const names = sorted.map((d) => WEEKDAY_PLURAL_ES[d] ?? '?');
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}
