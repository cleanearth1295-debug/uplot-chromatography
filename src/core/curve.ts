import type { AxisUnit, Curve, Result } from "./types.ts";
import { failure, okay } from "./result.ts";

export function isAxisUnit(value: unknown): value is AxisUnit {
  return value === "min" || value === "mL" || value === "CV";
}

export function validateCurve(curve: Curve): Result<Curve> {
  if (!curve.id || !curve.runId || !curve.sourceChromatogramId || !curve.signalUnit || !isAxisUnit(curve.xUnit)) {
    return failure("E_CURVE_METADATA", "Curve ID, run, chromatogram, axis and signal unit are required.", { curveId: curve.id });
  }

  if (curve.x.length < 2 || curve.x.length !== curve.y.length || (curve.missing && curve.missing.length !== curve.x.length)) {
    return failure("E_CURVE_LENGTH", "The curve needs at least two X/Y values and one mask entry per value.", { curveId: curve.id });
  }

  for (let index = 0; index < curve.x.length; index++) {
    const x = curve.x[index]!;
    const mask = curve.missing?.[index] ?? 0;
    if (!Number.isFinite(x) || (index > 0 && x <= curve.x[index - 1]!)) {
      return failure("E_X_ORDER", "Curve coordinates must be finite and strictly increasing.", { curveId: curve.id, index });
    }
    if ((mask !== 0 && mask !== 1) || (mask === 0 && !Number.isFinite(curve.y[index]))) {
      return failure("E_Y_VALUE", "Curve signals must be finite or marked missing.", { curveId: curve.id, index });
    }
  }

  return okay(curve);
}

export function lowerBound(values: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (values[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function interpolate(x: number, leftX: number, leftY: number, rightX: number, rightY: number): number {
  const t = (x - leftX) / (rightX - leftX);
  return (1 - t) * leftY + t * rightY;
}

export function sampleCurve(curve: Curve, x: number): number | null {
  if (!Number.isFinite(x)) return null;
  const index = lowerBound(curve.x, x);
  if (index === curve.x.length || curve.missing?.[index]) return null;
  if (curve.x[index] === x) return curve.y[index]!;
  if (index === 0 || curve.missing?.[index - 1]) return null;
  return interpolate(x, curve.x[index - 1]!, curve.y[index - 1]!, curve.x[index]!, curve.y[index]!);
}
