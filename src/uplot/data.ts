import type { AxisUnit, Curve, Result } from "../core/types.ts";
import { validateCurve } from "../core/curve.ts";
import { failure, okay } from "../core/result.ts";

export interface ChartView {
  xUnit: AxisUnit;
  curves: readonly Curve[];
}

export type AlignedChromatogramData = [number[] | Float64Array, ...((number | null | undefined)[] | Float64Array)[]];

export function toUPlotData(view: ChartView): Result<AlignedChromatogramData> {
  if (!view.curves.length) return okay([[]]);

  for (const curve of view.curves) {
    const checked = validateCurve(curve);
    if (!checked.ok) return checked;
    if (curve.xUnit !== view.xUnit) {
      return failure("E_AXIS_UNIT", "Convert each curve to the chart axis before aligning its points.", { curveId: curve.id });
    }
  }
  const first = view.curves[0]!.x;
  const shared = view.curves.every((curve) => curve.x === first ||
    (curve.x.length === first.length && curve.x.every((x, index) => first[index] === x)));
  if (shared) {
    return okay([first, ...view.curves.map((curve) => curve.missing
      ? Array.from(curve.y, (y, index) => curve.missing![index] ? null : y)
      : curve.y)]);
  }

  const coordinates = new Set<number>();
  for (const curve of view.curves) for (const x of curve.x) coordinates.add(x);
  const xs = [...coordinates].sort((a, b) => a - b);
  return okay([xs, ...view.curves.map((curve) => {
    let index = 0;
    return xs.map((x): number | null | undefined => {
      if (curve.x[index] !== x) return undefined;
      const value = curve.missing?.[index] ? null : curve.y[index];
      index++;
      return value;
    });
  })]);
}
