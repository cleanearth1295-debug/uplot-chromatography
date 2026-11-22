import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { decodeWorkbookTable, encodeWorkbookTable } from "../../src/io/workbook.ts";
import type { Result } from "../../src/core/types.ts";
import type { DataTable } from "../../src/io/formats/table.ts";
import type { WorkbookEngine } from "../../src/io/workbook.ts";

const schema: DataTable["columns"] = [
  { id: "name", label: "Peak name", type: "string", nullable: true },
  { id: "area", label: "Area [mAU min]", type: "number", nullable: true },
  { id: "accepted", label: "Accepted", type: "boolean", nullable: true },
];
const table: DataTable = {
  kind: "peaks",
  columns: schema,
  rows: [["=SUM(1,2)", 1.625, true], ["", null, false], [null, null, null]],
};
const mapping = {
  sheetName: "Peak results", kind: "peaks",
  columns: schema.map((column, sourceColumn) => ({ ...column, sourceColumn })),
};

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}

function errorCode(result: Result<unknown>): string | undefined {
  if (result.ok) assert.fail("Expected an error");
  return result.errors[0]?.code;
}

const enginePath = process.env.UPLOT_SHEETJS_MODULE;
const engine: WorkbookEngine | undefined = enginePath ? (await import(pathToFileURL(enginePath).href)).default : undefined;

test("workbook boundaries validate byte signatures, schemas, selected worksheet names and cell types", () => {
  const unavailable = {} as WorkbookEngine;
  assert.equal(errorCode(decodeWorkbookTable(new Uint8Array([1, 2, 3]), unavailable, mapping)), "E_WORKBOOK_FORMAT");
  assert.equal(errorCode(encodeWorkbookTable({ ...table, rows: [["old", Infinity, true]] }, unavailable)), "E_WORKBOOK_CELL");
  assert.equal(errorCode(encodeWorkbookTable(table, unavailable, { sheetName: "invalid/name" })), "E_WORKBOOK_OPTIONS");
  assert.equal(errorCode(encodeWorkbookTable(table, unavailable)), "E_WORKBOOK_WRITE");
  const xlsxPrefix = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  assert.equal(errorCode(decodeWorkbookTable(xlsxPrefix, unavailable, {
    ...mapping, columns: mapping.columns.map((column) => ({ ...column, sourceColumn: 0 })),
  })), "E_WORKBOOK_SCHEMA");
});

function roundTripWorkbook(format: "xls" | "xlsx", workbookEngine: WorkbookEngine) {
  const bytes = unwrap<Uint8Array>(encodeWorkbookTable(table, workbookEngine, { format, sheetName: mapping.sheetName }));
  const encoded = workbookEngine.read(bytes, { type: "array", cellFormula: true, cellDates: true, bookVBA: false, dense: false });
  const sheet = encoded.Sheets[mapping.sheetName]!;
  assert.equal((sheet.A2 as { t: string }).t, "s");
  assert.equal((sheet.A2 as { f?: string }).f, undefined);
  assert.deepEqual(unwrap<DataTable>(decodeWorkbookTable(bytes, workbookEngine, mapping)), table);
  assert.equal(errorCode(decodeWorkbookTable(bytes, workbookEngine, { ...mapping, sheetName: "Unknown" })), "E_WORKBOOK_SHEET");
  const reordered = unwrap<DataTable>(decodeWorkbookTable(bytes, workbookEngine, {
    ...mapping, columns: [mapping.columns[2]!, mapping.columns[0]!],
  }));
  assert.deepEqual(reordered.rows, [[true, "=SUM(1,2)"], [false, ""], [null, null]]);
  assert.equal(errorCode(decodeWorkbookTable(bytes, workbookEngine, {
    ...mapping, columns: [{ ...mapping.columns[0]!, label: "different header" }],
  })), "E_WORKBOOK_HEADER");
}

test("SheetJS writes and reads typed XLS workbook cells", { skip: !engine }, () => roundTripWorkbook("xls", engine!));
test("SheetJS writes and reads typed XLSX workbook cells", { skip: !engine }, () => roundTripWorkbook("xlsx", engine!));

test("SheetJS rejects external mapped formula cells even when cached values are present", { skip: !engine }, () => {
  const workbook = engine!.utils.book_new();
  const worksheet = engine!.utils.aoa_to_sheet([["Ignored note"], ["", "Area [mAU min]"], ["discard", 3]], { sheetStubs: true });
  worksheet.B3 = { t: "n", v: 3, f: "1+2" };
  engine!.utils.book_append_sheet(workbook, worksheet, "Selected");
  const bytes = new Uint8Array(engine!.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  assert.equal(errorCode(decodeWorkbookTable(bytes, engine!, {
    sheetName: "Selected", kind: "peaks", headerRow: 1, columns: [{ ...schema[1]!, sourceColumn: 1 }],
  })), "E_WORKBOOK_FORMULA");
});
