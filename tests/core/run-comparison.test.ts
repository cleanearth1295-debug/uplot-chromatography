import assert from "node:assert/strict";
import test from "node:test";
import type { Result, Run } from "../../src/core/types.ts";
import { buildComparisonView, deriveShiftedCurve, synchronizeComparisonCursor } from "../../src/core/run-comparison.ts";
import { calculateBaseline } from "../../src/core/baseline.ts";
import { defaultIntegrationConfig, integratePeaks } from "../../src/core/integrate.ts";
import { parseUnicornCurves } from "../../src/io/curves.ts";

function get<T>(result: Result<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

function run(id: string, unit: "min" | "mL" | "CV" = "min"): Run {
  return get(parseUnicornCurves(`X [${unit}],UV [mAU]\n0,1\n1,3\n2,2\n3,\n4,1\n`, { runId: id }));
}

function source(id: string, run: Run) {
  return { id, run, curveId: run.curves[0]!.id };
}

test("tiled view aligns each time curve using its own measured map", () => {
  const timeRun: Run = {
    ...run("timed"), timeVolume: { timeMin: Float64Array.of(0, 0.5, 4), volumeMl: Float64Array.of(0, 2, 7) },
  };
  const volumeRun = run("volume", "mL");
  const view = get(buildComparisonView([source("timed", timeRun), source("volume", volumeRun)], { xUnit: "mL", layout: "tiled" }));
  assert.notEqual(view.series[0]?.pane, view.series[1]?.pane);
  assert.equal(view.series[0]?.runId, "timed");
  assert.equal(view.series[0]?.sourceCurveId, timeRun.curves[0]?.id);
  assert.equal(view.series[0]?.curve.x[1], 2);
  const cursor = get(synchronizeComparisonCursor(view, 2));
  assert.deepEqual(cursor.map(({ seriesId, signal }) => [seriesId, signal]), [["timed", 2], ["volume", 2]]);
  assert.equal(get(synchronizeComparisonCursor(view, 5))[0]?.signal, null);
  assert.deepEqual([...timeRun.curves[0]!.x], [0, 1, 2, 3, 4]);
});

test("unconvertible tiles retain separate axes and disable the common cursor", () => {
  const sources = [source("time", run("timed")), source("volume", run("volume", "mL"))];
  const result = buildComparisonView(sources, { xUnit: "mL", layout: "tiled" });
  const view = get(result);
  assert.equal(view.cursorSynchronized, false);
  assert.deepEqual(view.series.map(({ curve }) => curve.xUnit), ["min", "mL"]);
  assert.equal(result.ok && result.warnings[0]?.code, "W_COMPARISON_INDEPENDENT_AXIS");
  assert.equal(synchronizeComparisonCursor(view, 2).ok, false);
  assert.equal(buildComparisonView(sources, { xUnit: "mL", layout: "overlay" }).ok, false);
  const tabs = get(buildComparisonView(sources, { xUnit: "mL", layout: "tabs", activeSeriesId: "volume" }));
  assert.deepEqual(tabs.series.map(({ visible }) => visible), [false, true]);
  assert.deepEqual(get(synchronizeComparisonCursor(tabs, 2)).map(({ seriesId }) => seriesId), ["volume"]);
});

test("mirror and shift use cloned arrays and preserve raw sign and missing samples", () => {
  const original = run("same");
  const first = original.curves[0]!;
  const baseline = get(calculateBaseline(original, first.id, { kind: "zero" }));
  const integrate = () => get(integratePeaks(first, baseline, [{
    id: "peak", left: { x: 0, kind: "manual" }, right: { x: 2, kind: "manual" }, polarity: "positive",
  }], defaultIntegrationConfig("min"))).rows[0]?.area;
  const area = integrate();
  const sources = [source("top", original), { ...source("bottom", original), label: "Mirror", xOffset: 1, yOffset: 2 }];
  assert.equal(buildComparisonView(sources.slice(0, 1), { xUnit: "min", layout: "mirror" }).ok, false);
  const view = get(buildComparisonView(sources, { xUnit: "min", layout: "mirror" }));
  assert.equal(view.series[1]?.label, "Mirror");
  assert.equal(view.series[1]?.curve.y[1], -1);
  const cursor = get(synchronizeComparisonCursor(view, 2))[1]!;
  assert.equal(cursor.unshiftedX, 1);
  assert.equal(cursor.displaySignal, -1);
  assert.equal(cursor.signal, 3);
  view.series[0]!.curve.y[1] = 90;
  assert.equal(first.y[1], 3);
  assert.equal(area, 4.5);
  assert.equal(integrate(), area);
  const shifted = get(deriveShiftedCurve(original, first.id, { id: "shifted", shiftX: -1, shiftY: -2 }));
  assert.deepEqual([...shifted.x], [-1, 0, 1, 2, 3]);
  assert.deepEqual([...shifted.y], [-1, 1, 0, 0, -1]);
  assert.deepEqual(shifted.missing, first.missing);
  assert.equal(shifted.kind, "derived");
  assert.deepEqual(shifted.sourceCurveIds, [first.id]);
  assert.equal(deriveShiftedCurve(original, first.id, { id: first.id }).ok, false);
});

test("stack offsets are display-only and Classic fixed Y disables the offset", () => {
  const inputs = [source("a", run("a")), source("b", run("b"))];
  const stack = get(buildComparisonView(inputs, { xUnit: "min", layout: "stack" }));
  assert.ok(stack.series[1]!.curve.y[0]! > stack.series[0]!.curve.y[1]!);
  assert.equal(inputs[1]!.run.curves[0]!.y[0], 1);
  const classic = { xUnit: "min", layout: "stack", mode: "classic", fixedY: [0, 4] } as const;
  const result = buildComparisonView(inputs, classic);
  assert.equal(get(result).series[1]?.yOffset, 0);
  assert.equal(result.ok && result.warnings[0]?.code, "W_COMPARISON_STACK_Y");
  const offset = buildComparisonView([inputs[0]!, { ...inputs[1]!, yOffset: 2 }], classic);
  assert.equal(!offset.ok && offset.errors[0]?.code, "E_COMPARISON_STACK_Y");
});

test("Classic imported CV guard allows measured time and volume recovery", () => {
  const base = run("imported");
  const imported: Run = {
    ...base, chromatograms: base.chromatograms.map((chart) => ({ ...chart, origin: "imported" })),
    column: { volumeMl: 2 }, timeVolume: { timeMin: Float64Array.of(0, 4), volumeMl: Float64Array.of(0, 8) },
  };
  const sources = [source("imported", imported)];
  const classic = { layout: "overlay", mode: "classic" } as const;
  const denied = buildComparisonView(sources, { ...classic, xUnit: "CV" });
  assert.equal(!denied.ok && denied.errors[0]?.code, "E_COMPARISON_IMPORTED_CV");
  assert.deepEqual([...get(buildComparisonView(sources, { ...classic, xUnit: "mL" })).series[0]!.curve.x], [0, 2, 4, 6, 8]);
  assert.deepEqual([...get(buildComparisonView(sources, { ...classic, xUnit: "min" })).series[0]!.curve.x], [0, 1, 2, 3, 4]);
  assert.deepEqual([...get(buildComparisonView(sources, { layout: "overlay", xUnit: "CV" })).series[0]!.curve.x], [0, 1, 2, 3, 4]);
});
