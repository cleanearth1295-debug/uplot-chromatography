import { test } from "node:test";
import assert from "node:assert/strict";
import { createLayoutStore, decodeLayout, encodeLayout } from "../../src/core/layout.ts";

test("default and personal views preserve chart identity and annotation ownership", () => {
  const store = createLayoutStore();
  const base = { mode: "tile" as const, activeChartId: "chart-B", panels: [
    { chartId: "chart-A", xUnit: "min" as const, annotations: [{ id: "note", x: 1, text: "A" }] },
    { chartId: "chart-B", xUnit: "mL" as const, annotations: [{ id: "note", x: 2, text: "B" }] },
  ] };
  const saved = store.save("shared", "main", base);
  assert(saved.ok);
  assert(store.setDefault("main").ok);
  assert(store.save("personal", "main", { ...base, activeChartId: "chart-A" }, "a-user").ok);
  assert.equal(store.restore(undefined, "a-user")?.activeChartId, "chart-A");
  assert.equal(store.restore(undefined, "another-user")?.activeChartId, "chart-B");

  const encoded = encodeLayout(base);
  assert(encoded.ok);
  const decoded = decodeLayout(encoded.value);
  assert(decoded.ok);
  assert.deepEqual(decoded.value.panels.map((panel) => panel.annotations?.[0]?.text), ["A", "B"]);
});
test("invalid layout positions and nonexistent defaults return diagnostics", () => {
  assert(!decodeLayout('{"schemaVersion":1,"layout":{"mode":"tile","activeChartId":"x","panels":[]}}').ok);
  assert(!decodeLayout('{"schemaVersion":1,"layout":{"mode":"tabs","activeChartId":"a","panels":[{"chartId":"a","xUnit":["min"]}]}}').ok);
  const store = createLayoutStore();
  assert(!store.setDefault("missing").ok);
  assert(!store.save("personal", "main", { mode: "tabs", activeChartId: "a", panels: [
    { chartId: "a", xUnit: "mL", xRange: [2, 1] },
  ] }).ok);
});
