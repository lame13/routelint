const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface ScopedFetchOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly headerOrigin?: string | URL;
  readonly accept: string;
  readonly signal: AbortSignal;
  readonly maxRedirects?: number | undefined;
}

export interface ScopedFetchResult {
  readonly response: Response;
  readonly finalUrl: string;
}

function httpUrl(value: string | URL, base?: string): URL {
  const url = value instanceof URL ? new URL(value.href) : new URL(value, base);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("Redirect URL must use HTTP(S) and cannot contain credentials.");
  }
  url.hash = "";
  return url;
}

/** Follow redirects while ensuring caller-supplied headers never cross their configured origin. */
export async function fetchWithScopedHeaders(
  value: string | URL,
  options: ScopedFetchOptions,
): Promise<ScopedFetchResult> {
  let current = httpUrl(value);
  const headerOrigin = httpUrl(options.headerOrigin ?? current.origin).origin;
  const maxRedirects = Math.max(0, Math.floor(options.maxRedirects ?? 5));
  let redirects = 0;

  for (;;) {
    const headers = new Headers({ accept: options.accept });
    if (current.origin === headerOrigin) {
      for (const [name, headerValue] of Object.entries(options.headers ?? {})) {
        headers.set(name, headerValue);
      }
    }
    const response = await options.fetch(current, {
      headers,
      redirect: "manual",
      signal: options.signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: current.href };
    }

    const location = response.headers.get("location");
    if (location === null) {
      await response.body?.cancel();
      throw new Error(`Redirect response ${response.status} did not include a Location header.`);
    }
    const next = httpUrl(location, current.href);
    await response.body?.cancel();
    redirects += 1;
    if (redirects > maxRedirects) {
      throw new Error(`Redirect limit exceeded after ${redirects} responses.`);
    }
    current = next;
  }
}
