import type { PeakWindow, XY } from "./types.ts";
import { interpolate } from "./curve.ts";

export type Residual = { x: number; raw: number; baseline: number; y: number };
type SkimLine = readonly [XY, XY];
type Profile = { points: Residual[]; skimLine?: SkimLine; skimExtensions?: SkimLine[] };

// On a sampled trace a tangent can lie between the two segment slopes at a knot.
function findTangent(points: readonly Residual[], apex: number, sign: number): number | null {
  const valley = points[0]!;
  const direction = Math.sign(points.at(-1)!.x - valley.x);
  let minimum = Infinity;
  let contact: number | null = null;
  for (let index = 1; index < points.length; index++) {
    const point = points[index]!;
    const slope = sign * (point.raw - valley.raw) / (direction * (point.x - valley.x));
    if (slope < minimum) {
      minimum = slope;
      contact = index;
    }
  }
  if (contact === null || contact <= apex) return null;
  if (contact === points.length - 1) {
    const last = points[contact]!;
    const previous = points[contact - 1]!;
    const slope = sign * (last.raw - previous.raw) / (direction * (last.x - previous.x));
    if (Math.abs(slope - minimum) > 1e-12 * Math.max(Math.abs(slope), Math.abs(minimum))) return null;
  }
  return contact;
}

export function applySkimming(windows: readonly PeakWindow[], samples: readonly Residual[][], ratio: number): Profile[] {
  const profiles: Profile[] = samples.map((points) => ({ points }));
  const heights = samples.map((points, index) => {
    const sign = windows[index]!.polarity === "positive" ? 1 : -1;
    return points.reduce((height, point) => Math.max(height, sign * point.y), 0);
  });
  for (let index = 1; index < windows.length; index++) {
    const left = windows[index - 1]!;
    const right = windows[index]!;
    if (left.right.kind !== "dropline" || right.left.kind !== "dropline" || left.right.x !== right.left.x ||
      left.polarity !== right.polarity) continue;
    const sign = left.polarity === "positive" ? 1 : -1;
    const valley = sign * samples[index]![0]!.y;
    const taller = heights[index - 1]! >= heights[index]! ? index - 1 : index;
    const shoulder = 2 * index - 1 - taller;
    const rise = heights[shoulder]! - valley;
    if (!(rise > 0 && (heights[taller]! - valley) / rise > ratio)) continue;

    const mainProfile = profiles[taller]!;
    const shoulderProfile = profiles[shoulder]!;
    if (mainProfile.skimLine || shoulderProfile.skimLine || shoulderProfile.skimExtensions) continue;
    const isRight = shoulder === index;
    const ordered = isRight ? samples[shoulder]! : [...samples[shoulder]!].reverse();
    const apex = ordered.findIndex((point) => point.y * sign === heights[shoulder]);
    const contact = findTangent(ordered, apex, sign);
    if (contact === null) continue;

    const skimPoints = ordered.slice(0, contact + 1);
    const start = skimPoints[0]!;
    const end = skimPoints.at(-1)!;
    const heightsOnLine = skimPoints.map((point) => interpolate(point.x, start.x, start.raw, end.x, end.raw));
    if (skimPoints.some((point, i) => sign * (heightsOnLine[i]! - point.baseline) < 0)) continue;
    const cap = skimPoints.map((point, i) => ({ ...point, baseline: heightsOnLine[i]!, y: point.raw - heightsOnLine[i]! }));
    const extension = skimPoints.map((point, i) => ({ ...point, raw: heightsOnLine[i]!, y: heightsOnLine[i]! - point.baseline }));
    const line: SkimLine = [{ x: start.x, y: start.raw }, { x: end.x, y: end.raw }];
    shoulderProfile.points = isRight ? cap : cap.reverse();
    shoulderProfile.skimLine = isRight ? line : [line[1], line[0]];
    mainProfile.points = isRight ? [...mainProfile.points, ...extension.slice(1)] : [...extension.slice(1).reverse(), ...mainProfile.points];
    (mainProfile.skimExtensions ??= []).push(shoulderProfile.skimLine);
    // Any measured area beyond the supporting line's contact belongs to the main peak.
    const tail = ordered.slice(contact + 1);
    mainProfile.points = isRight ? [...mainProfile.points, ...tail] : [...tail.reverse(), ...mainProfile.points];
  }
  return profiles;
}
