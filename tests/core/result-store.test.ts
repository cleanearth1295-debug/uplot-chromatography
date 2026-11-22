import { test } from "node:test";
import assert from "node:assert/strict";
import { createResultStore } from "../../src/io/index.ts";
import { parseUnicornCurves } from "../../src/io/index.ts";
import type { Result } from "../../src/index.ts";

function get<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}
function fixture() {
  const run = get(parseUnicornCurves("Time [min],UV [mAU]\n0,0\n1,2\n2,0", { runId: "original", runName: "January test" }));
  return {
    run, revision: 0, activeCurveId: run.curves[0]!.id, activeChromatogramId: run.chromatograms[0]!.id,
    windows: [], baselines: [], peakTables: [],
  };
}

test("the store detects stale writes and does not expose its original samples by reference", () => {
  const store = createResultStore();
  const source = fixture();
  get(store.add(source, { folder: "/runs/January", batchId: "B01" }));
  const loaded = get(store.open("original")).state;
  loaded.run.curves[0]!.y[1] = 99;
  const committed = get(store.save({ ...source, revision: 1 }, 0));
  assert.equal(committed.revision, 1);
  assert.equal(get(store.open("original")).state.run.curves[0]?.y[1], 2);
  const conflict = store.save({ ...source, revision: 1 }, 0);
  assert(!conflict.ok);
  assert.equal(conflict.errors[0]?.code, "E_RESULT_CONFLICT");
});

test("a copied result keeps data and remaps its local curve and chromatogram references", () => {
  const store = createResultStore();
  const source = fixture();
  get(store.add(source, { folder: "/runs/January", batchId: "B01", sampleId: "01", readOnly: true }));
  const copy = get(store.saveAs(source, { id: "copy", name: "February copy", folder: "/runs/February" }));
  assert.equal(copy.run.id, "copy");
  assert.notEqual(copy.activeCurveId, source.activeCurveId);
  assert.equal(copy.run.chromatograms[0]?.curveRefs[0]?.curveId, copy.activeCurveId);
  assert.equal(copy.run.curves[0]?.y[1], 2);
  assert.equal(store.search({ query: "*copy", folder: "/runs", descendants: true })[0]?.id, "copy");
  assert.equal(store.search({ batchId: "B01", sampleId: "01" })[0]?.id, "original");
  assert.equal(store.save(source, 0).ok, false);
});
