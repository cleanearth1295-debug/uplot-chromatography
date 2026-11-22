import { test } from "node:test";
import assert from "node:assert/strict";
import { fitDoeModel, runProcedure, runProcedureBatch } from "../../src/index.ts";
import { parseProcedure, serializeProcedure, procedureStepKinds, validateProcedure } from "../../src/core/procedure.ts";
import { predictDoeModel } from "../../src/core/doe.ts";
import { cumulativeIntegrateCurve } from "../../src/core/cumulative-integration.ts";
import { parseUnicornCurves } from "../../src/io/index.ts";
import type { EvaluationProcedure, Result, Run } from "../../src/index.ts";

function get<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}
function getRun(id: string, label = "UV") {
  return get(parseUnicornCurves("Time [min]," + label + " [mAU]\n0,0\n1,2\n2,0", { runId: id }));
}
const procedure: EvaluationProcedure = {
  id: "p", revision: 1, schemaVersion: 1, name: "Integrate UV",
  steps: [
    { kind: "baseline", curve: { label: "UV" }, spec: { kind: "zero" }, output: "base" },
    { kind: "integrate", baseline: "base", output: "peaks" },
  ],
};

test("procedures use run-local curve IDs and produce reproducible results", () => {
  const run = getRun("A");
  const first = get(runProcedure(run, procedure));
  assert.equal(first.tables.get("peaks")?.rows[0]?.area, 2);
  assert.deepEqual(get(runProcedure(run, procedure)).tables, first.tables);
  assert.equal(run.curves.length, 1);
});

test("a batch reports one failed run and supports retrying it without redoing completed runs", () => {
  const a = getRun("A");
  const b = getRun("B", "Pressure");
  const c = getRun("C");
  const batch = runProcedureBatch(procedure, [a, b, c].map((run) => ({ run, revision: 0 })));
  assert.deepEqual(batch.map(({ status }) => status), ["completed", "failed", "completed"]);
  assert.equal(batch[1]?.diagnostics[0]?.index, 0);
  const finished = new Set(batch.filter((row) => row.status === "completed").map((row) => row.key));
  const retried = runProcedureBatch(procedure, [a, getRun("B"), c].map((run) => ({ run, revision: 0 })), finished);
  assert.deepEqual(retried.map(({ status }) => status), ["already-completed", "completed", "already-completed"]);
});

test("a DoE model reports coefficients, predictions and rank errors", () => {
  const responses = [0, 1, 2, 3].map((x) => ({ runId: "run-" + x, factors: { x }, response: 2 + 3 * x }));
  const result = get(fitDoeModel(responses, [{ id: "x", powers: { x: 1 } }]));
  assert(Math.abs(result.intercept - 2) < 1e-10);
  assert(Math.abs(result.coefficients.x! - 3) < 1e-10);
  assert(result.rows.every((row) => Math.abs(row.residual) < 1e-10));
  assert.equal(result.rSquared, 1);
  const invalid = fitDoeModel(responses, [{ id: "x", powers: { x: 1 } }, { id: "duplicate", powers: { x: 1 } }]);
  assert(!invalid.ok);
  assert.equal(invalid.errors[0]?.code, "E_DOE_RANK");
});

test("procedure JSON round-trips portable references and supports explicit peak detection", () => {
  const portable: EvaluationProcedure = {
    ...procedure,
    steps: [
      { kind: "smooth", curve: { label: "UV" }, options: { kind: "moving-average", windowSamples: 1 }, output: "signal" },
      { kind: "baseline", curve: { output: "signal" }, spec: { kind: "zero" }, output: "base" },
      { kind: "detect", baseline: "base", output: "found" },
      { kind: "integrate", baseline: "base", windows: "found", output: "peaks" },
      { kind: "baseline", curve: { output: "signal" }, spec: { kind: "curve", baselineCurve: { label: "UV" } }, output: "reference" },
      { kind: "ratio", left: { output: "signal" }, right: { label: "UV" }, baselineA: "base",
        options: { thresholdA: 0.1, thresholdB: 0.1 }, output: "corrected-ratio" },
    ],
  };
  const restored = get(parseProcedure(get(serializeProcedure(portable))));
  assert.deepEqual(restored, portable);
  assert.deepEqual(procedureStepKinds, ["baseline", "detect", "integrate", "combine", "ratio", "smooth", "cumulative-integrate"]);
  for (const id of ["portable-a", "portable-b"]) {
    const run = getRun(id);
    const result = get(runProcedure(run, restored));
    assert.equal(result.windows.get("found")?.length, 1);
    assert.equal(result.tables.get("peaks")?.rows[0]?.area, 2);
    assert.deepEqual(result.baselines.get("reference")?.spec, { kind: "curve", baselineCurveId: run.curves[0]?.id });
    assert.deepEqual(Array.from(result.curves.get("corrected-ratio")!.y), [1, 1, 1]);
  }
});

test("procedure validation rejects malformed nested options and incompatible step references", () => {
  const cases = [
    { steps: [{ kind: "baseline", curve: { label: "UV" }, spec: { kind: "manual", shape: "linear", anchors: [null, {}] }, output: "base" }] },
    { steps: [procedure.steps[0], { kind: "integrate", baseline: "base", config: null, output: "peaks" }] },
    { steps: [procedure.steps[0], { kind: "integrate", baseline: "base", windows: [null], output: "peaks" }] },
    { steps: [procedure.steps[0], { kind: "integrate", baseline: "base", windwos: [], output: "peaks" }] },
    { steps: [procedure.steps[0], { kind: "integrate", baseline: "base", windows: "base", output: "peaks" }] },
    { steps: [{ kind: "smooth", curve: { label: "UV" }, options: { kind: "savitzky-golay", windowSamples: 4, degree: 1 }, output: "smoothed" }] },
    { name: " " },
    { schemaVersion: 2 },
  ];
  for (const invalid of cases) {
    const bad = { ...procedure, ...invalid };
    assert.equal(validateProcedure(bad).ok, false);
    assert.equal(parseProcedure(JSON.stringify(bad)).ok, false);
  }
  const malformedJson = parseProcedure("{");
  assert(!malformedJson.ok);
  assert.equal(malformedJson.errors[0]?.code, "E_PROCEDURE_JSON");
});

test("batch revisions determine deduplication and failed work does not mark revisions complete", () => {
  const run = getRun("revised");
  const batch = runProcedureBatch(procedure, [-1, 0, 0, 1].map((revision) => ({ run, revision })));
  assert.deepEqual(batch.map(({ status }) => status), ["failed", "completed", "already-completed", "completed"]);
  assert.equal(batch[0]?.diagnostics[0]?.code, "E_BATCH_INPUT");
  assert.notEqual(batch[1]?.key, batch[3]?.key);
});

test("DoE ANOVA and deleted residuals agree with direct calculations and leave-one-out fits", () => {
  const runs = [1, 3, 2, 6].map((response, x) => ({ runId: "run-" + x, factors: { x }, response }));
  const terms = [{ id: "x", powers: { x: 1 } }];
  const fit = get(fitDoeModel(runs, terms));
  const close = (actual: number | null, expected: number) => {
    assert(actual !== null);
    assert(Math.abs(actual - expected) < 1e-9, JSON.stringify({ actual, expected }));
  };
  assert.deepEqual([fit.anova.model.degreesOfFreedom, fit.anova.residual.degreesOfFreedom, fit.anova.total.degreesOfFreedom], [1, 2, 3]);
  close(fit.anova.total.sumSquares, 14);
  close(fit.anova.model.sumSquares, 9.8);
  close(fit.anova.residual.sumSquares, 4.2);
  close(fit.anova.model.fStatistic, 14 / 3);
  close(fit.anova.model.pValue, 1 - Math.sqrt(0.7));
  let press = 0;
  for (const [index, removed] of runs.entries()) {
    const otherRuns = runs.filter((_, position) => position !== index);
    const without = get(fitDoeModel(otherRuns, terms));
    const expected = removed.response - get(predictDoeModel(without, removed.factors)).predicted;
    close(fit.rows[index]!.deletedResidual, expected);
    press += expected ** 2;
  }
  close(fit.press, press);
  close(fit.predictedRSquared, 1 - press / 14);
  const future = predictDoeModel(fit, { x: 4 });
  close(get(future).predicted, 6.5);
  assert(future.ok);
  assert.equal(future.warnings[0]?.code, "W_DOE_EXTRAPOLATION");
  assert.deepEqual(future.value.extrapolatedFactors, ["x"]);
  assert.equal(predictDoeModel(fit, {}).ok, false);
  assert.equal(fitDoeModel([{ ...runs[0]!, factors: { x: "1" } }, ...runs.slice(1)] as unknown as typeof runs, terms).ok, false);
  const saturated = get(fitDoeModel(runs.slice(0, 2), terms));
  assert.equal(saturated.press, null);
  assert.equal(saturated.anova.model.pValue, null);
});

test("cumulative integration emits a derived signed-area curve and restarts after missing samples", () => {
  const run = getRun("integral");
  const curve = {
    ...run.curves[0]!, x: Float64Array.of(0, 1, 3, 4, 6),
    y: Float64Array.of(2, 4, NaN, -3, -1), missing: Uint8Array.of(0, 0, 1, 0, 0),
  };
  const result = cumulativeIntegrateCurve(curve);
  const area = get(result);
  assert.equal(area.kind, "derived");
  assert.equal(area.signalUnit, "mAU\u00b7min");
  assert.deepEqual(area.x, curve.x);
  assert.deepEqual(Array.from(area.y), [0, 3, 0, 0, -4]);
  assert.deepEqual(area.missing, curve.missing);
  assert(result.ok);
  assert.equal(result.warnings[0]?.code, "W_CUMULATIVE_GAPS");

  const portable: EvaluationProcedure = {
    ...procedure,
    steps: [...procedure.steps, { kind: "cumulative-integrate", curve: { label: "UV" }, baseline: "base", output: "area" }],
  };
  const artifacts = get(runProcedure(run, get(parseProcedure(get(serializeProcedure(portable))))));
  assert.equal(artifacts.tables.get("peaks")?.rows[0]?.area, 2);
  assert.deepEqual(Array.from(artifacts.curves.get("area")!.y), [0, 1, 2]);
});

test("cumulative integration includes between-sample baseline knots and exposes reference-baseline coverage gaps", () => {
  const curve = { ...getRun("baseline").curves[0]!, x: Float64Array.of(0, 4), y: Float64Array.of(2, 2) };
  const baseline = {
    id: "baseline",
    curveId: curve.id,
    xUnit: curve.xUnit,
    signalUnit: curve.signalUnit,
    points: [{ x: 0, y: 0 }, { x: 0.5, y: 2 }, { x: 1, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }],
    validRanges: [[0, 1], [3, 4]] as const,
    spec: { kind: "zero" } as const,
  };
  const area = get(cumulativeIntegrateCurve(curve, { baseline }));
  assert.deepEqual(Array.from(area.x), [0, 0.5, 1, 2, 3, 4]);
  assert.deepEqual(Array.from(area.y), [0, 0.5, 1, 0, 0, 2]);
  assert.deepEqual(Array.from(area.missing!), [0, 0, 0, 1, 0, 0]);
});
