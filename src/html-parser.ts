import { Parser } from "htmlparser2";
import type {
  HreflangSignal,
  LinkSignal,
  MetadataSignal,
  PageSignals,
  RobotsSignal,
} from "./types.js";

interface TextCapture {
  readonly location: MetadataSignal["location"];
  readonly chunks: string[];
}

interface AnchorCapture {
  readonly href: string;
  readonly rel: readonly string[];
  readonly fallbackText: string;
  readonly chunks: string[];
}

interface PendingHreflang {
  readonly language: string;
  readonly href: string;
}

export function emptyPageSignals(): PageSignals {
  return {
    titles: [],
    descriptions: [],
    canonicals: [],
    robots: [],
    h1s: [],
    links: [],
    hreflangs: [],
  };
}

/** Parse signals from server-delivered HTML. This intentionally does not execute JavaScript. */
export function parseHtml(html: string, documentUrl: string): PageSignals {
  const titles: MetadataSignal[] = [];
  const descriptions: MetadataSignal[] = [];
  const canonicals: MetadataSignal[] = [];
  const robots: RobotsSignal[] = [];
  const h1s: MetadataSignal[] = [];
  const pendingLinks: AnchorCapture[] = [];
  const pendingHreflangs: PendingHreflang[] = [];
  const openAnchors: AnchorCapture[] = [];
  const titleCaptures: TextCapture[] = [];
  const h1Captures: TextCapture[] = [];
  let headDepth = 0;
  let templateDepth = 0;
  let ignoredTextDepth = 0;
  let htmlLang: string | undefined;
  let baseHref: string | undefined;

  const location = (): MetadataSignal["location"] => (headDepth > 0 ? "head" : "body");
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase();
        if (tag === "template") templateDepth += 1;
        // Template contents are inert fragments, not signals from the document.
        if (templateDepth > 0) return;
        if (tag === "head") headDepth += 1;
        if (tag === "script" || tag === "style") ignoredTextDepth += 1;

        if (tag === "html" && htmlLang === undefined) {
          if (Object.hasOwn(attributes, "lang"))
            htmlLang = collapseWhitespace(attributes.lang ?? "");
        } else if (tag === "base" && baseHref === undefined) {
          if (Object.hasOwn(attributes, "href"))
            baseHref = collapseWhitespace(attributes.href ?? "");
        } else if (tag === "title") {
          titleCaptures.push({ location: location(), chunks: [] });
        } else if (tag === "h1") {
          h1Captures.push({ location: location(), chunks: [] });
        } else if (tag === "meta") {
          captureMeta(attributes, location(), descriptions, robots);
        } else if (tag === "link") {
          captureHeadLink(attributes, location(), canonicals, pendingHreflangs);
        } else if (tag === "a" && Object.hasOwn(attributes, "href")) {
          const rel = parseRel(attributes.rel);
          openAnchors.push({
            href: attributes.href ?? "",
            rel,
            fallbackText: cleanOptional(attributes["aria-label"] ?? attributes.title) ?? "",
            chunks: [],
          });
        } else if (tag === "img" && openAnchors.length > 0) {
          const alt = cleanOptional(attributes.alt);
          if (alt !== undefined) openAnchors.at(-1)?.chunks.push(` ${alt} `);
        }
      },
      ontext(value) {
        if (templateDepth > 0 || ignoredTextDepth > 0) return;
        titleCaptures.at(-1)?.chunks.push(value);
        h1Captures.at(-1)?.chunks.push(value);
        openAnchors.at(-1)?.chunks.push(value);
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (tag === "template") {
          templateDepth = Math.max(0, templateDepth - 1);
          return;
        }
        if (templateDepth > 0) return;
        if (tag === "title") finishTextCapture(titleCaptures, titles);
        if (tag === "h1") finishTextCapture(h1Captures, h1s);
        if (tag === "a") {
          const anchor = openAnchors.pop();
          if (anchor !== undefined) pendingLinks.push(anchor);
        }
        if (tag === "script" || tag === "style") {
          ignoredTextDepth = Math.max(0, ignoredTextDepth - 1);
        }
        if (tag === "head") headDepth = Math.max(0, headDepth - 1);
      },
    },
    { decodeEntities: true },
  );

  parser.end(html);
  while (titleCaptures.length > 0) finishTextCapture(titleCaptures, titles);
  while (h1Captures.length > 0) finishTextCapture(h1Captures, h1s);
  while (openAnchors.length > 0) {
    const anchor = openAnchors.pop();
    if (anchor !== undefined) pendingLinks.push(anchor);
  }

  const resolutionBase = resolveDocumentBase(baseHref, documentUrl);
  const links: LinkSignal[] = pendingLinks.map((link) => {
    const text = collapseWhitespace(link.chunks.join("")) || link.fallbackText;
    const resolvedUrl = resolveWebUrl(link.href, resolutionBase);
    return {
      href: link.href,
      ...(resolvedUrl === undefined ? {} : { resolvedUrl }),
      text,
      rel: link.rel,
      nofollow: link.rel.includes("nofollow"),
    };
  });
  const hreflangs: HreflangSignal[] = pendingHreflangs.map((signal) => {
    const resolvedUrl = resolveWebUrl(signal.href, resolutionBase);
    return {
      language: signal.language,
      href: signal.href,
      ...(resolvedUrl === undefined ? {} : { resolvedUrl }),
    };
  });

  return {
    titles,
    descriptions,
    canonicals,
    robots,
    h1s,
    links,
    hreflangs,
    ...(htmlLang === undefined ? {} : { htmlLang }),
    ...(baseHref === undefined ? {} : { baseHref }),
  };
}

/** Convert one combined X-Robots-Tag header value into audience-aware signals. */
export function parseXRobotsTag(value: string | null): readonly RobotsSignal[] {
  if (value === null || value.trim().length === 0) return [];
  const signals: RobotsSignal[] = [];
  let audience: RobotsSignal["audience"] | undefined = "robots";

  for (const rawPart of value.split(",")) {
    let directive = rawPart.trim();
    if (directive.length === 0) continue;
    const prefixed = directive.match(/^([a-z][a-z0-9_-]*)\s*:\s*(.+)$/i);
    if (prefixed !== null) {
      const prefix = prefixed[1]?.toLowerCase() ?? "";
      if (prefix === "googlebot" || prefix === "bingbot" || prefix === "robots") {
        audience = prefix;
        directive = prefixed[2]?.trim() ?? "";
      } else if (prefix.endsWith("bot")) {
        audience = undefined;
        continue;
      }
    }
    if (audience !== undefined && directive.length > 0) {
      signals.push({ value: directive, location: "head", audience, source: "header" });
    }
  }
  return signals;
}

function captureMeta(
  attributes: Readonly<Record<string, string>>,
  location: MetadataSignal["location"],
  descriptions: MetadataSignal[],
  robots: RobotsSignal[],
): void {
  const name = cleanOptional(attributes.name)?.toLowerCase();
  if (name === undefined || !Object.hasOwn(attributes, "content")) return;
  const content = collapseWhitespace(attributes.content ?? "");
  if (name === "description") descriptions.push({ value: content, location });
  if (name === "robots" || name === "googlebot" || name === "bingbot") {
    robots.push({ value: content, location, audience: name, source: "meta" });
  }
}

function captureHeadLink(
  attributes: Readonly<Record<string, string>>,
  location: MetadataSignal["location"],
  canonicals: MetadataSignal[],
  hreflangs: PendingHreflang[],
): void {
  if (!Object.hasOwn(attributes, "href")) return;
  const href = collapseWhitespace(attributes.href ?? "");
  const rel = parseRel(attributes.rel);
  if (rel.includes("canonical")) canonicals.push({ value: href, location });
  const language = cleanOptional(attributes.hreflang);
  if (rel.includes("alternate") && language !== undefined) {
    hreflangs.push({ language, href });
  }
}

function finishTextCapture(stack: TextCapture[], destination: MetadataSignal[]): void {
  const capture = stack.pop();
  if (capture === undefined) return;
  const value = collapseWhitespace(capture.chunks.join(""));
  destination.push({ value, location: capture.location });
}

function parseRel(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return [...new Set(value.toLowerCase().split(/\s+/).filter(Boolean))];
}

function resolveDocumentBase(baseHref: string | undefined, documentUrl: string): string {
  if (baseHref === undefined) return documentUrl;
  return resolveWebUrl(baseHref, documentUrl) ?? documentUrl;
}

function resolveWebUrl(input: string, base: string): string | undefined {
  try {
    const url = new URL(input, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function cleanOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = collapseWhitespace(value);
  return clean.length === 0 ? undefined : clean;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
