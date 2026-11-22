import type { AxisUnit, Curve, Result, Run } from "../core/types.ts";
import { validateCurve } from "../core/curve.ts";
import { failure, okay } from "../core/result.ts";
import { records } from "./formats/delimited.ts";
import type { Delimiter, RecordRow } from "./formats/delimited.ts";

type SourceAxis = AxisUnit | "s" | "ms" | "L" | "µL" | "nL";
export interface CurveColumn {
  x: string | number;
  y: string | number;
  xUnit: SourceAxis;
  signalUnit: string;
  label?: string;
}
export interface ParseCurveOptions {
  runId: string;
  runName?: string;
  format?: "csv" | "asc" | "auto";
  delimiter?: Delimiter;
  decimalSeparator?: "." | ",";
  columns?: readonly CurveColumn[];
}
const axes: Readonly<Record<SourceAxis, { unit: AxisUnit; factor: number }>> = {
  min: { unit: "min", factor: 1 }, s: { unit: "min", factor: 1 / 60 }, ms: { unit: "min", factor: 1 / 60_000 },
  mL: { unit: "mL", factor: 1 }, L: { unit: "mL", factor: 1000 }, "µL": { unit: "mL", factor: 0.001 },
  nL: { unit: "mL", factor: 0.000001 }, CV: { unit: "CV", factor: 1 },
};

function headerUnit(header: string): string | undefined {
  return (header.match(/\[([^\]]+)\]\s*$/) ?? header.match(/\(([^)]+)\)\s*$/))?.[1]?.trim();
}
function headerLabel(header: string): string {
  return header.replace(/\s*[\[(][^)\]]*[\])]\s*$/, "").trim();
}
function axisUnit(text: string | undefined): SourceAxis | undefined {
  switch (text?.toLowerCase()) {
    case "min": case "minute": case "minutes": return "min";
    case "s": case "sec": return "s";
    case "ms": return "ms";
    case "l": return "L";
    case "ml": return "mL";
    case "ul": case "μl": case "µl": return "µL";
    case "nl": return "nL";
    case "cv": return "CV";
    default: return undefined;
  }
}

function numeric(text: string, decimal: "." | ","): number {
  const clean = text.trim();
  if (decimal === "," && clean.includes(".")) return NaN;
  const normalized = decimal === "," ? clean.replace(",", ".") : clean;
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized) ? Number(normalized) : NaN;
}

function chooseDelimiter(text: string, options: ParseCurveOptions): Result<RecordRow[]> {
  if (options.delimiter) {
    if (options.decimalSeparator === options.delimiter) {
      return failure("E_DIALECT", "The column separator and decimal symbol must differ.");
    }
    return records(text, options.delimiter);
  }
  const possible: Delimiter[] = options.format === "csv" ? [",", ";", "\t"] : ["\t", ";", ","];
  const candidates = possible.filter((delimiter) => delimiter !== options.decimalSeparator)
    .map((delimiter) => ({ delimiter, result: records(text, delimiter) }));
  const matches = candidates.filter(({ result }) => result.ok && (result.value[0]?.cells.length ?? 0) >= 2 &&
    result.value.slice(1).every((row) => row.cells.length === result.value[0]!.cells.length));
  if (matches.length === 1) return matches[0]!.result;
  if (matches.length > 1) return failure("E_DIALECT", "More than one delimiter fits the file. Choose one explicitly.");
  const headers = candidates.filter(({ result }) => result.ok && (result.value[0]?.cells.length ?? 0) >= 2);
  return headers.length === 1 ? headers[0]!.result : failure("E_DIALECT", "The delimiter could not be inferred. Specify comma, semicolon or tab.");
}

function findColumn(headers: readonly string[], key: number | string): number {
  if (typeof key === "number") return Number.isInteger(key) && key >= 0 && key < headers.length ? key : -1;
  const index = headers.indexOf(key);
  return index >= 0 && index === headers.lastIndexOf(key) ? index : -1;
}

export function parseUnicornCurves(text: string, options: ParseCurveOptions): Result<Run> {
  if (!options.runId.trim()) return failure("E_RUN_ID", "A run ID is required.");
  const parsed = chooseDelimiter(text.replace(/^\ufeff/, ""), options);
  if (!parsed.ok) return parsed;

  const [header, ...rows] = parsed.value;
  if (!header || header.cells.length < 2 || rows.length === 0) {
    return failure("E_CURVE_FILE", "A header and sample rows are required.");
  }
  const headers = header.cells.map((cell) => cell.trim());
  for (const row of rows) {
    if (row.cells.length !== headers.length) {
      return failure("E_COLUMN_COUNT", "Sample row width differs from the header.", { row: row.row });
    }
  }

  let columns = options.columns;
  if (!columns) {
    const pairs: CurveColumn[] = [];
    for (let x = 0; x + 1 < headers.length; x += 2) {
      const xHeader = headers[x]!;
      const yHeader = headers[x + 1]!;
      const label = headerLabel(yHeader);
      const xUnit = axisUnit(headerUnit(xHeader));
      const signalUnit = headerUnit(yHeader);
      if (!xUnit || !signalUnit || headerLabel(xHeader) !== (label + " X").trim()) break;
      pairs.push({ x, y: x + 1, xUnit, signalUnit, label });
    }
    if (pairs.length * 2 === headers.length) {
      columns = pairs;
    } else {
      const xUnit = axisUnit(headerUnit(headers[0]!));
      if (!xUnit) return failure("E_AXIS_UNIT", "The first column must declare an axis unit, or columns must be supplied.", { row: header.row });
      columns = headers.slice(1).map((label, index) => ({
        x: 0, y: index + 1, xUnit, signalUnit: headerUnit(label) ?? "", label: headerLabel(label),
      }));
    }
  }
  if (!columns.length) return failure("E_COLUMNS", "At least one signal column must be mapped.");

  const chromatogramId = options.runId + ":chromatogram:1";
  const curves: Curve[] = [];
  for (const [slot, column] of columns.entries()) {
    const xi = findColumn(headers, column.x);
    const yi = findColumn(headers, column.y);
    const axis = Object.hasOwn(axes, column.xUnit) ? axes[column.xUnit] : undefined;
    if (xi < 0 || yi < 0 || xi === yi || !axis || !column.signalUnit.trim()) {
      return failure("E_COLUMNS", "The curve requires distinct X/Y columns and explicit axis and signal units.", { row: header.row, index: slot });
    }
    const x: number[] = [];
    const y: number[] = [];
    const missing: number[] = [];
    const sourceRows: number[] = [];
    const decimal = options.decimalSeparator ?? ".";
    for (const row of rows) {
      const xCell = row.cells[xi]!;
      const yCell = row.cells[yi]!;
      if (!xCell.trim() && !yCell.trim()) continue;
      const position = numeric(xCell, decimal) * axis.factor;
      const signal = yCell.trim() ? numeric(yCell, decimal) : 0;
      if (!Number.isFinite(position) || !Number.isFinite(signal)) {
        return failure("E_NUMBER", "The sample has an invalid numeric value.", { row: row.row, index: !Number.isFinite(position) ? xi : yi });
      }
      x.push(position);
      y.push(signal);
      missing.push(yCell.trim() ? 0 : 1);
      sourceRows.push(row.row);
    }

    const label = column.label ?? headerLabel(headers[yi]!);
    const key = encodeURIComponent(label.toLowerCase().trim().replace(/\s+/g, "-") || "curve");
    const curve: Curve = {
      id: options.runId + ":" + key + ":" + (slot + 1),
      runId: options.runId, label, sourceLabel: headers[yi], sourceChromatogramId: chromatogramId, kind: "measured",
      xUnit: axis.unit, signalUnit: column.signalUnit, x: Float64Array.from(x), y: Float64Array.from(y),
      missing: missing.some(Boolean) ? Uint8Array.from(missing) : undefined,
    };
    const check = validateCurve(curve);
    if (!check.ok) {
      return { ok: false, errors: check.errors.map((error) => ({ ...error, row: error.index === undefined ? header.row : sourceRows[error.index] })) };
    }
    curves.push(curve);
  }

  return okay({
    id: options.runId, name: options.runName ?? options.runId, curves, fractions: [], markers: [],
    chromatograms: [{
      id: chromatogramId, sourceName: options.runName ?? options.runId, origin: "original",
      curveRefs: curves.map((curve, slot) => ({ runId: options.runId, chromatogramId, curveId: curve.id, slot })),
      peakTableIds: [],
    }],
  });
}
