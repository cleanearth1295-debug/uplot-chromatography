import type { AxisUnit, Curve, Diagnostic, Interval, Result, Run } from "./types.ts";
import { resolveCurveAxis } from "./axis.ts";
import { isAxisUnit, sampleCurve, validateCurve } from "./curve.ts";
import { failure, okay } from "./result.ts";

export type ComparisonLayout = "overlay" | "stack" | "mirror" | "tiled" | "tabs";
export interface ComparisonSource {
  id: string;
  run: Run;
  curveId: string;
  label?: string;
  visible?: boolean;
  /** Display offsets in the pane's X unit and the curve's signal unit. */
  xOffset?: number;
  yOffset?: number;
}
export interface ComparisonViewOptions {
  xUnit: AxisUnit;
  layout: ComparisonLayout;
  mode?: "portable" | "classic";
  fixedY?: Interval;
  activeSeriesId?: string;
}
export interface ComparisonSeries {
  id: string;
  runId: string;
  chromatogramId: string;
  sourceCurveId: string;
  label: string;
  pane: string;
  visible: boolean;
  xOffset: number;
  yOffset: number;
  yDirection: 1 | -1;
  /** Rendering coordinates. Use sourceCurveId to look up the curve for evaluation. */
  curve: Curve;
}
export interface ComparisonView {
  xUnit: AxisUnit;
  layout: ComparisonLayout;
  fixedY?: Interval;
  cursorSynchronized: boolean;
  series: readonly ComparisonSeries[];
}

const independentAxisErrors = new Set(["E_TIME_VOLUME_MAP", "E_COLUMN_VOLUME", "E_COORDINATE_RANGE", "E_AXIS_AMBIGUOUS"]);

function transformCurve(curve: Curve, xOffset: number, yOffset: number, direction: 1 | -1): Result<Curve> {
  const result: Curve = {
    ...curve,
    x: Float64Array.from(curve.x, (x) => x + xOffset),
    y: Float64Array.from(curve.y, (y, i) => curve.missing?.[i] ? 0 : direction * y + yOffset),
    missing: curve.missing?.slice(),
    sourceCurveIds: curve.sourceCurveIds?.slice(),
  };
  return validateCurve(result);
}

export function buildComparisonView(sources: readonly ComparisonSource[], options: ComparisonViewOptions): Result<ComparisonView> {
  const { xUnit, layout, fixedY } = options;
  if (!isAxisUnit(xUnit)) return failure("E_AXIS_UNIT", "Choose a supported comparison axis.");
  if (!sources.length || sources.some(({ id }) => !id.trim()) || new Set(sources.map(({ id }) => id)).size !== sources.length ||
    (layout === "mirror" && sources.length !== 2) ||
    (options.activeSeriesId !== undefined && !sources.some(({ id }) => id === options.activeSeriesId))) {
    return failure("E_COMPARISON_VIEW", "Comparison series require unique IDs. Mirror uses two series and the active series must exist.");
  }
  if (fixedY && (!fixedY.every(Number.isFinite) || fixedY[0] >= fixedY[1])) {
    return failure("E_COMPARISON_VIEW", "Fixed Y limits must increase and be finite.");
  }
  const limitStackOffset = options.mode === "classic" && layout === "stack" && fixedY !== undefined;
  if (limitStackOffset && sources.some(({ yOffset }) => yOffset !== undefined && yOffset !== 0)) {
    return failure("E_COMPARISON_STACK_Y", "Classic stack offset is unavailable with a fixed Y axis.");
  }

  const active = sources.find(({ id }) => id === options.activeSeriesId) ?? sources.find(({ visible }) => visible !== false) ?? sources[0]!;
  const activeChartId = active.run.curves.find(({ id }) => id === active.curveId)?.sourceChromatogramId;
  const stackedTop = new Map<string, number>();
  const series: ComparisonSeries[] = [];
  const warnings: Diagnostic[] = limitStackOffset
    ? [{ code: "W_COMPARISON_STACK_Y", message: "Classic stack offset is disabled with a fixed Y axis." }]
    : [];
  for (const [index, source] of sources.entries()) {
    const { id, run, curveId } = source;
    const original = run.curves.find((curve) => curve.id === curveId);
    if (!original) return failure("E_CURVE_ID", "The requested curve is not in the run.", { curveId });
    const chart = run.chromatograms.find(({ id }) => id === original.sourceChromatogramId);
    if (options.mode === "classic" && chart?.origin === "imported" && xUnit === "CV") {
      return failure("E_COMPARISON_IMPORTED_CV", "Classic display cannot use CV for imported chromatograms. Try a measured time or volume axis.", { curveId });
    }
    const resolved = resolveCurveAxis(run, curveId, xUnit);
    if (!resolved.ok) {
      const independentPane = layout === "tiled" || layout === "tabs";
      if (!independentPane || resolved.errors.some(({ code }) => !independentAxisErrors.has(code))) {
        return { ok: false, errors: resolved.errors.map((error) => ({ ...error, curveId })) };
      }
      warnings.push({ code: "W_COMPARISON_INDEPENDENT_AXIS",
        message: "This pane uses its source axis. " + resolved.errors.map(({ message }) => message).join(" "), curveId });
    }
    const aligned = resolved.ok ? resolved.value : original;

    const visible = source.visible !== false && (layout !== "tabs" ||
      (run.id === active.run.id && original.sourceChromatogramId === activeChartId));
    const xOffset = source.xOffset ?? 0;
    let yOffset = source.yOffset ?? 0;
    const yDirection = layout === "mirror" && index === 1 ? -1 : 1;
    if (layout === "stack" && !limitStackOffset && visible) {
      const { y, missing, signalUnit } = aligned;
      let min = Infinity;
      let max = -Infinity;
      for (const [sample, value] of y.entries()) {
        if (missing?.[sample]) continue;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      if (min !== Infinity) {
        const previousTop = stackedTop.get(signalUnit);
        if (previousTop !== undefined && source.yOffset === undefined) {
          const gap = Math.max((max - min) * 0.05, Number.EPSILON * Math.max(1, Math.abs(previousTop)));
          yOffset = previousTop + gap - min;
        }
        stackedTop.set(signalUnit, Math.max(previousTop ?? -Infinity, max + yOffset));
      }
    }
    if (!Number.isFinite(xOffset) || !Number.isFinite(yOffset)) {
      return failure("E_COMPARISON_OFFSET", "Comparison offsets must be finite.", { curveId });
    }
    const transformed = transformCurve(aligned, xOffset, yOffset, yDirection);
    if (!transformed.ok) return transformed;
    const label = source.label ?? original.label;
    const chromatogramId = original.sourceChromatogramId;
    series.push({
      id, runId: run.id, chromatogramId, sourceCurveId: curveId, label, visible, xOffset, yOffset, yDirection,
      pane: layout === "tiled" || layout === "tabs" ? JSON.stringify([run.id, chromatogramId, aligned.xUnit]) : "comparison",
      curve: { ...transformed.value, id, label },
    });
  }
  return okay({
    xUnit, layout, fixedY: fixedY ? [fixedY[0], fixedY[1]] : undefined,
    cursorSynchronized: series.every((item) => !item.visible || item.curve.xUnit === xUnit), series,
  }, warnings);
}

export interface ComparisonCursorValue {
  seriesId: string;
  pane: string;
  x: number;
  /** Coordinate before the display offset, in the synchronized axis unit. */
  unshiftedX: number;
  signal: number | null;
  displaySignal: number | null;
}

export function synchronizeComparisonCursor(view: ComparisonView, x: number): Result<ComparisonCursorValue[]> {
  if (!Number.isFinite(x)) return failure("E_COORDINATE", "The cursor coordinate must be finite.");
  if (!view.cursorSynchronized) return failure("E_COMPARISON_CURSOR_AXIS", "Visible panes need a common axis to synchronize the cursor.");
  const values: ComparisonCursorValue[] = [];
  for (const series of view.series) {
    if (!series.visible) continue;
    const unshiftedX = x - series.xOffset;
    if (!Number.isFinite(unshiftedX)) return failure("E_COORDINATE", "The unshifted cursor coordinate is not finite.", { curveId: series.sourceCurveId });
    const displaySignal = sampleCurve(series.curve, x);
    values.push({ seriesId: series.id, pane: series.pane, x, unshiftedX, displaySignal,
      signal: displaySignal === null ? null : (displaySignal - series.yOffset) * series.yDirection });
  }
  return okay(values);
}

export interface ShiftComparisonCurveOptions {
  id: string;
  shiftX?: number;
  shiftY?: number;
  label?: string;
}

export function deriveShiftedCurve(run: Run, curveId: string, options: ShiftComparisonCurveOptions): Result<Curve> {
  const source = run.curves.find(({ id }) => id === curveId);
  if (!source) return failure("E_CURVE_ID", "The requested curve is not in the run.", { curveId });
  if (!options.id.trim() || run.curves.some(({ id }) => id === options.id)) {
    return failure("E_CURVE_ID", "A derived curve requires a new ID.", { curveId: options.id });
  }
  const { shiftX = 0, shiftY = 0 } = options;
  if (!Number.isFinite(shiftX) || !Number.isFinite(shiftY)) {
    return failure("E_COMPARISON_OFFSET", "Curve shifts must be finite.", { curveId });
  }
  const checked = validateCurve(source);
  if (!checked.ok) return checked;
  const shifted = transformCurve(source, shiftX, shiftY, 1);
  if (!shifted.ok) return shifted;
  return okay({
    ...shifted.value, id: options.id, label: options.label ?? source.label + " (shifted)",
    sourceLabel: undefined, kind: "derived", sourceCurveIds: [source.id],
  });
}
