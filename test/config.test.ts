import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG_YAML, loadConfig, parseHeaderOptions } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "routelint-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("loadConfig", () => {
  it("builds safe, documented defaults from only a base URL", async () => {
    const config = await loadConfig({
      cwd: await temporaryDirectory(),
      overrides: { baseUrl: "https://EXAMPLE.test:443/docs#fragment" },
    });

    expect(config).toMatchObject({
      baseUrl: "https://example.test/docs",
      seeds: ["https://example.test/docs"],
      sitemaps: "auto",
      headers: {},
      redirects: [],
      include: [],
      exclude: [],
      queryPolicy: "drop",
      respectRobots: true,
      limits: {
        maxPages: 250,
        maxDepth: 8,
        concurrency: 6,
        timeoutMs: 15_000,
        maxBytes: 2_000_000,
        maxRedirects: 5,
      },
      audit: {
        requireTitle: true,
        requireDescription: true,
        requireCanonical: true,
        requireH1: true,
        requireSitemapCoverage: true,
        maxDepth: 4,
      },
    });
    expect(config.agents.map((agent) => agent.key)).toEqual(["routelint"]);
    expect(config.next).toBeUndefined();
  });

  it("discovers YAML, resolves paths relative to it, and applies CLI overrides last", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "routelint.config.yml");
    await writeFile(
      configPath,
      `baseUrl: https://configured.test/base/
seeds: [/, relative]
sitemaps: [/configured-sitemap.xml]
agents: [googlebot]
headers:
  X-Configured: from-file
redirects:
  - from: /old-pricing
    to: /pricing
    status: 301
include: [/docs/**]
exclude: [/docs/private/**]
queryPolicy: keep
respectRobots: false
limits:
  maxPages: 90
  maxDepth: 7
  concurrency: 3
  timeoutMs: 9000
  maxBytes: 900000
  maxRedirects: 2
audit:
  requireTitle: false
  maxDepth: 2
next:
  root: ./site
  buildDirectory: output
  samples:
    /blog/[slug]: [/blog/example]
`,
      "utf8",
    );

    const config = await loadConfig({
      cwd: directory,
      overrides: {
        baseUrl: "https://live.test/app",
        maxPages: 12,
        concurrency: 4,
        agents: ["browser", "My Audit Bot/1.0"],
        headers: { "x-command": "from-cli" },
        sitemaps: ["/live.xml"],
        include: ["/public/**"],
        queryPolicy: "drop",
        respectRobots: true,
        buildDirectory: ".output",
      },
    });

    expect(config.baseUrl).toBe("https://live.test/app");
    expect(config.seeds).toEqual(["https://live.test/", "https://live.test/base/relative"]);
    expect(config.sitemaps).toEqual(["https://live.test/live.xml"]);
    expect(config.agents.map((agent) => agent.key)).toEqual(["browser", "custom-my-audit-bot-1-0"]);
    expect(config.headers).toEqual({ "x-command": "from-cli", "x-configured": "from-file" });
    expect(config.redirects).toEqual([
      {
        from: "https://live.test/old-pricing",
        to: "https://live.test/pricing",
        status: 301,
        maxHops: 1,
      },
    ]);
    expect(config.include).toEqual(["/public/**"]);
    expect(config.exclude).toEqual(["/docs/private/**"]);
    expect(config.queryPolicy).toBe("drop");
    expect(config.respectRobots).toBe(true);
    expect(config.limits).toMatchObject({ maxPages: 12, maxDepth: 7, concurrency: 4 });
    expect(config.audit).toMatchObject({ requireTitle: false, maxDepth: 2 });
    expect(config.next).toEqual({
      root: resolve(directory, "site"),
      buildDirectory: ".output",
      samples: { "/blog/[slug]": ["/blog/example"] },
    });
  });

  it("enables Next.js discovery without replacing a configured project root", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "routelint.config.yml"),
      `baseUrl: https://example.test
next:
  root: ./configured-site
  buildDirectory: output
`,
      "utf8",
    );

    const configured = await loadConfig({ cwd: directory, overrides: { enableNext: true } });
    const implicitDirectory = await temporaryDirectory();
    const implicit = await loadConfig({
      cwd: implicitDirectory,
      overrides: { baseUrl: "https://example.test", enableNext: true },
    });

    expect(configured.next).toEqual({
      root: resolve(directory, "configured-site"),
      buildDirectory: "output",
      samples: {},
    });
    expect(implicit.next).toEqual({
      root: implicitDirectory,
      buildDirectory: ".next",
      samples: {},
    });
  });

  it("expands whole-value environment header placeholders without interpolating partial text", async () => {
    const directory = await temporaryDirectory();
    vi.stubEnv("ROUTELINT_PREVIEW_TOKEN", "Bearer very-secret");
    await writeFile(
      join(directory, "routelint.config.json"),
      JSON.stringify({
        baseUrl: "https://example.test",
        headers: {
          Authorization: "$" + "{ROUTELINT_PREVIEW_TOKEN}",
          "X-Literal": "prefix-$" + "{ROUTELINT_PREVIEW_TOKEN}",
        },
      }),
      "utf8",
    );

    const config = await loadConfig({ cwd: directory });

    expect(config.headers).toEqual({
      authorization: "Bearer very-secret",
      "x-literal": "prefix-$" + "{ROUTELINT_PREVIEW_TOKEN}",
    });
  });

  it("loads URL files, rendered capture limits, and path-scoped rule overrides", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "routelint.config.yml"),
      `baseUrl: https://example.test
urls: [targets.txt]
rendered:
  enabled: true
  concurrency: 3
  timeoutMs: 12000
  settleMs: 0
audit:
  severities:
    noindex: off
  paths:
    - include: [/docs/**]
      exclude: [/docs/archive/**]
      requireDescription: false
      maxDepth: 6
      severities:
        missing-h1: info
`,
      "utf8",
    );

    const config = await loadConfig({ cwd: directory });

    expect(config.urlFiles).toEqual([resolve(directory, "targets.txt")]);
    expect(config.rendered).toEqual({
      enabled: true,
      concurrency: 3,
      timeoutMs: 12_000,
      settleMs: 0,
    });
    expect(config.audit.severities).toEqual({ noindex: "off" });
    expect(config.audit.paths).toEqual([
      {
        include: ["/docs/**"],
        exclude: ["/docs/archive/**"],
        requireDescription: false,
        maxDepth: 6,
        severities: { "missing-h1": "info" },
      },
    ]);
  });

  it("fails closed when an environment-backed header is missing", async () => {
    const directory = await temporaryDirectory();
    vi.stubEnv("ROUTELINT_MISSING_TOKEN", undefined);
    await writeFile(
      join(directory, "routelint.config.yml"),
      `baseUrl: https://example.test
headers:
  Authorization: \${ROUTELINT_MISSING_TOKEN}
`,
      "utf8",
    );

    await expect(loadConfig({ cwd: directory })).rejects.toThrow(
      "environment variable that is not set: ROUTELINT_MISSING_TOKEN",
    );
  });

  it("rejects redirect contracts that are ambiguous, off-origin, or impossible to capture", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "routelint.config.yml");

    await writeFile(
      configPath,
      `baseUrl: https://example.test
redirects:
  - from: /old?campaign=one
    to: /new
    status: 301
`,
      "utf8",
    );
    await expect(loadConfig({ cwd: directory })).rejects.toThrow("cannot include query strings");

    await writeFile(
      configPath,
      `baseUrl: https://example.test
redirects:
  - from: /old
    to: https://outside.test/new
    status: 301
`,
      "utf8",
    );
    await expect(loadConfig({ cwd: directory })).rejects.toThrow("configured origin");

    await writeFile(
      configPath,
      `baseUrl: https://example.test
limits:
  maxRedirects: 1
redirects:
  - from: /old
    to: /new
    status: 301
    maxHops: 2
`,
      "utf8",
    );
    await expect(loadConfig({ cwd: directory })).rejects.toThrow(
      "maxHops cannot exceed limits.maxRedirects",
    );
  });

  it.each([
    ["a missing base URL", {}, "A base URL is required"],
    ["a non-HTTP URL", { baseUrl: "file:///tmp/site" }, "must use HTTP(S)"],
    [
      "credentials in the base URL",
      { baseUrl: "https://admin:secret@example.test" },
      "cannot include credentials",
    ],
  ])("rejects %s", async (_label, overrides, message) => {
    await expect(loadConfig({ cwd: await temporaryDirectory(), overrides })).rejects.toThrow(
      message,
    );
  });

  it("reports strict schema errors and malformed config files with actionable context", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "custom.yml");
    await writeFile(
      path,
      `baseUrl: https://example.test
limits:
  maxPages: 0
unknownSetting: true
`,
      "utf8",
    );

    await expect(loadConfig({ cwd: directory, configPath: "custom.yml" })).rejects.toThrow(
      /^Invalid config:/,
    );
    await writeFile(path, "baseUrl: [unterminated", "utf8");
    await expect(loadConfig({ cwd: directory, configPath: path })).rejects.toThrow(
      `Could not parse config file: ${path}`,
    );
  });

  it("honors requireConfig instead of silently inventing configuration", async () => {
    const directory = await temporaryDirectory();

    await expect(loadConfig({ cwd: directory, requireConfig: true })).rejects.toThrow(
      `No RouteLint config found in ${directory}`,
    );
  });
});

describe("parseHeaderOptions", () => {
  it("parses values containing colons and lets the last exact-name option win", () => {
    expect(
      parseHeaderOptions([
        "Authorization: Bearer one:two",
        "X-Preview: first",
        "X-Preview: second",
      ]),
    ).toEqual({ Authorization: "Bearer one:two", "X-Preview": "second" });
  });

  it.each(["missing-separator", ": value", "X-Empty:"])(
    "rejects malformed header option %s",
    (value) => {
      expect(() => parseHeaderOptions([value])).toThrow();
    },
  );
});

describe("DEFAULT_CONFIG_YAML", () => {
  it("remains loadable as the starter configuration", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "routelint.config.yml"), DEFAULT_CONFIG_YAML, "utf8");

    const config = await loadConfig({ cwd: directory });

    expect(config.baseUrl).toBe("https://example.com/");
    expect(config.next?.root).toBe(directory);
    expect(config.next?.samples["/blog/[slug]"]).toEqual(["/blog/hello-world"]);
  });
});
