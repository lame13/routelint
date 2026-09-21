import { describe, expect, it } from "vitest";

import {
  auditRedirectContracts,
  collectRedirectContracts,
  interpolateRedirectTarget,
  matchRedirectSource,
  planRedirectSource,
  planRedirectTarget,
  redirectContractCandidates,
} from "../src/redirects.js";
import type {
  BuildInventory,
  PageSnapshot,
  RedirectContract,
  RedirectExpectation,
  RedirectHop,
  RobotsSignal,
  RouteNode,
} from "../src/types.js";

const origin = "https://example.test";
const agent = {
  key: "routelint",
  label: "RouteLint",
  userAgent: "RouteLint/Test",
} as const;

function absolute(path: string): string {
  return new URL(path, origin).href;
}

function hop(from: string, status: number, to: string): RedirectHop {
  return { url: absolute(from), status, location: absolute(to), durationMs: 2 };
}

function snapshot(
  path: string,
  options: {
    readonly redirects?: readonly RedirectHop[];
    readonly finalUrl?: string;
    readonly status?: number;
    readonly robots?: readonly RobotsSignal[];
    readonly completion?: PageSnapshot["completion"];
  } = {},
): PageSnapshot {
  const url = absolute(path);
  return {
    requestedUrl: url,
    finalUrl: options.finalUrl ?? url,
    agent,
    status: options.status ?? 200,
    contentType: "text/html",
    headers: { "content-type": "text/html" },
    redirects: options.redirects ?? [],
    signals: {
      titles: [],
      descriptions: [],
      canonicals: [],
      robots: options.robots ?? [],
      h1s: [],
      links: [],
      hreflangs: [],
    },
    bytesRead: 100,
    durationMs: 4,
    completion: options.completion ?? "complete",
  };
}

function route(path: string, page: PageSnapshot): RouteNode {
  return {
    url: absolute(path),
    depth: 0,
    sources: [{ kind: "redirect-contract", from: "config", detail: "source" }],
    snapshots: [page],
    inbound: [],
    outbound: [],
  };
}

function contract(
  from: string,
  to: string,
  overrides: Partial<RedirectContract> = {},
): RedirectContract {
  return {
    from: absolute(from),
    to: absolute(to),
    status: 301,
    maxHops: 1,
    source: "config",
    ...overrides,
  };
}

describe("redirect contract collection", () => {
  it("lets config override concrete Next.js redirects and skips definitions it cannot assert", () => {
    const configured: RedirectExpectation[] = [
      {
        from: absolute("/old"),
        to: absolute("/configured"),
        status: 301,
        maxHops: 1,
      },
    ];
    const build: BuildInventory = {
      framework: "next",
      root: ".",
      buildDirectory: ".next",
      routes: [],
      unresolvedPatterns: [],
      redirects: [
        { source: "/old", destination: "/build", status: 308 },
        { source: "/temporary", destination: "/later", status: 307 },
        { source: "/blog/:slug", destination: "/articles/:slug", status: 308 },
        { source: "/conditional", destination: "/member", status: 307, conditional: true },
        { source: "/query", destination: "/search?from=old", status: 308 },
        { source: "/external", destination: "https://outside.test/new", status: 308 },
      ],
      warnings: [],
    };

    const collection = collectRedirectContracts(configured, build, `${origin}/`);

    expect(collection.contracts).toEqual([
      expect.objectContaining({
        from: absolute("/old"),
        to: absolute("/configured"),
        source: "config",
      }),
      expect.objectContaining({
        from: absolute("/temporary"),
        to: absolute("/later"),
        status: 307,
        source: "next-build",
      }),
    ]);
    expect(collection.skippedBuildRedirects).toBe(4);
  });

  it("adds contract sources and targets to the crawl frontier", () => {
    const candidates = redirectContractCandidates([contract("/old", "/new")]);

    expect(candidates).toEqual([
      expect.objectContaining({
        url: absolute("/old"),
        sources: [expect.objectContaining({ kind: "redirect-contract", detail: "source" })],
      }),
      expect.objectContaining({
        url: absolute("/new"),
        sources: [expect.objectContaining({ kind: "redirect-contract", detail: "target" })],
      }),
    ]);
  });

  it("uses effective paths from the Next.js manifest without applying the base path twice", () => {
    const build: BuildInventory = {
      framework: "next",
      root: ".",
      buildDirectory: ".next",
      routes: [],
      unresolvedPatterns: [],
      redirects: [{ source: "/docs/old", destination: "/docs/new", status: 308 }],
      warnings: [],
    };

    const collection = collectRedirectContracts([], build, `${origin}/docs`);

    expect(collection.contracts).toEqual([
      expect.objectContaining({
        from: absolute("/docs/old"),
        to: absolute("/docs/new"),
        source: "next-build",
      }),
    ]);
  });
});

describe("redirect contract audit", () => {
  it("records verified redirects without producing findings", () => {
    const expected = contract("/old", "/new");
    const page = snapshot("/old", {
      redirects: [hop("/old", 301, "/new")],
      finalUrl: absolute("/new"),
    });

    const result = auditRedirectContracts([route("/old", page)], [expected]);

    expect(result.findings).toEqual([]);
    expect(result.report).toMatchObject({
      declared: 1,
      verified: 1,
      failed: 0,
      unchecked: 0,
      checks: [
        {
          outcome: "verified",
          findingCodes: [],
          observed: {
            finalUrl: absolute("/new"),
            finalStatus: 200,
            targetIndexability: "indexable",
          },
        },
      ],
    });
  });

  it("reports missing redirects, status and target mismatches, and excessive chains", () => {
    const missing = contract("/missing", "/new");
    const mismatched = contract("/old", "/new");
    const result = auditRedirectContracts(
      [
        route("/missing", snapshot("/missing")),
        route(
          "/old",
          snapshot("/old", {
            redirects: [hop("/old", 302, "/middle"), hop("/middle", 301, "/wrong")],
            finalUrl: absolute("/wrong"),
          }),
        ),
      ],
      [missing, mismatched],
    );

    expect(result.findings.map((finding) => finding.code)).toEqual([
      "expected-redirect-missing",
      "redirect-status-mismatch",
      "redirect-target-mismatch",
      "redirect-chain",
    ]);
    expect(result.report).toMatchObject({ declared: 2, verified: 0, failed: 2, unchecked: 0 });
  });

  it("fails a redirect whose final destination is broken or noindex", () => {
    const broken = contract("/broken-source", "/broken-target");
    const hidden = contract("/hidden-source", "/hidden-target");
    const noindex: RobotsSignal = {
      value: "noindex, follow",
      location: "head",
      audience: "robots",
      source: "meta",
    };
    const result = auditRedirectContracts(
      [
        route(
          "/broken-source",
          snapshot("/broken-source", {
            redirects: [hop("/broken-source", 301, "/broken-target")],
            finalUrl: absolute("/broken-target"),
            status: 404,
          }),
        ),
        route(
          "/hidden-source",
          snapshot("/hidden-source", {
            redirects: [hop("/hidden-source", 301, "/hidden-target")],
            finalUrl: absolute("/hidden-target"),
            robots: [noindex],
          }),
        ),
      ],
      [broken, hidden],
    );

    expect(result.findings.map((finding) => finding.code)).toEqual([
      "redirect-target-unhealthy",
      "redirect-target-unhealthy",
    ]);
    expect(result.report.failed).toBe(2);
  });

  it("distinguishes unchecked contracts from failed observations", () => {
    const result = auditRedirectContracts([], [contract("/old", "/new")], 3);

    expect(result.findings).toEqual([
      expect.objectContaining({ code: "redirect-contract-unchecked", severity: "warning" }),
    ]);
    expect(result.report).toMatchObject({
      declared: 1,
      verified: 0,
      failed: 0,
      unchecked: 1,
      skippedBuildRedirects: 3,
    });
  });
});

describe("redirect source patterns", () => {
  it("preserves trailing and empty segments in a double-wildcard capture", () => {
    expect(matchRedirectSource(absolute("/docs/**"), absolute("/docs/a/"))).toEqual(["a/"]);
    expect(matchRedirectSource(absolute("/docs/**"), absolute("/docs/"))).toEqual([""]);
    expect(matchRedirectSource(absolute("/docs/**"), absolute("/docs"))).toEqual([""]);
    expect(() => planRedirectSource(absolute("/docs/***"), "from")).toThrow("only * or **");
    expect(() => planRedirectTarget(absolute("/docs/***"), "to", 1)).toThrow("only * or **");
  });

  it("captures one segment per wildcard and a whole remainder for a trailing double wildcard", () => {
    expect(matchRedirectSource(absolute("/blog/old/*"), absolute("/blog/old/hello"))).toEqual([
      "hello",
    ]);
    expect(matchRedirectSource(absolute("/blog/old/*"), absolute("/blog/old/a/b"))).toBeUndefined();
    expect(matchRedirectSource(absolute("/docs/**"), absolute("/docs/a/b/c"))).toEqual(["a/b/c"]);
    expect(matchRedirectSource(absolute("/blog/old/*"), absolute("/blog/old"))).toBeUndefined();
    expect(
      matchRedirectSource(absolute("/blog/old/*"), absolute("/blog/new/hello")),
    ).toBeUndefined();
  });

  it("requires the query string to match exactly and rejects other origins", () => {
    expect(matchRedirectSource(absolute("/old?ref=legacy"), absolute("/old?ref=legacy"))).toEqual(
      [],
    );
    expect(matchRedirectSource(absolute("/old?ref=legacy"), absolute("/old"))).toBeUndefined();
    expect(
      matchRedirectSource(absolute("/old?ref=legacy"), absolute("/old?ref=other")),
    ).toBeUndefined();
    expect(
      matchRedirectSource(absolute("/old/*"), "https://outside.test/old/hello"),
    ).toBeUndefined();
  });

  it("substitutes captures into the declared target template in order", () => {
    expect(interpolateRedirectTarget(absolute("/blog/new/*"), ["hello"])).toBe(
      absolute("/blog/new/hello"),
    );
    expect(interpolateRedirectTarget(absolute("/docs/*/edit"), ["a/b"])).toBe(
      absolute("/docs/a/b/edit"),
    );
    expect(interpolateRedirectTarget("https://outside.test/new/*", ["hello"])).toBe(
      "https://outside.test/new/hello",
    );
    // A target without placeholders is returned unchanged even when captures exist.
    expect(interpolateRedirectTarget(absolute("/archive"), ["hello"])).toBe(absolute("/archive"));
  });

  it("rejects patterns that cannot be matched deterministically", () => {
    expect(() => planRedirectSource(absolute("/old-*.html"), "from")).toThrow(
      "wildcards must occupy a whole path segment",
    );
    expect(() => planRedirectSource(absolute("/docs/**/edit"), "from")).toThrow(
      "may only use ** as the final path segment",
    );
    expect(() => planRedirectTarget("https://outside.test/*/new", "to", 1)).not.toThrow();
    expect(() => planRedirectTarget(absolute("/a/*/b/*"), "to", 1)).toThrow(
      "uses 2 wildcards but the source declares 1",
    );
  });
});

describe("pattern contract audit", () => {
  const pattern: RedirectContract = {
    from: absolute("/blog/old/*"),
    to: absolute("/blog/new/*"),
    status: 308,
    maxHops: 2,
    source: "config",
    kind: "pattern",
  };

  it("reports an unfetched explicit sample as unchecked", () => {
    const result = auditRedirectContracts(
      [],
      [
        {
          ...pattern,
          samples: [absolute("/blog/old/excluded")],
        },
      ],
    );
    expect(result.report).toMatchObject({ declared: 1, unchecked: 1, unmatchedPatterns: [] });
    expect(result.findings[0]).toMatchObject({
      code: "redirect-contract-unchecked",
      url: absolute("/blog/old/excluded"),
    });
  });

  it("counts sources matching overlapping patterns once", () => {
    const result = auditRedirectContracts(
      [route("/blog/old/hello", snapshot("/blog/old/hello"))],
      [pattern, { ...pattern, from: absolute("/blog/**") }],
    );
    expect(result.report).toMatchObject({ declared: 2, patterns: 2, patternMatches: 1 });
  });

  it("verifies every observed match against its interpolated target", () => {
    const result = auditRedirectContracts(
      [
        route(
          "/blog/old/hello",
          snapshot("/blog/old/hello", {
            redirects: [hop("/blog/old/hello", 308, "/blog/new/hello")],
            finalUrl: absolute("/blog/new/hello"),
          }),
        ),
        route(
          "/blog/old/world",
          snapshot("/blog/old/world", {
            redirects: [hop("/blog/old/world", 308, "/blog/new/world")],
            finalUrl: absolute("/blog/new/world"),
          }),
        ),
        route("/unrelated", snapshot("/unrelated")),
      ],
      [pattern],
    );

    expect(result.findings).toEqual([]);
    expect(result.report).toMatchObject({
      declared: 2,
      patterns: 1,
      patternMatches: 2,
      verified: 2,
      failed: 0,
    });
    expect(result.report.unmatchedPatterns).toEqual([]);
    expect(result.sources).toEqual([absolute("/blog/old/hello"), absolute("/blog/old/world")]);
    expect(result.report.checks[0]).toMatchObject({
      declaredPattern: absolute("/blog/old/*"),
      contract: {
        from: absolute("/blog/old/hello"),
        to: absolute("/blog/new/hello"),
        kind: "pattern",
      },
    });
  });

  it("fails a matched source whose redirect lands somewhere else", () => {
    const result = auditRedirectContracts(
      [
        route(
          "/blog/old/hello",
          snapshot("/blog/old/hello", {
            redirects: [hop("/blog/old/hello", 301, "/blog/wrong/hello")],
            finalUrl: absolute("/blog/wrong/hello"),
          }),
        ),
      ],
      [pattern],
    );

    expect(result.findings.map((finding) => finding.code)).toEqual([
      "redirect-status-mismatch",
      "redirect-target-mismatch",
    ]);
    expect(result.report.failed).toBe(1);
  });

  it("reports a pattern that no observed URL matched without failing the run", () => {
    const result = auditRedirectContracts([route("/home", snapshot("/home"))], [pattern]);

    expect(result.findings).toEqual([
      expect.objectContaining({ code: "redirect-pattern-unmatched", severity: "info" }),
    ]);
    expect(result.report).toMatchObject({
      declared: 0,
      patterns: 1,
      patternMatches: 0,
      unmatchedPatterns: [absolute("/blog/old/*")],
    });
  });
});

describe("cross-origin and query-bearing contracts", () => {
  it("verifies a source that leaves the audited origin", () => {
    const away = contract("/moved", "/moved", { to: "https://archive.test/moved" });
    const result = auditRedirectContracts(
      [
        route(
          "/moved",
          snapshot("/moved", {
            redirects: [hop("/moved", 308, "https://archive.test/moved")],
            finalUrl: "https://archive.test/moved",
            status: 200,
          }),
        ),
      ],
      [{ ...away, status: 308 }],
    );

    expect(result.findings).toEqual([]);
    expect(result.report.verified).toBe(1);
    expect(result.report.checks[0]?.observed.targetIndexability).toBe("indexable");
  });

  it("keeps a query-bearing source and target exact", () => {
    const result = auditRedirectContracts(
      [
        route(
          "/search?q=old",
          snapshot("/search?q=old", {
            redirects: [hop("/search?q=old", 301, "/search")],
            finalUrl: absolute("/search"),
          }),
        ),
      ],
      [contract("/search?q=old", "/search")],
    );

    expect(result.findings).toEqual([]);
    expect(result.report.verified).toBe(1);
  });
});
