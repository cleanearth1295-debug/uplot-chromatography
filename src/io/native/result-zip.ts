import { validateCurve } from "../../core/curve.ts";
import { failure, okay } from "../../core/result.ts";
import type { Chromatogram, Curve, Diagnostic, Result, Run, RunMarker } from "../../core/types.ts";
import { resultMemberName } from "./index.ts";
import type { NativeCurveImport, NativeCurveOptions } from "./index.ts";
import { zipArchive } from "./zip.ts";
import type { ZipArchive, ZipMember } from "./zip.ts";

interface XmlElement {
  name: string;
  text: string;
  children: XmlElement[];
}
const XML_LIMIT = 8 * 1024 * 1024;
const CURVE_ARCHIVE_LIMIT = 64 * 1024 * 1024;
const ARRAY_LIMIT = 32 * 1024 * 1024;
const TOTAL_SAMPLES = 8_000_000;
const numberValue = (text: string | undefined) => text?.trim() ? Number(text) : NaN;

function decodeXml(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0
    ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c
      ? "utf-16be" : "utf-8";
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

function decodeXmlText(text: string): string {
  return text.replace(/&([^;\s]{1,32});/g, (_reference, content: string) => {
    switch (content) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
    }
    const point = /^#\d+$/.test(content) ? Number(content.slice(1)) :
      /^#x[\da-f]+$/i.test(content) ? Number.parseInt(content.slice(2), 16) : NaN;
    if (!Number.isSafeInteger(point) || point <= 0 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) {
      throw new Error("Unsupported entity in result metadata.");
    }
    return String.fromCodePoint(point);
  });
}

function parseMetadata(text: string): XmlElement {
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(text)) throw new Error("DTD and entity declarations are not supported.");
  const stack: XmlElement[] = [{ name: "#document", text: "", children: [] }];
  const token = /<!--[\s\S]*?-->|<\?xml(?:\s[^?]*)?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[\w:.-]+(?:\s+(?:[^'"<>]|"[^"]*"|'[^']*')*)?\/?>|[^<]+/gy;
  let count = 0;
  for (let offset = 0; offset < text.length;) {
    token.lastIndex = offset;
    const match = token.exec(text);
    if (!match) throw new Error("Result metadata contains malformed XML.");
    offset = token.lastIndex;
    const value = match[0];
    const parent = stack.at(-1)!;
    if (value.startsWith("<!--") || value.startsWith("<?xml")) continue;
    if (value.startsWith("<![CDATA[")) {
      parent.text += value.slice(9, -3);
    } else if (value.startsWith("</")) {
      const name = value.slice(2, -1).trim().split(":").at(-1)!.toLowerCase();
      if (stack.length < 2 || parent.name !== name) throw new Error("Result XML tags are unbalanced.");
      stack.pop();
    } else if (value.startsWith("<")) {
      if (++count > 150_000 || stack.length > 48) throw new Error("Result XML metadata exceeds parser limits.");
      const name = /^<([\w:.-]+)/.exec(value)![1]!.split(":").at(-1)!.toLowerCase();
      const child: XmlElement = { name, text: "", children: [] };
      parent.children.push(child);
      if (!value.endsWith("/>")) stack.push(child);
    } else {
      parent.text += decodeXmlText(value);
    }
  }
  if (stack.length !== 1 || stack[0]!.children.length !== 1) throw new Error("Expected one complete result XML document.");
  return stack[0]!.children[0]!;
}

function field(element: XmlElement, key: string): string | undefined {
  return element.children.find((child) => child.name === key)?.text.trim();
}

function elements(element: XmlElement): XmlElement[] {
  const output: XmlElement[] = [];
  const visit = (node: XmlElement) => {
    output.push(node);
    node.children.forEach(visit);
  };
  visit(element);
  return output;
}

function uniqueMembers(archive: ZipArchive): Map<string, ZipMember> {
  const output = new Map<string, ZipMember>();
  for (const member of archive.members) {
    if (member.directory) continue;
    const name = resultMemberName(member.path);
    if (output.has(name)) throw new Error("Result ZIP contains ambiguous member names.");
    output.set(name, member);
  }
  return output;
}

function singleArray(bytes: Uint8Array): Float64Array {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 36 || bytes[0] !== 0 || data.getInt32(9, true) !== 1 || data.getInt32(13, true) !== 0 ||
      bytes[17] !== 15 || bytes[26] !== 11 || data.getInt32(1, true) !== data.getInt32(18, true)) {
    throw new Error("Result curve arrays are not a bare NRBF single-precision primitive array.");
  }
  const count = data.getInt32(22, true);
  const end = 27 + 4 * count;
  if (count < 2 || count > TOTAL_SAMPLES || end !== bytes.length - 1 || bytes[end] !== 11) {
    throw new Error("Result curve array byte length or terminator is inconsistent.");
  }
  return Float64Array.from({ length: count }, (_, i) => data.getFloat32(27 + i * 4, true));
}
const nondecreasing = (axis: Float64Array) => axis.every((value, index) =>
  Number.isFinite(value) && (index === 0 || value >= axis[index - 1]!));

export async function readResultZip(bytes: Uint8Array, options: NativeCurveOptions): Promise<Result<NativeCurveImport>> {
  const outer = zipArchive(bytes);
  const members = uniqueMembers(outer);
  const resultFile = members.get("result.xml");
  if (!resultFile) return failure("E_UNICORN_ZIP", "Result.xml is missing.");
  const result = parseMetadata(decodeXml(await outer.read(resultFile.path, XML_LIMIT)));
  const version = elements(result).find((node) => ["unicornversion", "softwareversion"].includes(node.name))?.text.trim();
  const name = options.runName ?? (field(result, "name") || options.runId);
  const descriptors = [...members.entries()]
    .map(([memberName, descriptor]) => ({ index: Number(/^chrom\.(\d+)\.xml$/.exec(memberName)?.[1]), descriptor }))
    .filter(({ index }) => Number.isSafeInteger(index)).sort((a, b) => a.index - b.index);
  const curves: Curve[] = [];
  const chromatograms: Chromatogram[] = [];
  const warnings: Diagnostic[] = [];
  const markers: RunMarker[] = [];
  let total = 0;
  let timeVolume: Run["timeVolume"];
  let columnMl: number | undefined;

  for (const { index, descriptor } of descriptors) {
    const xml = parseMetadata(decodeXml(await outer.read(descriptor.path, XML_LIMIT)));
    const entries = elements(xml).filter((node) => field(node, "curvedatatype") !== undefined && field(node, "name") !== undefined);
    const chromatogramId = options.runId + ":chromatogram:" + index;
    const refs: Chromatogram["curveRefs"][number][] = [];
    const paths = new Set<string>();

    for (const [position, entry] of entries.entries()) {
      const label = field(entry, "name")!;
      const curveType = field(entry, "curvedatatype")!.toLowerCase();
      if (/^(injection|fraction|logbook|event)$/i.test(curveType)) {
        const events = elements(entry).filter((candidate) => field(candidate, "eventtext") !== undefined);
        for (const [eventIndex, event] of events.entries()) {
          const useVolume = options.axis === "volume";
          const x = numberValue(field(event, useVolume ? "eventvolume" : "eventtime"));
          if (!Number.isFinite(x)) continue;
          markers.push({
            id: chromatogramId + ":event:" + position + ":" + eventIndex,
            label: field(event, "eventtext") || label,
            kind: curveType === "injection" ? "injection" : "event",
            x, xUnit: useVolume ? "mL" : "min",
          });
        }
        continue;
      }

      const file = elements(entry)
        .map((node) => members.get(resultMemberName(node.text.trim())))
        .find((member) => member && /^chrom\.\d+_/.test(resultMemberName(member.path)));
      if (!file) {
        warnings.push({ code: "W_UNICORN_CURVE_STORAGE", message: "Skipped " + label + " because it has no recognized point archive." });
        continue;
      }
      if (paths.has(file.path)) throw new Error("Multiple curves reference the same point archive.");
      paths.add(file.path);

      const points = zipArchive(await outer.read(file.path, CURVE_ARCHIVE_LIMIT), true);
      const membersByName = uniqueMembers(points);
      const signalMember = membersByName.get("coordinatedata.amplitudes");
      const volumeMember = membersByName.get("coordinatedata.volumes");
      if (!signalMember || !volumeMember) throw new Error("A curve has no documented amplitude and volume array members.");
      const y = singleArray(await points.read(signalMember.path, ARRAY_LIMIT));
      const volumes = singleArray(await points.read(volumeMember.path, ARRAY_LIMIT));
      total += y.length;
      if (y.length !== volumes.length || total > TOTAL_SAMPLES) throw new Error("Inconsistent curve array sizes or total sample count.");

      const step = numberValue(field(entry, "distancebetweenpoints"));
      const start = numberValue(field(entry, "distancetostartpoint") ?? "0");
      const isVolume = field(entry, "isochronetype")?.toLowerCase() === "volume";
      const hasTime = !isVolume && Number.isFinite(start) && Number.isFinite(step) && step > 0;
      const useVolume = options.axis === "volume" || !hasTime && options.axis !== "time";
      if (!useVolume && !hasTime) throw new Error("A requested time axis cannot be reconstructed from this result curve.");
      const times = hasTime ? Float64Array.from({ length: y.length }, (_, i) => start + step * i) : undefined;
      if (!timeVolume && times && nondecreasing(volumes)) timeVolume = { timeMin: times.slice(), volumeMl: volumes.slice() };

      const measured = field(entry, "isoriginaldata")?.toLowerCase() !== "false";
      const unit = field(entry, "amplitudeunit") || (curveType === "ph" ? "pH" : "1");
      const curve: Curve = {
        id: chromatogramId + ":curve:" + position, runId: options.runId, sourceChromatogramId: chromatogramId,
        sourceLabel: label, label, signalUnit: unit, kind: measured ? "measured" : "derived",
        x: useVolume ? volumes : times!, xUnit: useVolume ? "mL" : "min", y,
      };
      const checked = validateCurve(curve);
      if (!checked.ok) return checked;
      curves.push(curve);
      refs.push({ runId: options.runId, chromatogramId, curveId: curve.id, slot: refs.length });
      const volume = numberValue(field(entry, "columnvolume"));
      if (Number.isFinite(volume) && volume > 0) columnMl ??= volume;
    }
    if (refs.length) chromatograms.push({
      id: chromatogramId, sourceName: field(xml, "name") || "Chromatogram " + index,
      origin: "imported", curveRefs: refs, peakTableIds: [],
    });
  }
  if (!curves.length) return failure("E_UNICORN_NATIVE_DATA", "The result contains no recognized curves.");
  return okay({
    format: "unicorn-result-zip", version: version || undefined,
    run: {
      id: options.runId, name, curves, chromatograms, markers, fractions: [], timeVolume,
      column: columnMl !== undefined ? { volumeMl: columnMl } : undefined,
    },
  }, [...warnings, { code: "W_UNICORN_CURVES_ONLY", message: "Result ZIP import covers documented curve records; vendor tables, method data and 7.10 equivalence require source evidence." }]);
}
