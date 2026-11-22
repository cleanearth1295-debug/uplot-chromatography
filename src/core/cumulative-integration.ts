import { baselineAt } from "./baseline.ts";
import { sampleCurve, validateCurve } from "./curve.ts";
import { failure, okay } from "./result.ts";
import type { BaselineResult, Curve, Result } from "./types.ts";

export interface CumulativeIntegrationOptions {
  id?: string;
  baseline?: BaselineResult;
}

export function cumulativeIntegrateCurve(curve: Curve, options: CumulativeIntegrationOptions = {}): Result<Curve> {
  const checked = validateCurve(curve);
  if (!checked.ok) return checked;
  const { baseline } = options;
  const start = curve.x[0]!;
  const end = curve.x.at(-1)!;
  let x = curve.x.slice();
  if (baseline) {
    if (baseline.curveId !== curve.id || baseline.xUnit !== curve.xUnit || baseline.signalUnit !== curve.signalUnit) {
      return failure("E_BASELINE_UNITS", "The selected baseline does not belong to this signal.", { curveId: curve.id });
    }
    const { points, validRanges } = baseline;
    if (points.length < 2 || points.some((point, index) => !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      (index > 0 && point.x <= points[index - 1]!.x)) || validRanges.some(([left, right], index) =>
      !Number.isFinite(left) || !Number.isFinite(right) || left > right || left < points[0]!.x ||
      right > points.at(-1)!.x || (index > 0 && left < validRanges[index - 1]![1]))) {
      return failure("E_BASELINE_POINTS", "Cumulative integration requires ordered, finite baseline points and coverage.", { curveId: curve.id });
    }
    const positions = new Set(curve.x);
    const add = (position: number) => {
      if (position >= start && position <= end) positions.add(position);
    };
    for (const point of points) add(point.x);
    for (const [index, [left, right]] of validRanges.entries()) {
      add(left);
      add(right);
      const previousEnd = validRanges[index - 1]?.[1];
      if (previousEnd !== undefined && previousEnd < left) {
        const middle = previousEnd / 2 + left / 2;
        if (middle > previousEnd && middle < left) add(middle);
      }
    }
    x = Float64Array.from([...positions].sort((a, b) => a - b));
  }

  const y = new Float64Array(x.length);
  const missing = new Uint8Array(x.length);
  let previous: { x: number; residual: number } | undefined;
  let total = 0;
  let rangeIndex = 0;
  let segments = 0;
  for (const [index, position] of x.entries()) {
    const signal = baseline ? sampleCurve(curve, position) : curve.missing?.[index] ? null : curve.y[index]!;
    let background: number | null = 0;
    if (baseline) {
      const initialRangeIndex = rangeIndex;
      let coverage = baseline.validRanges[rangeIndex];
      while (coverage && position > coverage[1]) coverage = baseline.validRanges[++rangeIndex];
      // Adjacent floating-point coordinates may leave no representable
      // position for the missing sample inserted between coverage ranges.
      const crossedGap = previous && coverage && rangeIndex !== initialRangeIndex &&
        coverage[0] > baseline.validRanges[rangeIndex - 1]![1];
      background = coverage && position >= coverage[0] && !crossedGap ? baselineAt(baseline.points, position) : null;
    }
    if (signal === null || background === null) {
      missing[index] = 1;
      previous = undefined;
      continue;
    }
    const residual = signal - background;
    if (!Number.isFinite(residual)) return failure("E_INTEGRATION_OVERFLOW", "The integral exceeds numeric limits.", { curveId: curve.id, index });
    if (previous) {
      total += (position - previous.x) * (previous.residual / 2 + residual / 2);
      segments++;
    } else {
      total = 0;
    }
    if (!Number.isFinite(total)) return failure("E_INTEGRATION_OVERFLOW", "The integral exceeds numeric limits.", { curveId: curve.id, index });
    y[index] = total;
    previous = { x: position, residual };
  }
  if (segments === 0) {
    return failure("E_INCOMPLETE_INTERVAL", "Cumulative integration requires at least one continuous interval.", { curveId: curve.id });
  }
  const hasGaps = missing.some(Boolean);
  return okay({
    ...curve, id: options.id ?? curve.id + ":cumulative-integral", sourceLabel: undefined,
    label: curve.label + " (cumulative integral)", kind: "derived", signalUnit: curve.signalUnit + "\u00b7" + curve.xUnit,
    sourceCurveIds: baseline?.spec.kind === "curve" ? [...new Set([curve.id, baseline.spec.baselineCurveId])] : [curve.id],
    x, y, missing: hasGaps ? missing : undefined,
  }, hasGaps ? [{
    code: "W_CUMULATIVE_GAPS", message: "The integral restarts at zero after missing data.", curveId: curve.id,
  }] : []);
}
