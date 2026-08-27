import { describe, expect, it } from "vitest";
import {
  renderHtmlReport,
  renderJsonReport,
  renderReport,
  renderSarifReport,
  renderTerminalReport,
} from "../src/reporters/index.js";
import type { PageSnapshot, RouteLintReport } from "../src/types.js";

const agent = {
  key: "routelint",
  label: "Site checker",
  userAgent: "SiteChecker/0.1",
} as const;
const browserAgent = {
  key: "browser",
  label: "Browser",
  userAgent: "Browser/Test",
} as const;

function snapshot(overrides: Partial<PageSnapshot> = {}, omitStatus = false): PageSnapshot {
  const result: PageSnapshot = {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    agent,
    status: 200,
    contentType: "text/html; charset=utf-8",
    headers: { "content-type": "text/html; charset=utf-8" },
    redirects: [],
    signals: {
      titles: [{ value: "Home", location: "head" }],
      descriptions: [],
      canonicals: [{ value: "https://example.com/", location: "head" }],
      robots: [],
      h1s: [{ value: "Home", location: "body" }],
      links: [],
      hreflangs: [],
      htmlLang: "en",
    },
    bytesRead: 1_024,
    bodySha256: "abc123",
    durationMs: 38,
    completion: "complete",
    ...overrides,
  };
  if (!omitStatus) return result;
  const { status: _status, ...withoutStatus } = result;
  return withoutStatus;
}

function fixture(): RouteLintReport {
  return {
    schemaVersion: "3",
    toolVersion: "0.3.0",
    generatedAt: "2026-08-22T00:00:00.000Z",
    durationMs: 1_234,
    baseUrl: "https://example.com/",
    config: {
      maxPages: 100,
      maxDepth: 5,
      agents: ["routelint", "browser"],
      respectRobots: true,
      queryPolicy: "drop",
    },
    sitemap: {
      requested: ["https://example.com/sitemap.xml"],
      fetched: ["https://example.com/sitemap.xml"],
      entries: [
        {
          url: "https://example.com/",
          sitemapUrl: "https://example.com/sitemap.xml",
          alternates: [],
        },
      ],
      warnings: [],
    },
    robots: {
      url: "https://example.com/robots.txt",
      status: 200,
      groups: [],
      sitemaps: ["https://example.com/sitemap.xml"],
      warnings: [],
    },
    redirectContracts: {
      declared: 1,
      verified: 1,
      failed: 0,
      unchecked: 0,
      skippedBuildRedirects: 2,
      checks: [
        {
          contract: {
            from: "https://example.com/old",
            to: "https://example.com/new",
            status: 301,
            maxHops: 1,
            source: "config",
          },
          observed: {
            completion: "complete",
            hops: [
              {
                url: "https://example.com/old",
                status: 301,
                location: "https://example.com/new",
                durationMs: 4,
              },
            ],
            finalUrl: "https://example.com/new",
            finalStatus: 200,
            targetIndexability: "indexable",
          },
          outcome: "verified",
          findingCodes: [],
        },
      ],
    },
    routes: [
      {
        url: "https://example.com/",
        depth: 0,
        sources: [{ kind: "seed" }],
        snapshots: [snapshot(), snapshot({ agent: browserAgent })],
        inbound: [],
        outbound: ["https://example.com/broken"],
      },
      {
        url: "https://example.com/broken",
        depth: 1,
        sources: [{ kind: "internal-link", from: "https://example.com/" }],
        snapshots: [
          snapshot(
            {
              requestedUrl: "https://example.com/broken",
              finalUrl: "https://example.com/broken",
              completion: "timeout",
              error: "Timed out",
            },
            true,
          ),
        ],
        inbound: ["https://example.com/"],
        outbound: [],
      },
    ],
    findings: [
      {
        code: "LINK_BROKEN",
        severity: "error",
        message: "Unsafe </script><img src=x onerror=alert(1)> \u001b[2J",
        url: "https://example.com/broken",
        relatedUrls: ["https://example.com/"],
        evidence: { status: 404, 'bad"><script': true },
      },
      {
        code: "CANONICAL_MISSING",
        severity: "warning",
        message: "No canonical was found.",
        url: "https://example.com/broken",
      },
    ],
    summary: {
      routes: 2,
      fetched: 1,
      indexable: 1,
      errors: 1,
      warnings: 1,
      info: 0,
      brokenLinks: 1,
      redirects: 0,
      noindex: 0,
      maxDepth: 1,
    },
    truncated: true,
  };
}

describe("terminal reporter", () => {
  it("renders a deterministic plain-text summary and sorted findings", () => {
    const report = fixture();
    const output = renderTerminalReport(report, { color: false });
    const reordered = renderTerminalReport(
      { ...report, findings: report.findings.toReversed() },
      {
        color: false,
      },
    );

    expect(output).toBe(reordered);
    expect(output).toContain("Site report\nhttps://example.com/");
    expect(output).toContain("INCOMPLETE EVIDENCE");
    expect(output).toContain("LINK_BROKEN");
    expect(output).toContain(
      "Redirect contracts: 1/1 verified, 0 failed, 0 unchecked, 2 Next.js definitions outside contract scope",
    );
    expect(output.indexOf("LINK_BROKEN")).toBeLessThan(output.indexOf("CANONICAL_MISSING"));
    expect(output).not.toContain("\u001b[");
  });

  it("supports color and an explicit finding display limit", () => {
    const output = renderTerminalReport(fixture(), { color: true, maxFindings: 1 });

    expect(output).toContain("\u001b[31m");
    expect(output).toContain("1 finding not displayed");
  });
});

describe("JSON reporter", () => {
  it("pretty-prints a stable, lossless JSON document with a final newline", () => {
    const report = fixture();
    const output = renderJsonReport(report);

    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output)).toEqual(JSON.parse(JSON.stringify(report)));
    expect(output.indexOf('"baseUrl"')).toBeLessThan(output.indexOf('"config"'));
  });
});

describe("SARIF reporter", () => {
  it("maps checks and route URLs to a SARIF 2.1.0 log", () => {
    const parsed = JSON.parse(renderSarifReport(fixture()));

    expect(parsed.version).toBe("2.1.0");
    expect(parsed.$schema).toContain("sarif-2.1.0");
    expect(parsed.runs[0].tool.driver.rules.map((rule: { id: string }) => rule.id)).toEqual([
      "CANONICAL_MISSING",
      "LINK_BROKEN",
    ]);
    const broken = parsed.runs[0].results.find(
      (result: { ruleId: string }) => result.ruleId === "LINK_BROKEN",
    );
    expect(broken.level).toBe("error");
    expect(broken.locations[0].physicalLocation.artifactLocation.uri).toBe(
      "https://example.com/broken",
    );
    expect(broken.relatedLocations[0].physicalLocation.artifactLocation.uri).toBe(
      "https://example.com/",
    );
  });

  it("exports redirect contract failures as ordinary code-scanning results", () => {
    const report = fixture();
    const parsed = JSON.parse(
      renderSarifReport({
        ...report,
        findings: [
          ...report.findings,
          {
            code: "redirect-target-mismatch",
            severity: "error",
            message: "The redirect ended at the wrong destination.",
            url: "https://example.com/old",
            relatedUrls: ["https://example.com/new"],
          },
        ],
      }),
    );

    expect(
      parsed.runs[0].tool.driver.rules.some(
        (rule: { id: string }) => rule.id === "redirect-target-mismatch",
      ),
    ).toBe(true);
    expect(
      parsed.runs[0].results.find(
        (result: { ruleId: string }) => result.ruleId === "redirect-target-mismatch",
      ),
    ).toMatchObject({
      level: "error",
      locations: [{ physicalLocation: { artifactLocation: { uri: "https://example.com/old" } } }],
    });
  });
});

describe("HTML reporter", () => {
  it("renders a self-contained, accessible report whose core evidence needs no JavaScript", () => {
    const output = renderHtmlReport(fixture());

    expect(output).toMatch(/^<!doctype html>/);
    expect(output).toContain('<svg class="route-graph"');
    expect(output).toContain('role="img"');
    expect(output).toContain("<table>");
    expect(output.match(/<tr data-route-row/g)).toHaveLength(2);
    expect(output.match(/<tr data-finding-row/g)).toHaveLength(2);
    expect(output).toContain("Incomplete evidence");
    expect(output).toContain("Site checker: 200 · Browser: 200");
    expect(output).toContain("Site checker: indexable · Browser: indexable");
    expect(output).toContain("Agent response differences");
    expect(output).toContain("Redirect contracts");
    expect(output).toContain("1 of 1 contracts verified");
    expect(output).toContain("https://example.com/old");
    expect(output).toContain("https://example.com/new");
    expect(output).toContain("badge-verified");
    expect(output).toContain("2 Next.js definitions were outside contract scope");
    expect(output).toContain("No response differences were found between configured agents");
    expect(output).toContain("Rendered evidence");
    expect(output).toContain('label for="route-search"');
    expect(output).toContain("prefers-reduced-motion");
    expect(output).toContain("https://nikom.work");
    expect(output).not.toMatch(/<script[^>]+src=/i);
    expect(output).not.toMatch(/<link\b/i);
    expect(output).not.toMatch(/@(?:import|font-face)/i);
    expect(output.toLowerCase()).not.toContain("seo score");
  });

  it("omits the Next.js scope note when no build redirects were skipped", () => {
    const report = fixture();
    const contracts = report.redirectContracts;
    if (contracts === undefined) throw new Error("Fixture requires redirect contracts.");

    const output = renderHtmlReport({
      ...report,
      redirectContracts: { ...contracts, skippedBuildRedirects: 0 },
    });

    expect(output).not.toContain("0 Next.js definitions");
  });

  it("states when findings have been filtered against a baseline", () => {
    const output = renderHtmlReport({
      ...fixture(),
      comparison: {
        mode: "changed-only",
        baselineGeneratedAt: "2026-08-20T00:00:00.000Z",
        newFindings: 1,
        worsenedFindings: 1,
        resolvedFindings: 2,
        unchangedFindings: 8,
      },
    });

    expect(output).toContain("Changed-only report");
    expect(output).toContain("1 new and 1 worsened");
    expect(output).toContain("2 resolved and 8 unchanged");
  });

  it("escapes every report value before placing it in HTML or SVG", () => {
    const output = renderHtmlReport(fixture());

    expect(output).not.toContain("</script><img src=x onerror=alert(1)>");
    expect(output).not.toContain('bad"><script');
    expect(output).toContain("&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(output).toContain("bad&quot;&gt;&lt;script");
  });
});

describe("report dispatcher", () => {
  it("selects every supported output format", () => {
    const report = fixture();

    expect(renderReport(report, "terminal")).toBe(renderTerminalReport(report));
    expect(renderReport(report, "json")).toBe(renderJsonReport(report));
    expect(renderReport(report, "sarif")).toBe(renderSarifReport(report));
    expect(renderReport(report, "html")).toBe(renderHtmlReport(report));
  });
});
