import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { discoverNextBuild } from "../src/discovery/next.js";
import { parseHtml } from "../src/html-parser.js";

const fixtures = fileURLToPath(new URL("./fixtures/frameworks/", import.meta.url));

describe("frozen framework fixtures", () => {
  it("discovers public routes from a modern Next App Router build", async () => {
    const root = fileURLToPath(new URL("./fixtures/frameworks/next-16-app/", import.meta.url));
    const inventory = await discoverNextBuild({
      root,
      buildDirectory: ".next",
      samples: {
        "/blog/[slug]": ["release-020"],
        "/docs/[[...parts]]": ["guides/install"],
        "/photo/[id]": ["42"],
        "/products/[slug]": ["second"],
      },
    });

    expect(inventory.buildId).toBe("fixture-next-16-build");
    expect(inventory.nextVersion).toBe("16.0.1");
    expect(inventory.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pathname: "/", renderMode: "static" }),
        expect.objectContaining({ pathname: "/account", renderMode: "dynamic" }),
        expect.objectContaining({
          pathname: "/blog/release-020",
          pattern: "/blog/[slug]",
          renderMode: "dynamic",
        }),
        expect.objectContaining({
          pathname: "/docs/guides/install",
          pattern: "/docs/[[...parts]]",
          renderMode: "dynamic",
        }),
        expect.objectContaining({ pathname: "/favicon.ico", renderMode: "dynamic" }),
        expect.objectContaining({ pathname: "/legacy", renderMode: "dynamic" }),
        expect.objectContaining({ pathname: "/opengraph-image", renderMode: "dynamic" }),
        expect.objectContaining({
          pathname: "/photo/42",
          pattern: "/photo/[id]",
          renderMode: "dynamic",
        }),
        expect.objectContaining({ pathname: "/pricing", renderMode: "unknown" }),
        expect.objectContaining({
          pathname: "/products/second",
          pattern: "/products/[slug]",
          renderMode: "dynamic",
        }),
        expect.objectContaining({
          pathname: "/products/widget",
          pattern: "/products/[slug]",
          renderMode: "isr",
          revalidateSeconds: 300,
        }),
        expect.objectContaining({ pathname: "/robots.txt", renderMode: "dynamic" }),
        expect.objectContaining({ pathname: "/sitemap.xml", renderMode: "dynamic" }),
      ]),
    );
    expect(inventory.routes).toHaveLength(13);
    expect(inventory.routes.some((route) => route.pathname.startsWith("/api"))).toBe(false);
    expect(inventory.routes.some((route) => route.pathname === "/feed.xml")).toBe(false);
    expect(inventory.routes.some((route) => route.pathname === "/404")).toBe(false);
    expect(inventory.unresolvedPatterns).toEqual([]);
    expect(inventory.redirects).toEqual([
      { source: "/old-pricing", destination: "/pricing", status: 308 },
      { source: "/preview/:path*", destination: "/:path*", status: 307 },
    ]);
    expect(inventory.warnings).toEqual([
      'Partial prerendering was detected; affected routes use renderMode "unknown" because they are not fully static.',
    ]);
  });

  it("extracts SSR evidence from Astro output without treating hydration payloads as content", async () => {
    const html = await readFile(`${fixtures}/astro-ssr/guide.html`, "utf8");
    const signals = parseHtml(html, "https://example.test/guides/astro-ssr");

    expect(signals.titles).toEqual([{ value: "Astro SSR deployment guide", location: "head" }]);
    expect(signals.descriptions).toEqual([
      {
        value: "Deploy an Astro SSR site without hiding content from crawlers.",
        location: "head",
      },
    ]);
    expect(signals.canonicals).toEqual([
      { value: "https://example.test/guides/astro-ssr", location: "head" },
    ]);
    expect(signals.h1s).toEqual([
      { value: "Deploy Astro with server-rendered content", location: "body" },
    ]);
    expect(signals.links.map((link) => link.resolvedUrl)).toEqual([
      "https://example.test/",
      "https://example.test/guides",
      "https://example.test/guides/astro-ssr/adapters",
    ]);
    expect(signals.links.some((link) => link.text.includes("Hydrated-only"))).toBe(false);
  });
});
