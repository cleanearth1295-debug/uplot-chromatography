import type { BaselineResult, Curve, IntegrationConfig, Interval, PeakLimit, PeakWindow, Result, XY } from "./types.ts";
import { baselineAt, coversRange } from "./baseline.ts";
import { interpolate, sampleCurve, validateCurve } from "./curve.ts";
import { failure, okay } from "./result.ts";

function valleyLimits(points: readonly XY[], polarity: PeakWindow["polarity"]): PeakLimit[] {
  const direction = polarity === "positive" ? 1 : -1;
  const limits: PeakLimit[] = [];
  let descending = false;
  let valley = 0;
  for (let i = 1; i < points.length; i++) {
    const slope = direction * (points[i]!.y - points[i - 1]!.y);
    if (slope < 0) {
      descending = true;
      valley = i;
    }
    if (slope > 0 && descending) {
      limits.push({ x: points[valley]!.x, kind: "dropline" });
      descending = false;
    }
  }
  return limits;
}

export function detectPeaks(curve: Curve, baseline: BaselineResult, config: IntegrationConfig): Result<readonly PeakWindow[]> {
  const input = validateCurve(curve);
  if (!input.ok) return input;
  if (baseline.curveId !== curve.id || baseline.xUnit !== curve.xUnit || config.xUnit !== curve.xUnit ||
    baseline.signalUnit !== curve.signalUnit) {
    return failure("E_INTEGRATION_UNITS", "Peak detection requires compatible curve and baseline coordinates.");
  }
  if (config.separation.kind === "skim" && !(Number.isFinite(config.separation.ratio) && config.separation.ratio >= 1)) {
    return failure("E_SKIM_RATIO", "The skim ratio must be finite and at least one.");
  }
  const domain: Interval = [curve.x[0]!, curve.x.at(-1)!];
  const [start, end] = config.window ?? domain;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < end) || start < domain[0] || end > domain[1]) {
    return failure("E_INTEGRATION_RANGE", "The detection range must lie inside the measured curve.");
  }

  const coordinates = new Set([start, end]);
  for (const x of curve.x) if (x > start && x < end) coordinates.add(x);
  for (const { x } of baseline.points) if (x > start && x < end) coordinates.add(x);
  const xs = [...coordinates].sort((a, b) => a - b);
  let previous: XY | undefined;
  let region: XY[] = [];
  let sign = 0;
  const windows: PeakWindow[] = [];

  function closeRegion() {
    if (sign && region.length >= 2 && (sign > 0 || config.acceptNegative)) {
      const polarity = sign > 0 ? "positive" : "negative";
      const first = region[0]!;
      const last = region.at(-1)!;
      const bounds: PeakLimit[] = [
        { x: first.x, kind: first.y === 0 ? "baseline-intersection" : "manual" },
        ...valleyLimits(region, polarity),
        { x: last.x, kind: last.y === 0 ? "baseline-intersection" : "manual" },
      ];
      for (let i = 1; i < bounds.length; i++) {
        windows.push({ id: "p" + (windows.length + 1), left: bounds[i - 1]!, right: bounds[i]!, polarity });
      }
    }
    region = [];
    sign = 0;
  }

  for (const x of xs) {
    const raw = sampleCurve(curve, x);
    const base = baselineAt(baseline.points, x);
    if (raw === null || base === null || !coversRange(baseline.validRanges, [x, x])) {
      closeRegion();
      previous = undefined;
      continue;
    }
    const point = { x, y: raw - base };
    if (!Number.isFinite(point.y)) return failure("E_INTEGRATION_OVERFLOW", "Baseline subtraction is outside numeric limits.");
    if (previous && !coversRange(baseline.validRanges, [previous.x, x])) {
      closeRegion();
      previous = undefined;
    }
    const currentSign = Math.sign(point.y);
    if (currentSign === 0) {
      if (sign) region.push(point);
      closeRegion();
    } else if (sign && currentSign !== sign && previous) {
      const crossing = { x: interpolate(0, previous.y, previous.x, point.y, point.x), y: 0 };
      region.push(crossing);
      closeRegion();
      sign = currentSign;
      region = [crossing, point];
    } else if (!sign) {
      sign = currentSign;
      region = previous && previous.y === 0 ? [previous, point] : [point];
    } else {
      region.push(point);
    }
    previous = point;
  }
  closeRegion();
  return okay(windows);
}
