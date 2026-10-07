/**
 * Parser de bases y condiciones y precios. Los textos son EJEMPLOS SINTÉTICOS
 * con el estilo de las bases reales; no describen promociones vigentes.
 */
import { describe, expect, it } from 'vitest';
import { pesos } from '../src/core/money';
import { parseLegalText } from '../src/server/sources/legal-parser';
import { mapProduct, parseCsv, regionalMedians } from '../src/server/jobs/fuel-prices';
import { OfficialPageSource } from '../src/server/sources/official-page-source';
import { SOURCE_CONFIGS } from '../src/server/sources/registry';

const brubankOpts = SOURCE_CONFIGS.find((c) => c.id === 'brubank-help')!.parse;
const axionOpts = SOURCE_CONFIGS.find((c) => c.id === 'axion-beneficios')!.parse;

describe('parser de bases y condiciones', () => {
  it('extrae porcentaje, días, vigencia, tope semanal, segmento y exclusiones', () => {
    const t = `EJEMPLO. Viernes, sábados y domingos 20% OFF en la carga de combustible. Promoción válida para residentes en la República Argentina (excepto Tierra del Fuego, Río Negro y Mendoza)
      los días viernes, sábados y domingos desde el 01/11/2030 hasta el 30/11/2030 inclusive, exclusiva para clientes del Plan Plus con tarjetas de débito y crédito VISA.
      Descuento del 20% con un tope de reintegro semanal de $5.000 (cinco mil pesos). Los reintegros se verán reflejados en el resumen.`;
    const r = parseLegalText(t, brubankOpts);
    expect(r.rule.discountValue).toBe(2000);
    expect(r.rule.delivery).toBe('CASHBACK');
    expect(r.rule.daysOfWeek).toEqual([5, 6, 7]);
    expect(r.validFrom).toBe('2030-11-01');
    expect(r.validUntil).toBe('2030-11-30');
    expect(r.rule.caps).toEqual([{ amount: pesos(5_000), period: 'WEEKLY' }]);
    expect(r.rule.eligibleCustomerSegments).toEqual(['brubank-plan-plus']);
    expect(r.rule.excludedRegions).toEqual(['TIERRA_DEL_FUEGO', 'RIO_NEGRO', 'MENDOZA']);
    expect(r.rule.eligiblePaymentMethodTypes).toEqual(['DEBIT_CARD', 'CREDIT_CARD']);
    expect(r.rule.unknownConditions).toEqual([]);
  });

  it('marca como desconocido lo que no encuentra (tope, segmentos, ruedita)', () => {
    const t = 'EJEMPLO. Todos los martes 10% OFF en la carga de combustible. Girá la ruedita en la app. Válido del 01/11/2030 al 30/11/2030 con tarjeta de débito.';
    const r = parseLegalText(t, brubankOpts);
    expect(r.rule.daysOfWeek).toEqual([2]);
    expect(r.rule.unknownConditions).toEqual(expect.arrayContaining(['CAP', 'SEGMENTS', 'OTHER']));
    expect(r.confidence).toBe('LOW');
  });

  it('tope "cada dos semanas" es ambiguo', () => {
    const t = 'EJEMPLO. Lunes y viernes 10% de descuento en Quantium Diesel X10 para usuarios ON. Tope de $7.000 cada dos semanas. Desde el 01/11/2030 hasta el 31/12/2030. No acumulable con otras promociones.';
    const r = parseLegalText(t, axionOpts);
    expect(r.rule.unknownConditions).toContain('CAP_PERIOD');
    expect(r.rule.eligibleFuelTypes).toEqual(['DIESEL_PREMIUM']);
    expect(r.rule.stackable).toBe('NO');
    expect(r.rule.daysOfWeek).toEqual([1, 5]);
  });

  it('no confunde el presupuesto total con un tope por cliente', () => {
    const t = 'EJEMPLO. Todos los días 30% de reintegro, desde el 01/11/2030 hasta el 30/11/2030 o hasta alcanzar $12.000.000 en reintegros otorgados. Compras superiores a $200 con tarjeta de débito. Clientes en general.';
    const r = parseLegalText(t, brubankOpts);
    expect(r.rule.caps).toEqual([]);
    expect(r.rule.unknownConditions).toContain('CAP');
    expect(r.rule.minimumPurchase).toBe(pesos(200) + 1); // "superiores a $200" → $200,01
    expect(r.rule.notes.join(' ')).toContain('presupuesto total');
  });

  it('varios porcentajes → valor desconocido', () => {
    const r = parseLegalText('EJEMPLO. 15% o 20% de descuento según el plan, del 01/11/2030 al 30/11/2030.', brubankOpts);
    expect(r.rule.unknownConditions).toContain('BENEFIT_VALUE');
  });

  it('límites de operaciones', () => {
    const r = parseLegalText('EJEMPLO. 10% de reintegro con tope de $2.000 por compra, limitado a 1 (una) transacción por semana y un máximo de 4 compras participantes.', brubankOpts);
    expect(r.rule.caps).toEqual([{ amount: pesos(2_000), period: 'PER_TRANSACTION' }]);
    expect(r.rule.usageLimits).toEqual([
      { maxTransactions: 1, period: 'WEEKLY' },
      { maxTransactions: 4, period: 'PROMOTION_PERIOD' },
    ]);
  });
});

describe('adapter de página oficial', () => {
  it('descubre artículos, valida y detecta estructura rota', async () => {
    const src = new OfficialPageSource({ ...SOURCE_CONFIGS[0], indexUrls: ['https://ayuda.example/promos'] });
    const article = `<html><h1>EJEMPLO martes 10% en Axion</h1><article>${'Todos los martes 10% de reintegro en Axion con tarjeta de débito VISA. Clientes en general. Desde el 01/11/2030 hasta el 30/11/2030. Tope de reintegro semanal de $4.000. '.repeat(3)}</article></html>`;
    const pages: Record<string, string> = {
      'https://ayuda.example/promos': '<a href="https://help.brubank.com/es/articles/123-martes-axion">Martes Axion</a><a href="/otra">Otra</a>',
      'https://help.brubank.com/es/articles/123-martes-axion': article,
    };
    const fakeFetch = (async (url: string) => new Response(pages[url] ?? 'not found', { status: pages[url] ? 200 : 404 })) as typeof fetch;
    const ctx = { fetch: fakeFetch, clock: { now: () => new Date('2030-11-03T12:00:00Z') }, userAgent: 'test' };
    const docs = await src.fetch(ctx);
    expect(docs).toHaveLength(2);
    const parsed = src.parse(docs);
    expect(parsed[0].sourceKey).toBe('123');
    expect(parsed[0].draft.status).toBe('AUTOMATICALLY_IMPORTED');
    expect(parsed[0].draft.rule.caps[0]).toEqual({ amount: pesos(4_000), period: 'WEEKLY' });
    const v = src.validate(parsed, docs);
    expect(v.structureOk).toBe(true);
    expect(v.valid).toHaveLength(1);

    const broken = src.validate([], [docs[0]]);
    expect(broken.structureOk).toBe(false);
  });
});

describe('precios', () => {
  it('parsea CSV y calcula medianas por provincia', () => {
    const csv = [
      'indice_tiempo,empresa,provincia,producto,precio,fecha_vigencia,empresabandera',
      '2030-11,A,CAPITAL FEDERAL,Nafta (súper) entre 92 y 95 Ron,1200,2030-11-01 10:00:00,AXION ENERGY',
      '2030-11,B,CAPITAL FEDERAL,Nafta (súper) entre 92 y 95 Ron,1300,2030-11-02 10:00:00,AXION ENERGY',
      '2030-11,C,CAPITAL FEDERAL,Nafta (súper) entre 92 y 95 Ron,1250,2030-11-02 10:00:00,AXION ENERGY',
      '2030-11,D,CAPITAL FEDERAL,Nafta (súper) entre 92 y 95 Ron,999,2030-11-02 10:00:00,OTRA',
      '2030-11,E,"Buenos Aires",Gas Oil Grado 3,1400,2030-11-01 10:00:00,AXION ENERGY',
    ].join('\n');
    expect(parseCsv(csv)[5][2]).toBe('Buenos Aires');
    const m = regionalMedians(csv, /axion/i, 'America/Argentina/Buenos_Aires');
    const caba = m.find((x) => x.region === 'CABA')!;
    expect(caba.price).toBe(pesos(1_250));
    expect(caba.samples).toBe(3);
    expect(m.find((x) => x.region === 'BUENOS_AIRES')!.fuelType).toBe('DIESEL_PREMIUM');
    expect(mapProduct('Nafta (premium) de más de 95 Ron')).toBe('PREMIUM');
    expect(() => regionalMedians('a,b\n1,2', /axion/i, 'UTC')).toThrow(/Estructura/);
  });
});

describe('bases reales de Brubank (octubre 2026)', () => {
  it('interpreta el artículo oficial de los martes', async () => {
    const { readFileSync } = await import('node:fs');
    const body = readFileSync(new URL('./fixtures/brubank-9010023-2026-10.html', import.meta.url), 'utf8');
    const src = new OfficialPageSource(SOURCE_CONFIGS[0]);
    const docs = [{ url: 'https://help.brubank.com/es/articles/9010023', status: 200, contentType: 'text/html', body, retrievedAt: '2026-10-07T15:29:24.000Z' }];
    const [p] = src.parse(docs);
    const r = p.draft.rule;
    expect(p.sourceKey).toBe('9010023');
    expect([p.draft.validFrom, p.draft.validUntil]).toEqual(['2026-10-01', '2026-10-31']);
    expect(r.discountValue).toBe(1000);
    expect(r.delivery).toBe('CASHBACK');
    expect(r.daysOfWeek).toEqual([2]);
    expect(r.caps).toEqual([{ amount: pesos(4_000), period: 'PER_TRANSACTION' }]);
    expect(r.usageLimits).toEqual([
      { maxTransactions: 1, period: 'WEEKLY' },
      { maxTransactions: 4, period: 'PROMOTION_PERIOD' },
    ]);
    expect(r.minimumPurchase).toBe(pesos(200) + 1);
    expect(r.eligiblePaymentMethodTypes).toEqual(['DEBIT_CARD', 'CREDIT_CARD']);
    // el menú de la página menciona "Plan One": no debe tomarse como segmento
    expect(r.eligibleCustomerSegments).toBeNull();
    expect(r.unknownConditions).not.toContain('SEGMENTS');
    // los pagos con QR están EXCLUIDOS, no son un requisito
    expect(r.requiresQR).toBe(false);
    expect(r.notes.join(' ')).toContain('transferencias 3.0');
    expect(r.multipleOperationsPerDay).toBe('NO');
    expect(p.stations).toHaveLength(5);
    expect(r.eligibleStationIds).toHaveLength(5);
    expect(p.stations![0].region).toBe('CABA');
    // "Jugá y Participá por Premios": el parser no puede confirmarlo solo
    expect(r.unknownConditions).toContain('OTHER');
    expect(p.draft.status).toBe('AUTOMATICALLY_IMPORTED');
  });
});
