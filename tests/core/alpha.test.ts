import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPeakEdit, calculateBaseline, defaultIntegrationConfig, filterVisiblePeaks,
  integratePeaks, mapCoordinate, resolveCurveAxis, validateCurve,
} from "../../src/index.ts";
import type { AnalysisState, Curve, PeakTable, Result, Run } from "../../src/index.ts";
import { decodeSnapshot, encodePeakTableCsv, encodeSnapshot, parseUnicornCurves } from "../../src/io/index.ts";

function value<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}

function run(csv = "Time [min],UV [mAU]\n0,0\n1,2\n2,0\n"): Run {
  return value(parseUnicornCurves(csv, { runId: "run1" }));
}

function triangle(runData: Run, end = 2): PeakTable {
  const baseline = value(calculateBaseline(runData, "run1:uv:1", { kind: "zero" }));
  return value(integratePeaks(runData.curves[0]!, baseline, [
    { id: "p1", left: { x: 0, kind: "manual" }, right: { x: end, kind: "manual" }, polarity: "positive" },
  ], defaultIntegrationConfig("min")));
}

test("CSV imports time and mAU and integrates a triangular peak", () => {
  const table = triangle(run());
  assert.equal(table.areaUnit, "mAU·min");
  assert.equal(table.rows[0]?.area, 2);
  assert.deepEqual(table.rows[0]?.apex, { x: 1, y: 2 });
  assert.equal(table.rows[0]?.width, 2);
  assert.equal(table.rows[0]?.halfHeightWidth, 1);
  assert.equal(table.rows[0]?.pctTotalPeakArea, 100);
});

test("a manual move interpolates the end boundary and preserves the previous draft", () => {
  const input = run();
  const baseline = value(calculateBaseline(input, input.curves[0]!.id, { kind: "zero" }));
  const previous = triangle(input);
  const state: AnalysisState = {
    revision: 0, run: input, activeChromatogramId: input.chromatograms[0]!.id,
    activeCurveId: input.curves[0]!.id, activePeakTableId: previous.id,
    peakTables: [previous], baselines: [baseline],
    windows: [{ id: "p1", ...previous.rows[0]!.bounds, polarity: "positive" }],
  };
  const next = value(applyPeakEdit(state, { op: "move-limit", peakId: "p1", edge: "right", x: 1.5, expectedRevision: 0 }));
  assert.equal(next.revision, 1);
  assert.equal(next.peakTables[0]?.rows[0]?.area, 1.75);
  assert.equal(state.peakTables[0]?.rows[0]?.area, 2);
  assert.equal(applyPeakEdit(next, { op: "move-limit", peakId: "p1", edge: "right", x: 1, expectedRevision: 0 }).ok, false);
});

test("time-volume uses measured knots and returns the inverse of a plateau as a range", () => {
  const timeVolume = { timeMin: Float64Array.of(0, 1, 2), volumeMl: Float64Array.of(0, 2, 3) };
  const input: Run = { ...run(), timeVolume, column: { volumeMl: 2.5 } };
  assert.deepEqual(value(mapCoordinate(input, 1.5, "min", "mL")), { kind: "point", x: 2.5 });
  assert.deepEqual(value(mapCoordinate(input, 1.5, "min", "CV")), { kind: "point", x: 1 });
  const plateau = { ...input, timeVolume: { ...timeVolume, volumeMl: Float64Array.of(0, 2, 2) } };
  assert.deepEqual(value(mapCoordinate(plateau, 2, "mL", "min")), { kind: "range", range: [1, 2] });
  assert.deepEqual([...value(resolveCurveAxis(input, input.curves[0]!.id, "mL")).x], [0, 2, 3]);
  assert.equal(resolveCurveAxis(plateau, input.curves[0]!.id, "mL").ok, false);
});

test("a rate change between measured signal points is kept in the volume axis", () => {
  const input = run("Time [min],UV [mAU]\n0,0\n2,4");
  const timeVolume = { timeMin: Float64Array.of(0, 1, 2), volumeMl: Float64Array.of(0, 1, 3) };
  const converted = value(resolveCurveAxis({ ...input, timeVolume }, input.curves[0]!.id, "mL"));
  assert.deepEqual([...converted.x], [0, 1, 3]);
  assert.deepEqual([...converted.y], [0, 2, 4]);
  const baseline = value(calculateBaseline({ ...input, curves: [converted] }, converted.id, { kind: "zero" }));
  const table = value(integratePeaks(converted, baseline, [
    { id: "p1", left: { x: 0, kind: "manual" }, right: { x: 3, kind: "manual" }, polarity: "positive" },
  ], defaultIntegrationConfig("mL")));
  assert.equal(table.rows[0]?.area, 7);
});

test("explicit per-channel X in ASC retains different sample grids and a decimal comma", () => {
  const input = value(parseUnicornCurves("\ufeffUV x;UV;Cond x;Cond\r\n0,0;2,5;0,5;5,5\r\n1,0;;1,5;6,5\r\n2,0;3,5;;", {
    format: "asc", delimiter: ";", decimalSeparator: ",", runId: "sem",
    columns: [
      { x: "UV x", y: "UV", xUnit: "min", signalUnit: "mAU" },
      { x: "Cond x", y: "Cond", xUnit: "min", signalUnit: "mS/cm" },
    ],
  }));
  assert.deepEqual([...input.curves[0]!.x], [0, 1, 2]);
  assert.deepEqual([...input.curves[0]!.missing!], [0, 1, 0]);
  assert.deepEqual([...input.curves[1]!.x], [0.5, 1.5]);
  assert.deepEqual([...input.curves[1]!.y], [5.5, 6.5]);
});

test("duplicate X and unresolved axis units return identifiable diagnostics", () => {
  const input = run();
  const invalid: Curve = { ...input.curves[0]!, x: Float64Array.of(0, 1, 1) };
  const result = validateCurve(invalid);
  assert(!result.ok);
  assert.equal(result.errors[0]?.code, "E_X_ORDER");
  assert.equal(result.errors[0]?.index, 2);
  assert.equal(parseUnicornCurves("X,UV\n0,1\n1,2", { runId: "unknown" }).ok, false);
});

test("trapezoids include knots from the baseline and preserve negative areas", () => {
  const input = run("Time [min],UV [mAU]\n0,2\n2,2");
  const curve = input.curves[0]!;
  const manual = value(calculateBaseline(input, curve.id, {
    kind: "manual", shape: "linear", anchors: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }],
  }));
  const pos = { id: "p", left: { x: 0, kind: "manual" }, right: { x: 2, kind: "manual" }, polarity: "positive" } as const;
  assert.equal(value(integratePeaks(curve, manual, [pos], defaultIntegrationConfig("min"))).rows[0]?.area, 3);
  const negative = run("Time [min],UV [mAU]\n0,0\n1,-2\n2,0");
  const zero = value(calculateBaseline(negative, negative.curves[0]!.id, { kind: "zero" }));
  assert.equal(value(integratePeaks(negative.curves[0]!, zero, [{ ...pos, polarity: "negative" }], {
    ...defaultIntegrationConfig("min"), acceptNegative: true,
  })).rows[0]?.area, -2);
});

test("measured gaps inside a peak prevent integration", () => {
  const input = run("Time [min],UV [mAU]\n0,0\n1,\n2,0");
  const curve = input.curves[0]!;
  const baseline = value(calculateBaseline(input, curve.id, { kind: "zero" }));
  const r = integratePeaks(curve, baseline, [
    { id: "p", left: { x: 0, kind: "manual" }, right: { x: 2, kind: "manual" }, polarity: "positive" },
  ], defaultIntegrationConfig("min"));
  assert(!r.ok);
  assert.equal(r.errors[0]?.code, "E_INCOMPLETE_INTERVAL");
});

test("display filtering preserves area denominators and the CSV column order", () => {
  const input = run("Time [min],UV [mAU]\n0,0\n1,6\n2,0\n3,4\n4,0");
  const curve = input.curves[0]!;
  const zero = value(calculateBaseline(input, curve.id, { kind: "zero" }));
  const windows = [[0, 2], [2, 4]].map(([left, right], i) => ({
    id: String(i), left: { x: left!, kind: "manual" as const }, right: { x: right!, kind: "manual" as const },
    polarity: "positive" as const,
  }));
  const table = value(integratePeaks(curve, zero, windows, defaultIntegrationConfig("min")));
  const visible = filterVisiblePeaks(table, (p) => p.area > 4);
  assert.equal(visible[0]?.pctTotalPeakArea, 60);
  assert.equal(table.denominators.peakArea, 10);
  assert.equal(encodePeakTableCsv(table, ["area", "id"]).split("\n")[0], "Area [mAU·min],Peak ID");
});

test("snapshot restores typed arrays and rejects a dangling active curve", () => {
  const input = run("Time [min],UV [mAU]\n0,0\n1,\n2,0");
  const state: AnalysisState = {
    revision: 0, run: input, activeChromatogramId: input.chromatograms[0]!.id,
    activeCurveId: input.curves[0]!.id, peakTables: [], baselines: [], windows: [],
  };
  const restored = value(decodeSnapshot(encodeSnapshot(state)));
  assert(restored.run.curves[0]?.x instanceof Float64Array);
  assert.deepEqual([...restored.run.curves[0]!.missing!], [0, 1, 0]);
  assert.equal(decodeSnapshot(encodeSnapshot({ ...state, activeCurveId: "no-such-curve" })).ok, false);
});

test("snapshot rejects unsafe peak-table settings before an edit can consume them", () => {
  const input = run();
  const table = triangle(input);
  const curve = input.curves[0]!;
  const baseline = value(calculateBaseline(input, curve.id, { kind: "zero" }));
  const state: AnalysisState = {
    revision: 0, run: input, activeChromatogramId: curve.sourceChromatogramId, activeCurveId: curve.id,
    activePeakTableId: table.id, baselines: [baseline], peakTables: [table], windows: [],
  };
  const serialized = JSON.parse(encodeSnapshot(state));
  delete serialized.peakTables[0].config.separation;
  const decoded = decodeSnapshot(JSON.stringify(serialized));
  assert(!decoded.ok);
  assert.equal(decoded.errors[0]?.code, "E_SNAPSHOT_TABLE");
});
