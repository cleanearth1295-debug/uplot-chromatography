import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPeakEdit, calculateBaseline, defaultIntegrationConfig, detectPeaks, integratePeaks } from "../../src/index.ts";
import { encodeCurvesCsv, parseUnicornCurves } from "../../src/io/index.ts";
import type { AnalysisState, BaselineSpec, Result } from "../../src/index.ts";

function get<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}
function load(ys: number[], spec: BaselineSpec = { kind: "zero" }) {
  const csv = "Time [min],UV [mAU]\n" + ys.map((y, x) => x + "," + y).join("\n");
  const run = get(parseUnicornCurves(csv, { runId: "eg" }));
  const curve = run.curves[0]!;
  return { run, curve, baseline: get(calculateBaseline(run, curve.id, spec)) };
}

test("sign changes are split at interpolated baseline intersections", () => {
  const { curve, baseline } = load([0, 2, -2, 0]);
  const config = { ...defaultIntegrationConfig("min"), acceptNegative: true };
  const windows = get(detectPeaks(curve, baseline, config));
  assert.deepEqual(windows.map((row) => [row.left.x, row.right.x, row.polarity]), [[0, 1.5, "positive"], [1.5, 3, "negative"]]);
  const table = get(integratePeaks(curve, baseline, windows, config));
  assert.deepEqual(table.rows.map((p) => p.area), [1.5, -1.5]);
});

test("same-polarity peaks share a valley dropline without counting any area twice", () => {
  const { curve, baseline } = load([0, 3, 1, 2, 0]);
  const config = defaultIntegrationConfig("min");
  const windows = get(detectPeaks(curve, baseline, config));
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0]?.right, { x: 2, kind: "dropline" });
  assert.deepEqual(windows[1]?.left, { x: 2, kind: "dropline" });
  const peaks = get(integratePeaks(curve, baseline, windows, config));
  assert.equal(peaks.denominators.peakArea, 6);
  const reject = get(integratePeaks(curve, baseline, windows, { ...config, reject: { keepLargest: 1 } }));
  assert.equal(reject.rows.length, 1);
  assert.equal(reject.rows[0]?.area, 3.5);
  assert.equal(reject.rows[0]?.pctTotalPeakArea, 100);
});

test("a flattened apex stays a single peak", () => {
  const { curve, baseline } = load([0, 3, 3, 2, 0]);
  const config = defaultIntegrationConfig("min");
  const windows = get(detectPeaks(curve, baseline, config));
  assert.equal(windows.length, 1);
  assert.equal(get(integratePeaks(curve, baseline, windows, config)).rows[0]?.apex.x, 1);
});

test("split and adjacent join recover the original area", () => {
  const { run, curve, baseline } = load([0, 2, 0]);
  const config = defaultIntegrationConfig("min");
  const windows = get(detectPeaks(curve, baseline, config));
  const table = get(integratePeaks(curve, baseline, windows, config));
  const state: AnalysisState = {
    run, revision: 0, activeChromatogramId: curve.sourceChromatogramId, activeCurveId: curve.id,
    activePeakTableId: table.id, baselines: [baseline], peakTables: [table], windows,
  };
  const split = get(applyPeakEdit(state, { op: "split", peakId: "p1", newPeakId: "p1-right" }));
  assert.deepEqual(split.peakTables[0]?.rows.map((p) => p.area), [1, 1]);
  const joined = get(applyPeakEdit(split, { op: "join-right", peakId: "p1" }));
  assert.deepEqual(joined.peakTables[0]?.rows.map((p) => [p.id, p.area]), [["p1", 2]]);
  assert.equal(state.windows.length, 1);
});

test("a forced straight segment in a spline stays straight in calculations", () => {
  const { baseline } = load([0, 4, 4, 4, 0], {
    kind: "manual", shape: "classic-spline",
    anchors: [{ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 3, y: 0 }, { x: 4, y: 1 }], straightAfter: [0],
  });
  assert.equal(baseline.points.find((point) => point.x === 1)?.y, 1);
  assert.equal(baseline.points.find((point) => point.x === 2)?.y, 2);
  assert.equal(baseline.points.find((point) => point.x === 4)?.y, 1);
});

test("edited signal CSV can be imported with its common axis header", () => {
  const { curve } = load([0, 2, 0]);
  const csv = get(encodeCurvesCsv([curve]));
  const restored = get(parseUnicornCurves(csv, { runId: "return" }));
  assert.equal(restored.curves[0]?.label, "UV");
  assert.deepEqual([...restored.curves[0]!.x], [0, 1, 2]);
  assert.deepEqual([...restored.curves[0]!.y], [0, 2, 0]);
});

test("per-curve CSV export restores the correct grid and gaps for each channel", () => {
  const first = load([1, 0, 2]).curve;
  const second = { ...first, label: "Conductivity", signalUnit: "mS/cm", x: Float64Array.of(0.5, 1.5, 2.5),
    y: Float64Array.of(1, 0, 3), missing: Uint8Array.of(0, 1, 0) };
  const csv = get(encodeCurvesCsv([first, second]));
  const restored = get(parseUnicornCurves(csv, { runId: "return" }));
  assert.deepEqual(restored.curves.map((curve) => curve.label), ["UV", "Conductivity"]);
  assert.deepEqual([...restored.curves[1]!.x], [0.5, 1.5, 2.5]);
  assert.deepEqual([...restored.curves[1]!.missing!], [0, 1, 0]);
});

test("morphological opening removes a narrow excursion without changing signal points", () => {
  const { curve, baseline } = load([1, 1, 5, 1, 1], { kind: "morphological", structureWidth: 2, minAnchorDistance: 0 });
  assert.equal(baseline.points.find((p) => p.x === 2)?.y, 1);
  assert.equal(curve.y[2], 5);
  assert.equal(baseline.validRanges.length, 1);
});

test("classical baseline finds flat segments around a larger excursion", () => {
  const { baseline } = load([2, 2, 2, 8, 2, 2, 2], {
    kind: "classical", minSegment: 1, noiseWindow: 0.1, maxLevel: 3, maxSlope: 0.1,
  });
  assert.equal(baseline.points.find((p) => p.x === 3)?.y, 2);
});
