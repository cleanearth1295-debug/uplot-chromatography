import type { PeakRow, Result } from "./types.ts";
import { failure, okay } from "./result.ts";

export interface ColumnPerformance {
  plates: number;
  hetpCm: number;
  platesPerM: number;
  asymmetry: number | null;
  reducedPlateHeight: number | null;
}

export function theoreticalPlates(retention: number, width: number | null): number | null {
  if (!Number.isFinite(retention) || retention <= 0 || width === null || !Number.isFinite(width) || width <= 0) return null;
  const plates = 5.54 * (retention / width) ** 2;
  return Number.isFinite(plates) && plates > 0 ? plates : null;
}

export function evaluateColumnPerformance(
  peak: Pick<PeakRow, "apex" | "halfHeightWidth" | "asymmetry">,
  column: { bedHeightCm: number; particleDiameterUm?: number },
  options: { injectionX?: number } = {},
): Result<ColumnPerformance> {
  const retention = peak.apex.x - (options.injectionX ?? 0);
  const width = peak.halfHeightWidth;
  const height = column.bedHeightCm;
  if (!Number.isFinite(retention) || retention <= 0 || width === null || !Number.isFinite(width) || width <= 0 ||
    !Number.isFinite(height) || height <= 0) {
    return failure("E_COLUMN_PERFORMANCE", "Positive retention from injection, half-height width and bed height are required.");
  }
  const plates = theoreticalPlates(retention, width);
  if (plates === null) return failure("E_COLUMN_PERFORMANCE", "Computed plate metrics exceed numeric limits.");
  const hetpCm = height / plates;
  const platesPerM = plates / (height / 100);
  const particle = column.particleDiameterUm;
  const reducedPlateHeight = particle !== undefined && Number.isFinite(particle) && particle > 0 ? hetpCm * 10_000 / particle : null;
  if (![plates, hetpCm, platesPerM].every(Number.isFinite)) return failure("E_COLUMN_PERFORMANCE", "Computed plate metrics exceed numeric limits.");
  return okay({ plates, hetpCm, platesPerM, asymmetry: peak.asymmetry, reducedPlateHeight });
}
