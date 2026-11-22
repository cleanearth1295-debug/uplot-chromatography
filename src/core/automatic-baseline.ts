import type { BaselineSpec, Curve, Interval, Result, XY } from "./types.ts";
import { interpolate, lowerBound } from "./curve.ts";
import { failure, okay } from "./result.ts";

type AutomaticSpec = Extract<BaselineSpec, { kind: "morphological" | "classical" }>;
interface AutomaticGeometry {
  points: readonly XY[];
  validRanges: readonly Interval[];
}

function slidingExtreme(x: Float64Array, y: Float64Array, radius: number, sign: 1 | -1): Float64Array {
  const output = new Float64Array(y.length);
  const candidates = new Uint32Array(y.length);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < x.length; i++) {
    const center = x[i]!;
    while (head < tail && x[candidates[head]!]! < center - radius) head++;
    while (next < x.length && x[next]! <= center + radius) {
      while (head < tail && sign * y[candidates[tail - 1]!]! <= sign * y[next]!) tail--;
      candidates[tail++] = next++;
    }
    output[i] = y[candidates[head]!]!;
  }
  return output;
}
function morphology(x: Float64Array, y: Float64Array, width: number, spacing: number): XY[] {
  const radius = width / 2;
  const eroded = slidingExtreme(x, y, radius, -1);
  const opened = slidingExtreme(x, eroded, radius, 1);
  const output: XY[] = [{ x: x[0]!, y: opened[0]! }];
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i]! - output.at(-1)!.x >= spacing) output.push({ x: x[i]!, y: opened[i]! });
  }
  output.push({ x: x.at(-1)!, y: opened.at(-1)! });
  return output;
}

function classical(x: Float64Array, y: Float64Array, spec: Extract<AutomaticSpec, { kind: "classical" }>): XY[] {
  const qualifying = new Set<number>();
  let i = 0;
  while (i < x.length - 1) {
    const end = lowerBound(x, x[i]! + spec.minSegment);
    if (end === x.length) break;
    const rise = y[end]! - y[i]!;
    const slope = rise / (x[end]! - x[i]!);
    if (Math.abs(slope) <= spec.maxSlope && Math.max(y[i]!, y[end]!) <= spec.maxLevel) {
      let accepted = true;
      for (let sample = i + 1; sample < end; sample++) {
        const predicted = interpolate(x[sample]!, x[i]!, y[i]!, x[end]!, y[end]!);
        if (Math.abs(y[sample]! - predicted) > spec.noiseWindow || y[sample]! > spec.maxLevel) {
          accepted = false;
          break;
        }
      }
      if (accepted) {
        qualifying.add(i);
        qualifying.add(end);
      }
    }
    const next = lowerBound(x, x[i]! + spec.minSegment / 3);
    i = Math.max(i + 1, next);
  }

  if (qualifying.size < 2) return [];
  const anchors = [...qualifying].sort((a, b) => a - b);
  let position = 0;
  return Array.from(x, (value, index) => {
    while (position + 1 < anchors.length && anchors[position + 1]! <= index) position++;
    const left = anchors[position]!;
    const right = anchors[position + 1];
    const base = index <= left || right === undefined ? y[left]! : interpolate(value, x[left]!, y[left]!, x[right]!, y[right]!);
    return { x: value, y: base };
  });
}

export function automaticBaseline(curve: Curve, spec: AutomaticSpec): Result<AutomaticGeometry> {
  const valid = spec.kind === "morphological" ? Number.isFinite(spec.structureWidth) && spec.structureWidth > 0 &&
    Number.isFinite(spec.minAnchorDistance) && spec.minAnchorDistance >= 0 :
    [spec.minSegment, spec.noiseWindow, spec.maxLevel, spec.maxSlope].every(Number.isFinite) &&
    spec.minSegment > 0 && spec.noiseWindow >= 0 && spec.maxSlope >= 0;
  if (!valid) return failure("E_BASELINE_SETTINGS", "Automatic baseline parameters are outside their supported range.", { curveId: curve.id });

  const points: XY[] = [];
  const validRanges: Interval[] = [];
  let start = 0;
  while (start < curve.x.length) {
    if (curve.missing?.[start]) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < curve.x.length && !curve.missing?.[end]) end++;
    if (end - start >= 2) {
      const x = curve.x.slice(start, end);
      const y = curve.y.slice(start, end);
      const geometry = spec.kind === "morphological" ? morphology(x, y, spec.structureWidth, spec.minAnchorDistance) : classical(x, y, spec);
      if (geometry.length >= 2) {
        for (const point of geometry) points.push(point);
        validRanges.push([x[0]!, x.at(-1)!]);
      }
    }
    start = end;
  }
  return validRanges.length ? okay({ points, validRanges }) :
    failure("E_BASELINE_RANGE", "The supplied settings did not identify a usable baseline segment.", { curveId: curve.id });
}
