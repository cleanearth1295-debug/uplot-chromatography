import type { AxisUnit, Curve, Interval, Result, Run, XY } from "./types.ts";
import { lowerBound, sampleCurve, validateCurve } from "./curve.ts";
import { failure, okay } from "./result.ts";
import { mapCoordinate } from "./axis.ts";

export function measureCurve(curve: Curve, x: number, options: { mode?: "linear" | "nearest" } = {}): Result<XY> {
  const checked = validateCurve(curve);
  if (!checked.ok) return checked;
  if (!Number.isFinite(x) || x < curve.x[0]! || x > curve.x.at(-1)!) {
    return failure("E_COORDINATE_RANGE", "The location must lie within the measured curve.", { curveId: curve.id });
  }
  if (options.mode === "nearest") {
    const i = lowerBound(curve.x, x);
    const left = curve.x[i - 1];
    const right = curve.x[i]!;
    x = left !== undefined && x - left <= right - x ? left : right;
  }
  const y = sampleCurve(curve, x);
  return y === null ? failure("E_INCOMPLETE_INTERVAL", "The location is missing.", { curveId: curve.id }) : okay({ x, y });
}

export interface IntervalMeasurement {
  start: XY;
  end: XY;
  delta: number;
  min: number;
  max: number;
  integral: number;
  sampleMean: number | null;
  weightedMean: number;
}

export function measureInterval(curve: Curve, range: Interval): Result<IntervalMeasurement> {
  const checked = validateCurve(curve);
  if (!checked.ok) return checked;
  if (range[0] <= range[1]) return measureValidatedInterval(curve, range);
  const interval = measureValidatedInterval(curve, [range[1], range[0]]);
  if (!interval.ok) return interval;
  const result = interval.value;
  return okay({ ...result, start: result.end, end: result.start, delta: -result.delta, integral: -result.integral });
}

export function measureValidatedInterval(curve: Curve, range: Interval): Result<IntervalMeasurement> {
  const [start, end] = range;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < end) || start < curve.x[0]! || end > curve.x.at(-1)!) {
    return failure("E_INTEGRATION_RANGE", "The measurement range must lie within the curve.", { curveId: curve.id, range });
  }
  const left = sampleCurve(curve, start);
  const right = sampleCurve(curve, end);
  if (left === null || right === null) {
    return failure("E_INCOMPLETE_INTERVAL", "The interval includes missing measurements.", { curveId: curve.id, range });
  }

  let min = Math.min(left, right);
  let max = Math.max(left, right);
  let previousX = start;
  let previousY = left;
  let sum = 0;
  let count = 0;
  let integral = 0;
  for (let i = lowerBound(curve.x, start); i < curve.x.length && curve.x[i]! <= end; i++) {
    if (curve.missing?.[i]) return failure("E_INCOMPLETE_INTERVAL", "The interval includes missing measurements.", { curveId: curve.id, range });
    const x = curve.x[i]!;
    const y = curve.y[i]!;
    integral += (x - previousX) * (previousY / 2 + y / 2);
    previousX = x;
    previousY = y;
    min = Math.min(min, y);
    max = Math.max(max, y);
    sum += y;
    count++;
  }
  integral += (end - previousX) * (previousY / 2 + right / 2);
  if (!Number.isFinite(integral) || !Number.isFinite(sum)) return failure("E_INTEGRATION_OVERFLOW", "The measurement is outside numeric limits.");
  return okay({
    start: { x: start, y: left }, end: { x: end, y: right }, delta: right - left,
    min, max, integral, sampleMean: count ? sum / count : null, weightedMean: integral / (end - start),
  });
}

export interface MarkerSnapshotOptions {
  xUnit?: AxisUnit;
  run?: Run;
}

export function captureMarkerSnapshot(curves: readonly Curve[], x: number, options: MarkerSnapshotOptions = {}) {
  const markerUnit = options.xUnit ?? curves[0]?.xUnit;
  return curves.map((curve) => {
    let result: Result<XY>;
    if (markerUnit === curve.xUnit) result = measureCurve(curve, x);
    else if (!markerUnit || !options.run || options.run.id !== curve.runId) {
      result = failure("E_MARKER_AXIS", "A measured coordinate map is required for this channel.", { curveId: curve.id });
    } else {
      const mapped = mapCoordinate(options.run, x, markerUnit, curve.xUnit);
      result = !mapped.ok ? mapped : mapped.value.kind === "point" ? measureCurve(curve, mapped.value.x)
        : failure("E_MARKER_AXIS", "The marker has no unique reading in this channel's axis.", { curveId: curve.id });
    }
    return { curveId: curve.id, label: curve.label, xUnit: curve.xUnit, signalUnit: curve.signalUnit, result };
  });
}
