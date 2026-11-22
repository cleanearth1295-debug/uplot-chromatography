import uPlot from "uplot";
import { applyPeakEdit, calculateBaseline, defaultIntegrationConfig, integratePeaks } from "uplot-chromatography";
import type { AnalysisState, PeakWindow, Result } from "uplot-chromatography";
import { parseUnicornCurves } from "uplot-chromatography/io";
import { createChromatogramPlugin, toUPlotData } from "uplot-chromatography/uplot";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.errors[0]?.message);
  return result.value;
}

export function mountChromatogram(target: HTMLElement, csv: string, onArea: (area: number) => void): uPlot {
  const run = unwrap(parseUnicornCurves(csv, { runId: "demo" }));
  const curve = run.curves[0]!;
  const baseline = unwrap(calculateBaseline(run, curve.id, { kind: "zero" }));
  const windows: PeakWindow[] = [{
    id: "p1", left: { x: curve.x[0]!, kind: "manual" }, right: { x: curve.x.at(-1)!, kind: "manual" }, polarity: "positive",
  }];
  const table = unwrap(integratePeaks(curve, baseline, windows, defaultIntegrationConfig(curve.xUnit)));
  let state: AnalysisState = {
    run, revision: 0, activeCurveId: curve.id, activeChromatogramId: curve.sourceChromatogramId,
    activePeakTableId: table.id, baselines: [baseline], peakTables: [table], windows,
  };
  const plugin: uPlot.Plugin = createChromatogramPlugin({
    getFrame: () => ({ runId: run.id, revision: state.revision, curve, baseline, table: state.peakTables[0]!, seriesIndex: 1, yScale: "y" }),
    onEdit: (edit) => {
      const next = applyPeakEdit(state, edit);
      if (next.ok) {
        state = next.value;
        onArea(state.peakTables[0]!.rows[0]!.area);
      }
    },
  });
  const data: uPlot.AlignedData = unwrap(toUPlotData({ xUnit: curve.xUnit, curves: [curve] }));
  onArea(table.rows[0]!.area);
  return new uPlot({
    width: target.clientWidth, height: 350, scales: { x: { time: false } },
    series: [{}, { label: curve.label, stroke: "#163c66", width: 2 }], plugins: [plugin],
  }, data, target);
}
