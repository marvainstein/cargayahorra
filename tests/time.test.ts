import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, endOfMonth, fixedClock, formatLongDate, isLocalDate, startOfWeek, today } from '../src/core/time';
import { periodRange } from '../src/core/usage';

describe('fechas en America/Argentina/Buenos_Aires', () => {
  it('usa la zona del usuario y no la del servidor', () => {
    // 02:30 UTC del 7/10 = 23:30 del 6/10 en Buenos Aires
    const clock = fixedClock('2026-10-07T02:30:00Z');
    expect(today(clock, 'America/Argentina/Buenos_Aires')).toBe('2026-10-06');
    expect(today(clock, 'UTC')).toBe('2026-10-07');
  });

  it('día de la semana ISO', () => {
    expect(dayOfWeek('2026-10-06')).toBe(2); // martes
    expect(dayOfWeek('2026-10-11')).toBe(7); // domingo
  });

  it('cambio de mes y de año', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
  });

  it('semanas', () => {
    expect(startOfWeek('2026-10-06')).toBe('2026-10-05');
    expect(startOfWeek('2026-10-06', 7)).toBe('2026-10-04');
  });

  it('períodos de topes', () => {
    const p = { validFrom: '2026-10-01', validUntil: '2026-10-31' };
    expect(periodRange('MONTHLY', '2026-10-06', p)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(periodRange('WEEKLY', '2026-10-06', p)).toEqual({ start: '2026-10-05', end: '2026-10-11' });
    expect(periodRange('PER_TRANSACTION', '2026-10-06', p)).toBeNull();
    expect(periodRange('PROMOTION_PERIOD', '2026-10-20', p)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
  });

  it('valida y formatea', () => {
    expect(isLocalDate('2026-02-30')).toBe(false);
    expect(formatLongDate('2026-10-06')).toBe('martes, 6 de octubre');
  });
});
