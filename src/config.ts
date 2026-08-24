import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { BUILTIN_AGENTS, resolveAgent } from "./agents.js";
import type {
  AuditOptions,
  CrawlLimits,
  NextOptions,
  QueryPolicy,
  RouteLintConfig,
} from "./types.js";

const CONFIG_FILENAMES = [
  "routelint.config.yml",
  "routelint.config.yaml",
  "routelint.config.json",
] as const;

const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();

const rawConfigSchema = z
  .object({
    baseUrl: z.string().optional(),
    seeds: z.array(z.string()).optional(),
    sitemaps: z.union([z.literal("auto"), z.array(z.string())]).optional(),
    agents: z.array(z.string()).min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    queryPolicy: z.enum(["drop", "keep"]).optional(),
    respectRobots: z.boolean().optional(),
    limits: z
      .object({
        maxPages: positiveInteger.optional(),
        maxDepth: nonNegativeInteger.optional(),
        concurrency: positiveInteger.optional(),
        timeoutMs: positiveInteger.optional(),
        maxBytes: positiveInteger.optional(),
        maxRedirects: nonNegativeInteger.optional(),
      })
      .strict()
      .optional(),
    audit: z
      .object({
        requireTitle: z.boolean().optional(),
        requireDescription: z.boolean().optional(),
        requireCanonical: z.boolean().optional(),
        requireH1: z.boolean().optional(),
        requireSitemapCoverage: z.boolean().optional(),
        maxDepth: nonNegativeInteger.optional(),
      })
      .strict()
      .optional(),
    next: z
      .object({
        root: z.string().optional(),
        buildDirectory: z.string().optional(),
        samples: z.record(z.string(), z.array(z.string())).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type RawConfig = z.infer<typeof rawConfigSchema>;

export interface ConfigOverrides {
  readonly baseUrl?: string;
  readonly maxPages?: number;
  readonly maxDepth?: number;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly agents?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly sitemaps?: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly queryPolicy?: QueryPolicy;
  readonly respectRobots?: boolean;
  readonly nextRoot?: string;
  readonly buildDirectory?: string;
}

export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly overrides?: ConfigOverrides;
  readonly requireConfig?: boolean;
}

const DEFAULT_LIMITS: CrawlLimits = Object.freeze({
  maxPages: 250,
  maxDepth: 8,
  concurrency: 6,
  timeoutMs: 15_000,
  maxBytes: 2_000_000,
  maxRedirects: 5,
});

const DEFAULT_AUDIT: AuditOptions = Object.freeze({
  requireTitle: true,
  requireDescription: true,
  requireCanonical: true,
  requireH1: true,
  requireSitemapCoverage: true,
  maxDepth: 4,
});

function parseHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error(`${label} must use HTTP(S) and cannot include credentials.`);
  }
  url.hash = "";
  return url;
}

function resolveUrlList(values: readonly string[], baseUrl: string, label: string): string[] {
  return values.map((value, index) => {
    try {
      const url = new URL(value, baseUrl);
      return parseHttpUrl(url.href, `${label}[${index}]`).href;
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(`${label}[${index}] is invalid.`);
    }
  });
}

function seedResolutionBase(
  configuredBaseUrl: string | undefined,
  effectiveBaseUrl: string,
): string {
  if (configuredBaseUrl === undefined) return effectiveBaseUrl;
  const configured = parseHttpUrl(configuredBaseUrl, "baseUrl");
  const effective = parseHttpUrl(effectiveBaseUrl, "baseUrl");
  configured.protocol = effective.protocol;
  configured.host = effective.host;
  configured.search = "";
  configured.hash = "";
  return configured.href;
}

function resolveHeaderValue(value: string): string {
  const match = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(value.trim());
  if (match === null) return value;
  const name = match[1];
  if (name === undefined) return value;
  const resolved = process.env[name];
  if (resolved === undefined) {
    throw new Error(
      `A request header references an environment variable that is not set: ${name}.`,
    );
  }
  return resolved;
}

function resolveHeaders(
  configured: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const headers = new Headers();
  for (const [name, value] of Object.entries({ ...configured, ...overrides })) {
    try {
      headers.set(name, resolveHeaderValue(value));
    } catch (error) {
      if (error instanceof Error && error.message.includes("environment variable")) throw error;
      throw new Error("One or more configured request headers are invalid.");
    }
  }
  return Object.fromEntries(headers.entries());
}

async function findConfig(cwd: string): Promise<string | undefined> {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = resolve(cwd, filename);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next conventional filename.
    }
  }
  return undefined;
}

async function readRawConfig(path: string): Promise<RawConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Could not read config file: ${path}`);
  }

  let value: unknown;
  try {
    value = path.toLowerCase().endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch {
    throw new Error(`Could not parse config file: ${path}`);
  }

  const parsed = rawConfigSchema.safeParse(value ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid config: ${details}`);
  }
  return parsed.data;
}

function resolveNextOptions(
  raw: RawConfig,
  overrides: ConfigOverrides,
  baseDirectory: string,
): NextOptions | undefined {
  if (raw.next === undefined && overrides.nextRoot === undefined) return undefined;
  const configuredRoot = overrides.nextRoot ?? raw.next?.root ?? ".";
  const root = isAbsolute(configuredRoot) ? configuredRoot : resolve(baseDirectory, configuredRoot);
  return {
    root,
    buildDirectory: overrides.buildDirectory ?? raw.next?.buildDirectory ?? ".next",
    samples: raw.next?.samples ?? {},
  };
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<RouteLintConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const explicitPath = options.configPath;
  const configPath =
    explicitPath === undefined
      ? await findConfig(cwd)
      : isAbsolute(explicitPath)
        ? explicitPath
        : resolve(cwd, explicitPath);
  if (options.requireConfig === true && configPath === undefined) {
    throw new Error(`No RouteLint config found in ${cwd}.`);
  }

  const raw = configPath === undefined ? {} : await readRawConfig(configPath);
  const overrides = options.overrides ?? {};
  const rawBaseUrl = overrides.baseUrl ?? raw.baseUrl;
  if (rawBaseUrl === undefined) {
    throw new Error(
      "A base URL is required. Pass one on the command line or set baseUrl in config.",
    );
  }
  const baseUrl = parseHttpUrl(rawBaseUrl, "baseUrl").href;
  const baseDirectory = configPath === undefined ? cwd : resolve(configPath, "..");

  const limits: CrawlLimits = {
    maxPages: overrides.maxPages ?? raw.limits?.maxPages ?? DEFAULT_LIMITS.maxPages,
    maxDepth: overrides.maxDepth ?? raw.limits?.maxDepth ?? DEFAULT_LIMITS.maxDepth,
    concurrency: overrides.concurrency ?? raw.limits?.concurrency ?? DEFAULT_LIMITS.concurrency,
    timeoutMs: overrides.timeoutMs ?? raw.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    maxBytes: overrides.maxBytes ?? raw.limits?.maxBytes ?? DEFAULT_LIMITS.maxBytes,
    maxRedirects: overrides.maxRedirects ?? raw.limits?.maxRedirects ?? DEFAULT_LIMITS.maxRedirects,
  };

  const audit: AuditOptions = {
    requireTitle: raw.audit?.requireTitle ?? DEFAULT_AUDIT.requireTitle,
    requireDescription: raw.audit?.requireDescription ?? DEFAULT_AUDIT.requireDescription,
    requireCanonical: raw.audit?.requireCanonical ?? DEFAULT_AUDIT.requireCanonical,
    requireH1: raw.audit?.requireH1 ?? DEFAULT_AUDIT.requireH1,
    requireSitemapCoverage:
      raw.audit?.requireSitemapCoverage ?? DEFAULT_AUDIT.requireSitemapCoverage,
    maxDepth: raw.audit?.maxDepth ?? DEFAULT_AUDIT.maxDepth,
  };

  const seedValues = raw.seeds ?? [baseUrl];
  const sitemapValues = overrides.sitemaps ?? (raw.sitemaps === "auto" ? undefined : raw.sitemaps);
  const sitemaps =
    sitemapValues === undefined ? "auto" : resolveUrlList(sitemapValues, baseUrl, "sitemaps");
  const agents = (overrides.agents ?? raw.agents ?? [BUILTIN_AGENTS.routelint.key]).map(
    resolveAgent,
  );
  const next = resolveNextOptions(raw, overrides, baseDirectory);

  return {
    baseUrl,
    seeds: resolveUrlList(seedValues, seedResolutionBase(raw.baseUrl, baseUrl), "seeds"),
    sitemaps,
    agents,
    headers: resolveHeaders(raw.headers ?? {}, overrides.headers ?? {}),
    include: [...(overrides.include ?? raw.include ?? [])],
    exclude: [...(overrides.exclude ?? raw.exclude ?? [])],
    queryPolicy: overrides.queryPolicy ?? raw.queryPolicy ?? "drop",
    respectRobots: overrides.respectRobots ?? raw.respectRobots ?? true,
    limits,
    audit,
    ...(next === undefined ? {} : { next }),
  };
}

export function parseHeaderOptions(values: readonly string[]): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf(":");
    if (separator <= 0) {
      throw new Error("Headers must use the form 'Name: value'.");
    }
    const name = value.slice(0, separator).trim();
    const headerValue = value.slice(separator + 1).trim();
    if (headerValue.length === 0) throw new Error(`Header ${name} cannot be empty.`);
    try {
      new Headers({ [name]: headerValue });
    } catch {
      throw new Error("One or more command-line request headers are invalid.");
    }
    headers[name] = headerValue;
  }
  return headers;
}

export const DEFAULT_CONFIG_YAML = `# RouteLint stays within one origin and stops at explicit budgets.
baseUrl: https://example.com
seeds:
  - /
sitemaps: auto
agents:
  - routelint
respectRobots: true
queryPolicy: drop

limits:
  maxPages: 250
  maxDepth: 8
  concurrency: 6
  timeoutMs: 15000
  maxBytes: 2000000
  maxRedirects: 5

audit:
  requireTitle: true
  requireDescription: true
  requireCanonical: true
  requireH1: true
  requireSitemapCoverage: true
  maxDepth: 4

# Next.js build discovery is optional. Remove this block for URL-only checks.
next:
  root: .
  buildDirectory: .next
  samples:
    /blog/[slug]:
      - /blog/hello-world
`;
