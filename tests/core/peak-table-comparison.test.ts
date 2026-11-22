import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateBaseline, comparePeakTables, defaultIntegrationConfig, integratePeaks } from "../../src/index.ts";
import type { PeakTable, Result } from "../../src/index.ts";
import { parseUnicornCurves } from "../../src/io/index.ts";

const get = <T>(r: Result<T>): T => {
  if (!r.ok) assert.fail(JSON.stringify(r.errors));
  return r.value;
};
function table(unit: "min" | "mL", amplitude: number): PeakTable {
  const run = get(parseUnicornCurves("X [" + unit + "],UV [mAU]\n0,0\n1," + amplitude + "\n2,0", { runId: String(amplitude) }));
  const curve = run.curves[0]!;
  const baseline = get(calculateBaseline(run, curve.id, { kind: "zero" }));
  return get(integratePeaks(curve, baseline, [
    { id: "p", name: "Peak", left: { x: 0, kind: "manual" }, right: { x: 2, kind: "manual" }, polarity: "positive" },
  ], defaultIntegrationConfig(unit)));
}
test("mixed-axis and unevaluated runs are diagnosed without discarding the compatible run", () => {
  const result = comparePeakTables(table("min", 2), [
    { id: "volume", table: table("mL", 10) },
    { id: "ready", table: table("min", 7) },
    { id: "raw" },
  ], [{ kind: "name" }]);
  assert(result.ok);
  assert.deepEqual(result.value.map((match) => [match.tableId, match.peak?.area]), [["ready", 7]]);
  assert.deepEqual(result.warnings.map(({ code }) => code), ["W_COMPARISON_AXIS", "W_COMPARISON_UNINTEGRATED"]);
});
