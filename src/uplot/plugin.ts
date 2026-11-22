import type { BaselineResult, Curve, PeakEdge, PeakEdit, PeakTable } from "../core/types.ts";
import { baselineAt } from "../core/baseline.ts";
import { samplePeakFill } from "../core/display-geometry.ts";

export interface ChromatographyPlot {
  over: HTMLElement;
  ctx: CanvasRenderingContext2D;
  bbox: { left: number; top: number; width: number; height: number };
  series: readonly { show?: boolean }[];
  valToPos(value: number, scale: string, canvasPixels?: boolean): number;
  posToVal(position: number, scale: string, canvasPixels?: boolean): number;
  redraw(rebuildPaths?: boolean, recalcAxes?: boolean): void;
}

export interface ChromatogramFrame {
  runId: string;
  revision: number;
  curve: Curve;
  baseline: BaselineResult;
  table: PeakTable;
  seriesIndex: number;
  yScale: string;
}

export interface ChromatogramPluginOptions {
  getFrame: (chart: ChromatographyPlot) => ChromatogramFrame | null;
  onEdit: (edit: PeakEdit, chart: ChromatographyPlot) => void;
  xScale?: string;
  stroke?: string;
  fill?: string;
}

type Edge = PeakEdge;
type Drag = {
  pointerId: number; button: HTMLButtonElement;
  runId: string; curveId: string; tableId: string; revision: number;
  peakId: string; edge: Edge; x: number;
};
type Binding = { controller: AbortController; buttons: Map<string, HTMLButtonElement>; drag?: Drag };

function sameTarget(frame: ChromatogramFrame, drag: Drag): boolean {
  return frame.revision === drag.revision && frame.runId === drag.runId &&
    frame.curve.id === drag.curveId && frame.table.id === drag.tableId;
}

function finishDrag(binding: Binding): Drag | undefined {
  const drag = binding.drag;
  binding.drag = undefined;
  if (drag?.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId);
  return drag;
}

function paint(plot: ChromatographyPlot, frame: ChromatogramFrame, options: ChromatogramPluginOptions): void {
  const { curve, baseline, table, yScale } = frame;
  const ctx = plot.ctx;
  const { left, top, width, height } = plot.bbox;
  const xScale = options.xScale ?? "x";
  const xPosition = (x: number) => plot.valToPos(x, xScale, true);
  const yPosition = (y: number) => plot.valToPos(y, yScale, true);
  const low = plot.posToVal(0, xScale);
  const high = plot.posToVal(plot.over.clientWidth, xScale);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) return;

  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.clip();
    ctx.strokeStyle = options.stroke ?? "#1b716c";
    ctx.fillStyle = options.fill ?? "rgba(3, 128, 111, 0.20)";
    ctx.lineWidth = 1;

    for (const row of table.rows) {
      const samples = samplePeakFill(curve, baseline, row, [low, high]);
      if (samples.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(xPosition(samples[0]!.x), yPosition(samples[0]!.top));
      for (let index = 1; index < samples.length; index++) {
        const point = samples[index]!;
        ctx.lineTo(xPosition(point.x), yPosition(point.top));
      }
      for (let index = samples.length - 1; index >= 0; index--) {
        const point = samples[index]!;
        ctx.lineTo(xPosition(point.x), yPosition(point.bottom));
      }
      ctx.closePath();
      ctx.fill();
    }

    for (const [rangeStart, rangeEnd] of baseline.validRanges) {
      const start = Math.max(rangeStart, low);
      const end = Math.min(rangeEnd, high);
      if (start >= end) continue;
      ctx.beginPath();
      ctx.moveTo(xPosition(start), yPosition(baselineAt(baseline.points, start)!));
      for (const point of baseline.points) {
        if (point.x <= start) continue;
        if (point.x >= end) break;
        ctx.lineTo(xPosition(point.x), yPosition(point.y));
      }
      ctx.lineTo(xPosition(end), yPosition(baselineAt(baseline.points, end)!));
      ctx.stroke();
    }
  } finally {
    ctx.restore();
  }
}

export function createChromatogramPlugin(options: ChromatogramPluginOptions) {
  const instances = new WeakMap<ChromatographyPlot, Binding>();
  const xScale = options.xScale ?? "x";
  const currentFrame = (plot: ChromatographyPlot) => {
    const frame = options.getFrame(plot);
    return frame && plot.series[frame.seriesIndex]?.show !== false && plot.series[frame.seriesIndex] ? frame : null;
  };

  function addHandle(plot: ChromatographyPlot, binding: Binding, peakId: string, edge: Edge): HTMLButtonElement {
    const button = plot.over.ownerDocument.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", `Peak ${peakId} ${edge} boundary`);
    button.dataset.peakBoundary = edge;
    button.style.cssText = [
      "position:absolute", "top:0", "height:100%", "width:9px", "z-index:5", "padding:0",
      "border:0", "margin:0", "background:linear-gradient(90deg,transparent 3px,#147973 3px,#147973 6px,transparent 6px)",
      "touch-action:none", "cursor:ew-resize",
    ].join(";");
    const listener = { signal: binding.controller.signal };
    const position = (event: PointerEvent) => {
      const box = plot.over.getBoundingClientRect();
      return plot.posToVal(Math.max(0, Math.min(box.width, event.clientX - box.left)), xScale);
    };
    button.addEventListener("mousedown", (event) => event.stopPropagation(), listener);
    button.addEventListener("pointerdown", (event) => {
      const frame = currentFrame(plot);
      if (!frame || event.button !== 0 || binding.drag) return;
      const peak = frame.table.rows.find((row) => row.id === peakId);
      if (!peak) return;
      event.preventDefault();
      event.stopPropagation();
      button.focus({ preventScroll: true });
      button.setPointerCapture(event.pointerId);
      binding.drag = {
        pointerId: event.pointerId, button, peakId, edge, runId: frame.runId, curveId: frame.curve.id,
        tableId: frame.table.id, revision: frame.revision, x: peak.bounds[edge].x,
      };
    }, listener);
    button.addEventListener("pointermove", (event) => {
      const drag = binding.drag;
      if (drag?.button !== button || drag.pointerId !== event.pointerId) return;
      drag.x = position(event);
      plot.redraw(false);
    }, listener);
    button.addEventListener("pointerup", (event) => {
      if (binding.drag?.button !== button || binding.drag.pointerId !== event.pointerId) return;
      event.stopPropagation();
      const drag = finishDrag(binding)!;
      const frame = currentFrame(plot);
      const old = frame?.table.rows.find((row) => row.id === peakId)?.bounds[edge].x;
      if (frame && sameTarget(frame, drag) && old !== drag.x && Number.isFinite(drag.x)) {
        options.onEdit({ op: "move-limit", peakId, edge, x: drag.x, expectedRevision: drag.revision }, plot);
      }
      plot.redraw(false);
    }, listener);
    const cancel = (event: PointerEvent) => {
      if (binding.drag?.button !== button || binding.drag.pointerId !== event.pointerId) return;
      finishDrag(binding);
      plot.redraw(false);
    };
    button.addEventListener("pointercancel", cancel, listener);
    button.addEventListener("lostpointercapture", cancel, listener);
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const frame = currentFrame(plot);
      const start = frame?.table.rows.find((row) => row.id === peakId)?.bounds[edge].x;
      if (!frame || start === undefined) return;

      const px = plot.valToPos(start, xScale);
      const delta = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1);
      const next = plot.posToVal(Math.max(0, Math.min(plot.over.clientWidth, px + delta)), xScale);
      event.preventDefault();
      if (next !== start && Number.isFinite(next)) {
        options.onEdit({ op: "move-limit", peakId, edge, x: next, expectedRevision: frame.revision }, plot);
        plot.redraw(false);
      }
    }, listener);
    plot.over.append(button);
    return button;
  }

  return {
    hooks: {
      init(plot: ChromatographyPlot) {
        const binding: Binding = { controller: new AbortController(), buttons: new Map() };
        instances.set(plot, binding);
        plot.over.ownerDocument.addEventListener("keydown", (event) => {
          if (event.key !== "Escape" || !binding.drag) return;
          finishDrag(binding);
          plot.redraw(false);
        }, { signal: binding.controller.signal });
      },
      draw(plot: ChromatographyPlot) {
        const binding = instances.get(plot);
        if (!binding) return;
        const frame = currentFrame(plot);
        if (binding.drag && (!frame || !sameTarget(frame, binding.drag))) finishDrag(binding);
        if (frame) paint(plot, frame, options);
        const visible = new Set<string>();
        for (const peak of frame?.table.rows ?? []) {
          for (const edge of ["left", "right"] as const) {
            const key = JSON.stringify([peak.id, edge]);
            const drag = binding.drag;
            const x = drag && drag.edge === edge && drag.peakId === peak.id ? drag.x : peak.bounds[edge].x;
            const pixel = plot.valToPos(x, xScale);
            if (!Number.isFinite(pixel) || pixel < 0 || pixel > plot.over.clientWidth + 0.5) continue;
            visible.add(key);
            const button = binding.buttons.get(key) ?? addHandle(plot, binding, peak.id, edge);
            binding.buttons.set(key, button);
            button.style.left = Math.max(0, Math.min(plot.over.clientWidth - 9, pixel - 4.5)) + "px";
            button.title = `${edge} · ${x.toPrecision(5)} ${frame?.table.xUnit}`;
          }
        }
        for (const [key, button] of binding.buttons) {
          if (visible.has(key) || button === binding.drag?.button) continue;
          button.remove();
          binding.buttons.delete(key);
        }
      },
      destroy(plot: ChromatographyPlot) {
        const binding = instances.get(plot);
        if (!binding) return;
        finishDrag(binding);
        binding.controller.abort();
        for (const button of binding.buttons.values()) button.remove();
        instances.delete(plot);
      },
    },
  };
}

export async function renderChromatogramPng(chart: Pick<ChromatographyPlot, "ctx">): Promise<Blob> {
  return new Promise((resolve, reject) => {
    chart.ctx.canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The canvas could not be exported as PNG."));
    }, "image/png");
  });
}
