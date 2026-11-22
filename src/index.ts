export type * from "./core/types.ts";
export { validateCurve, sampleCurve } from "./core/curve.ts";
export { mapCoordinate, resolveCurveAxis } from "./core/axis.ts";
export type { Coordinate } from "./core/axis.ts";
export { calculateBaseline } from "./core/baseline.ts";
export { defaultIntegrationConfig, integratePeaks, filterVisiblePeaks } from "./core/integrate.ts";
export { applyPeakEdit, reintegratePeakRange } from "./core/peak-edits.ts";
export { detectPeaks } from "./core/detect.ts";
export { measureCurve, measureInterval, captureMarkerSnapshot } from "./core/measure.ts";
export type { IntervalMeasurement, MarkerSnapshotOptions } from "./core/measure.ts";
export { combineCurves, ratioCurves, slopeAt } from "./core/curve-operations.ts";
export type { CombineOptions } from "./core/curve-operations.ts";
export { smoothCurve } from "./core/smoothing.ts";
export type { SmoothingOptions } from "./core/smoothing.ts";
export { poolFractions, fractionHistogram, activityHistogram } from "./core/fractions.ts";
export type { FractionPool, FractionResult } from "./core/fractions.ts";
export { comparePeakTables, matchPeaks, summarizeMatches } from "./core/compare.ts";
export type { ComparablePeak, ComparisonInput, MatchCriterion, PeakOverride, PeakMatch, PeakTableComparisonInput } from "./core/compare.ts";
export { evaluateColumnPerformance } from "./core/column-performance.ts";
export type { ColumnPerformance } from "./core/column-performance.ts";
export { validateProcedure, runProcedure, runProcedureBatch, parseProcedure, serializeProcedure, procedureStepKinds } from "./core/procedure.ts";
export type {
  CurveRef, ProcedureStep, EvaluationProcedure, ProcedureArtifacts, BatchOutcome, ProcedureStepKind, ProcedureBaselineSpec,
} from "./core/procedure.ts";
export { cumulativeIntegrateCurve } from "./core/cumulative-integration.ts";
export type { CumulativeIntegrationOptions } from "./core/cumulative-integration.ts";
export { fitDoeModel, predictDoeModel } from "./core/doe.ts";
export type { DoeFit, DoeRun, DoeTerm, DoeAnova, DoePrediction, DoePredictionRow } from "./core/doe.ts";
export { buildRunDocumentation, listAvailableDocumentationSections, queryRunLog, updateEvaluationNote } from "./core/run-documentation.ts";
export type {
  DocumentationField, EvaluationNote, PositionedRunLogEntry, RunDocumentation, RunDocumentationSource,
  RunDocumentSection, RunFeedback, RunLogEntry, RunLogQuery, RunSectionId,
} from "./core/run-documentation.ts";
export { createLayoutStore, decodeLayout, encodeLayout } from "./core/layout.ts";
export type { ChromatogramLayout, LayoutAnnotation, LayoutPanel } from "./core/layout.ts";
export { buildComparisonView, synchronizeComparisonCursor, deriveShiftedCurve } from "./core/run-comparison.ts";
export type {
  ComparisonLayout, ComparisonSource, ComparisonViewOptions, ComparisonSeries, ComparisonView,
  ComparisonCursorValue, ShiftComparisonCurveOptions,
} from "./core/run-comparison.ts";
