import type { AnalysisState, Curve, Result } from "../core/types.ts";
import { failure, okay } from "../core/result.ts";
import { decodeSnapshot, encodeSnapshot } from "./snapshot.ts";

export interface ResultMetadata {
  folder?: string;
  batchId?: string;
  sampleId?: string;
  author?: string;
  readOnly?: boolean;
  archived?: boolean;
  createdAt?: string;
}
export interface ResultSummary extends ResultMetadata {
  id: string;
  name: string;
  revision: number;
}
export interface ResultQuery {
  query?: string;
  folder?: string;
  descendants?: boolean;
  batchId?: string;
  sampleId?: string;
  author?: string;
  includeArchived?: boolean;
}
type StoredResult = { summary: ResultSummary; snapshot: string };

function sameSamples(a: Curve, b: Curve): boolean {
  return a.kind === b.kind && a.xUnit === b.xUnit && a.signalUnit === b.signalUnit &&
    a.sourceChromatogramId === b.sourceChromatogramId && (a.sourceLabel ?? a.label) === (b.sourceLabel ?? b.label) &&
    a.x.length === b.x.length && a.x.every((x, i) => x === b.x[i] &&
      (a.missing?.[i] ?? 0) === (b.missing?.[i] ?? 0) && (a.missing?.[i] === 1 || a.y[i] === b.y[i]));
}
function matchName(name: string, query: string): boolean {
  const target = name.toLocaleLowerCase();
  const phrase = query.toLocaleLowerCase();
  if (!phrase.includes("*")) return target.includes(phrase);
  const parts = phrase.split("*");
  const first = parts.shift()!;
  const last = parts.pop()!;
  if (!target.startsWith(first) || !target.endsWith(last) || first.length + last.length > target.length) return false;
  let offset = first.length;
  const limit = target.length - last.length;
  for (const part of parts) {
    if (!part) continue;
    const next = target.indexOf(part, offset);
    if (next < 0 || next + part.length > limit) return false;
    offset = next + part.length;
  }
  return true;
}

function copyRun(state: AnalysisState, id: string, name: string): AnalysisState {
  const remap = (scope: string, keys: readonly string[]) => new Map(keys.map((old, i) => [old, id + ":" + scope + ":" + (i + 1)]));
  const charts = remap("chromatogram", state.run.chromatograms.map((chart) => chart.id));
  const curves = remap("curve", state.run.curves.map((curve) => curve.id));
  const baselines = remap("baseline", state.baselines.map((base) => base.id));
  const tables = remap("table", state.peakTables.map((table) => table.id));

  return {
    ...state, revision: 0, activeCurveId: curves.get(state.activeCurveId)!,
    activeChromatogramId: charts.get(state.activeChromatogramId)!,
    activeBaselineId: state.activeBaselineId === undefined ? undefined : baselines.get(state.activeBaselineId),
    activePeakTableId: state.activePeakTableId === undefined ? undefined : tables.get(state.activePeakTableId),
    run: {
      ...state.run, id, name,
      curves: state.run.curves.map((curve) => ({
        ...curve, id: curves.get(curve.id)!, runId: id, sourceChromatogramId: charts.get(curve.sourceChromatogramId)!,
        sourceCurveIds: curve.sourceCurveIds?.map((ref) => curves.get(ref) ?? ref),
      })),
      chromatograms: state.run.chromatograms.map((chart) => ({
        ...chart, id: charts.get(chart.id)!,
        curveRefs: chart.curveRefs.map((ref) => ref.runId === state.run.id ? ({
          ...ref, runId: id, chromatogramId: charts.get(ref.chromatogramId) ?? ref.chromatogramId,
          curveId: curves.get(ref.curveId) ?? ref.curveId,
        }) : ref),
        peakTableIds: chart.peakTableIds.map((ref) => tables.get(ref)!),
      })),
    },
    baselines: state.baselines.map((base) => ({
      ...base, id: baselines.get(base.id)!, curveId: curves.get(base.curveId)!,
      spec: base.spec.kind === "curve" ? { ...base.spec, baselineCurveId: curves.get(base.spec.baselineCurveId) ?? base.spec.baselineCurveId } : base.spec,
    })),
    peakTables: state.peakTables.map((table) => ({
      ...table, id: tables.get(table.id)!, curveId: curves.get(table.curveId)!,
      chromatogramId: charts.get(table.chromatogramId)!, baselineId: baselines.get(table.baselineId)!,
    })),
  };
}

export function createResultStore() {
  const entries = new Map<string, StoredResult>();
  const recent = new Set<string>();

  function add(state: AnalysisState, meta: ResultMetadata = {}): Result<ResultSummary> {
    if (!state.run.id.trim() || entries.has(state.run.id)) return failure("E_RESULT_ID", "A new result requires a unique ID.");
    const snapshot = encodeSnapshot(state);
    const checked = decodeSnapshot(snapshot);
    if (!checked.ok) return checked;
    const summary = { ...meta, id: state.run.id, name: state.run.name, revision: state.revision };
    entries.set(summary.id, { summary, snapshot });
    return okay({ ...summary });
  }

  function open(id: string): Result<{ state: AnalysisState; metadata: ResultSummary }> {
    const entry = entries.get(id);
    if (!entry) return failure("E_RESULT_ID", "The result does not exist.");
    const state = decodeSnapshot(entry.snapshot);
    if (!state.ok) return state;
    recent.delete(id);
    recent.add(id);
    return okay({ state: state.value, metadata: { ...entry.summary } });
  }

  function save(state: AnalysisState, expectedRevision: number): Result<ResultSummary> {
    const entry = entries.get(state.run.id);
    if (!entry) return failure("E_RESULT_ID", "The result does not exist.");
    if (entry.summary.readOnly || entry.summary.archived) return failure("E_RESULT_READ_ONLY", "This result can only be saved as a new copy.");
    if (entry.summary.revision !== expectedRevision || !Number.isSafeInteger(expectedRevision + 1)) {
      return failure("E_RESULT_CONFLICT", "The stored result has revision " + entry.summary.revision + ".");
    }
    const current = decodeSnapshot(entry.snapshot);
    if (!current.ok) return current;
    const byId = new Map(state.run.curves.map((curve) => [curve.id, curve]));
    for (const curve of current.value.run.curves) {
      if (curve.kind !== "measured") continue;
      const proposed = byId.get(curve.id);
      if (!proposed || !sameSamples(curve, proposed)) return failure("E_RAW_CURVE", "A measured curve cannot be rewritten or removed.", { curveId: curve.id });
    }
    const snapshot = encodeSnapshot({ ...state, revision: expectedRevision + 1 });
    const checked = decodeSnapshot(snapshot);
    if (!checked.ok) return checked;
    const summary = { ...entry.summary, name: state.run.name, revision: expectedRevision + 1 };
    entries.set(summary.id, { summary, snapshot });
    return okay({ ...summary });
  }

  function saveAs(state: AnalysisState, destination: { id: string; name: string; folder?: string }): Result<AnalysisState> {
    const checked = decodeSnapshot(encodeSnapshot(state));
    if (!checked.ok) return checked;
    const result = copyRun(checked.value, destination.id, destination.name);
    const saved = add(result, { folder: destination.folder });
    return saved.ok ? okay(result) : saved;
  }

  function search(query: ResultQuery = {}): readonly ResultSummary[] {
    const summaries = [...entries.values()].map(({ summary }) => summary);
    return summaries.filter((item) => {
      const folder = query.folder?.replace(/\/$/, "");
      return (query.includeArchived || !item.archived) &&
        (folder === undefined || item.folder === folder || (query.descendants && item.folder?.startsWith(folder + "/"))) &&
        (!query.query || matchName(item.name, query.query)) &&
        (query.batchId === undefined || item.batchId === query.batchId) &&
        (query.sampleId === undefined || item.sampleId === query.sampleId) &&
        (query.author === undefined || item.author === query.author);
    }).map((summary) => ({ ...summary }));
  }

  return {
    add, open, save, saveAs, search,
    recent: (limit = 10) => [...recent].reverse().slice(0, Math.max(0, limit)).map((id) => ({ ...entries.get(id)!.summary })),
    clearRecent: () => recent.clear(),
  };
}

export type ResultStore = ReturnType<typeof createResultStore>;
