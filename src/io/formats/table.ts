import type { Result } from "../../core/types.ts";
import { failure, okay } from "../../core/result.ts";
import { delimitedRow, delimiterFor, records } from "./delimited.ts";
import type { TableCell, TextFormat } from "./delimited.ts";

export interface DataColumn {
  id: string;
  label: string;
  type: "string" | "number" | "boolean";
  nullable?: boolean;
}

export interface DataTable {
  kind: string;
  columns: readonly DataColumn[];
  rows: readonly (readonly TableCell[])[];
}

const signature = "uplot-chromatography/table";

function validColumns(columns: unknown): columns is DataColumn[] {
  return Array.isArray(columns) && columns.length > 0 && columns.every((item: unknown) => {
    if (typeof item !== "object" || item === null) return false;
    const column = item as Partial<DataColumn>;
    return typeof column.id === "string" && !!column.id.trim() && typeof column.label === "string" &&
      (column.type === "string" || column.type === "number" || column.type === "boolean") &&
      (column.nullable === undefined || typeof column.nullable === "boolean");
  }) && new Set(columns.map((column) => column.id)).size === columns.length;
}

function validCell(value: TableCell, column: DataColumn): boolean {
  if (value === null) return column.nullable === true;
  return typeof value === column.type && (typeof value !== "number" || Number.isFinite(value));
}

export function encodePortableTable(table: DataTable, format: TextFormat = "csv"): Result<string> {
  if (!table.kind.trim() || !validColumns(table.columns)) {
    return failure("E_TABLE_SCHEMA", "A table requires a kind and unique, typed columns.");
  }
  const delimiter = delimiterFor(format);
  const lines = [
    delimitedRow([signature, 1, table.kind, JSON.stringify(table.columns)], delimiter, true),
    delimitedRow(["Record", ...table.columns.map(({ label }) => label)], delimiter, true),
  ];
  for (const [index, row] of table.rows.entries()) {
    if (row.length !== table.columns.length || !table.columns.every((column, i) => validCell(row[i]!, column))) {
      return failure("E_TABLE_CELL", "The row does not conform to the column schema.", { index });
    }
    // A single apostrophe represents an empty string. Nonempty strings beginning
    // with an apostrophe are escaped by delimitedRow, as are spreadsheet formulas.
    lines.push(delimitedRow(["data", ...row], delimiter, true));
  }
  return okay(lines.join("\n") + "\n");
}

function decodeCell(raw: string, column: DataColumn): TableCell | undefined {
  if (raw === "") return column.nullable ? null : undefined;
  if (column.type === "string") return raw.startsWith("'") ? raw.slice(1) : raw;
  if (column.type === "boolean") return raw === "true" ? true : raw === "false" ? false : undefined;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function decodePortableTable(text: string, format?: TextFormat): Result<DataTable> {
  const input = text.replace(/^\ufeff/, "");
  const delimiter = delimiterFor(format ?? (input.startsWith(signature + "\t") ? "asc" : "csv"));
  const parsed = records(input, delimiter);
  if (!parsed.ok) return parsed;
  const [manifest, heading, ...rows] = parsed.value;
  if (manifest?.cells.length !== 4 || manifest.cells[0] !== signature || manifest.cells[1] !== "1" || !heading) {
    return failure("E_TABLE_SCHEMA", "Expected a version 1 portable table.");
  }
  const rawKind = manifest.cells[2]!;
  const kind = rawKind.startsWith("'") ? rawKind.slice(1) : rawKind;
  let columns: unknown;
  try {
    columns = JSON.parse(manifest.cells[3]!);
  } catch {
    return failure("E_TABLE_SCHEMA", "The column schema is invalid JSON.");
  }
  if (!kind.trim() || !validColumns(columns) || heading.cells[0] !== "Record" ||
    heading.cells.length !== columns.length + 1 || columns.some(({ label }, i) =>
      decodeCell(heading.cells[i + 1]!, { id: "", label: "", type: "string" }) !== label)) {
    return failure("E_TABLE_SCHEMA", "The headings do not match a valid column schema.");
  }
  const decoded: TableCell[][] = [];
  for (const row of rows) {
    if (row.cells.length !== columns.length + 1 || row.cells[0] !== "data") {
      return failure("E_TABLE_CELL", "Expected a data row matching the column schema.", { row: row.row });
    }
    const cells: TableCell[] = [];
    for (const [index, column] of columns.entries()) {
      const value = decodeCell(row.cells[index + 1]!, column);
      if (value === undefined) return failure("E_TABLE_CELL", "Invalid value for the column type.", { row: row.row, index });
      cells.push(value);
    }
    decoded.push(cells);
  }
  return okay({ kind, columns, rows: decoded });
}
