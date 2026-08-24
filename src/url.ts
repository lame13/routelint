import type { QueryPolicy } from "./types.js";

const SENSITIVE_QUERY_KEY =
  /(?:^|[-_.])(?:access[-_.]?)?(?:api[-_.]?key|auth|code|credential|jwt|nonce|pass(?:word)?|secret|session|sig(?:nature)?|token)(?:$|[-_.])/i;

/** Resolve an HTTP(S) URL, remove its fragment, and apply the configured query policy. */
export function normalizeUrl(
  input: string,
  baseUrl: string,
  queryPolicy: QueryPolicy = "keep",
): string | undefined {
  let url: URL;
  try {
    url = new URL(input, baseUrl);
  } catch {
    return undefined;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username.length > 0 || url.password.length > 0) return undefined;

  url.hash = "";
  if (queryPolicy === "drop") url.search = "";
  return url.href;
}

export function isSameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Match a normalized URL against simple, dependency-free glob rules.
 * Path globs match pathname + query; absolute globs match the complete URL.
 */
export function isUrlIncluded(
  url: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const included = include.length === 0 || include.some((pattern) => matchesGlob(parsed, pattern));
  if (!included) return false;
  return !exclude.some((pattern) => matchesGlob(parsed, pattern));
}

/** Redact credentials and secret-looking query values before a URL enters an error message. */
export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    if (url.username.length > 0) url.username = "redacted";
    if (url.password.length > 0) url.password = "redacted";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.href;
  } catch {
    return "[invalid URL]";
  }
}

/** Redact a URL found in a response header while preserving relative-reference form. */
export function redactUrlReference(input: string): string {
  if (/^https?:\/\//i.test(input)) return redactUrl(input);
  if (input.startsWith("//")) return redactUrl(`https:${input}`).replace(/^https:/, "");

  const hashAt = input.indexOf("#");
  const beforeHash = hashAt === -1 ? input : input.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : input.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  if (queryAt === -1) return input;
  const path = beforeHash.slice(0, queryAt);
  const parameters = new URLSearchParams(beforeHash.slice(queryAt + 1));
  for (const key of [...parameters.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) parameters.set(key, "[redacted]");
  }
  const query = parameters.toString();
  return `${path}${query.length === 0 ? "" : `?${query}`}${hash}`;
}

/** Remove known secret values and redact URLs embedded in an untrusted error string. */
export function redactErrorText(message: string, secrets: readonly string[] = []): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[redacted]");
  }

  redacted = redacted.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    const trailing = candidate.match(/[),.;!?]+$/)?.[0] ?? "";
    const bare = trailing.length === 0 ? candidate : candidate.slice(0, -trailing.length);
    return `${redactUrl(bare)}${trailing}`;
  });
  return redacted;
}

function matchesGlob(url: URL, patternInput: string): boolean {
  const pattern = patternInput.trim();
  if (pattern.length === 0) return false;
  const absolute = /^https?:\/\//i.test(pattern);
  const target = absolute ? url.href : `${url.pathname}${url.search}`;
  return globToRegExp(pattern).test(target);
}

function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character ?? "");
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}
