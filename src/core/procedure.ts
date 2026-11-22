import type { BaselineResult, BaselineSpec, Curve, Diagnostic, IntegrationConfig, PeakTable, PeakWindow, Result, Run } from "./types.ts";
import { calculateBaseline } from "./baseline.ts";
import { cumulativeIntegrateCurve } from "./cumulative-integration.ts";
import { detectPeaks } from "./detect.ts";
import { defaultIntegrationConfig, integratePeaks } from "./integrate.ts";
import { combineCurves, ratioCurves } from "./curve-operations.ts";
import type { CombineOptions } from "./curve-operations.ts";
import { failure, okay } from "./result.ts";
import { smoothCurve } from "./smoothing.ts";
import type { SmoothingOptions } from "./smoothing.ts";
import {
  isRecord, named, onlyKeys, validBaselineSpec, validIntegrationConfig, validPeakWindows, validSmoothingOptions, validThreshold,
} from "./procedure-validation.ts";

export type CurveRef = { id: string } | { label: string } | { output: string };
export type ProcedureBaselineSpec = BaselineSpec | { kind: "curve"; baselineCurve: CurveRef };
type ProcedureConfig = Omit<IntegrationConfig, "xUnit">;
export type ProcedureStep = { output: string } & (
  | { kind: "baseline"; curve: CurveRef; spec: ProcedureBaselineSpec }
  | { kind: "detect"; baseline: string; config?: ProcedureConfig }
  | { kind: "integrate"; baseline: string; config?: ProcedureConfig; windows?: readonly PeakWindow[] | string }
  | { kind: "combine"; left: CurveRef; right: CurveRef; options: CombineOptions }
  | { kind: "ratio"; left: CurveRef; right: CurveRef; baselineA?: string; baselineB?: string;
      options: { thresholdA: number; thresholdB: number } }
  | { kind: "smooth"; curve: CurveRef; options: SmoothingOptions }
  | { kind: "cumulative-integrate"; curve: CurveRef; baseline?: string }
);
export type ProcedureStepKind = ProcedureStep["kind"];
export const procedureStepKinds = Object.freeze(["baseline", "detect", "integrate", "combine", "ratio", "smooth", "cumulative-integrate"] as const satisfies readonly ProcedureStepKind[]);
export interface EvaluationProcedure {
  schemaVersion: 1;
  id: string;
  name: string;
  revision: number;
  steps: readonly ProcedureStep[];
}
export interface ProcedureArtifacts {
  baselines: ReadonlyMap<string, BaselineResult>;
  curves: ReadonlyMap<string, Curve>;
  tables: ReadonlyMap<string, PeakTable>;
  windows: ReadonlyMap<string, readonly PeakWindow[]>;
}
function checkCurveRef(ref: unknown): ref is CurveRef {
  if (!isRecord(ref)) return false;
  const fields = Reflect.ownKeys(ref);
  const key = fields[0];
  return fields.length === 1 && (key === "id" || key === "label" || key === "output") && named(ref[key]);
}

export function validateProcedure(procedure: unknown): Result<EvaluationProcedure> {
  if (!isRecord(procedure) || !onlyKeys(procedure, "id", "schemaVersion", "name", "revision", "steps") ||
    procedure.schemaVersion !== 1 || !named(procedure.id) ||
    !named(procedure.name) || typeof procedure.revision !== "number" || !Number.isSafeInteger(procedure.revision) ||
    procedure.revision < 0 || !Array.isArray(procedure.steps) || !procedure.steps.length) {
    return failure("E_PROCEDURE_SHAPE", "A named, versioned procedure with at least one step is required.");
  }
  const symbols = new Map<string, ProcedureStepKind>();
  const detectedBy = new Map<string, string>();
  const visible = (ref: unknown) => {
    if (!checkCurveRef(ref)) return false;
    if (!("output" in ref)) return true;
    const kind = symbols.get(ref.output);
    return kind === "combine" || kind === "ratio" || kind === "smooth" || kind === "cumulative-integrate";
  };
  const hasBaseline = (ref: unknown): ref is string => named(ref) && symbols.get(ref) === "baseline";
  for (const [index, step] of procedure.steps.entries()) {
    if (!isRecord(step) || !named(step.output) || symbols.has(step.output)) {
      return failure("E_PROCEDURE_OUTPUT", "Each procedure output must have a unique name.", { index });
    }
    const keys = (...specific: readonly string[]) => onlyKeys(step, "kind", "output", ...specific);
    switch (step.kind) {
      case "baseline":
        if (!keys("curve", "spec") || !visible(step.curve) || !validBaselineSpec(step.spec, visible)) {
          return failure("E_PROCEDURE_SOURCE", "The baseline requires a resolvable curve and supported specification.", { index });
        }
        break;
      case "detect":
      case "integrate":
        if (!hasBaseline(step.baseline)) {
          return failure("E_PROCEDURE_SOURCE", "Peak evaluation needs a previously calculated baseline.", { index });
        }
        if (!(step.kind === "detect" ? keys("baseline", "config") : keys("baseline", "config", "windows")) ||
          !validIntegrationConfig(step.config)) {
          return failure("E_PROCEDURE_OPTIONS", "Peak evaluation requires valid integration settings.", { index });
        }
        if (step.kind === "detect") detectedBy.set(step.output, step.baseline);
        else if (step.windows !== undefined && (typeof step.windows === "string" ?
          detectedBy.get(step.windows) !== step.baseline : !validPeakWindows(step.windows))) {
          return failure("E_PROCEDURE_OPTIONS", "Peak integration requires valid windows or a detection output from the same baseline.", { index });
        }
        break;
      case "combine":
        if (!keys("left", "right", "options") || !visible(step.left) || !visible(step.right) || !isRecord(step.options) ||
          !onlyKeys(step.options, "op", "id", "threshold") ||
          (step.options.id !== undefined && typeof step.options.id !== "string") ||
          (step.options.op !== "add" && step.options.op !== "subtract" && step.options.op !== "divide") ||
          (step.options.threshold !== undefined && !validThreshold(step.options.threshold))) {
          return failure("E_PROCEDURE_SOURCE", "The operation needs two resolvable curves and valid arithmetic settings.", { index });
        }
        break;
      case "ratio":
        if (!keys("left", "right", "options", "baselineA", "baselineB") ||
          !visible(step.left) || !visible(step.right) || !validThreshold(step.options) ||
          (step.baselineA !== undefined && !hasBaseline(step.baselineA)) ||
          (step.baselineB !== undefined && !hasBaseline(step.baselineB))) {
          return failure("E_PROCEDURE_SOURCE", "The ratio needs two curves, valid thresholds and previously calculated optional baselines.", { index });
        }
        break;
      case "cumulative-integrate":
        if (!keys("curve", "baseline") || !visible(step.curve) || (step.baseline !== undefined && !hasBaseline(step.baseline))) {
          return failure("E_PROCEDURE_SOURCE", "Cumulative integration needs a resolvable curve and an optional prior baseline.", { index });
        }
        break;
      case "smooth":
        if (!keys("curve", "options") || !visible(step.curve) || !validSmoothingOptions(step.options)) {
          return failure("E_PROCEDURE_SOURCE", "The filter needs a resolvable curve and valid filter settings.", { index });
        }
        break;
      default:
        return failure("E_PROCEDURE_COMMAND", "The procedure contains an unsupported operation.", { index });
    }
    symbols.set(step.output, step.kind);
  }
  return okay(procedure as unknown as EvaluationProcedure);
}

export function serializeProcedure(procedure: EvaluationProcedure): Result<string> {
  const checked = validateProcedure(procedure);
  if (!checked.ok) return checked;
  try {
    const json = JSON.stringify(checked.value, function (key, value: unknown) {
      if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" ||
        (typeof value === "number" && !Number.isFinite(value)) ||
        (value === undefined && Array.isArray(this))) throw new Error("Non-JSON value at " + key);
      return value;
    });
    const decoded = parseProcedure(json);
    return decoded.ok ? okay(json) : decoded;
  } catch {
    return failure("E_PROCEDURE_JSON", "The procedure cannot be represented as JSON.");
  }
}

export function parseProcedure(json: string): Result<EvaluationProcedure> {
  if (typeof json !== "string") return failure("E_PROCEDURE_JSON", "A procedure must be provided as JSON text.");
  try {
    return validateProcedure(JSON.parse(json));
  } catch {
    return failure("E_PROCEDURE_JSON", "The procedure contains invalid JSON.");
  }
}

export function runProcedure(run: Run, procedure: EvaluationProcedure): Result<ProcedureArtifacts> {
  const checked = validateProcedure(procedure);
  if (!checked.ok) return checked;
  return executeProcedure(run, checked.value);
}

function executeProcedure(run: Run, procedure: EvaluationProcedure): Result<ProcedureArtifacts> {
  const curves = new Map<string, Curve>();
  const baselines = new Map<string, BaselineResult>();
  const tables = new Map<string, PeakTable>();
  const windows = new Map<string, readonly PeakWindow[]>();
  const warnings: Diagnostic[] = [];
  const sourceByLabel = new Map<string, Curve | undefined>();
  const curvesById = new Map<string, Curve | undefined>();
  for (const curve of run.curves) {
    sourceByLabel.set(curve.label, sourceByLabel.has(curve.label) ? undefined : curve);
    curvesById.set(curve.id, curvesById.has(curve.id) ? undefined : curve);
  }
  const getCurve = (ref: CurveRef): Curve | undefined => {
    if ("output" in ref) return curves.get(ref.output);
    if ("id" in ref) return curvesById.get(ref.id);
    const curve = sourceByLabel.get(ref.label);
    return curve ? curvesById.get(curve.id) : undefined;
  };
  const identify = (result: { ok: false; errors: readonly Diagnostic[] }, index: number): Result<never> => ({
    ok: false, errors: result.errors.map((error) => ({ ...error, index })),
  });
  const addWarnings = (items: readonly Diagnostic[], index: number) => {
    for (const warning of items) warnings.push({ ...warning, index });
  };
  for (const [index, step] of procedure.steps.entries()) {
    const outputId = JSON.stringify([run.id, procedure.id, procedure.revision, step.output]);
    if (curvesById.has(outputId)) return failure("E_PROCEDURE_OUTPUT", "The output would replace an existing curve.", { index });

    if (step.kind === "integrate" || step.kind === "detect") {
      const baseline = baselines.get(step.baseline)!;
      const curve = curvesById.get(baseline.curveId)!;
      const config = { ...(step.config ?? defaultIntegrationConfig(curve.xUnit)), xUnit: curve.xUnit };
      const declared = step.kind === "integrate" ? step.windows : undefined;
      const detected = declared === undefined ? detectPeaks(curve, baseline, config) :
        okay(typeof declared === "string" ? windows.get(declared)! : declared);
      if (!detected.ok) return identify(detected, index);
      addWarnings(detected.warnings, index);
      if (step.kind === "detect") {
        windows.set(step.output, detected.value);
        continue;
      }
      const table = integratePeaks(curve, baseline, detected.value, config, run);
      if (!table.ok) return identify(table, index);
      tables.set(step.output, { ...table.value, id: outputId });
      addWarnings(table.warnings, index);
    } else if (step.kind === "combine" || step.kind === "ratio") {
      const left = getCurve(step.left);
      const right = getCurve(step.right);
      if (!left || !right) return failure("E_PROCEDURE_SOURCE", "The source curves are missing or ambiguous in this run.", { index });
      const result = step.kind === "combine" ? combineCurves(left, right, { ...step.options, id: outputId }) :
        ratioCurves(left, right, {
          ...step.options, id: outputId,
          baselineA: step.baselineA === undefined ? undefined : baselines.get(step.baselineA),
          baselineB: step.baselineB === undefined ? undefined : baselines.get(step.baselineB),
        });
      if (!result.ok) return identify(result, index);
      curves.set(step.output, result.value);
      curvesById.set(result.value.id, result.value);
      addWarnings(result.warnings, index);
    } else {
      const curve = getCurve(step.curve);
      if (!curve) return failure("E_PROCEDURE_SOURCE", "The source curve is missing or ambiguous in this run.", { index });
      if (step.kind === "baseline") {
        let spec: BaselineSpec;
        if (step.spec.kind === "curve" && "baselineCurve" in step.spec) {
          const source = getCurve(step.spec.baselineCurve);
          if (!source) return failure("E_PROCEDURE_SOURCE", "The reference baseline curve is missing or ambiguous in this run.", { index });
          spec = { kind: "curve", baselineCurveId: source.id };
        } else {
          spec = step.spec;
        }
        if (spec.kind === "curve" && !curvesById.get(spec.baselineCurveId)) {
          return failure("E_PROCEDURE_SOURCE", "The reference baseline curve is missing or ambiguous in this run.", { index });
        }
        const result = calculateBaseline({ ...run, curves: [...run.curves, ...curves.values()] }, curve.id, spec);
        if (!result.ok) return identify(result, index);
        baselines.set(step.output, { ...result.value, id: outputId });
        addWarnings(result.warnings, index);
      } else {
        const result = step.kind === "smooth" ? smoothCurve(curve, { ...step.options, id: outputId }) :
          cumulativeIntegrateCurve(curve, {
            id: outputId,
            baseline: step.baseline === undefined ? undefined : baselines.get(step.baseline),
          });
        if (!result.ok) return identify(result, index);
        curves.set(step.output, result.value);
        curvesById.set(result.value.id, result.value);
        addWarnings(result.warnings, index);
      }
    }
  }
  return okay({ curves, baselines, tables, windows }, warnings);
}

export interface BatchOutcome {
  key: string;
  runId: string;
  status: "completed" | "failed" | "already-completed";
  diagnostics: readonly Diagnostic[];
  artifacts?: ProcedureArtifacts;
}
export function runProcedureBatch(
  procedure: EvaluationProcedure, inputs: readonly { run: Run; revision: number }[],
  completed: ReadonlySet<string> = new Set(),
): readonly BatchOutcome[] {
  const checked = validateProcedure(procedure);
  const finished = new Set(completed);
  return inputs.map(({ run, revision }) => {
    const key = JSON.stringify([run.id, revision, procedure?.id, procedure?.revision]);
    const common = { key, runId: run.id };
    if (!checked.ok) return { ...common, status: "failed", diagnostics: checked.errors };
    if (!named(run.id) || !Number.isSafeInteger(revision) || revision < 0) {
      return { ...common, status: "failed", diagnostics: [
        { code: "E_BATCH_INPUT", message: "A batch input needs a run ID and a nonnegative safe integer revision." },
      ] };
    }
    if (finished.has(key)) return { ...common, status: "already-completed", diagnostics: [] };
    const result = executeProcedure(run, checked.value);
    if (!result.ok) return { ...common, status: "failed", diagnostics: result.errors };
    finished.add(key);
    return { ...common, status: "completed", diagnostics: result.warnings, artifacts: result.value };
  });
}
