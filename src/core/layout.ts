import { failure, okay } from "./result.ts";
import type { AxisUnit, Interval, Result } from "./types.ts";

export interface LayoutAnnotation {
  id: string;
  x: number;
  text: string;
}
export interface LayoutPanel {
  chartId: string;
  xUnit: AxisUnit;
  xRange?: Interval;
  yRange?: Interval;
  yUnit?: string;
  visibleCurveIds?: readonly string[];
  annotations?: readonly LayoutAnnotation[];
}
export interface ChromatogramLayout {
  mode: "tabs" | "tile";
  activeChartId: string;
  panels: readonly LayoutPanel[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && !!value.trim();
}
function range(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && value[0] < value[1];
}
function validLayout(value: unknown): value is ChromatogramLayout {
  if (!record(value) || (value.mode !== "tabs" && value.mode !== "tile") || !id(value.activeChartId) ||
    !Array.isArray(value.panels) || value.panels.length === 0) return false;
  const charts = new Set();
  for (const panel of value.panels) {
    if (!record(panel) || !id(panel.chartId) || charts.has(panel.chartId) ||
      (panel.xUnit !== "min" && panel.xUnit !== "mL" && panel.xUnit !== "CV") ||
      (panel.xRange !== undefined && !range(panel.xRange)) || (panel.yRange !== undefined && !range(panel.yRange)) ||
      (panel.yUnit !== undefined && !id(panel.yUnit))) return false;
    const visible = panel.visibleCurveIds;
    if (visible !== undefined && (!Array.isArray(visible) || !visible.every(id) || new Set(visible).size !== visible.length)) {
      return false;
    }
    const annotations = panel.annotations;
    if (annotations !== undefined) {
      if (!Array.isArray(annotations) || !annotations.every((annotation) => record(annotation) &&
        id(annotation.id) && typeof annotation.x === "number" && Number.isFinite(annotation.x) &&
        typeof annotation.text === "string")) return false;
      if (new Set(annotations.map((annotation) => annotation.id)).size !== annotations.length) return false;
    }
    charts.add(panel.chartId);
  }
  return charts.has(value.activeChartId);
}

export function encodeLayout(layout: ChromatogramLayout): Result<string> {
  if (!validLayout(layout)) return failure("E_LAYOUT_INVALID", "The layout needs distinct panels and an active chart in the layout.");
  const canonical: ChromatogramLayout = {
    mode: layout.mode,
    activeChartId: layout.activeChartId,
    panels: layout.panels.map(({ chartId, xUnit, xRange, yRange, yUnit, visibleCurveIds, annotations }) => ({
      chartId, xUnit,
      xRange: xRange && [xRange[0], xRange[1]],
      yRange: yRange && [yRange[0], yRange[1]],
      yUnit,
      visibleCurveIds: visibleCurveIds && [...visibleCurveIds],
      annotations: annotations?.map(({ id, x, text }) => ({ id, x, text })),
    })),
  };
  return okay(JSON.stringify({ schemaVersion: 1, layout: canonical }));
}

export function decodeLayout(text: string): Result<ChromatogramLayout> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failure("E_LAYOUT_INVALID", "The layout file could not be parsed.");
  }
  if (!record(value) || value.schemaVersion !== 1 || !validLayout(value.layout)) {
    return failure("E_LAYOUT_INVALID", "The layout file has invalid fields or a schema version this package does not support.");
  }
  return okay(value.layout);
}

export function createLayoutStore() {
  const shared = new Map<string, string>();
  const personal = new Map<string, Map<string, string>>();
  let defaultName: string | undefined;
  return {
    save(scope: "shared" | "personal", name: string, layout: ChromatogramLayout, userId?: string): Result<string> {
      if (!id(name) || (scope === "personal" && !id(userId))) {
        return failure("E_LAYOUT_NAME", "A layout name and the owner of a personal view are required.");
      }
      const payload = encodeLayout(layout);
      if (!payload.ok) return payload;
      if (scope === "shared") shared.set(name, payload.value);
      else {
        const owner = userId!;
        const views = personal.get(owner) ?? new Map();
        views.set(name, payload.value);
        personal.set(owner, views);
      }
      return payload;
    },
    setDefault(name: string): Result<string> {
      if (!shared.has(name)) return failure("E_LAYOUT_NAME", "A shared layout must exist before setting it as the default.");
      defaultName = name;
      return okay(name);
    },
    restore(name?: string, userId?: string): ChromatogramLayout | undefined {
      const chosen = name ?? defaultName;
      if (chosen === undefined) return undefined;
      const candidate = (userId !== undefined ? personal.get(userId)?.get(chosen) : undefined) ?? shared.get(chosen);
      if (candidate === undefined) return undefined;
      const layout = decodeLayout(candidate);
      return layout.ok ? layout.value : undefined;
    },
  };
}
