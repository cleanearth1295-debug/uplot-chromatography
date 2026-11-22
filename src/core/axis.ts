import type { AxisUnit, Curve, Interval, Result, Run } from "./types.ts";
import { interpolate, isAxisUnit, lowerBound, sampleCurve, validateCurve } from "./curve.ts";
import { failure, okay } from "./result.ts";

export type Coordinate = { kind: "point"; x: number } | { kind: "range"; range: Interval };

function validateTimeVolume(run: Run): Result<NonNullable<Run["timeVolume"]>> {
  const mapping = run.timeVolume;
  if (!mapping || mapping.timeMin.length < 2 || mapping.timeMin.length !== mapping.volumeMl.length) {
    return failure("E_TIME_VOLUME_MAP", "Two or more paired time and volume observations are required.");
  }
  for (let index = 0; index < mapping.timeMin.length; index++) {
    const time = mapping.timeMin[index]!;
    const volume = mapping.volumeMl[index]!;
    if (!Number.isFinite(time) || !Number.isFinite(volume) ||
      (index > 0 && (time <= mapping.timeMin[index - 1]! || volume < mapping.volumeMl[index - 1]!))) {
      return failure("E_TIME_VOLUME_MAP", "Time must increase strictly and volume must not decrease.", { index });
    }
  }
  return okay(mapping);
}

function coordinateMapper(run: Run, from: AxisUnit, to: AxisUnit): Result<(x: number) => Result<Coordinate>> {
  if (!isAxisUnit(from) || !isAxisUnit(to)) return failure("E_AXIS_UNIT", "The requested axis unit is unsupported.");
  if (from === to) return okay((x) => okay({ kind: "point", x }));
  const volumeMl = run.column?.volumeMl;
  if ((from === "CV" || to === "CV") && (!Number.isFinite(volumeMl) || volumeMl! <= 0)) {
    return failure("E_COLUMN_VOLUME", "A positive column volume is required to convert CV.");
  }

  const basisFrom = from === "CV" ? "mL" : from;
  const basisTo = to === "CV" ? "mL" : to;
  const forward = (x: number) => from === "CV" ? x * volumeMl! : x;
  const finish = (x: number): Result<Coordinate> => {
    const mapped = to === "CV" ? x / volumeMl! : x;
    return Number.isFinite(mapped) ? okay({ kind: "point", x: mapped }) : failure("E_COORDINATE", "The converted coordinate is not finite.");
  };
  if (basisFrom === basisTo) return okay((x) => finish(forward(x)));

  const result = validateTimeVolume(run);
  if (!result.ok) return result;
  const { timeMin, volumeMl: measuredVolume } = result.value;
  const source = basisFrom === "min" ? timeMin : measuredVolume;
  const target = basisFrom === "min" ? measuredVolume : timeMin;
  return okay((x) => {
    const input = forward(x);
    const index = lowerBound(source, input);
    if (index === source.length || input < source[0]!) {
      return failure("E_COORDINATE_RANGE", "The coordinate is outside the measured conversion range.");
    }
    if (source[index] === input) {
      let end = index;
      while (source[end + 1] === input) end++;
      if (end > index) return okay({ kind: "range", range: [target[index]!, target[end]!] });
      return finish(target[index]!);
    }
    return finish(interpolate(input, source[index - 1]!, target[index - 1]!, source[index]!, target[index]!));
  });
}

export function mapCoordinate(run: Run, x: number, from: AxisUnit, to: AxisUnit): Result<Coordinate> {
  if (!Number.isFinite(x)) return failure("E_COORDINATE", "The requested coordinate must be finite.");
  const mapping = coordinateMapper(run, from, to);
  return mapping.ok ? mapping.value(x) : mapping;
}

export function resolveCurveAxis(run: Run, curveId: string, unit: AxisUnit): Result<Curve> {
  const curve = run.curves.find((item) => item.id === curveId);
  if (!curve) return failure("E_CURVE_ID", "The requested curve is not in the run.", { curveId });
  const checked = validateCurve(curve);
  if (!checked.ok || curve.xUnit === unit) return checked;

  const mapping = coordinateMapper(run, curve.xUnit, unit);
  if (!mapping.ok) return mapping;
  const coordinates = new Set(curve.x);
  if ((curve.xUnit === "min" || unit === "min") && run.timeVolume) {
    const breakpoints = curve.xUnit === "min" ? run.timeVolume.timeMin : run.timeVolume.volumeMl;
    for (const knot of breakpoints) {
      const source = curve.xUnit === "CV" ? knot / run.column!.volumeMl! : knot;
      if (source > curve.x[0]! && source < curve.x.at(-1)!) coordinates.add(source);
    }
  }
  const original = [...coordinates].sort((first, second) => first - second);
  const x = new Float64Array(original.length);
  const y = new Float64Array(original.length);
  const missing = new Uint8Array(original.length);
  for (let index = 0; index < original.length; index++) {
    const value = original[index]!;
    const position = mapping.value(value);
    if (!position.ok) return position;
    if (position.value.kind === "range" || (index > 0 && position.value.x <= x[index - 1]!)) {
      return failure("E_AXIS_AMBIGUOUS", "Conversion does not give a unique, increasing sample grid.", { curveId, index });
    }
    x[index] = position.value.x;
    const signal = sampleCurve(curve, value);
    y[index] = signal ?? 0;
    if (signal === null) missing[index] = 1;
  }
  return okay({ ...curve, x, y, missing: missing.some(Boolean) ? missing : undefined, xUnit: unit });
}
