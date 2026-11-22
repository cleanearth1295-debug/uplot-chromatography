import type { AxisUnit, Fraction, IntegrationConfig, PeakRow, Run } from "./types.ts";
import { mapCoordinate } from "./axis.ts";
import { theoreticalPlates } from "./column-performance.ts";

type ContextColumns = Pick<PeakRow, "retentionFactor" | "kav" | "plates" | "hetpCm" | "platesPerM" | "fractionIds">;

function positive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function mappedPoint(run: Run, x: number, from: AxisUnit, to: AxisUnit): number | null {
  const position = mapCoordinate(run, x, from, to);
  return position.ok && position.value.kind === "point" ? position.value.x : null;
}

export function peakContext(run: Run, config: IntegrationConfig): (row: PeakRow) => ContextColumns {
  const column = run.column;
  const injections = run.markers.filter((marker) => marker.kind === "injection");
  const marker = injections[0];
  const injection = config.injectionX ?? (marker === undefined ? 0 :
    injections.length === 1 ? mappedPoint(run, marker.x, marker.xUnit, config.xUnit) : null);
  const fractionsByUnit = new Map<AxisUnit, Fraction[]>();
  for (const fraction of run.fractions) {
    if (config.fractionTrackId !== undefined && fraction.trackId !== config.fractionTrackId) continue;
    const group = fractionsByUnit.get(fraction.xUnit);
    if (group) group.push(fraction);
    else fractionsByUnit.set(fraction.xUnit, [fraction]);
  }

  function fractionAt(x: number): string | null {
    let id: string | null = null;
    for (const [unit, fractions] of fractionsByUnit) {
      const mapped = mapCoordinate(run, x, config.xUnit, unit);
      if (!mapped.ok) continue;
      if (mapped.value.kind === "range") {
        const [lower, upper] = mapped.value.range;
        if (fractions.some(({ range: [start, end] }) => upper >= start && lower < end)) return null;
        continue;
      }
      const coordinate = mapped.value.x;
      for (const fraction of fractions) {
        if (!(coordinate >= fraction.range[0] && coordinate < fraction.range[1])) continue;
        if (id !== null) return null;
        id = fraction.id;
      }
    }
    return id;
  }

  return (row) => {
    const retention = injection === null ? NaN : row.apex.x - injection;
    const plates = theoreticalPlates(retention, row.halfHeightWidth);
    const bedHeight = column?.bedHeightCm;
    const heightMetrics = plates !== null && positive(bedHeight);
    const retentionMl = config.xUnit === "mL" ? retention : config.xUnit === "CV" && positive(column?.volumeMl) ?
      retention * column.volumeMl : NaN;
    const totalLiquid = column?.totalLiquidVolumeMl;
    const voidVolume = column?.voidVolumeMl;
    const columnVolume = column?.volumeMl;
    const [start, end] = row.integrationBounds ?? [row.bounds.left.x, row.bounds.right.x];
    return {
      plates, hetpCm: heightMetrics ? finiteOrNull(bedHeight / plates) : null,
      platesPerM: heightMetrics ? finiteOrNull(plates / (bedHeight / 100)) : null,
      retentionFactor: retentionMl >= 0 && positive(totalLiquid) ? finiteOrNull((retentionMl - totalLiquid) / totalLiquid) : null,
      kav: retentionMl >= 0 && column?.separationMode === "SEC" && positive(voidVolume) && positive(columnVolume) && columnVolume > voidVolume ?
        finiteOrNull((retentionMl - voidVolume) / (columnVolume - voidVolume)) : null,
      fractionIds: { start: fractionAt(start), apex: fractionAt(row.apex.x), end: fractionAt(end) },
    };
  };
}
