import type { BaselineResult, BaselineSpec, Interval, Result, Run, XY } from "./types.ts";
import { resolveCurveAxis } from "./axis.ts";
import { interpolate } from "./curve.ts";
import { failure, okay } from "./result.ts";
import { evaluateSpline } from "./spline.ts";
import { automaticBaseline } from "./automatic-baseline.ts";

export function coversRange(ranges: readonly Interval[], [start, end]: Interval): boolean {
  return ranges.some(([low, high]) => low <= start && high >= end);
}

function manualPoints(anchors: readonly XY[]): Result<readonly XY[]> {
  if (anchors.length < 2) return failure("E_BASELINE_POINTS", "At least two baseline points are required.");
  for (let index = 0; index < anchors.length; index++) {
    const point = anchors[index]!;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || (index > 0 && point.x <= anchors[index - 1]!.x)) {
      return failure("E_BASELINE_POINTS", "Baseline coordinates must be finite, unique and ordered.", { index });
    }
  }
  return okay(anchors.map((point) => ({ ...point })));
}

export function baselineAt(points: readonly XY[], x: number): number | null {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (points[mid]!.x < x) lo = mid + 1;
    else hi = mid;
  }
  const right = points[lo];
  if (!right) return null;
  if (right.x === x) return right.y;
  const left = points[lo - 1];
  return left ? interpolate(x, left.x, left.y, right.x, right.y) : null;
}

export function calculateBaseline(run: Run, curveId: string, spec: BaselineSpec): Result<BaselineResult> {
  const curve = run.curves.find((entry) => entry.id === curveId);
  if (!curve) return failure("E_CURVE_ID", "The requested curve is not in the run.", { curveId });

  const current = resolveCurveAxis(run, curveId, curve.xUnit);
  if (!current.ok) return current;

  const domain: Interval = [curve.x[0]!, curve.x[curve.x.length - 1]!];
  const info = {
    id: `${curveId}:baseline:${JSON.stringify(spec)}`, curveId,
    xUnit: curve.xUnit, signalUnit: curve.signalUnit, spec,
  };
  if (spec.kind === "zero") {
    return okay({ ...info, points: [{ x: domain[0], y: 0 }, { x: domain[1], y: 0 }], validRanges: [domain] });
  }
  if (spec.kind === "manual") {
    const points = manualPoints(spec.anchors);
    if (!points.ok) return points;
    const straight = spec.straightAfter ?? [];
    if (straight.some((i) => !Number.isInteger(i) || i < 0 || i >= points.value.length - 1)) {
      return failure("E_BASELINE_POINTS", "A straight segment needs two adjacent baseline anchors.", { curveId });
    }
    const samples = spec.shape === "linear" ? points.value : evaluateSpline(points.value, curve.x, straight);
    if (samples.some(({ y }) => !Number.isFinite(y))) return failure("E_BASELINE_POINTS", "Baseline interpolation exceeds numeric limits.", { curveId });
    return okay({
      ...info, points: samples, validRanges: [[points.value[0]!.x, points.value.at(-1)!.x]],
    }, spec.shape === "classic-spline" ? [{
      code: "W_CLASSIC_SPLINE_UNVERIFIED", message: "This is a natural spline with fixed straight segments. Classic 7.10 comparison is pending.", curveId,
    }] : []);
  }
  if (spec.kind === "curve") {
    const source = resolveCurveAxis(run, spec.baselineCurveId, curve.xUnit);
    if (!source.ok) return source;
    if (source.value.signalUnit !== curve.signalUnit) {
      return failure("E_SIGNAL_UNIT", "Baseline and signal must share a signal unit.", { curveId });
    }

    const points: XY[] = [];
    const validRanges: Interval[] = [];
    let start: number | undefined;
    for (let index = 0; index < source.value.x.length; index++) {
      if (source.value.missing?.[index]) {
        if (start !== undefined) validRanges.push([start, source.value.x[index - 1]!]);
        start = undefined;
        continue;
      }

      const x = source.value.x[index]!;
      start ??= x;
      points.push({ x, y: source.value.y[index]! });
    }
    if (start !== undefined) validRanges.push([start, source.value.x.at(-1)!]);
    if (!validRanges.some(([start, end]) => start < end)) {
      return failure("E_BASELINE_RANGE", "The source curve has no continuous baseline interval.", { curveId });
    }
    return okay({ ...info, points, validRanges });
  }
  const geometry = automaticBaseline(curve, spec);
  return geometry.ok ? okay({ ...info, ...geometry.value }, [{
    code: "W_CLASSIC_BASELINE_UNVERIFIED", message: "The automatic baseline algorithm is pending Classic 7.10 fixture comparison.", curveId,
  }]) : geometry;
}
