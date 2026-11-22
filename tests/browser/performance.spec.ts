import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { AnalysisState, Curve, PeakWindow, Result, Run } from "../../src/index.ts";
import type { AlignedChromatogramData, ChromatographyPlot } from "../../src/uplot/index.ts";

type Chart = ChromatographyPlot & {
  setScale: (key: string, range: { min: number; max: number }) => void;
  destroy: () => void;
};
type Benchmark = {
  zoom: (variant: "base" | "plugin") => Promise<number[]>;
  samples: number[][];
  edits: number;
  integrations: number;
  errors: string[];
  destroy: () => void;
};
type World = {
  uPlot: new (options: object, data: AlignedChromatogramData, host: HTMLElement) => Chart;
  uPlotChromatography: typeof import("../../src/browser.ts");
  s73Benchmark: Benchmark;
};

async function drag(page: Page, from: Locator, plot: Locator, fraction: number, beforeCommit?: () => Promise<void>) {
  const target = await from.boundingBox();
  const viewport = await plot.boundingBox();
  if (!target || !viewport) throw new Error("S73 cannot locate the drag target and chart viewport.");
  const y = target.y + target.height / 2;
  await page.mouse.move(target.x + target.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(viewport.x + viewport.width * fraction, y, { steps: 3 });
  try {
    await beforeCommit?.();
  } finally {
    await page.mouse.up();
  }
}

const percentile95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];

test("interaction_and_teardown measures zoom and drag with three nonaligned channels", async ({ page, browserName }, testInfo) => {
  test.setTimeout(240_000);
  const repetitions = 30;
  await page.goto("/examples/browser/");
  await expect(page.getByTestId("revision")).toHaveText("0");

  for (const points of [10_000, 100_000]) {
    const environment = await page.evaluate(async (pointCount) => {
      const world = globalThis as unknown as World;
      const api = world.uPlotChromatography;
      function value<T>(result: Result<T>): T {
        if (!result.ok) throw new Error(result.errors.map((entry) => entry.message).join(" "));
        return result.value;
      }
      const host = document.createElement("div");
      host.id = "s73-benchmark";
      host.style.cssText = "position:fixed;left:10px;top:10px;z-index:20;background:white;";
      const hosts = ["base", "plugin"].map((variant) => {
        const node = document.createElement("div");
        node.id = "s73-" + variant;
        host.append(node);
        return node;
      });
      document.body.append(host);
      const width = Math.min(innerWidth - 20, 820);
      const readMemory = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const curves: Curve[] = [0, 1, 2].map((channel) => ({
        id: "trace-" + channel,
        runId: "synthetic-s73",
        sourceChromatogramId: "s73",
        label: "Channel " + channel,
        kind: "measured",
        signalUnit: "mAU",
        xUnit: "min",
        x: Float64Array.from({ length: pointCount }, (_, index) => index + channel / 4),
        y: Float64Array.from({ length: pointCount }, (_, index) => Math.max(0, 2 - 4 * Math.abs(index / pointCount - 0.43))),
      }));
      const run: Run = {
        id: "synthetic-s73", name: "S73 synthetic fixture", curves, markers: [], fractions: [],
        chromatograms: [{ id: "s73", sourceName: "fixture", origin: "original", peakTableIds: [],
          curveRefs: curves.map((curve, slot) => ({ runId: "synthetic-s73", chromatogramId: "s73", curveId: curve.id, slot })) }],
      };
      const curve = curves[0]!;
      const baseline = value(api.calculateBaseline(run, curve.id, { kind: "zero" }));
      const windows: PeakWindow[] = [{ id: "s73", left: { x: pointCount * 0.14, kind: "manual" },
        right: { x: pointCount * 0.70, kind: "manual" }, polarity: "positive" }];
      const table = value(api.integratePeaks(curve, baseline, windows, api.defaultIntegrationConfig("min"), run));
      let state: AnalysisState = { run, revision: 0, activeCurveId: curve.id, activeChromatogramId: "s73",
        activePeakTableId: table.id, peakTables: [table], activeBaselineId: baseline.id, baselines: [baseline], windows };
      const data = value(api.toUPlotData({ xUnit: "min", curves }));
      const samples: number[][] = [[], []];
      for (const [index, node] of hosts.entries()) {
        node.addEventListener("pointerup", () => {
          const start = performance.now();
          void frame().then(() => samples[index]!.push(performance.now() - start));
        }, { capture: true });
      }
      const options = () => ({
        width, height: 190,
        scales: { x: { time: false }, y: { range: [0, 2.1] } },
        series: [{}, { stroke: "#153c62" }, { stroke: "#a65324" }, { stroke: "#147973" }],
        legend: { show: false }, cursor: { drag: { setScale: false } },
      });
      const beforeBaseBytes = readMemory();
      const basePlot = new world.uPlot(options(), data, hosts[0]!);
      await frame();
      const withBaseBytes = readMemory();
      const plugin = api.createChromatogramPlugin({
        getFrame: () => ({ runId: run.id, curve, baseline, table: state.peakTables[0]!, revision: state.revision, seriesIndex: 1, yScale: "y" }),
        onEdit: (edit) => {
          world.s73Benchmark.edits++;
          world.s73Benchmark.integrations++;
          const updated = api.applyPeakEdit(state, edit);
          if (updated.ok) state = updated.value;
          else world.s73Benchmark.errors.push(updated.errors.map((error) => error.message).join(" "));
        },
      });
      const pluginPlot = new world.uPlot({ ...options(), plugins: [plugin] }, data, hosts[1]!);
      world.s73Benchmark = {
        samples, edits: 0, integrations: 0, errors: [],
        async zoom(variant) {
          const chart = variant === "base" ? basePlot : pluginPlot;
          const timings: number[] = [];
          for (let index = 0; index < 30; index++) {
            const start = performance.now();
            chart.setScale("x", { min: 0, max: index % 2 === 0 ? 0.9 * pointCount : pointCount });
            await frame();
            timings.push(performance.now() - start);
          }
          return timings;
        },
        destroy() {
          pluginPlot.destroy();
          basePlot.destroy();
          host.remove();
          Reflect.deleteProperty(world, "s73Benchmark");
        },
      };
      await frame();
      return {
        points: pointCount, channels: curves.length, alignedXCount: data[0].length, userAgent: navigator.userAgent,
        cpuConcurrency: navigator.hardwareConcurrency, dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
        memory: { beforeBaseBytes, withBaseBytes, withBothBytes: readMemory(), scope: "reported page JS heap; null when unsupported" },
      };
    }, points);

    try {
      expect(environment.alignedXCount).toBe(points * 3);
      const baseZoom = await page.evaluate(() => (globalThis as unknown as World).s73Benchmark.zoom("base"));
      const pluginZoom = await page.evaluate(() => (globalThis as unknown as World).s73Benchmark.zoom("plugin"));
      const base = page.locator("#s73-base .u-over");
      const enhanced = page.locator("#s73-plugin .u-over");
      const handle = enhanced.getByRole("button", { name: "Peak s73 right boundary" });
      await expect(handle).toBeVisible();
      for (let index = 0; index < repetitions; index++) {
        const position = index % 2 === 0 ? 0.63 : 0.73;
        await drag(page, base, base, position);
        await drag(page, handle, enhanced, position, async () => {
          expect(await page.evaluate(() => (globalThis as unknown as World).s73Benchmark.integrations)).toBe(index);
        });
        expect(await page.evaluate(() => (globalThis as unknown as World).s73Benchmark.integrations)).toBe(index + 1);
      }
      const read = () => page.evaluate(() => {
        const { samples, edits, integrations, errors } = (globalThis as unknown as World).s73Benchmark;
        return { edits, integrations, errors, baseDrag: samples[0]!, pluginDrag: samples[1]! };
      });
      await expect.poll(async () => {
        const observed = await read();
        return [observed.baseDrag.length, observed.pluginDrag.length];
      }).toEqual([repetitions, repetitions]);
      const { baseDrag, pluginDrag, edits, integrations, errors } = await read();
      for (const samples of [baseZoom, pluginZoom, baseDrag, pluginDrag]) {
        expect(samples).toHaveLength(repetitions);
        expect(samples.every((duration) => Number.isFinite(duration) && duration >= 0)).toBe(true);
      }
      expect({ edits, integrations, errors }).toEqual({ edits: repetitions, integrations: repetitions, errors: [] });
      await testInfo.attach(`s73-metrics-${points}.json`, { contentType: "application/json", body: JSON.stringify({
        ...environment, browserName, project: testInfo.project.name, repetitions,
        method: "zoom setScale or drag pointerup to a second animation frame, including paint scheduling",
        p95Ms: { baseZoom: percentile95(baseZoom), pluginZoom: percentile95(pluginZoom),
          baseDragRelease: percentile95(baseDrag), pluginDragRelease: percentile95(pluginDrag) },
        samplesMs: { baseZoom, pluginZoom, baseDrag, pluginDrag },
      }, null, 2) });
    } finally {
      await page.evaluate(() => (globalThis as unknown as World).s73Benchmark.destroy());
      await expect(page.locator("#s73-benchmark")).toHaveCount(0);
    }
  }
});
