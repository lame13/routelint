import type { RouteLintReport } from "../types.js";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;

  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  if (Array.isArray(value)) return value.map((entry) => normalizeJson(entry));

  if (typeof value === "object") {
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) normalized[key] = normalizeJson(entry);
    }
    return normalized;
  }

  return String(value);
}

/** Serialize JSON with deterministic object-key ordering and a final newline. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(normalizeJson(value), null, 2)}\n`;
}

export function renderJsonReport(report: RouteLintReport): string {
  return stableJson(report);
}
