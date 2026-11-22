import type { AnalysisState, BaselineResult, Curve, Interval, PeakEdit, PeakTable, PeakWindow, Result } from "./types.ts";
import { resolveCurveAxis } from "./axis.ts";
import { detectPeaks } from "./detect.ts";
import { integratePeaks } from "./integrate.ts";
import { failure, okay } from "./result.ts";

function updatePeakWindows(
  state: AnalysisState,
  expectedRevision: number | undefined,
  update: (curve: Curve, baseline: BaselineResult, table: PeakTable) => Result<readonly PeakWindow[]>,
): Result<AnalysisState> {
  if (expectedRevision !== undefined && expectedRevision !== state.revision) {
    return failure("E_STALE_EDIT", "The analysis changed after this edit started.");
  }
  const current = state.peakTables.find((table) => table.id === state.activePeakTableId);
  const baseline = state.baselines.find((entry) => entry.id === current?.baselineId);
  if (!current || !baseline || current.curveId !== state.activeCurveId) {
    return failure("E_ACTIVE_PEAK_TABLE", "An active peak table and its baseline are needed.");
  }
  const curve = resolveCurveAxis(state.run, current.curveId, current.xUnit);
  if (!curve.ok) return curve;
  const edited = update(curve.value, baseline, current);
  if (!edited.ok) return edited;
  const windows = edited.value;
  const recalculated = integratePeaks(curve.value, baseline, windows, current.config, state.run);
  if (!recalculated.ok) return recalculated;

  return okay({
    ...state, revision: state.revision + 1, windows,
    peakTables: state.peakTables.map((table) => table.id === current.id
      ? { ...recalculated.value, id: table.id, chromatogramId: table.chromatogramId }
      : table),
  }, [...edited.warnings, ...recalculated.warnings]);
}

export function applyPeakEdit(state: AnalysisState, edit: PeakEdit): Result<AnalysisState> {
  return updatePeakWindows(state, edit.expectedRevision, () => applyWindowEdit(state.windows, edit));
}

/** Re-detect windows in the selection with the active settings and existing full baseline. */
export function reintegratePeakRange(state: AnalysisState, range: Interval, expectedRevision?: number): Result<AnalysisState> {
  return updatePeakWindows(state, expectedRevision, (curve, baseline, table) => {
    const domain = table.config.window ?? [curve.x[0]!, curve.x.at(-1)!];
    let [left, right] = range;
    if (!range.every(Number.isFinite) || !(left < right) || left < domain[0] || right > domain[1]) {
      return failure("E_INTEGRATION_RANGE", "The reintegration range must lie inside the active integration range.", { range });
    }

    // Preserve a peak that crosses either selection boundary as a whole.
    const preserved: PeakWindow[] = [];
    const replaceable: PeakWindow[] = [];
    for (const peak of state.windows) {
      if (peak.left.x >= range[0] && peak.right.x <= range[1]) {
        replaceable.push(peak);
      } else {
        preserved.push(peak);
        if (peak.left.x < range[0] && peak.right.x > range[0]) left = Math.max(left, peak.right.x);
        if (peak.left.x < range[1] && peak.right.x > range[1]) right = Math.min(right, peak.left.x);
      }
    }
    if (left >= right) return okay(state.windows);
    const detected = detectPeaks(curve, baseline, { ...table.config, window: [left, right] });
    if (!detected.ok) return detected;
    const reserved = new Set(state.windows.map(({ id }) => id));
    let sequence = 1;
    const replacements = detected.value.map((peak) => {
      const original = replaceable.find((old) => old.left.x === peak.left.x && old.right.x === peak.right.x && old.polarity === peak.polarity);
      const previous = preserved.find((old) => old.right.x === peak.left.x && old.polarity === peak.polarity && old.right.kind === "dropline");
      const next = preserved.find((old) => old.left.x === peak.right.x && old.polarity === peak.polarity && old.left.kind === "dropline");
      while (reserved.has(`p${sequence}`)) sequence++;
      return {
        ...peak, id: original?.id ?? `p${sequence++}`, name: original?.name,
        left: previous?.right ?? peak.left, right: next?.left ?? peak.right,
      };
    });
    return okay([...preserved, ...replacements].sort((a, b) => a.left.x - b.left.x), detected.warnings);
  });
}

function applyWindowEdit(input: readonly PeakWindow[], edit: PeakEdit): Result<readonly PeakWindow[]> {
  const windows = [...input].sort((a, b) => a.left.x - b.left.x);
  const position = windows.findIndex((window) => window.id === edit.peakId);
  const peak = windows[position];
  if (!peak) return failure("E_PEAK_ID", "The requested peak is not in the current table.");

  switch (edit.op) {
    case "move-limit": {
      const at = peak[edit.edge];
      const otherEdge = edit.edge === "right" ? "left" : "right";
      const neighborIndex = position + (edit.edge === "right" ? 1 : -1);
      const next = windows[neighborIndex];
      const shared = next && at.kind === "dropline" && next[otherEdge].kind === "dropline" && next[otherEdge].x === at.x;
      const replacement = { x: edit.x, kind: shared ? "dropline" as const : "manual" as const };
      windows[position] = { ...peak, [edit.edge]: replacement };
      if (shared) windows[neighborIndex] = { ...next, [otherEdge]: replacement };
      break;
    }
    case "split": {
      if (!edit.newPeakId || windows.some((window) => window.id === edit.newPeakId)) {
        return failure("E_PEAK_ID", "A split requires a distinct new peak ID.");
      }
      const x = edit.x ?? (peak.left.x / 2 + peak.right.x / 2);
      const dropline = { x, kind: "dropline" as const };
      windows.splice(position, 1, { ...peak, right: dropline }, {
        ...peak, id: edit.newPeakId, left: dropline,
      });
      break;
    }
    case "join-left":
    case "join-right": {
      const leftIndex = edit.op === "join-left" ? position - 1 : position;
      const left = windows[leftIndex];
      const right = windows[leftIndex + 1];
      if (!left || !right || left.polarity !== right.polarity || left.right.kind !== "dropline" ||
        right.left.kind !== "dropline" || left.right.x !== right.left.x) {
        return failure("E_PEAK_JOIN", "Join requires neighboring same-polarity peaks with a shared dropline.");
      }
      windows.splice(leftIndex, 2, { ...peak, left: left.left, right: right.right });
      break;
    }
    case "remove":
      windows.splice(position, 1);
      break;
    case "rename":
      windows[position] = { ...peak, name: edit.name.trim() || undefined };
      break;
  }
  return okay(windows);
}
