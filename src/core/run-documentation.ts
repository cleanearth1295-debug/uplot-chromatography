import { mapCoordinate } from "./axis.ts";
import { failure, okay } from "./result.ts";
import type { AxisUnit, Result, Run, RunMarker } from "./types.ts";

export interface DocumentationField {
  id: string;
  name: string;
  value: string | number | boolean;
  unit?: string;
  block?: string;
}
export type RunFeedback = "information" | "warning" | "error";
export interface RunLogEntry extends RunMarker {
  feedback?: RunFeedback;
}

export type RunSectionId = "summary" | "system" | "column" | "calibration" | "fraction-collector"
  | "variables" | "start-conditions" | "scouting" | "method" | "run-log" | "notes";
export interface RunDocumentationSource {
  columnId?: string;
  system?: readonly DocumentationField[];
  calibration?: readonly DocumentationField[];
  fractionCollector?: readonly DocumentationField[];
  variables?: readonly DocumentationField[];
  startConditions?: readonly DocumentationField[];
  scouting?: readonly DocumentationField[];
  method?: readonly DocumentationField[];
  log?: readonly RunLogEntry[];
  evaluationNotes?: readonly EvaluationNote[];
}
export interface EvaluationNote { id: string; text: string }
export interface RunDocumentSection {
  id: RunSectionId;
  label: string;
  fields?: readonly DocumentationField[];
}
export interface RunDocumentation {
  runId: string;
  sections: readonly RunDocumentSection[];
  log: readonly RunLogEntry[];
  evaluationNotes: readonly EvaluationNote[];
}
export interface RunLogQuery {
  text?: string;
  caseSensitive?: boolean;
  kinds?: readonly RunMarker["kind"][];
  feedback?: readonly RunFeedback[];
  xUnit?: AxisUnit;
  originMarkerId?: string;
}
export interface PositionedRunLogEntry extends RunLogEntry {
  coordinate: { x: number; xUnit: AxisUnit };
}

function uniqueIds(items: readonly { id: string }[]): boolean {
  return new Set(items.map(({ id }) => id)).size === items.length && items.every(({ id }) => id.trim().length > 0);
}

export function buildRunDocumentation(run: Run, source: RunDocumentationSource = {}): Result<RunDocumentation> {
  const log = [...run.markers, ...(source.log ?? [])];
  const notes = source.evaluationNotes ?? [];
  if (!uniqueIds(log) || !uniqueIds(notes)) return failure("E_RUN_DOCUMENT_ID", "Log and note IDs must be unique within their own lists.");

  const summary: DocumentationField[] = [
    { id: "run-id", name: "Run ID", value: run.id },
    { id: "run-name", name: "Run name", value: run.name },
    { id: "curves", name: "Curves", value: run.curves.length },
    { id: "chromatograms", name: "Chromatograms", value: run.chromatograms.length },
  ];
  if (run.uvPathLengthCm !== undefined) summary.push({ id: "uv-path", name: "UV optical path", value: run.uvPathLengthCm, unit: "cm" });
  const column: DocumentationField[] = [];
  if (source.columnId !== undefined) column.push({ id: "column-id", name: "Column ID", value: source.columnId });
  if (run.column?.separationMode) column.push({ id: "column-mode", name: "Separation mode", value: run.column.separationMode });
  const properties = [
    ["volumeMl", "column-volume", "Column volume", "mL"],
    ["bedHeightCm", "column-bed-height", "Bed height", "cm"],
    ["voidVolumeMl", "column-void-volume", "Void volume", "mL"],
    ["totalLiquidVolumeMl", "column-total-liquid", "Total liquid volume", "mL"],
    ["particleDiameterUm", "column-particle-diameter", "Particle diameter", "µm"],
  ] as const;
  for (const [key, id, name, unit] of properties) {
    const value = run.column?.[key];
    if (value !== undefined) column.push({ id, name, value, unit });
  }
  const sections: RunDocumentSection[] = [];
  const add = (id: RunSectionId, label: string, fields?: readonly DocumentationField[]) => {
    if (fields?.length) sections.push({ id, label, fields: fields.map((field) => ({ ...field })) });
  };
  add("summary", "Run summary", summary);
  add("system", "System", source.system);
  add("column", "Column", column);
  add("calibration", "Calibration", source.calibration);
  add("fraction-collector", "Fraction collector", source.fractionCollector);
  add("variables", "Variables", source.variables ?? Object.entries(run.variables ?? {}).map(([name, value]) => ({
    id: name, name, value,
  })));
  add("start-conditions", "Start conditions", source.startConditions);
  add("scouting", "Scouting", source.scouting);
  add("method", "Method", source.method);
  if (log.length) sections.push({ id: "run-log", label: "Run log" });
  if (notes.length) sections.push({ id: "notes", label: "Evaluation notes" });
  return okay({
    runId: run.id,
    sections,
    log: log.map((event) => ({ ...event })),
    evaluationNotes: notes.map((note) => ({ ...note })),
  });
}

export function listAvailableDocumentationSections(documentation: RunDocumentation): readonly RunSectionId[] {
  return documentation.sections.map(({ id }) => id);
}

export function queryRunLog(
  run: Run, query: RunLogQuery = {}, additional: readonly RunLogEntry[] = [],
): Result<readonly PositionedRunLogEntry[]> {
  const entries: RunLogEntry[] = [...run.markers, ...additional];
  if (!uniqueIds(entries)) return failure("E_RUN_DOCUMENT_ID", "Log IDs must be unique.");
  const origin = query.originMarkerId ? entries.find(({ id }) => id === query.originMarkerId) : undefined;
  if (query.originMarkerId && (!origin || origin.kind !== "injection")) {
    return failure("E_RUN_LOG_ORIGIN", "The log origin must be an injection marker in this run.");
  }
  const xUnit = query.xUnit ?? origin?.xUnit;
  const convert = (entry: RunLogEntry, unit: AxisUnit): Result<number> => {
    const point = mapCoordinate(run, entry.x, entry.xUnit, unit);
    if (!point.ok) return point;
    return point.value.kind === "point" ? okay(point.value.x) : failure("E_RUN_LOG_AXIS", "Log position is ambiguous after coordinate conversion.");
  };
  const offset = origin && xUnit ? convert(origin, xUnit) : okay(0);
  if (!offset.ok) return offset;

  const text = query.caseSensitive ? query.text : query.text?.toLowerCase();
  const output: PositionedRunLogEntry[] = [];
  for (const entry of entries) {
    if (query.kinds && !query.kinds.includes(entry.kind)) continue;
    if (query.feedback && !query.feedback.includes(entry.feedback ?? "information")) continue;
    const label = query.caseSensitive ? entry.label : entry.label.toLowerCase();
    if (text !== undefined && !label.includes(text)) continue;
    const unit = xUnit ?? entry.xUnit;
    const position = convert(entry, unit);
    if (!position.ok) return position;
    output.push({ ...entry, coordinate: { x: position.value - offset.value, xUnit: unit } });
  }
  if (xUnit) output.sort((a, b) => a.coordinate.x - b.coordinate.x);
  return okay(output);
}

export function updateEvaluationNote(documentation: RunDocumentation, note: EvaluationNote): Result<RunDocumentation> {
  if (!note.id.trim()) return failure("E_RUN_DOCUMENT_ID", "An evaluation note needs a stable ID.");
  const evaluationNotes = [...documentation.evaluationNotes];
  const index = evaluationNotes.findIndex(({ id }) => id === note.id);
  if (index >= 0) evaluationNotes[index] = { ...note };
  else evaluationNotes.push({ ...note });
  const sections = documentation.sections.some(({ id }) => id === "notes")
    ? documentation.sections
    : [...documentation.sections, { id: "notes" as const, label: "Evaluation notes" }];
  return okay({ ...documentation, sections, evaluationNotes });
}
