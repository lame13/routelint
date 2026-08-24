import type {
  DiscoveredRobotsFile,
  RobotsAvailability,
  RobotsFile,
  RobotsGroup,
  RobotsRule,
  RobotsUnavailableReason,
} from "../types.js";
import { fetchWithScopedHeaders } from "./fetch.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

export interface FetchRobotsOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly headerOrigin?: string | URL;
  readonly maxRedirects?: number;
}

interface MutableRobotsGroup {
  readonly agents: string[];
  readonly rules: RobotsRule[];
  hasRuleDirective: boolean;
}

class ResponseLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Response exceeded the ${limit}-byte limit.`);
    this.name = "ResponseLimitError";
  }
}

class RobotsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RobotsParseError";
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Limits must be positive safe integers.");
  }
  return value;
}

function robotsUrlFor(value: string | URL): URL {
  const parsed = value instanceof URL ? new URL(value.href) : new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Robots discovery only supports HTTP and HTTPS URLs.");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("Robots discovery does not accept credentials in URLs.");
  }
  return new URL("/robots.txt", parsed.origin);
}

function commitGroup(groups: RobotsGroup[], group: MutableRobotsGroup | undefined): void {
  if (!group || group.agents.length === 0) return;
  groups.push({ agents: [...new Set(group.agents)], rules: [...group.rules] });
}

function withoutComment(line: string): string {
  const commentAt = line.indexOf("#");
  return (commentAt === -1 ? line : line.slice(0, commentAt)).trim();
}

/** Parse a robots.txt file according to record grouping rules from RFC 9309. */
export function parseRobotsText(text: string, robotsUrl: string | URL): DiscoveredRobotsFile {
  const url = robotsUrlFor(robotsUrl).href;
  const groups: RobotsGroup[] = [];
  const sitemapSet = new Set<string>();
  const warnings: string[] = [];
  let current: MutableRobotsGroup | undefined;

  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/u)) {
    const line = withoutComment(rawLine);
    if (!line) continue;

    const colonAt = line.indexOf(":");
    if (colonAt === -1) continue;
    const directive = line.slice(0, colonAt).trim().toLowerCase();
    const value = line.slice(colonAt + 1).trim();

    if (directive === "user-agent") {
      if (!value) continue;
      if (!current || current.hasRuleDirective) {
        commitGroup(groups, current);
        current = { agents: [], rules: [], hasRuleDirective: false };
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (directive === "allow" || directive === "disallow") {
      if (!current) continue;
      current.hasRuleDirective = true;
      // An empty Allow/Disallow value has no matching path and can be ignored.
      if (value) current.rules.push({ directive, pattern: value });
      continue;
    }

    if (directive === "sitemap" && value) {
      try {
        const sitemapUrl = new URL(value, url);
        if (sitemapUrl.protocol !== "http:" && sitemapUrl.protocol !== "https:") {
          warnings.push("Ignored a non-HTTP Sitemap URL.");
          continue;
        }
        if (sitemapUrl.username || sitemapUrl.password) {
          warnings.push("Ignored a Sitemap URL containing credentials.");
          continue;
        }
        sitemapUrl.hash = "";
        sitemapSet.add(sitemapUrl.href);
      } catch {
        warnings.push("Ignored an invalid Sitemap URL.");
      }
      continue;
    }

    // Extension records such as Crawl-delay still end the user-agent preamble.
    if (current) current.hasRuleDirective = true;
  }

  commitGroup(groups, current);
  return { url, availability: { state: "available" }, groups, sitemaps: [...sitemapSet], warnings };
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new ResponseLimitError(maxBytes);
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new ResponseLimitError(maxBytes);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  const output: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw new ResponseLimitError(maxBytes);
      try {
        output.push(decoder.decode(value, { stream: true }));
      } catch {
        throw new RobotsParseError("robots.txt is not valid UTF-8.");
      }
    }
    try {
      output.push(decoder.decode());
    } catch {
      throw new RobotsParseError("robots.txt is not valid UTF-8.");
    }
    return output.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function unavailableWarning(detail: string): string {
  return `${detail} Route fetching will be skipped while robots rules are respected; use --ignore-robots only when bypassing the policy is intentional.`;
}

function unavailableFile(
  url: string,
  reason: RobotsUnavailableReason,
  detail: string,
  status?: number,
): DiscoveredRobotsFile {
  return {
    url,
    ...(status === undefined ? {} : { status }),
    availability: { state: "unavailable", reason },
    groups: [],
    sitemaps: [],
    warnings: [unavailableWarning(detail)],
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Fetch and parse the origin's robots.txt without allowing an unbounded response. */
export async function fetchRobots(
  baseUrl: string | URL,
  options: FetchRobotsOptions = {},
): Promise<DiscoveredRobotsFile> {
  const url = robotsUrlFor(baseUrl);
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = normalizePositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { response } = await fetchWithScopedHeaders(url, {
      fetch: fetchImplementation,
      headers: options.headers,
      headerOrigin: options.headerOrigin ?? url.origin,
      accept: "text/plain, text/*;q=0.9, */*;q=0.1",
      signal: controller.signal,
      maxRedirects: options.maxRedirects,
    });
    const base = { url: url.href, status: response.status } as const;
    if (response.status === 404 || response.status === 410) {
      await cancelResponseBody(response);
      return {
        ...base,
        availability: { state: "missing" },
        groups: [],
        sitemaps: [],
        warnings: [],
      };
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      return unavailableFile(
        url.href,
        "http-error",
        `robots.txt returned HTTP ${response.status} and is unavailable.`,
        response.status,
      );
    }

    let text: string;
    try {
      text = await readLimitedText(response, maxBytes);
    } catch (error) {
      await cancelResponseBody(response);
      if (controller.signal.aborted) {
        return unavailableFile(
          url.href,
          "timeout",
          `robots.txt timed out after ${timeoutMs}ms and is unavailable.`,
          response.status,
        );
      }
      if (error instanceof ResponseLimitError) {
        return unavailableFile(url.href, "response-too-large", error.message, response.status);
      }
      if (error instanceof RobotsParseError) {
        return unavailableFile(url.href, "parse-error", error.message, response.status);
      }
      return unavailableFile(
        url.href,
        "read-error",
        `Could not read robots.txt: ${error instanceof Error ? error.message : String(error)}`,
        response.status,
      );
    }

    try {
      const parsed = parseRobotsText(text, url);
      return { ...parsed, status: response.status };
    } catch (error) {
      return unavailableFile(
        url.href,
        "parse-error",
        `Could not parse robots.txt: ${error instanceof Error ? error.message : String(error)}`,
        response.status,
      );
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return unavailableFile(
        url.href,
        "timeout",
        `robots.txt timed out after ${timeoutMs}ms and is unavailable.`,
      );
    }
    return unavailableFile(
      url.href,
      "network-error",
      `Could not fetch robots.txt: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Resolve explicit and legacy robots results to a safe availability state. */
export function resolveRobotsAvailability(robots: RobotsFile | undefined): RobotsAvailability {
  if (robots === undefined) return { state: "unavailable", reason: "not-fetched" };
  if (robots.availability !== undefined) return robots.availability;
  if (robots.status === 404 || robots.status === 410) return { state: "missing" };
  if (robots.status !== undefined && (robots.status < 200 || robots.status >= 300)) {
    return { state: "unavailable", reason: "http-error" };
  }

  const warnings = robots.warnings.join(" ").toLowerCase();
  if (warnings.includes("timed out")) return { state: "unavailable", reason: "timeout" };
  if (warnings.includes("byte limit") || warnings.includes("response exceeded")) {
    return { state: "unavailable", reason: "response-too-large" };
  }
  if (warnings.includes("could not parse") || warnings.includes("not valid utf-8")) {
    return { state: "unavailable", reason: "parse-error" };
  }
  if (warnings.includes("could not read")) return { state: "unavailable", reason: "read-error" };
  if (warnings.includes("could not fetch")) {
    return { state: "unavailable", reason: "network-error" };
  }
  return { state: "available" };
}

function matchingPath(value: string | URL, base: string): string | undefined {
  if (typeof value === "string" && value.startsWith("/")) {
    return value.split("#", 1)[0] ?? "/";
  }
  try {
    const parsed = value instanceof URL ? value : new URL(value, base);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}

function ruleExpression(pattern: string): RegExp | undefined {
  const terminal = pattern.endsWith("$");
  const withoutTerminal = terminal ? pattern.slice(0, -1) : pattern;
  const escaped = withoutTerminal
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"))
    .join(".*");
  try {
    return new RegExp(`^${escaped}${terminal ? "$" : ""}`, "u");
  } catch {
    return undefined;
  }
}

/** Resolve robots Allow/Disallow precedence for one user agent and URL. */
export function isRobotsAllowed(
  robots: RobotsFile,
  value: string | URL,
  userAgent: string,
): boolean {
  const availability = resolveRobotsAvailability(robots);
  if (availability.state === "unavailable") return false;
  if (availability.state === "missing") return true;
  const path = matchingPath(value, robots.url);
  if (path === undefined) return false;

  const normalizedAgent = userAgent.toLowerCase();
  let longestAgentMatch = -1;
  const matchingGroups: RobotsGroup[] = [];
  for (const group of robots.groups) {
    const groupMatch = group.agents.reduce((best, token) => {
      const normalizedToken = token.toLowerCase();
      if (normalizedToken === "*") return Math.max(best, 0);
      return normalizedAgent.includes(normalizedToken)
        ? Math.max(best, normalizedToken.length)
        : best;
    }, -1);
    if (groupMatch < longestAgentMatch) continue;
    if (groupMatch > longestAgentMatch) {
      longestAgentMatch = groupMatch;
      matchingGroups.length = 0;
    }
    if (groupMatch >= 0) matchingGroups.push(group);
  }

  if (longestAgentMatch < 0) return true;
  let winningRule: { readonly allow: boolean; readonly specificity: number } | undefined;
  for (const group of matchingGroups) {
    for (const rule of group.rules) {
      const expression = ruleExpression(rule.pattern);
      if (!expression?.test(path)) continue;
      const specificity = rule.pattern.replace(/[*$]/gu, "").length;
      const allow = rule.directive === "allow";
      if (
        !winningRule ||
        specificity > winningRule.specificity ||
        (specificity === winningRule.specificity && allow && !winningRule.allow)
      ) {
        winningRule = { allow, specificity };
      }
    }
  }
  return winningRule?.allow ?? true;
}
