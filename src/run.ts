import { basename } from "node:path";
import { performance } from "node:perf_hooks";

import { auditSite } from "./audit.js";
import { crawlSite } from "./crawl.js";
import { buildInitialCandidates, mergeRouteCandidates } from "./discovery/candidates.js";
import { discoverNextBuild } from "./discovery/next.js";
import { fetchRobots } from "./discovery/robots.js";
import { fetchSitemaps } from "./discovery/sitemap.js";
import { loadUrlLists, type UrlListInventory } from "./discovery/url-list.js";
import { redactReport } from "./redact.js";
import { captureRenderedPages } from "./rendered.js";
import type {
  BuildInventory,
  InputInventory,
  RouteCandidate,
  RouteLintConfig,
  RouteLintReport,
  RouteNode,
  SitemapInventory,
} from "./types.js";
import { REPORT_SCHEMA_VERSION, VERSION } from "./version.js";

function defaultSitemapUrl(baseUrl: string): string {
  return new URL("/sitemap.xml", new URL(baseUrl).origin).href;
}

function sitemapUrls(config: RouteLintConfig, declared: readonly string[]): readonly string[] {
  if (config.sitemaps !== "auto") return config.sitemaps;
  return declared.length > 0 ? declared : [defaultSitemapUrl(config.baseUrl)];
}

function emptySitemap(requested: readonly string[], warning: string): SitemapInventory {
  return { requested, fetched: [], entries: [], warnings: [warning] };
}

function safeSourceName(value: string): string {
  return value === "<stdin>" ? value : basename(value);
}

function safeUrlListMessage(message: string, source: string): string {
  return message.split(source).join(safeSourceName(source));
}

function urlListInputs(inventory: UrlListInventory): InputInventory {
  return {
    urlListFiles: inventory.sources.length,
    urlListUrls: inventory.urls.length,
    warnings: inventory.diagnostics
      .filter((diagnostic) => diagnostic.severity === "warning")
      .map((diagnostic) => safeUrlListMessage(diagnostic.message, diagnostic.source)),
  };
}

function urlListCandidates(inventory: UrlListInventory): readonly RouteCandidate[] {
  return inventory.entries.map((entry) => ({
    url: entry.url,
    depth: 0,
    sources: [
      {
        kind: "url-list",
        from: safeSourceName(entry.source),
        detail: `line ${entry.line}`,
      },
    ],
  }));
}

function configuredHeaderNames(headers: Readonly<Record<string, string>>): readonly string[] {
  return [...new Set(Object.keys(headers).map((name) => name.toLowerCase()))].sort();
}

async function addRenderedEvidence(
  routes: readonly RouteNode[],
  config: RouteLintConfig,
): Promise<readonly RouteNode[]> {
  if (config.rendered?.enabled !== true) return routes;
  const eligible = routes.filter((route) => {
    const snapshot = route.snapshots[0];
    return (
      snapshot?.completion === "complete" &&
      snapshot.status !== undefined &&
      snapshot.status >= 200 &&
      snapshot.status < 300 &&
      snapshot.redirects.length === 0 &&
      (snapshot.contentType === undefined ||
        /^(text\/html|application\/xhtml\+xml)\b/i.test(snapshot.contentType))
    );
  });
  const rendered = await captureRenderedPages(
    eligible.map((route) => route.url),
    {
      userAgent: config.agents[0]?.userAgent ?? "RouteLint rendered capture",
      headers: config.headers,
      timeoutMs: config.rendered.timeoutMs,
      settleMs: config.rendered.settleMs,
      concurrency: config.rendered.concurrency,
      maxBytes: config.limits.maxBytes,
    },
  );
  const byUrl = new Map(rendered.map((snapshot) => [snapshot.requestedUrl, snapshot]));
  return routes.map((route) => {
    const snapshot = byUrl.get(route.url);
    return snapshot === undefined ? route : { ...route, rendered: snapshot };
  });
}

export async function runRouteLint(config: RouteLintConfig): Promise<RouteLintReport> {
  const startedAt = performance.now();
  const urlLists = await loadUrlLists(config.urlFiles ?? [], { baseUrl: config.baseUrl });
  const inputErrors = urlLists.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (inputErrors.length > 0) {
    throw new Error(
      `Invalid URL-list input: ${inputErrors
        .map((diagnostic) => safeUrlListMessage(diagnostic.message, diagnostic.source))
        .join("; ")}`,
    );
  }
  const [robots, build] = await Promise.all([
    fetchRobots(config.baseUrl, {
      timeoutMs: config.limits.timeoutMs,
      maxBytes: Math.min(config.limits.maxBytes, 512 * 1024),
      headers: config.headers,
      headerOrigin: new URL(config.baseUrl).origin,
      maxRedirects: config.limits.maxRedirects,
    }),
    config.next === undefined
      ? Promise.resolve<BuildInventory | undefined>(undefined)
      : discoverNextBuild(config.next),
  ]);

  const requestedSitemaps = sitemapUrls(config, robots.sitemaps);
  const sitemap =
    requestedSitemaps.length === 0
      ? emptySitemap([], "No sitemap URL was configured or declared in robots.txt.")
      : await fetchSitemaps(requestedSitemaps, {
          timeoutMs: config.limits.timeoutMs,
          maxBytesPerSitemap: Math.max(config.limits.maxBytes, 10 * 1024 * 1024),
          headers: config.headers,
          headerOrigin: new URL(config.baseUrl).origin,
          maxRedirects: config.limits.maxRedirects,
        });

  const initial = buildInitialCandidates({
    baseUrl: config.baseUrl,
    seeds: config.seeds,
    sitemap,
    ...(build === undefined ? {} : { build }),
    queryPolicy: config.queryPolicy,
  });
  const effectiveSitemap: SitemapInventory =
    initial.warnings.length === 0
      ? sitemap
      : { ...sitemap, warnings: [...sitemap.warnings, ...initial.warnings] };

  const candidates = mergeRouteCandidates(
    config.baseUrl,
    [...initial.candidates, ...urlListCandidates(urlLists)],
    config.queryPolicy,
  );
  const crawled = await crawlSite({
    ...config.limits,
    baseUrl: config.baseUrl,
    seeds: config.seeds,
    candidates,
    agents: config.agents,
    headers: config.headers,
    include: config.include,
    exclude: config.exclude,
    queryPolicy: config.queryPolicy,
    respectRobots: config.respectRobots,
    robots,
  });
  const routes = await addRenderedEvidence(crawled.routes, config);

  const audit = auditSite({
    baseUrl: config.baseUrl,
    routes,
    sitemap: effectiveSitemap,
    robots,
    ...(build === undefined ? {} : { build }),
    options: config.audit,
    truncated: crawled.truncated,
  });

  const report: RouteLintReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    toolVersion: VERSION,
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startedAt),
    baseUrl: config.baseUrl,
    config: {
      maxPages: config.limits.maxPages,
      maxDepth: config.limits.maxDepth,
      agents: config.agents.map((agent) => agent.key),
      respectRobots: config.respectRobots,
      queryPolicy: config.queryPolicy,
      seeds: config.seeds,
      sitemapMode: config.sitemaps === "auto" ? "auto" : "explicit",
      sitemapUrls: config.sitemaps === "auto" ? [] : config.sitemaps,
      include: config.include,
      exclude: config.exclude,
      timeoutMs: config.limits.timeoutMs,
      maxBytes: config.limits.maxBytes,
      maxRedirects: config.limits.maxRedirects,
      rendered: config.rendered?.enabled ?? false,
      ...(config.rendered === undefined
        ? {}
        : {
            renderedConcurrency: config.rendered.concurrency,
            renderedTimeoutMs: config.rendered.timeoutMs,
            renderedSettleMs: config.rendered.settleMs,
          }),
      headerNames: configuredHeaderNames(config.headers),
      urlListFiles: config.urlFiles?.length ?? 0,
      audit: config.audit,
    },
    inputs: urlListInputs(urlLists),
    ...(build === undefined ? {} : { build }),
    sitemap: effectiveSitemap,
    robots,
    routes,
    findings: audit.findings,
    summary: audit.summary,
    truncated: crawled.truncated,
  };
  return redactReport(report, Object.values(config.headers));
}
