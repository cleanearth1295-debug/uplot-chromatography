import type { Curve, Result } from "../../core/types.ts";
import { isAxisUnit, validateCurve } from "../../core/curve.ts";
import { failure, okay } from "../../core/result.ts";
import type { TableCell, TextFormat } from "./delimited.ts";
import { decodePortableTable, encodePortableTable } from "./table.ts";
import type { DataColumn } from "./table.ts";

type CurveMetadata = Omit<Curve, "x" | "y" | "missing">;
const columns: readonly DataColumn[] = [
  { id: "curve", label: "Curve number", type: "number" },
  { id: "metadata", label: "Curve metadata", type: "string", nullable: true },
  { id: "x", label: "X", type: "number" },
  { id: "y", label: "Signal", type: "number", nullable: true },
];

export function encodeCurveData(curves: readonly Curve[], format: TextFormat = "csv"): Result<string> {
  if (!curves.length) return failure("E_CURVE_FILE", "At least one curve is needed.");
  const ids = new Set<string>();
  const rows: TableCell[][] = [];
  for (const [slot, curve] of curves.entries()) {
    const checked = validateCurve(curve);
    if (!checked.ok) return checked;
    const key = JSON.stringify([curve.runId, curve.id]);
    if (ids.has(key)) return failure("E_CURVE_FILE", "Curve IDs must be unique within a run.", { curveId: curve.id });
    ids.add(key);
    const { id, runId, label, sourceLabel, sourceChromatogramId, kind, xUnit, signalUnit, sourceCurveIds } = curve;
    const metadata = JSON.stringify({ id, runId, label, sourceLabel, sourceChromatogramId, kind, xUnit, signalUnit, sourceCurveIds });
    for (let index = 0; index < curve.x.length; index++) {
      rows.push([slot + 1, index === 0 ? metadata : null, curve.x[index]!, curve.missing?.[index] ? null : curve.y[index]!]);
    }
  }
  return encodePortableTable({ kind: "curves", columns, rows }, format);
}

function decodeMetadata(text: string): CurveMetadata | undefined {
  let item: Partial<CurveMetadata> | null;
  try {
    item = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (item === null || typeof item !== "object") return undefined;
  const { id, runId, label, sourceLabel, sourceChromatogramId, kind, xUnit, signalUnit, sourceCurveIds } = item;
  if (typeof id !== "string" || typeof runId !== "string" || typeof label !== "string" ||
    (sourceLabel !== undefined && typeof sourceLabel !== "string") || typeof sourceChromatogramId !== "string" ||
    (kind !== "measured" && kind !== "baseline" && kind !== "derived") ||
    !isAxisUnit(xUnit) || typeof signalUnit !== "string" ||
    (sourceCurveIds !== undefined && (!Array.isArray(sourceCurveIds) || sourceCurveIds.some((value) => typeof value !== "string")))) {
    return undefined;
  }
  return { id, runId, label, sourceLabel, sourceChromatogramId, kind, xUnit, signalUnit, sourceCurveIds };
}

export function decodeCurveData(text: string, format?: TextFormat): Result<Curve[]> {
  const decoded = decodePortableTable(text, format);
  if (!decoded.ok) return decoded;
  const table = decoded.value;
  if (table.kind !== "curves" || !table.rows.length || table.columns.length !== columns.length ||
    columns.some((column, index) => column.id !== table.columns[index]!.id || column.type !== table.columns[index]!.type ||
      column.nullable !== table.columns[index]!.nullable)) {
    return failure("E_CURVE_FILE", "Expected a portable curve data table.");
  }
  const groups: { metadata: CurveMetadata; x: number[]; y: number[]; missing: number[] }[] = [];
  const ids = new Set<string>();
  for (const [index, [slot, rawMetadata, x, y]] of table.rows.entries()) {
    if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 1 || typeof x !== "number" ||
      (y !== null && typeof y !== "number")) {
      return failure("E_CURVE_FILE", "The curve sample is invalid.", { index });
    }
    if (slot === groups.length + 1 && typeof rawMetadata === "string") {
      const metadata = decodeMetadata(rawMetadata);
      if (!metadata) return failure("E_CURVE_METADATA", "The curve metadata is malformed.", { index });
      const key = JSON.stringify([metadata.runId, metadata.id]);
      if (ids.has(key)) return failure("E_CURVE_FILE", "Curve IDs must be unique within a run.", { index });
      ids.add(key);
      groups.push({ metadata, x: [], y: [], missing: [] });
    } else if (slot !== groups.length || rawMetadata !== null) {
      return failure("E_CURVE_FILE", "Samples must be grouped by curve with metadata on the first sample.", { index });
    }
    const group = groups[slot - 1]!;
    group.x.push(x);
    group.y.push(y ?? 0);
    group.missing.push(y === null ? 1 : 0);
  }
  const curves: Curve[] = [];
  for (const group of groups) {
    const curve: Curve = { ...group.metadata, x: Float64Array.from(group.x), y: Float64Array.from(group.y) };
    if (group.missing.includes(1)) curve.missing = Uint8Array.from(group.missing);
    const checked = validateCurve(curve);
    if (!checked.ok) return checked;
    curves.push(curve);
  }
  return okay(curves);
}
