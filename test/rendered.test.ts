import { describe, expect, it } from "vitest";

import {
  captureRenderedPage,
  captureRenderedPages,
  RenderedCaptureUnavailableError,
} from "../src/rendered.js";

interface RecordedRequest {
  readonly url: string;
  readonly continuedHeaders?: Readonly<Record<string, string>>;
}

interface FakeState {
  activeNavigations: number;
  maxActiveNavigations: number;
  browserCloses: number;
  contextCloses: number;
  pageCloses: number;
  contentCalls: number;
  readonly evaluateExpressions: string[];
  readonly contextOptions: Array<{
    readonly userAgent: string;
    readonly serviceWorkers: "block";
  }>;
  readonly requests: RecordedRequest[];
}

interface FakeOptions {
  readonly navigate?: (url: string, index: number) => Promise<void>;
  readonly html?: (url: string) => string;
  readonly content?: (url: string) => Promise<string>;
  readonly serializedBytes?: (url: string) => number | Promise<number>;
  readonly visibleText?: (url: string) => string | Promise<string>;
  readonly finalUrl?: (url: string) => string;
}

interface FakeRoute {
  request(): {
    url(): string;
    headers(): Readonly<Record<string, string>>;
    allHeaders(): Promise<Readonly<Record<string, string>>>;
  };
  continue(options?: { readonly headers?: Readonly<Record<string, string>> }): Promise<void>;
}

type FakeRouteHandler = (route: FakeRoute) => Promise<void>;

function fakePlaywright(options: FakeOptions = {}): {
  readonly module: unknown;
  readonly state: FakeState;
} {
  const state: FakeState = {
    activeNavigations: 0,
    maxActiveNavigations: 0,
    browserCloses: 0,
    contextCloses: 0,
    pageCloses: 0,
    contentCalls: 0,
    evaluateExpressions: [],
    contextOptions: [],
    requests: [],
  };

  const htmlFor = (url: string): string =>
    options.html?.(url) ??
    "<!doctype html><html><head><title>Hydrated title</title>" +
      '<meta name="description" content="Hydrated description"></head>' +
      "<body><h1>Hydrated heading</h1></body></html>";

  const module = {
    chromium: {
      launch: async (_options: { readonly headless: boolean }) => ({
        newContext: async (contextOptions: {
          readonly userAgent: string;
          readonly serviceWorkers: "block";
        }) => {
          state.contextOptions.push(contextOptions);
          let handler: FakeRouteHandler | undefined;
          let currentUrl = "about:blank";
          const pageIndex = state.contextOptions.length - 1;
          return {
            route: async (_pattern: string, nextHandler: FakeRouteHandler) => {
              handler = nextHandler;
            },
            newPage: async () => ({
              goto: async (url: string) => {
                currentUrl = options.finalUrl?.(url) ?? url;
                state.activeNavigations += 1;
                state.maxActiveNavigations = Math.max(
                  state.maxActiveNavigations,
                  state.activeNavigations,
                );
                try {
                  await options.navigate?.(url, pageIndex);
                  if (handler !== undefined) {
                    const suppliedHeaders = { accept: "text/html" };
                    await handler(
                      fakeRoute(`${new URL(url).origin}/app.js`, suppliedHeaders, state),
                    );
                    await handler(
                      fakeRoute("https://assets.example-cdn.test/app.js", suppliedHeaders, state),
                    );
                  }
                  return { status: () => 200 };
                } finally {
                  state.activeNavigations -= 1;
                }
              },
              waitForTimeout: async (_milliseconds: number) => {},
              url: () => currentUrl,
              content: async () => {
                state.contentCalls += 1;
                return options.content?.(currentUrl) ?? htmlFor(currentUrl);
              },
              evaluate: async (expression: string) => {
                state.evaluateExpressions.push(expression);
                if (expression.includes("TextEncoder")) {
                  return (
                    options.serializedBytes?.(currentUrl) ?? Buffer.byteLength(htmlFor(currentUrl))
                  );
                }
                return options.visibleText?.(currentUrl) ?? "Hydrated heading Useful rendered body";
              },
              setDefaultTimeout: (_milliseconds: number) => {},
              setDefaultNavigationTimeout: (_milliseconds: number) => {},
              close: async () => {
                state.pageCloses += 1;
              },
            }),
            close: async () => {
              state.contextCloses += 1;
            },
          };
        },
        close: async () => {
          state.browserCloses += 1;
        },
      }),
    },
  };

  return { module, state };
}

function fakeRoute(
  url: string,
  headers: Readonly<Record<string, string>>,
  state: FakeState,
): FakeRoute {
  return {
    request: () => ({
      url: () => url,
      headers: () => headers,
      allHeaders: async () => headers,
    }),
    continue: async (options) => {
      state.requests.push({
        url,
        ...(options?.headers === undefined ? {} : { continuedHeaders: options.headers }),
      });
    },
  };
}

const baseOptions = {
  userAgent: "RouteLint rendered test",
  timeoutMs: 2_000,
  settleMs: 0,
} as const;

describe("rendered page capture", () => {
  it("captures hydrated metadata and hashed text evidence without retaining page contents", async () => {
    const fake = fakePlaywright({
      finalUrl: () => "https://example.test/final",
      visibleText: () => "  Rendered\n body   words  ",
    });

    const snapshot = await captureRenderedPage("https://example.test/start", baseOptions, {
      loadPlaywright: async () => fake.module,
    });

    expect(snapshot).toMatchObject({
      requestedUrl: "https://example.test/start",
      finalUrl: "https://example.test/final",
      status: 200,
      completion: "complete",
      content: { characters: 19, words: 3 },
    });
    expect(snapshot.signals.titles[0]?.value).toBe("Hydrated title");
    expect(snapshot.signals.descriptions[0]?.value).toBe("Hydrated description");
    expect(snapshot.signals.h1s[0]?.value).toBe("Hydrated heading");
    expect(snapshot.content?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.content?.simhash).toMatch(/^[a-f0-9]{16}$/);
    expect(snapshot).not.toHaveProperty("html");
    expect(snapshot).not.toHaveProperty("text");
    expect(fake.state).toMatchObject({ browserCloses: 1, contextCloses: 1, pageCloses: 1 });
  });

  it("keeps custom headers on the primary origin and removes them from external requests", async () => {
    const fake = fakePlaywright();
    await captureRenderedPage(
      "https://example.test/",
      {
        ...baseOptions,
        headers: {
          Authorization: "Bearer private",
          "X-Preview-Key": "preview-secret",
        },
      },
      { loadPlaywright: async () => fake.module },
    );

    expect(fake.state.contextOptions[0]).toEqual({
      userAgent: "RouteLint rendered test",
      serviceWorkers: "block",
    });
    expect(fake.state.contextOptions[0]).not.toHaveProperty("extraHTTPHeaders");
    expect(fake.state.requests[0]).toEqual({
      url: "https://example.test/app.js",
      continuedHeaders: {
        accept: "text/html",
        authorization: "Bearer private",
        "x-preview-key": "preview-secret",
      },
    });
    expect(fake.state.requests[1]).toEqual({
      url: "https://assets.example-cdn.test/app.js",
    });
  });

  it("bounds parallel pages and preserves input order", async () => {
    const fake = fakePlaywright({
      navigate: async (_url, index) => {
        await new Promise((resolve) => setTimeout(resolve, 15 - index));
      },
    });
    const urls = Array.from({ length: 5 }, (_, index) => `https://example.test/${index}`);

    const snapshots = await captureRenderedPages(
      urls,
      { ...baseOptions, concurrency: 2 },
      { loadPlaywright: async () => fake.module },
    );

    expect(snapshots.map((snapshot) => snapshot.requestedUrl)).toEqual(urls);
    expect(fake.state.maxActiveNavigations).toBe(2);
    expect(fake.state.pageCloses).toBe(5);
    expect(fake.state.contextCloses).toBe(5);
    expect(fake.state.browserCloses).toBe(1);
  });

  it("returns a redacted timeout result and still closes every resource", async () => {
    const fake = fakePlaywright({
      navigate: async (url) => {
        const error = new Error(`Timed out at ${url} using Bearer private`);
        error.name = "TimeoutError";
        throw error;
      },
    });

    const snapshot = await captureRenderedPage(
      "https://example.test/slow?token=url-secret",
      { ...baseOptions, headers: { authorization: "Bearer private" } },
      { loadPlaywright: async () => fake.module },
    );

    expect(snapshot.completion).toBe("timeout");
    expect(snapshot.error).toContain("[redacted]");
    expect(snapshot.error).not.toContain("url-secret");
    expect(snapshot.error).not.toContain("Bearer private");
    expect(fake.state).toMatchObject({ browserCloses: 1, contextCloses: 1, pageCloses: 1 });
  });

  it("bounds serialized DOM evidence before parsing it", async () => {
    const fake = fakePlaywright({ html: () => `<body>${"x".repeat(200)}</body>` });

    const snapshot = await captureRenderedPage(
      "https://example.test/large",
      { ...baseOptions, maxBytes: 50 },
      { loadPlaywright: async () => fake.module },
    );

    expect(snapshot).toMatchObject({
      completion: "capture-error",
      htmlBytes: 213,
      error: "Rendered DOM exceeded the 50-byte limit.",
    });
    expect(fake.state.contentCalls).toBe(0);
    expect(fake.state.evaluateExpressions).toHaveLength(1);
  });

  it("bounds DOM capture work by the remaining overall timeout", async () => {
    const fake = fakePlaywright({
      content: async () => new Promise<string>(() => {}),
    });

    const startedAt = performance.now();
    const snapshot = await captureRenderedPage(
      "https://example.test/hanging-content",
      { ...baseOptions, timeoutMs: 25 },
      { loadPlaywright: async () => fake.module },
    );

    expect(snapshot.completion).toBe("timeout");
    expect(snapshot.error).toContain("overall rendered capture timeout");
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(fake.state.contentCalls).toBe(1);
    expect(fake.state).toMatchObject({ browserCloses: 1, contextCloses: 1, pageCloses: 1 });
  });

  it("bounds the browser-side DOM size preflight and skips content retrieval", async () => {
    const fake = fakePlaywright({
      serializedBytes: async () => new Promise<number>(() => {}),
    });

    const snapshot = await captureRenderedPage(
      "https://example.test/hanging-size-check",
      { ...baseOptions, timeoutMs: 25 },
      { loadPlaywright: async () => fake.module },
    );

    expect(snapshot.completion).toBe("timeout");
    expect(snapshot.error).toContain("DOM size check");
    expect(fake.state.contentCalls).toBe(0);
  });

  it("fails clearly when Playwright or its Chromium executable is unavailable", async () => {
    await expect(
      captureRenderedPage("https://example.test/", baseOptions, {
        loadPlaywright: async () => {
          throw new Error("Cannot find package 'playwright'");
        },
      }),
    ).rejects.toThrow(RenderedCaptureUnavailableError);
    await expect(
      captureRenderedPage("https://example.test/", baseOptions, {
        loadPlaywright: async () => ({
          chromium: {
            launch: async () => {
              throw new Error("Executable does not exist");
            },
          },
        }),
      }),
    ).rejects.toThrow("npx playwright install chromium");
  });

  it("validates URLs and limits before loading the optional dependency", async () => {
    let loads = 0;
    const dependencies = {
      loadPlaywright: async () => {
        loads += 1;
        return {};
      },
    };

    await expect(
      captureRenderedPages(["file:///private"], baseOptions, dependencies),
    ).rejects.toThrow("absolute HTTP(S)");
    await expect(
      captureRenderedPages(
        ["https://example.test/"],
        { ...baseOptions, concurrency: 0 },
        dependencies,
      ),
    ).rejects.toThrow("concurrency must be a safe integer");
    await expect(
      captureRenderedPages(
        ["https://example.test/"],
        { ...baseOptions, maxBytes: 0 },
        dependencies,
      ),
    ).rejects.toThrow("maxBytes must be a safe integer");
    expect(loads).toBe(0);
  });
});
