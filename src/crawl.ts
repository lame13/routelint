import { isRobotsAllowed, resolveRobotsAvailability } from "./discovery/robots.js";
import { emptyPageSignals } from "./html-parser.js";
import { capturePage } from "./http.js";
import type {
  AgentProfile,
  BuildRoute,
  CrawlOptions,
  PageSnapshot,
  RobotsFile,
  RouteCandidate,
  RouteNode,
  RouteSource,
  SitemapEntry,
} from "./types.js";
import { isSameOrigin, isUrlIncluded, normalizeUrl } from "./url.js";

export interface CrawlResult {
  readonly routes: readonly RouteNode[];
  readonly truncated: boolean;
}

interface MutableRoute {
  readonly url: string;
  depth: number;
  readonly sources: RouteSource[];
  sitemap?: SitemapEntry;
  build?: BuildRoute;
  snapshots: readonly PageSnapshot[];
  readonly inbound: Set<string>;
  readonly outbound: Set<string>;
  processed: boolean;
}

interface InitialCandidate {
  readonly url: string;
  depth: number;
  priority: number;
  readonly sources: RouteSource[];
  sitemap?: SitemapEntry;
  build?: BuildRoute;
}

type RobotsDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly unavailableMessage?: string };

class RequestLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next !== undefined) next();
    else this.active -= 1;
  }
}

/** Crawl a bounded same-origin route graph using deterministic breadth-first traversal. */
export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const normalizedBase = normalizeUrl(options.baseUrl, options.baseUrl, "keep");
  if (normalizedBase === undefined) {
    throw new Error("baseUrl must be an absolute HTTP(S) URL without credentials.");
  }
  if (options.agents.length === 0) throw new Error("At least one agent profile is required.");
  assertSafeInteger(options.maxPages, "maxPages", 0);
  assertSafeInteger(options.maxDepth, "maxDepth", 0);
  assertSafeInteger(options.concurrency, "concurrency", 1);
  assertSafeInteger(options.timeoutMs, "timeoutMs", 1);
  assertSafeInteger(options.maxBytes, "maxBytes", 0);
  assertSafeInteger(options.maxRedirects, "maxRedirects", 0);

  const maxPages = options.maxPages;
  const maxDepth = options.maxDepth;
  const concurrency = options.concurrency;
  const requestLimiter = new RequestLimiter(concurrency);
  const initial = collectInitialCandidates(options, normalizedBase);
  const initialWithinDepth = initial.filter((candidate) => candidate.depth <= maxDepth);
  const routes = new Map<string, MutableRoute>();
  let truncated =
    initialWithinDepth.length < initial.length || initialWithinDepth.length > maxPages;

  for (const candidate of initialWithinDepth.slice(0, maxPages)) {
    routes.set(candidate.url, {
      url: candidate.url,
      depth: candidate.depth,
      sources: [...candidate.sources],
      ...(candidate.sitemap === undefined ? {} : { sitemap: candidate.sitemap }),
      ...(candidate.build === undefined ? {} : { build: candidate.build }),
      snapshots: [],
      inbound: new Set(),
      outbound: new Set(),
      processed: false,
    });
  }

  for (;;) {
    const pending = [...routes.values()].filter((route) => !route.processed);
    if (pending.length === 0) break;
    const nextDepth = Math.min(...pending.map((route) => route.depth));
    const level = pending
      .filter((route) => route.depth === nextDepth)
      .sort((left, right) => left.url.localeCompare(right.url));

    for (let offset = 0; offset < level.length; offset += concurrency) {
      const batch = level.slice(offset, offset + concurrency);
      const results = await Promise.all(
        batch.map(async (route) => ({
          route,
          snapshots: await captureAgents(route.url, options, requestLimiter),
        })),
      );

      // Promise.all preserves batch order, so link discovery is independent of response timing.
      for (const result of results) {
        const route = result.route;
        route.snapshots = result.snapshots;
        route.processed = true;
        const primary = result.snapshots[0];
        if (!canDiscoverFrom(primary)) continue;

        const discovered = new Set<string>();
        for (const link of primary.signals.links) {
          if (link.resolvedUrl === undefined) continue;
          const target = normalizeUrl(link.resolvedUrl, primary.finalUrl, options.queryPolicy);
          if (target === undefined || !isSameOrigin(target, normalizedBase)) continue;
          if (isCloudflareEmailProtectionLink(target)) continue;
          if (!isUrlIncluded(target, options.include, options.exclude)) continue;
          discovered.add(target);
        }

        for (const target of [...discovered].sort((left, right) => left.localeCompare(right))) {
          route.outbound.add(target);
          const existing = routes.get(target);
          if (existing !== undefined) {
            existing.inbound.add(route.url);
            addSource(existing.sources, { kind: "internal-link", from: route.url });
            if (!existing.processed) existing.depth = Math.min(existing.depth, route.depth + 1);
            continue;
          }

          const targetDepth = route.depth + 1;
          if (targetDepth > maxDepth || routes.size >= maxPages) {
            truncated = true;
            continue;
          }
          routes.set(target, {
            url: target,
            depth: targetDepth,
            sources: [{ kind: "internal-link", from: route.url }],
            snapshots: [],
            inbound: new Set([route.url]),
            outbound: new Set(),
            processed: false,
          });
        }
      }
    }
  }

  applyInternalDepths(routes);
  return {
    routes: [...routes.values()].sort(compareRouteDepth).map(toRouteNode),
    truncated,
  };
}

function applyInternalDepths(routes: ReadonlyMap<string, MutableRoute>): void {
  const queue: MutableRoute[] = [];
  for (const route of routes.values()) {
    if (route.sources.some((source) => source.kind === "seed")) {
      route.depth = 0;
      queue.push(route);
    } else {
      route.depth = -1;
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const route = queue[cursor];
    if (route === undefined) continue;
    for (const targetUrl of route.outbound) {
      const target = routes.get(targetUrl);
      if (target === undefined) continue;
      const nextDepth = route.depth + 1;
      if (target.depth >= 0 && target.depth <= nextDepth) continue;
      target.depth = nextDepth;
      queue.push(target);
    }
  }
}

function compareRouteDepth(left: MutableRoute, right: MutableRoute): number {
  const leftDepth = left.depth < 0 ? Number.MAX_SAFE_INTEGER : left.depth;
  const rightDepth = right.depth < 0 ? Number.MAX_SAFE_INTEGER : right.depth;
  return leftDepth - rightDepth || left.url.localeCompare(right.url);
}

export const crawl = crawlSite;

function isCloudflareEmailProtectionLink(url: string): boolean {
  return new URL(url).pathname === "/cdn-cgi/l/email-protection";
}

export function isAllowedByRobots(
  robots: RobotsFile | undefined,
  url: string,
  agent: AgentProfile,
): boolean {
  if (robots === undefined) return false;
  if (!isSameOrigin(url, robots.url)) return true;
  return isRobotsAllowed(robots, url, agent.userAgent);
}

function robotsDecision(
  robots: RobotsFile | undefined,
  url: string,
  agent: AgentProfile,
): RobotsDecision {
  if (robots !== undefined && !isSameOrigin(url, robots.url)) return { allowed: true };
  const availability = resolveRobotsAvailability(robots);
  if (availability.state === "unavailable") {
    const detail =
      availability.reason === "not-fetched"
        ? "robots.txt was not fetched"
        : `robots.txt is unavailable (${availability.reason})`;
    return {
      allowed: false,
      unavailableMessage: `${detail}; request skipped while robots rules are respected.`,
    };
  }
  if (availability.state === "missing") return { allowed: true };
  return { allowed: robots !== undefined && isRobotsAllowed(robots, url, agent.userAgent) };
}

function collectInitialCandidates(
  options: CrawlOptions,
  normalizedBase: string,
): readonly InitialCandidate[] {
  const candidates = new Map<string, InitialCandidate>();
  for (const seed of options.seeds) {
    addInitial(
      candidates,
      { url: seed, depth: 0, sources: [{ kind: "seed" }] },
      options,
      normalizedBase,
      0,
    );
  }
  for (const candidate of options.candidates) {
    const priority = candidate.sources.some(
      (source) => source.kind === "redirect-contract" && source.detail === "source",
    )
      ? 0
      : 1;
    addInitial(candidates, candidate, options, normalizedBase, priority);
  }
  return [...candidates.values()].sort(
    (left, right) =>
      left.depth - right.depth ||
      left.priority - right.priority ||
      left.url.localeCompare(right.url),
  );
}

function addInitial(
  destination: Map<string, InitialCandidate>,
  candidate: RouteCandidate,
  options: CrawlOptions,
  normalizedBase: string,
  priority: number,
): void {
  const url = normalizeUrl(candidate.url, normalizedBase, options.queryPolicy);
  if (url === undefined || !isSameOrigin(url, normalizedBase)) return;
  if (!isUrlIncluded(url, options.include, options.exclude)) return;
  const depth = Number.isSafeInteger(candidate.depth) && candidate.depth >= 0 ? candidate.depth : 0;
  const existing = destination.get(url);
  if (existing === undefined) {
    destination.set(url, {
      url,
      depth,
      priority,
      sources: deduplicateSources(candidate.sources),
      ...(candidate.sitemap === undefined ? {} : { sitemap: candidate.sitemap }),
      ...(candidate.build === undefined ? {} : { build: candidate.build }),
    });
    return;
  }
  existing.depth = Math.min(existing.depth, depth);
  existing.priority = Math.min(existing.priority, priority);
  for (const source of candidate.sources) addSource(existing.sources, source);
  if (existing.sitemap === undefined && candidate.sitemap !== undefined) {
    existing.sitemap = candidate.sitemap;
  }
  if (existing.build === undefined && candidate.build !== undefined)
    existing.build = candidate.build;
}

async function captureAgents(
  url: string,
  options: CrawlOptions,
  requestLimiter: RequestLimiter,
): Promise<readonly PageSnapshot[]> {
  return Promise.all(
    options.agents.map((agent) => {
      if (options.respectRobots) {
        const decision = robotsDecision(options.robots, url, agent);
        if (!decision.allowed) {
          return Promise.resolve(blockedSnapshot(url, agent, decision.unavailableMessage));
        }
      }
      return requestLimiter.run(() =>
        capturePage(url, {
          agent,
          headers: options.headers,
          timeoutMs: options.timeoutMs,
          maxBytes: options.maxBytes,
          maxRedirects: options.maxRedirects,
        }),
      );
    }),
  );
}

function blockedSnapshot(
  url: string,
  agent: AgentProfile,
  unavailableMessage?: string,
): PageSnapshot {
  return {
    requestedUrl: url,
    finalUrl: url,
    agent,
    headers: {},
    redirects: [],
    signals: emptyPageSignals(),
    bytesRead: 0,
    durationMs: 0,
    completion: "robots-blocked",
    ...(unavailableMessage === undefined ? {} : { error: unavailableMessage }),
  };
}

function canDiscoverFrom(snapshot: PageSnapshot | undefined): snapshot is PageSnapshot {
  return (
    snapshot !== undefined &&
    snapshot.completion === "complete" &&
    snapshot.status !== undefined &&
    snapshot.status >= 200 &&
    snapshot.status < 300
  );
}

function toRouteNode(route: MutableRoute): RouteNode {
  return {
    url: route.url,
    depth: route.depth,
    sources: [...route.sources].sort(compareSources),
    ...(route.sitemap === undefined ? {} : { sitemap: route.sitemap }),
    ...(route.build === undefined ? {} : { build: route.build }),
    snapshots: route.snapshots,
    inbound: [...route.inbound].sort((left, right) => left.localeCompare(right)),
    outbound: [...route.outbound].sort((left, right) => left.localeCompare(right)),
  };
}

function deduplicateSources(sources: readonly RouteSource[]): RouteSource[] {
  const result: RouteSource[] = [];
  for (const source of sources) addSource(result, source);
  return result;
}

function addSource(sources: RouteSource[], source: RouteSource): void {
  const key = sourceKey(source);
  if (!sources.some((existing) => sourceKey(existing) === key)) sources.push(source);
}

function sourceKey(source: RouteSource): string {
  return `${source.kind}\u0000${source.from ?? ""}\u0000${source.detail ?? ""}`;
}

function compareSources(left: RouteSource, right: RouteSource): number {
  return sourceKey(left).localeCompare(sourceKey(right));
}

function assertSafeInteger(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
}
