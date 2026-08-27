import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type {
  BuildInventory,
  BuildRedirect,
  BuildRoute,
  NextOptions,
  RenderMode,
} from "../types.js";

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

type JsonObject = Record<string, unknown>;
type ManifestRouteKind = "app" | "generic" | "pages";

interface MutableBuildRoute {
  pathname: string;
  pattern?: string;
  renderMode: RenderMode;
  revalidateSeconds?: number | false;
  sourceManifest: string;
  partiallyStatic?: boolean;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!isObject(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function manifestLabel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

async function readJsonManifest(
  root: string,
  file: string,
  warnings: string[],
): Promise<JsonObject | undefined> {
  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) return undefined;
    if (metadata.size > MAX_MANIFEST_BYTES) {
      warnings.push(`${manifestLabel(root, file)} exceeds the ${MAX_MANIFEST_BYTES}-byte limit.`);
      return undefined;
    }
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isObject(parsed)) {
      warnings.push(`${manifestLabel(root, file)} does not contain a JSON object.`);
      return undefined;
    }
    return parsed;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      warnings.push(
        `Could not read ${manifestLabel(root, file)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }
}

function normalizePathname(value: string): string | undefined {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || containsControlCharacter(trimmed)) return undefined;
  let pathname = trimmed;
  if (/^https?:\/\//iu.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return undefined;
    }
  }
  pathname = pathname.split(/[?#]/u, 1)[0] ?? "";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/{2,}/gu, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  return pathname || "/";
}

function normalizeAppManifestPath(value: string): string | undefined {
  const normalized = normalizePathname(value);
  if (!normalized) return undefined;
  const inputSegments = normalized.split("/").filter(Boolean);
  const outputSegments: string[] = [];
  for (const inputSegment of inputSegments) {
    if (inputSegment.startsWith("@")) continue;
    if (inputSegment.startsWith("(") && inputSegment.endsWith(")")) {
      continue;
    }
    const segment = inputSegment.replace(/^(?:\(\.{1,3}\))+/u, "");
    if (segment) outputSegments.push(segment);
  }
  if (outputSegments.at(-1) === "page" || outputSegments.at(-1) === "route") outputSegments.pop();
  return outputSegments.length === 0 ? "/" : `/${outputSegments.join("/")}`;
}

function isInternalPath(pathname: string): boolean {
  return (
    pathname === "/_app" ||
    pathname === "/_document" ||
    pathname === "/_error" ||
    pathname === "/_not-found" ||
    pathname === "/404" ||
    pathname === "/500" ||
    pathname.startsWith("/_next/")
  );
}

function isPagesApiRoute(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isAppRouteHandler(value: string): boolean {
  const normalized = normalizePathname(value);
  return normalized?.split("/").at(-1) === "route";
}

function isNextMetadataRoute(pathname: string): boolean {
  const filename = pathname.split("/").filter(Boolean).at(-1)?.toLowerCase();
  if (filename === undefined) return false;
  if (
    filename === "robots.txt" ||
    filename === "sitemap.xml" ||
    filename === "manifest.webmanifest" ||
    filename === "favicon.ico"
  ) {
    return true;
  }
  return /^(?:apple-)?icon(?:[-.].*)?$|^(?:opengraph|twitter)-image(?:[-.].*)?$/u.test(filename);
}

function isDynamicPath(pathname: string): boolean {
  return pathname.split("/").some((segment) => segment.startsWith("[") && segment.endsWith("]"));
}

function routeEvidenceRank(route: MutableBuildRoute): number {
  if (route.partiallyStatic) return 5;
  switch (route.renderMode) {
    case "isr":
      return 4;
    case "static":
      return 3;
    case "dynamic":
      return 2;
    case "unknown":
      return 1;
  }
}

function upsertRoute(routes: Map<string, MutableBuildRoute>, incoming: MutableBuildRoute): void {
  const existing = routes.get(incoming.pathname);
  if (!existing || routeEvidenceRank(incoming) > routeEvidenceRank(existing)) {
    routes.set(incoming.pathname, incoming);
  }
}

function records(value: unknown): readonly JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function addManifestRoute(
  routes: Map<string, MutableBuildRoute>,
  patterns: Map<string, string>,
  rawPath: string,
  sourceManifest: string,
  kind: ManifestRouteKind = "generic",
  appManifestPath = rawPath,
  appPathIsPublic = false,
): void {
  const pathname =
    kind === "app" && !appPathIsPublic
      ? normalizeAppManifestPath(rawPath)
      : normalizePathname(rawPath);
  if (!pathname || isInternalPath(pathname)) return;
  if (kind === "pages" && isPagesApiRoute(pathname)) return;
  if (kind === "app" && isAppRouteHandler(appManifestPath) && !isNextMetadataRoute(pathname)) {
    return;
  }
  if (isDynamicPath(pathname)) {
    patterns.set(pathname, sourceManifest);
    return;
  }
  upsertRoute(routes, { pathname, renderMode: "unknown", sourceManifest });
}

function collectRouteKeys(
  manifest: JsonObject | undefined,
  routes: Map<string, MutableBuildRoute>,
  patterns: Map<string, string>,
  sourceManifest: string,
  kind: ManifestRouteKind,
): void {
  if (!manifest) return;
  for (const key of Object.keys(manifest)) {
    addManifestRoute(routes, patterns, key, sourceManifest, kind);
  }
}

function collectAppRouteValues(
  manifest: JsonObject | undefined,
  routes: Map<string, MutableBuildRoute>,
  patterns: Map<string, string>,
  sourceManifest: string,
): void {
  if (!manifest) return;
  for (const [appManifestPath, value] of Object.entries(manifest)) {
    if (typeof value === "string") {
      addManifestRoute(routes, patterns, value, sourceManifest, "app", appManifestPath, true);
    }
  }
}

function prerenderMode(value: JsonObject): {
  readonly mode: RenderMode;
  readonly revalidateSeconds?: number | false;
  readonly partiallyStatic?: boolean;
} {
  const revalidate = value.initialRevalidateSeconds;
  const partiallyStatic =
    value.renderingMode === "PARTIALLY_STATIC" ||
    value.experimentalPPR === true ||
    value.compute === "blocking" ||
    value.compute === "resuming";
  if (partiallyStatic) {
    return {
      mode: "unknown",
      partiallyStatic: true,
      ...(revalidate === false || typeof revalidate === "number"
        ? { revalidateSeconds: revalidate }
        : {}),
    };
  }
  if (revalidate === false) return { mode: "static", revalidateSeconds: false };
  if (typeof revalidate === "number" && Number.isFinite(revalidate)) {
    return revalidate > 0
      ? { mode: "isr", revalidateSeconds: revalidate }
      : { mode: "dynamic", revalidateSeconds: 0 };
  }
  return { mode: "static" };
}

function configuredBasePath(manifest: JsonObject | undefined, warnings: string[]): string {
  const rawBasePath = stringValue(manifest?.basePath);
  if (!rawBasePath) return "";
  const normalized = normalizePathname(rawBasePath);
  if (!normalized || normalized === "/") {
    warnings.push(`Ignored invalid basePath in routes-manifest.json: ${rawBasePath}`);
    return "";
  }
  return normalized;
}

function withBasePath(pathname: string, basePath: string): string {
  if (!basePath) return pathname;
  return pathname === "/" ? basePath : `${basePath}${pathname}`;
}

function withoutBasePath(pathname: string, basePath: string): string | undefined {
  if (!basePath) return undefined;
  if (pathname === basePath) return "/";
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : undefined;
}

function collectPrerenderManifest(
  manifest: JsonObject | undefined,
  routes: Map<string, MutableBuildRoute>,
  patterns: Map<string, string>,
  sourceManifest: string,
): void {
  if (!manifest) return;
  if (isObject(manifest.routes)) {
    for (const [rawPath, rawDetails] of Object.entries(manifest.routes)) {
      const pathname = normalizePathname(rawPath);
      if (!pathname || isInternalPath(pathname) || !isObject(rawDetails)) continue;
      const details = prerenderMode(rawDetails);
      const pattern = stringValue(rawDetails.srcRoute);
      const normalizedPattern = pattern ? normalizePathname(pattern) : undefined;
      if (normalizedPattern && isDynamicPath(normalizedPattern)) {
        patterns.set(normalizedPattern, sourceManifest);
      }
      upsertRoute(routes, {
        pathname,
        ...(normalizedPattern ? { pattern: normalizedPattern } : {}),
        renderMode: details.mode,
        ...(details.revalidateSeconds !== undefined
          ? { revalidateSeconds: details.revalidateSeconds }
          : {}),
        ...(details.partiallyStatic ? { partiallyStatic: true } : {}),
        sourceManifest,
      });
    }
  }
  if (isObject(manifest.dynamicRoutes)) {
    for (const rawPattern of Object.keys(manifest.dynamicRoutes)) {
      const pattern = normalizePathname(rawPattern);
      if (pattern && !isInternalPath(pattern)) patterns.set(pattern, sourceManifest);
    }
  }
}

function collectRoutesManifest(
  manifest: JsonObject | undefined,
  routes: Map<string, MutableBuildRoute>,
  patterns: Map<string, string>,
  redirects: BuildRedirect[],
  sourceManifest: string,
): void {
  if (!manifest) return;
  for (const route of records(manifest.staticRoutes)) {
    const rawPath = stringValue(route.page) ?? stringValue(route.source);
    if (rawPath) addManifestRoute(routes, patterns, rawPath, sourceManifest);
  }
  for (const route of records(manifest.dynamicRoutes)) {
    const rawPattern = stringValue(route.page) ?? stringValue(route.source);
    const pattern = rawPattern ? normalizePathname(rawPattern) : undefined;
    if (pattern && !isInternalPath(pattern)) patterns.set(pattern, sourceManifest);
  }
  for (const redirect of records(manifest.redirects)) {
    const source = stringValue(redirect.source);
    const destination = stringValue(redirect.destination);
    if (!source || !destination) continue;
    const rawStatus = redirect.statusCode;
    const status =
      typeof rawStatus === "number" && rawStatus >= 300 && rawStatus < 400
        ? rawStatus
        : redirect.permanent === true
          ? 308
          : 307;
    const conditional =
      (Array.isArray(redirect.has) && redirect.has.length > 0) ||
      (Array.isArray(redirect.missing) && redirect.missing.length > 0);
    redirects.push({ source, destination, status, ...(conditional ? { conditional: true } : {}) });
  }
}

function escapeExpression(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function routePatternExpression(pattern: string): RegExp {
  const segments = pattern.split("/").filter(Boolean);
  if (segments.length === 0) return /^\/$/u;
  let expression = "^";
  for (const segment of segments) {
    if (segment.startsWith("[[...") && segment.endsWith("]]")) {
      expression += "(?:/[^?#]+)?";
    } else if (segment.startsWith("[...") && segment.endsWith("]")) {
      expression += "/[^?#]+";
    } else if (segment.startsWith("[") && segment.endsWith("]")) {
      expression += "/[^/?#]+";
    } else {
      expression += `/${escapeExpression(segment)}`;
    }
  }
  expression += "/?$";
  return new RegExp(expression, "u");
}

function dynamicSegments(pattern: string): readonly string[] {
  return pattern.split("/").filter((segment) => segment.startsWith("[") && segment.endsWith("]"));
}

function materializeSample(pattern: string, sample: string): string | undefined {
  const trimmed = sample.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("/") || /^https?:\/\//iu.test(trimmed)) return normalizePathname(trimmed);

  const segments = dynamicSegments(pattern);
  if (segments.length !== 1) return undefined;
  const token = segments[0];
  if (!token) return undefined;
  const isCatchAll = token.includes("...");
  const encoded = isCatchAll
    ? trimmed
        .split("/")
        .filter(Boolean)
        .map((part) => encodeURIComponent(part))
        .join("/")
    : encodeURIComponent(trimmed);
  if (!encoded && !token.startsWith("[[...")) return undefined;
  const withValue = pattern.replace(`/${token}`, encoded ? `/${encoded}` : "");
  return normalizePathname(withValue);
}

function applySamples(
  samples: NextOptions["samples"],
  patterns: Map<string, string>,
  routes: Map<string, MutableBuildRoute>,
  warnings: string[],
  basePath: string,
): Set<string> {
  const resolvedPatterns = new Set<string>();
  for (const [rawPattern, values] of Object.entries(samples)) {
    const pattern = normalizePathname(rawPattern);
    if (!pattern || !patterns.has(pattern)) {
      warnings.push(`Ignored samples for unknown dynamic route pattern: ${rawPattern}`);
      continue;
    }
    const expression = routePatternExpression(pattern);
    for (const value of values) {
      const materialized = materializeSample(pattern, value);
      const pathname =
        materialized && expression.test(materialized)
          ? materialized
          : materialized
            ? withoutBasePath(materialized, basePath)
            : undefined;
      if (!pathname || !expression.test(pathname)) {
        warnings.push(
          `Ignored sample ${JSON.stringify(value)} because it does not match ${pattern}.`,
        );
        continue;
      }
      resolvedPatterns.add(pattern);
      upsertRoute(routes, {
        pathname,
        pattern,
        renderMode: "dynamic",
        sourceManifest: patterns.get(pattern) ?? "samples",
      });
    }
  }
  return resolvedPatterns;
}

async function readBuildId(
  buildDirectory: string,
  warnings: string[],
  root: string,
): Promise<string | undefined> {
  const file = path.join(buildDirectory, "BUILD_ID");
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > 1024) return undefined;
    return (await readFile(file, "utf8")).trim() || undefined;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      warnings.push(
        `Could not read ${manifestLabel(root, file)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }
}

async function readNextVersion(root: string, buildDirectory: string): Promise<string | undefined> {
  const frameworkFile = path.join(buildDirectory, "diagnostics", "framework.json");
  try {
    const metadata = await stat(frameworkFile);
    if (metadata.isFile() && metadata.size <= 16 * 1024) {
      const parsed: unknown = JSON.parse(await readFile(frameworkFile, "utf8"));
      if (isObject(parsed) && parsed.name === "Next.js" && typeof parsed.version === "string") {
        return parsed.version;
      }
    }
  } catch {
    // Older builds may not include framework diagnostics; fall back to the installed package.
  }

  let directory = root;
  while (true) {
    const packageFile = path.join(directory, "node_modules", "next", "package.json");
    try {
      const metadata = await stat(packageFile);
      if (metadata.isFile() && metadata.size <= 1024 * 1024) {
        const parsed: unknown = JSON.parse(await readFile(packageFile, "utf8"));
        if (isObject(parsed) && typeof parsed.version === "string") return parsed.version;
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return undefined;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/** Inspect supported public/known Next.js build artifacts without executing project code. */
export async function discoverNextBuild(options: NextOptions): Promise<BuildInventory> {
  const root = path.resolve(options.root);
  const buildDirectory = path.isAbsolute(options.buildDirectory)
    ? path.normalize(options.buildDirectory)
    : path.resolve(root, options.buildDirectory);
  const warnings: string[] = [];
  const routes = new Map<string, MutableBuildRoute>();
  const patterns = new Map<string, string>();
  const redirects: BuildRedirect[] = [];

  const routesFile = path.join(buildDirectory, "routes-manifest.json");
  const prerenderFile = path.join(buildDirectory, "prerender-manifest.json");
  const appPathsFile = path.join(buildDirectory, "server", "app-paths-manifest.json");
  const appPathRoutesFile = path.join(buildDirectory, "app-path-routes-manifest.json");
  const pagesFile = path.join(buildDirectory, "server", "pages-manifest.json");
  const buildManifestFile = path.join(buildDirectory, "build-manifest.json");

  const [
    routesManifest,
    prerenderManifest,
    appPathsManifest,
    appPathRoutesManifest,
    pagesManifest,
    buildManifest,
  ] = await Promise.all([
    readJsonManifest(root, routesFile, warnings),
    readJsonManifest(root, prerenderFile, warnings),
    readJsonManifest(root, appPathsFile, warnings),
    readJsonManifest(root, appPathRoutesFile, warnings),
    readJsonManifest(root, pagesFile, warnings),
    readJsonManifest(root, buildManifestFile, warnings),
  ]);

  collectRoutesManifest(
    routesManifest,
    routes,
    patterns,
    redirects,
    manifestLabel(root, routesFile),
  );
  collectPrerenderManifest(prerenderManifest, routes, patterns, manifestLabel(root, prerenderFile));
  if (appPathRoutesManifest) {
    collectAppRouteValues(
      appPathRoutesManifest,
      routes,
      patterns,
      manifestLabel(root, appPathRoutesFile),
    );
  } else {
    collectRouteKeys(appPathsManifest, routes, patterns, manifestLabel(root, appPathsFile), "app");
  }
  collectRouteKeys(pagesManifest, routes, patterns, manifestLabel(root, pagesFile), "pages");
  if (isObject(buildManifest?.pages)) {
    collectRouteKeys(
      buildManifest.pages,
      routes,
      patterns,
      manifestLabel(root, buildManifestFile),
      "pages",
    );
  }

  if (
    !routesManifest &&
    !prerenderManifest &&
    !appPathsManifest &&
    !appPathRoutesManifest &&
    !pagesManifest &&
    !buildManifest
  ) {
    warnings.push(`No supported Next.js build manifests were found in ${buildDirectory}.`);
  }

  const basePath = configuredBasePath(routesManifest, warnings);
  const resolvedPatterns = applySamples(options.samples, patterns, routes, warnings, basePath);
  if ([...routes.values()].some((route) => route.partiallyStatic)) {
    warnings.push(
      'Partial prerendering was detected; affected routes use renderMode "unknown" because they are not fully static.',
    );
  }
  for (const route of routes.values()) {
    if (route.renderMode === "unknown" && !route.partiallyStatic) route.renderMode = "dynamic";
  }

  const [buildId, nextVersion] = await Promise.all([
    readBuildId(buildDirectory, warnings, root),
    readNextVersion(root, buildDirectory),
  ]);
  const resultRoutes: BuildRoute[] = [...routes.values()]
    .sort((left, right) => left.pathname.localeCompare(right.pathname))
    .map((route) => ({
      pathname: withBasePath(route.pathname, basePath),
      ...(route.pattern ? { pattern: withBasePath(route.pattern, basePath) } : {}),
      renderMode: route.renderMode,
      ...(route.revalidateSeconds !== undefined
        ? { revalidateSeconds: route.revalidateSeconds }
        : {}),
      sourceManifest: route.sourceManifest,
    }));
  const uniqueRedirects = new Map<string, BuildRedirect>();
  for (const redirect of redirects) {
    uniqueRedirects.set(
      `${redirect.status}\u0000${redirect.source}\u0000${redirect.destination}`,
      redirect,
    );
  }

  return {
    framework: "next",
    root,
    buildDirectory,
    ...(nextVersion ? { nextVersion } : {}),
    ...(buildId ? { buildId } : {}),
    routes: resultRoutes,
    unresolvedPatterns: [...patterns.keys()]
      .filter((pattern) => !resolvedPatterns.has(pattern))
      .map((pattern) => withBasePath(pattern, basePath))
      .sort((left, right) => left.localeCompare(right)),
    redirects: [...uniqueRedirects.values()].sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.destination.localeCompare(right.destination),
    ),
    warnings,
  };
}
