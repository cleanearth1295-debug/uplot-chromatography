import { validateCurve } from "../../core/curve.ts";
import { failure, okay } from "../../core/result.ts";
import type { Curve, Result } from "../../core/types.ts";
import type { NativeCurveImport, NativeCurveOptions } from "./index.ts";

const textDecoder = new TextDecoder("windows-1252");
const ENTRY_BYTES = 344;
const CURVE_HEADER = 240;

function text(bytes: Uint8Array, start: number, size: number): string {
  const slice = bytes.subarray(start, start + size);
  const nul = slice.indexOf(0);
  return textDecoder.decode(nul < 0 ? slice : slice.subarray(0, nul)).trim();
}

export function isLegacyRes(bytes: Uint8Array): boolean {
  return bytes[0] === 0x11 && bytes[1] === 0x47 && bytes[2] === 0x11 && bytes[3] === 0x47;
}

// Layout documented by OpenReadout's Cytiva UNICORN provenance.
export function readLegacyRes(bytes: Uint8Array, options: NativeCurveOptions): Result<NativeCurveImport> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const f64 = (at: number) => view.getFloat64(at, true);
  if (bytes.length < 48 || bytes.length > 256 * 1024 * 1024 || u32(16) !== bytes.length) {
    return failure("E_UNICORN_RES", "Legacy RES byte count disagrees with its header or exceeds the import limit.");
  }
  const layout = text(bytes, 24, 24);
  if (layout !== "UNICORN 3.10") {
    return failure("E_UNICORN_RES", "Legacy RES layout is outside the documented UNICORN 3.10 binary layout.");
  }
  const directory = u32(8);
  if (directory < 48 || directory + ENTRY_BYTES > bytes.length) {
    return failure("E_UNICORN_RES", "Legacy RES directory offset is invalid.");
  }
  const id = options.runId + ":chromatogram:1";
  const curves: Curve[] = [];
  let at = directory;
  let sampleCount = 0;
  for (let index = 0; ; index++, at += ENTRY_BYTES) {
    if (index >= 4096 || at + ENTRY_BYTES > bytes.length) {
      return failure("E_UNICORN_RES", "Legacy RES directory is unterminated or exceeds the entry limit.");
    }
    const name = text(bytes, at + 6, 296);
    if (!name) break;
    if (u16(at) !== 1 || u16(at + 2) !== 4 || bytes[at + 5] !== 0x14 ||
      (bytes[at + 4] !== 1 && bytes[at + 4] !== 3)) continue;
    const size = u32(at + 302);
    const offset = u32(at + 310);
    if (u32(at + 314) !== CURVE_HEADER || size < CURVE_HEADER + 16 || (size - CURVE_HEADER) % 8 !== 0 ||
      offset < 48 || offset + size > bytes.length || u16(offset) !== 6 || u16(offset + 2) !== 2 || u16(offset + 4) !== 1) {
      return failure("E_UNICORN_RES", "Legacy RES curve block has an invalid header or byte count.", { index });
    }
    const time = offset + 6;
    const volume = time + 78;
    const signal = volume + 78;
    if (u16(time) !== 78 || u16(time + 2) !== 0x8001 || u16(volume) !== 78 || u16(volume + 2) !== 0x8002 ||
      u16(volume + 60) !== 0x0104 || u16(signal) !== 78 ||
      (u16(signal + 2) !== 0x4000 && u16(signal + 2) !== 0x4001) || u16(signal + 60) !== 0x0104) {
      return failure("E_UNICORN_RES", "Legacy RES curve descriptors use an unsupported layout.", { index });
    }
    const count = (size - CURVE_HEADER) / 8;
    sampleCount += count;
    if (sampleCount > 8_000_000) return failure("E_UNICORN_RES", "Legacy RES exceeds the total sample limit.");
    const useVolume = options.axis === "volume";
    const xScale = f64((useVolume ? volume : time) + 62);
    const xOffset = useVolume ? 0 : f64(time + 70) / 60_000;
    const yScale = f64(signal + 62);
    if (!(Number.isFinite(xScale) && xScale > 0 && Number.isFinite(xOffset) &&
      Number.isFinite(yScale) && yScale !== 0)) {
      return failure("E_UNICORN_RES", "Legacy RES curve has invalid scaling metadata.", { index });
    }
    const data = offset + CURVE_HEADER;
    const curve: Curve = {
      id: id + ":curve:" + (index + 1), runId: options.runId, sourceChromatogramId: id,
      sourceLabel: name, label: name.replace(/^=?[^:]+:\d+_/, ""),
      kind: bytes[at + 4] === 1 ? "measured" : "derived",
      signalUnit: text(bytes, signal + 44, 16) || "1", xUnit: useVolume ? "mL" : "min",
      x: Float64Array.from({ length: count }, (_, sample) => xOffset + xScale *
        (useVolume ? view.getInt32(data + sample * 8, true) : sample)),
      y: Float64Array.from({ length: count }, (_, sample) => yScale * view.getInt32(data + sample * 8 + 4, true)),
    };
    const valid = validateCurve(curve);
    if (!valid.ok) return valid;
    curves.push(curve);
  }
  if (!curves.length) return failure("E_UNICORN_RES", "Legacy RES directory contains no supported curves.");
  const name = options.runName ?? options.runId;
  return okay({
    format: "unicorn-legacy-res",
    run: { id: options.runId, name, curves, markers: [], fractions: [], chromatograms: [{
      id, sourceName: name, origin: "imported", peakTableIds: [],
      curveRefs: curves.map((curve, slot) => ({ runId: options.runId, chromatogramId: id, curveId: curve.id, slot })),
    }] },
  }, [{ code: "W_UNICORN_CURVES_ONLY", message: "Legacy RES import includes curves. Event and method blocks are outside this reader's scope." }]);
}
