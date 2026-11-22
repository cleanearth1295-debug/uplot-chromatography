import type { PeakMatch } from "../../core/compare.ts";
import type { Fraction } from "../../core/types.ts";
import { encodeDataTableCsv } from "../export.ts";
import type { DataColumn, DataTable } from "./table.ts";

const comparisonColumns: readonly DataColumn[] = [
  { id: "referenceId", label: "Reference peak ID", type: "string" },
  { id: "tableId", label: "Compared table ID", type: "string" },
  { id: "status", label: "Status", type: "string" },
  { id: "candidateIds", label: "Candidate peak IDs (JSON)", type: "string" },
  { id: "overridden", label: "Overridden", type: "boolean" },
  { id: "peakId", label: "Matched peak ID", type: "string", nullable: true },
  { id: "peakName", label: "Matched peak name", type: "string", nullable: true },
  { id: "area", label: "Area", type: "number", nullable: true },
  { id: "height", label: "Height", type: "number", nullable: true },
  { id: "apexX", label: "Apex X", type: "number", nullable: true },
  { id: "apexY", label: "Apex signal", type: "number", nullable: true },
];

const fractionColumns: readonly DataColumn[] = [
  { id: "id", label: "Fraction ID", type: "string" },
  { id: "label", label: "Label", type: "string" },
  { id: "trackId", label: "Track ID", type: "string" },
  { id: "sequence", label: "Sequence", type: "number" },
  { id: "start", label: "Start", type: "number" },
  { id: "end", label: "End", type: "number" },
  { id: "xUnit", label: "Axis unit", type: "string" },
  { id: "volumeMl", label: "Volume [mL]", type: "number", nullable: true },
];

export function toComparisonDataTable(matches: readonly PeakMatch[]): DataTable {
  return {
    kind: "comparison", columns: comparisonColumns.map((column) => ({ ...column })),
    rows: matches.map(({ referenceId, tableId, status, candidateIds, overridden, peak }) => [
      referenceId, tableId, status, JSON.stringify(candidateIds), overridden,
      peak?.id ?? null, peak?.name ?? null, peak?.area ?? null, peak?.height ?? null, peak?.apex.x ?? null, peak?.apex.y ?? null,
    ]),
  };
}

export function toFractionDataTable(fractions: readonly Fraction[]): DataTable {
  return {
    kind: "fractions", columns: fractionColumns.map((column) => ({ ...column })),
    rows: fractions.map(({ id, label, trackId, sequence, range, xUnit, volumeMl }) => [
      id, label, trackId, sequence, range[0], range[1], xUnit, volumeMl ?? null,
    ]),
  };
}

export function encodeComparisonCsv(matches: readonly PeakMatch[]): string {
  return encodeDataTableCsv(toComparisonDataTable(matches));
}

export function encodeFractionsCsv(fractions: readonly Fraction[]): string {
  return encodeDataTableCsv(toFractionDataTable(fractions));
}
