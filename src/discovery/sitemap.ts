import { Parser } from "htmlparser2";

import type { HreflangSignal, SitemapEntry, SitemapInventory } from "../types.js";
import { fetchWithScopedHeaders } from "./fetch.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_SITEMAPS = 100;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 100_000;

export interface FetchSitemapsOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxBytesPerSitemap?: number;
  readonly maxSitemaps?: number;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly headerOrigin?: string | URL;
  readonly maxRedirects?: number;
}

export interface ParsedSitemap {
  readonly kind: "urlset" | "index" | "unknown";
  readonly entries: readonly SitemapEntry[];
  readonly childSitemaps: readonly string[];
  readonly warnings: readonly string[];
}

interface MutableUrlEntry {
  loc?: string;
  lastModified?: string;
  readonly alternates: HreflangSignal[];
}

interface MutableSitemapEntry {
  loc?: string;
}

interface TextCapture {
  readonly tag: "loc" | "lastmod";
  readonly owner: "url" | "sitemap";
  value: string;
}

class SitemapLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Sitemap exceeded the ${limit}-byte limit.`);
    this.name = "SitemapLimitError";
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Sitemap limits must be positive safe integers.");
  }
  return value;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Sitemap depth must be a non-negative safe integer.");
  }
  return value;
}

function localName(name: string): string {
  const colonAt = name.lastIndexOf(":");
  return (colonAt === -1 ? name : name.slice(colonAt + 1)).toLowerCase();
}

function attributeByLocalName(
  attributes: Readonly<Record<string, string>>,
  wanted: string,
): string | undefined {
  for (const [name, value] of Object.entries(attributes)) {
    if (localName(name) === wanted) return value;
  }
  return undefined;
}

function normalizeHttpUrl(value: string, base: string): string | undefined {
  try {
    const parsed = new URL(value.trim(), base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password) return undefined;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
}

/** Parse a sitemap document with a streaming XML parser rather than document-wide regular expressions. */
export function parseSitemapXml(xml: string, sitemapUrl: string | URL): ParsedSitemap {
  const base = normalizeHttpUrl(String(sitemapUrl), String(sitemapUrl));
  if (!base)
    throw new TypeError("Sitemap URLs must use HTTP or HTTPS and must not contain credentials.");

  const entries: SitemapEntry[] = [];
  const childSitemaps: string[] = [];
  const warnings: string[] = [];
  const elementStack: string[] = [];
  let rootKind: ParsedSitemap["kind"] = "unknown";
  let currentUrl: MutableUrlEntry | undefined;
  let currentSitemap: MutableSitemapEntry | undefined;
  let capture: TextCapture | undefined;
  let parserError: Error | undefined;

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = localName(name);
        const parent = elementStack.at(-1);
        if (elementStack.length === 0) {
          if (tag === "urlset") rootKind = "urlset";
          if (tag === "sitemapindex") rootKind = "index";
        }

        if (tag === "url" && rootKind === "urlset") {
          currentUrl = { alternates: [] };
        } else if (tag === "sitemap" && rootKind === "index") {
          currentSitemap = {};
        } else if (tag === "loc" && parent === "url" && currentUrl) {
          capture = { tag: "loc", owner: "url", value: "" };
        } else if (tag === "lastmod" && parent === "url" && currentUrl) {
          capture = { tag: "lastmod", owner: "url", value: "" };
        } else if (tag === "loc" && parent === "sitemap" && currentSitemap) {
          capture = { tag: "loc", owner: "sitemap", value: "" };
        } else if (tag === "link" && parent === "url" && currentUrl) {
          const rel = attributeByLocalName(attributes, "rel")?.toLowerCase();
          const language = attributeByLocalName(attributes, "hreflang")?.trim();
          const href = attributeByLocalName(attributes, "href")?.trim();
          if (rel?.split(/\s+/u).includes("alternate") && language && href) {
            const resolvedUrl = normalizeHttpUrl(href, base);
            if (resolvedUrl) {
              currentUrl.alternates.push({ language, href, resolvedUrl });
            } else {
              warnings.push(`Ignored an invalid alternate URL in ${base}.`);
            }
          }
        }
        elementStack.push(tag);
      },
      ontext(text) {
        if (capture) capture.value += text;
      },
      onclosetag(name) {
        const tag = localName(name);
        if (capture?.tag === tag) {
          const value = capture.value.trim();
          if (capture.owner === "url" && currentUrl) {
            if (capture.tag === "loc") currentUrl.loc = value;
            if (capture.tag === "lastmod") currentUrl.lastModified = value;
          }
          if (capture.owner === "sitemap" && currentSitemap && capture.tag === "loc") {
            currentSitemap.loc = value;
          }
          capture = undefined;
        }

        if (tag === "url" && currentUrl) {
          if (currentUrl.loc) {
            const url = normalizeHttpUrl(currentUrl.loc, base);
            if (url) {
              entries.push({
                url,
                sitemapUrl: base,
                ...(currentUrl.lastModified ? { lastModified: currentUrl.lastModified } : {}),
                alternates: [...currentUrl.alternates],
              });
            } else {
              warnings.push(`Ignored an invalid URL in ${base}.`);
            }
          } else {
            warnings.push(`Ignored a sitemap <url> without <loc> in ${base}.`);
          }
          currentUrl = undefined;
        }

        if (tag === "sitemap" && currentSitemap) {
          if (currentSitemap.loc) {
            const url = normalizeHttpUrl(currentSitemap.loc, base);
            if (url) childSitemaps.push(url);
            else warnings.push(`Ignored an invalid child sitemap URL in ${base}.`);
          } else {
            warnings.push(`Ignored a <sitemap> without <loc> in ${base}.`);
          }
          currentSitemap = undefined;
        }
        elementStack.pop();
      },
      onerror(error) {
        parserError = error;
      },
    },
    { xmlMode: true, decodeEntities: true, lowerCaseTags: false },
  );

  parser.end(xml);
  if (parserError) throw parserError;
  if (rootKind === "unknown") warnings.push(`Unsupported sitemap root element in ${base}.`);
  return {
    kind: rootKind,
    entries,
    childSitemaps: [...new Set(childSitemaps)],
    warnings,
  };
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new SitemapLimitError(maxBytes);
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new SitemapLimitError(maxBytes);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  const output: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw new SitemapLimitError(maxBytes);
      output.push(decoder.decode(value, { stream: true }));
    }
    output.push(decoder.decode());
    return output.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

interface SitemapQueueItem {
  readonly url: string;
  readonly depth: number;
}

/** Fetch sitemap files and bounded, recursively discovered sitemap indexes. */
export async function fetchSitemaps(
  requestedUrls: readonly (string | URL)[],
  options: FetchSitemapsOptions = {},
): Promise<SitemapInventory> {
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = positiveInteger(options.maxBytesPerSitemap, DEFAULT_MAX_BYTES);
  const maxSitemaps = positiveInteger(options.maxSitemaps, DEFAULT_MAX_SITEMAPS);
  const maxDepth = nonNegativeInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const warnings: string[] = [];
  const requested: string[] = [];
  const queue: SitemapQueueItem[] = [];

  for (const value of requestedUrls) {
    const normalized = normalizeHttpUrl(String(value), String(value));
    if (!normalized) {
      warnings.push(`Ignored invalid sitemap URL: ${String(value)}`);
      continue;
    }
    if (!requested.includes(normalized)) {
      requested.push(normalized);
      queue.push({ url: normalized, depth: 0 });
    }
  }

  const visited = new Set<string>();
  const fetched: string[] = [];
  const entryByUrl = new Map<string, SitemapEntry>();
  let sitemapLimitWarned = false;
  let entryLimitWarned = false;

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || visited.has(item.url)) continue;
    if (visited.size >= maxSitemaps) {
      if (!sitemapLimitWarned) {
        warnings.push(`Stopped after reaching the ${maxSitemaps}-sitemap limit.`);
        sitemapLimitWarned = true;
      }
      break;
    }
    visited.add(item.url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { response, finalUrl } = await fetchWithScopedHeaders(item.url, {
        fetch: fetchImplementation,
        headers: options.headers,
        headerOrigin: options.headerOrigin ?? new URL(item.url).origin,
        accept: "application/xml, text/xml;q=0.9, text/plain;q=0.5",
        signal: controller.signal,
        maxRedirects: options.maxRedirects,
      });
      fetched.push(item.url);
      if (!response.ok) {
        warnings.push(`${item.url} returned HTTP ${response.status}.`);
        continue;
      }

      const responseBase = normalizeHttpUrl(finalUrl, item.url) ?? item.url;
      const parsed = parseSitemapXml(await readLimitedText(response, maxBytes), responseBase);
      warnings.push(...parsed.warnings);
      for (const entry of parsed.entries) {
        if (entryByUrl.has(entry.url)) continue;
        if (entryByUrl.size >= maxEntries) {
          if (!entryLimitWarned) {
            warnings.push(`Stopped collecting URLs after reaching the ${maxEntries}-entry limit.`);
            entryLimitWarned = true;
          }
          break;
        }
        entryByUrl.set(entry.url, entry);
      }

      if (parsed.kind === "index") {
        for (const childUrl of parsed.childSitemaps) {
          if (visited.has(childUrl) || queue.some((queued) => queued.url === childUrl)) continue;
          if (item.depth >= maxDepth) {
            warnings.push(
              `Did not follow ${childUrl}: sitemap index depth limit ${maxDepth} reached.`,
            );
            continue;
          }
          queue.push({ url: childUrl, depth: item.depth + 1 });
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        warnings.push(`${item.url} timed out after ${timeoutMs}ms.`);
      } else if (error instanceof SitemapLimitError) {
        warnings.push(`${item.url}: ${error.message}`);
      } else {
        warnings.push(
          `Could not fetch or parse ${item.url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    requested,
    fetched,
    entries: [...entryByUrl.values()],
    warnings,
  };
}
