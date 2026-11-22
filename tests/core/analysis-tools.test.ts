import assert from "node:assert/strict";
import { test } from "node:test";
import {
  combineCurves, fractionHistogram, matchPeaks, measureCurve, measureInterval, poolFractions,
  ratioCurves, slopeAt, smoothCurve, summarizeMatches, evaluateColumnPerformance,
} from "../../src/index.ts";
import { parseUnicornCurves } from "../../src/io/index.ts";
import type { Curve, Fraction, PeakRow, Result } from "../../src/index.ts";

function from<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}
function signal(xs: number[], ys: number[], volume = false) {
  const text = "X [" + (volume ? "mL" : "min") + "],UV [mAU]\n" + xs.map((x, i) => x + "," + ys[i]).join("\n");
  return from(parseUnicornCurves(text, { runId: "run" })).curves[0]!;
}

test("the weighted interval mean differs from the sample average on irregular X", () => {
  const curve = signal([0, 1, 4], [0, 6, 0]);
  assert.equal(from(measureCurve(curve, 2)).y, 4);
  const interval = from(measureInterval(curve, [0, 4]));
  assert.equal(interval.integral, 12);
  assert.equal(interval.weightedMean, 3);
  assert.equal(interval.sampleMean, 2);
  assert.equal(interval.max, 6);
});

test("curve combinations evaluate only where both signals overlap", () => {
  const a = signal([0, 1, 2], [10, 10, 10]);
  const b = { ...signal([1, 1.5, 3], [2, 0.01, 2]), id: "b" };
  const difference = from(combineCurves(a, b, { op: "subtract" }));
  assert.deepEqual([...difference.x], [1, 1.5, 2]);
  assert.equal(difference.y[0], 8);
  const ratio = from(ratioCurves(a, b, { thresholdA: 0.1, thresholdB: 0.1 }));
  assert.equal(ratio.y[0], 5);
  assert.equal(ratio.y[1], 1);
});

test("median removes a spike, AR starts from the first sample and slope uses physical X", () => {
  const spike = signal([0, 1, 2], [1, 99, 1]);
  assert.deepEqual([...from(smoothCurve(spike, { kind: "median", windowSamples: 3 })).y], [1, 1, 1]);
  assert.equal(from(smoothCurve(spike, { kind: "moving-average", windowSamples: 3 })).y[1], 101 / 3);
  const series = signal([0, 1, 2], [0, 2, 4]);
  assert.deepEqual([...from(smoothCurve(series, { kind: "autoregressive", strength: 1 })).y], [0, 1, 2.5]);
  assert.equal(from(slopeAt(signal([0, 1, 4], [1, 3, 9]), 2)), 2);
});

test("fraction pooling uses contiguous ranges and amount uses each extinction coefficient", () => {
  const fractions: Fraction[] = [1, 2, 3, 4].map((sequence) => ({
    id: String(sequence), label: String(sequence), trackId: "collector", sequence,
    xUnit: "mL", range: [(sequence - 1) * 2, sequence * 2],
  }));
  assert.deepEqual(from(poolFractions(fractions, ["4", "1", "2"])).map((pool) => pool.fractionIds), [["1", "2"], ["4"]]);
  const curve = signal([0, 2, 4, 8], [20, 20, 20, 20], true);
  const hist = from(fractionHistogram(curve, fractions.slice(0, 2), { pathLengthCm: 1, extinctionByFraction: { "1": 1, "2": 2 } }));
  assert.deepEqual(hist.map((row) => [row.meanAbsorbanceMAU, row.concentrationMgMl, row.amountMg]), [[20, 0.02, 0.04], [20, 0.01, 0.02]]);
});

test("duplicate peak names need an explicit match and sample statistics exclude missing rows", () => {
  const peak = (id: string, area: number) => ({ id, name: "Target", area, height: 3, apex: { x: 1, y: 3 } });
  const matches = from(matchPeaks([peak("p", 10)], [
    { id: "one", peaks: [peak("a", 10)] }, { id: "two", peaks: [peak("b", 14), peak("c", 21)] },
    { id: "missing", peaks: [] },
  ], [{ kind: "name" }]));
  assert.deepEqual(matches.map((entry) => entry.status), ["matched", "ambiguous", "missing"]);
  assert.equal(from(summarizeMatches(matches))[0]?.n, 1);
  const override = from(matchPeaks([peak("p", 10)], [
    { id: "one", peaks: [peak("a", 10)] }, { id: "two", peaks: [peak("b", 14), peak("c", 21)] },
  ], [{ kind: "name" }], [{ referenceId: "p", tableId: "two", peakId: "b" }]));
  const stat = from(summarizeMatches(override))[0]!;
  assert.equal(stat.mean, 12);
  assert.equal(stat.sd, Math.sqrt(8));
  assert(Math.abs(stat.cvPercent! - 23.570226) < 0.00001);
});

test("column performance uses retention relative to injection and measured bed height", () => {
  const metrics = from(evaluateColumnPerformance({ apex: { x: 12, y: 2 }, halfHeightWidth: 1, asymmetry: 2 },
    { bedHeightCm: 20 }, { injectionX: 2 }));
  assert(Math.abs(metrics.plates - 554) < 1e-10);
  assert(Math.abs(metrics.hetpCm - 0.0361011) < 1e-7);
  assert(Math.abs(metrics.platesPerM - 2770) < 1e-9);
  assert.equal(metrics.asymmetry, 2);
});

test("Savitzky-Golay differentiates an irregularly sampled quadratic", () => {
  const input = signal([0, 1, 3, 4, 6], [0, 1, 9, 16, 36]);
  const derivative = from(smoothCurve(input, { kind: "savitzky-golay", windowSamples: 5, degree: 2, derivative: 2 }));
  assert.equal(derivative.signalUnit, "mAU/min^2");
  for (const y of derivative.y) assert(Math.abs(y - 2) < 1e-10);
});
