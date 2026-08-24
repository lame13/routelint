import { describe, expect, it } from "vitest";

import {
  buildInitialCandidates,
  mergeRouteCandidates,
  normalizeCandidateUrl,
} from "../src/discovery/candidates.js";
import type { BuildInventory, RouteCandidate, SitemapInventory } from "../src/types.js";

describe("candidate discovery", () => {
  it("normalizes HTTP URLs deterministically", () => {
    expect(
      normalizeCandidateUrl(" /a/../b?z=2&a=1#section ", "https://EXAMPLE.com:443/base", "drop"),
    ).toBe("https://example.com/b");
    expect(normalizeCandidateUrl("/b?z=2&a=1#section", "https://example.com", "keep")).toBe(
      "https://example.com/b?a=1&z=2",
    );
    expect(normalizeCandidateUrl("mailto:test@example.com", "https://example.com")).toBeUndefined();
    expect(
      normalizeCandidateUrl("https://user:secret@example.com/", "https://example.com"),
    ).toBeUndefined();
    expect(normalizeCandidateUrl("/bad\npath", "https://example.com")).toBeUndefined();
  });

  it("merges duplicate same-origin candidates and retains minimum depth and evidence", () => {
    const candidates: RouteCandidate[] = [
      { url: "/a?tracking=1", depth: 2, sources: [{ kind: "internal-link", from: "/" }] },
      { url: "https://example.com/a", depth: 0, sources: [{ kind: "seed" }] },
      { url: "https://other.example/a", depth: 0, sources: [{ kind: "seed" }] },
    ];

    const merged = mergeRouteCandidates("https://example.com", candidates);

    expect(merged).toEqual([
      {
        url: "https://example.com/a",
        depth: 0,
        sources: [{ kind: "internal-link", from: "/" }, { kind: "seed" }],
      },
    ]);
  });

  it("builds and merges the initial frontier from seeds, sitemap, and build routes", () => {
    const sitemap: SitemapInventory = {
      requested: ["https://example.com/sitemap.xml"],
      fetched: ["https://example.com/sitemap.xml"],
      entries: [
        {
          url: "https://example.com/a?from=sitemap",
          sitemapUrl: "https://example.com/sitemap.xml",
          alternates: [],
        },
        {
          url: "https://external.example/outside",
          sitemapUrl: "https://example.com/sitemap.xml",
          alternates: [],
        },
      ],
      warnings: [],
    };
    const buildRoute = {
      pathname: "/a",
      renderMode: "static" as const,
      sourceManifest: ".next/prerender-manifest.json",
    };
    const build: BuildInventory = {
      framework: "next",
      root: "/project",
      buildDirectory: "/project/.next",
      routes: [buildRoute],
      unresolvedPatterns: [],
      redirects: [],
      warnings: [],
    };

    const collection = buildInitialCandidates({
      baseUrl: "https://example.com",
      seeds: ["/a", "https://external.example/seed"],
      sitemap,
      build,
    });

    expect(collection.candidates).toHaveLength(1);
    expect(collection.candidates[0]).toEqual({
      url: "https://example.com/a",
      depth: 0,
      sources: [
        { kind: "seed" },
        { kind: "sitemap", from: "https://example.com/sitemap.xml" },
        { kind: "next-build", from: ".next/prerender-manifest.json" },
      ],
      sitemap: sitemap.entries[0],
      build: buildRoute,
    });
    expect(
      collection.warnings.filter((warning) => warning.includes("another origin")),
    ).toHaveLength(2);
  });
});
