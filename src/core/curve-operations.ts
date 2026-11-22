import type { BaselineResult, Curve, Result } from "./types.ts";
import { baselineAt, coversRange } from "./baseline.ts";
import { lowerBound, sampleCurve, validateCurve } from "./curve.ts";
import { failure, okay } from "./result.ts";

interface Thresholds {
  thresholdA: number;
  thresholdB: number;
}
export interface CombineOptions {
  op: "add" | "subtract" | "divide";
  id?: string;
  threshold?: Thresholds;
}

export function combineCurves(a: Curve, b: Curve, options: CombineOptions): Result<Curve> {
  for (const curve of [a, b]) {
    const checked = validateCurve(curve);
    if (!checked.ok) return checked;
  }
  if (a.xUnit !== b.xUnit || (options.op !== "divide" && a.signalUnit !== b.signalUnit)) {
    return failure("E_CURVE_UNITS", "The selected operation requires compatible curve units.");
  }
  if (options.threshold && ![options.threshold.thresholdA, options.threshold.thresholdB].every((v) => Number.isFinite(v) && v >= 0)) {
    return failure("E_THRESHOLD", "Ratio thresholds must be finite and nonnegative.");
  }
  const lower = Math.max(a.x[0]!, b.x[0]!);
  const upper = Math.min(a.x.at(-1)!, b.x.at(-1)!);
  if (!(lower < upper)) return failure("E_CURVE_OVERLAP", "The curves have no shared interval.");

  const set = new Set([lower, upper]);
  for (const curve of [a, b]) {
    for (let i = lowerBound(curve.x, lower); i < curve.x.length && curve.x[i]! < upper; i++) set.add(curve.x[i]!);
  }
  const x = Float64Array.from([...set].sort((first, second) => first - second));
  const y = new Float64Array(x.length);
  const missing = new Uint8Array(x.length);
  let invalid = 0;
  for (let index = 0; index < x.length; index++) {
    const at = x[index]!;
    const left = sampleCurve(a, at);
    const right = sampleCurve(b, at);
    if (left === null || right === null) {
      missing[index] = 1;
      continue;
    }
    const threshold = options.threshold;
    const value = options.op === "add" ? left + right : options.op === "subtract" ? left - right :
      threshold && (Math.abs(left) < threshold.thresholdA || Math.abs(right) < threshold.thresholdB) ? 1 : left / right;
    if (Number.isFinite(value)) y[index] = value;
    else {
      missing[index] = 1;
      invalid++;
    }
  }
  return okay({
    ...a, id: options.id ?? a.id + ":" + options.op + ":" + b.id, sourceLabel: undefined,
    label: a.label + " " + options.op + " " + b.label, kind: "derived",
    signalUnit: options.op === "divide" ? "1" : a.signalUnit,
    sourceCurveIds: [a.id, b.id], x, y, missing: missing.some(Boolean) ? missing : undefined,
  }, invalid ? [{ code: "W_CURVE_NONFINITE", message: invalid + " non-finite results were marked missing." }] : []);
}

function baselineCorrected(curve: Curve, baseline: BaselineResult): Result<Curve> {
  if (baseline.curveId !== curve.id || baseline.xUnit !== curve.xUnit || baseline.signalUnit !== curve.signalUnit) {
    return failure("E_BASELINE_UNITS", "The selected baseline does not belong to this signal.");
  }
  const xs = [...new Set([...curve.x, ...baseline.points.map((point) => point.x)])]
    .filter((x) => x >= curve.x[0]! && x <= curve.x.at(-1)!).sort((a, b) => a - b);
  const points = xs.map((x) => {
    const signal = sampleCurve(curve, x);
    const b = baselineAt(baseline.points, x);
    return signal === null || b === null || !coversRange(baseline.validRanges, [x, x]) ? null : signal - b;
  });
  return okay({
    ...curve, x: Float64Array.from(xs), y: Float64Array.from(points, (y) => y ?? 0),
    missing: Uint8Array.from(points, (y) => Number(y === null)),
  });
}

export function ratioCurves(
  a: Curve, b: Curve,
  options: Thresholds & { baselineA?: BaselineResult; baselineB?: BaselineResult; id?: string },
): Result<Curve> {
  const left = options.baselineA ? baselineCorrected(a, options.baselineA) : okay(a);
  if (!left.ok) return left;
  const right = options.baselineB ? baselineCorrected(b, options.baselineB) : okay(b);
  if (!right.ok) return right;
  return combineCurves(left.value, right.value, { op: "divide", id: options.id, threshold: options });
}

export function slopeAt(curve: Curve, position: number): Result<number> {
  const checked = validateCurve(curve);
  if (!checked.ok) return checked;
  if (!Number.isFinite(position) || position < curve.x[0]! || position > curve.x.at(-1)!) {
    return failure("E_COORDINATE_RANGE", "The slope location must be inside the curve.");
  }
  const index = lowerBound(curve.x, position);
  const left = Math.max(0, index - 1);
  const right = curve.x[index] === position ? Math.min(curve.x.length - 1, index + 1) : index;
  for (let i = left; i <= right; i++) if (curve.missing?.[i]) {
    return failure("E_INCOMPLETE_INTERVAL", "A missing sample prevents slope calculation here.");
  }
  const slope = (curve.y[right]! - curve.y[left]!) / (curve.x[right]! - curve.x[left]!);
  return Number.isFinite(slope) ? okay(slope) : failure("E_INTEGRATION_OVERFLOW", "The slope is outside numeric limits.");
}
