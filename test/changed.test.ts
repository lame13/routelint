import { describe, expect, it } from "vitest";

import { changedOnlyReport } from "../src/changed.js";
import type { Finding, RouteLintReport } from "../src/types.js";

function report(generatedAt: string, findings: readonly Finding[]): RouteLintReport {
  return {
    schemaVersion: "2",
    toolVersion: "0.2.0",
    generatedAt,
    durationMs: 1,
    baseUrl: "https://example.test/",
    config: {
      maxPages: 10,
      maxDepth: 2,
      agents: ["routelint"],
      respectRobots: true,
      queryPolicy: "drop",
    },
    sitemap: { requested: [], fetched: [], entries: [], warnings: [] },
    routes: [],
    findings,
    summary: {
      routes: 0,
      fetched: 0,
      indexable: 0,
      errors: 0,
      warnings: 0,
      info: 0,
      brokenLinks: 0,
      redirects: 0,
      noindex: 0,
      maxDepth: 0,
    },
    truncated: false,
  };
}

describe("changed-only reports", () => {
  it("keeps new and worsened findings while counting unchanged and resolved ones", () => {
    const baseline = report("2026-08-20T00:00:00.000Z", [
      { code: "same", severity: "warning", message: "Before", url: "https://example.test/a" },
      { code: "worse", severity: "warning", message: "Before", url: "https://example.test/b" },
      { code: "resolved", severity: "error", message: "Before" },
    ]);
    const current = report("2026-08-24T00:00:00.000Z", [
      { code: "same", severity: "warning", message: "Current", url: "https://example.test/a" },
      { code: "worse", severity: "error", message: "Current", url: "https://example.test/b" },
      { code: "new", severity: "error", message: "Current", url: "https://example.test/c" },
    ]);

    const filtered = changedOnlyReport(current, baseline);

    expect(filtered.findings.map((finding) => finding.code)).toEqual(["worse", "new"]);
    expect(filtered.summary).toMatchObject({ errors: 2, warnings: 0, info: 0 });
    expect(filtered.comparison).toEqual({
      mode: "changed-only",
      baselineGeneratedAt: baseline.generatedAt,
      newFindings: 1,
      worsenedFindings: 1,
      resolvedFindings: 1,
      unchangedFindings: 1,
    });
  });

  it("rejects baselines from a different site or evidence policy", () => {
    const current = report("2026-08-24T00:00:00.000Z", []);
    const baseline = {
      ...report("2026-08-20T00:00:00.000Z", []),
      baseUrl: "https://other.test/",
      config: {
        ...current.config,
        queryPolicy: "keep" as const,
        respectRobots: false,
        agents: ["googlebot"],
      },
    };

    expect(() => changedOnlyReport(current, baseline)).toThrow(
      "base URL, query policy, robots policy, agent order differ",
    );
  });

  it("compares every recorded crawl and audit policy in a deterministic order", () => {
    const audit = {
      requireTitle: true,
      requireDescription: true,
      requireCanonical: true,
      requireH1: true,
      requireSitemapCoverage: false,
      maxDepth: 4,
      severities: { "missing-title": "error" as const, "missing-h1": "warning" as const },
      paths: [
        {
          include: ["/products/**"],
          exclude: ["/products/drafts/**"],
          requireDescription: false,
          severities: { "missing-canonical": "info" as const },
        },
      ],
    };
    const current = {
      ...report("2026-08-24T00:00:00.000Z", []),
      config: {
        maxPages: 100,
        maxDepth: 5,
        agents: ["routelint"],
        respectRobots: true,
        queryPolicy: "drop" as const,
        rendered: true,
        urlListFiles: 2,
        audit,
      },
    } satisfies RouteLintReport;
    const baseline = {
      ...report("2026-08-20T00:00:00.000Z", []),
      config: {
        ...current.config,
        maxPages: 99,
        maxDepth: 4,
        rendered: false,
        urlListFiles: 1,
        audit: { ...audit, requireCanonical: false },
      },
    } satisfies RouteLintReport;

    expect(() => changedOnlyReport(current, baseline)).toThrow(
      "maximum page count, maximum crawl depth, rendered evidence setting, URL-list input count, audit policy differ",
    );
  });

  it("rejects changes to the recorded route and request evidence policy", () => {
    const current = {
      ...report("2026-08-24T00:00:00.000Z", []),
      config: {
        ...report("2026-08-24T00:00:00.000Z", []).config,
        seeds: ["https://example.test/", "https://example.test/docs"],
        sitemapMode: "explicit" as const,
        sitemapUrls: ["https://example.test/sitemap.xml"],
        include: ["/docs/**"],
        exclude: ["/docs/private/**"],
        timeoutMs: 10_000,
        maxBytes: 1_000_000,
        maxRedirects: 4,
        rendered: true,
        renderedConcurrency: 2,
        renderedTimeoutMs: 20_000,
        renderedSettleMs: 250,
        headerNames: ["authorization", "x-preview-key"],
        redirects: [
          {
            from: "https://example.test/old",
            to: "https://example.test/new",
            status: 301 as const,
            maxHops: 1,
          },
        ],
      },
    } satisfies RouteLintReport;
    const baseline = {
      ...report("2026-08-20T00:00:00.000Z", []),
      config: {
        ...current.config,
        seeds: ["https://example.test/"],
        sitemapMode: "auto" as const,
        sitemapUrls: [],
        include: ["/**"],
        exclude: [],
        timeoutMs: 9_000,
        maxBytes: 900_000,
        maxRedirects: 3,
        renderedConcurrency: 1,
        renderedTimeoutMs: 19_000,
        renderedSettleMs: 100,
        headerNames: ["authorization"],
        redirects: [
          {
            from: "https://example.test/old",
            to: "https://example.test/other",
            status: 301 as const,
            maxHops: 1,
          },
        ],
      },
    } satisfies RouteLintReport;

    expect(() => changedOnlyReport(current, baseline)).toThrow(
      "seed URLs, sitemap mode, sitemap URLs, include filters, exclude filters, request timeout, response byte limit, redirect limit, rendered concurrency, rendered timeout, rendered settle time, request header names, redirect contracts differ",
    );
  });

  it("treats audit records with different object-key insertion order as the same policy", () => {
    const current = {
      ...report("2026-08-24T00:00:00.000Z", []),
      config: {
        ...report("2026-08-24T00:00:00.000Z", []).config,
        audit: {
          requireTitle: true,
          requireDescription: true,
          requireCanonical: true,
          requireH1: true,
          requireSitemapCoverage: true,
          maxDepth: 2,
          severities: { beta: "warning" as const, alpha: "error" as const },
        },
      },
    } satisfies RouteLintReport;
    const baseline = {
      ...report("2026-08-20T00:00:00.000Z", []),
      config: {
        ...current.config,
        audit: {
          ...current.config.audit,
          severities: { alpha: "error" as const, beta: "warning" as const },
        },
      },
    } satisfies RouteLintReport;

    expect(changedOnlyReport(current, baseline).comparison).toMatchObject({
      newFindings: 0,
      worsenedFindings: 0,
      resolvedFindings: 0,
      unchangedFindings: 0,
    });
  });

  it("rejects a changed-only report as the baseline", () => {
    const baseline = {
      ...report("2026-08-20T00:00:00.000Z", []),
      comparison: {
        mode: "changed-only" as const,
        baselineGeneratedAt: "2026-08-19T00:00:00.000Z",
        newFindings: 0,
        worsenedFindings: 0,
        resolvedFindings: 0,
        unchangedFindings: 0,
      },
    } satisfies RouteLintReport;

    expect(() => changedOnlyReport(report("2026-08-24T00:00:00.000Z", []), baseline)).toThrow(
      "baseline report is already changed-only",
    );
  });

  it.each([
    [true, false, "baseline report is truncated"],
    [false, true, "current report is truncated"],
    [true, true, "baseline report and current report are truncated"],
  ])(
    "rejects incomplete comparisons (baseline truncated: %s, current truncated: %s)",
    (baselineTruncated, currentTruncated, message) => {
      const baseline = {
        ...report("2026-08-20T00:00:00.000Z", []),
        truncated: baselineTruncated,
      };
      const current = {
        ...report("2026-08-24T00:00:00.000Z", []),
        truncated: currentTruncated,
      };

      expect(() => changedOnlyReport(current, baseline)).toThrow(message);
    },
  );
});
