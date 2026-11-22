import { expect, test } from "@playwright/test";
import type { AnalysisState, Result } from "../../src/index.ts";
import type { AlignedChromatogramData, ChromatographyPlot } from "../../src/uplot/index.ts";

type Chart = ChromatographyPlot & { destroy: () => void };
type LifecycleFixture = {
  counts: () => { edits: number[]; activeListeners: number[]; retainedHandles: number[] };
  destroy: (index: number) => void;
  triggerDetachedEvents: (index: number) => void;
  cleanup: () => void;
};
type World = {
  uPlot: new (options: object, data: AlignedChromatogramData, host: HTMLElement) => Chart;
  uPlotChromatography: typeof import("../../src/browser.ts");
  s73Lifecycle: LifecycleFixture;
};

test("interaction_and_teardown isolates chart instances and removes stale handlers", async ({ page }) => {
  await page.goto("/examples/browser/");
  await expect(page.getByTestId("revision")).toHaveText("0");
  await page.evaluate(() => {
    const world = globalThis as unknown as World;
    const api = world.uPlotChromatography;
    function value<T>(result: Result<T>): T {
      if (!result.ok) throw new Error(result.errors.map((entry) => entry.message).join(" "));
      return result.value;
    }
    const root = document.createElement("div");
    root.style.cssText = "position:fixed;left:10px;top:10px;z-index:20;background:white;";
    const hosts = [0, 1].map((index) => {
      const host = document.createElement("div");
      host.id = "s73-lifecycle-" + index;
      root.append(host);
      return host;
    });
    document.body.append(root);
    const run = value(api.parseUnicornCurves("Time [min],UV [mAU]\n0,0\n1,2\n2,0", { runId: "s73-lifecycle" }));
    const curve = run.curves[0]!;
    const data = value(api.toUPlotData({ xUnit: "min", curves: [curve] }));
    const baseline = value(api.calculateBaseline(run, curve.id, { kind: "zero" }));
    const windows = [{ id: "p1", left: { x: 0, kind: "manual" }, right: { x: 2, kind: "manual" }, polarity: "positive" }] as const;
    const table = value(api.integratePeaks(curve, baseline, windows, api.defaultIntegrationConfig("min"), run));
    const states: AnalysisState[] = hosts.map(() => ({ run, revision: 0, activeCurveId: curve.id,
      activeChromatogramId: curve.sourceChromatogramId, activePeakTableId: table.id, peakTables: [table],
      activeBaselineId: baseline.id, baselines: [baseline], windows }));
    const edits = [0, 0];
    const detached = new Map<number, HTMLButtonElement[]>();
    const charts = new Map<number, Chart>();
    const chartIds = new Map<ChromatographyPlot, number>();
    const registrations: { chart: number; target: EventTarget; type: string; callback: EventListenerOrEventListenerObject;
      capture?: boolean; signal?: AbortSignal; removed: boolean }[] = [];
    const originalAdd = EventTarget.prototype.addEventListener;
    const originalRemove = EventTarget.prototype.removeEventListener;
    let mounting = -1;
    let initializing = -1;
    let drawing = -1;
    const captures = (options?: boolean | EventListenerOptions) => typeof options === "boolean" ? options : options?.capture ?? false;
    const captureAdd: typeof originalAdd = function (this: EventTarget, ...args) {
      const [type, callback, setup] = args;
      const chart = this === document ? initializing :
        this instanceof HTMLButtonElement && this.hasAttribute("data-peak-boundary") ? drawing : -1;
      if (chart >= 0 && callback) {
        registrations.push({ chart, target: this, type, callback, capture: captures(setup),
          signal: typeof setup === "object" ? setup?.signal : undefined, removed: false });
      }
      return originalAdd.apply(this, args);
    };
    const captureRemove: typeof originalRemove = function (this: EventTarget, ...args) {
      const [type, callback, setup] = args;
      for (const item of registrations) {
        if (item.target === this && item.type === type && item.callback === callback && item.capture === captures(setup)) item.removed = true;
      }
      return originalRemove.apply(this, args);
    };
    EventTarget.prototype.addEventListener = captureAdd;
    EventTarget.prototype.removeEventListener = captureRemove;

    const plugin = api.createChromatogramPlugin({
      getFrame: (chart) => {
        const index = chartIds.get(chart);
        if (index === undefined) return null;
        const state = states[index]!;
        return { runId: run.id, curve, baseline, table: state.peakTables[0]!,
          revision: state.revision, seriesIndex: 1, yScale: "y" };
      },
      onEdit: (edit, chart) => {
        const index = chartIds.get(chart)!;
        states[index] = value(api.applyPeakEdit(states[index]!, edit));
        edits[index] = edits[index]! + 1;
      },
    });
    const fixture = { hooks: {
      ...plugin.hooks,
      init(chart: ChromatographyPlot) {
        chartIds.set(chart, mounting);
        initializing = mounting;
        try { plugin.hooks.init(chart); } finally { initializing = -1; }
      },
      draw(chart: ChromatographyPlot) {
        drawing = chartIds.get(chart) ?? -1;
        try { plugin.hooks.draw(chart); } finally { drawing = -1; }
      },
    } };
    const destroy = (index: number) => {
      const chart = charts.get(index);
      if (!chart) return;
      detached.set(index, Array.from(chart.over.querySelectorAll("button[data-peak-boundary]")));
      chart.destroy();
      chartIds.delete(chart);
      charts.delete(index);
    };
    try {
      hosts.forEach((host, index) => {
        mounting = index;
        const chart = new world.uPlot({ width: Math.min(740, innerWidth - 20), height: 170,
          scales: { x: { time: false, range: [0, 2] }, y: { range: [0, 2.1] } },
          legend: { show: false }, series: [{}, { stroke: "#153c62" }], plugins: [fixture],
        }, data, host);
        charts.set(index, chart);
      });
    } catch (error) {
      EventTarget.prototype.addEventListener = originalAdd;
      EventTarget.prototype.removeEventListener = originalRemove;
      throw error;
    } finally {
      mounting = -1;
    }
    world.s73Lifecycle = {
      destroy,
      counts: () => ({ edits: [...edits], activeListeners: hosts.map((_, index) =>
        registrations.filter((item) => item.chart === index && !item.removed && !item.signal?.aborted).length),
      retainedHandles: hosts.map((host) => host.querySelectorAll("[data-peak-boundary]").length) }),
      triggerDetachedEvents(index) {
        for (const button of detached.get(index) ?? []) {
          button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
        }
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      },
      cleanup() {
        try { destroy(0); destroy(1); } finally {
          EventTarget.prototype.addEventListener = originalAdd;
          EventTarget.prototype.removeEventListener = originalRemove;
          root.remove();
          Reflect.deleteProperty(world, "s73Lifecycle");
        }
      },
    };
  });

  const counts = () => page.evaluate(() => (globalThis as unknown as World).s73Lifecycle.counts());
  try {
    const first = page.locator("#s73-lifecycle-0").getByRole("button", { name: "Peak p1 right boundary" });
    const second = page.locator("#s73-lifecycle-1").getByRole("button", { name: "Peak p1 right boundary" });
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    const initial = await counts();
    const [firstListenerCount, secondListenerCount] = initial.activeListeners;
    expect(initial).toEqual({ edits: [0, 0], activeListeners: [firstListenerCount, secondListenerCount], retainedHandles: [2, 2] });
    expect(firstListenerCount).toBeGreaterThanOrEqual(3);
    expect(secondListenerCount).toBe(firstListenerCount);
    await first.press("Shift+ArrowLeft");
    expect((await counts()).edits).toEqual([1, 0]);

    const box = await first.boundingBox();
    if (!box) throw new Error("Cannot locate the first chart's peak handle.");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 20, box.y + box.height / 2);
    await page.evaluate(() => (globalThis as unknown as World).s73Lifecycle.destroy(0));
    await page.mouse.up();
    await page.evaluate(() => (globalThis as unknown as World).s73Lifecycle.triggerDetachedEvents(0));
    expect(await counts()).toEqual({ edits: [1, 0], activeListeners: [0, secondListenerCount], retainedHandles: [0, 2] });

    await second.press("Shift+ArrowLeft");
    expect((await counts()).edits).toEqual([1, 1]);
    await page.evaluate(() => (globalThis as unknown as World).s73Lifecycle.destroy(1));
    await page.evaluate(() => (globalThis as unknown as World).s73Lifecycle.triggerDetachedEvents(1));
    expect(await counts()).toEqual({ edits: [1, 1], activeListeners: [0, 0], retainedHandles: [0, 0] });
  } finally {
    await page.evaluate(() => (globalThis as unknown as World).s73Lifecycle.cleanup());
  }
});
