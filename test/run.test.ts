import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { runRouteLint } from "../src/run.js";
import type { RouteLintConfig } from "../src/types.js";

const servers: Server[] = [];
const agent = {
  key: "routelint",
  label: "RouteLint",
  userAgent: "RouteLint/Test",
} as const;

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

function config(baseUrl: string): RouteLintConfig {
  return {
    baseUrl,
    seeds: [baseUrl],
    sitemaps: "auto",
    agents: [agent],
    headers: { "x-preview-key": "local-test-secret" },
    include: [],
    exclude: [],
    queryPolicy: "drop",
    respectRobots: true,
    limits: {
      maxPages: 20,
      maxDepth: 4,
      concurrency: 3,
      timeoutMs: 2_000,
      maxBytes: 100_000,
      maxRedirects: 3,
    },
    audit: {
      requireTitle: true,
      requireDescription: true,
      requireCanonical: true,
      requireH1: true,
      requireSitemapCoverage: true,
      maxDepth: 3,
    },
  };
}

function html(origin: string, path: string, body = ""): string {
  return `<!doctype html><html lang="en"><head>
    <title>${path === "/" ? "Home" : path}</title>
    <meta name="description" content="Description for ${path}">
    <link rel="canonical" href="${origin}${path}">
  </head><body><h1>${path}</h1>${body}</body></html>`;
}

describe("runRouteLint", () => {
  it("discovers robots and sitemaps, crawls SSR HTML, and audits the resulting graph", async () => {
    const requestedPaths: string[] = [];
    const requestsWithoutPreviewHeader: string[] = [];
    let origin = "";
    origin = await listen((request, response) => {
      const path = request.url ?? "/";
      requestedPaths.push(path);
      if (request.headers["x-preview-key"] !== "local-test-secret") {
        requestsWithoutPreviewHeader.push(path);
      }
      response.setHeader("x-reflected-preview", request.headers["x-preview-key"] ?? "missing");

      if (path === "/robots.txt") {
        response
          .writeHead(200, { "content-type": "text/plain" })
          .end(`User-agent: *\nDisallow: /private\nSitemap: ${origin}/site-map.xml\n`);
        return;
      }
      if (path === "/site-map.xml") {
        response.writeHead(200, { "content-type": "application/xml" }).end(`<urlset>
          <url><loc>${origin}/</loc></url>
          <url><loc>${origin}/about</loc></url>
          <url><loc>${origin}/old</loc></url>
          <url><loc>${origin}/gone</loc></url>
          <url><loc>${origin}/private</loc></url>
        </urlset>`);
        return;
      }
      if (path === "/") {
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(
            html(
              origin,
              "/",
              '<a href="/about">About</a><a href="/old">Old</a>' +
                '<a href="/gone">Gone</a><a href="/private">Private</a>',
            ),
          );
        return;
      }
      if (path === "/about") {
        response
          .writeHead(200, { "content-type": "text/html" })
          .end(html(origin, "/about", '<a href="/">Home</a>'));
        return;
      }
      if (path === "/old") {
        response.writeHead(301, { location: "/about" }).end();
        return;
      }
      if (path === "/gone") {
        response.writeHead(404, { "content-type": "text/html" }).end(html(origin, "/gone"));
        return;
      }
      response.writeHead(500).end("The robots-blocked route must never be requested.");
    });

    const report = await runRouteLint(config(`${origin}/`));
    const byUrl = new Map(report.routes.map((route) => [route.url, route]));
    const findingCodes = report.findings.map((finding) => finding.code);

    expect(report).toMatchObject({
      schemaVersion: "1",
      toolVersion: "0.1.0",
      baseUrl: `${origin}/`,
      truncated: false,
      config: {
        maxPages: 20,
        maxDepth: 4,
        agents: ["routelint"],
        respectRobots: true,
        queryPolicy: "drop",
      },
    });
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.robots?.sitemaps).toEqual([`${origin}/site-map.xml`]);
    expect(report.sitemap.requested).toEqual([`${origin}/site-map.xml`]);
    expect(report.sitemap.fetched).toEqual([`${origin}/site-map.xml`]);
    expect(report.routes).toHaveLength(5);
    expect(byUrl.get(`${origin}/`)?.outbound).toEqual([
      `${origin}/about`,
      `${origin}/gone`,
      `${origin}/old`,
      `${origin}/private`,
    ]);
    expect(byUrl.get(`${origin}/about`)?.inbound).toEqual([`${origin}/`]);
    expect(byUrl.get(`${origin}/private`)?.snapshots[0]?.completion).toBe("robots-blocked");
    expect(findingCodes).toEqual(
      expect.arrayContaining([
        "broken-internal-link",
        "redirecting-internal-link",
        "sitemap-broken-url",
        "sitemap-redirect",
        "sitemap-robots-blocked",
      ]),
    );
    expect(report.summary).toMatchObject({
      routes: 5,
      fetched: 5,
      brokenLinks: 1,
      redirects: 1,
    });
    expect(requestedPaths).not.toContain("/private");
    expect(requestsWithoutPreviewHeader).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("local-test-secret");
  });

  it("reports unavailable robots and skips routes unless robots are explicitly ignored", async () => {
    const requestedPaths: string[] = [];
    let origin = "";
    origin = await listen((request, response) => {
      const path = request.url ?? "/";
      requestedPaths.push(path);
      if (path === "/robots.txt") {
        response.writeHead(503).end("temporary failure");
        return;
      }
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(html(origin, "/", '<a href="/next">Next</a>'));
    });
    const respectedConfig = { ...config(`${origin}/`), sitemaps: [] } satisfies RouteLintConfig;

    const respected = await runRouteLint(respectedConfig);
    expect(respected.robots?.availability).toEqual({
      state: "unavailable",
      reason: "http-error",
    });
    expect(respected.routes[0]?.snapshots[0]?.completion).toBe("robots-blocked");
    expect(requestedPaths.filter((path) => path === "/")).toHaveLength(0);
    expect(
      respected.findings.some(
        (finding) =>
          finding.code === "robots-warning" &&
          finding.message.includes("Route fetching will be skipped"),
      ),
    ).toBe(true);

    const ignored = await runRouteLint({ ...respectedConfig, respectRobots: false });
    expect(ignored.routes[0]?.snapshots[0]?.completion).toBe("complete");
    expect(requestedPaths.filter((path) => path === "/")).toHaveLength(1);
  });
});

async function listen(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
