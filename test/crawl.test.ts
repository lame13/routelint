import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { crawlSite, isAllowedByRobots } from "../src/crawl.js";
import { redirectContractCandidates } from "../src/redirects.js";
import type { AgentProfile, CrawlOptions, RobotsFile } from "../src/types.js";

const primary: AgentProfile = {
  key: "testbot",
  label: "Test bot",
  userAgent: "TestBot/1.0",
};
const secondary: AgentProfile = {
  key: "otherbot",
  label: "Other bot",
  userAgent: "OtherBot/1.0",
};
const generic: AgentProfile = {
  key: "crawler",
  label: "Crawler",
  userAgent: "Crawler/1.0",
};
const servers: Server[] = [];

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

describe("crawlSite", () => {
  it("rejects an unsafe concurrency limit before crawling", async () => {
    await expect(
      crawlSite(crawlOptions("https://example.test", { seeds: ["/"], concurrency: 0 })),
    ).rejects.toThrow("concurrency must be a safe integer");
  });

  it("builds a deterministic same-origin BFS graph and only discovers from the primary agent", async () => {
    const origin = await listen((request, response) => {
      response.setHeader("content-type", "text/html");
      const otherBot = request.headers["user-agent"]?.includes("OtherBot") ?? false;
      if (request.url === "/") {
        response.end(
          otherBot
            ? '<a href="/secondary-only">Secondary only</a>'
            : `<a href="/b?campaign=one#top">B</a>
               <a href="/a" rel="nofollow">A</a>
               <a href="/private/key">Excluded</a>
               <a href="/cdn-cgi/l/email-protection#deadbeef">Cloudflare email</a>
               <a href="https://external.test/page">External</a>`,
        );
        return;
      }
      if (request.url === "/a") {
        response.end('<a href="/c">C from A</a>');
        return;
      }
      if (request.url === "/b") {
        awaitDelay(15, () => response.end('<a href="/c">C from B</a>'));
        return;
      }
      response.end("<h1>Leaf</h1>");
    });

    const result = await crawlSite(
      crawlOptions(origin, {
        seeds: ["/"],
        agents: [primary, secondary],
        exclude: ["**/private/**"],
        queryPolicy: "drop",
      }),
    );

    expect(result.truncated).toBe(false);
    expect(result.routes.map((route) => route.url)).toEqual([
      `${origin}/`,
      `${origin}/a`,
      `${origin}/b`,
      `${origin}/c`,
    ]);
    const root = result.routes[0];
    const routeC = result.routes[3];
    expect(root?.outbound).toEqual([`${origin}/a`, `${origin}/b`]);
    expect(root?.snapshots.map((snapshot) => snapshot.agent.key)).toEqual(["testbot", "otherbot"]);
    expect(routeC?.inbound).toEqual([`${origin}/a`, `${origin}/b`]);
    expect(routeC?.sources).toEqual([
      { kind: "internal-link", from: `${origin}/a` },
      { kind: "internal-link", from: `${origin}/b` },
    ]);
  });

  it("does not spend the crawl budget on links inside templates", async () => {
    const requestedPaths: string[] = [];
    const origin = await listen((request, response) => {
      requestedPaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/html" }).end(
        request.url === "/"
          ? `<template><a href="/placeholder">Unused</a></template>
             <a href="/real">Real page</a>`
          : "<h1>Real page</h1>",
      );
    });

    const result = await crawlSite(crawlOptions(origin, { seeds: ["/"], maxPages: 2 }));

    expect(requestedPaths).toEqual(["/", "/real"]);
    expect(result.routes.map((route) => route.url)).toEqual([`${origin}/`, `${origin}/real`]);
    expect(result.routes[0]?.outbound).toEqual([`${origin}/real`]);
    expect(result.truncated).toBe(false);
  });

  it("respects per-agent robots rules and never discovers links from a secondary snapshot", async () => {
    let requests = 0;
    const origin = await listen((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<a href="/should-not-be-discovered">Only secondary saw this</a>');
    });
    const robots: RobotsFile = {
      url: `${origin}/robots.txt`,
      status: 200,
      availability: { state: "available" },
      groups: [
        { agents: ["TestBot"], rules: [{ directive: "disallow", pattern: "/blocked" }] },
        { agents: ["OtherBot"], rules: [{ directive: "allow", pattern: "/" }] },
      ],
      sitemaps: [],
      warnings: [],
    };

    const result = await crawlSite(
      crawlOptions(origin, {
        seeds: ["/blocked"],
        agents: [primary, secondary],
        respectRobots: true,
        robots,
      }),
    );

    expect(requests).toBe(1);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.snapshots.map((snapshot) => snapshot.completion)).toEqual([
      "robots-blocked",
      "complete",
    ]);
    expect(result.routes[0]?.outbound).toEqual([]);
  });

  it("fails closed when robots policy is unavailable but honors explicit ignore-robots", async () => {
    let requests = 0;
    const origin = await listen((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/html" }).end("<h1>Fetched</h1>");
    });
    const robots: RobotsFile = {
      url: `${origin}/robots.txt`,
      status: 503,
      availability: { state: "unavailable", reason: "http-error" },
      groups: [],
      sitemaps: [],
      warnings: ["robots.txt returned HTTP 503 and is unavailable."],
    };

    const respected = await crawlSite(
      crawlOptions(origin, { seeds: ["/"], respectRobots: true, robots }),
    );
    expect(requests).toBe(0);
    expect(respected.routes[0]?.snapshots[0]).toMatchObject({
      completion: "robots-blocked",
      error:
        "robots.txt is unavailable (http-error); request skipped while robots rules are respected.",
    });

    const ignored = await crawlSite(
      crawlOptions(origin, { seeds: ["/"], respectRobots: false, robots }),
    );
    expect(requests).toBe(1);
    expect(ignored.routes[0]?.snapshots[0]?.completion).toBe("complete");
  });

  it("fails closed when robots policy was never fetched", async () => {
    let requests = 0;
    const origin = await listen((_request, response) => {
      requests += 1;
      response.end("should not be fetched");
    });
    const result = await crawlSite(crawlOptions(origin, { seeds: ["/"], respectRobots: true }));

    expect(requests).toBe(0);
    expect(result.routes[0]?.snapshots[0]).toMatchObject({
      completion: "robots-blocked",
      error: "robots.txt was not fetched; request skipped while robots rules are respected.",
    });
    expect(isAllowedByRobots(undefined, `${origin}/`, primary)).toBe(false);
  });

  it("merges initial provenance and keeps inbound and outbound evidence", async () => {
    const origin = await listen((request, response) => {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(request.url === "/" ? '<a href="/about">About</a>' : "<h1>About</h1>");
    });
    const result = await crawlSite(
      crawlOptions(origin, {
        seeds: ["/"],
        candidates: [
          {
            url: "/",
            depth: 0,
            sources: [{ kind: "sitemap", from: `${origin}/sitemap.xml` }],
          },
        ],
      }),
    );

    expect(result.routes[0]?.sources).toEqual([
      { kind: "seed" },
      { kind: "sitemap", from: `${origin}/sitemap.xml` },
    ]);
    expect(result.routes[1]?.inbound).toEqual([`${origin}/`]);
  });

  it("reports click depth from seeds instead of treating sitemap routes as depth zero", async () => {
    const origin = await listen((request, response) => {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(request.url === "/" ? '<a href="/about">About</a>' : "<h1>Page</h1>");
    });
    const result = await crawlSite(
      crawlOptions(origin, {
        seeds: ["/"],
        candidates: [
          { url: "/about", depth: 0, sources: [{ kind: "sitemap" }] },
          { url: "/orphan", depth: 0, sources: [{ kind: "sitemap" }] },
        ],
      }),
    );

    expect(
      Object.fromEntries(result.routes.map((route) => [new URL(route.url).pathname, route.depth])),
    ).toEqual({ "/": 0, "/about": 1, "/orphan": -1 });
  });

  it("enforces the page and depth budgets without losing observed outbound edges", async () => {
    const origin = await listen((_request, response) => {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end('<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>');
    });
    const pageLimited = await crawlSite(
      crawlOptions(origin, { seeds: ["/"], maxPages: 2, maxDepth: 5 }),
    );
    expect(pageLimited.truncated).toBe(true);
    expect(pageLimited.routes.map((route) => route.url)).toEqual([`${origin}/`, `${origin}/a`]);
    expect(pageLimited.routes[0]?.outbound).toEqual([`${origin}/a`, `${origin}/b`, `${origin}/c`]);

    const depthLimited = await crawlSite(
      crawlOptions(origin, { seeds: ["/"], maxPages: 10, maxDepth: 0 }),
    );
    expect(depthLimited.truncated).toBe(true);
    expect(depthLimited.routes).toHaveLength(1);
    expect(depthLimited.routes[0]?.outbound).toHaveLength(3);
  });

  it("fetches redirect contract sources before their targets when the page budget is tight", async () => {
    const requested: string[] = [];
    const origin = await listen((request, response) => {
      requested.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/html" }).end("<h1>Page</h1>");
    });

    const result = await crawlSite(
      crawlOptions(origin, {
        maxPages: 1,
        candidates: [
          {
            url: "/z-source",
            depth: 0,
            sources: [{ kind: "redirect-contract", from: "config", detail: "source" }],
          },
          {
            url: "/a-target",
            depth: 0,
            sources: [{ kind: "redirect-contract", from: `${origin}/z-source`, detail: "target" }],
          },
        ],
      }),
    );

    expect(result.truncated).toBe(true);
    expect(result.routes.map((route) => route.url)).toEqual([`${origin}/z-source`]);
    expect(requested).toEqual(["/z-source"]);
  });

  it("applies the concurrency budget across all agent requests", async () => {
    let active = 0;
    let maximumActive = 0;
    const origin = await listen((_request, response) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      awaitDelay(20, () => {
        active -= 1;
        response.writeHead(200, { "content-type": "text/html" }).end("<h1>Done</h1>");
      });
    });

    await crawlSite(
      crawlOptions(origin, {
        seeds: ["/a", "/b", "/c"],
        agents: [primary, secondary],
        concurrency: 2,
      }),
    );

    expect(maximumActive).toBeLessThanOrEqual(2);
  });
});

describe("request pacing", () => {
  it("paces redirect hops and agents without counting queued time as response time", async () => {
    const starts: number[] = [];
    const origin = await listen((request, response) => {
      starts.push(performance.now());
      if (request.url === "/old") {
        response.writeHead(301, { location: "/new" }).end();
      } else {
        response.writeHead(200, { "content-type": "text/html" }).end("<h1>Page</h1>");
      }
    });
    const result = await crawlSite(
      crawlOptions(origin, {
        seeds: ["/old"],
        agents: [primary, secondary],
        delayMs: 150,
        timeoutMs: 100,
      }),
    );
    expect(starts).toHaveLength(4);
    for (let index = 1; index < starts.length; index += 1) {
      expect((starts[index] ?? 0) - (starts[index - 1] ?? 0)).toBeGreaterThanOrEqual(125);
    }
    for (const snapshot of result.routes[0]?.snapshots ?? []) {
      expect(snapshot.completion).toBe("complete");
      expect(snapshot.durationMs).toBeLessThan(100);
      expect(snapshot.redirects[0]?.durationMs).toBeLessThan(100);
    }
  });

  it("preserves explicit minimum spacing longer than the robots delay cap", async () => {
    const origin = await listen((_request, response) => response.end("Page"));
    const result = await crawlSite(crawlOptions(origin, { seeds: ["/only"], delayMs: 20_000 }));
    expect(result.pacing).toEqual({ delayMs: 20_000, clamped: false });
  });

  it("prioritizes pattern samples over concrete targets under a page limit", async () => {
    const origin = await listen((_request, response) => response.end("Page"));
    const candidates = redirectContractCandidates([
      {
        from: `${origin}/z/*`,
        to: `${origin}/a`,
        status: 301,
        maxHops: 1,
        kind: "pattern",
        source: "config",
        samples: [`${origin}/z/sample`],
      },
    ]);
    const result = await crawlSite(crawlOptions(origin, { candidates, maxPages: 1 }));
    expect(result.routes.map((route) => route.url)).toEqual([`${origin}/z/sample`]);
  });

  it("spaces request starts by the configured delay", async () => {
    const starts: number[] = [];
    const origin = await listen((_request, response) => {
      starts.push(Date.now());
      response.writeHead(200, { "content-type": "text/html" }).end("<h1>Page</h1>");
    });

    const result = await crawlSite(
      crawlOptions(origin, { seeds: ["/a", "/b", "/c"], delayMs: 60 }),
    );

    expect(result.pacing).toEqual({ delayMs: 60, clamped: false });
    expect(starts).toHaveLength(3);
    expect((starts.at(-1) ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(90);
  });

  it("honors a robots.txt crawl delay unless it is explicitly ignored", async () => {
    const starts: number[] = [];
    const origin = await listen((_request, response) => {
      starts.push(Date.now());
      response.writeHead(200, { "content-type": "text/html" }).end("<h1>Page</h1>");
    });
    const robots: RobotsFile = {
      url: `${origin}/robots.txt`,
      availability: { state: "available" },
      groups: [{ agents: ["*"], rules: [], crawlDelaySeconds: 0.06 }],
      sitemaps: [],
      warnings: [],
      crawlDelaySeconds: 0.06,
    };

    const honored = await crawlSite(
      crawlOptions(origin, { seeds: ["/a", "/b"], respectRobots: true, robots }),
    );
    expect(honored.pacing).toEqual({ delayMs: 60, robotsDelaySeconds: 0.06, clamped: false });
    expect((starts.at(-1) ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(45);

    starts.length = 0;
    const ignored = await crawlSite(
      crawlOptions(origin, {
        seeds: ["/a", "/b"],
        respectRobots: true,
        robots,
        honorCrawlDelay: false,
      }),
    );
    expect(ignored.pacing).toEqual({ delayMs: 0, clamped: false });
    expect((starts.at(-1) ?? 0) - (starts[0] ?? 0)).toBeLessThan(45);
  });

  it("caps an extreme declared crawl delay and reports the cap", async () => {
    const origin = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end("<h1>Page</h1>");
    });
    const robots: RobotsFile = {
      url: `${origin}/robots.txt`,
      availability: { state: "available" },
      groups: [{ agents: ["*"], rules: [], crawlDelaySeconds: 3_600 }],
      sitemaps: [],
      warnings: [],
      crawlDelaySeconds: 3_600,
    };

    const result = await crawlSite(
      crawlOptions(origin, { seeds: ["/only"], respectRobots: true, robots }),
    );

    expect(result.pacing).toEqual({ delayMs: 10_000, robotsDelaySeconds: 3_600, clamped: true });
  });

  it("keeps the query string of a declared redirect source while discovery drops queries", async () => {
    const requested: string[] = [];
    const origin = await listen((_request, response) => {
      requested.push(_request.url ?? "");
      response
        .writeHead(200, { "content-type": "text/html" })
        .end('<a href="/linked?from=page">Link</a>');
    });

    const result = await crawlSite(
      crawlOptions(origin, {
        seeds: ["/"],
        queryPolicy: "drop",
        candidates: [
          {
            url: "/legacy?ref=old",
            depth: 0,
            sources: [{ kind: "redirect-contract", from: "config", detail: "source" }],
          },
        ],
      }),
    );

    expect(requested).toContain("/legacy?ref=old");
    expect(requested).toContain("/linked");
    expect(result.routes.map((route) => route.url).sort()).toEqual([
      `${origin}/`,
      `${origin}/legacy?ref=old`,
      `${origin}/linked`,
    ]);
  });
});

describe("isAllowedByRobots", () => {
  const robots: RobotsFile = {
    url: "https://example.test/robots.txt",
    availability: { state: "available" },
    groups: [
      {
        agents: ["*"],
        rules: [
          { directive: "disallow", pattern: "/private/*" },
          { directive: "allow", pattern: "/private/public$" },
        ],
      },
      {
        agents: ["TestBot"],
        rules: [
          { directive: "disallow", pattern: "/bot" },
          { directive: "allow", pattern: "/bot/open" },
        ],
      },
    ],
    sitemaps: [],
    warnings: [],
  };

  it("selects the most-specific agent group and most-specific matching rule", () => {
    expect(isAllowedByRobots(robots, "https://example.test/bot/closed", primary)).toBe(false);
    expect(isAllowedByRobots(robots, "https://example.test/bot/open/page", primary)).toBe(true);
    expect(isAllowedByRobots(robots, "https://example.test/private/secret", generic)).toBe(false);
    expect(isAllowedByRobots(robots, "https://example.test/private/public", generic)).toBe(true);
    expect(isAllowedByRobots(robots, "https://other.test/private/secret", generic)).toBe(true);
  });
});

function crawlOptions(origin: string, overrides: Partial<CrawlOptions>): CrawlOptions {
  return {
    baseUrl: origin,
    seeds: [],
    candidates: [],
    agents: [primary],
    headers: {},
    include: [],
    exclude: [],
    queryPolicy: "keep",
    respectRobots: false,
    maxPages: 20,
    maxDepth: 3,
    concurrency: 2,
    timeoutMs: 2_000,
    maxBytes: 100_000,
    maxRedirects: 3,
    ...overrides,
  };
}

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

function awaitDelay(milliseconds: number, callback: () => void): void {
  setTimeout(callback, milliseconds);
}
