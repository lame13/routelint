import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runRouteLint } from "../src/run.js";
import type { RenderedPageSnapshot, RouteLintConfig } from "../src/types.js";

const captureRenderedPagesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/rendered.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/rendered.js")>()),
  captureRenderedPages: captureRenderedPagesMock,
}));

const servers: Server[] = [];
const temporaryDirectories: string[] = [];
const agent = {
  key: "routelint",
  label: "RouteLint",
  userAgent: "RouteLint/Test",
} as const;

afterEach(async () => {
  captureRenderedPagesMock.mockReset();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
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
      schemaVersion: "2",
      toolVersion: "0.2.0",
      baseUrl: `${origin}/`,
      truncated: false,
      config: {
        maxPages: 20,
        maxDepth: 4,
        agents: ["routelint"],
        respectRobots: true,
        queryPolicy: "drop",
        seeds: [`${origin}/`],
        sitemapMode: "auto",
        sitemapUrls: [],
        include: [],
        exclude: [],
        timeoutMs: 2_000,
        maxBytes: 100_000,
        maxRedirects: 3,
        headerNames: ["x-preview-key"],
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

  it("adds URL-list routes to the crawl and records rejected off-origin entries", async () => {
    let origin = "";
    origin = await listen((request, response) => {
      if (request.url === "/robots.txt") {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(html(origin, request.url ?? "/"));
    });
    const directory = await mkdtemp(join(tmpdir(), "routelint-run-"));
    temporaryDirectories.push(directory);
    const list = join(directory, "targets.txt");
    await writeFile(list, "/listed\nhttps://outside.test/rejected\n", "utf8");

    const report = await runRouteLint({
      ...config(`${origin}/`),
      sitemaps: [],
      urlFiles: [list],
    });

    expect(report.routes.map((route) => route.url)).toContain(`${origin}/listed`);
    expect(report.routes.find((route) => route.url === `${origin}/listed`)?.sources).toContainEqual(
      { kind: "url-list", from: "targets.txt", detail: "line 1" },
    );
    expect(report.inputs).toMatchObject({ urlListFiles: 1, urlListUrls: 1 });
    expect(report.inputs?.warnings[0]).toContain("outside");
    expect(JSON.stringify(report)).not.toContain(directory);
  });

  it("renders only complete direct 2xx HTML routes and attaches the evidence", async () => {
    let origin = "";
    origin = await listen((request, response) => {
      const path = request.url ?? "/";
      if (path === "/robots.txt") {
        response.writeHead(404).end();
        return;
      }
      if (path === "/") {
        response
          .writeHead(200, { "content-type": "text/html" })
          .end(
            html(
              origin,
              "/",
              '<a href="/eligible">Eligible</a><a href="/data">Data</a>' +
                '<a href="/old">Old</a><a href="/gone">Gone</a>',
            ),
          );
        return;
      }
      if (path === "/eligible") {
        response.writeHead(200, { "content-type": "text/html" }).end(html(origin, path));
        return;
      }
      if (path === "/data") {
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (path === "/old") {
        response.writeHead(302, { location: "/eligible" }).end();
        return;
      }
      response.writeHead(404, { "content-type": "text/html" }).end(html(origin, path));
    });
    captureRenderedPagesMock.mockImplementation(
      async (urls: readonly string[]): Promise<readonly RenderedPageSnapshot[]> =>
        urls.map((url) => ({
          requestedUrl: url,
          finalUrl: url,
          status: 200,
          completion: "complete",
          signals: {
            titles: [{ value: `Rendered ${new URL(url).pathname}`, location: "head" }],
            descriptions: [],
            canonicals: [],
            robots: [],
            h1s: [],
            links: [],
            hreflangs: [],
          },
          htmlBytes: 200,
          durationMs: 5,
        })),
    );

    const report = await runRouteLint({
      ...config(`${origin}/`),
      sitemaps: [],
      rendered: { enabled: true, concurrency: 2, timeoutMs: 1_000, settleMs: 0 },
    });

    expect(captureRenderedPagesMock).toHaveBeenCalledOnce();
    expect(captureRenderedPagesMock.mock.calls[0]?.[0]).toEqual([
      `${origin}/`,
      `${origin}/eligible`,
    ]);
    expect(captureRenderedPagesMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { "x-preview-key": "local-test-secret" },
      maxBytes: 100_000,
      concurrency: 2,
      timeoutMs: 1_000,
      settleMs: 0,
    });
    expect(report.routes.find((item) => item.url === `${origin}/`)?.rendered).toBeDefined();
    expect(report.routes.find((item) => item.url === `${origin}/eligible`)?.rendered).toBeDefined();
    expect(report.routes.find((item) => item.url === `${origin}/data`)?.rendered).toBeUndefined();
    expect(report.routes.find((item) => item.url === `${origin}/old`)?.rendered).toBeUndefined();
    expect(report.routes.find((item) => item.url === `${origin}/gone`)?.rendered).toBeUndefined();
    expect(report.config).toMatchObject({
      rendered: true,
      renderedConcurrency: 2,
      renderedTimeoutMs: 1_000,
      renderedSettleMs: 0,
    });
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
