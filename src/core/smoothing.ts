import type { Curve, Result } from "./types.ts";
import { validateCurve } from "./curve.ts";
import { failure, okay } from "./result.ts";
import { leastSquares } from "./least-squares.ts";

export type SmoothingOptions = { id?: string } & (
  | { kind: "moving-average" | "median"; windowSamples: number }
  | { kind: "autoregressive"; strength: number }
  | { kind: "savitzky-golay"; windowSamples: number; degree: number; derivative?: number }
);

export function smoothCurve(curve: Curve, options: SmoothingOptions): Result<Curve> {
  const checked = validateCurve(curve);
  if (!checked.ok) return checked;

  const y = curve.y.slice();
  if (options.kind === "savitzky-golay") return savitzkyGolay(curve, options);
  if (options.kind === "autoregressive") {
    if (!Number.isInteger(options.strength) || options.strength < 1 || options.strength > 25) {
      return failure("E_FILTER_PARAMETER", "AR strength must be an integer from 1 to 25.");
    }
    const weight = options.strength / (options.strength + 1);
    for (let index = 1; index < y.length; index++) {
      if (!curve.missing?.[index] && !curve.missing?.[index - 1]) {
        y[index] = weight * y[index - 1]! + (1 - weight) * curve.y[index]!;
      }
    }
  } else {
    if (!Number.isInteger(options.windowSamples) || options.windowSamples < 1 || options.windowSamples > 151) {
      return failure("E_FILTER_PARAMETER", "The filter needs a sample window from 1 to 151.");
    }
    const radius = Math.floor(options.windowSamples / 2);
    let low = 0;
    while (low < y.length) {
      if (curve.missing?.[low]) {
        low++;
        continue;
      }
      let stop = low + 1;
      while (stop < y.length && !curve.missing?.[stop]) stop++;
      for (let i = low; i < stop; i++) {
        const window = Math.min(radius, i - low, stop - i - 1);
        const values = curve.y.slice(i - window, i + window + 1);
        y[i] = options.kind === "median" ? values.sort()[window]!
          : values.reduce((sum, value) => sum + value, 0) / values.length;
      }
      low = stop;
    }
  }
  return validateCurve({
    ...curve, id: options.id ?? curve.id + ":" + options.kind, kind: "derived",
    sourceLabel: undefined, label: curve.label + " (" + options.kind + ")",
    sourceCurveIds: [curve.id], x: curve.x.slice(), y, missing: curve.missing?.slice(),
  });
}

function savitzkyGolay(curve: Curve, options: Extract<SmoothingOptions, { kind: "savitzky-golay" }>): Result<Curve> {
  const { degree, windowSamples, derivative = 0 } = options;
  if (!Number.isInteger(windowSamples) || windowSamples < 3 || windowSamples > 151 || windowSamples % 2 !== 1 ||
    !Number.isInteger(degree) || degree < 1 || degree > 5 || degree >= windowSamples ||
    !Number.isInteger(derivative) || derivative < 0 || derivative > degree) {
    return failure("E_FILTER_PARAMETER", "Savitzky–Golay requires an odd window, a degree from 1 to 5 and a derivative order at most that degree.");
  }
  const y = new Float64Array(curve.y.length);
  const missing = curve.missing?.slice() ?? new Uint8Array(y.length);
  let factorial = 1;
  for (let i = 2; i <= derivative; i++) factorial *= i;
  let start = 0;
  while (start < y.length) {
    if (missing[start]) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < y.length && !curve.missing?.[end]) end++;
    const count = Math.min(end - start, windowSamples);
    if (count <= degree) {
      missing.fill(1, start, end);
      start = end;
      continue;
    }
    for (let i = start; i < end; i++) {
      const first = Math.max(start, Math.min(i - Math.floor(count / 2), end - count));
      const x = curve.x[i]!;
      const scale = Math.max(x - curve.x[first]!, curve.x[first + count - 1]! - x);
      const rows = Array.from({ length: count }, (_, row) => {
        const normalized = (curve.x[first + row]! - x) / scale;
        return Array.from({ length: degree + 1 }, (_, power) => normalized ** power);
      });
      const coefficients = leastSquares(rows, curve.y.subarray(first, first + count));
      const value = coefficients ? coefficients[derivative]! * factorial / scale ** derivative : NaN;
      if (Number.isFinite(value)) y[i] = value;
      else missing[i] = 1;
    }
    start = end;
  }
  if (missing.every(Boolean)) return failure("E_FILTER_SAMPLES", "No continuous segment has enough samples for this polynomial.");
  return okay({
    ...curve, id: options.id ?? curve.id + ":savitzky-golay:" + derivative, kind: "derived", sourceLabel: undefined,
    label: curve.label + " (Savitzky–Golay)", sourceCurveIds: [curve.id],
    signalUnit: derivative ? curve.signalUnit + "/" + curve.xUnit + (derivative > 1 ? "^" + derivative : "") : curve.signalUnit,
    x: curve.x.slice(), y, missing: missing.some(Boolean) ? missing : undefined,
  });
}
