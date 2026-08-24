import type {
  BuildInventory,
  QueryPolicy,
  RouteCandidate,
  RouteSource,
  SitemapInventory,
} from "../types.js";

const MAX_URL_LENGTH = 8_192;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export interface InitialCandidateOptions {
  readonly baseUrl: string | URL;
  readonly seeds: readonly string[];
  readonly sitemap?: SitemapInventory;
  readonly build?: BuildInventory;
  readonly queryPolicy?: QueryPolicy;
}

export interface CandidateCollection {
  readonly candidates: readonly RouteCandidate[];
  readonly warnings: readonly string[];
}

function parseBaseUrl(value: string | URL): URL {
  const parsed = value instanceof URL ? new URL(value.href) : new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("The base URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("The base URL must not contain credentials.");
  }
  parsed.hash = "";
  return parsed;
}

/** Normalize a crawl candidate while rejecting credentials, non-HTTP schemes, and unsafe input. */
export function normalizeCandidateUrl(
  value: string | URL,
  baseUrl: string | URL,
  queryPolicy: QueryPolicy = "drop",
): string | undefined {
  const raw = value instanceof URL ? value.href : value.trim();
  if (!raw || raw.length > MAX_URL_LENGTH || containsControlCharacter(raw)) return undefined;
  try {
    const base = parseBaseUrl(baseUrl);
    const parsed = new URL(raw, base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password) return undefined;
    parsed.hash = "";
    if (queryPolicy === "drop") parsed.search = "";
    else parsed.searchParams.sort();
    return parsed.href.length <= MAX_URL_LENGTH ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function sourceKey(source: RouteSource): string {
  return `${source.kind}\u0000${source.from ?? ""}\u0000${source.detail ?? ""}`;
}

function mergeSources(left: readonly RouteSource[], right: readonly RouteSource[]): RouteSource[] {
  const merged = new Map<string, RouteSource>();
  for (const source of [...left, ...right]) merged.set(sourceKey(source), source);
  return [...merged.values()];
}

/** Merge and de-duplicate candidates, retaining only URLs on the configured origin. */
export function mergeRouteCandidates(
  baseUrl: string | URL,
  candidates: readonly RouteCandidate[],
  queryPolicy: QueryPolicy = "drop",
): RouteCandidate[] {
  const base = parseBaseUrl(baseUrl);
  const merged = new Map<string, RouteCandidate>();
  for (const candidate of candidates) {
    const url = normalizeCandidateUrl(candidate.url, base, queryPolicy);
    if (!url || new URL(url).origin !== base.origin) continue;
    const existing = merged.get(url);
    if (!existing) {
      merged.set(url, { ...candidate, url, sources: mergeSources([], candidate.sources) });
      continue;
    }
    merged.set(url, {
      url,
      depth: Math.min(existing.depth, candidate.depth),
      sources: mergeSources(existing.sources, candidate.sources),
      ...((existing.sitemap ?? candidate.sitemap)
        ? { sitemap: existing.sitemap ?? candidate.sitemap }
        : {}),
      ...((existing.build ?? candidate.build) ? { build: existing.build ?? candidate.build } : {}),
    });
  }
  return [...merged.values()];
}

/** Build the bounded initial frontier from explicit seeds, sitemap entries, and Next build routes. */
export function buildInitialCandidates(options: InitialCandidateOptions): CandidateCollection {
  const base = parseBaseUrl(options.baseUrl);
  const queryPolicy = options.queryPolicy ?? "drop";
  const candidates: RouteCandidate[] = [];
  const warnings: string[] = [];

  for (const seed of options.seeds) {
    const url = normalizeCandidateUrl(seed, base, queryPolicy);
    if (!url) {
      warnings.push("Ignored an invalid seed URL.");
      continue;
    }
    if (new URL(url).origin !== base.origin) {
      warnings.push(`Ignored a seed URL on another origin: ${new URL(url).origin}`);
      continue;
    }
    candidates.push({ url, depth: 0, sources: [{ kind: "seed" }] });
  }

  for (const entry of options.sitemap?.entries ?? []) {
    const url = normalizeCandidateUrl(entry.url, base, queryPolicy);
    if (!url) {
      warnings.push("Ignored an invalid sitemap entry URL.");
      continue;
    }
    if (new URL(url).origin !== base.origin) {
      warnings.push(`Ignored a sitemap entry on another origin: ${new URL(url).origin}`);
      continue;
    }
    candidates.push({
      url,
      depth: 0,
      sources: [{ kind: "sitemap", from: entry.sitemapUrl }],
      sitemap: entry,
    });
  }

  for (const route of options.build?.routes ?? []) {
    const url = normalizeCandidateUrl(route.pathname, base, queryPolicy);
    if (!url || new URL(url).origin !== base.origin) {
      warnings.push(`Ignored invalid build route: ${route.pathname}`);
      continue;
    }
    candidates.push({
      url,
      depth: 0,
      sources: [
        {
          kind: route.pattern ? "sample" : "next-build",
          from: route.sourceManifest,
          ...(route.pattern ? { detail: route.pattern } : {}),
        },
      ],
      build: route,
    });
  }

  return {
    candidates: mergeRouteCandidates(base, candidates, queryPolicy),
    warnings,
  };
}
