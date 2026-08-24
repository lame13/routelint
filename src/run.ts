import { performance } from "node:perf_hooks";

import { auditSite } from "./audit.js";
import { crawlSite } from "./crawl.js";
import { buildInitialCandidates } from "./discovery/candidates.js";
import { discoverNextBuild } from "./discovery/next.js";
import { fetchRobots } from "./discovery/robots.js";
import { fetchSitemaps } from "./discovery/sitemap.js";
import { redactReport } from "./redact.js";
import type {
  BuildInventory,
  RouteLintConfig,
  RouteLintReport,
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

export async function runRouteLint(config: RouteLintConfig): Promise<RouteLintReport> {
  const startedAt = performance.now();
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

  const crawled = await crawlSite({
    ...config.limits,
    baseUrl: config.baseUrl,
    seeds: config.seeds,
    candidates: initial.candidates,
    agents: config.agents,
    headers: config.headers,
    include: config.include,
    exclude: config.exclude,
    queryPolicy: config.queryPolicy,
    respectRobots: config.respectRobots,
    robots,
  });

  const audit = auditSite({
    baseUrl: config.baseUrl,
    routes: crawled.routes,
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
    },
    ...(build === undefined ? {} : { build }),
    sitemap: effectiveSitemap,
    robots,
    routes: crawled.routes,
    findings: audit.findings,
    summary: audit.summary,
    truncated: crawled.truncated,
  };
  return redactReport(report, Object.values(config.headers));
}
