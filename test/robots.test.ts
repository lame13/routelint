import { describe, expect, it } from "vitest";

import {
  fetchRobots,
  isRobotsAllowed,
  parseRobotsText,
  robotsCrawlDelaySeconds,
} from "../src/discovery/robots.js";

describe("robots.txt discovery", () => {
  it("parses groups and sitemap directives", () => {
    const robots = parseRobotsText(
      `\uFEFF# leading comment
User-agent: ExampleBot
User-agent: SecondBot
Disallow: /private # trailing comment
Allow: /private/public$

User-agent: *
Disallow: /tmp*
Sitemap: /sitemap.xml
Sitemap: https://cdn.example/sitemap.xml#ignored
`,
      "https://example.com/somewhere",
    );

    expect(robots.url).toBe("https://example.com/robots.txt");
    expect(robots.availability).toEqual({ state: "available" });
    expect(robots.groups).toEqual([
      {
        agents: ["examplebot", "secondbot"],
        rules: [
          { directive: "disallow", pattern: "/private" },
          { directive: "allow", pattern: "/private/public$" },
        ],
      },
      { agents: ["*"], rules: [{ directive: "disallow", pattern: "/tmp*" }] },
    ]);
    expect(robots.sitemaps).toEqual([
      "https://example.com/sitemap.xml",
      "https://cdn.example/sitemap.xml",
    ]);
  });

  it("uses the most specific user-agent group and longest matching path rule", () => {
    const robots = parseRobotsText(
      `User-agent: *
Disallow: /

User-agent: Googlebot
Disallow: /private*
Allow: /private/public$
Disallow: /same
Allow: /same

User-agent: Googlebot
Disallow: /combined
`,
      "https://example.com/robots.txt",
    );

    expect(isRobotsAllowed(robots, "https://example.com/private/a", "Googlebot/2.1")).toBe(false);
    expect(isRobotsAllowed(robots, "/private/public", "Googlebot/2.1")).toBe(true);
    expect(isRobotsAllowed(robots, "/private/public/more", "Googlebot/2.1")).toBe(false);
    expect(isRobotsAllowed(robots, "/same", "Googlebot/2.1")).toBe(true);
    expect(isRobotsAllowed(robots, "/combined", "Googlebot/2.1")).toBe(false);
    expect(isRobotsAllowed(robots, "/public", "SomeCrawler/1.0")).toBe(false);
  });

  it("does not merge user-agent groups across extension records", () => {
    const robots = parseRobotsText(
      `User-agent: FirstBot
Crawl-delay: 2
User-agent: SecondBot
Disallow: /second-only
`,
      "https://example.com/robots.txt",
    );

    expect(robots.groups).toHaveLength(2);
    expect(isRobotsAllowed(robots, "/second-only", "FirstBot")).toBe(true);
    expect(isRobotsAllowed(robots, "/second-only", "SecondBot")).toBe(false);
  });

  it("returns a bounded warning instead of parsing an oversized response", async () => {
    const fetchImplementation: typeof globalThis.fetch = async () =>
      new Response("User-agent: *\nDisallow: /", {
        headers: { "content-length": "1000" },
      });

    const robots = await fetchRobots("https://example.com/page", {
      fetch: fetchImplementation,
      maxBytes: 100,
    });

    expect(robots.status).toBe(200);
    expect(robots.availability).toEqual({
      state: "unavailable",
      reason: "response-too-large",
    });
    expect(robots.groups).toEqual([]);
    expect(robots.warnings[0]).toContain("100-byte limit");
    expect(robots.warnings[0]).toContain("Route fetching will be skipped");
    expect(isRobotsAllowed(robots, "/", "AnyBot")).toBe(false);
  });

  it("reports a timeout without throwing", async () => {
    const fetchImplementation: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });

    const robots = await fetchRobots("https://example.com", {
      fetch: fetchImplementation,
      timeoutMs: 5,
    });

    expect(robots.availability).toEqual({ state: "unavailable", reason: "timeout" });
    expect(robots.warnings[0]).toContain("robots.txt timed out after 5ms");
    expect(robots.warnings[0]).toContain("Route fetching will be skipped");
  });

  it("marks HTTP server errors unavailable instead of treating them as an empty policy", async () => {
    const robots = await fetchRobots("https://example.com", {
      fetch: async () => new Response("temporary failure", { status: 503 }),
    });

    expect(robots).toMatchObject({
      status: 503,
      availability: { state: "unavailable", reason: "http-error" },
      groups: [],
      sitemaps: [],
    });
    expect(robots.warnings[0]).toContain("HTTP 503");
    expect(isRobotsAllowed(robots, "/public", "AnyBot")).toBe(false);
  });

  it("marks network failures unavailable", async () => {
    const robots = await fetchRobots("https://example.com", {
      fetch: async () => {
        throw new Error("connection reset");
      },
    });

    expect(robots.availability).toEqual({ state: "unavailable", reason: "network-error" });
    expect(robots.warnings[0]).toContain("Could not fetch robots.txt");
    expect(isRobotsAllowed(robots, "/public", "AnyBot")).toBe(false);
  });

  it("marks an undecodable robots response unavailable instead of parsing partial rules", async () => {
    const robots = await fetchRobots("https://example.com", {
      fetch: async () => new Response(Uint8Array.from([0xc3, 0x28])),
    });

    expect(robots.availability).toEqual({ state: "unavailable", reason: "parse-error" });
    expect(robots.warnings[0]).toContain("not valid UTF-8");
    expect(robots.groups).toEqual([]);
    expect(isRobotsAllowed(robots, "/public", "AnyBot")).toBe(false);
  });

  it("removes preview headers when robots.txt redirects across origins", async () => {
    const seen: Array<{ readonly url: string; readonly secret: string | null }> = [];
    const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      const secret = new Headers(init?.headers).get("x-preview-key");
      seen.push({ url, secret });
      if (url === "https://example.com/robots.txt") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://static.example.net/robots.txt" },
        });
      }
      return new Response("User-agent: *\nDisallow: /private\n");
    };

    const robots = await fetchRobots("https://example.com", {
      fetch: fetchImplementation,
      headers: { "x-preview-key": "secret" },
      headerOrigin: "https://example.com",
    });

    expect(seen).toEqual([
      { url: "https://example.com/robots.txt", secret: "secret" },
      { url: "https://static.example.net/robots.txt", secret: null },
    ]);
    expect(robots.availability).toEqual({ state: "available" });
    expect(isRobotsAllowed(robots, "/private", "AnyBot")).toBe(false);
  });

  it("treats a missing robots.txt as an empty policy", async () => {
    const robots = await fetchRobots("https://example.com", {
      fetch: async () => new Response("missing", { status: 404 }),
    });
    expect(robots).toMatchObject({
      status: 404,
      availability: { state: "missing" },
      groups: [],
      sitemaps: [],
      warnings: [],
    });
    expect(isRobotsAllowed(robots, "/public", "AnyBot")).toBe(true);
  });
});

describe("robots crawl delay", () => {
  const robotsUrl = "https://example.com/robots.txt";

  it("ignores a request rate whose normalized delay overflows", () => {
    const requests = `0.${"0".repeat(310)}1`;
    const robots = parseRobotsText(`User-agent: *\nRequest-rate: ${requests}/60\n`, robotsUrl);
    expect(robots.crawlDelaySeconds).toBeUndefined();
    expect(robots.warnings).toHaveLength(1);
    expect(robotsCrawlDelaySeconds(robots, "AnyBot")).toBeUndefined();
  });

  it("records Crawl-delay per group and keeps the strictest value on the file", () => {
    const robots = parseRobotsText(
      `User-agent: slowbot
Crawl-delay: 2
Disallow:

User-agent: *
Crawl-delay: 0.5
Disallow: /private
`,
      robotsUrl,
    );

    expect(robots.groups).toEqual([
      expect.objectContaining({ agents: ["slowbot"], crawlDelaySeconds: 2 }),
      expect.objectContaining({ agents: ["*"], crawlDelaySeconds: 0.5 }),
    ]);
    expect(robots.crawlDelaySeconds).toBe(2);
    expect(robotsCrawlDelaySeconds(robots, "SlowBot/1.0")).toBe(2);
    expect(robotsCrawlDelaySeconds(robots, "OtherBot/1.0")).toBe(0.5);
  });

  it("converts Request-rate into seconds per request and ignores unusable values", () => {
    const robots = parseRobotsText(
      `User-agent: *
Request-rate: 1/10
Disallow:
`,
      robotsUrl,
    );

    expect(robotsCrawlDelaySeconds(robots, "AnyBot")).toBe(10);
    expect(robots.crawlDelaySeconds).toBe(10);

    const hourly = parseRobotsText(
      `User-agent: *
Request-rate: 6/m
Disallow:
`,
      robotsUrl,
    );
    expect(robotsCrawlDelaySeconds(hourly, "AnyBot")).toBe(10);
  });

  it("warns about unusable values instead of guessing", () => {
    const robots = parseRobotsText(
      `User-agent: *
Crawl-delay: soon
Request-rate: often
Disallow:
`,
      robotsUrl,
    );

    expect(robots.groups[0]?.crawlDelaySeconds).toBeUndefined();
    expect(robots.crawlDelaySeconds).toBeUndefined();
    expect(robots.warnings).toEqual([
      "Ignored a Crawl-delay value that is not a positive number of seconds.",
      "Ignored a Request-rate value that is not written as requests per second or minute.",
    ]);
    expect(robotsCrawlDelaySeconds(robots, "AnyBot")).toBeUndefined();
  });

  it("does not apply a crawl delay when robots.txt is missing or unavailable", () => {
    const robots = parseRobotsText("User-agent: *\nCrawl-delay: 5\nDisallow:\n", robotsUrl);

    expect(
      robotsCrawlDelaySeconds({ ...robots, availability: { state: "missing" } }, "AnyBot"),
    ).toBeUndefined();
    expect(
      robotsCrawlDelaySeconds(
        { ...robots, availability: { state: "unavailable", reason: "timeout" } },
        "AnyBot",
      ),
    ).toBeUndefined();
    expect(robotsCrawlDelaySeconds(undefined, "AnyBot")).toBeUndefined();
  });
});
