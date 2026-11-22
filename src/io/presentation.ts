import { failure, okay } from "../core/result.ts";
import type { Result } from "../core/types.ts";

export type PrintableCell = string | number | boolean | null;
export interface PresentationTable {
  columns: readonly { label: string; unit?: string }[];
  rows: readonly (readonly PrintableCell[])[];
}
export type PrintBlock = { title: string } & (
  | { kind: "text"; text: string }
  | { kind: "table"; table: PresentationTable }
  | { kind: "image"; pngDataUrl: string; alt?: string }
);

function heading(column: PresentationTable["columns"][number]): string {
  return column.unit ? column.label + " [" + column.unit + "]" : column.label;
}

function validateTable(table: PresentationTable): boolean {
  return !!table && Array.isArray(table.columns) && Array.isArray(table.rows) && table.columns.length > 0 &&
    table.columns.every((column) => column && typeof column.label === "string" && (column.unit === undefined || typeof column.unit === "string")) &&
    table.rows.every((row) => Array.isArray(row) && row.length === table.columns.length &&
      row.every((cell) => cell === null || typeof cell === "string" || typeof cell === "boolean" ||
        (typeof cell === "number" && Number.isFinite(cell))));
}

export function tableClipboardText(table: PresentationTable, indices?: readonly number[]): Result<string> {
  if (!validateTable(table)) return failure("E_PRESENTATION_TABLE", "Table rows must match their column count and use finite values.");
  if (indices?.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= table.rows.length)) {
    return failure("E_PRESENTATION_ROWS", "A selected row lies outside the table.");
  }
  const rows = indices === undefined ? table.rows : indices.map((i) => table.rows[i]!);
  const stringify = (cell: PrintableCell) => {
    const raw = String(cell ?? "");
    const text = typeof cell === "string" && (/[=+\-@]/.test(raw.trimStart()[0] ?? "") || /^[\r\n\t]/.test(raw))
      ? "'" + raw
      : raw;
    return /["\t\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  };
  return okay([table.columns.map(heading), ...rows].map((row) => row.map(stringify).join("\t")).join("\n") + "\n");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function embeddedPng(url: string): boolean {
  const prefix = "data:image/png;base64,";
  if (!url.startsWith(prefix)) return false;
  const encoded = url.slice(prefix.length);
  if (encoded.length % 4 || encoded.length < 60 || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return false;
  const bytes = atob(encoded.slice(0, 44));
  return bytes.slice(8, 16) === "\x00\x00\x00\rIHDR" &&
    [bytes.slice(16, 20), bytes.slice(20, 24)].every((size) => size !== "\x00\x00\x00\x00");
}

export function encodePrintDocument(title: string, blocks: readonly PrintBlock[]): Result<string> {
  if (!blocks.length) return failure("E_PRINT_BLOCKS", "Choose at least one item to print.");
  const html: string[] = ['<!doctype html><html lang="en"><head><meta charset="utf-8">',
    "<title>" + escapeHtml(title) + "</title>",
    "<style>body{font:12px/1.45 system-ui,sans-serif;margin:18px;color:#16292e}" +
      "section{margin-bottom:20px}h1,h2{break-after:avoid}table{border-collapse:collapse;width:100%}" +
      "thead{display:table-header-group}th,td{text-align:left;border-bottom:1px solid #526061;padding:5px;overflow-wrap:anywhere}" +
      "tr{break-inside:avoid}img{max-width:100%;break-inside:avoid}p{white-space:pre-wrap;overflow-wrap:anywhere}" +
      "@media print{body{margin:0}}</style></head><body><main><h1>" + escapeHtml(title) + "</h1>"];

  for (const block of blocks) {
    html.push("<section><h2>" + escapeHtml(block.title) + "</h2>");
    switch (block.kind) {
      case "text":
        html.push("<p>" + escapeHtml(block.text) + "</p>");
        break;
      case "image":
        if (!embeddedPng(block.pngDataUrl)) {
          return failure("E_PRINT_IMAGE", "Print charts need an embedded PNG image.");
        }
        html.push('<img src="' + block.pngDataUrl + '" alt="' + escapeHtml(block.alt ?? block.title) + '">');
        break;
      case "table": {
        if (!validateTable(block.table)) return failure("E_PRESENTATION_TABLE", "A print table has invalid column or row values.");
        const { columns, rows } = block.table;
        html.push("<table><thead><tr>" + columns.map((column) => '<th scope="col">' + escapeHtml(heading(column)) + "</th>").join("") +
          "</tr></thead><tbody>");
        for (const row of rows) html.push("<tr>" + row.map((cell) => "<td>" + escapeHtml(String(cell ?? "")) + "</td>").join("") + "</tr>");
        html.push("</tbody></table>");
        break;
      }
    }
    html.push("</section>");
  }
  return okay(html.join("\n") + "\n</main></body></html>");
}
