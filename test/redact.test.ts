import { describe, expect, it } from "vitest";

import { redactReport } from "../src/redact.js";
import type { RouteLintReport } from "../src/types.js";

describe("report redaction", () => {
  it("removes request secrets, secret query values, and absolute project paths", () => {
    const secret = "preview-secret";
    const url = `https://example.com/private?token=${secret}`;
    const report: RouteLintReport = {
      schemaVersion: "1",
      toolVersion: "0.1.0",
      generatedAt: "2026-08-22T00:00:00.000Z",
      durationMs: 1,
      baseUrl: url,
      config: {
        maxPages: 1,
        maxDepth: 1,
        agents: ["routelint"],
        respectRobots: true,
        queryPolicy: "keep",
        redirects: [
          {
            from: `https://example.com/private?token=${secret}`,
            to: `https://example.com/public?token=${secret}`,
            status: 301,
            maxHops: 1,
          },
        ],
      },
      build: {
        framework: "next",
        root: "/Users/niko/private-site",
        buildDirectory: "/Users/niko/private-site/.next",
        routes: [],
        unresolvedPatterns: [],
        redirects: [],
        warnings: ["No manifest in /Users/niko/private-site/.next"],
      },
      sitemap: {
        requested: [`https://example.com/sitemap.xml?key=${secret}`],
        fetched: [],
        entries: [],
        warnings: [],
      },
      robots: {
        url: `https://example.com/robots.txt?token=${secret}`,
        status: 503,
        availability: { state: "unavailable", reason: "http-error" },
        groups: [],
        sitemaps: [],
        warnings: [`robots.txt failed near ${secret}`],
      },
      redirectContracts: {
        declared: 1,
        verified: 0,
        failed: 1,
        unchecked: 0,
        skippedBuildRedirects: 0,
        checks: [
          {
            contract: {
              from: `https://example.com/private?token=${secret}`,
              to: `https://example.com/public?token=${secret}`,
              status: 301,
              maxHops: 1,
              source: "config",
            },
            observed: {
              completion: "complete",
              hops: [
                {
                  url: `https://example.com/private?token=${secret}`,
                  status: 302,
                  location: `https://example.com/wrong?token=${secret}`,
                  durationMs: 1,
                },
              ],
              finalUrl: `https://example.com/wrong?token=${secret}`,
              finalStatus: 200,
              targetIndexability: "indexable",
            },
            outcome: "failed",
            findingCodes: ["redirect-status-mismatch", "redirect-target-mismatch"],
          },
        ],
      },
      routes: [
        {
          url,
          depth: -1,
          sources: [{ kind: "seed" }],
          snapshots: [
            {
              requestedUrl: url,
              finalUrl: url,
              agent: { key: "routelint", label: "RouteLint", userAgent: "RouteLint/Test" },
              status: 200,
              contentType: "text/html",
              headers: { "x-reflected-preview": `Bearer ${secret}` },
              redirects: [],
              signals: {
                titles: [{ value: `Welcome ${secret}`, location: "head" }],
                descriptions: [],
                canonicals: [{ value: url, location: "head" }],
                robots: [],
                h1s: [],
                links: [
                  {
                    href: `/next?auth=${secret}`,
                    resolvedUrl: `https://example.com/next?auth=${secret}`,
                    text: secret,
                    rel: [],
                    nofollow: false,
                  },
                ],
                hreflangs: [],
              },
              bytesRead: 1,
              durationMs: 1,
              completion: "complete",
            },
          ],
          inbound: [],
          outbound: [],
        },
      ],
      findings: [
        {
          code: "reflected",
          severity: "warning",
          message: `The response reflected ${secret}`,
          url,
          evidence: { reflected: secret },
        },
      ],
      summary: {
        routes: 1,
        fetched: 1,
        indexable: 1,
        errors: 0,
        warnings: 1,
        info: 0,
        brokenLinks: 0,
        redirects: 0,
        noindex: 0,
        maxDepth: 0,
      },
      truncated: false,
    };

    const safe = redactReport(report, [secret]);
    const serialized = JSON.stringify(safe);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("/Users/niko/private-site");
    expect(safe.build).toMatchObject({ root: ".", buildDirectory: ".next" });
    expect(safe.robots?.availability).toEqual({ state: "unavailable", reason: "http-error" });
    expect(serialized).toContain("%5Bredacted%5D");
    expect(JSON.stringify(report)).toContain(secret);
  });
});
