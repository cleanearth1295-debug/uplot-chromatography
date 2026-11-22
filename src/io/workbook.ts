import { failure, okay } from "../core/result.ts";
import type { Result } from "../core/types.ts";
import type { TableCell } from "./formats/delimited.ts";
import type { DataColumn, DataTable } from "./formats/table.ts";

export type WorkbookFormat = "xls" | "xlsx";

export interface WorkbookTableWriteOptions {
  format?: WorkbookFormat;
  sheetName?: string;
}

export interface WorkbookColumnMapping extends DataColumn {
  /** Zero-based worksheet column. */
  sourceColumn: number;
}

export interface WorkbookTableReadOptions {
  sheetName: string;
  kind: string;
  columns: readonly WorkbookColumnMapping[];
  /** Zero-based worksheet row containing the mapped headings. */
  headerRow?: number;
}

type WorkbookCellPosition = { r: number; c: number };
type WorkbookRange = { s: WorkbookCellPosition; e: WorkbookCellPosition };
type WorkbookSheet = Record<string, unknown>;
type Workbook = { SheetNames: string[]; Sheets: Record<string, WorkbookSheet> };

/** The subset of the SheetJS namespace used by the workbook adapter. */
export interface WorkbookEngine {
  read(data: Uint8Array, options: {
    type: "array"; cellFormula: true; cellDates: true; bookVBA: false; dense: false;
  }): Workbook;
  write(book: Workbook, options: { type: "array"; bookType: "biff8" | "xlsx" }): unknown;
  utils: {
    aoa_to_sheet(rows: TableCell[][], options: { sheetStubs: true }): WorkbookSheet;
    book_new(): Workbook;
    book_append_sheet(book: Workbook, sheet: WorkbookSheet, name: string): unknown;
    encode_cell(position: WorkbookCellPosition): string;
    decode_range(reference: string): WorkbookRange;
  };
}

const rowLimit = { xls: 65_536, xlsx: 1_048_576 };
const columnLimit = { xls: 256, xlsx: 16_384 };
const textLimit = 32_767;
const signatures = {
  xls: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  xlsx: [0x50, 0x4b, 0x03, 0x04],
} as const;

function workbookFormat(bytes: Uint8Array): WorkbookFormat | undefined {
  if (!(bytes instanceof Uint8Array)) return undefined;
  if (signatures.xls.every((byte, index) => bytes[index] === byte)) return "xls";
  return signatures.xlsx.every((byte, index) => bytes[index] === byte) ? "xlsx" : undefined;
}

function validSheetName(name: unknown): name is string {
  return typeof name === "string" && !!name.trim() && name.length <= 31 && !/[:\\/?*\[\]\x00-\x1f]/.test(name) &&
    !name.startsWith("'") && !name.endsWith("'") && name !== "__proto__";
}

function validSchema(kind: unknown, columns: unknown): columns is readonly DataColumn[] {
  return typeof kind === "string" && !!kind.trim() && Array.isArray(columns) && columns.length > 0 &&
    Array.from(columns).every((column) => column && typeof column.id === "string" && !!column.id.trim() &&
      typeof column.label === "string" && column.label.length <= textLimit &&
      (column.type === "string" || column.type === "number" || column.type === "boolean") &&
      (column.nullable === undefined || typeof column.nullable === "boolean")) &&
    new Set(columns.map((column) => column.id)).size === columns.length;
}

function validCell(cell: unknown, column: DataColumn): cell is TableCell {
  if (cell === null) return column.nullable === true;
  if (typeof cell !== column.type) return false;
  return typeof cell === "number" ? Number.isFinite(cell) : typeof cell !== "string" || cell.length <= textLimit;
}

export function encodeWorkbookTable(
  table: DataTable, engine: WorkbookEngine, options: WorkbookTableWriteOptions = {},
): Result<Uint8Array> {
  const { format = "xlsx", sheetName = "Results" } = options ?? {};
  if ((format !== "xls" && format !== "xlsx") || !validSheetName(sheetName)) {
    return failure("E_WORKBOOK_OPTIONS", "Choose a supported format and a valid worksheet name.");
  }
  if (!table || !validSchema(table.kind, table.columns) || !Array.isArray(table.rows)) {
    return failure("E_WORKBOOK_SCHEMA", "A table requires a kind and unique, typed columns.");
  }
  if (table.rows.length + 1 > rowLimit[format] || table.columns.length > columnLimit[format]) {
    return failure("E_WORKBOOK_SIZE", "The table exceeds the selected workbook format's row or column limit.");
  }
  const cells: TableCell[][] = [table.columns.map(({ label }) => label)];
  for (const [index, row] of table.rows.entries()) {
    if (!Array.isArray(row) || row.length !== table.columns.length ||
      !table.columns.every((column, i) => validCell(row[i], column))) {
      return failure("E_WORKBOOK_CELL", "The row does not match the workbook column schema.", { row: index + 2 });
    }
    cells.push([...row]);
  }
  try {
    const book = engine.utils.book_new();
    // AOA strings are stored as literal string cells, including formula-like text.
    const sheet = engine.utils.aoa_to_sheet(cells, { sheetStubs: true });
    engine.utils.book_append_sheet(book, sheet, sheetName);
    const output = engine.write(book, { bookType: format === "xls" ? "biff8" : "xlsx", type: "array" });
    const bytes = output instanceof ArrayBuffer ? new Uint8Array(output) : output instanceof Uint8Array ? output : undefined;
    if (!bytes || workbookFormat(bytes) !== format) return failure("E_WORKBOOK_WRITE", "The engine did not return bytes in the selected workbook format.");
    return okay(bytes);
  } catch {
    return failure("E_WORKBOOK_WRITE", "The workbook engine could not write the table.");
  }
}

function readCell(sheet: WorkbookSheet, engine: WorkbookEngine, r: number, c: number): Result<TableCell> {
  const coordinate = engine.utils.encode_cell({ r, c });
  const value = Object.hasOwn(sheet, coordinate) ? sheet[coordinate] : undefined;
  if (value === undefined) return okay(null);
  if (typeof value !== "object" || value === null) {
    return failure("E_WORKBOOK_CELL", "The worksheet contains an unsupported cell.", { row: r + 1, index: c });
  }
  const cell = value as { t?: unknown; v?: unknown; f?: unknown; F?: unknown };
  if (cell.f !== undefined || cell.F !== undefined) {
    return failure("E_WORKBOOK_FORMULA", "Mapped worksheet cells must contain literal values.", { row: r + 1, index: c });
  }
  if (cell.t === "z") return okay(null);
  if ((cell.t === "n" && typeof cell.v === "number" && Number.isFinite(cell.v)) ||
    (cell.t === "b" && typeof cell.v === "boolean") ||
    ((cell.t === "s" || cell.t === "str") && typeof cell.v === "string")) {
    return okay(cell.v);
  }
  return failure("E_WORKBOOK_CELL", "The worksheet contains an unsupported cell type.", { row: r + 1, index: c });
}

export function decodeWorkbookTable(
  bytes: Uint8Array, engine: WorkbookEngine, options: WorkbookTableReadOptions,
): Result<DataTable> {
  const format = workbookFormat(bytes);
  if (!format) return failure("E_WORKBOOK_FORMAT", "Expected a BIFF8 .xls or an .xlsx workbook.");
  const { sheetName, kind, columns, headerRow = 0 } = options ?? {};
  if (!validSheetName(sheetName) || !validSchema(kind, columns) || !Number.isInteger(headerRow) ||
    headerRow < 0 || headerRow >= rowLimit[format] ||
    columns.some(({ sourceColumn }) => !Number.isInteger(sourceColumn) || sourceColumn < 0 || sourceColumn >= columnLimit[format]) ||
    new Set(columns.map(({ sourceColumn }) => sourceColumn)).size !== columns.length) {
    return failure("E_WORKBOOK_SCHEMA", "Choose a worksheet, heading row and distinct source columns with their expected types.");
  }
  try {
    const book = engine.read(bytes, { type: "array", cellFormula: true, cellDates: true, bookVBA: false, dense: false });
    const sheet = book.SheetNames.includes(sheetName) && Object.hasOwn(book.Sheets, sheetName) ? book.Sheets[sheetName] : undefined;
    if (!sheet) return failure("E_WORKBOOK_SHEET", "The named worksheet is absent.");
    const reference = sheet["!ref"];
    if (typeof reference !== "string") return failure("E_WORKBOOK_SHEET", "The named worksheet has no readable cell range.");
    const range = engine.utils.decode_range(reference);
    if (!Number.isInteger(range.e.r) || range.e.r < headerRow || range.e.r >= rowLimit[format]) {
      return failure("E_WORKBOOK_SIZE", "The heading or worksheet rows lie outside the supported range.");
    }
    for (const column of columns) {
      const heading = readCell(sheet, engine, headerRow, column.sourceColumn);
      if (!heading.ok) return heading;
      if (heading.value !== column.label) {
        return failure("E_WORKBOOK_HEADER", "The worksheet heading does not match the mapped column.", {
          row: headerRow + 1, index: column.sourceColumn,
        });
      }
    }
    const rows: TableCell[][] = [];
    for (let row = headerRow + 1; row <= range.e.r; row++) {
      const cells: TableCell[] = [];
      for (const column of columns) {
        const cell = readCell(sheet, engine, row, column.sourceColumn);
        if (!cell.ok) return cell;
        if (!validCell(cell.value, column)) {
          return failure("E_WORKBOOK_CELL", "The cell does not match its mapped column type.", { row: row + 1, index: column.sourceColumn });
        }
        cells.push(cell.value);
      }
      rows.push(cells);
    }
    return okay({ kind, columns: columns.map(({ sourceColumn: _, ...column }) => column), rows });
  } catch {
    return failure("E_WORKBOOK_READ", "The workbook engine could not read the worksheet.");
  }
}
