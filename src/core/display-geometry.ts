import type { BaselineResult, Curve, Interval, PeakRow, XY } from "./types.ts";
import { baselineAt, coversRange } from "./baseline.ts";
import { interpolate, lowerBound, sampleCurve } from "./curve.ts";

export interface PeakFillPoint { x: number; top: number; bottom: number; }

const lineValue = (line: readonly [XY, XY], x: number) => interpolate(x, line[0].x, line[0].y, line[1].x, line[1].y);

export function samplePeakFill(
  curve: Curve, baseline: BaselineResult, row: PeakRow, visible: Interval,
): readonly PeakFillPoint[] {
  const bounds = row.integrationBounds ?? [row.bounds.left.x, row.bounds.right.x];
  const start = Math.max(visible[0], bounds[0]);
  const end = Math.min(visible[1], bounds[1]);
  if (!(start < end) || !coversRange(baseline.validRanges, [start, end])) return [];

  const xs = new Set([start, end]);
  for (let index = lowerBound(curve.x, start); index < curve.x.length && curve.x[index]! < end; index++) {
    xs.add(curve.x[index]!);
  }
  let lo = 0;
  let hi = baseline.points.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (baseline.points[mid]!.x < start) lo = mid + 1;
    else hi = mid;
  }
  for (let index = lo; index < baseline.points.length && baseline.points[index]!.x < end; index++) {
    xs.add(baseline.points[index]!.x);
  }
  for (const [first, last] of row.skimExtensions ?? []) {
    if (first.x > start && first.x < end) xs.add(first.x);
    if (last.x > start && last.x < end) xs.add(last.x);
  }

  const output: PeakFillPoint[] = [];
  for (const x of [...xs].sort((a, b) => a - b)) {
    const extension = row.skimExtensions?.find(([left, right]) => left.x <= x && x <= right.x);
    const top = extension ? lineValue(extension, x) : sampleCurve(curve, x);
    const bottom = row.skimLine ? lineValue(row.skimLine, x) : baselineAt(baseline.points, x);
    if (top === null || bottom === null || !Number.isFinite(top) || !Number.isFinite(bottom)) return [];
    output.push({ x, top, bottom });
  }
  return output;
}
