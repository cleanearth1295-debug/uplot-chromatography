import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateBaseline, defaultIntegrationConfig, detectPeaks, integratePeaks } from "../../src/index.ts";
import { samplePeakFill } from "../../src/core/display-geometry.ts";
import type { Result } from "../../src/index.ts";
import { parseUnicornCurves } from "../../src/io/index.ts";

function value<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}
test("shading represents the same area the skimming calculation assigns each peak", () => {
  const run = value(parseUnicornCurves("Time [min],UV [mAU]\n0,0\n1,20\n2,4\n3,5\n4,2\n5,1\n6,0", { runId: "skim" }));
  const curve = run.curves[0]!;
  const baseline = value(calculateBaseline(run, curve.id, { kind: "zero" }));
  const config = { ...defaultIntegrationConfig("min"), separation: { kind: "skim" as const, ratio: 10 } };
  const table = value(integratePeaks(curve, baseline, value(detectPeaks(curve, baseline, config)), config));
  assert.deepEqual(table.rows.map((row) => row.area), [30, 2]);
  const areas = table.rows.map((row) => {
    const samples = samplePeakFill(curve, baseline, row, [0, 6]);
    return samples.slice(1).reduce((total, next, i) => {
      const prev = samples[i]!;
      return total + (next.x - prev.x) * ((next.top - next.bottom) + (prev.top - prev.bottom)) / 2;
    }, 0);
  });
  assert.deepEqual(areas, table.rows.map((row) => row.area));
  const child = samplePeakFill(curve, baseline, table.rows[1]!, [2.5, 3.5]);
  assert.equal(child[0]?.x, 2.5);
  assert.equal(child.at(-1)?.x, 3.5);
});
