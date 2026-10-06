/**
 * Solver lineal mínimo (sin dependencias):
 *  - `solveLP`: simplex de dos fases sobre tableau denso (Dantzig con
 *    fallback a regla de Bland ante degeneración, para evitar ciclos).
 *  - `solveMILP`: branch & bound en profundidad para variables binarias.
 *
 * Los problemas de este dominio son chicos (decenas a cientos de variables),
 * así que priorizamos simplicidad y legibilidad sobre rendimiento.
 * El solver sólo ELIGE asignaciones; los montos finales se recalculan con el
 * motor de reglas en centavos enteros.
 */

export type ConstraintOp = '<=' | '>=' | '=';

export interface Constraint {
  terms: Array<[number, number]>; // [índice de variable, coeficiente]
  op: ConstraintOp;
  rhs: number;
  label?: string;
}

export interface LinearProgram {
  numVars: number;
  /** Coeficientes a MAXIMIZAR. */
  objective: number[];
  constraints: Constraint[];
  /** Variables restringidas a {0, 1} (sólo para solveMILP). */
  binaries?: number[];
}

export type LPStatus = 'OPTIMAL' | 'INFEASIBLE' | 'UNBOUNDED';

export interface LPResult {
  status: LPStatus;
  x: number[];
  objective: number;
}

const EPS = 1e-9;

export function solveLP(lp: LinearProgram): LPResult {
  const n = lp.numVars;
  // Normalizar: rhs >= 0
  const rows = lp.constraints.map((c) => {
    if (c.rhs < 0) {
      const op: ConstraintOp = c.op === '<=' ? '>=' : c.op === '>=' ? '<=' : '=';
      return { terms: c.terms.map(([i, v]) => [i, -v] as [number, number]), op, rhs: -c.rhs };
    }
    return c;
  });
  const m = rows.length;
  let numSlack = 0;
  let numArt = 0;
  for (const r of rows) {
    if (r.op === '<=') numSlack++;
    else if (r.op === '>=') {
      numSlack++;
      numArt++;
    } else numArt++;
  }
  const artStart = n + numSlack;
  const total = artStart + numArt;
  const width = total + 1; // última columna = rhs
  const T: Float64Array[] = [];
  const basis = new Int32Array(m);
  let s = n;
  let a = artStart;
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(width);
    for (const [j, v] of rows[i].terms) {
      if (j < 0 || j >= n) throw new Error(`Variable fuera de rango: ${j}`);
      row[j] += v;
    }
    row[total] = rows[i].rhs;
    if (rows[i].op === '<=') {
      row[s] = 1;
      basis[i] = s++;
    } else if (rows[i].op === '>=') {
      row[s++] = -1;
      row[a] = 1;
      basis[i] = a++;
    } else {
      row[a] = 1;
      basis[i] = a++;
    }
    T.push(row);
  }

  const pivot = (pr: number, pc: number) => {
    const prow = T[pr];
    const pv = prow[pc];
    for (let j = 0; j < width; j++) prow[j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === pr) continue;
      const row = T[i];
      const f = row[pc];
      if (Math.abs(f) < 1e-15) continue;
      for (let j = 0; j < width; j++) row[j] -= f * prow[j];
    }
    basis[pr] = pc;
  };

  /** Itera el simplex maximizando `cost`. Devuelve false si no acotado. */
  const run = (cost: Float64Array, allowed: (j: number) => boolean): boolean => {
    // fila de costos reducidos: red[j] = c_j - c_B · B^-1 A_j
    const red = new Float64Array(width);
    for (let j = 0; j < width; j++) red[j] = j < total ? cost[j] : 0;
    for (let i = 0; i < m; i++) {
      const cb = cost[basis[i]];
      if (cb === 0) continue;
      const row = T[i];
      for (let j = 0; j < width; j++) red[j] -= cb * row[j];
    }
    let degenerateSteps = 0;
    for (let iter = 0; iter < 50_000; iter++) {
      const useBland = degenerateSteps > 50;
      let pc = -1;
      let best = EPS;
      for (let j = 0; j < total; j++) {
        if (!allowed(j)) continue;
        if (red[j] > best) {
          pc = j;
          if (useBland) break;
          best = red[j];
        }
      }
      if (pc === -1) return true;
      let pr = -1;
      let minRatio = Infinity;
      for (let i = 0; i < m; i++) {
        const v = T[i][pc];
        if (v > EPS) {
          const ratio = T[i][total] / v;
          if (ratio < minRatio - 1e-12 || (Math.abs(ratio - minRatio) <= 1e-12 && pr >= 0 && basis[i] < basis[pr])) {
            minRatio = ratio;
            pr = i;
          }
        }
      }
      if (pr === -1) return false;
      degenerateSteps = minRatio < 1e-12 ? degenerateSteps + 1 : 0;
      pivot(pr, pc);
      const f = red[pc];
      const prow = T[pr];
      for (let j = 0; j < width; j++) red[j] -= f * prow[j];
    }
    throw new Error('Simplex: demasiadas iteraciones');
  };

  // Fase 1
  if (numArt > 0) {
    const c1 = new Float64Array(total);
    for (let j = artStart; j < total; j++) c1[j] = -1;
    run(c1, () => true);
    let infeas = 0;
    for (let i = 0; i < m; i++) if (basis[i] >= artStart) infeas += T[i][total];
    if (infeas > 1e-7) return { status: 'INFEASIBLE', x: new Array(n).fill(0), objective: 0 };
    // Sacar artificiales de la base
    for (let i = 0; i < m; i++) {
      if (basis[i] < artStart) continue;
      let pc = -1;
      for (let j = 0; j < artStart; j++) {
        if (Math.abs(T[i][j]) > 1e-9) {
          pc = j;
          break;
        }
      }
      if (pc >= 0) pivot(i, pc);
      // si no hay columna, la fila es redundante y la artificial queda en 0
    }
  }

  // Fase 2
  const c2 = new Float64Array(total);
  for (let j = 0; j < n; j++) c2[j] = lp.objective[j] ?? 0;
  const bounded = run(c2, (j) => j < artStart);
  if (!bounded) return { status: 'UNBOUNDED', x: new Array(n).fill(0), objective: Infinity };

  const x = new Array(n).fill(0);
  for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = Math.max(0, T[i][total]);
  let obj = 0;
  for (let j = 0; j < n; j++) obj += (lp.objective[j] ?? 0) * x[j];
  return { status: 'OPTIMAL', x, objective: obj };
}

export interface MILPOptions {
  maxNodes?: number;
  timeLimitMs?: number;
}

export interface MILPResult extends LPResult {
  /** true si se probó optimalidad (no se cortó por límites). */
  provenOptimal: boolean;
  nodes: number;
}

export function solveMILP(lp: LinearProgram, opts: MILPOptions = {}): MILPResult {
  const binaries = lp.binaries ?? [];
  const maxNodes = opts.maxNodes ?? 5_000;
  const deadline = Date.now() + (opts.timeLimitMs ?? 4_000);
  const base: Constraint[] = [...lp.constraints, ...binaries.map((b) => ({ terms: [[b, 1]] as Array<[number, number]>, op: '<=' as const, rhs: 1 }))];

  let best: LPResult | null = null;
  let nodes = 0;
  let cut = false;
  const stack: Array<Array<[number, 0 | 1]>> = [[]];

  while (stack.length > 0) {
    if (nodes >= maxNodes || Date.now() > deadline) {
      cut = true;
      break;
    }
    const fixes = stack.pop()!;
    nodes++;
    const constraints = [...base, ...fixes.map(([v, val]) => ({ terms: [[v, 1]] as Array<[number, number]>, op: '=' as const, rhs: val }))];
    const res = solveLP({ numVars: lp.numVars, objective: lp.objective, constraints });
    if (res.status !== 'OPTIMAL') continue;
    if (best && res.objective <= best.objective + 1e-7) continue;
    // variable binaria más fraccional
    let branchVar = -1;
    let bestFrac = 1e-6;
    for (const b of binaries) {
      const v = res.x[b];
      const frac = Math.min(v - Math.floor(v), Math.ceil(v) - v);
      if (frac > bestFrac) {
        bestFrac = frac;
        branchVar = b;
      }
    }
    if (branchVar === -1) {
      const x = res.x.slice();
      for (const b of binaries) x[b] = Math.round(x[b]);
      best = { status: 'OPTIMAL', x, objective: res.objective };
      continue;
    }
    const v = res.x[branchVar];
    // Explorar primero la rama más cercana al valor de la relajación (se apila último).
    const first: 0 | 1 = v >= 0.5 ? 1 : 0;
    const second: 0 | 1 = first === 1 ? 0 : 1;
    stack.push([...fixes, [branchVar, second]]);
    stack.push([...fixes, [branchVar, first]]);
  }

  if (!best) return { status: 'INFEASIBLE', x: new Array(lp.numVars).fill(0), objective: 0, provenOptimal: !cut, nodes };
  return { ...best, provenOptimal: !cut, nodes };
}
