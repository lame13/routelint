import { describe, expect, it } from "vitest";
import {
  renderCsvReport,
  renderHtmlReport,
  renderJsonReport,
  renderJunitReport,
  renderMarkdownReport,
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
  it("shows unmatched patterns even when there were no concrete redirect checks", () => {
    const report = {
      ...fixture(),
      redirectContracts: {
        declared: 0,
        verified: 0,
        failed: 0,
        unchecked: 0,
        skippedBuildRedirects: 0,
        patterns: 1,
        patternMatches: 0,
        unmatchedPatterns: ["https://example.com/old/*"],
        checks: [],
      },
    };
    expect(renderTerminalReport(report)).toContain("1 pattern unmatched");
    expect(renderHtmlReport(report)).toContain("1 pattern matched nothing");
  });

  it("selects every supported output format", () => {
    const report = fixture();

    expect(renderReport(report, "terminal")).toBe(renderTerminalReport(report));
    expect(renderReport(report, "json")).toBe(renderJsonReport(report));
    expect(renderReport(report, "sarif")).toBe(renderSarifReport(report));
    expect(renderReport(report, "html")).toBe(renderHtmlReport(report));
    expect(renderReport(report, "markdown")).toBe(renderMarkdownReport(report));
    expect(renderReport(report, "csv")).toBe(renderCsvReport(report));
    expect(renderReport(report, "junit")).toBe(renderJunitReport(report));
  });
});

describe("Markdown reporter", () => {
  it("escapes Markdown links, images, backslashes, and code delimiters", () => {
    const markdown = renderMarkdownReport({
      ...fixture(),
      findings: [
        {
          code: "bad`code",
          severity: "error",
          message: "![image](https://outside.test/pixel) [link](https://outside.test/) \\| *bold*",
        },
      ],
    });
    expect(markdown).toContain("bad\\`code");
    expect(markdown).toContain("\\!\\[image\\]\\(https://outside.test/pixel\\)");
    expect(markdown).not.toContain("![image](");
    expect(markdown).not.toContain("[link](");
    expect(markdown).toContain("\\\\\\| \\*bold\\*");
  });

  it("identifies a changed-only report instead of implying that all findings are shown", () => {
    const markdown = renderMarkdownReport({
      ...fixture(),
      comparison: {
        mode: "changed-only",
        baselineGeneratedAt: "2026-09-20T00:00:00.000Z",
        newFindings: 1,
        worsenedFindings: 1,
        resolvedFindings: 2,
        unchangedFindings: 8,
      },
    });
    expect(markdown).toContain("Changed-only report");
    expect(markdown).toContain("1 new, 1 worsened, 2 resolved, and 8 unchanged findings");
  });

  it("renders a GitHub-flavored summary that neutralizes report values", () => {
    const markdown = renderMarkdownReport(fixture());

    expect(markdown.startsWith("# RouteLint report\n")).toBe(true);
    expect(markdown).toContain("| Findings | 2 (1 errors, 1 warnings, 0 info) |");
    expect(markdown).toContain("| error | LINK\\_BROKEN | https://example.com/broken |");
    expect(markdown).toContain("&lt;/script&gt;");
    expect(markdown).not.toContain("<img src=x");
    expect(markdown).not.toContain("\u001b");
    expect(markdown).toContain("Redirect contracts");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("summarizes rather than listing an unbounded number of findings", () => {
    const report = fixture();
    const findings = Array.from({ length: 250 }, (_value, index) => ({
      code: `CODE_${index}`,
      severity: "warning" as const,
      message: `Finding ${index}`,
      url: `https://example.com/page-${index}`,
    }));

    const markdown = renderMarkdownReport({ ...report, findings });

    expect(markdown).toContain("50 further findings are available in the JSON report.");
  });
});

describe("CSV reporter", () => {
  it.each(["=1+1", "+1+1", "-1+1", "@SUM(A1)", "\t=1+1", "\r\n=1+1"])(
    "neutralizes spreadsheet formulas in untrusted fields: %j",
    (value) => {
      const csv = renderCsvReport({
        ...fixture(),
        findings: [
          {
            code: value,
            severity: "error",
            message: value,
            evidence: { [value]: "value" },
          },
        ],
      });
      expect(csv).not.toMatch(/(?:^|,)"?\s*[=+@-]/u);
      expect(csv).toContain("'");
    },
  );

  it("writes one RFC 4180 row per finding with a header", () => {
    const csv = renderCsvReport(fixture());
    const lines = csv.split("\n");

    expect(lines[0]).toBe("severity,code,url,message,related_urls,evidence");
    expect(lines).toHaveLength(4);
    expect(csv).toContain('"bad""><script=true; status=404"');
    expect(csv).not.toContain("\u001b");
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("quotes fields that contain the delimiter", () => {
    const report = fixture();
    const csv = renderCsvReport({
      ...report,
      findings: [
        {
          code: "duplicate-title",
          severity: "warning",
          message: 'Title repeated, twice "here"',
          url: "https://example.com/a",
        },
      ],
    });

    expect(csv).toContain('"Title repeated, twice ""here"""');
  });
});

describe("JUnit reporter", () => {
  it("removes forbidden XML codepoints while retaining valid Unicode", () => {
    const junit = renderJunitReport({
      ...fixture(),
      findings: [
        {
          code: "invalid-xml",
          severity: "error",
          message: "bad\u0000\ud800\ufffe\uffff valid 😀",
        },
      ],
    });
    for (const forbidden of ["\u0000", "\ud800", "\ufffe", "\uffff"]) {
      expect(junit).not.toContain(forbidden);
    }
    expect(junit).toContain("valid 😀");
  });

  it("maps findings to test cases and severities to failures", () => {
    const report = fixture();
    const junit = renderJunitReport({
      ...report,
      findings: [
        ...report.findings,
        { code: "page-budget-reached", severity: "info", message: "The crawl stopped." },
      ],
    });

    expect(junit.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(junit).toContain('<testsuites name="routelint" tests="3" failures="2">');
    expect(junit).toContain('<failure type="error"');
    expect(junit).toContain('<failure type="warning"');
    expect(junit).toContain("<system-out>");
    expect(junit).toContain("&lt;/script&gt;");
    expect(junit).toContain('<property name="routes" value="2"/>');
    expect(junit).not.toContain("\u001b");
  });

  it("emits one passing test case when there are no findings", () => {
    const report = fixture();
    const junit = renderJunitReport({ ...report, findings: [] });

    expect(junit).toContain('tests="1" failures="0"');
    expect(junit).toContain('<testcase classname="routelint" name="no findings"/>');
  });
});
