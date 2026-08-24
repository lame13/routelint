import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  diffReports,
  parseRouteLintReport,
  readRouteLintReport,
  renderDiffJson,
  renderDiffTerminal,
} from "../src/diff.js";
import type {
  Finding,
  PageSignals,
  PageSnapshot,
  RenderMode,
  RouteLintReport,
  RouteNode,
} from "../src/types.js";

const origin = "https://example.test";
const temporaryDirectories: string[] = [];
const agent = {
  key: "routelint",
  label: "RouteLint",
  userAgent: "RouteLint/Test",
} as const;
const browserAgent = {
  key: "browser",
  label: "Browser",
  userAgent: "Browser/Test",
} as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function absolute(path: string): string {
  return new URL(path, origin).href;
}

function page(
  path: string,
  overrides: Partial<PageSnapshot> = {},
  signalOverrides: Partial<PageSignals> = {},
): PageSnapshot {
  const url = absolute(path);
  return {
    requestedUrl: url,
    finalUrl: url,
    agent,
    status: 200,
    contentType: "text/html",
    headers: { "content-type": "text/html" },
    redirects: [],
    signals: {
      titles: [{ value: "Title", location: "head" }],
      descriptions: [{ value: "Description", location: "head" }],
      canonicals: [{ value: url, location: "head" }],
      robots: [],
      h1s: [{ value: "Heading", location: "body" }],
      links: [],
      hreflangs: [],
      ...signalOverrides,
    },
    bytesRead: 100,
    durationMs: 3,
    completion: "complete",
    ...overrides,
  };
}

function route(path: string, snapshot = page(path), renderMode: RenderMode = "static"): RouteNode {
  return {
    url: absolute(path),
    depth: 0,
    sources: [{ kind: "seed" }],
    build: {
      pathname: path,
      renderMode,
      sourceManifest: ".next/routes-manifest.json",
    },
    snapshots: [snapshot],
    inbound: [],
    outbound: [],
  };
}

function report(
  routes: readonly RouteNode[] = [],
  findings: readonly Finding[] = [],
  generatedAt = "2026-08-22T00:00:00.000Z",
): RouteLintReport {
  return {
    schemaVersion: "1",
    toolVersion: "0.1.0",
    generatedAt,
    durationMs: 10,
    baseUrl: `${origin}/`,
    config: {
      maxPages: 100,
      maxDepth: 5,
      agents: ["routelint"],
      respectRobots: true,
      queryPolicy: "drop",
    },
    sitemap: { requested: [], fetched: [], entries: [], warnings: [] },
    routes,
    findings,
    summary: {
      routes: routes.length,
      fetched: routes.length,
      indexable: routes.length,
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length,
      info: findings.filter((finding) => finding.severity === "info").length,
      brokenLinks: 0,
      redirects: 0,
      noindex: 0,
      maxDepth: 0,
    },
    truncated: false,
  };
}

describe("report validation", () => {
  it("accepts a complete schema-v1 report without rewriting it", () => {
    const value = report([route("/"), { ...route("/orphan"), depth: -1 }]);

    expect(parseRouteLintReport(value)).toBe(value);
  });

  it("round-trips complete schema-v2 evidence and comparison metadata", () => {
    const content = {
      characters: 128,
      words: 24,
      sha256: "a".repeat(64),
      simhash: "b".repeat(16),
    };
    const snapshot = page("/listed", { content });
    const listedRoute = {
      ...route("/listed", snapshot),
      sources: [{ kind: "url-list" as const, from: "targets.txt", detail: "line 4" }],
      rendered: {
        requestedUrl: absolute("/listed"),
        finalUrl: absolute("/listed"),
        status: 200,
        completion: "complete" as const,
        signals: snapshot.signals,
        content,
        htmlBytes: 512,
        durationMs: 18,
      },
    };
    const value = {
      ...report([listedRoute], [], "2026-08-24T00:00:00.000Z"),
      schemaVersion: "2",
      toolVersion: "0.2.0",
      config: {
        maxPages: 250,
        maxDepth: 8,
        agents: ["routelint", "browser"],
        respectRobots: true,
        queryPolicy: "keep" as const,
        seeds: [`${origin}/`, `${origin}/products`],
        sitemapMode: "explicit" as const,
        sitemapUrls: [`${origin}/sitemap.xml`],
        include: ["/products/**"],
        exclude: ["/products/drafts/**"],
        timeoutMs: 12_000,
        maxBytes: 1_000_000,
        maxRedirects: 4,
        rendered: true,
        renderedConcurrency: 2,
        renderedTimeoutMs: 20_000,
        renderedSettleMs: 250,
        headerNames: ["authorization", "x-preview-key"],
        urlListFiles: 1,
        audit: {
          requireTitle: true,
          requireDescription: true,
          requireCanonical: true,
          requireH1: true,
          requireSitemapCoverage: false,
          maxDepth: 6,
          severities: { "missing-title": "error" as const },
          paths: [
            {
              include: ["/products/**"],
              exclude: ["/products/drafts/**"],
              requireDescription: false,
              maxDepth: 3,
              severities: { "missing-canonical": "warning" as const },
            },
          ],
        },
      },
      inputs: {
        urlListFiles: 1,
        urlListUrls: 1,
        warnings: ["targets.txt: ignored one off-origin URL"],
      },
      comparison: {
        mode: "changed-only" as const,
        baselineGeneratedAt: "2026-08-20T00:00:00.000Z",
        newFindings: 2,
        worsenedFindings: 1,
        resolvedFindings: 3,
        unchangedFindings: 5,
      },
    } satisfies RouteLintReport;
    const roundTripped: unknown = JSON.parse(JSON.stringify(value));

    expect(parseRouteLintReport(roundTripped)).toEqual(value);
  });

  it("validates and preserves robots availability while accepting legacy reports", () => {
    const unavailable = {
      ...report(),
      robots: {
        url: `${origin}/robots.txt`,
        status: 503,
        availability: { state: "unavailable", reason: "http-error" },
        groups: [],
        sitemaps: [],
        warnings: ["robots.txt is unavailable."],
      },
    } satisfies RouteLintReport;

    expect(parseRouteLintReport(unavailable).robots?.availability).toEqual({
      state: "unavailable",
      reason: "http-error",
    });
    expect(() =>
      parseRouteLintReport({
        ...unavailable,
        robots: { ...unavailable.robots, availability: { state: "unavailable", reason: "bogus" } },
      }),
    ).toThrow("robots.availability.reason");
    const { availability: _availability, ...legacyRobots } = unavailable.robots;
    expect(
      parseRouteLintReport({ ...unavailable, robots: legacyRobots }).robots?.availability,
    ).toBe(undefined);
  });

  it.each([
    [null, "report"],
    [{ ...report(), schemaVersion: "3" }, "schemaVersion"],
    [
      (() => {
        const { summary: _summary, ...missingSummary } = report();
        return missingSummary;
      })(),
      "summary",
    ],
    [
      {
        ...report([route("/")]),
        routes: [{ ...route("/"), snapshots: [{ status: 200 }] }],
      },
      "routes.0.snapshots.0.requestedUrl",
    ],
    [
      {
        ...report([], [{ code: "bad", severity: "urgent" as "error", message: "Bad" }]),
      },
      "findings.0.severity",
    ],
    [
      {
        ...report(),
        config: { ...report().config, timeoutMs: 0 },
      },
      "config.timeoutMs",
    ],
  ])("rejects malformed report data at %s", (value, expectedPath) => {
    expect(() => parseRouteLintReport(value)).toThrow(expectedPath);
  });

  it("reports unreadable and malformed JSON files separately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "routelint-diff-"));
    temporaryDirectories.push(directory);
    const invalidPath = join(directory, "invalid.json");
    await writeFile(invalidPath, "{ definitely not JSON", "utf8");

    await expect(readRouteLintReport(join(directory, "missing.json"))).rejects.toThrow(
      "Could not read report",
    );
    await expect(readRouteLintReport(invalidPath)).rejects.toThrow("Could not parse JSON report");
  });
});

describe("diffReports", () => {
  it("diffs secondary-agent delivery and SEO signals", () => {
    const baselineRoute = {
      ...route("/multi-agent"),
      snapshots: [
        page("/multi-agent"),
        page(
          "/multi-agent",
          { agent: browserAgent },
          {
            titles: [{ value: "Old browser title", location: "head" }],
          },
        ),
      ],
    };
    const currentRoute = {
      ...route("/multi-agent"),
      snapshots: [
        page("/multi-agent"),
        page(
          "/multi-agent",
          { agent: browserAgent, status: 404 },
          {
            titles: [{ value: "New browser title", location: "head" }],
          },
        ),
      ],
    };

    const codes = diffReports(report([baselineRoute]), report([currentRoute])).changes.map(
      (change) => change.code,
    );

    expect(codes).toEqual(
      expect.arrayContaining([
        "agent-status-changed:browser",
        "agent-indexability-changed:browser",
        "agent-title-changed:browser",
      ]),
    );
  });

  it("reports route, signal, render-mode, and finding regressions with severity totals", () => {
    const baselineStable = route(
      "/stable",
      page(
        "/stable",
        {},
        {
          titles: [{ value: "Old title", location: "head" }],
          robots: [
            { value: "index, follow", location: "head", audience: "robots", source: "meta" },
          ],
        },
      ),
      "static",
    );
    const currentStable = route(
      "/stable",
      page(
        "/stable",
        { finalUrl: absolute("/moved"), status: 503 },
        {
          titles: [{ value: "New title", location: "head" }],
          canonicals: [{ value: "/preferred", location: "head" }],
          robots: [{ value: "noindex", location: "head", audience: "robots", source: "header" }],
        },
      ),
      "dynamic",
    );
    const baseline = report(
      [baselineStable, route("/removed")],
      [
        {
          code: "metadata-warning",
          severity: "warning",
          message: "Metadata needs work.",
          url: absolute("/stable"),
        },
        {
          code: "resolved-warning",
          severity: "warning",
          message: "This will be fixed.",
          url: absolute("/removed"),
        },
      ],
      "2026-08-20T00:00:00.000Z",
    );
    const current = report(
      [currentStable, route("/added-broken", page("/added-broken", { status: 404 }))],
      [
        {
          code: "metadata-warning",
          severity: "error",
          message: "Metadata is now broken.",
          url: absolute("/stable"),
        },
        {
          code: "new-warning",
          severity: "warning",
          message: "A new warning.",
          url: absolute("/added-broken"),
        },
      ],
      "2026-08-22T00:00:00.000Z",
    );

    const diff = diffReports(baseline, current);
    const codes = diff.changes.map((change) => change.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "route-added",
        "route-removed",
        "status-changed",
        "final-url-changed",
        "indexability-changed",
        "canonical-changed",
        "title-changed",
        "robots-changed",
        "render-mode-changed",
        "finding-severity:metadata-warning",
        "finding-added:new-warning",
        "finding-resolved:resolved-warning",
      ]),
    );
    expect(diff.summary).toEqual({
      added: 2,
      removed: 2,
      changed: 8,
      errors: 4,
      warnings: 6,
      info: 2,
    });
    expect(diff.baselineGeneratedAt).toBe(baseline.generatedAt);
    expect(diff.currentGeneratedAt).toBe(current.generatedAt);
    expect(diff.changes.slice(0, 4).every((change) => change.severity === "error")).toBe(true);
  });

  it("treats a recovered status and indexability as informational", () => {
    const baseline = report([route("/page", page("/page", { status: 500 }))]);
    const current = report([route("/page")]);

    const changes = diffReports(baseline, current).changes;

    expect(changes.find((change) => change.code === "status-changed")).toMatchObject({
      severity: "info",
      before: 500,
      after: 200,
    });
    expect(changes.find((change) => change.code === "indexability-changed")).toMatchObject({
      severity: "info",
      before: "unknown",
      after: "indexable",
    });
  });

  it("renders stable terminal and JSON output, including the no-change state", () => {
    const unchanged = report([route("/")]);
    const diff = diffReports(unchanged, unchanged);

    expect(renderDiffTerminal(diff)).toContain("No route or finding changes.");
    expect(renderDiffTerminal(diff)).toMatch(/^RouteLint report diff/);
    expect(renderDiffJson(diff).endsWith("\n")).toBe(true);
    expect(JSON.parse(renderDiffJson(diff))).toMatchObject({
      schemaVersion: "1",
      changes: [],
      summary: { added: 0, removed: 0, changed: 0 },
    });
  });
});
