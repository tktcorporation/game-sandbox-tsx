/**
 * `Math.hypot` for two and three numbers, bit for bit as V8 computes it (src/builtins/math.tq):
 * any infinite argument gives Infinity, then any NaN gives NaN, then all zeros give 0; otherwise
 * each absolute value is divided by the largest, the squares are summed with Kahan compensation in
 * argument order, and the square root of the sum is scaled back by the largest. V8 does not inline
 * `Math.hypot`, so a call costs several times this; `Math.sqrt(x * x + y * y)` differs from it in
 * the last bit for a large share of inputs, which would change the sim's output.
 * Leaf module (no imports) so that terrain.ts and map.ts can use it while they load.
 */
export function hypot2(x: number, y: number): number {
  const a = Math.abs(x);
  const b = Math.abs(y);
  if (a === Infinity || b === Infinity) return Infinity;
  if (a !== a || b !== b) return NaN;
  const max = a > b ? a : b;
  if (max === 0) return 0;
  const n = a / max;
  const m = b / max;
  // The compensation is 0 after the first term, and the last term's is never read.
  return Math.sqrt(n * n + m * m) * max;
}

export function hypot3(x: number, y: number, z: number): number {
  const a = Math.abs(x);
  const b = Math.abs(y);
  const c = Math.abs(z);
  if (a === Infinity || b === Infinity || c === Infinity) return Infinity;
  if (a !== a || b !== b || c !== c) return NaN;
  let max = a > b ? a : b;
  if (c > max) max = c;
  if (max === 0) return 0;
  const n = a / max;
  const sum = n * n;
  const m = b / max;
  const s2 = m * m;
  const p2 = sum + s2;
  const comp = p2 - sum - s2;
  const k = c / max;
  return Math.sqrt(p2 + (k * k - comp)) * max;
}
