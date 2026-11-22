import assert from "node:assert/strict";
import { test } from "node:test";
import type { Result, Run } from "../../src/index.ts";
import { buildRunDocumentation, queryRunLog, updateEvaluationNote } from "../../src/core/run-documentation.ts";
import { encodePrintDocument, tableClipboardText } from "../../src/io/presentation.ts";

function value<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}

const run: Run = {
  id: "run-A", name: "Synthetic work", curves: [], chromatograms: [], fractions: [],
  timeVolume: { timeMin: Float64Array.of(0, 1, 2), volumeMl: Float64Array.of(0, 2, 5) },
  column: { bedHeightCm: 17, volumeMl: 10 }, uvPathLengthCm: 0.2,
  markers: [{ id: "injection", kind: "injection", label: "Inject", x: 1, xUnit: "min" },
    { id: "phase", kind: "phase", label: "Elution", x: 2, xUnit: "min" }],
};

test("available documentation retains real units and duplicate variable names across blocks", () => {
  const source = { columnId: "colA", variables: [
    { id: "v1", name: "Flow", value: 1, unit: "mL/min", block: "Load" },
    { id: "v2", name: "Flow", value: 2, unit: "mL/min", block: "Wash" },
  ] };
  const doc = value(buildRunDocumentation(run, source));
  assert.deepEqual(doc.sections.map((section) => section.id), ["summary", "column", "variables", "run-log"]);
  assert.deepEqual(doc.sections.find((s) => s.id === "variables")?.fields, source.variables);
  assert.equal(doc.sections.find((s) => s.id === "column")?.fields.find((field) => field.id === "column-volume")?.unit, "mL");
});

test("log filtering retains stable IDs and shows offsets at injection in measured volume", () => {
  const source = [{ id: "feedback", kind: "event" as const, feedback: "warning" as const,
    label: "Air detected", x: 1.5, xUnit: "min" as const }];
  const feedback = value(queryRunLog(run, {
    xUnit: "mL", originMarkerId: "injection", text: "AIR", feedback: ["warning"],
  }, source));
  assert.equal(feedback[0]?.id, "feedback");
  assert.equal(feedback[0]?.coordinate.x, 1.5);
  assert.equal(feedback[0]?.x, 1.5);
  assert.equal(feedback[0]?.xUnit, "min");
  assert.equal(feedback[0]?.coordinate.xUnit, "mL");
});

test("an evaluation note can be updated in place without touching the source run log", () => {
  const doc = value(buildRunDocumentation(run, { evaluationNotes: [{ id: "a", text: "Before" }] }));
  const changed = value(updateEvaluationNote(doc, { id: "a", text: "After" }));
  assert.equal(changed.evaluationNotes[0]?.text, "After");
  assert.equal(doc.evaluationNotes[0]?.text, "Before");
  assert.deepEqual(doc.log, changed.log);
});

test("clipboard and print use the same ordered table and escape text", () => {
  const table = { columns: [{ label: "Area", unit: "mAU·min" }, { label: "Note" }],
    rows: [[1.5, "A\tB"], [2, "<script>window.bad=1</script>"]] };
  const tsv = value(tableClipboardText(table, [1, 0]));
  assert.equal(tsv, 'Area [mAU·min]\tNote\n2\t<script>window.bad=1</script>\n1.5\t"A\tB"\n');
  const html = value(encodePrintDocument("Run & comparison", [
    { kind: "text", title: "First & overview", text: "A < B" },
    { kind: "table", title: "Second table", table },
  ]));
  assert(html.indexOf("First &amp; overview") < html.indexOf("Second table"));
  assert(html.includes("mAU·min"));
  assert(html.includes("&lt;script&gt;window.bad=1&lt;/script&gt;"));
  assert(!html.includes("<script>"));
  assert(!encodePrintDocument("Bad chart", [
    { kind: "image", title: "Bad", pngDataUrl: 'data:text/html,<svg onload="...">' },
  ]).ok);
  assert(!encodePrintDocument("Truncated chart", [
    { kind: "image", title: "Truncated", pngDataUrl: "data:image/png;base64,iVBORw0KGgo" },
  ]).ok);
  assert(encodePrintDocument("Valid chart", [
    { kind: "image", title: "Valid", pngDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGsQAAAAASUVORK5CYII=" },
  ]).ok);
  assert(!tableClipboardText({ ...table, rows: [null] } as never).ok);
});
