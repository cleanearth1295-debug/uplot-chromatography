import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateBaseline } from "../../src/core/baseline.ts";
import { detectPeaks } from "../../src/core/detect.ts";
import { defaultIntegrationConfig, filterVisiblePeaks, integratePeaks } from "../../src/core/integrate.ts";
import { applyPeakEdit, reintegratePeakRange } from "../../src/core/peak-edits.ts";
import type { AnalysisState, Curve, Result, Run } from "../../src/core/types.ts";

function get<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}

function setup(ys: number[], xs = ys.map((_, index) => index)) {
  const curve: Curve = {
    id: "uv", kind: "measured", runId: "run", sourceChromatogramId: "injection", label: "UV",
    xUnit: "min", signalUnit: "mAU", x: Float64Array.from(xs), y: Float64Array.from(ys),
  };
  const run: Run = { id: "run", name: "run", curves: [curve], chromatograms: [], markers: [], fractions: [] };
  const baseline = get(calculateBaseline(run, curve.id, { kind: "zero" }));
  return { run, curve, baseline, config: defaultIntegrationConfig(curve.xUnit) };
}

function near(value: number | null | undefined, expected: number, tolerance = 1e-12) {
  assert.ok(value != null && Math.abs(value - expected) <= tolerance, `${value} ≠ ${expected}`);
}

test("peak moments weight irregular intervals and support negative polarity", () => {
  const offset = 1e9;
  const { curve, baseline, config } = setup([0, -3, -0.75, 0], [offset, offset + 1, offset + 2.5, offset + 3]);
  const settings = { ...config, acceptNegative: true };
  const windows = get(detectPeaks(curve, baseline, settings));
  const row = get(integratePeaks(curve, baseline, windows, settings)).rows[0]!;
  near(row.centroid, offset + 4 / 3);
  near(row.momentStandardDeviation, Math.sqrt(7 / 18));
  near(row.sigma, Math.sqrt(0.5));
  assert.equal(row.area, -4.5);
  assert.deepEqual(row.crossings?.halfHeight, [offset + 0.5, offset + 2]);
});

test("resolution uses included neighbors while a display filter preserves denominators", () => {
  const { curve, baseline, config } = setup([0, 3, 0, 0, 1, 0, 0, 2, 0]);
  const windows = get(detectPeaks(curve, baseline, config));
  for (const [resolution, expected] of [["base-width", 1.5], ["sigma", 3 * Math.sqrt(6) / 4], ["half-height", 3 * Math.sqrt(8 * Math.log(2)) / 4]] as const) {
    const table = get(integratePeaks(curve, baseline, windows, { ...config, resolution }));
    assert.equal(table.rows[0]!.resolution, null);
    near(table.rows[2]!.resolution, expected);
    assert.equal(filterVisiblePeaks(table, (row) => row.id === "p3")[0], table.rows[2]);
    assert.equal(table.denominators.peakArea, 6);
    const rejected = get(integratePeaks(curve, baseline, windows, { ...config, resolution, reject: { minHeight: 2 } }));
    near(rejected.rows[1]!.resolution, expected * 2);
    assert.equal(rejected.denominators.peakArea, 5);
  }
});

test("sampled skim divides shoulder and parent without changing signed total area", () => {
  for (const sign of [1, -1]) {
    for (const reversed of [false, true]) {
      const signal = [0, 20, 4, 5, 2, 1, 0].map((y) => y * sign);
      const { curve, baseline, config } = setup(reversed ? signal.reverse() : signal);
      const settings = { ...config, acceptNegative: true, separation: { kind: "skim" as const, ratio: 10 } };
      const windows = get(detectPeaks(curve, baseline, settings));
      const integrated = integratePeaks(curve, baseline, windows, settings);
      const table = get(integrated);
      assert.ok(integrated.ok && integrated.warnings.some(({ code }) => code === "W_SKIM_PROVISIONAL"));
      const shoulder = table.rows[reversed ? 0 : 1]!;
      const parent = table.rows[reversed ? 1 : 0]!;
      near(shoulder.area, 2 * sign);
      near(parent.area, 30 * sign);
      near(table.denominators.peakArea, 32 * sign);
      assert.deepEqual(shoulder.integrationBounds, [2, 4]);
      assert.deepEqual(curve.y, Float64Array.from(signal));
    }
  }
});

test("skim retains droplines at the ratio threshold or without a supporting tangent", () => {
  for (const [signal, ratio] of [[[0, 20, 4, 5, 2, 1, 0], 16], [[0, 20, 4, 5, 0], 10]] as const) {
    const { curve, baseline, config } = setup([...signal]);
    const settings = { ...config, separation: { kind: "skim" as const, ratio } };
    const windows = get(detectPeaks(curve, baseline, settings));
    const rows = get(integratePeaks(curve, baseline, windows, settings)).rows;
    assert.deepEqual(rows.map((row) => row.skimLine), [undefined, undefined]);
  }
});

test("range reintegration preserves outer windows and restores a deleted peak", () => {
  const { run, curve, baseline, config } = setup([0, 3, 0, 0, 2, 0, 0, 1, 0]);
  const windows = get(detectPeaks(curve, baseline, config));
  const table = get(integratePeaks(curve, baseline, windows, config));
  const state: AnalysisState = {
    run, windows, revision: 0, activeChromatogramId: curve.sourceChromatogramId, activeCurveId: curve.id,
    activePeakTableId: table.id, baselines: [baseline], peakTables: [table],
  };
  const removed = get(applyPeakEdit(state, { op: "remove", peakId: "p2" }));
  const restored = get(reintegratePeakRange(removed, [1, 6.5], 1));
  assert.equal(restored.revision, 2);
  assert.equal(restored.windows[0], windows[0]);
  assert.equal(restored.windows[2], windows[2]);
  assert.equal(restored.peakTables[0]!.denominators.peakArea, 6);
  assert.equal(restored.peakTables[0]!.id, table.id);
  assert.equal(restored.run.curves[0], curve);
  assert.equal(reintegratePeakRange(removed, [1, 6.5], 0).ok, false);
});

test("column metrics use injection-relative retention and explicit column metadata", () => {
  const sample = setup([0, 4, 0], [3, 5, 7]);
  const curve: Curve = { ...sample.curve, xUnit: "mL" };
  const run: Run = {
    ...sample.run, curves: [curve], column: { separationMode: "SEC", volumeMl: 10, voidVolumeMl: 2, totalLiquidVolumeMl: 5, bedHeightCm: 20 },
    markers: [{ id: "injection", label: "Inject", kind: "injection", x: 1, xUnit: "mL" }],
  };
  const baseline = get(calculateBaseline(run, curve.id, { kind: "zero" }));
  const config = defaultIntegrationConfig(curve.xUnit);
  const windows = get(detectPeaks(curve, baseline, config));
  const row = get(integratePeaks(curve, baseline, windows, config, run)).rows[0]!;
  near(row.retentionFactor, -0.2);
  near(row.kav, 0.25);
  near(row.plates, 22.16);
  near(row.hetpCm, 20 / 22.16);
  near(row.platesPerM, 110.8);
  const noContext = get(integratePeaks(curve, baseline, windows, config)).rows[0]!;
  assert.equal(noContext.kav, null);
  assert.equal(noContext.plates, null);
});

test("fraction assignment maps measured axes and reports ambiguous collector overlaps", () => {
  const { run: original, curve, baseline, config } = setup([0, 2, 0], [0, 1, 4]);
  const run: Run = {
    ...original, timeVolume: { timeMin: Float64Array.of(0, 1, 4), volumeMl: Float64Array.of(0, 2, 12) },
    column: { separationMode: "SEC", volumeMl: 10, voidVolumeMl: 2, totalLiquidVolumeMl: 5 },
    fractions: [
      { id: "a", label: "A", trackId: "main", sequence: 0, xUnit: "mL", range: [0, 2] },
      { id: "b", label: "B", trackId: "main", sequence: 1, xUnit: "mL", range: [2, 8] },
      { id: "c", label: "C", trackId: "main", sequence: 2, xUnit: "mL", range: [8, 13] },
      { id: "other", label: "Other", trackId: "backup", sequence: 0, xUnit: "min", range: [0.5, 1.5] },
    ],
  };
  const windows = get(detectPeaks(curve, baseline, config));
  const all = get(integratePeaks(curve, baseline, windows, config, run)).rows[0]!;
  assert.deepEqual(all.fractionIds, { start: "a", apex: null, end: "c" });
  const selected = get(integratePeaks(curve, baseline, windows, { ...config, fractionTrackId: "main" }, run)).rows[0]!;
  assert.deepEqual(selected.fractionIds, { start: "a", apex: "b", end: "c" });
  assert.equal(selected.kav, null);
  assert.equal(selected.retentionFactor, null);
  near(selected.plates, 5.54 / 4);
  assert.equal(selected.hetpCm, null);
});
