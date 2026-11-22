import type { IntegrationConfig, PeakWindow } from "./types.ts";
import { isAxisUnit } from "./curve.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function named(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function onlyKeys(value: Record<string, unknown>, ...allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));
}

function numberIn(value: unknown, min = -Infinity, max = Infinity): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return numberIn(value, min, max) && Number.isSafeInteger(value);
}

export function validBaselineSpec(spec: unknown, visibleCurve: (ref: unknown) => boolean): boolean {
  if (!isRecord(spec)) return false;
  switch (spec.kind) {
    case "zero": return onlyKeys(spec, "kind");
    case "curve":
      return Object.hasOwn(spec, "baselineCurve") ? onlyKeys(spec, "kind", "baselineCurve") && visibleCurve(spec.baselineCurve)
        : onlyKeys(spec, "kind", "baselineCurveId") && named(spec.baselineCurveId);
    case "manual": {
      const { anchors, straightAfter } = spec;
      return onlyKeys(spec, "kind", "shape", "anchors", "straightAfter") &&
        (spec.shape === "linear" || spec.shape === "classic-spline") &&
        Array.isArray(anchors) && anchors.length >= 2 &&
        Array.from(anchors).every((point, index) => isRecord(point) && onlyKeys(point, "x", "y") &&
          numberIn(point.x) && numberIn(point.y) &&
          (index === 0 || (isRecord(anchors[index - 1]) && point.x > anchors[index - 1].x))) &&
        (straightAfter === undefined || (Array.isArray(straightAfter) &&
          Array.from(straightAfter).every((index) => integerIn(index, 0, anchors.length - 2))));
    }
    case "morphological": return onlyKeys(spec, "kind", "structureWidth", "minAnchorDistance") &&
      numberIn(spec.structureWidth) && spec.structureWidth > 0 && numberIn(spec.minAnchorDistance, 0);
    case "classical": return onlyKeys(spec, "kind", "minSegment", "noiseWindow", "maxLevel", "maxSlope") &&
      numberIn(spec.minSegment) && spec.minSegment > 0 && numberIn(spec.noiseWindow, 0) &&
      numberIn(spec.maxLevel) && numberIn(spec.maxSlope, 0);
    default: return false;
  }
}

export function validThreshold(threshold: unknown): boolean {
  return isRecord(threshold) && onlyKeys(threshold, "thresholdA", "thresholdB") &&
    numberIn(threshold.thresholdA, 0) && numberIn(threshold.thresholdB, 0);
}

export function validSmoothingOptions(options: unknown): boolean {
  if (!isRecord(options) || (options.id !== undefined && typeof options.id !== "string")) return false;
  switch (options.kind) {
    case "moving-average":
    case "median": return onlyKeys(options, "kind", "id", "windowSamples") && integerIn(options.windowSamples, 1, 151);
    case "autoregressive": return onlyKeys(options, "kind", "id", "strength") && integerIn(options.strength, 1, 25);
    case "savitzky-golay":
      return onlyKeys(options, "kind", "id", "windowSamples", "degree", "derivative") &&
        integerIn(options.windowSamples, 3, 151) && options.windowSamples % 2 === 1 &&
        integerIn(options.degree, 1, Math.min(5, options.windowSamples - 1)) &&
        (options.derivative === undefined || integerIn(options.derivative, 0, options.degree));
    default: return false;
  }
}

export function validIntegrationConfig(config: unknown): config is Omit<IntegrationConfig, "xUnit"> | undefined {
  return config === undefined || (isRecord(config) &&
    onlyKeys(config, "window", "acceptNegative", "reject", "separation", "asymmetryAt", "resolution",
      "totalPeakAreaPolicy", "xUnit", "injectionX", "fractionTrackId") &&
    (config.xUnit === undefined || isAxisUnit(config.xUnit)) && typeof config.acceptNegative === "boolean" &&
    (config.injectionX === undefined || numberIn(config.injectionX)) &&
    (config.fractionTrackId === undefined || named(config.fractionTrackId)) &&
    isRecord(config.separation) && (config.separation.kind === "dropline" ? onlyKeys(config.separation, "kind") :
      config.separation.kind === "skim" && onlyKeys(config.separation, "kind", "ratio") &&
        numberIn(config.separation.ratio, 1)) &&
    numberIn(config.asymmetryAt) && config.asymmetryAt > 0 && config.asymmetryAt < 1 &&
    ["base-width", "sigma", "half-height"].some((kind) => kind === config.resolution) &&
    (config.totalPeakAreaPolicy === undefined || config.totalPeakAreaPolicy === "signed" ||
      config.totalPeakAreaPolicy === "absolute") &&
    (config.window === undefined || (Array.isArray(config.window) && config.window.length === 2 &&
      numberIn(config.window[0]) && numberIn(config.window[1]) && config.window[0] < config.window[1])) &&
    (config.reject === undefined || (isRecord(config.reject) &&
      onlyKeys(config.reject, "minHeight", "minWidth", "minArea", "keepLargest") && Object.values(config.reject)
      .every((value) => value === undefined || numberIn(value, 0)) &&
      (config.reject.keepLargest === undefined || integerIn(config.reject.keepLargest, 0, Number.MAX_SAFE_INTEGER)))));
}

function validLimit(limit: unknown): limit is PeakWindow["left"] {
  return isRecord(limit) && onlyKeys(limit, "x", "kind") && numberIn(limit.x) &&
    ["baseline-intersection", "dropline", "skim", "manual"].some((kind) => kind === limit.kind);
}

export function validPeakWindows(windows: unknown): windows is readonly PeakWindow[] {
  if (!Array.isArray(windows)) return false;
  const ids = new Set<string>();
  const intervals: { start: number; end: number }[] = [];
  for (const window of windows) {
    if (!isRecord(window) || !onlyKeys(window, "id", "left", "right", "polarity", "name") ||
      !named(window.id) || ids.has(window.id) ||
      (window.polarity !== "positive" && window.polarity !== "negative") ||
      (window.name !== undefined && typeof window.name !== "string") ||
      !validLimit(window.left) || !validLimit(window.right) || window.left.x >= window.right.x) return false;
    ids.add(window.id);
    intervals.push({ start: window.left.x, end: window.right.x });
  }
  intervals.sort((left, right) => left.start - right.start);
  return intervals.every((interval, index) => index === 0 || intervals[index - 1]!.end <= interval.start);
}
