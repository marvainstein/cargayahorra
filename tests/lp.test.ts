import { describe, expect, it } from 'vitest';
import { solveLP, solveMILP, type LinearProgram } from '../src/core/optimizer/lp';

describe('solveLP', () => {
  it('resuelve un LP clásico', () => {
    // max 3x + 5y s.a. x <= 4, 2y <= 12, 3x + 2y <= 18  → x=2, y=6, z=36
    const r = solveLP({
      numVars: 2,
      objective: [3, 5],
      constraints: [
        { terms: [[0, 1]], op: '<=', rhs: 4 },
        { terms: [[1, 2]], op: '<=', rhs: 12 },
        { terms: [[0, 3], [1, 2]], op: '<=', rhs: 18 },
      ],
    });
    expect(r.status).toBe('OPTIMAL');
    expect(r.objective).toBeCloseTo(36);
    expect(r.x[0]).toBeCloseTo(2);
    expect(r.x[1]).toBeCloseTo(6);
  });

  it('maneja igualdades y >=', () => {
    // max x + y s.a. x + y = 10, x >= 3, y <= 4 → 10
    const r = solveLP({
      numVars: 2,
      objective: [1, 2],
      constraints: [
        { terms: [[0, 1], [1, 1]], op: '=', rhs: 10 },
        { terms: [[0, 1]], op: '>=', rhs: 3 },
        { terms: [[1, 1]], op: '<=', rhs: 4 },
      ],
    });
    expect(r.status).toBe('OPTIMAL');
    expect(r.x[0]).toBeCloseTo(6);
    expect(r.x[1]).toBeCloseTo(4);
  });

  it('detecta infactibilidad', () => {
    const r = solveLP({
      numVars: 1,
      objective: [1],
      constraints: [
        { terms: [[0, 1]], op: '<=', rhs: 1 },
        { terms: [[0, 1]], op: '>=', rhs: 2 },
      ],
    });
    expect(r.status).toBe('INFEASIBLE');
  });

  it('detecta no acotado', () => {
    const r = solveLP({ numVars: 1, objective: [1], constraints: [{ terms: [[0, 1]], op: '>=', rhs: 1 }] });
    expect(r.status).toBe('UNBOUNDED');
  });
});

describe('solveMILP', () => {
  it('knapsack 0/1 coincide con fuerza bruta', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 20; t++) {
      const k = 8;
      const w = Array.from({ length: k }, () => Math.round(rnd() * 20) + 1);
      const v = Array.from({ length: k }, () => Math.round(rnd() * 30) + 1);
      const cap = Math.round(w.reduce((a, b) => a + b, 0) / 2);
      const lp: LinearProgram = {
        numVars: k,
        objective: v,
        constraints: [{ terms: w.map((wi, i) => [i, wi] as [number, number]), op: '<=', rhs: cap }],
        binaries: Array.from({ length: k }, (_, i) => i),
      };
      const r = solveMILP(lp);
      let brute = 0;
      for (let mask = 0; mask < 1 << k; mask++) {
        let ww = 0;
        let vv = 0;
        for (let i = 0; i < k; i++) if (mask & (1 << i)) { ww += w[i]; vv += v[i]; }
        if (ww <= cap) brute = Math.max(brute, vv);
      }
      expect(r.provenOptimal).toBe(true);
      expect(r.objective).toBeCloseTo(brute, 6);
    }
  });
});
