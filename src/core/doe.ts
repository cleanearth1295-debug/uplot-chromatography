import type { Diagnostic, Result } from "./types.ts";
import { fUpperTail } from "./doe-statistics.ts";
import { leastSquares } from "./least-squares.ts";
import { isRecord, named } from "./procedure-validation.ts";
import { failure, okay } from "./result.ts";

export interface DoeRun {
  runId: string;
  factors: Readonly<Record<string, number>>;
  response: number;
}
export interface DoeTerm {
  id: string;
  powers: Readonly<Record<string, number>>;
}
interface DoeAnovaRow {
  degreesOfFreedom: number;
  sumSquares: number;
  meanSquare: number | null;
}
export interface DoeAnova {
  model: DoeAnovaRow & { fStatistic: number | null; pValue: number | null };
  residual: DoeAnovaRow;
  total: Pick<DoeAnovaRow, "degreesOfFreedom" | "sumSquares">;
}
export interface DoePredictionRow {
  runId: string;
  observed: number;
  predicted: number;
  residual: number;
  leverage: number;
  standardizedResidual: number | null;
  deletedResidual: number | null;
}
export interface DoeFit {
  intercept: number;
  coefficients: Readonly<Record<string, number>>;
  rows: readonly DoePredictionRow[];
  rSquared: number | null;
  adjustedRSquared: number | null;
  residualDegreesOfFreedom: number;
  residualSumSquares: number;
  anova: DoeAnova;
  press: number | null;
  predictedRSquared: number | null;
  terms: readonly DoeTerm[];
  factorRanges: Readonly<Record<string, { min: number; max: number }>>;
}
export interface DoePrediction {
  predicted: number;
  extrapolatedFactors: readonly string[];
}

function validTerm(value: unknown): value is DoeTerm {
  return isRecord(value) && named(value.id) && isRecord(value.powers) && Object.keys(value.powers).length > 0 &&
    Object.entries(value.powers).every(([factor, power]) => named(factor) && typeof power === "number" &&
      Number.isSafeInteger(power) && power >= 1 && power <= 5);
}

function validRun(value: unknown): value is DoeRun {
  return isRecord(value) && named(value.runId) && isRecord(value.factors) && Number.isFinite(value.response);
}

function modelRow(factors: Readonly<Record<string, number>>, terms: readonly DoeTerm[]): number[] {
  return [1, ...terms.map((term) => Object.entries(term.powers).reduce((product, [name, power]) => {
    const factor = Object.hasOwn(factors, name) ? factors[name] : undefined;
    return product * (Number.isFinite(factor) ? factor! ** power : NaN);
  }, 1))];
}

export function fitDoeModel(runs: readonly DoeRun[], terms: readonly DoeTerm[]): Result<DoeFit> {
  if (!Array.isArray(runs) || !Array.isArray(terms) || runs.length < terms.length + 1 ||
    !Array.from(terms).every(validTerm) || new Set(terms.map((term) => term.id)).size !== terms.length) {
    return failure("E_DOE_DESIGN", "The model needs unique term IDs, defined terms and enough runs.");
  }
  const invalidRun = Array.from(runs).findIndex((run) => !validRun(run));
  if (invalidRun !== -1) {
    return failure("E_DOE_VALUE", "Every included run needs an ID, factors and a finite response.", { index: invalidRun });
  }
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) {
    return failure("E_DOE_DESIGN", "Included run IDs must be unique.");
  }
  const rows = runs.map((run) => modelRow(run.factors, terms));
  const invalidFactor = rows.findIndex((row) => !row.every(Number.isFinite));
  if (invalidFactor !== -1) {
    return failure("E_DOE_VALUE", "Every included run needs finite values for all model factors and terms.", { index: invalidFactor });
  }

  const response = runs.map((run) => run.response);
  const scales = rows[0]!.map((_, column) => rows.reduce((max, row) => Math.max(max, Math.abs(row[column]!)), 0));
  const scaled = rows.map((row) => row.map((value, column) => value / (scales[column]! || 1)));
  const leverage = new Float64Array(runs.length);
  const coefficients = leastSquares(scaled, response, leverage);
  if (!coefficients) return failure("E_DOE_RANK", "Model terms are linearly dependent or numerically unresolved.");
  const unscaledCoefficients = terms.map((_, index) => coefficients[index + 1]! / scales[index + 1]!);
  if (!unscaledCoefficients.every(Number.isFinite)) return failure("E_DOE_VALUE", "A model coefficient exceeds numeric limits.");

  const prediction = runs.map((run, index) => {
    const predicted = scaled[index]!.reduce((sum, factor, column) => sum + factor * coefficients[column]!, 0);
    return { runId: run.runId, observed: run.response, predicted, residual: run.response - predicted };
  });
  const mean = response.reduce((sum, value) => sum + value / runs.length, 0);
  const total = response.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const residualSumSquares = prediction.reduce((sum, row) => sum + row.residual ** 2, 0);
  if (!Number.isFinite(total) || !Number.isFinite(residualSumSquares)) {
    return failure("E_DOE_VALUE", "Model variance exceeds numeric limits.");
  }
  const residualDegreesOfFreedom = runs.length - terms.length - 1;
  const rSquared = total > 0 ? 1 - residualSumSquares / total : null;
  const residualMeanSquare = residualDegreesOfFreedom > 0 ? residualSumSquares / residualDegreesOfFreedom : null;
  const adjustedRSquared = total > 0 && residualMeanSquare !== null
    ? 1 - residualMeanSquare / (total / (runs.length - 1)) : null;
  const modelSumSquares = Math.max(0, total - residualSumSquares);
  const modelMeanSquare = terms.length > 0 ? modelSumSquares / terms.length : null;
  // A numerically exact fit with model variance has the limiting p-value of zero.
  const f = total === 0 || residualMeanSquare === null || modelMeanSquare === null || (residualMeanSquare === 0 && modelMeanSquare === 0)
    ? null : modelMeanSquare / residualMeanSquare;
  const anova: DoeAnova = {
    model: { degreesOfFreedom: terms.length, sumSquares: modelSumSquares, meanSquare: modelMeanSquare,
      fStatistic: f !== null && Number.isFinite(f) ? f : null,
      pValue: f === null ? null : fUpperTail(f, terms.length, residualDegreesOfFreedom) },
    residual: { degreesOfFreedom: residualDegreesOfFreedom, sumSquares: residualSumSquares, meanSquare: residualMeanSquare },
    total: { degreesOfFreedom: runs.length - 1, sumSquares: total },
  };
  const diagnosticRows = prediction.map((row, index) => {
    const position = Math.max(0, Math.min(1, leverage[index]!));
    const remaining = 1 - position;
    const canDelete = residualDegreesOfFreedom > 0 && remaining > Number.EPSILON * Math.max(8, runs.length);
    const deleted = canDelete ? row.residual / remaining : NaN;
    const standardized = canDelete && residualMeanSquare !== null && residualMeanSquare > 0
      ? row.residual / Math.sqrt(residualMeanSquare * remaining) : NaN;
    return { ...row, leverage: position, deletedResidual: Number.isFinite(deleted) ? deleted : null,
      standardizedResidual: Number.isFinite(standardized) ? standardized : null };
  });
  const sumDeletedSquares = diagnosticRows.reduce((sum, row) => sum + (row.deletedResidual ?? NaN) ** 2, 0);
  const press = Number.isFinite(sumDeletedSquares) ? sumDeletedSquares : null;
  const factorNames = new Set(terms.flatMap((term) => Object.keys(term.powers)));
  const factorRanges = Object.fromEntries([...factorNames].map((name) => [name,
    runs.reduce((range, run) => {
      const value = run.factors[name]!;
      return { min: Math.min(range.min, value), max: Math.max(range.max, value) };
    }, { min: Infinity, max: -Infinity }),
  ]));
  return okay({
    intercept: coefficients[0]!,
    coefficients: Object.fromEntries(terms.map((term, index) => [term.id, unscaledCoefficients[index]!])),
    rows: diagnosticRows, rSquared, adjustedRSquared, residualDegreesOfFreedom, residualSumSquares, anova, press,
    predictedRSquared: press !== null && total > 0 && Number.isFinite(press / total) ? 1 - press / total : null,
    terms: terms.map((term) => ({ id: term.id, powers: { ...term.powers } })),
    factorRanges,
  });
}

export function predictDoeModel(fit: DoeFit, factors: Readonly<Record<string, number>>): Result<DoePrediction> {
  if (!isRecord(factors)) return failure("E_DOE_VALUE", "Prediction needs a record of named factor values.");
  const row = modelRow(factors, fit.terms);
  const predicted = fit.terms.reduce((sum, term, index) => sum + row[index + 1]! * fit.coefficients[term.id]!, fit.intercept);
  if (!Number.isFinite(predicted)) return failure("E_DOE_VALUE", "Prediction needs finite values for all model factors and terms.");
  const extrapolatedFactors = Object.entries(fit.factorRanges)
    .filter(([name, range]) => factors[name]! < range.min || factors[name]! > range.max).map(([name]) => name);
  const warnings: Diagnostic[] = extrapolatedFactors.length ? [{
    code: "W_DOE_EXTRAPOLATION", message: "Factors outside the observed ranges: " + extrapolatedFactors.join(", ") + ".",
  }] : [];
  return okay({ predicted, extrapolatedFactors }, warnings);
}
