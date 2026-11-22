export function leastSquares(rows: readonly number[][], values: ArrayLike<number>, leverage?: Float64Array): number[] | null {
  const width = rows[0]?.length ?? 0;
  const count = rows.length;
  if (!width || count < width || values.length !== count || (leverage !== undefined && leverage.length !== count) || rows.some((row) => row.length !== width)) return null;

  const q: Float64Array[] = [];
  const r = Array.from({ length: width }, () => new Float64Array(width));
  const qty = new Float64Array(width);
  for (let col = 0; col < width; col++) {
    const vector = Float64Array.from(rows, (row) => row[col]!);
    let norm = 0;
    for (const value of vector) norm += value * value;
    const tolerance = Math.sqrt(norm) * Number.EPSILON * Math.max(count, width) * 8;
    for (let i = 0; i < col; i++) {
      const basis = q[i]!;
      let projection = 0;
      for (let j = 0; j < count; j++) projection += basis[j]! * vector[j]!;
      r[i]![col] = projection;
      for (let j = 0; j < count; j++) vector[j] = vector[j]! - projection * basis[j]!;
    }
    norm = 0;
    for (const value of vector) norm += value * value;
    const size = Math.sqrt(norm);
    if (!Number.isFinite(size) || !(size > tolerance)) return null;
    r[col]![col] = size;
    let projected = 0;
    for (let j = 0; j < count; j++) {
      vector[j] = vector[j]! / size;
      projected += vector[j]! * values[j]!;
    }
    q.push(vector);
    qty[col] = projected;
  }
  const output = new Array<number>(width);
  for (let i = width - 1; i >= 0; i--) {
    let residual = qty[i]!;
    for (let j = i + 1; j < width; j++) residual -= r[i]![j]! * output[j]!;
    output[i] = residual / r[i]![i]!;
  }
  if (!output.every(Number.isFinite)) return null;
  if (leverage) {
    leverage.fill(0);
    for (const basis of q) {
      for (let row = 0; row < count; row++) {
        leverage[row] = leverage[row]! + basis[row]! ** 2;
      }
    }
  }
  return output;
}
