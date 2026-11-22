const api = globalThis.uPlotChromatography;
const Plot = globalThis.uPlot;
const element = (id) => document.getElementById(id);
let currentRun;
let plot;
let state;
const sample = "Time [min],UV [mAU],Conductivity [mS/cm]\n0,0,4\n1,2,5\n2,0,6";
const colors = ["#153c62", "#a65324", "#70468b", "#147973"];

function unwrap(result) {
  if (!result.ok) throw new Error(result.errors.map((issue) => issue.message).join(" "));
  return result.value;
}
function alertUser(message = "") {
  element("error").hidden = !message;
  element("error").textContent = message;
}
function updateTable() {
  const table = state.peakTables[0];
  const peak = table.rows[0];
  element("peak-name").textContent = peak?.id ?? "—";
  element("peak-start").textContent = peak ? peak.bounds.left.x.toFixed(2) + " " + table.xUnit : "—";
  element("peak-end").textContent = peak ? peak.bounds.right.x.toFixed(2) + " " + table.xUnit : "—";
  element("peak-area").textContent = peak ? peak.area.toFixed(2) + " " + table.areaUnit : "—";
  element("revision").textContent = String(state.revision);
}
function showCurve(curveId) {
  const curve = currentRun.curves.find((entry) => entry.id === curveId);
  const baseline = unwrap(api.calculateBaseline(currentRun, curve.id, { kind: "zero" }));
  const config = api.defaultIntegrationConfig(curve.xUnit);
  const windows = curve.missing ? unwrap(api.detectPeaks(curve, baseline, config)) : [{
    id: "p1", left: { x: curve.x[0], kind: "manual" }, right: { x: curve.x.at(-1), kind: "manual" },
    polarity: "positive",
  }];
  const table = unwrap(api.integratePeaks(curve, baseline, windows, config, currentRun));
  const curves = currentRun.curves.filter((candidate) => candidate.xUnit === curve.xUnit);
  const data = unwrap(api.toUPlotData({ curves, xUnit: curve.xUnit }));
  const units = [...new Set(curves.map(({ signalUnit }) => signalUnit))];
  const scaleKey = (unit) => "signal" + units.indexOf(unit);
  const seriesIndex = curves.indexOf(curve) + 1;

  plot?.destroy();
  state = {
    run: currentRun, revision: 0, activeCurveId: curve.id, activeChromatogramId: curve.sourceChromatogramId,
    activePeakTableId: table.id, peakTables: [table], activeBaselineId: baseline.id, baselines: [baseline], windows,
  };
  const plugin = api.createChromatogramPlugin({
    getFrame: () => ({ runId: currentRun.id, curve, baseline, table: state.peakTables[0], revision: state.revision, yScale: scaleKey(curve.signalUnit), seriesIndex }),
    onEdit: (edit) => {
      const result = api.applyPeakEdit(state, edit);
      if (result.ok) {
        state = result.value;
        alertUser();
        updateTable();
      } else {
        alertUser(result.errors[0]?.message ?? "This boundary is unavailable.");
      }
    },
  });
  const low = data[0][0];
  const high = data[0].at(-1);
  plot = new Plot({
    width: element("chart").clientWidth, height: 335,
    scales: {
      x: { time: false, range: [low, high] },
      ...Object.fromEntries(units.map((unit) => [scaleKey(unit), {
        auto: true,
        ...(unit === curve.signalUnit && {
          range: (_chart, min, max) => {
            const lowSignal = Math.min(0, Number.isFinite(min) ? min : 0);
            const highSignal = Math.max(0, Number.isFinite(max) ? max : 0);
            return lowSignal < highSignal ? [lowSignal, highSignal] : [0, 1];
          },
        }),
      }])),
    },
    series: [{}, ...curves.map((trace, index) => ({
      label: trace.label, scale: scaleKey(trace.signalUnit), stroke: colors[index % colors.length], width: trace === curve ? 2 : 1,
      spanGaps: false,
    }))],
    axes: [{ label: curve.xUnit }, ...units.map((unit, index) => ({
      label: unit, scale: scaleKey(unit), side: index % 2 === 0 ? 3 : 1, grid: { show: index === 0 },
    }))],
    plugins: [plugin],
  }, data, element("chart"));
  alertUser();
  updateTable();
}
function open(csv, name) {
  const run = unwrap(api.parseUnicornCurves(csv, { runId: name, runName: name }));
  const before = currentRun;
  currentRun = run;
  try {
    showCurve(run.curves[0].id);
  } catch (error) {
    currentRun = before;
    throw error;
  }
  element("run-name").textContent = name;
  element("curve").replaceChildren(...run.curves.map((curve) => new Option(curve.label, curve.id)));
}

function readDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
if (api && Plot) {
  open(sample, "Triangle example");
  const size = new ResizeObserver(() => {
    if (plot) plot.setSize({ width: element("chart").clientWidth, height: 335 });
  });
  size.observe(element("chart"));
  let newest = 0;
  element("csv").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    const request = ++newest;
    if (!file) return;
    try {
      const csv = await file.text();
      if (request === newest) open(csv, file.name);
    } catch (error) {
      if (request === newest) alertUser(error.message);
    }
  });
  element("curve").addEventListener("change", (event) => {
    try {
      showCurve(event.target.value);
    } catch (error) {
      event.target.value = state.activeCurveId;
      alertUser(error.message);
    }
  });
  element("export").addEventListener("click", () => {
    const blob = new Blob([api.encodePeakTableCsv(state.peakTables[0])], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = "chromatogram-peaks.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  element("preview").addEventListener("click", async () => {
    const name = state.run.name;
    const table = api.toPeakDataTable(state.peakTables[0], ["id", "start", "end", "area"]);
    try {
      const png = await readDataUrl(await api.renderChromatogramPng(plot));
      const html = unwrap(api.encodePrintDocument(name, [
        { kind: "image", title: "Chromatogram", pngDataUrl: png },
        { kind: "table", title: "Peak integration", table },
      ]));
      element("print-page").srcdoc = html;
      element("print-preview").showModal();
    } catch (error) {
      alertUser(error.message);
    }
  });
  element("print").addEventListener("click", () => element("print-page").contentWindow?.print());
} else {
  alertUser("Install uPlot 1.6.32 and build the example files to open the chart.");
}
