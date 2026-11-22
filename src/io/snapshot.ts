import type { AnalysisState, BaselineResult, Chromatogram, Curve, PeakTable, PeakWindow, Result, Run } from "../core/types.ts";
import { isAxisUnit, validateCurve } from "../core/curve.ts";
import { failure, okay } from "../core/result.ts";

export function encodeSnapshot(state: AnalysisState): string {
  const { run, ...session } = state;
  const curves = run.curves.map(({ x, y, missing, ...curve }) => ({
    ...curve, x: [...x], y: Array.from(y, (value, index) => missing?.[index] ? null : value),
  }));
  const timeVolume = run.timeVolume && { timeMin: [...run.timeVolume.timeMin], volumeMl: [...run.timeVolume.volumeMl] };
  return JSON.stringify({ schemaVersion: 1, ...session, run: { ...run, curves, timeVolume } });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function arrayOfNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(finite);
}
function unique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}
function limit(item: unknown): boolean {
  return object(item) && finite(item.x) && typeof item.kind === "string" &&
    ["baseline-intersection", "dropline", "skim", "manual"].includes(item.kind);
}
function interval(item: unknown): item is [number, number] {
  return arrayOfNumbers(item) && item.length === 2 && item[0]! <= item[1]!;
}
function config(item: unknown): boolean {
  if (!object(item) || !isAxisUnit(item.xUnit) || typeof item.acceptNegative !== "boolean" ||
    !finite(item.asymmetryAt) || item.asymmetryAt <= 0 || item.asymmetryAt >= 1 ||
    !["base-width", "sigma", "half-height"].includes(String(item.resolution)) ||
    (item.window !== undefined && !interval(item.window)) ||
    (item.injectionX !== undefined && !finite(item.injectionX)) ||
    (item.fractionTrackId !== undefined && (typeof item.fractionTrackId !== "string" || !item.fractionTrackId.trim())) ||
    (item.totalPeakAreaPolicy !== undefined && item.totalPeakAreaPolicy !== "signed" && item.totalPeakAreaPolicy !== "absolute") ||
    !object(item.separation)) return false;
  const reject = item.reject;
  if (reject !== undefined && (!object(reject) ||
    Object.values(reject).some((value) => !finite(value) || value < 0) ||
    (reject.keepLargest !== undefined && !Number.isSafeInteger(reject.keepLargest)))) return false;
  return item.separation.kind === "dropline" ||
    (item.separation.kind === "skim" && finite(item.separation.ratio) && item.separation.ratio >= 1);
}
function baselineSpec(spec: unknown): boolean {
  if (!object(spec)) return false;
  switch (spec.kind) {
    case "zero": return true;
    case "curve": return typeof spec.baselineCurveId === "string" && !!spec.baselineCurveId;
    case "manual":
      return ["linear", "classic-spline"].includes(String(spec.shape)) &&
        Array.isArray(spec.anchors) && spec.anchors.length >= 2 && spec.anchors.every((point, i, points) =>
          object(point) && finite(point.x) && finite(point.y) && (i === 0 || point.x > points[i - 1].x)) &&
        (spec.straightAfter === undefined || (Array.isArray(spec.straightAfter) &&
          spec.straightAfter.every((index) => Number.isInteger(index) && index >= 0 && index < (spec.anchors as unknown[]).length - 1)));
    case "morphological": return finite(spec.structureWidth) && spec.structureWidth > 0 &&
      finite(spec.minAnchorDistance) && spec.minAnchorDistance >= 0;
    case "classical": return finite(spec.minSegment) && spec.minSegment > 0 &&
      finite(spec.noiseWindow) && spec.noiseWindow >= 0 && finite(spec.maxSlope) && spec.maxSlope >= 0 && finite(spec.maxLevel);
    default: return false;
  }
}
function validPeakLimitPair(left: unknown, right: unknown): boolean {
  return limit(left) && limit(right) && object(left) && object(right) && finite(left.x) && finite(right.x) && left.x < right.x;
}
function nullableNumber(value: unknown): boolean {
  return value === null || finite(value);
}
function crossings(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && value.every(nullableNumber);
}
function segment(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 &&
    value.every((point) => object(point) && finite(point.x) && finite(point.y));
}
function validPeakRow(row: unknown): boolean {
  if (!object(row) || typeof row.id !== "string" || !row.id ||
    (row.name !== undefined && typeof row.name !== "string") ||
    !["positive", "negative"].includes(String(row.polarity)) || !object(row.bounds) ||
    !validPeakLimitPair(row.bounds.left, row.bounds.right) || !object(row.apex) ||
    !finite(row.apex.x) || !finite(row.apex.y) || !finite(row.height) || !finite(row.area) ||
    !finite(row.width) || !object(row.baselineHeights) || !object(row.endpointHeights) || !object(row.fractionIds)) return false;
  const { baselineHeights, endpointHeights, fractionIds } = row;
  return [row.centroid, row.momentStandardDeviation].every((value) => value === undefined || nullableNumber(value)) &&
    (row.crossings === undefined || (object(row.crossings) && crossings(row.crossings.halfHeight) && crossings(row.crossings.asymmetry))) &&
    (row.integrationBounds === undefined || (interval(row.integrationBounds) && row.integrationBounds[0] < row.integrationBounds[1])) &&
    (row.skimLine === undefined || segment(row.skimLine)) &&
    (row.skimExtensions === undefined || (Array.isArray(row.skimExtensions) && row.skimExtensions.every(segment))) &&
    [baselineHeights.start, baselineHeights.apex, baselineHeights.end, endpointHeights.start, endpointHeights.end].every(finite) &&
    [fractionIds.start, fractionIds.apex, fractionIds.end].every((value) => value === null || typeof value === "string") &&
    [row.halfHeightWidth, row.pctTotalPeakArea, row.pctTotalCurveArea, row.asymmetry, row.resolution, row.sigma, row.retentionFactor,
      row.kav, row.plates, row.hetpCm, row.platesPerM].every(nullableNumber);
}

function validRunMetadata(run: Record<string, unknown>): boolean {
  const { column, markers, fractions, variables, uvPathLengthCm } = run;
  return (column === undefined || (object(column) &&
    (column.separationMode === undefined || column.separationMode === "SEC" || column.separationMode === "other") &&
    ["volumeMl", "bedHeightCm", "voidVolumeMl", "totalLiquidVolumeMl", "particleDiameterUm"].every(
      (key) => column[key] === undefined || finite(column[key]),
    ))) &&
    (uvPathLengthCm === undefined || finite(uvPathLengthCm)) &&
    Array.isArray(markers) && markers.every((item) => object(item) && typeof item.id === "string" &&
      typeof item.label === "string" && finite(item.x) && isAxisUnit(item.xUnit) &&
      ["injection", "phase", "event", "note"].includes(String(item.kind))) &&
    Array.isArray(fractions) && fractions.every((item) => object(item) && typeof item.id === "string" &&
      typeof item.label === "string" && typeof item.trackId === "string" && Number.isSafeInteger(item.sequence) &&
      interval(item.range) && item.range[0] < item.range[1] && isAxisUnit(item.xUnit) &&
      (item.volumeMl === undefined || finite(item.volumeMl))) &&
    (variables === undefined || (object(variables) && Object.values(variables).every((value) => typeof value === "string" || finite(value))));
}

function decodeCurve(value: unknown, runId: string): Result<Curve> {
  if (!object(value) || typeof value.id !== "string" || typeof value.label !== "string" ||
    typeof value.sourceChromatogramId !== "string" || value.runId !== runId || !isAxisUnit(value.xUnit) ||
    typeof value.signalUnit !== "string" || !["measured", "baseline", "derived"].includes(String(value.kind)) ||
    (value.sourceLabel !== undefined && typeof value.sourceLabel !== "string") ||
    (value.sourceCurveIds !== undefined && (!Array.isArray(value.sourceCurveIds) ||
      value.sourceCurveIds.some((item) => typeof item !== "string"))) ||
    !arrayOfNumbers(value.x) || !Array.isArray(value.y) || !value.y.every((item) => item === null || finite(item))) {
    return failure("E_SNAPSHOT_CURVE", "A serialized curve contains invalid metadata or coordinates.");
  }
  const curve: Curve = {
    ...value,
    id: value.id, label: value.label, runId, sourceChromatogramId: value.sourceChromatogramId,
    kind: value.kind as Curve["kind"], xUnit: value.xUnit, signalUnit: value.signalUnit,
    x: Float64Array.from(value.x), y: Float64Array.from(value.y, (item) => item ?? 0),
    missing: value.y.includes(null) ? Uint8Array.from(value.y, (item) => Number(item === null)) : undefined,
  };
  return validateCurve(curve);
}

export function decodeSnapshot(text: string): Result<AnalysisState> {
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    return failure("E_SNAPSHOT_JSON", "The snapshot must be valid JSON.");
  }

  if (!object(input) || input.schemaVersion !== 1) return failure("E_SNAPSHOT_VERSION", "Expected snapshot schema version 1.");
  if (!object(input.run) || typeof input.run.id !== "string" || typeof input.run.name !== "string" ||
    !Array.isArray(input.run.curves) || !Array.isArray(input.run.chromatograms) ||
    !Array.isArray(input.run.markers) || !Array.isArray(input.run.fractions) ||
    !Array.isArray(input.baselines) || !Array.isArray(input.peakTables) || !Array.isArray(input.windows) ||
    !finite(input.revision) || !Number.isSafeInteger(input.revision) || input.revision < 0) {
    return failure("E_SNAPSHOT_SHAPE", "The snapshot does not contain the required run and session fields.");
  }

  const source = input.run;
  if (!validRunMetadata(source)) return failure("E_SNAPSHOT_RUN_METADATA", "The run contains malformed column, marker, fraction or variable metadata.");
  const curves: Curve[] = [];
  for (const entry of source.curves as unknown[]) {
    const curve = decodeCurve(entry, source.id as string);
    if (!curve.ok) return curve;
    curves.push(curve.value);
  }
  const chromatograms = source.chromatograms as unknown[];
  const curveIds = new Set(curves.map((curve) => curve.id));
  if (!unique(curves.map((curve) => curve.id)) || !chromatograms.every((chart) =>
    object(chart) && typeof chart.id === "string" && typeof chart.sourceName === "string" &&
    ["original", "imported", "derived"].includes(String(chart.origin)) && Array.isArray(chart.peakTableIds) &&
    Array.isArray(chart.curveRefs) && chart.curveRefs.every((ref) => object(ref) && typeof ref.curveId === "string" &&
      typeof ref.runId === "string" && typeof ref.chromatogramId === "string" && Number.isInteger(ref.slot) &&
      (ref.runId !== source.id || curveIds.has(ref.curveId))))) {
    return failure("E_SNAPSHOT_REFERENCE", "The run contains invalid or duplicate curve references.");
  }

  const chartIds = (chromatograms as Chromatogram[]).map((item) => item.id);
  if (!unique(chartIds) || curves.some((curve) => !chartIds.includes(curve.sourceChromatogramId)) ||
    typeof input.activeCurveId !== "string" || !curveIds.has(input.activeCurveId) ||
    typeof input.activeChromatogramId !== "string" || !chartIds.includes(input.activeChromatogramId)) {
    return failure("E_SNAPSHOT_REFERENCE", "The active chromatogram, curve or source reference is invalid.");
  }

  const baselines = input.baselines as unknown[];
  if (!baselines.every((base) => object(base) && typeof base.id === "string" &&
    typeof base.curveId === "string" && curveIds.has(base.curveId) && isAxisUnit(base.xUnit) &&
    typeof base.signalUnit === "string" && baselineSpec(base.spec) &&
    Array.isArray(base.points) && base.points.length >= 2 && base.points.every((item, index, points) =>
      object(item) && finite(item.x) && finite(item.y) && (index === 0 || item.x > points[index - 1].x)) &&
    Array.isArray(base.validRanges) && base.validRanges.length > 0 && base.validRanges.every(interval))) {
    return failure("E_SNAPSHOT_BASELINE", "The run contains invalid baseline geometry or references.");
  }
  const baselineIds = (baselines as BaselineResult[]).map((item) => item.id);
  const tables = input.peakTables as unknown[];
  if (!unique(baselineIds) || (input.activeBaselineId !== undefined && !baselineIds.includes(String(input.activeBaselineId))) ||
    !tables.every((table) => object(table) && typeof table.id === "string" &&
      typeof table.curveId === "string" && curveIds.has(table.curveId) && chartIds.includes(String(table.chromatogramId)) &&
      baselineIds.includes(String(table.baselineId)) && isAxisUnit(table.xUnit) &&
      typeof table.signalUnit === "string" && typeof table.areaUnit === "string" &&
      config(table.config) && object(table.config) && table.config.xUnit === table.xUnit &&
      object(table.denominators) && finite(table.denominators.peakArea) && finite(table.denominators.curveAreaAboveBaseline) &&
      Array.isArray(table.rows) && table.rows.every(validPeakRow))) {
    return failure("E_SNAPSHOT_TABLE", "The run contains an invalid peak table or baseline reference.");
  }

  const tableIds = (tables as PeakTable[]).map((item) => item.id);
  if (!unique(tableIds) || (input.activePeakTableId !== undefined && !tableIds.includes(String(input.activePeakTableId))) ||
    (chromatograms as Chromatogram[]).some((chart) => chart.peakTableIds.some((id) => !tableIds.includes(id))) ||
    !input.windows.every((item) => object(item) && typeof item.id === "string" &&
      validPeakLimitPair(item.left, item.right) && ["positive", "negative"].includes(String(item.polarity)))) {
    return failure("E_SNAPSHOT_REFERENCE", "The current peak table or peak bounds are invalid.");
  }

  let timeVolume: Run["timeVolume"];
  if (source.timeVolume !== undefined) {
    if (!object(source.timeVolume) || !arrayOfNumbers(source.timeVolume.timeMin) ||
      !arrayOfNumbers(source.timeVolume.volumeMl) || source.timeVolume.timeMin.length !== source.timeVolume.volumeMl.length) {
      return failure("E_SNAPSHOT_AXIS", "The time-volume observation arrays are invalid.");
    }
    timeVolume = { timeMin: Float64Array.from(source.timeVolume.timeMin), volumeMl: Float64Array.from(source.timeVolume.volumeMl) };
  }
  const run = { ...source, curves, timeVolume } as unknown as Run;
  return okay({
    run, revision: input.revision, activeChromatogramId: input.activeChromatogramId, activeCurveId: input.activeCurveId,
    activeBaselineId: input.activeBaselineId as string | undefined, activePeakTableId: input.activePeakTableId as string | undefined,
    baselines: baselines as BaselineResult[], peakTables: tables as PeakTable[], windows: input.windows as PeakWindow[],
  });
}
