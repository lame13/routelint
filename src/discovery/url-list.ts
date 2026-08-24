import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_BYTES_PER_SOURCE = 10 * 1024 * 1024;

export type UrlListDiagnosticSeverity = "error" | "warning";

export type UrlListDiagnosticCode =
  | "empty-source"
  | "source-read-failed"
  | "source-too-large"
  | "stdin-reused"
  | "invalid-entry"
  | "unsupported-protocol"
  | "credentials-not-allowed"
  | "off-origin";

export interface UrlListDiagnostic {
  readonly severity: UrlListDiagnosticSeverity;
  readonly code: UrlListDiagnosticCode;
  readonly source: string;
  readonly line?: number;
  readonly message: string;
}

export interface UrlListEntry {
  readonly url: string;
  readonly source: string;
  readonly line: number;
}

export interface UrlListSourceSummary {
  /** The value supplied by the caller, or `<stdin>` for `-`. */
  readonly source: string;
  readonly kind: "file" | "stdin";
  /** Absolute path used for filesystem reads. Omitted for stdin. */
  readonly resolvedPath?: string;
  readonly accepted: number;
  readonly rejected: number;
}

export interface UrlListInventory {
  /** De-duplicated absolute URLs, ordered by their first valid occurrence. */
  readonly urls: readonly string[];
  /** Source and line evidence for each URL retained in `urls`. */
  readonly entries: readonly UrlListEntry[];
  readonly sources: readonly UrlListSourceSummary[];
  readonly diagnostics: readonly UrlListDiagnostic[];
}

export interface LoadUrlListsOptions {
  readonly baseUrl: string | URL;
  readonly cwd?: string;
  readonly maxBytesPerSource?: number;
  /** Compatibility hook. Prefer `readFileChunks` for bounded custom readers. */
  readonly readFile?: (filePath: string) => Promise<string>;
  /** Compatibility hook. Prefer `readStdinChunks` for bounded custom readers. */
  readonly readStdin?: () => Promise<string>;
  readonly statFile?: (filePath: string) => Promise<{ readonly size: number }>;
  readonly readFileChunks?: (filePath: string) => AsyncIterable<string | Uint8Array>;
  readonly readStdinChunks?: () => AsyncIterable<string | Uint8Array>;
}

interface ParsedEntry {
  readonly url?: string;
  readonly diagnostic?: Omit<UrlListDiagnostic, "source" | "line" | "message"> & {
    readonly detail: string;
  };
}

type SourceContents =
  | {
      readonly status: "ok";
      readonly contents: string;
      readonly bytes: number;
    }
  | {
      readonly status: "too-large";
      /** Exact for stat/string readers; a lower bound for chunk readers. */
      readonly bytes: number;
      readonly exact: boolean;
    };

function parseBaseUrl(value: string | URL): URL {
  const parsed = value instanceof URL ? new URL(value.href) : new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("The URL-list base URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("The URL-list base URL must not contain credentials.");
  }
  parsed.hash = "";
  return parsed;
}

function positiveSafeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("The URL-list byte limit must be a positive safe integer.");
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function parseEntry(value: string, base: URL): ParsedEntry {
  if (containsControlCharacter(value)) {
    return {
      diagnostic: {
        severity: "error",
        code: "invalid-entry",
        detail: "contains a control character",
      },
    };
  }

  const explicitScheme = /^([a-z][a-z\d+.-]*):/iu.exec(value)?.[1]?.toLowerCase();
  if (explicitScheme && explicitScheme !== "http" && explicitScheme !== "https") {
    return {
      diagnostic: {
        severity: "error",
        code: "unsupported-protocol",
        detail: `uses the unsupported ${explicitScheme}: protocol`,
      },
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(value, base);
  } catch {
    return {
      diagnostic: {
        severity: "error",
        code: "invalid-entry",
        detail: "is not a valid URL or path",
      },
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      diagnostic: {
        severity: "error",
        code: "unsupported-protocol",
        detail: `uses the unsupported ${parsed.protocol} protocol`,
      },
    };
  }
  if (parsed.username || parsed.password) {
    return {
      diagnostic: {
        severity: "error",
        code: "credentials-not-allowed",
        detail: "contains URL credentials",
      },
    };
  }
  if (parsed.origin !== base.origin) {
    return {
      diagnostic: {
        severity: "warning",
        code: "off-origin",
        detail: `targets ${parsed.origin}, outside the configured ${base.origin} origin`,
      },
    };
  }

  parsed.hash = "";
  parsed.searchParams.sort();
  return { url: parsed.href };
}

function location(source: string, line?: number): string {
  return line === undefined ? source : `${source}:${line}`;
}

function diagnostic(
  source: string,
  severity: UrlListDiagnosticSeverity,
  code: UrlListDiagnosticCode,
  detail: string,
  line?: number,
): UrlListDiagnostic {
  return {
    severity,
    code,
    source,
    ...(line === undefined ? {} : { line }),
    message: `${location(source, line)} ${detail}.`,
  };
}

async function defaultStatFile(filePath: string): Promise<{ readonly size: number }> {
  const metadata = await stat(filePath);
  return { size: metadata.size };
}

function waitForReadable(stream: Readable): Promise<"readable" | "end"> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("readable", onReadable);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
    };
    const finish = (result: "readable" | "end") => {
      cleanup();
      resolve(result);
    };
    const onReadable = () => finish("readable");
    const onEnd = () => finish("end");
    const onClose = () => {
      if (stream.readableEnded) {
        finish("end");
        return;
      }
      cleanup();
      reject(new Error("input stream closed before reaching its end"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    stream.once("readable", onReadable);
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}

async function* readReadableChunks(
  stream: Readable,
  destroyOnReturn: boolean,
): AsyncGenerator<Uint8Array> {
  try {
    while (true) {
      // Consume what is currently buffered. Asking for a fixed 64 KiB can
      // deadlock on a smaller file because Node waits for more bytes while the
      // buffered tail prevents the end event from being emitted.
      const value: unknown = stream.read();
      if (value === null) {
        if (stream.readableEnded) return;
        if ((await waitForReadable(stream)) === "end") return;
        continue;
      }

      if (typeof value === "string") {
        yield Buffer.from(value, "utf8");
      } else if (value instanceof Uint8Array) {
        yield value;
      } else {
        throw new TypeError("input stream produced a non-text chunk");
      }
    }
  } finally {
    stream.pause();
    if (destroyOnReturn && !stream.destroyed) stream.destroy();
  }
}

function defaultReadFileChunks(filePath: string): AsyncIterable<Uint8Array> {
  return readReadableChunks(createReadStream(filePath, { highWaterMark: 64 * 1024 }), true);
}

function defaultReadStdinChunks(): AsyncIterable<Uint8Array> {
  return readReadableChunks(process.stdin, false);
}

function boundedString(contents: string, maxBytes: number): SourceContents {
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes > maxBytes) return { status: "too-large", bytes, exact: true };
  return { status: "ok", contents, bytes };
}

function bytesForChunk(chunk: string | Uint8Array): Uint8Array {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (chunk instanceof Uint8Array) return chunk;
  throw new TypeError("URL-list reader produced a non-text chunk");
}

async function readBoundedChunks(
  chunks: AsyncIterable<string | Uint8Array>,
  maxBytes: number,
): Promise<SourceContents> {
  const decoder = new StringDecoder("utf8");
  const decoded: string[] = [];
  const iterator = chunks[Symbol.asyncIterator]();
  let bytes = 0;
  let complete = false;

  try {
    while (true) {
      const item = await iterator.next();
      if (item.done) {
        complete = true;
        break;
      }

      const chunk = bytesForChunk(item.value);
      const observedBytes = bytes + chunk.byteLength;
      if (observedBytes > maxBytes) {
        return { status: "too-large", bytes: observedBytes, exact: false };
      }

      bytes = observedBytes;
      decoded.push(decoder.write(chunk));
    }

    decoded.push(decoder.end());
    return { status: "ok", contents: decoded.join(""), bytes };
  } finally {
    if (!complete) await iterator.return?.();
  }
}

function validateFileSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError("file metadata returned an invalid byte size");
  }
  return size;
}

async function readFileSource(
  filePath: string,
  maxBytes: number,
  options: LoadUrlListsOptions,
): Promise<SourceContents> {
  const hasCustomReader = options.readFile !== undefined || options.readFileChunks !== undefined;
  const statFileImplementation =
    options.statFile ?? (hasCustomReader ? undefined : defaultStatFile);

  if (statFileImplementation) {
    const bytes = validateFileSize((await statFileImplementation(filePath)).size);
    if (bytes > maxBytes) return { status: "too-large", bytes, exact: true };
  }

  if (options.readFileChunks) {
    return readBoundedChunks(options.readFileChunks(filePath), maxBytes);
  }
  if (options.readFile) {
    return boundedString(await options.readFile(filePath), maxBytes);
  }
  return readBoundedChunks(defaultReadFileChunks(filePath), maxBytes);
}

async function readStdinSource(
  maxBytes: number,
  options: LoadUrlListsOptions,
): Promise<SourceContents> {
  if (options.readStdinChunks) {
    return readBoundedChunks(options.readStdinChunks(), maxBytes);
  }
  if (options.readStdin) {
    return boundedString(await options.readStdin(), maxBytes);
  }
  return readBoundedChunks(defaultReadStdinChunks(), maxBytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Load explicit crawl targets from text files or stdin.
 *
 * Each non-empty, non-comment line must be an HTTP(S) URL or a path that can be
 * resolved against `baseUrl`. Invalid and off-origin lines are excluded with
 * source-and-line diagnostics. A `-` source reads stdin and may appear only once.
 */
export async function loadUrlLists(
  inputSources: readonly string[],
  options: LoadUrlListsOptions,
): Promise<UrlListInventory> {
  const base = parseBaseUrl(options.baseUrl);
  const cwd = options.cwd ?? process.cwd();
  const maxBytes = positiveSafeInteger(options.maxBytesPerSource, DEFAULT_MAX_BYTES_PER_SOURCE);
  const entries: UrlListEntry[] = [];
  const sources: UrlListSourceSummary[] = [];
  const diagnostics: UrlListDiagnostic[] = [];
  const seenUrls = new Set<string>();
  let stdinRead = false;

  for (const rawSource of inputSources) {
    const source = rawSource.trim();
    if (!source) {
      diagnostics.push(
        diagnostic("<empty>", "error", "empty-source", "does not identify an input file"),
      );
      continue;
    }

    const isStdin = source === "-";
    const sourceLabel = isStdin ? "<stdin>" : source;
    const resolvedPath = isStdin ? undefined : path.resolve(cwd, source);
    if (isStdin && stdinRead) {
      diagnostics.push(
        diagnostic(sourceLabel, "error", "stdin-reused", "was already consumed; use '-' only once"),
      );
      sources.push({ source: sourceLabel, kind: "stdin", accepted: 0, rejected: 1 });
      continue;
    }

    if (isStdin) stdinRead = true;
    let sourceContents: SourceContents;
    try {
      sourceContents = isStdin
        ? await readStdinSource(maxBytes, options)
        : await readFileSource(path.resolve(cwd, source), maxBytes, options);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          sourceLabel,
          "error",
          "source-read-failed",
          `could not be read: ${errorMessage(error)}`,
        ),
      );
      sources.push({
        source: sourceLabel,
        kind: isStdin ? "stdin" : "file",
        ...(resolvedPath ? { resolvedPath } : {}),
        accepted: 0,
        rejected: 1,
      });
      continue;
    }

    if (sourceContents.status === "too-large") {
      const size = sourceContents.exact
        ? `${sourceContents.bytes} bytes`
        : `at least ${sourceContents.bytes} bytes`;
      diagnostics.push(
        diagnostic(
          sourceLabel,
          "error",
          "source-too-large",
          `is ${size} and exceeds the ${maxBytes}-byte limit`,
        ),
      );
      sources.push({
        source: sourceLabel,
        kind: isStdin ? "stdin" : "file",
        ...(resolvedPath ? { resolvedPath } : {}),
        accepted: 0,
        rejected: 1,
      });
      continue;
    }

    let accepted = 0;
    let rejected = 0;
    const lines = sourceContents.contents.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const value = (lines[index] ?? "").trim();
      if (!value || value.startsWith("#")) continue;

      const parsed = parseEntry(value, base);
      if (!parsed.url) {
        rejected += 1;
        const issue = parsed.diagnostic;
        if (issue) {
          diagnostics.push(
            diagnostic(sourceLabel, issue.severity, issue.code, issue.detail, index + 1),
          );
        }
        continue;
      }
      if (seenUrls.has(parsed.url)) continue;
      seenUrls.add(parsed.url);
      entries.push({ url: parsed.url, source: sourceLabel, line: index + 1 });
      accepted += 1;
    }

    sources.push({
      source: sourceLabel,
      kind: isStdin ? "stdin" : "file",
      ...(resolvedPath ? { resolvedPath } : {}),
      accepted,
      rejected,
    });
  }

  return {
    urls: entries.map((entry) => entry.url),
    entries,
    sources,
    diagnostics,
  };
}
