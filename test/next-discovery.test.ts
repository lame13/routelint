import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverNextBuild } from "../src/discovery/next.js";

const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "next-discovery-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".next", "server"), { recursive: true });
  return root;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value), "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Next.js build discovery", () => {
  it("combines known manifests, samples dynamic routes, and inventories redirects", async () => {
    const root = await temporaryProject();
    const build = path.join(root, ".next");
    await writeJson(path.join(build, "routes-manifest.json"), {
      staticRoutes: [{ page: "/" }, { page: "/account" }],
      dynamicRoutes: [{ page: "/blog/[slug]" }],
      redirects: [
        { source: "/old", destination: "/new", permanent: true },
        { source: "/temp", destination: "/later", statusCode: 302 },
        {
          source: "/member",
          destination: "/account",
          statusCode: 307,
          has: [{ type: "header", key: "x-member" }],
        },
      ],
    });
    await writeJson(path.join(build, "prerender-manifest.json"), {
      routes: {
        "/": { initialRevalidateSeconds: false },
        "/about": { initialRevalidateSeconds: false },
        "/news/first": { initialRevalidateSeconds: 60, srcRoute: "/news/[slug]" },
      },
      dynamicRoutes: {
        "/news/[slug]": {},
      },
    });
    await writeJson(path.join(build, "server", "app-paths-manifest.json"), {
      "/(marketing)/about/page": "app/(marketing)/about/page.js",
      "/(v1.2)/versioned/page": "app/(v1.2)/versioned/page.js",
      "/shop/[id]/page": "app/shop/[id]/page.js",
      "/robots.txt/route": "app/robots.txt/route.js",
      "/sitemap.xml/route": "app/sitemap.xml/route.js",
      "/api/revalidate/route": "app/api/revalidate/route.js",
      "/feed.xml/route": "app/feed.xml/route.js",
      "/@modal/(.)photo/[id]/page": "app/@modal/(.)photo/[id]/page.js",
    });
    await writeJson(path.join(build, "server", "pages-manifest.json"), {
      "/_app": "pages/_app.js",
      "/legacy": "pages/legacy.js",
      "/blog/[slug]": "pages/blog/[slug].js",
      "/api/legacy": "pages/api/legacy.js",
      "/api/[action]": "pages/api/[action].js",
    });
    await writeFile(path.join(build, "BUILD_ID"), "build-123\n", "utf8");
    await mkdir(path.join(build, "diagnostics"), { recursive: true });
    await writeJson(path.join(build, "diagnostics", "framework.json"), {
      name: "Next.js",
      version: "16.2.2",
    });
    await mkdir(path.join(root, "node_modules", "next"), { recursive: true });
    await writeJson(path.join(root, "node_modules", "next", "package.json"), { version: "16.2.1" });

    const inventory = await discoverNextBuild({
      root,
      buildDirectory: ".next",
      samples: {
        "/blog/[slug]": ["hello world", "/blog/second", "/not-a-blog"],
        "/news/[slug]": ["/news/two"],
      },
    });

    expect(inventory.buildId).toBe("build-123");
    expect(inventory.nextVersion).toBe("16.2.2");
    expect(inventory.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pathname: "/", renderMode: "static" }),
        expect.objectContaining({ pathname: "/about", renderMode: "static" }),
        expect.objectContaining({ pathname: "/account", renderMode: "dynamic" }),
        expect.objectContaining({ pathname: "/legacy", renderMode: "dynamic" }),
        expect.objectContaining({ pathname: "/robots.txt", renderMode: "dynamic" }),
        expect.objectContaining({ pathname: "/sitemap.xml", renderMode: "dynamic" }),
        expect.objectContaining({ pathname: "/versioned", renderMode: "dynamic" }),
        expect.objectContaining({
          pathname: "/news/first",
          pattern: "/news/[slug]",
          renderMode: "isr",
          revalidateSeconds: 60,
        }),
        expect.objectContaining({ pathname: "/blog/hello%20world", pattern: "/blog/[slug]" }),
        expect.objectContaining({ pathname: "/blog/second", pattern: "/blog/[slug]" }),
        expect.objectContaining({ pathname: "/news/two", pattern: "/news/[slug]" }),
      ]),
    );
    expect(inventory.routes.some((route) => route.pathname === "/not-a-blog")).toBe(false);
    expect(inventory.routes.some((route) => route.pathname.startsWith("/api"))).toBe(false);
    expect(inventory.routes.some((route) => route.pathname === "/feed.xml")).toBe(false);
    expect(inventory.unresolvedPatterns).toEqual(["/photo/[id]", "/shop/[id]"]);
    expect(inventory.redirects).toEqual([
      { source: "/member", destination: "/account", status: 307, conditional: true },
      { source: "/old", destination: "/new", status: 308 },
      { source: "/temp", destination: "/later", status: 302 },
    ]);
    expect(inventory.warnings.some((warning) => warning.includes("does not match"))).toBe(true);
  });

  it("reports missing manifests and does not invent routes", async () => {
    const root = await temporaryProject();
    const inventory = await discoverNextBuild({
      root,
      buildDirectory: ".next",
      samples: { "/unknown/[id]": ["one"] },
    });

    expect(inventory.routes).toEqual([]);
    expect(inventory.unresolvedPatterns).toEqual([]);
    expect(inventory.warnings.some((warning) => warning.includes("No supported"))).toBe(true);
    expect(inventory.warnings.some((warning) => warning.includes("unknown dynamic"))).toBe(true);
  });

  it("applies the configured basePath and does not mislabel partial prerendering as static", async () => {
    const root = await temporaryProject();
    const build = path.join(root, ".next");
    await writeJson(path.join(build, "routes-manifest.json"), {
      basePath: "/docs",
      staticRoutes: [{ page: "/" }, { page: "/about" }],
      dynamicRoutes: [{ page: "/guides/[slug]" }],
      redirects: [],
    });
    await writeJson(path.join(build, "prerender-manifest.json"), {
      routes: {
        "/": {
          initialRevalidateSeconds: false,
          renderingMode: "PARTIALLY_STATIC",
          experimentalPPR: true,
        },
        "/about": { initialRevalidateSeconds: false, renderingMode: "STATIC" },
      },
      dynamicRoutes: {},
    });
    await writeJson(path.join(build, "app-path-routes-manifest.json"), {
      "/@modal/(.)photo/[id]/page": "/gallery/[id]",
      "/api/cache/route": "/api/cache",
      "/manifest.webmanifest/route": "/manifest.webmanifest",
      "/page/page": "/page",
      "/route/page": "/route",
    });

    const inventory = await discoverNextBuild({
      root,
      buildDirectory: ".next",
      samples: {
        "/guides/[slug]": ["/docs/guides/start"],
        "/gallery/[id]": ["one"],
      },
    });

    expect(inventory.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pathname: "/docs", renderMode: "unknown" }),
        expect.objectContaining({ pathname: "/docs/about", renderMode: "static" }),
        expect.objectContaining({ pathname: "/docs/manifest.webmanifest", renderMode: "dynamic" }),
        expect.objectContaining({ pathname: "/docs/page", renderMode: "dynamic" }),
        expect.objectContaining({ pathname: "/docs/route", renderMode: "dynamic" }),
        expect.objectContaining({
          pathname: "/docs/guides/start",
          pattern: "/docs/guides/[slug]",
        }),
        expect.objectContaining({
          pathname: "/docs/gallery/one",
          pattern: "/docs/gallery/[id]",
        }),
      ]),
    );
    expect(inventory.unresolvedPatterns).toEqual([]);
    expect(inventory.routes.some((route) => route.pathname === "/docs/api/cache")).toBe(false);
    expect(inventory.warnings.some((warning) => warning.includes("Partial prerendering"))).toBe(
      true,
    );
  });
});
