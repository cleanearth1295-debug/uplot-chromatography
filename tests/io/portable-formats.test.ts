import assert from "node:assert/strict";
import test from "node:test";
import type { Curve, Fraction, PeakTable, Result } from "../../src/core/types.ts";
import type { PeakMatch } from "../../src/core/compare.ts";
import { encodePeakTableCsv, toPeakDataTable } from "../../src/io/export.ts";
import { decodeCurveData, encodeCurveData } from "../../src/io/formats/curve-data.ts";
import { encodeComparisonCsv, encodeFractionsCsv, toComparisonDataTable, toFractionDataTable } from "../../src/io/formats/result-tables.ts";
import { decodePortableTable, encodePortableTable } from "../../src/io/formats/table.ts";
import type { DataTable } from "../../src/io/formats/table.ts";
import { encodePrintDocument } from "../../src/io/presentation.ts";

function get<T>(result: Result<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const table: DataTable = {
  kind: "+test",
  columns: [
    { id: "string", label: "Name, with \"quotes\"\n", type: "string", nullable: true },
    { id: "number", label: "=units", type: "number", nullable: true },
    { id: "boolean", label: "", type: "boolean" },
  ],
  rows: [["=SUM(1,2)", -1.5, true], ["'apostrophe", -0, false], ["", null, false], [null, 1e-300, true],
    ["a\tb\rc\nd", 1e300, false], ["\t=1", 0, true]],
};

function roundTripTable(format: "csv" | "asc") {
  const encoded = get(encodePortableTable(table, format));
  assert.equal(encoded.includes("'=SUM(1,2)"), true);
  assert.equal(encoded.includes("'=units"), true);
  assert.equal(encoded.includes("''apostrophe"), true);
  assert.deepEqual(get(decodePortableTable("\ufeff" + encoded)), table);
  const emptyTable = { ...table, kind: "'test", rows: [] };
  assert.deepEqual(get(decodePortableTable(get(encodePortableTable(emptyTable, format)))), emptyTable);
}

function roundTripCurves(format: "csv" | "asc") {
  const first: Curve = {
    id: "a", runId: "run", label: "'=UV,100\n", sourceLabel: " unicode µL [raw] ", sourceChromatogramId: "original",
    kind: "measured", xUnit: "min", signalUnit: "mAU [corrected]", x: Float64Array.of(-0, 1.5, 4),
    y: Float64Array.of(2, NaN, -3), missing: Uint8Array.of(0, 1, 0),
  };
  const second: Curve = {
    ...first, id: "b", xUnit: "mL", signalUnit: "mS/cm", kind: "derived", sourceCurveIds: ["a"],
    x: Float64Array.of(0.25, 6), y: Float64Array.of(-0, 42), missing: undefined,
  };
  const restored = get(decodeCurveData(get(encodeCurveData([first, second], format))));
  assert.deepEqual(restored.map(({ label }) => label), [first.label, second.label]);
  assert.deepEqual(restored.map(({ x }) => x), [first.x, second.x]);
  assert.deepEqual(restored.map(({ y }) => y), [Float64Array.of(2, 0, -3), second.y]);
  assert.deepEqual(restored[0]?.missing, first.missing);
  assert.equal(restored[0]?.sourceLabel, first.sourceLabel);
  assert.equal(restored[1]?.xUnit, "mL");
  assert.equal(restored[1]?.signalUnit, "mS/cm");
  assert.equal(restored[1]?.kind, "derived");
  assert.deepEqual(restored[1]?.sourceCurveIds, ["a"]);
  assert.equal(encodeCurveData([first, first], format).ok, false);
}

test("portable csv tables preserve types, escaped strings and nulls", () => roundTripTable("csv"));
test("portable csv curves preserve units, identity, independent grids and gaps", () => roundTripCurves("csv"));
test("portable asc tables preserve types, escaped strings and nulls", () => roundTripTable("asc"));
test("portable asc curves preserve units, identity, independent grids and gaps", () => roundTripCurves("asc"));

test("portable table rejects malformed schemas and rows with diagnostics", () => {
  const encoded = get(encodePortableTable(table));
  assert.equal(decodePortableTable(encoded.replace("/table,1,", "/table,2,")).ok, false);
  assert.equal(decodePortableTable(encoded.replace("Record,", "Wrong,")).ok, false);
  assert.equal(decodePortableTable(encoded.replace(",-1.5,true", ",Infinity,true")).ok, false);
  assert.equal(decodePortableTable(encoded + "data,,0,other\n").ok, false);
  assert.equal(decodePortableTable(encoded + "data,\"unfinished\n").ok, false);
  assert.equal(encodePortableTable({ ...table, rows: [[null, Infinity, false]] }).ok, false);
  assert.equal(encodePortableTable({ ...table, columns: [table.columns[0]!, table.columns[0]!] }).ok, false);
});

test("portable curve decoding respects sample structure", () => {
  const columns = [
    { id: "curve", label: "Curve number", type: "number" },
    { id: "metadata", label: "Curve metadata", type: "string", nullable: true },
    { id: "x", label: "X", type: "number" },
    { id: "y", label: "Signal", type: "number", nullable: true },
  ] as const;
  const metadata = JSON.stringify({
    id: "curve", runId: "run", label: "x", sourceChromatogramId: "original", kind: "measured", xUnit: "CV", signalUnit: "mAU",
  });
  assert.equal(decodeCurveData(get(encodePortableTable(table))).ok, false);
  assert.equal(decodeCurveData(get(encodePortableTable({ kind: "curves", columns, rows: [[1, null, 0, 0]] }))).ok, false);
  assert.equal(decodeCurveData(get(encodePortableTable({
    kind: "curves", columns, rows: [[1, metadata, 1, 0], [1, null, 0, 0]],
  }))).ok, false);
});

test("peak exports cover all measurements and allow ordered selection", () => {
  const peakTable: PeakTable = {
    id: "table", chromatogramId: "chart", baselineId: "line", curveId: "uv", xUnit: "min", signalUnit: "mAU",
    areaUnit: "mAU min", denominators: { peakArea: 1, curveAreaAboveBaseline: 1 },
    config: { xUnit: "min", acceptNegative: true, separation: { kind: "dropline" }, asymmetryAt: 0.1, resolution: "sigma" },
    rows: [{
      id: "p1", name: "=1+1", polarity: "negative",
      bounds: { left: { x: 1, kind: "skim" }, right: { x: 3, kind: "manual" } },
      apex: { x: 2, y: 3 }, baselineHeights: { start: 4, apex: 5, end: 6 }, endpointHeights: { start: -1, end: -2 },
      fractionIds: { start: null, apex: "B-1", end: "B-2" }, height: -2, area: -3, width: 2, halfHeightWidth: 1,
      pctTotalPeakArea: 20, pctTotalCurveArea: 15, asymmetry: 1.3, resolution: null, sigma: 0.1, retentionFactor: 0.2,
      kav: 0.3, plates: 100, hetpCm: 0.5, platesPerM: 900,
      centroid: 2, momentStandardDeviation: 0.2, crossings: { halfHeight: [1.5, 2.5], asymmetry: [1.2, null] },
      skimLine: [{ x: 1, y: 4 }, { x: 3, y: 6 }], skimExtensions: [[{ x: 1, y: 4 }, { x: 3, y: 6 }]],
      integrationBounds: [0.75, 3.5],
    }],
  };
  const data = toPeakDataTable(peakTable);
  assert.equal(data.columns.length, 44);
  assert.deepEqual(get(decodePortableTable(get(encodePortableTable(data)))), data);
  assert.equal(encodePeakTableCsv(peakTable, ["name", "height", "resolution", "fractionApex"]),
    "Name,Height [mAU],Resolution,Apex fraction ID\n'=1+1,-2,,B-1\n");
  assert.match(encodePeakTableCsv(peakTable), /HETP \[cm\],Plates per metre/);
  assert.equal(encodePeakTableCsv(peakTable, ["skimStartSignal", "integrationEnd", "asymmetryEnd", "centroid"]),
    "Skim start signal [mAU],Integration end [min],Right asymmetry crossing [min],Centroid [min]\n4,3.5,,2\n");
  const printable = toPeakDataTable(peakTable, ["centroid", "name"]);
  const html = get(encodePrintDocument("Peak measurements", [{ kind: "table", title: "Peaks", table: printable }]));
  assert.match(html, /<th scope="col">Centroid \[min\]<\/th><th scope="col">Name<\/th>/);
});

test("comparison and fraction exports retain ambiguous candidates, statuses, and units", () => {
  const matches: PeakMatch[] = [
    { referenceId: "r", tableId: "a", status: "ambiguous", candidateIds: ["p,1", "p\"2"], peak: null, overridden: false },
    { referenceId: "r", tableId: "b", status: "matched", candidateIds: ["p3"], overridden: true,
      peak: { id: "p3", name: "+peak", area: 4, height: 5, apex: { x: 6, y: 7 } } },
  ];
  const fractions: Fraction[] = [
    { id: "F1", label: "A, 1", trackId: "track", sequence: 1, range: [0, 2], xUnit: "mL", volumeMl: 2 },
    { id: "F2", label: "B", trackId: "track", sequence: 2, range: [2, 3], xUnit: "mL" },
  ];
  const comparisonData = toComparisonDataTable(matches);
  const fractionData = toFractionDataTable(fractions);
  assert.deepEqual(get(decodePortableTable(get(encodePortableTable(comparisonData)))), comparisonData);
  assert.deepEqual(get(decodePortableTable(get(encodePortableTable(fractionData, "asc")))), fractionData);
  assert.match(encodeComparisonCsv(matches), /matched,.*true,p3,'\+peak,4,5,6,7/);
  assert.match(encodeFractionsCsv(fractions), /F1,"A, 1",track,1,0,2,mL,2/);
});
