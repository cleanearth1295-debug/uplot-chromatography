import type { Diagnostic, Result } from "./types.ts";

export function okay<T>(value: T, warnings: readonly Diagnostic[] = []): Result<T> {
  return { ok: true, value, warnings };
}

export function failure(code: string, message: string, location?: Omit<Diagnostic, "code" | "message">): Result<never> {
  return { ok: false, errors: [{ code, message, ...location }] };
}
