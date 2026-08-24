import { performance } from "node:perf_hooks";

import { contentEvidenceFromText } from "./content.js";
import { emptyPageSignals, parseHtml } from "./html-parser.js";
import type { RenderedPageSnapshot } from "./types.js";
import { normalizeUrl, redactErrorText } from "./url.js";

export type { RenderedPageSnapshot } from "./types.js";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_SETTLE_MS = 250;
const DEFAULT_MAX_BYTES = 5_000_000;
const PLAYWRIGHT_INSTALL =
  "Install the optional renderer with `npm install --save-dev playwright` and " +
  "`npx playwright install chromium`.";

export interface RenderedCaptureOptions {
  readonly userAgent: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly settleMs?: number;
  readonly concurrency?: number;
  readonly maxBytes?: number;
}

/** Dependency seam for tests and embedders that provide their own compatible Playwright build. */
export interface RenderedCaptureDependencies {
  readonly loadPlaywright?: () => Promise<unknown>;
}

export class RenderedCaptureUnavailableError extends Error {
  readonly code = "PLAYWRIGHT_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RenderedCaptureUnavailableError";
  }
}

interface BrowserType {
  launch(options: { readonly headless: boolean; readonly timeout: number }): Promise<Browser>;
}

interface Browser {
  newContext(options: BrowserContextOptions): Promise<BrowserContext>;
  close(): Promise<void>;
}

interface BrowserContextOptions {
  readonly userAgent: string;
  readonly serviceWorkers: "block";
}

interface BrowserContext {
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

interface BrowserRoute {
  request(): BrowserRequest;
  continue(options?: { readonly headers?: Readonly<Record<string, string>> }): Promise<void>;
}

interface BrowserRequest {
  url(): string;
  headers(): Readonly<Record<string, string>>;
  allHeaders?: () => Promise<Readonly<Record<string, string>>>;
}

interface BrowserResponse {
  status(): number;
}

interface BrowserPage {
  goto(
    url: string,
    options: { readonly timeout: number; readonly waitUntil: "domcontentloaded" },
  ): Promise<BrowserResponse | null>;
  waitForTimeout(milliseconds: number): Promise<void>;
  url(): string;
  content(): Promise<string>;
  evaluate<Result>(expression: string): Promise<Result>;
  setDefaultTimeout(milliseconds: number): void;
  setDefaultNavigationTimeout(milliseconds: number): void;
  close(): Promise<void>;
}

/**
 * Render URLs with optional Playwright Chromium. Results retain evidence, not page contents.
 * Input order is preserved even when captures run concurrently.
 */
export async function captureRenderedPages(
  urls: readonly string[],
  options: RenderedCaptureOptions,
  dependencies: RenderedCaptureDependencies = {},
): Promise<readonly RenderedPageSnapshot[]> {
  const normalizedUrls = urls.map(validateUrl);
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  assertSafeInteger(options.timeoutMs, "timeoutMs", 1);
  assertSafeInteger(settleMs, "settleMs", 0);
  assertSafeInteger(concurrency, "concurrency", 1);
  assertSafeInteger(maxBytes, "maxBytes", 1);
  const headers = normalizeHeaders(options.headers);
  if (normalizedUrls.length === 0) return [];

  const browserType = await loadChromium(dependencies.loadPlaywright ?? loadPlaywright);
  let browser: Browser;
  try {
    browser = assertBrowser(
      await browserType.launch({ headless: true, timeout: options.timeoutMs }),
    );
  } catch (error) {
    throw unavailableError("Playwright Chromium could not start.", error);
  }

  try {
    return await mapWithConcurrency(normalizedUrls, concurrency, (url) =>
      captureWithBrowser(browser, url, {
        userAgent: options.userAgent,
        headers,
        timeoutMs: options.timeoutMs,
        settleMs,
        maxBytes,
      }),
    );
  } finally {
    await closeQuietly(browser);
  }
}

/** Render one URL without requiring callers to build a one-item batch. */
export async function captureRenderedPage(
  url: string,
  options: RenderedCaptureOptions,
  dependencies: RenderedCaptureDependencies = {},
): Promise<RenderedPageSnapshot> {
  const snapshots = await captureRenderedPages([url], options, dependencies);
  const snapshot = snapshots[0];
  if (snapshot === undefined) throw new Error("Rendered capture did not return a result.");
  return snapshot;
}

async function captureWithBrowser(
  browser: Browser,
  requestedUrl: string,
  options: {
    readonly userAgent: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly settleMs: number;
    readonly maxBytes: number;
  },
): Promise<RenderedPageSnapshot> {
  const startedAt = performance.now();
  const primaryOrigin = new URL(requestedUrl).origin;
  const secrets = Object.values(options.headers).filter(Boolean);
  let context: BrowserContext | undefined;
  let page: BrowserPage | undefined;
  let finalUrl = requestedUrl;
  let status: number | undefined;

  try {
    context = assertBrowserContext(
      await withRemainingTimeout(
        startedAt,
        options.timeoutMs,
        "Rendered browser context creation",
        () =>
          browser.newContext({
            userAgent: options.userAgent,
            serviceWorkers: "block",
          }),
      ),
    );
    await withRemainingTimeout(
      startedAt,
      options.timeoutMs,
      "Rendered request isolation setup",
      () =>
        context?.route("**/*", (route) =>
          injectSameOriginHeaders(route, primaryOrigin, options.headers),
        ) ?? Promise.reject(new Error("Rendered context closed during isolation setup.")),
    );
    page = assertBrowserPage(
      await withRemainingTimeout(
        startedAt,
        options.timeoutMs,
        "Rendered page creation",
        () =>
          context?.newPage() ?? Promise.reject(new Error("Rendered context closed before use.")),
      ),
    );
    page.setDefaultTimeout(options.timeoutMs);
    page.setDefaultNavigationTimeout(options.timeoutMs);

    let response: BrowserResponse | null;
    try {
      response = await withRemainingTimeout(
        startedAt,
        options.timeoutMs,
        "Rendered navigation",
        (remainingMs) =>
          page?.goto(requestedUrl, {
            timeout: remainingMs,
            waitUntil: "domcontentloaded",
          }) ?? Promise.reject(new Error("Rendered page closed before navigation.")),
      );
      finalUrl = safePageUrl(page, requestedUrl);
      status = response?.status();
    } catch (error) {
      finalUrl = safePageUrl(page, requestedUrl);
      return failedSnapshot(
        requestedUrl,
        finalUrl,
        startedAt,
        isTimeoutError(error) ? "timeout" : "navigation-error",
        sanitizeError(error, secrets),
      );
    }

    if (options.settleMs > 0) {
      await withRemainingTimeout(
        startedAt,
        options.timeoutMs,
        "Rendered settle period",
        () => page?.waitForTimeout(options.settleMs) ?? Promise.resolve(),
      );
    }
    const rawHtmlBytes = await withRemainingTimeout(
      startedAt,
      options.timeoutMs,
      "Rendered DOM size check",
      () =>
        page?.evaluate<unknown>(
          "(() => { const root = document.documentElement?.outerHTML ?? ''; " +
            "const doctype = document.doctype === null ? '' : " +
            "new XMLSerializer().serializeToString(document.doctype); " +
            "return new TextEncoder().encode(doctype + root).byteLength; })()",
        ) ?? Promise.reject(new Error("Rendered page closed before the DOM size check.")),
    );
    if (!Number.isSafeInteger(rawHtmlBytes) || (rawHtmlBytes as number) < 0) {
      throw new TypeError("The rendered page returned an invalid DOM byte size.");
    }
    const preflightHtmlBytes = rawHtmlBytes as number;
    if (preflightHtmlBytes > options.maxBytes) {
      return {
        ...failedSnapshot(
          requestedUrl,
          safePageUrl(page, finalUrl),
          startedAt,
          "capture-error",
          `Rendered DOM exceeded the ${options.maxBytes}-byte limit.`,
        ),
        ...(status === undefined ? {} : { status }),
        htmlBytes: preflightHtmlBytes,
      };
    }
    const [html, rawVisibleText] = await withRemainingTimeout(
      startedAt,
      options.timeoutMs,
      "Rendered DOM capture",
      () =>
        Promise.all([
          page?.content() ?? Promise.reject(new Error("Rendered page closed before capture.")),
          page?.evaluate<unknown>("document.body?.innerText ?? ''") ??
            Promise.reject(new Error("Rendered page closed before text capture.")),
        ]),
    );
    if (typeof rawVisibleText !== "string") {
      throw new TypeError("The rendered page returned non-text body evidence.");
    }
    finalUrl = safePageUrl(page, finalUrl);
    const htmlBytes = Buffer.byteLength(html);
    if (htmlBytes > options.maxBytes) {
      return {
        ...failedSnapshot(
          requestedUrl,
          finalUrl,
          startedAt,
          "capture-error",
          `Rendered DOM exceeded the ${options.maxBytes}-byte limit.`,
        ),
        ...(status === undefined ? {} : { status }),
        htmlBytes,
      };
    }
    const content = contentEvidenceFromText(rawVisibleText);

    return {
      requestedUrl,
      finalUrl,
      ...(status === undefined ? {} : { status }),
      completion: "complete",
      signals: parseHtml(html, finalUrl),
      htmlBytes,
      content,
      durationMs: roundedDuration(startedAt),
    };
  } catch (error) {
    return {
      ...failedSnapshot(
        requestedUrl,
        finalUrl,
        startedAt,
        isTimeoutError(error) ? "timeout" : "capture-error",
        sanitizeError(error, secrets),
      ),
      ...(status === undefined ? {} : { status }),
    };
  } finally {
    await closeQuietly(page);
    await closeQuietly(context);
  }
}

async function injectSameOriginHeaders(
  route: BrowserRoute,
  primaryOrigin: string,
  customHeaders: Readonly<Record<string, string>>,
): Promise<void> {
  const request = route.request();
  let sameOrigin = false;
  try {
    sameOrigin = new URL(request.url()).origin === primaryOrigin;
  } catch {
    // Treat malformed request URLs as untrusted destinations.
  }
  if (!sameOrigin || Object.keys(customHeaders).length === 0) {
    await route.continue();
    return;
  }

  const requestHeaders =
    request.allHeaders === undefined ? request.headers() : await request.allHeaders();
  const sameOriginHeaders = { ...requestHeaders };
  const customNames = new Set(Object.keys(customHeaders).map((name) => name.toLowerCase()));
  for (const name of Object.keys(sameOriginHeaders)) {
    if (customNames.has(name.toLowerCase())) delete sameOriginHeaders[name];
  }
  await route.continue({ headers: { ...sameOriginHeaders, ...customHeaders } });
}

async function withRemainingTimeout<Result>(
  startedAt: number,
  timeoutMs: number,
  operationName: string,
  operation: (remainingMs: number) => Promise<Result>,
): Promise<Result> {
  const remainingMs = Math.ceil(timeoutMs - (performance.now() - startedAt));
  if (remainingMs <= 0) throw timeoutError(operationName);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(remainingMs),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(timeoutError(operationName)), remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function timeoutError(operationName: string): Error {
  const error = new Error(`${operationName} exceeded the overall rendered capture timeout.`);
  error.name = "TimeoutError";
  return error;
}

async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  operation: (item: Item, index: number) => Promise<Result>,
): Promise<readonly Result[]> {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await operation(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function loadPlaywright(): Promise<unknown> {
  const packageName = "playwright";
  return import(packageName);
}

async function loadChromium(load: () => Promise<unknown>): Promise<BrowserType> {
  let moduleValue: unknown;
  try {
    moduleValue = await load();
  } catch (error) {
    throw unavailableError("The optional Playwright package is not available.", error);
  }

  const direct = getProperty(moduleValue, "chromium");
  const fromDefault = getProperty(getProperty(moduleValue, "default"), "chromium");
  const candidate = direct ?? fromDefault;
  if (!hasFunctions(candidate, ["launch"])) {
    throw unavailableError("The installed Playwright package does not expose Chromium.");
  }
  return candidate as BrowserType;
}

function assertBrowser(value: unknown): Browser {
  if (!hasFunctions(value, ["newContext", "close"])) {
    throw new TypeError("Playwright Chromium returned an invalid browser object.");
  }
  return value as Browser;
}

function assertBrowserContext(value: unknown): BrowserContext {
  if (!hasFunctions(value, ["route", "newPage", "close"])) {
    throw new TypeError("Playwright returned an invalid browser context.");
  }
  return value as BrowserContext;
}

function assertBrowserPage(value: unknown): BrowserPage {
  if (
    !hasFunctions(value, [
      "goto",
      "waitForTimeout",
      "url",
      "content",
      "evaluate",
      "setDefaultTimeout",
      "setDefaultNavigationTimeout",
      "close",
    ])
  ) {
    throw new TypeError("Playwright returned an invalid page object.");
  }
  return value as BrowserPage;
}

function getProperty(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

function hasFunctions(value: unknown, keys: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    keys.every((key) => typeof (value as Readonly<Record<string, unknown>>)[key] === "function")
  );
}

function validateUrl(input: string): string {
  const normalized = normalizeUrl(input, input, "keep");
  if (normalized === undefined) {
    throw new TypeError(
      "Rendered page URLs must be absolute HTTP(S) URLs without embedded credentials.",
    );
  }
  return normalized;
}

function normalizeHeaders(
  input: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input ?? {})) {
    try {
      headers.set(name, value);
    } catch (error) {
      throw new TypeError(`Invalid rendered request header name: ${name}.`, { cause: error });
    }
  }
  return Object.fromEntries(headers.entries());
}

function failedSnapshot(
  requestedUrl: string,
  finalUrl: string,
  startedAt: number,
  completion: Exclude<RenderedPageSnapshot["completion"], "complete">,
  error: string,
): RenderedPageSnapshot {
  return {
    requestedUrl,
    finalUrl,
    completion,
    signals: emptyPageSignals(),
    htmlBytes: 0,
    durationMs: roundedDuration(startedAt),
    error,
  };
}

function safePageUrl(page: BrowserPage, fallback: string): string {
  try {
    return normalizeUrl(page.url(), fallback, "keep") ?? fallback;
  } catch {
    return fallback;
  }
}

function roundedDuration(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || /timed?\s*out|timeout/i.test(error.message);
}

function sanitizeError(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactErrorText(message, secrets);
}

function unavailableError(message: string, cause?: unknown): RenderedCaptureUnavailableError {
  const detail = cause instanceof Error ? ` ${redactErrorText(cause.message)}` : "";
  return new RenderedCaptureUnavailableError(`${message} ${PLAYWRIGHT_INSTALL}${detail}`, {
    cause,
  });
}

async function closeQuietly(resource: { close(): Promise<void> } | undefined): Promise<void> {
  try {
    await resource?.close();
  } catch {
    // Cleanup errors must not hide the capture result or the original failure.
  }
}

function assertSafeInteger(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
}
