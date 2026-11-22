import type { Result } from "../../core/types.ts";
import { failure, okay } from "../../core/result.ts";

export type Delimiter = "," | ";" | "\t";

export type TextFormat = "csv" | "asc";
export type TableCell = string | number | boolean | null;

export function delimiterFor(format: TextFormat): Delimiter {
  return format === "asc" ? "\t" : ",";
}

function numericCell(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

function textCell(value: string, preserveEmpty: boolean): string {
  return (preserveEmpty && (!value || value.startsWith("'"))) || /^(?:\s*[=+\-@]|[\t\r\n])/u.test(value) ? "'" + value : value;
}

function quoteCell(value: string, delimiter: Delimiter): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
}

export function delimitedRow(cells: readonly (TableCell | undefined)[], delimiter: Delimiter, preserveEmpty = false): string {
  return cells.map((value) => quoteCell(value == null ? "" : typeof value === "string" ? textCell(value, preserveEmpty) :
    typeof value === "number" ? numericCell(value) : String(value), delimiter)).join(delimiter);
}

export type RecordRow = { cells: string[]; row: number };

export function records(text: string, delimiter: Delimiter): Result<RecordRow[]> {
  const rows: RecordRow[] = [];
  let cells: string[] = [];
  let field = "";
  let line = 1;
  let row = 1;
  let state: "plain" | "quoted" | "closed" = "plain";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (state === "quoted") {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        state = "closed";
      } else {
        field += char;
        if (char === "\n" || (char === "\r" && text[i + 1] !== "\n")) line++;
      }
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      if (cells.length || field.trim()) rows.push({ cells: [...cells, field], row });
      cells = [];
      field = "";
      state = "plain";
      row = ++line;
    } else if (char === delimiter) {
      cells.push(field);
      field = "";
      state = "plain";
    } else if (char === '"' && state === "plain" && !field.length) {
      state = "quoted";
    } else if (char === '"' || state === "closed") {
      return failure("E_CSV_QUOTE", "Unexpected character next to a quoted field.", { row });
    } else {
      field += char;
    }
  }
  if (state === "quoted") return failure("E_CSV_QUOTE", "A quoted field did not close.", { row });
  if (cells.length || field.trim()) rows.push({ cells: [...cells, field], row });
  return okay(rows);
}
