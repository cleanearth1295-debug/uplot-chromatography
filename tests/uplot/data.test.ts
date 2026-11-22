import { test } from "node:test";
import assert from "node:assert/strict";
import { toUPlotData } from "../../src/uplot/index.ts";
import type { Curve } from "../../src/index.ts";

const signal: Curve = {
  id: "uv", runId: "r", sourceChromatogramId: "c", label: "UV", kind: "measured",
  xUnit: "min", signalUnit: "mAU", x: Float64Array.of(0, 1, 2), y: Float64Array.of(0, 0, 2),
  missing: Uint8Array.of(0, 1, 0),
};

test("explicit gaps stay null while other channels extend the display grid", () => {
  const cond: Curve = {
    ...signal, id: "cond", signalUnit: "mS/cm", x: Float64Array.of(0.5, 1.5),
    y: Float64Array.of(1, 3), missing: undefined,
  };
  const aligned = toUPlotData({ xUnit: "min", curves: [signal, cond] });
  assert(aligned.ok);
  assert.deepEqual(aligned.value, [
    [0, 0.5, 1, 1.5, 2], [0, undefined, null, undefined, 2], [undefined, 1, undefined, 3, undefined],
  ]);
  assert.deepEqual([...signal.x], [0, 1, 2]);
});

test("a mixed axis cannot silently move chromatogram traces", () => {
  const aligned = toUPlotData({ xUnit: "mL", curves: [signal] });
  assert(!aligned.ok);
  assert.equal(aligned.errors[0]?.code, "E_AXIS_UNIT");
});
