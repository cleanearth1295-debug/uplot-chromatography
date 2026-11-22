import type { XY } from "./types.ts";
import { interpolate, lowerBound } from "./curve.ts";

export function evaluateSpline(anchors: readonly XY[], sampleAt: Float64Array, straight: readonly number[]): XY[] {
  const xs = Float64Array.from(anchors, ({ x }) => x);
  const curvature = new Float64Array(anchors.length);
  const factors = new Float64Array(anchors.length);
  for (let i = 1; i < anchors.length - 1; i++) {
    const left = anchors[i - 1]!;
    const knot = anchors[i]!;
    const right = anchors[i + 1]!;
    const dxLeft = knot.x - left.x;
    const dxRight = right.x - knot.x;
    const ratio = dxLeft / (dxLeft + dxRight);
    const pivot = ratio * curvature[i - 1]! + 2;
    curvature[i] = (ratio - 1) / pivot;
    const slope = (right.y - knot.y) / dxRight - (knot.y - left.y) / dxLeft;
    factors[i] = (6 * slope / (dxLeft + dxRight) - ratio * factors[i - 1]!) / pivot;
  }
  for (let i = anchors.length - 2; i >= 1; i--) {
    curvature[i] = curvature[i]! * curvature[i + 1]! + factors[i]!;
  }

  const sample = new Set(xs);
  const linear = new Set(straight);
  for (const x of sampleAt) if (x > xs[0]! && x < xs.at(-1)!) sample.add(x);
  for (let i = 0; i < anchors.length - 1; i++) {
    if (linear.has(i)) continue;
    const x0 = xs[i]!;
    const dx = xs[i + 1]! - x0;
    for (let n = 1; n < 8; n++) sample.add(x0 + n * dx / 8);
  }

  return [...sample].sort((a, b) => a - b).map((x) => {
    const i = lowerBound(xs, x);
    const right = anchors[i]!;
    if (right.x === x) return { ...right };
    const left = anchors[i - 1]!;
    const width = right.x - left.x;
    const y = interpolate(x, left.x, left.y, right.x, right.y);
    if (linear.has(i - 1)) return { x, y };
    const a = (right.x - x) / width;
    const b = (x - left.x) / width;
    return { x, y: y + ((a ** 3 - a) * curvature[i - 1]! + (b ** 3 - b) * curvature[i]!) * width ** 2 / 6 };
  });
}
