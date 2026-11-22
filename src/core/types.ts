export type AxisUnit = "min" | "mL" | "CV";
export type Interval = readonly [start: number, end: number];
export type XY = Readonly<{ x: number; y: number }>;

export interface Diagnostic {
  code: string;
  message: string;
  curveId?: string;
  row?: number;
  index?: number;
  range?: Interval;
}

export type Result<T> =
  | { ok: true; value: T; warnings: readonly Diagnostic[] }
  | { ok: false; errors: readonly Diagnostic[] };

export interface Curve {
  id: string;
  runId: string;
  label: string;
  sourceLabel?: string;
  sourceChromatogramId: string;
  kind: "measured" | "baseline" | "derived";
  xUnit: AxisUnit;
  signalUnit: string;
  x: Float64Array;
  y: Float64Array;
  missing?: Uint8Array;
  sourceCurveIds?: readonly string[];
}
export interface Chromatogram {
  id: string;
  sourceName: string;
  displayName?: string;
  origin: "original" | "imported" | "derived";
  curveRefs: readonly { runId: string; chromatogramId: string; curveId: string; slot: number }[];
  peakTableIds: readonly string[];
}
export interface Run {
  id: string;
  name: string;
  curves: readonly Curve[];
  chromatograms: readonly Chromatogram[];
  timeVolume?: { timeMin: Float64Array; volumeMl: Float64Array };
  column?: {
    separationMode?: "SEC" | "other";
    volumeMl?: number;
    bedHeightCm?: number;
    voidVolumeMl?: number;
    totalLiquidVolumeMl?: number;
    particleDiameterUm?: number;
  };
  uvPathLengthCm?: number;
  markers: readonly RunMarker[];
  fractions: readonly Fraction[];
  variables?: Readonly<Record<string, number | string>>;
}
export interface RunMarker {
  id: string;
  kind: "injection" | "phase" | "event" | "note";
  x: number;
  xUnit: AxisUnit;
  label: string;
}
export interface Fraction {
  id: string;
  label: string;
  trackId: string;
  sequence: number;
  range: Interval;
  xUnit: AxisUnit;
  volumeMl?: number;
}
export type BaselineSpec =
  | { kind: "zero" }
  | { kind: "manual"; shape: "linear" | "classic-spline"; anchors: readonly XY[]; straightAfter?: readonly number[] }
  | { kind: "curve"; baselineCurveId: string }
  | { kind: "morphological"; structureWidth: number; minAnchorDistance: number }
  | { kind: "classical"; minSegment: number; noiseWindow: number; maxLevel: number; maxSlope: number };
export type LimitKind = "baseline-intersection" | "dropline" | "skim" | "manual";
export type PeakLimit = { x: number; kind: LimitKind };
export interface PeakWindow {
  id: string;
  left: PeakLimit;
  right: PeakLimit;
  polarity: "positive" | "negative";
  name?: string;
}
export interface IntegrationConfig {
  xUnit: AxisUnit;
  window?: Interval;
  acceptNegative: boolean;
  reject?: { minHeight?: number; minWidth?: number; minArea?: number; keepLargest?: number };
  separation: { kind: "dropline" } | { kind: "skim"; ratio: number };
  asymmetryAt: number;
  resolution: "base-width" | "sigma" | "half-height";
  totalPeakAreaPolicy?: "signed" | "absolute";
  /** Injection coordinate in xUnit, overriding the run's injection marker. */
  injectionX?: number;
  /** Fraction collector track to use when run metadata is supplied. */
  fractionTrackId?: string;
}
export interface BaselineResult {
  id: string;
  curveId: string;
  xUnit: AxisUnit;
  signalUnit: string;
  points: readonly XY[];
  validRanges: readonly Interval[];
  spec: BaselineSpec;
}
export interface PeakRow {
  id: string;
  name?: string;
  polarity: PeakWindow["polarity"];
  bounds: { left: PeakLimit; right: PeakLimit };
  apex: XY;
  baselineHeights: { start: number; apex: number; end: number };
  endpointHeights: { start: number; end: number };
  fractionIds: { start: string | null; apex: string | null; end: string | null };
  height: number;
  area: number;
  width: number;
  halfHeightWidth: number | null;
  /** First moment of the same-polarity residual, in the integration axis unit. */
  centroid?: number | null;
  /** Residual-weighted standard deviation around the centroid, in the integration axis unit. */
  momentStandardDeviation?: number | null;
  crossings?: { halfHeight: readonly [number | null, number | null]; asymmetry: readonly [number | null, number | null] };
  /** Local integration baseline of a skimmed shoulder. */
  skimLine?: readonly [XY, XY];
  /** Upper edges of areas transferred from shoulders to this peak by skimming. */
  skimExtensions?: readonly (readonly [XY, XY])[];
  /** Integration span after skimming. The original peak bounds remain the editing handles. */
  integrationBounds?: Interval;
  pctTotalPeakArea: number | null;
  pctTotalCurveArea: number | null;
  asymmetry: number | null;
  resolution: number | null;
  /** Residual-weighted root mean square deviation around the apex, in the integration axis unit. */
  sigma: number | null;
  retentionFactor: number | null;
  kav: number | null;
  plates: number | null;
  hetpCm: number | null;
  platesPerM: number | null;
}
export interface PeakTable {
  id: string;
  chromatogramId: string;
  baselineId: string;
  curveId: string;
  config: IntegrationConfig;
  xUnit: AxisUnit;
  signalUnit: string;
  areaUnit: string;
  rows: readonly PeakRow[];
  denominators: { peakArea: number; curveAreaAboveBaseline: number };
}
export interface AnalysisState {
  revision: number;
  run: Run;
  activeChromatogramId: string;
  activeCurveId: string;
  activePeakTableId?: string;
  peakTables: readonly PeakTable[];
  activeBaselineId?: string;
  baselines: readonly BaselineResult[];
  windows: readonly PeakWindow[];
}
export type PeakEdit = { peakId: string; expectedRevision?: number } & (
  | { op: "move-limit"; edge: PeakEdge; x: number }
  | { op: "split"; x?: number; newPeakId: string }
  | { op: "join-left" | "join-right" }
  | { op: "remove" }
  | { op: "rename"; name: string }
);
export type PeakEdge = "left" | "right";
