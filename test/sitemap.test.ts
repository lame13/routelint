import { describe, expect, it } from "vitest";

import { fetchSitemaps, parseSitemapXml } from "../src/discovery/sitemap.js";

describe("sitemap discovery", () => {
  it("parses URL entries, entities, dates, and xhtml alternates", () => {
    const parsed = parseSitemapXml(
      `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://example.com/a?one=1&amp;two=2</loc>
    <lastmod>2026-08-20</lastmod>
    <image:image><image:loc>https://cdn.example/wrong.jpg</image:loc></image:image>
    <xhtml:link rel="alternate" hreflang="fr" href="/fr/a" />
  </url>
</urlset>`,
      "https://example.com/sitemap.xml",
    );

    expect(parsed.kind).toBe("urlset");
    expect(parsed.entries).toEqual([
      {
        url: "https://example.com/a?one=1&two=2",
        sitemapUrl: "https://example.com/sitemap.xml",
        lastModified: "2026-08-20",
        alternates: [{ language: "fr", href: "/fr/a", resolvedUrl: "https://example.com/fr/a" }],
      },
    ]);
  });

  it("recurses through sitemap indexes once and protects against loops", async () => {
    const documents = new Map([
      [
        "https://example.com/index.xml",
        `<sitemapindex><sitemap><loc>/child.xml</loc></sitemap><sitemap><loc>/index.xml</loc></sitemap></sitemapindex>`,
      ],
      [
        "https://example.com/child.xml",
        `<urlset><url><loc>https://example.com/one</loc></url><url><loc>https://example.com/one</loc></url></urlset>`,
      ],
    ]);
    const fetchImplementation: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = documents.get(url);
      return body ? new Response(body) : new Response("missing", { status: 404 });
    };

    const inventory = await fetchSitemaps(["https://example.com/index.xml"], {
      fetch: fetchImplementation,
      maxSitemaps: 4,
      maxDepth: 2,
    });

    expect(inventory.fetched).toEqual([
      "https://example.com/index.xml",
      "https://example.com/child.xml",
    ]);
    expect(inventory.entries.map((entry) => entry.url)).toEqual(["https://example.com/one"]);
  });

  it("honors recursion and response-size limits", async () => {
    const fetchImplementation: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("index.xml")) {
        return new Response(
          `<sitemapindex><sitemap><loc>/child.xml</loc></sitemap></sitemapindex>`,
        );
      }
      return new Response(`<urlset><url><loc>https://example.com/a</loc></url></urlset>`, {
        headers: { "content-length": "10000" },
      });
    };

    const depthLimited = await fetchSitemaps(["https://example.com/index.xml"], {
      fetch: fetchImplementation,
      maxDepth: 0,
    });
    expect(depthLimited.fetched).toEqual(["https://example.com/index.xml"]);
    expect(depthLimited.warnings.some((warning) => warning.includes("depth limit 0"))).toBe(true);

    const byteLimited = await fetchSitemaps(["https://example.com/child.xml"], {
      fetch: fetchImplementation,
      maxBytesPerSitemap: 100,
    });
    expect(byteLimited.entries).toEqual([]);
    expect(byteLimited.warnings.some((warning) => warning.includes("100-byte limit"))).toBe(true);
  });

  it("removes preview headers when a sitemap redirects across origins", async () => {
    const seen: Array<{ readonly url: string; readonly secret: string | null }> = [];
    const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      const secret = new Headers(init?.headers).get("x-preview-key");
      seen.push({ url, secret });
      if (url === "https://example.com/sitemap.xml") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://static.example.net/sitemap.xml" },
        });
      }
      return new Response("<urlset><url><loc>https://example.com/about</loc></url></urlset>");
    };

    const inventory = await fetchSitemaps(["https://example.com/sitemap.xml"], {
      fetch: fetchImplementation,
      headers: { "x-preview-key": "secret" },
      headerOrigin: "https://example.com",
    });

    expect(seen).toEqual([
      { url: "https://example.com/sitemap.xml", secret: "secret" },
      { url: "https://static.example.net/sitemap.xml", secret: null },
    ]);
    expect(inventory.entries.map((entry) => entry.url)).toEqual(["https://example.com/about"]);
  });
});
