import type { Curve, PeakRow, PeakTable, Result } from "../core/types.ts";
import { sampleCurve, validateCurve } from "../core/curve.ts";
import { failure, okay } from "../core/result.ts";
import { delimitedRow } from "./formats/delimited.ts";
import type { TableCell } from "./formats/delimited.ts";
import type { DataColumn, DataTable } from "./formats/table.ts";

export type PeakColumn =
  | "id" | "name" | "start" | "apex" | "end" | "height" | "area"
  | "width" | "halfHeightWidth" | "pctTotalPeakArea" | "pctTotalCurveArea" | "asymmetry"
  | "polarity" | "startKind" | "endKind" | "apexSignal" | "baselineStart" | "baselineApex" | "baselineEnd"
  | "endpointStart" | "endpointEnd" | "fractionStart" | "fractionApex" | "fractionEnd"
  | "resolution" | "sigma" | "retentionFactor" | "kav" | "plates" | "hetpCm" | "platesPerM"
  | "centroid" | "momentStandardDeviation" | "halfHeightStart" | "halfHeightEnd" | "asymmetryStart" | "asymmetryEnd"
  | "skimStart" | "skimEnd" | "skimStartSignal" | "skimEndSignal" | "skimExtensions" | "integrationStart" | "integrationEnd";
const peakColumns: readonly PeakColumn[] = ["id", "name", "start", "apex", "end", "height", "area",
  "width", "halfHeightWidth", "pctTotalPeakArea", "pctTotalCurveArea", "asymmetry",
  "polarity", "startKind", "endKind", "apexSignal", "baselineStart", "baselineApex", "baselineEnd",
  "endpointStart", "endpointEnd", "fractionStart", "fractionApex", "fractionEnd",
  "resolution", "sigma", "retentionFactor", "kav", "plates", "hetpCm", "platesPerM",
  "centroid", "momentStandardDeviation", "halfHeightStart", "halfHeightEnd", "asymmetryStart", "asymmetryEnd",
  "skimStart", "skimEnd", "skimStartSignal", "skimEndSignal", "skimExtensions", "integrationStart", "integrationEnd"];

const peakTextColumns = new Set<PeakColumn>(["id", "name", "polarity", "startKind", "endKind", "fractionStart", "fractionApex", "fractionEnd",
  "skimExtensions"]);
const peakNullableColumns = new Set<PeakColumn>(["name", "halfHeightWidth", "pctTotalPeakArea", "pctTotalCurveArea",
  "asymmetry", "fractionStart", "fractionApex", "fractionEnd", "resolution", "sigma", "retentionFactor", "kav",
  "plates", "hetpCm", "platesPerM", "centroid", "momentStandardDeviation", "halfHeightStart", "halfHeightEnd", "asymmetryStart", "asymmetryEnd",
  "skimStart", "skimEnd", "skimStartSignal", "skimEndSignal", "skimExtensions", "integrationStart", "integrationEnd"]);

function readPeak(peak: PeakRow, column: PeakColumn): TableCell {
  switch (column) {
    case "start": return peak.bounds.left.x;
    case "end": return peak.bounds.right.x;
    case "apex": return peak.apex.x;
    case "startKind": return peak.bounds.left.kind;
    case "endKind": return peak.bounds.right.kind;
    case "apexSignal": return peak.apex.y;
    case "baselineStart": return peak.baselineHeights.start;
    case "baselineApex": return peak.baselineHeights.apex;
    case "baselineEnd": return peak.baselineHeights.end;
    case "endpointStart": return peak.endpointHeights.start;
    case "endpointEnd": return peak.endpointHeights.end;
    case "fractionStart": return peak.fractionIds.start;
    case "fractionApex": return peak.fractionIds.apex;
    case "fractionEnd": return peak.fractionIds.end;
    case "halfHeightStart": return peak.crossings?.halfHeight[0] ?? null;
    case "halfHeightEnd": return peak.crossings?.halfHeight[1] ?? null;
    case "asymmetryStart": return peak.crossings?.asymmetry[0] ?? null;
    case "asymmetryEnd": return peak.crossings?.asymmetry[1] ?? null;
    case "skimStart": return peak.skimLine?.[0].x ?? null;
    case "skimEnd": return peak.skimLine?.[1].x ?? null;
    case "skimStartSignal": return peak.skimLine?.[0].y ?? null;
    case "skimEndSignal": return peak.skimLine?.[1].y ?? null;
    case "skimExtensions": return peak.skimExtensions === undefined ? null : JSON.stringify(peak.skimExtensions);
    case "integrationStart": return peak.integrationBounds?.[0] ?? null;
    case "integrationEnd": return peak.integrationBounds?.[1] ?? null;
    default: return peak[column] ?? null;
  }
}

export function toPeakDataTable(table: PeakTable, columns: readonly PeakColumn[] = peakColumns): DataTable {
  const x = " [" + table.xUnit + "]";
  const y = " [" + table.signalUnit + "]";
  const headings: Record<PeakColumn, string> = {
    id: "Peak ID", name: "Name", start: "Start" + x, apex: "Apex" + x, end: "End" + x, height: "Height" + y,
    area: "Area [" + table.areaUnit + "]", width: "Width" + x, halfHeightWidth: "Half-height width" + x,
    pctTotalPeakArea: "Total peak area [%]", pctTotalCurveArea: "Total curve area [%]", asymmetry: "Asymmetry",
    polarity: "Polarity", startKind: "Start limit type", endKind: "End limit type", apexSignal: "Apex signal" + y,
    baselineStart: "Start baseline signal" + y, baselineApex: "Apex baseline signal" + y, baselineEnd: "End baseline signal" + y,
    endpointStart: "Start endpoint height" + y, endpointEnd: "End endpoint height" + y,
    fractionStart: "Start fraction ID", fractionApex: "Apex fraction ID", fractionEnd: "End fraction ID",
    resolution: "Resolution", sigma: "Sigma" + x, retentionFactor: "Retention factor", kav: "Kav",
    plates: "Plates", hetpCm: "HETP [cm]", platesPerM: "Plates per metre",
    centroid: "Centroid" + x, momentStandardDeviation: "Moment standard deviation" + x,
    halfHeightStart: "Left half-height crossing" + x, halfHeightEnd: "Right half-height crossing" + x,
    asymmetryStart: "Left asymmetry crossing" + x, asymmetryEnd: "Right asymmetry crossing" + x,
    skimStart: "Skim start" + x, skimEnd: "Skim end" + x, skimStartSignal: "Skim start signal" + y, skimEndSignal: "Skim end signal" + y,
    skimExtensions: "Skim extensions (JSON)", integrationStart: "Integration start" + x, integrationEnd: "Integration end" + x,
  };
  const schema = columns.map((id): DataColumn => ({
    id, label: headings[id], type: peakTextColumns.has(id) ? "string" : "number", nullable: peakNullableColumns.has(id),
  }));
  return { kind: "peaks", columns: schema, rows: table.rows.map((row) => columns.map((column) => readPeak(row, column))) };
}

export function encodeDataTableCsv(table: DataTable): string {
  const lines = [delimitedRow(table.columns.map(({ label }) => label), ",")];
  for (const row of table.rows) lines.push(delimitedRow(row, ","));
  return lines.join("\n") + "\n";
}

export function encodePeakTableCsv(table: PeakTable, columns: readonly PeakColumn[] = peakColumns): string {
  return encodeDataTableCsv(toPeakDataTable(table, columns));
}

export interface CurveCsvOptions {
  start?: number;
  end?: number;
  everyNth?: number;
  grid?: "per-curve" | "union";
}

export function encodeCurvesCsv(curves: readonly Curve[], options: CurveCsvOptions = {}): Result<string> {
  if (!curves.length) return failure("E_CURVE_FILE", "At least one curve is needed.");
  for (const curve of curves) {
    const checked = validateCurve(curve);
    if (!checked.ok) return checked;
  }
  const every = options.everyNth ?? 1;
  const start = options.start ?? -Infinity;
  const end = options.end ?? Infinity;
  if (!Number.isInteger(every) || every < 1 || !(start <= end)) {
    return failure("E_EXPORT_RANGE", "Export range and sampling stride must be valid.");
  }
  const selected = curves.map((curve) => {
    const indices: number[] = [];
    for (let i = 0; i < curve.x.length; i++) {
      if (curve.x[i]! >= start && curve.x[i]! <= end) indices.push(i);
    }
    return indices;
  });
  const union = options.grid === "union" || (options.grid === undefined && curves.length === 1);
  if (union && curves.some((curve) => curve.xUnit !== curves[0]!.xUnit)) {
    return failure("E_AXIS_UNIT", "Use the same axis for a common-X export.");
  }
  const heading = union ? ["X [" + curves[0]!.xUnit + "]",
    ...curves.map((curve) => curve.label + " [" + curve.signalUnit + "]")]
    : curves.flatMap((curve) => [curve.label + " X [" + curve.xUnit + "]", curve.label + " [" + curve.signalUnit + "]"]);
  const lines = [delimitedRow(heading, ",")];

  if (union) {
    const xGrid = [...new Set(selected.flatMap((list, curve) => list.map((index) => curves[curve]!.x[index]!)))].sort((a, b) => a - b);
    for (let index = 0; index < xGrid.length; index += every) {
      const x = xGrid[index]!;
      lines.push(delimitedRow([x, ...curves.map((curve) => sampleCurve(curve, x))], ","));
    }
  } else {
    const sampled = selected.map((indices) => indices.filter((_, i) => i % every === 0));
    const count = sampled.reduce((maximum, samples) => Math.max(maximum, samples.length), 0);
    for (let index = 0; index < count; index++) {
      const row = curves.flatMap((curve, slot) => {
        const sample = sampled[slot]![index];
        return sample === undefined ? [null, null] : [curve.x[sample], curve.missing?.[sample] ? null : curve.y[sample]];
      });
      lines.push(delimitedRow(row, ","));
    }
  }
  return okay(lines.join("\n") + "\n");
}
