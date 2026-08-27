import { describe, expect, it } from "vitest";

import {
  auditRedirectContracts,
  collectRedirectContracts,
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
