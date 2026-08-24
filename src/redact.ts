import { relative } from "node:path";
import type {
  BuildInventory,
  BuildRoute,
  Finding,
  HreflangSignal,
  LinkSignal,
  MetadataSignal,
  PageSignals,
  PageSnapshot,
  RenderedPageSnapshot,
  RobotsFile,
  RobotsSignal,
  RouteLintReport,
  RouteNode,
  RouteSource,
  SitemapEntry,
  SitemapInventory,
} from "./types.js";
import { redactErrorText, redactUrlReference } from "./url.js";

function text(value: string, secrets: readonly string[]): string {
  return redactErrorText(value, secrets);
}

function reference(value: string, secrets: readonly string[]): string {
  return redactUrlReference(text(value, secrets));
}

function pathText(
  value: string,
  localPaths: readonly string[],
  secrets: readonly string[],
): string {
  let result = value;
  for (const localPath of localPaths) result = result.split(localPath).join(".");
  return text(result, secrets);
}

function metadata(signal: MetadataSignal, secrets: readonly string[]): MetadataSignal {
  return { ...signal, value: text(signal.value, secrets) };
}

function robotsSignal(signal: RobotsSignal, secrets: readonly string[]): RobotsSignal {
  return { ...signal, value: text(signal.value, secrets) };
}

function link(signal: LinkSignal, secrets: readonly string[]): LinkSignal {
  return {
    ...signal,
    href: reference(signal.href, secrets),
    ...(signal.resolvedUrl === undefined ? {} : { resolvedUrl: text(signal.resolvedUrl, secrets) }),
    text: text(signal.text, secrets),
    rel: signal.rel.map((value) => text(value, secrets)),
  };
}

function hreflang(signal: HreflangSignal, secrets: readonly string[]): HreflangSignal {
  return {
    ...signal,
    language: text(signal.language, secrets),
    href: reference(signal.href, secrets),
    ...(signal.resolvedUrl === undefined ? {} : { resolvedUrl: text(signal.resolvedUrl, secrets) }),
  };
}

function signals(value: PageSignals, secrets: readonly string[]): PageSignals {
  return {
    titles: value.titles.map((signal) => metadata(signal, secrets)),
    descriptions: value.descriptions.map((signal) => metadata(signal, secrets)),
    canonicals: value.canonicals.map((signal) => ({
      ...signal,
      value: reference(signal.value, secrets),
    })),
    robots: value.robots.map((signal) => robotsSignal(signal, secrets)),
    h1s: value.h1s.map((signal) => metadata(signal, secrets)),
    links: value.links.map((signal) => link(signal, secrets)),
    hreflangs: value.hreflangs.map((signal) => hreflang(signal, secrets)),
    ...(value.htmlLang === undefined ? {} : { htmlLang: text(value.htmlLang, secrets) }),
    ...(value.baseHref === undefined ? {} : { baseHref: reference(value.baseHref, secrets) }),
  };
}

function snapshot(value: PageSnapshot, secrets: readonly string[]): PageSnapshot {
  return {
    ...value,
    requestedUrl: text(value.requestedUrl, secrets),
    finalUrl: text(value.finalUrl, secrets),
    agent: {
      key: text(value.agent.key, secrets),
      label: text(value.agent.label, secrets),
      userAgent: text(value.agent.userAgent, secrets),
    },
    headers: Object.fromEntries(
      Object.entries(value.headers).map(([name, headerValue]) => [
        text(name, secrets),
        text(headerValue, secrets),
      ]),
    ),
    redirects: value.redirects.map((hop) => ({
      ...hop,
      url: text(hop.url, secrets),
      location: text(hop.location, secrets),
    })),
    signals: signals(value.signals, secrets),
    ...(value.error === undefined ? {} : { error: text(value.error, secrets) }),
  };
}

function renderedSnapshot(
  value: RenderedPageSnapshot,
  secrets: readonly string[],
): RenderedPageSnapshot {
  return {
    ...value,
    requestedUrl: text(value.requestedUrl, secrets),
    finalUrl: text(value.finalUrl, secrets),
    signals: signals(value.signals, secrets),
    ...(value.error === undefined ? {} : { error: text(value.error, secrets) }),
  };
}

function sitemapEntry(value: SitemapEntry, secrets: readonly string[]): SitemapEntry {
  return {
    ...value,
    url: text(value.url, secrets),
    sitemapUrl: text(value.sitemapUrl, secrets),
    ...(value.lastModified === undefined
      ? {}
      : { lastModified: text(value.lastModified, secrets) }),
    alternates: value.alternates.map((alternate) => hreflang(alternate, secrets)),
  };
}

function sitemap(value: SitemapInventory, secrets: readonly string[]): SitemapInventory {
  return {
    requested: value.requested.map((url) => text(url, secrets)),
    fetched: value.fetched.map((url) => text(url, secrets)),
    entries: value.entries.map((entry) => sitemapEntry(entry, secrets)),
    warnings: value.warnings.map((warning) => text(warning, secrets)),
  };
}

function robots(value: RobotsFile, secrets: readonly string[]): RobotsFile {
  return {
    ...value,
    url: text(value.url, secrets),
    groups: value.groups.map((group) => ({
      agents: group.agents.map((agent) => text(agent, secrets)),
      rules: group.rules.map((rule) => ({
        ...rule,
        pattern: text(rule.pattern, secrets),
      })),
    })),
    sitemaps: value.sitemaps.map((url) => text(url, secrets)),
    warnings: value.warnings.map((warning) => text(warning, secrets)),
  };
}

function buildRoute(
  value: BuildRoute,
  secrets: readonly string[],
  localPaths: readonly string[] = [],
): BuildRoute {
  return {
    ...value,
    pathname: reference(value.pathname, secrets),
    ...(value.pattern === undefined ? {} : { pattern: text(value.pattern, secrets) }),
    sourceManifest: pathText(value.sourceManifest, localPaths, secrets),
  };
}

function build(value: BuildInventory, secrets: readonly string[]): BuildInventory {
  const relativeBuildDirectory = relative(value.root, value.buildDirectory).replace(/\\/g, "/");
  const buildDirectory = relativeBuildDirectory.startsWith("..")
    ? "[outside-project]"
    : relativeBuildDirectory || ".";
  const localPaths = [value.buildDirectory, value.root].sort(
    (left, right) => right.length - left.length,
  );
  const buildText = (input: string): string => pathText(input, localPaths, secrets);
  return {
    ...value,
    root: ".",
    buildDirectory,
    ...(value.nextVersion === undefined ? {} : { nextVersion: text(value.nextVersion, secrets) }),
    ...(value.buildId === undefined ? {} : { buildId: text(value.buildId, secrets) }),
    routes: value.routes.map((route) => buildRoute(route, secrets, localPaths)),
    unresolvedPatterns: value.unresolvedPatterns.map((pattern) => text(pattern, secrets)),
    redirects: value.redirects.map((redirect) => ({
      ...redirect,
      source: reference(redirect.source, secrets),
      destination: reference(redirect.destination, secrets),
    })),
    warnings: value.warnings.map(buildText),
  };
}

function source(value: RouteSource, secrets: readonly string[]): RouteSource {
  return {
    ...value,
    ...(value.from === undefined ? {} : { from: text(value.from, secrets) }),
    ...(value.detail === undefined ? {} : { detail: text(value.detail, secrets) }),
  };
}

function route(
  value: RouteNode,
  secrets: readonly string[],
  localPaths: readonly string[],
): RouteNode {
  return {
    ...value,
    url: text(value.url, secrets),
    sources: value.sources.map((item) => source(item, secrets)),
    ...(value.sitemap === undefined ? {} : { sitemap: sitemapEntry(value.sitemap, secrets) }),
    ...(value.build === undefined ? {} : { build: buildRoute(value.build, secrets, localPaths) }),
    snapshots: value.snapshots.map((item) => snapshot(item, secrets)),
    ...(value.rendered === undefined
      ? {}
      : { rendered: renderedSnapshot(value.rendered, secrets) }),
    inbound: value.inbound.map((url) => text(url, secrets)),
    outbound: value.outbound.map((url) => text(url, secrets)),
  };
}

function finding(value: Finding, secrets: readonly string[]): Finding {
  return {
    ...value,
    code: text(value.code, secrets),
    message: text(value.message, secrets),
    ...(value.url === undefined ? {} : { url: text(value.url, secrets) }),
    ...(value.relatedUrls === undefined
      ? {}
      : { relatedUrls: value.relatedUrls.map((url) => text(url, secrets)) }),
    ...(value.evidence === undefined
      ? {}
      : {
          evidence: Object.fromEntries(
            Object.entries(value.evidence).map(([name, evidenceValue]) => [
              text(name, secrets),
              typeof evidenceValue === "string" ? text(evidenceValue, secrets) : evidenceValue,
            ]),
          ),
        }),
  };
}

/** Return a report safe to serialize, without mutating the evidence used by the audit. */
export function redactReport(
  report: RouteLintReport,
  secretValues: readonly string[],
): RouteLintReport {
  const secrets = secretValues.filter((value) => value.length > 0);
  const localPaths =
    report.build === undefined
      ? []
      : [report.build.buildDirectory, report.build.root].sort(
          (left, right) => right.length - left.length,
        );
  return {
    ...report,
    baseUrl: text(report.baseUrl, secrets),
    config: {
      ...report.config,
      agents: report.config.agents.map((agent) => text(agent, secrets)),
      ...(report.config.seeds === undefined
        ? {}
        : { seeds: report.config.seeds.map((seed) => reference(seed, secrets)) }),
      ...(report.config.sitemapUrls === undefined
        ? {}
        : {
            sitemapUrls: report.config.sitemapUrls.map((sitemapUrl) =>
              reference(sitemapUrl, secrets),
            ),
          }),
      ...(report.config.include === undefined
        ? {}
        : { include: report.config.include.map((pattern) => text(pattern, secrets)) }),
      ...(report.config.exclude === undefined
        ? {}
        : { exclude: report.config.exclude.map((pattern) => text(pattern, secrets)) }),
      ...(report.config.headerNames === undefined
        ? {}
        : { headerNames: report.config.headerNames.map((name) => text(name, secrets)) }),
    },
    ...(report.inputs === undefined
      ? {}
      : {
          inputs: {
            ...report.inputs,
            warnings: report.inputs.warnings.map((warning) => text(warning, secrets)),
          },
        }),
    ...(report.build === undefined ? {} : { build: build(report.build, secrets) }),
    sitemap: sitemap(report.sitemap, secrets),
    ...(report.robots === undefined ? {} : { robots: robots(report.robots, secrets) }),
    routes: report.routes.map((item) => route(item, secrets, localPaths)),
    findings: report.findings.map((item) => finding(item, secrets)),
  };
}
