import type { IntegrationConfig, PeakRow, XY } from "./types.ts";
import { interpolate } from "./curve.ts";

const quadratureFractions = [(1 - 1 / Math.sqrt(3)) / 2, (1 + 1 / Math.sqrt(3)) / 2];

// The piecewise-linear integral weights irregularly spaced samples by their actual x span.
export function peakMoments(points: readonly XY[], apex: number, sign: number): Pick<PeakRow, "centroid" | "sigma" | "momentStandardDeviation"> {
  let mass = 0;
  let firstMoment = 0;
  let secondMoment = 0;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const start = sign * a.y;
    const end = sign * b.y;
    if (start <= 0 && end <= 0) continue;
    const zero = start < 0 || end < 0 ? interpolate(0, start, a.x, end, b.x) : 0;
    const left = (start < 0 ? zero : a.x) - apex;
    const right = (end < 0 ? zero : b.x) - apex;
    const halfSpan = (right - left) / 2;
    // Two-point Gaussian quadrature integrates the cubic second-moment term exactly.
    for (const fraction of quadratureFractions) {
      const offset = left + (right - left) * fraction;
      const weight = halfSpan * (Math.max(0, start) * (1 - fraction) + Math.max(0, end) * fraction);
      mass += weight;
      firstMoment += weight * offset;
      secondMoment += weight * offset ** 2;
    }
  }
  const meanOffset = firstMoment / mass;
  const centroid = apex + meanOffset;
  const sigma = Math.sqrt(secondMoment / mass);
  const standardDeviation = Math.sqrt(Math.max(0, secondMoment / mass - meanOffset ** 2));
  return {
    centroid: Number.isFinite(centroid) ? centroid : null,
    sigma: Number.isFinite(sigma) ? sigma : null,
    momentStandardDeviation: Number.isFinite(standardDeviation) ? standardDeviation : null,
  };
}

export function peakResolution(previous: PeakRow | undefined, peak: PeakRow, method: IntegrationConfig["resolution"]): number | null {
  if (!previous) return null;
  let denominator: number;
  switch (method) {
    case "base-width": denominator = (previous.width + peak.width) / 2; break;
    case "sigma":
      if (previous.sigma === null || peak.sigma === null) return null;
      denominator = 2 * (previous.sigma + peak.sigma);
      break;
    case "half-height":
      if (previous.halfHeightWidth === null || peak.halfHeightWidth === null) return null;
      denominator = 2 * (previous.halfHeightWidth + peak.halfHeightWidth) / Math.sqrt(8 * Math.log(2));
      break;
  }
  const resolution = (peak.apex.x - previous.apex.x) / denominator;
  return denominator > 0 && resolution >= 0 && Number.isFinite(resolution) ? resolution : null;
}
