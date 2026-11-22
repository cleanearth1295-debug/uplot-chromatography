import type { Diagnostic, PeakRow, PeakTable, Result } from "./types.ts";
import { failure, okay } from "./result.ts";

export type ComparablePeak = Pick<PeakRow, "id" | "name" | "area" | "height" | "apex">;
export interface ComparisonInput {
  id: string;
  peaks: readonly ComparablePeak[];
}
export type MatchCriterion = { kind: "name" | "ordinal" | "area-rank" | "height-rank" }
  | { kind: "retention"; tolerance: number };
export interface PeakOverride {
  referenceId: string;
  tableId: string;
  peakId: string | null;
}
export interface PeakMatch {
  referenceId: string;
  tableId: string;
  status: "matched" | "missing" | "ambiguous";
  candidateIds: readonly string[];
  peak: ComparablePeak | null;
  overridden: boolean;
}

export interface PeakTableComparisonInput {
  id: string;
  table?: PeakTable | null;
}

export function comparePeakTables(
  reference: PeakTable,
  others: readonly PeakTableComparisonInput[],
  criteria: readonly MatchCriterion[],
  overrides: readonly PeakOverride[] = [],
): Result<readonly PeakMatch[]> {
  if (new Set(others.map(({ id }) => id)).size !== others.length) {
    return failure("E_PEAK_COMPARISON", "Compared run IDs must be unique.");
  }
  const compatible: ComparisonInput[] = [];
  const skipped = new Set<string>();
  const warnings: Diagnostic[] = [];
  for (const { id, table } of others) {
    if (!table) warnings.push({ code: "W_COMPARISON_UNINTEGRATED", message: id + " has no peak table." });
    else if (table.xUnit !== reference.xUnit) warnings.push({
      code: "W_COMPARISON_AXIS", message: id + " was integrated in " + table.xUnit + "; the reference uses " + reference.xUnit + ".",
    });
    else if (table.signalUnit !== reference.signalUnit || table.areaUnit !== reference.areaUnit) warnings.push({
      code: "W_COMPARISON_SIGNAL_UNIT", message: id + " has other signal or area units.",
    });
    else {
      compatible.push({ id, peaks: table.rows });
      continue;
    }
    skipped.add(id);
  }
  const result = matchPeaks(reference.rows, compatible, criteria, overrides.filter(({ tableId }) => !skipped.has(tableId)));
  return result.ok ? okay(result.value, [...result.warnings, ...warnings]) : result;
}

function ranks(peaks: readonly ComparablePeak[], key: "height" | "area"): Map<string, number> {
  const sorted = [...peaks].sort((a, b) => Math.abs(b[key]) - Math.abs(a[key]));
  let rank = 0;
  return new Map(sorted.map((peak, index) => {
    if (index === 0 || Math.abs(sorted[index - 1]![key]) !== Math.abs(peak[key])) rank = index + 1;
    return [peak.id, rank];
  }));
}

export function matchPeaks(reference: readonly ComparablePeak[], others: readonly ComparisonInput[],
  criteria: readonly MatchCriterion[], overrides: readonly PeakOverride[] = []): Result<readonly PeakMatch[]> {
  const unique = (ids: readonly string[]) => new Set(ids).size === ids.length && ids.every(Boolean);
  if (!criteria.length || criteria.some((item) => item.kind === "retention" && (!Number.isFinite(item.tolerance) || item.tolerance < 0)) ||
    !unique(others.map((table) => table.id)) || ![reference, ...others.map((table) => table.peaks)].every((peaks) =>
      unique(peaks.map((peak) => peak.id)) && peaks.every((peak) => [peak.area, peak.height, peak.apex.x].every(Number.isFinite)))) {
    return failure("E_PEAK_COMPARISON", "Peak comparisons require unique IDs, numeric metrics and valid criteria.");
  }
  const referenceSort = [...reference].sort((a, b) => a.apex.x - b.apex.x);
  const referenceArea = ranks(reference, "area");
  const referenceHeight = ranks(reference, "height");
  const claimed = new Set<string>();
  for (const override of overrides) {
    const table = others.find((table) => table.id === override.tableId);
    const key = JSON.stringify([override.tableId, override.referenceId]);
    if (claimed.has(key) || !reference.some(({ id }) => id === override.referenceId) || !table ||
      (override.peakId !== null && !table.peaks.some(({ id }) => id === override.peakId))) {
      return failure("E_PEAK_OVERRIDE", "The override contains a duplicate or unknown reference.");
    }
    claimed.add(key);
  }

  const matches: PeakMatch[] = [];
  for (const table of others) {
    const sorted = [...table.peaks].sort((a, b) => a.apex.x - b.apex.x);
    const byArea = ranks(sorted, "area");
    const byHeight = ranks(sorted, "height");
    for (const [i, peak] of referenceSort.entries()) {
      const override = overrides.find((item) => item.tableId === table.id && item.referenceId === peak.id);
      const candidates = override ? sorted.filter((item) => item.id === override.peakId) : sorted.filter((item, j) =>
        criteria.every((criterion) => {
          switch (criterion.kind) {
            case "name": return !!peak.name && item.name === peak.name;
            case "ordinal": return i === j;
            case "area-rank": return referenceArea.get(peak.id) === byArea.get(item.id);
            case "height-rank": return referenceHeight.get(peak.id) === byHeight.get(item.id);
            case "retention": return Math.abs(peak.apex.x - item.apex.x) <= criterion.tolerance;
          }
        }));
      matches.push({
        referenceId: peak.id, tableId: table.id, candidateIds: candidates.map(({ id }) => id),
        status: candidates.length === 1 ? "matched" : candidates.length ? "ambiguous" : "missing",
        peak: candidates.length === 1 ? candidates[0]! : null, overridden: !!override,
      });
    }
  }

  const used = new Map<string, PeakMatch[]>();
  for (const item of matches) {
    if (!item.peak) continue;
    const key = JSON.stringify([item.tableId, item.peak.id]);
    if (!used.has(key)) used.set(key, []);
    used.get(key)!.push(item);
  }
  for (const shared of used.values()) {
    if (shared.length < 2) continue;
    const uniqueOverride = shared.filter((item) => item.overridden);
    for (const item of shared) {
      if (uniqueOverride.length === 1 && item === uniqueOverride[0]) continue;
      item.peak = null;
      item.status = "ambiguous";
    }
  }
  return okay(matches);
}

export function summarizeMatches(matches: readonly PeakMatch[], field: "area" | "height" | "retention" = "area") {
  const groups = new Map<string, number[]>();
  for (const entry of matches) {
    if (!groups.has(entry.referenceId)) groups.set(entry.referenceId, []);
    if (!entry.peak || entry.status !== "matched") continue;
    const number = field === "retention" ? entry.peak.apex.x : entry.peak[field];
    if (!Number.isFinite(number)) return failure("E_PEAK_COMPARISON", "Compared values must be finite.");
    groups.get(entry.referenceId)!.push(number);
  }
  return okay([...groups].map(([referenceId, values]) => {
    const n = values.length;
    const mean = n ? values.reduce((sum, value) => sum + value / n, 0) : null;
    const sd = n > 1 && mean !== null ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : null;
    return { referenceId, n, mean, sd, cvPercent: mean && sd !== null ? sd / Math.abs(mean) * 100 : null };
  }));
}
