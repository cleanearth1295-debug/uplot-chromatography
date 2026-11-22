import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateBaseline, captureMarkerSnapshot, defaultIntegrationConfig, integratePeaks,
  measureInterval, resolveCurveAxis,
} from "../../src/index.ts";
import type { PeakWindow, Result, Run } from "../../src/index.ts";
import { parseUnicornCurves } from "../../src/io/index.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
};
const fromCSV = (csv: string) => value(parseUnicornCurves(csv, { runId: "regression" }));

test("R02 keeps calculated percentages when view axis changes and recalculates only on a new integration", () => {
  const original = fromCSV("Time [min],UV [mAU]\n0,0\n1,2\n2,0\n3,2\n4,0");
  const run: Run = { ...original, timeVolume: { timeMin: Float64Array.of(0, 1, 2, 3, 4), volumeMl: Float64Array.of(0, 1, 2, 4, 6) } };
  const makeWindows = (mid: number, end: number): PeakWindow[] => [[0, mid], [mid, end]].map(([a, b], index) => ({
    id: "p" + index, left: { x: a!, kind: "manual" }, right: { x: b!, kind: "manual" }, polarity: "positive",
  }));
  const curve = run.curves[0]!;
  const base = value(calculateBaseline(run, curve.id, { kind: "zero" }));
  const table = value(integratePeaks(curve, base, makeWindows(2, 4), defaultIntegrationConfig("min")));
  const displayCurve = value(resolveCurveAxis(run, curve.id, "mL"));
  assert.equal(table.xUnit, "min");
  assert.deepEqual(table.rows.map((row) => [row.area, row.pctTotalPeakArea]), [[2, 50], [2, 50]]);
  const volumeBase = value(calculateBaseline({ ...run, curves: [displayCurve] }, curve.id, { kind: "zero" }));
  const onVolume = value(integratePeaks(displayCurve, volumeBase, makeWindows(2, 6), defaultIntegrationConfig("mL")));
  assert.deepEqual(onVolume.rows.map((row) => row.area), [2, 4]);
  assert(Math.abs(onVolume.rows[0]!.pctTotalPeakArea! - 100 / 3) < 1e-10);
  assert(Math.abs(onVolume.rows[1]!.pctTotalPeakArea! - 200 / 3) < 1e-10);
});

test("R03 uses a requested physical basis for a multi-channel snapshot and allows either marker order", () => {
  const run: Run = { ...fromCSV("Time [min],UV [mAU]\n0,0\n1,6\n4,0"),
    timeVolume: { timeMin: Float64Array.of(0, 1, 4), volumeMl: Float64Array.of(0, 2, 8) } };
  const uv = run.curves[0]!;
  const mL = { ...value(resolveCurveAxis(run, uv.id, "mL")), id: "conductivity", label: "Conductivity",
    signalUnit: "mS/cm", y: Float64Array.of(3, 7, 11) };
  const readings = captureMarkerSnapshot([uv, mL], 1, { run, xUnit: "min" });
  assert.deepEqual(readings.map(({ result }) => value(result).y), [6, 7]);
  assert.deepEqual(readings.map(({ signalUnit }) => signalUnit), ["mAU", "mS/cm"]);
  const forward = value(measureInterval(uv, [0, 4]));
  const reversed = value(measureInterval(uv, [4, 0]));
  assert.equal(reversed.start.x, 4);
  assert.equal(reversed.end.x, 0);
  assert.equal(reversed.integral, -forward.integral);
  assert.deepEqual([reversed.min, reversed.max, reversed.sampleMean, reversed.weightedMean], [0, 6, 2, 3]);
});
