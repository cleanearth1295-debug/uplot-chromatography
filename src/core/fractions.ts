import type { Curve, Diagnostic, Fraction, Interval, Result } from "./types.ts";
import { isAxisUnit, validateCurve } from "./curve.ts";
import { measureValidatedInterval } from "./measure.ts";
import { failure, okay } from "./result.ts";

export interface FractionPool {
  trackId: string;
  fractionIds: readonly string[];
  xUnit: Fraction["xUnit"];
  range: Interval;
  volumeMl: number | null;
}
export interface FractionResult {
  fractionId: string;
  range: Interval;
  volumeMl: number;
  meanAbsorbanceMAU: number | null;
  concentrationMgMl: number | null;
  amountMg: number | null;
}

function checkFractions(fractions: readonly Fraction[]): Result<Map<string, Fraction>> {
  const byId = new Map<string, Fraction>();
  for (const fraction of fractions) {
    const [start, end] = fraction.range;
    if (!fraction.id || byId.has(fraction.id) || !fraction.trackId || !Number.isSafeInteger(fraction.sequence) ||
      !isAxisUnit(fraction.xUnit) || !Number.isFinite(start) || !Number.isFinite(end) || !(start < end) ||
      (fraction.volumeMl !== undefined && (!Number.isFinite(fraction.volumeMl) || fraction.volumeMl <= 0))) {
      return failure("E_FRACTION_METADATA", "Fraction IDs, ranges, units, sequence and volumes must be valid.");
    }
    byId.set(fraction.id, fraction);
  }
  return okay(byId);
}
export function poolFractions(fractions: readonly Fraction[], selected: readonly string[]): Result<readonly FractionPool[]> {
  const byId = checkFractions(fractions);
  if (!byId.ok) return byId;
  const active: Fraction[] = [];
  for (const id of new Set(selected)) {
    const fraction = byId.value.get(id);
    if (!fraction) return failure("E_FRACTION_ID", "Unknown fraction " + id + ".");
    active.push(fraction);
  }
  active.sort((a, b) => a.trackId.localeCompare(b.trackId) || a.sequence - b.sequence);
  const pools: FractionPool[] = [];
  let previous: Fraction | undefined;
  for (const fraction of active) {
    const last = pools.at(-1);
    const volumeMl = fraction.volumeMl ?? (fraction.xUnit === "mL" ? fraction.range[1] - fraction.range[0] : null);
    if (previous && last && previous.trackId === fraction.trackId && previous.xUnit === fraction.xUnit &&
      previous.sequence + 1 === fraction.sequence && previous.range[1] === fraction.range[0]) {
      pools[pools.length - 1] = {
        ...last, fractionIds: [...last.fractionIds, fraction.id], range: [last.range[0], fraction.range[1]],
        volumeMl: last.volumeMl !== null && volumeMl !== null ? last.volumeMl + volumeMl : null,
      };
    } else {
      pools.push({ trackId: fraction.trackId, fractionIds: [fraction.id], xUnit: fraction.xUnit, range: fraction.range, volumeMl });
    }
    previous = fraction;
  }
  return okay(pools);
}

export function fractionHistogram(
  curve: Curve, fractions: readonly Fraction[],
  options: { pathLengthCm?: number; extinctionByFraction?: Readonly<Record<string, number>> } = {},
): Result<readonly FractionResult[]> {
  const checked = validateCurve(curve);
  if (!checked.ok) return checked;
  const byId = checkFractions(fractions);
  if (!byId.ok) return byId;
  if (curve.xUnit !== "mL" || fractions.some((fraction) => fraction.xUnit !== "mL") ||
    !["AU", "mAU"].includes(curve.signalUnit)) {
    return failure("E_FRACTION_UNITS", "The UV signal and fraction boundaries must use measured mL and AU or mAU.");
  }
  const warnings: Diagnostic[] = [];
  const rows = fractions.map((fraction): FractionResult => {
    const [start, end] = fraction.range;
    const volumeMl = fraction.volumeMl ?? end - start;
    const measurement = measureValidatedInterval(curve, fraction.range);
    if (!measurement.ok) {
      warnings.push(...measurement.errors.map((issue) => ({ ...issue, message: fraction.id + ": " + issue.message })));
      return { fractionId: fraction.id, range: fraction.range, volumeMl, meanAbsorbanceMAU: null, concentrationMgMl: null, amountMg: null };
    }
    const meanAbsorbanceMAU = measurement.value.integral / volumeMl * (curve.signalUnit === "AU" ? 1000 : 1);
    const extinction = options.extinctionByFraction && Object.hasOwn(options.extinctionByFraction, fraction.id)
      ? options.extinctionByFraction[fraction.id] : undefined;
    const path = options.pathLengthCm;
    const usable = typeof path === "number" && Number.isFinite(path) && path > 0 &&
      typeof extinction === "number" && Number.isFinite(extinction) && extinction > 0;
    const concentrationMgMl = usable ? meanAbsorbanceMAU / (1000 * path * extinction) : null;
    if (!usable) warnings.push({ code: "W_FRACTION_QUANTITATION", message: fraction.id + ": positive extinction and optical path length are needed." });
    return {
      fractionId: fraction.id, range: fraction.range, volumeMl, meanAbsorbanceMAU, concentrationMgMl,
      amountMg: concentrationMgMl === null ? null : concentrationMgMl * volumeMl,
    };
  });
  return okay(rows, warnings);
}

export function activityHistogram(fractions: readonly Fraction[], activity: Readonly<Record<string, number>>) {
  const checked = checkFractions(fractions);
  if (!checked.ok) return checked;
  return okay(fractions.map((fraction) => ({
    fractionId: fraction.id, xUnit: fraction.xUnit, range: fraction.range,
    activity: Object.hasOwn(activity, fraction.id) && Number.isFinite(activity[fraction.id]) ? activity[fraction.id]! : null,
  })));
}
