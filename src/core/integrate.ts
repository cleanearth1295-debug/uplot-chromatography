import type {
  AxisUnit, BaselineResult, Curve, IntegrationConfig, Interval, PeakRow, PeakTable, PeakWindow, Result, Run, XY,
} from "./types.ts";
import { baselineAt, coversRange } from "./baseline.ts";
import { interpolate, lowerBound, sampleCurve, validateCurve } from "./curve.ts";
import { failure, okay } from "./result.ts";
import { peakMoments, peakResolution } from "./peak-metrics.ts";
import { applySkimming } from "./peak-skim.ts";
import type { Residual } from "./peak-skim.ts";
import { peakContext } from "./peak-context.ts";

export function defaultIntegrationConfig(xUnit: AxisUnit): IntegrationConfig {
  return { xUnit, acceptNegative: false, separation: { kind: "dropline" }, asymmetryAt: 0.1, resolution: "half-height" };
}

function knots(curve: Curve, baseline: BaselineResult, baselineX: Float64Array, [left, right]: Interval): number[] {
  const position = new Set([left, right]);
  for (let index = lowerBound(curve.x, left); index < curve.x.length && curve.x[index]! < right; index++) {
    position.add(curve.x[index]!);
  }
  for (let index = lowerBound(baselineX, left); index < baseline.points.length && baselineX[index]! < right; index++) {
    position.add(baselineX[index]!);
  }
  return [...position].sort((a, b) => a - b);
}

function crossing(points: readonly Residual[], apex: number, step: -1 | 1, level: number, sign: number): number | null {
  for (let inside = apex, outside = apex + step; outside >= 0 && outside < points.length; inside = outside, outside += step) {
    const near = points[inside]!;
    const far = points[outside]!;
    if (sign * far.y === level) return far.x;
    if (sign * far.y < level) return interpolate(level, sign * near.y, near.x, sign * far.y, far.x);
  }
  return null;
}

function trapezoidArea(a: XY, b: XY): number {
  return (b.x - a.x) * (a.y / 2 + b.y / 2);
}

function positiveArea(a: XY, b: XY): number {
  if (a.y <= 0 && b.y <= 0) return 0;
  if (a.y >= 0 && b.y >= 0) return trapezoidArea(a, b);
  const x = interpolate(0, a.y, a.x, b.y, b.x);
  return a.y > 0 ? trapezoidArea(a, { x, y: 0 }) : trapezoidArea({ x, y: 0 }, b);
}

function collect(curve: Curve, baseline: BaselineResult, x: number): Residual | null {
  const raw = sampleCurve(curve, x);
  const base = baselineAt(baseline.points, x);
  return raw === null || base === null ? null : { x, raw, baseline: base, y: raw - base };
}

function makeRow(window: PeakWindow, points: readonly Residual[], asymmetryAt: number): PeakRow {
  const sign = window.polarity === "negative" ? -1 : 1;
  const apexIndex = points.reduce((best, point, index) => point.y * sign > points[best]!.y * sign ? index : best, 0);
  const apex = points[apexIndex]!;
  const start = points[0]!;
  const end = points.at(-1)!;
  const magnitude = Math.max(0, sign * apex.y);
  const halfLeft = magnitude ? crossing(points, apexIndex, -1, magnitude / 2, sign) : null;
  const halfRight = magnitude ? crossing(points, apexIndex, 1, magnitude / 2, sign) : null;
  const leftAt = magnitude ? crossing(points, apexIndex, -1, magnitude * asymmetryAt, sign) : null;
  const rightAt = magnitude ? crossing(points, apexIndex, 1, magnitude * asymmetryAt, sign) : null;

  let area = 0;
  for (let index = 1; index < points.length; index++) area += trapezoidArea(points[index - 1]!, points[index]!);

  return {
    id: window.id, name: window.name, polarity: window.polarity,
    bounds: { left: { ...window.left }, right: { ...window.right } }, apex: { x: apex.x, y: apex.raw },
    baselineHeights: { start: start.baseline, apex: apex.baseline, end: end.baseline },
    endpointHeights: { start: start.y, end: end.y }, fractionIds: { start: null, apex: null, end: null },
    height: sign * magnitude, area, width: end.x - start.x,
    halfHeightWidth: halfLeft === null || halfRight === null ? null : halfRight - halfLeft,
    crossings: { halfHeight: [halfLeft, halfRight], asymmetry: [leftAt, rightAt] },
    pctTotalPeakArea: null, pctTotalCurveArea: null,
    asymmetry: leftAt !== null && rightAt !== null && apex.x > leftAt ? (rightAt - apex.x) / (apex.x - leftAt) : null,
    ...peakMoments(points, apex.x, sign),
    resolution: null, retentionFactor: null, kav: null, plates: null, hetpCm: null, platesPerM: null,
  };
}

/** Pass the source run to populate column-performance and fraction fields. */
export function integratePeaks(
  curve: Curve,
  baseline: BaselineResult,
  windows: readonly PeakWindow[],
  config: IntegrationConfig,
  run?: Run,
): Result<PeakTable> {
  const checked = validateCurve(curve);
  if (!checked.ok) return checked;
  if (baseline.curveId !== curve.id || baseline.xUnit !== curve.xUnit || baseline.signalUnit !== curve.signalUnit || config.xUnit !== curve.xUnit) {
    return failure("E_INTEGRATION_UNITS", "Curve, baseline and integration config must refer to the same axis, signal and curve.");
  }
  if (run && run.id !== curve.runId) return failure("E_INTEGRATION_RUN", "Peak metadata must come from the curve's run.");
  if ((config.injectionX !== undefined && !Number.isFinite(config.injectionX)) ||
    (config.fractionTrackId !== undefined && (typeof config.fractionTrackId !== "string" || !config.fractionTrackId.trim()))) {
    return failure("E_INTEGRATION_CONTEXT", "The injection coordinate must be finite and the fraction track ID must be nonempty.");
  }
  if (config.separation.kind === "skim" && !(Number.isFinite(config.separation.ratio) && config.separation.ratio >= 1)) {
    return failure("E_SKIM_RATIO", "The skim ratio must be finite and at least one.");
  }
  const rejects = config.reject;
  if (rejects && ([rejects.minArea, rejects.minHeight, rejects.minWidth, rejects.keepLargest]
    .some((n) => n !== undefined && (!Number.isFinite(n) || n < 0)) ||
    (rejects.keepLargest !== undefined && !Number.isInteger(rejects.keepLargest)))) {
    return failure("E_REJECT_OPTIONS", "Reject options must be finite and nonnegative, and count must be an integer.");
  }
  if (!(config.asymmetryAt > 0 && config.asymmetryAt < 1)) {
    return failure("E_ASYMMETRY_LEVEL", "The asymmetry level must lie strictly between zero and one.");
  }

  const baselineX = Float64Array.from(baseline.points, (point) => point.x);
  if (baselineX.length < 2 || baseline.points.some((point, index) => !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) || (index > 0 && point.x <= baselineX[index - 1]!))) {
    return failure("E_BASELINE_POINTS", "The calculation requires finite, strictly increasing baseline points.");
  }

  const domain: Interval = [curve.x[0]!, curve.x.at(-1)!];
  const areaRange = config.window ?? domain;
  if (!Number.isFinite(areaRange[0]) || !Number.isFinite(areaRange[1]) ||
    areaRange[0] >= areaRange[1] || areaRange[0] < domain[0] || areaRange[1] > domain[1]) {
    return failure("E_INTEGRATION_RANGE", "The integration range must be inside the measured curve.", { range: areaRange });
  }

  const ids = new Set<string>();
  let previousEnd = areaRange[0];
  const sorted = [...windows].sort((a, b) => a.left.x - b.left.x);
  const samples: Residual[][] = [];
  for (const window of sorted) {
    const range: Interval = [window.left.x, window.right.x];
    if (!window.id || ids.has(window.id) || !range.every(Number.isFinite) ||
      range[0] < previousEnd || range[0] >= range[1] || range[1] > areaRange[1]) {
      return failure("E_PEAK_WINDOW", "Peak IDs must be unique and intervals ordered, distinct and inside the integration range.", { curveId: curve.id, range });
    }
    if (window.polarity === "negative" && !config.acceptNegative) {
      return failure("E_NEGATIVE_PEAK", "Enable negative peaks before integrating a negative window.", { curveId: curve.id, range });
    }
    ids.add(window.id);
    previousEnd = range[1];
    if (!coversRange(baseline.validRanges, range)) {
      return failure("E_INCOMPLETE_INTERVAL", "The baseline does not span the requested peak.", { curveId: curve.id, range });
    }
    const points = knots(curve, baseline, baselineX, range).map((x) => collect(curve, baseline, x));
    if (points.some((point) => point === null)) {
      return failure("E_INCOMPLETE_INTERVAL", "The peak contains a missing measurement or baseline point.", { curveId: curve.id, range });
    }
    if (points.some((point) => !Number.isFinite(point!.y))) {
      return failure("E_INTEGRATION_OVERFLOW", "Baseline subtraction is outside numeric limits.", { curveId: curve.id, range });
    }
    samples.push(points as Residual[]);
  }
  const profiles = config.separation.kind === "skim" ? applySkimming(sorted, samples, config.separation.ratio) :
    samples.map((points) => ({ points, skimLine: undefined, skimExtensions: undefined }));
  const rows = profiles.map(({ points, skimLine, skimExtensions }, index) => ({
    ...makeRow(sorted[index]!, points, config.asymmetryAt),
    ...(skimLine && { skimLine }), ...(skimExtensions && { skimExtensions }),
    ...(skimLine || skimExtensions ? { integrationBounds: [points[0]!.x, points.at(-1)!.x] as Interval } : {}),
  }));

  let curveArea = 0;
  let skippedArea = false;
  const denominatorKnots = knots(curve, baseline, baselineX, areaRange);
  let previous = collect(curve, baseline, denominatorKnots[0]!);
  for (let index = 1; index < denominatorKnots.length; index++) {
    const point = collect(curve, baseline, denominatorKnots[index]!);
    if (point && previous && coversRange(baseline.validRanges, [previous.x, point.x])) {
      curveArea += positiveArea(previous, point);
    } else {
      skippedArea = true;
    }
    previous = point;
  }

  let included = rows.filter((row) => Math.abs(row.area) >= (rejects?.minArea ?? 0) &&
    Math.abs(row.height) >= (rejects?.minHeight ?? 0) && row.width >= (rejects?.minWidth ?? 0));
  if (rejects?.keepLargest !== undefined) {
    included = [...included].sort((a, b) => Math.abs(b.area) - Math.abs(a.area) || a.apex.x - b.apex.x)
      .slice(0, rejects.keepLargest).sort((a, b) => a.bounds.left.x - b.bounds.left.x);
  }
  const magnitude = config.totalPeakAreaPolicy === "absolute" ? Math.abs : (n: number) => n;
  const peakArea = included.reduce((sum, row) => sum + magnitude(row.area), 0);
  if (![curveArea, peakArea, ...included.map((row) => row.area)].every(Number.isFinite)) {
    return failure("E_INTEGRATION_OVERFLOW", "The integrated area is outside numeric limits.", { curveId: curve.id });
  }
  const context = run ? peakContext(run, config) : undefined;
  const adjusted = included.map((row, index) => ({
    ...row,
    ...context?.(row),
    resolution: peakResolution(included[index - 1], row, config.resolution),
    pctTotalPeakArea: peakArea ? magnitude(row.area) / peakArea * 100 : null,
    pctTotalCurveArea: curveArea && !skippedArea ? row.area / curveArea * 100 : null,
  }));
  const warnings = [];
  if (skippedArea) warnings.push({ code: "W_CURVE_AREA_INCOMPLETE", message: "Some intervals are missing. Percent of full curve area is unavailable.", curveId: curve.id });
  if (config.separation.kind === "skim") warnings.push({ code: "W_SKIM_PROVISIONAL", message: "Skim uses a sampled tangent. Adjacent peaks retain droplines when no supporting tangent is found.", curveId: curve.id });
  return okay({
    id: `${curve.id}:peaks:${baseline.id}`, chromatogramId: curve.sourceChromatogramId,
    baselineId: baseline.id, curveId: curve.id, config: structuredClone(config), xUnit: curve.xUnit,
    signalUnit: curve.signalUnit, areaUnit: `${curve.signalUnit}·${curve.xUnit}`, rows: adjusted,
    denominators: { peakArea, curveAreaAboveBaseline: curveArea },
  }, warnings);
}

export function filterVisiblePeaks(table: PeakTable, predicate: (peak: PeakRow) => boolean): readonly PeakRow[] {
  return table.rows.filter(predicate);
}
