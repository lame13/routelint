import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { emptyPageSignals, parseHtml, parseXRobotsTag } from "./html-parser.js";
import type { AgentProfile, PageSnapshot, RedirectHop } from "./types.js";
import { normalizeUrl, redactErrorText, redactUrlReference } from "./url.js";

const REDACTED_HEADER = "[redacted]";
const SENSITIVE_HEADER =
  /(?:^|[-_])(?:authorization|cookie|credential|api[-_]?key|secret|session|token)(?:$|[-_])/i;
const URL_VALUE_HEADER = /^(?:content-location|link|location|refresh)$/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface CapturePageOptions {
  readonly agent: AgentProfile;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
}

interface BodyReadResult {
  readonly bytes: Uint8Array;
  readonly bytesRead: number;
  readonly sha256: string;
  readonly exceeded: boolean;
}

/** Capture the exact response body delivered to one user-agent without running client JavaScript. */
export async function capturePage(
  requestedUrl: string,
  options: CapturePageOptions,
): Promise<PageSnapshot> {
  assertSafeInteger(options.timeoutMs, "timeoutMs", 1);
  assertSafeInteger(options.maxBytes, "maxBytes", 0);
  assertSafeInteger(options.maxRedirects, "maxRedirects", 0);
  const startedAt = performance.now();
  const redirects: RedirectHop[] = [];
  const secrets = Object.values(options.headers ?? {}).filter((value) => value.length > 0);
  const normalizedRequest = normalizeUrl(requestedUrl, requestedUrl, "keep");
  if (normalizedRequest === undefined) {
    return failedSnapshot(
      requestedUrl,
      requestedUrl,
      options.agent,
      redirects,
      startedAt,
      "invalid-response",
      "The requested URL must be an absolute HTTP(S) URL without credentials.",
    );
  }

  const headerOrigin = new URL(normalizedRequest).origin;
  let currentUrl = normalizedRequest;
  let currentResponse: Response | undefined;
  let timedOut = false;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  try {
    for (;;) {
      const hopStartedAt = performance.now();
      const requestHeaders = new Headers();
      if (new URL(currentUrl).origin === headerOrigin) {
        for (const [name, value] of Object.entries(options.headers ?? {})) {
          requestHeaders.set(name, value);
        }
      }
      requestHeaders.set("user-agent", options.agent.userAgent);
      requestHeaders.set("accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1");

      currentResponse = undefined;
      currentResponse = await fetch(currentUrl, {
        method: "GET",
        headers: requestHeaders,
        redirect: "manual",
        signal: controller.signal,
      });

      if (!REDIRECT_STATUSES.has(currentResponse.status)) break;
      const rawLocation = currentResponse.headers.get("location");
      const nextUrl =
        rawLocation === null ? undefined : normalizeUrl(rawLocation, currentUrl, "keep");
      if (rawLocation === null || nextUrl === undefined) {
        await cancelBody(currentResponse);
        return responseFailure(
          normalizedRequest,
          currentUrl,
          options.agent,
          currentResponse,
          redirects,
          startedAt,
          "invalid-response",
          rawLocation === null
            ? `Redirect response ${currentResponse.status} did not include a Location header.`
            : `Redirect response ${currentResponse.status} included an invalid Location header.`,
          secrets,
        );
      }

      redirects.push({
        url: redactUrlReference(currentUrl),
        status: currentResponse.status,
        location: redactUrlReference(nextUrl),
        durationMs: roundedDuration(hopStartedAt),
      });
      await cancelBody(currentResponse);
      if (redirects.length > options.maxRedirects) {
        return responseFailure(
          normalizedRequest,
          currentUrl,
          options.agent,
          currentResponse,
          redirects,
          startedAt,
          "invalid-response",
          `Redirect limit exceeded after ${redirects.length} response${redirects.length === 1 ? "" : "s"}.`,
          secrets,
        );
      }
      currentUrl = nextUrl;
    }

    const body = await readBody(currentResponse, options.maxBytes, controller.signal);
    const contentType = currentResponse.headers.get("content-type") ?? undefined;
    let signals = emptyPageSignals();
    if (contentType !== undefined && isHtmlContentType(contentType)) {
      const html = decodeBody(body.bytes, contentType);
      signals = parseHtml(html, currentUrl);
    }
    const headerRobots = parseXRobotsTag(currentResponse.headers.get("x-robots-tag"));
    if (headerRobots.length > 0)
      signals = { ...signals, robots: [...signals.robots, ...headerRobots] };

    return {
      requestedUrl: normalizedRequest,
      finalUrl: currentUrl,
      agent: options.agent,
      status: currentResponse.status,
      ...(contentType === undefined ? {} : { contentType }),
      headers: sanitizeResponseHeaders(currentResponse.headers),
      redirects,
      signals,
      bytesRead: body.bytesRead,
      bodySha256: body.sha256,
      durationMs: roundedDuration(startedAt),
      completion: body.exceeded ? "max-bytes-exceeded" : "complete",
    };
  } catch (error) {
    const completion = timedOut ? "timeout" : "network-error";
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = timedOut
      ? `Request timed out after ${timeoutMs} ms.`
      : redactErrorText(rawMessage, secrets);
    if (currentResponse !== undefined) {
      return responseFailure(
        normalizedRequest,
        currentUrl,
        options.agent,
        currentResponse,
        redirects,
        startedAt,
        completion,
        message,
        secrets,
      );
    }
    return failedSnapshot(
      normalizedRequest,
      currentUrl,
      options.agent,
      redirects,
      startedAt,
      completion,
      message,
    );
  } finally {
    clearTimeout(timer);
  }
}

export const captureUrl = capturePage;

export function isHtmlContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function responseFailure(
  requestedUrl: string,
  finalUrl: string,
  agent: AgentProfile,
  response: Response,
  redirects: readonly RedirectHop[],
  startedAt: number,
  completion: PageSnapshot["completion"],
  error: string,
  secrets: readonly string[],
): PageSnapshot {
  const contentType = response.headers.get("content-type") ?? undefined;
  const robots = parseXRobotsTag(response.headers.get("x-robots-tag"));
  return {
    requestedUrl,
    finalUrl,
    agent,
    status: response.status,
    ...(contentType === undefined ? {} : { contentType }),
    headers: sanitizeResponseHeaders(response.headers),
    redirects,
    signals: robots.length === 0 ? emptyPageSignals() : { ...emptyPageSignals(), robots },
    bytesRead: 0,
    durationMs: roundedDuration(startedAt),
    completion,
    error: redactErrorText(error, secrets),
  };
}

function failedSnapshot(
  requestedUrl: string,
  finalUrl: string,
  agent: AgentProfile,
  redirects: readonly RedirectHop[],
  startedAt: number,
  completion: PageSnapshot["completion"],
  error: string,
): PageSnapshot {
  return {
    requestedUrl,
    finalUrl,
    agent,
    headers: {},
    redirects,
    signals: emptyPageSignals(),
    bytesRead: 0,
    durationMs: roundedDuration(startedAt),
    completion,
    error,
  };
}

async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BodyReadResult> {
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let exceeded = false;
  if (response.body === null) {
    return { bytes: new Uint8Array(), bytesRead, sha256: hash.digest("hex"), exceeded };
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      const available = Math.max(0, maxBytes - bytesRead);
      const accepted = chunk.byteLength <= available ? chunk : chunk.subarray(0, available);
      if (accepted.byteLength > 0) {
        chunks.push(accepted);
        hash.update(accepted);
        bytesRead += accepted.byteLength;
      }
      if (accepted.byteLength < chunk.byteLength) {
        exceeded = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return {
    bytes: concatenate(chunks, bytesRead),
    bytesRead,
    sha256: hash.digest("hex"),
    exceeded,
  };
}

function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function sanitizeResponseHeaders(headers: Headers): Readonly<Record<string, string>> {
  const safe: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (SENSITIVE_HEADER.test(name)) {
      safe[name] = REDACTED_HEADER;
    } else if (URL_VALUE_HEADER.test(name)) {
      safe[name] = sanitizeUrlHeader(name, value);
    } else {
      safe[name] = value;
    }
  }
  return safe;
}

function sanitizeUrlHeader(name: string, value: string): string {
  if (name === "location" || name === "content-location") return redactUrlReference(value);
  if (name === "link") {
    return redactErrorText(
      value.replace(/<([^>]+)>/g, (_match, url: string) => `<${redactUrlReference(url)}>`),
    );
  }
  if (name === "refresh") {
    return redactErrorText(
      value.replace(/(url\s*=\s*)([^;]+)/i, (_match, prefix: string, url: string) => {
        const quote = url.startsWith('"') || url.startsWith("'") ? (url[0] ?? "") : "";
        const unquoted = quote.length === 0 ? url.trim() : url.slice(1, -1);
        return `${prefix}${quote}${redactUrlReference(unquoted)}${quote}`;
      }),
    );
  }
  return redactErrorText(value);
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The socket may already be closed or aborted. There is nothing else to release.
  }
}

function roundedDuration(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function assertSafeInteger(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
}
