import { describe, expect, it } from "vitest";
import type { AuditInput } from "../src/audit.js";
import {
  auditSite,
  getIndexability,
  highestSeverity,
  meetsFailureThreshold,
  routeStatus,
} from "../src/audit.js";
import type {
  AuditOptions,
  HreflangSignal,
  PageSignals,
  PageSnapshot,
  RouteNode,
  SitemapEntry,
} from "../src/types.js";

const origin = "https://example.test";
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

const quietAudit: AuditOptions = {
  requireTitle: false,
  requireDescription: false,
  requireCanonical: false,
  requireH1: false,
  requireSitemapCoverage: false,
  maxDepth: 4,
};

function absolute(path: string): string {
  return new URL(path, origin).href;
}

function sitemap(path: string): SitemapEntry {
  return {
    url: absolute(path),
    sitemapUrl: absolute("/sitemap.xml"),
    alternates: [],
  };
}

function signals(overrides: Partial<PageSignals> = {}): PageSignals {
  return {
    titles: [{ value: "Unique title", location: "head" }],
    descriptions: [{ value: "Unique description", location: "head" }],
    canonicals: [],
    robots: [],
    h1s: [{ value: "Heading", location: "body" }],
    links: [],
    hreflangs: [],
    ...overrides,
  };
}

function snapshot(
  path: string,
  overrides: Omit<Partial<PageSnapshot>, "status"> & { readonly status?: number | null } = {},
  signalOverrides: Partial<PageSignals> = {},
): PageSnapshot {
  const url = absolute(path);
  const { status = 200, ...snapshotOverrides } = overrides;
  return {
    requestedUrl: url,
    finalUrl: url,
    agent,
    ...(status === null ? {} : { status }),
    contentType: "text/html; charset=utf-8",
    headers: { "content-type": "text/html; charset=utf-8" },
    redirects: [],
    signals: signals(signalOverrides),
    bytesRead: 500,
    durationMs: 4,
    completion: "complete",
    ...snapshotOverrides,
  };
}

interface RouteOptions {
  readonly depth?: number;
  readonly inbound?: readonly string[];
  readonly outbound?: readonly string[];
  readonly page?: PageSnapshot;
  readonly pages?: readonly PageSnapshot[];
  readonly sitemap?: SitemapEntry;
  readonly build?: RouteNode["build"];
}

function route(path: string, options: RouteOptions = {}): RouteNode {
  return {
    url: absolute(path),
    depth: options.depth ?? 0,
    sources: [{ kind: "seed" }],
    ...(options.sitemap === undefined ? {} : { sitemap: options.sitemap }),
    ...(options.build === undefined ? {} : { build: options.build }),
    snapshots: options.pages ?? [options.page ?? snapshot(path)],
    inbound: options.inbound ?? [],
    outbound: options.outbound ?? [],
  };
}

function auditInput(routes: readonly RouteNode[], overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    baseUrl: `${origin}/`,
    routes,
    sitemap: {
      requested: [absolute("/sitemap.xml")],
      fetched: [absolute("/sitemap.xml")],
      entries: routes.flatMap((item) => (item.sitemap === undefined ? [] : [item.sitemap])),
      warnings: [],
    },
    options: quietAudit,
    truncated: false,
    ...overrides,
  };
}

function codesFor(input: AuditInput, url?: string): string[] {
  return auditSite(input)
    .findings.filter((finding) => url === undefined || finding.url === absolute(url))
    .map((finding) => finding.code);
}

describe("cross-route sitemap and link audits", () => {
  it("flags redirects, broken URLs, and noindex conflicts in sitemaps and internal links", () => {
    const root = route("/", {
      outbound: [absolute("/broken"), absolute("/old"), absolute("/hidden")],
    });
    const broken = route("/broken", {
      inbound: [root.url],
      sitemap: sitemap("/broken"),
      page: snapshot("/broken", { status: 404 }),
    });
    const redirected = route("/old", {
      inbound: [root.url],
      sitemap: sitemap("/old"),
      page: snapshot("/old", {
        finalUrl: absolute("/new"),
        redirects: [
          {
            url: absolute("/old"),
            status: 308,
            location: absolute("/new"),
            durationMs: 1,
          },
        ],
      }),
    });
    const hidden = route("/hidden", {
      inbound: [root.url],
      sitemap: sitemap("/hidden"),
      page: snapshot(
        "/hidden",
        {},
        {
          robots: [
            {
              value: "noindex, follow",
              location: "head",
              audience: "robots",
              source: "meta",
            },
          ],
        },
      ),
    });
    const input = auditInput([root, broken, redirected, hidden]);
    const output = auditSite(input);

    expect(codesFor(input, "/")).toEqual(
      expect.arrayContaining([
        "broken-internal-link",
        "redirecting-internal-link",
        "internal-link-to-noindex",
      ]),
    );
    expect(codesFor(input, "/broken")).toContain("sitemap-broken-url");
    expect(codesFor(input, "/old")).toContain("sitemap-redirect");
    expect(codesFor(input, "/hidden")).toContain("sitemap-noindex");
    expect(output.summary).toMatchObject({
      routes: 4,
      fetched: 4,
      brokenLinks: 1,
      redirects: 1,
      noindex: 1,
    });
  });
});

describe("canonical target audits", () => {
  it("checks broken, redirecting, noindex, and undiscovered internal canonical targets", () => {
    const brokenTarget = route("/broken-target", {
      page: snapshot("/broken-target", { status: 410 }),
    });
    const redirectTarget = route("/redirect-target", {
      page: snapshot("/redirect-target", {
        finalUrl: absolute("/destination"),
        redirects: [
          {
            url: absolute("/redirect-target"),
            status: 301,
            location: absolute("/destination"),
            durationMs: 2,
          },
        ],
      }),
    });
    const noindexTarget = route("/noindex-target", {
      page: snapshot(
        "/noindex-target",
        {},
        {
          robots: [
            {
              value: "none",
              location: "head",
              audience: "robots",
              source: "header",
            },
          ],
        },
      ),
    });
    const sourceBroken = route("/canonical-broken", {
      page: snapshot(
        "/canonical-broken",
        {},
        {
          canonicals: [{ value: "/broken-target", location: "head" }],
        },
      ),
    });
    const sourceRedirect = route("/canonical-redirect", {
      page: snapshot(
        "/canonical-redirect",
        {},
        {
          canonicals: [{ value: absolute("/redirect-target"), location: "head" }],
        },
      ),
    });
    const sourceNoindex = route("/canonical-noindex", {
      page: snapshot(
        "/canonical-noindex",
        {},
        {
          canonicals: [{ value: "/noindex-target", location: "head" }],
        },
      ),
    });
    const sourceUnseen = route("/canonical-unseen", {
      page: snapshot(
        "/canonical-unseen",
        {},
        {
          canonicals: [{ value: "/never-discovered", location: "head" }],
        },
      ),
    });
    const input = auditInput([
      sourceBroken,
      sourceRedirect,
      sourceNoindex,
      sourceUnseen,
      brokenTarget,
      redirectTarget,
      noindexTarget,
    ]);

    expect(codesFor(input, "/canonical-broken")).toContain("broken-canonical-target");
    expect(codesFor(input, "/canonical-redirect")).toContain("redirecting-canonical-target");
    expect(codesFor(input, "/canonical-noindex")).toContain("noindex-canonical-target");
    expect(
      auditSite(input).findings.find(
        (finding) =>
          finding.url === absolute("/canonical-unseen") &&
          finding.code === "canonical-target-unseen",
      ),
    ).toMatchObject({ severity: "warning" });
  });

  it("downgrades unseen canonical and hreflang targets when the crawl was truncated", () => {
    const alternates: readonly HreflangSignal[] = [
      { language: "de", href: "/de/page", resolvedUrl: absolute("/de/page") },
    ];
    const source = route("/page", {
      page: snapshot(
        "/page",
        {},
        {
          canonicals: [{ value: "/preferred", location: "head" }],
          hreflangs: alternates,
        },
      ),
    });
    const truncated = auditSite(auditInput([source], { truncated: true }));

    expect(
      truncated.findings.find((finding) => finding.code === "canonical-target-unseen"),
    ).toMatchObject({ severity: "info" });
    expect(
      truncated.findings.find((finding) => finding.code === "hreflang-target-unseen"),
    ).toMatchObject({ severity: "info" });
    expect(truncated.findings).toContainEqual(
      expect.objectContaining({ code: "page-budget-reached", severity: "warning" }),
    );

    const complete = auditSite(auditInput([source], { truncated: false }));
    expect(
      complete.findings.find((finding) => finding.code === "canonical-target-unseen"),
    ).toMatchObject({ severity: "warning" });
    expect(
      complete.findings.find((finding) => finding.code === "hreflang-target-unseen"),
    ).toMatchObject({ severity: "warning" });
  });
});

describe("hreflang graph audits", () => {
  it("requires reciprocal internal hreflang links", () => {
    const english = route("/en/page", {
      page: snapshot(
        "/en/page",
        {},
        {
          hreflangs: [{ language: "fr", href: "/fr/page", resolvedUrl: absolute("/fr/page") }],
        },
      ),
    });
    const french = route("/fr/page", {
      page: snapshot(
        "/fr/page",
        {},
        {
          hreflangs: [{ language: "fr", href: "/fr/page", resolvedUrl: absolute("/fr/page") }],
        },
      ),
    });

    const findings = auditSite(auditInput([english, french])).findings.filter(
      (finding) => finding.code === "hreflang-missing-return-link",
    );

    expect(findings).toEqual([
      expect.objectContaining({
        url: english.url,
        relatedUrls: [french.url],
        severity: "warning",
      }),
    ]);
  });
});

describe("depth, orphan, and duplicate audits", () => {
  it("finds deep orphans and duplicate route-level signals without a synthetic score", () => {
    const home = route("/", {
      outbound: [absolute("/Products/"), absolute("/products")],
    });
    const preferred = route("/preferred", { inbound: [home.url] });
    const first = route("/Products/", {
      inbound: [home.url],
      page: snapshot(
        "/Products/",
        {},
        {
          titles: [{ value: "Shared title", location: "head" }],
          descriptions: [{ value: "Shared description", location: "head" }],
          canonicals: [{ value: preferred.url, location: "head" }],
        },
      ),
    });
    const second = route("/products", {
      inbound: [home.url],
      page: snapshot(
        "/products",
        {},
        {
          titles: [{ value: " shared   title ", location: "head" }],
          descriptions: [{ value: "SHARED DESCRIPTION", location: "head" }],
          canonicals: [{ value: preferred.url, location: "head" }],
        },
      ),
    });
    const deep = route("/deep", {
      depth: 6,
      inbound: [home.url],
      sitemap: sitemap("/deep"),
      page: snapshot(
        "/deep",
        {},
        {
          canonicals: [{ value: absolute("/deep"), location: "head" }],
        },
      ),
    });
    const orphan = route("/orphan", {
      depth: -1,
      sitemap: sitemap("/orphan"),
      page: snapshot(
        "/orphan",
        {},
        { canonicals: [{ value: absolute("/orphan"), location: "head" }] },
      ),
    });
    const output = auditSite(auditInput([home, preferred, first, second, deep, orphan]));
    const codes = output.findings.map((finding) => finding.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "deep-route",
        "orphan-route",
        "duplicate-canonical-target",
        "duplicate-title-across-routes",
        "duplicate-description-across-routes",
        "route-case-or-slash-variant",
      ]),
    );
    expect(output.summary.maxDepth).toBe(6);
    expect(output.summary.indexable).toBe(6);
  });

  it("distinguishes duplicate from conflicting page-level metadata", () => {
    const duplicate = route("/duplicate", {
      page: snapshot(
        "/duplicate",
        {},
        {
          titles: [
            { value: "Same", location: "head" },
            { value: " Same ", location: "body" },
          ],
          canonicals: [
            { value: "/duplicate", location: "head" },
            { value: absolute("/duplicate"), location: "body" },
          ],
        },
      ),
    });
    const conflicting = route("/conflicting", {
      page: snapshot(
        "/conflicting",
        {},
        {
          descriptions: [
            { value: "First", location: "head" },
            { value: "Second", location: "body" },
          ],
        },
      ),
    });
    const codes = auditSite(auditInput([duplicate, conflicting])).findings.map(
      (finding) => finding.code,
    );

    expect(codes).toContain("duplicate-title");
    expect(codes).toContain("duplicate-canonical");
    expect(codes).toContain("conflicting-description");
  });
});

describe("audit helpers", () => {
  it("does not turn incomplete HTML into false metadata and graph findings", () => {
    const incomplete = route("/large", {
      depth: -1,
      sitemap: sitemap("/large"),
      pages: [
        snapshot(
          "/large",
          { completion: "max-bytes-exceeded", bytesRead: 1_024 },
          { titles: [], descriptions: [], canonicals: [], h1s: [], links: [] },
        ),
      ],
    });
    const output = auditSite(
      auditInput([incomplete], {
        options: {
          ...quietAudit,
          requireTitle: true,
          requireDescription: true,
          requireCanonical: true,
          requireH1: true,
          requireSitemapCoverage: true,
        },
      }),
    );
    const codes = output.findings.map((finding) => finding.code);

    expect(getIndexability(incomplete)).toBe("unknown");
    expect(codes).toContain("incomplete-fetch");
    expect(codes).not.toEqual(
      expect.arrayContaining([
        "missing-title",
        "missing-description",
        "missing-canonical",
        "missing-h1",
        "orphan-route",
        "dead-end-route",
        "not-in-sitemap",
      ]),
    );
    expect(output.summary.indexable).toBe(0);
  });

  it("reports bot and browser delivery differences with agent attribution", () => {
    const primary = snapshot(
      "/agent-view",
      {},
      {
        titles: [{ value: "Search title", location: "head" }],
        descriptions: [{ value: "Search description", location: "head" }],
        canonicals: [{ value: "/agent-view", location: "head" }],
        robots: [],
      },
    );
    const browser = snapshot(
      "/agent-view",
      { agent: browserAgent },
      {
        titles: [{ value: "Browser title", location: "head" }],
        descriptions: [{ value: "Browser description", location: "head" }],
        canonicals: [{ value: "/browser-view", location: "head" }],
        robots: [
          {
            value: "noindex, follow",
            location: "head",
            audience: "robots",
            source: "meta",
          },
        ],
      },
    );
    const output = auditSite(auditInput([route("/agent-view", { pages: [primary, browser] })]));
    const codes = output.findings.map((finding) => finding.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "agent-title-mismatch",
        "agent-description-mismatch",
        "agent-canonical-mismatch",
        "agent-robots-mismatch",
      ]),
    );
    expect(
      output.findings.find((finding) => finding.code === "agent-robots-mismatch"),
    ).toMatchObject({
      severity: "error",
      evidence: { primaryAgent: "routelint", comparedAgent: "browser" },
    });
  });

  it("reports secondary-agent failures even when the primary capture succeeds", () => {
    const primary = snapshot("/blocked-for-browser");
    const blocked = snapshot("/blocked-for-browser", {
      agent: browserAgent,
      status: null,
      completion: "robots-blocked",
    });
    const output = auditSite(
      auditInput([route("/blocked-for-browser", { pages: [primary, blocked] })]),
    );

    expect(output.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "agent-incomplete-fetch", severity: "warning" }),
        expect.objectContaining({ code: "agent-fetch-mismatch", severity: "error" }),
      ]),
    );
  });

  it("keeps uncertain responses out of the indexable count", () => {
    const blocked = route("/blocked", {
      page: snapshot("/blocked", { completion: "robots-blocked" }),
    });
    const nonHtml = route("/feed.xml", {
      page: snapshot("/feed.xml", { contentType: "application/xml" }),
    });
    const noindex = route("/noindex", {
      page: snapshot(
        "/noindex",
        {},
        {
          robots: [
            {
              value: "index, noindex, follow",
              location: "head",
              audience: "robots",
              source: "meta",
            },
          ],
        },
      ),
    });
    const redirected = route("/old", {
      page: snapshot("/old", {
        finalUrl: absolute("/new"),
        redirects: [
          {
            url: absolute("/old"),
            status: 301,
            location: absolute("/new"),
            durationMs: 1,
          },
        ],
      }),
    });

    expect(getIndexability(blocked)).toBe("unknown");
    expect(getIndexability(nonHtml)).toBe("unknown");
    expect(getIndexability(noindex)).toBe("noindex");
    expect(getIndexability(redirected)).toBe("unknown");
    expect(routeStatus(blocked)).toBe("200");
    expect(highestSeverity([])).toBeUndefined();
    expect(
      highestSeverity([
        { code: "info", severity: "info", message: "Info" },
        { code: "error", severity: "error", message: "Error" },
      ]),
    ).toBe("error");
    expect(meetsFailureThreshold("error", "warning")).toBe(true);
    expect(meetsFailureThreshold("info", "warning")).toBe(false);
  });
});
