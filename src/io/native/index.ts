import { failure, okay } from "../../core/result.ts";
import type { Result, Run } from "../../core/types.ts";
import { isZip, zipArchive } from "./zip.ts";
import type { ZipMember } from "./zip.ts";
import { isLegacyRes, readLegacyRes } from "./res.ts";
import { readResultZip } from "./result-zip.ts";

export type { ZipMember } from "./zip.ts";
export type UnicornContainerFormat =
  | "unicorn-result-zip-candidate" | "zip" | "unicorn-legacy-res"
  | "unicorn-folder" | "unicorn-doe" | "modde-project" | "unknown";

export interface UnicornContainerInspection {
  format: UnicornContainerFormat;
  confidence: "signature" | "member-layout" | "extension" | "unknown";
  members: readonly ZipMember[];
  portableTextPaths: readonly string[];
}

export interface NativeCurveOptions {
  runId: string;
  runName?: string;
  fileName?: string;
  axis?: "time" | "volume";
}

export interface NativeCurveImport {
  run: Run;
  format: "unicorn-result-zip" | "unicorn-legacy-res";
  version?: string;
}

type NativeInput = ArrayBuffer | Uint8Array;
const bytesOf = (input: NativeInput) => input instanceof Uint8Array ? input : new Uint8Array(input);
const playable = /\.(?:asc|csv|tsv|txt)$/i;

export function resultMemberName(path: string): string {
  return (path.split("/").at(-1) ?? "").replace(/^copy of /i, "").replace(/\.zip$/i, "").toLowerCase();
}

export function inspectUnicornContainer(input: NativeInput, fileName = ""): Result<UnicornContainerInspection> {
  const bytes = bytesOf(input);
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  const extensionFormat = extension === "ufol" ? "unicorn-folder" : extension === "udoe" ? "unicorn-doe"
    : extension === "mip" ? "modde-project" : undefined;
  if (isLegacyRes(bytes)) {
    return okay({ format: "unicorn-legacy-res", confidence: "signature", members: [], portableTextPaths: [] });
  }
  try {
    const members = isZip(bytes) ? zipArchive(bytes).members : [];
    const files = members.filter((member) => !member.directory);
    const names = new Set(files.map((member) => resultMemberName(member.path)));
    const candidate = names.has("result.xml") && [...names].some((name) => /^chrom\.\d+\.xml$/.test(name));
    const format = candidate ? "unicorn-result-zip-candidate" : extensionFormat ?? (isZip(bytes) ? "zip" : "unknown");
    return okay({
      format,
      confidence: candidate ? "member-layout" : extensionFormat ? "extension" : isZip(bytes) ? "signature" : "unknown",
      members,
      portableTextPaths: files.filter((member) => playable.test(member.path)).map((member) => member.path),
    });
  } catch (error) {
    return failure("E_UNICORN_ZIP", message(error));
  }
}

export async function extractUnicornPortableText(input: NativeInput, memberPath: string): Promise<Result<string>> {
  if (!playable.test(memberPath)) return failure("E_UNICORN_PORTABLE_TEXT", "Select a CSV, ASC, TSV, or TXT member.");
  try {
    const bytes = await zipArchive(bytesOf(input)).read(memberPath, 16 * 1024 * 1024);
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error("Selected ZIP member contains non-text bytes.");
    return okay(text);
  } catch (error) {
    return failure("E_UNICORN_PORTABLE_TEXT", message(error));
  }
}

export async function importUnicornNativeCurves(input: NativeInput, options: NativeCurveOptions): Promise<Result<NativeCurveImport>> {
  if (!options.runId.trim()) return failure("E_RUN_ID", "A run ID is required.");
  const inspected = inspectUnicornContainer(input, options.fileName);
  if (!inspected.ok) return inspected;
  try {
    switch (inspected.value.format) {
      case "unicorn-legacy-res":
        return readLegacyRes(bytesOf(input), options);
      case "unicorn-result-zip-candidate":
        return await readResultZip(bytesOf(input), options);
      default:
        return failure("E_UNICORN_NATIVE_FORMAT", "No supported native result structure was found. Export curves as CSV or ASC in UNICORN.");
    }
  } catch (error) {
    return failure("E_UNICORN_NATIVE_DATA", message(error));
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
