import { simhashDistance } from "./content.js";
import { auditRedirectContracts } from "./redirects.js";
import type {
  AuditOptions,
  BuildInventory,
  Finding,
  PageSnapshot,
  RedirectContract,
  RedirectContractReport,
  RobotsFile,
  RouteLintSummary,
  RouteNode,
  Severity,
  SitemapInventory,
} from "./types.js";
import { isUrlIncluded } from "./url.js";

export interface AuditInput {
  readonly baseUrl: string;
  readonly routes: readonly RouteNode[];
  readonly sitemap: SitemapInventory;
  readonly robots?: RobotsFile;
  readonly build?: BuildInventory;
  readonly redirectContracts?: readonly RedirectContract[];
  readonly skippedBuildRedirects?: number;
  readonly options: AuditOptions;
  readonly truncated: boolean;
}

export interface AuditOutput {
  readonly findings: readonly Finding[];
  readonly summary: RouteLintSummary;
  readonly redirectContracts: RedirectContractReport;
}

type Indexability = "indexable" | "noindex" | "unknown";

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

const ROUTE_GROUP_FINDINGS = new Set([
  "duplicate-canonical-target",
  "duplicate-title-across-routes",
  "duplicate-description-across-routes",
  "duplicate-content-across-routes",
  "route-case-or-slash-variant",
]);

function primarySnapshot(route: RouteNode): PageSnapshot | undefined {
  return route.snapshots[0];
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizedUrl(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function directives(snapshot: PageSnapshot): Set<string> {
  const audience = snapshot.agent.key.toLowerCase();
  const applicable = snapshot.signals.robots.filter(
    (signal) =>
      signal.audience === "robots" ||
      (audience === "googlebot" && signal.audience === "googlebot") ||
      (audience === "bingbot" && signal.audience === "bingbot"),
  );
  const result = new Set(
    applicable
      .flatMap((signal) => signal.value.toLowerCase().split(/[;,]/))
      .map((value) => value.trim().split(/\s+/, 1)[0] ?? "")
      .filter((value) => value.length > 0),
  );
  if (result.has("none")) {
    result.add("noindex");
    result.add("nofollow");
  }
  if (result.has("noindex")) result.delete("index");
  if (result.has("nofollow")) result.delete("follow");
  return result;
}

export function getSnapshotIndexability(snapshot: PageSnapshot): Indexability {
  if (snapshot.completion !== "complete") return "unknown";
  if (snapshot.redirects.length > 0) return "unknown";
  if (snapshot.status === undefined || snapshot.status < 200 || snapshot.status >= 300) {
    return "unknown";
  }
  if (
    snapshot.contentType !== undefined &&
    !/^(text\/html|application\/xhtml\+xml)\b/i.test(snapshot.contentType)
  ) {
    return "unknown";
  }
  return directives(snapshot).has("noindex") ? "noindex" : "indexable";
}

export function getIndexability(route: RouteNode): Indexability {
  const snapshot = primarySnapshot(route);
  return snapshot === undefined ? "unknown" : getSnapshotIndexability(snapshot);
}

function canonicalUrl(route: RouteNode): string | undefined {
  const snapshot = primarySnapshot(route);
  return snapshot === undefined || snapshot.completion !== "complete"
    ? undefined
    : snapshotCanonicalUrl(snapshot);
}

function snapshotCanonicalUrl(snapshot: PageSnapshot): string | undefined {
  const canonical = snapshot.signals.canonicals[0]?.value;
  return canonical === undefined ? undefined : normalizedUrl(canonical, snapshot.finalUrl);
}

function statusLabel(snapshot: PageSnapshot | undefined): string {
  if (snapshot?.status === undefined) return snapshot?.completion ?? "not fetched";
  return String(snapshot.status);
}

function findingKey(finding: Finding): string {
  return `${finding.severity}\u0000${finding.url ?? ""}\u0000${finding.code}\u0000${finding.message}`;
}

function pushFinding(findings: Finding[], finding: Finding): void {
  findings.push(finding);
}

function optionsForRoute(options: AuditOptions, url: string): AuditOptions {
  let effective: AuditOptions = options;
  for (const scope of options.paths ?? []) {
    if (!isUrlIncluded(url, scope.include, scope.exclude)) continue;
    effective = {
      ...effective,
      ...(scope.requireTitle === undefined ? {} : { requireTitle: scope.requireTitle }),
      ...(scope.requireDescription === undefined
        ? {}
        : { requireDescription: scope.requireDescription }),
      ...(scope.requireCanonical === undefined ? {} : { requireCanonical: scope.requireCanonical }),
      ...(scope.requireH1 === undefined ? {} : { requireH1: scope.requireH1 }),
      ...(scope.requireSitemapCoverage === undefined
        ? {}
        : { requireSitemapCoverage: scope.requireSitemapCoverage }),
      ...(scope.maxDepth === undefined ? {} : { maxDepth: scope.maxDepth }),
    };
  }
  return effective;
}

function applySeverityConfiguration(
  findings: readonly Finding[],
  options: AuditOptions,
): readonly Finding[] {
  const configured: Finding[] = [];
  for (const finding of findings) {
    const affectedUrls =
      finding.url === undefined
        ? []
        : ROUTE_GROUP_FINDINGS.has(finding.code)
          ? [finding.url, ...(finding.relatedUrls ?? [])]
          : [finding.url];
    const severities = (affectedUrls.length === 0 ? [undefined] : affectedUrls).map((url) => {
      let severity = options.severities?.[finding.code];
      for (const scope of options.paths ?? []) {
        if (url === undefined || !isUrlIncluded(url, scope.include, scope.exclude)) continue;
        severity = scope.severities?.[finding.code] ?? severity;
      }
      return severity ?? finding.severity;
    });
    const active = severities.filter((severity): severity is Severity => severity !== "off");
    if (active.length === 0) continue;
    const severity = active.reduce((highest, candidate) =>
      SEVERITY_ORDER[candidate] < SEVERITY_ORDER[highest] ? candidate : highest,
    );
    configured.push(severity === finding.severity ? finding : { ...finding, severity });
  }
  return configured;
}

function checkRepeated(
  findings: Finding[],
  route: RouteNode,
  code: string,
  label: string,
  values: readonly string[],
): void {
  const present = values.map(normalizedText).filter((value) => value.length > 0);
  if (present.length < 2) return;
  const distinct = new Set(present);
  pushFinding(findings, {
    code: distinct.size > 1 ? `conflicting-${code}` : `duplicate-${code}`,
    severity: "warning",
    url: route.url,
    message:
      distinct.size > 1
        ? `The route returns conflicting ${label}.`
        : `The route returns duplicate ${label}.`,
    evidence: { count: present.length, distinctValues: distinct.size },
  });
}

function checkPage(
  findings: Finding[],
  route: RouteNode,
  options: AuditOptions,
  isRedirectContractSource: boolean,
): void {
  options = optionsForRoute(options, route.url);
  const snapshot = primarySnapshot(route);
  if (snapshot === undefined) {
    pushFinding(findings, {
      code: "route-not-fetched",
      severity: "info",
      url: route.url,
      message: "The route was discovered but not fetched within this run's limits.",
    });
    return;
  }

  if (snapshot.completion === "robots-blocked") {
    pushFinding(findings, {
      code: "robots-blocked",
      severity: "info",
      url: route.url,
      message: "robots.txt prevented this route from being fetched.",
    });
    return;
  }
  if (snapshot.completion !== "complete") {
    pushFinding(findings, {
      code: "incomplete-fetch",
      severity: snapshot.completion === "max-bytes-exceeded" ? "warning" : "error",
      url: route.url,
      message: `The route could not be captured completely (${snapshot.completion}).`,
      evidence: { bytesRead: snapshot.bytesRead },
    });
    if (snapshot.status === undefined) {
      pushFinding(findings, {
        code: "missing-http-response",
        severity: "error",
        url: route.url,
        message: "The route did not return an HTTP response.",
      });
    }
    return;
  }
  if (snapshot.status === undefined) {
    pushFinding(findings, {
      code: "missing-http-response",
      severity: "error",
      url: route.url,
      message: "The route did not return an HTTP response.",
    });
    return;
  }
  if (isRedirectContractSource) return;
  if (snapshot.status >= 400) {
    pushFinding(findings, {
      code: snapshot.status >= 500 ? "server-error" : "not-found",
      severity: "error",
      url: route.url,
      message: `The route returned HTTP ${snapshot.status}.`,
      evidence: { status: snapshot.status },
    });
    return;
  }
  if (snapshot.status < 200 || snapshot.status >= 300) {
    pushFinding(findings, {
      code: "unexpected-status",
      severity: "warning",
      url: route.url,
      message: `The route returned HTTP ${snapshot.status}.`,
      evidence: { status: snapshot.status },
    });
    return;
  }
  if (snapshot.redirects.length > 0) {
    pushFinding(findings, {
      code: "redirected-route",
      severity: "warning",
      url: route.url,
      relatedUrls: [snapshot.finalUrl],
      message: `The discovered URL redirects to ${snapshot.finalUrl}.`,
      evidence: { hops: snapshot.redirects.length },
    });
    return;
  }
  if (
    snapshot.contentType !== undefined &&
    !/^(text\/html|application\/xhtml\+xml)\b/i.test(snapshot.contentType)
  ) {
    pushFinding(findings, {
      code: "non-html-route",
      severity: "info",
      url: route.url,
      message: `The route returned ${snapshot.contentType} instead of HTML.`,
    });
    return;
  }

  const { signals } = snapshot;
  if (options.requireTitle && signals.titles.length === 0) {
    pushFinding(findings, {
      code: "missing-title",
      severity: "error",
      url: route.url,
      message: "The server-rendered HTML has no title.",
    });
  }
  if (options.requireDescription && signals.descriptions.length === 0) {
    pushFinding(findings, {
      code: "missing-description",
      severity: "warning",
      url: route.url,
      message: "The server-rendered HTML has no meta description.",
    });
  }
  if (options.requireCanonical && signals.canonicals.length === 0) {
    pushFinding(findings, {
      code: "missing-canonical",
      severity: "error",
      url: route.url,
      message: "The server-rendered HTML has no canonical link.",
    });
  }
  if (options.requireH1 && signals.h1s.length === 0) {
    pushFinding(findings, {
      code: "missing-h1",
      severity: "warning",
      url: route.url,
      message: "The server-rendered HTML has no H1.",
    });
  }
  checkRepeated(
    findings,
    route,
    "title",
    "title elements",
    signals.titles.map((signal) => signal.value),
  );
  checkRepeated(
    findings,
    route,
    "description",
    "meta descriptions",
    signals.descriptions.map((signal) => signal.value),
  );
  checkRepeated(
    findings,
    route,
    "canonical",
    "canonical links",
    signals.canonicals.map(
      (signal) => normalizedUrl(signal.value, snapshot.finalUrl) ?? signal.value,
    ),
  );
  if (signals.h1s.length > 1) {
    pushFinding(findings, {
      code: "multiple-h1",
      severity: "warning",
      url: route.url,
      message: "The server-rendered HTML has more than one H1.",
      evidence: { count: signals.h1s.length },
    });
  }

  const robotValues = signals.robots.map(
    (signal) => `${signal.audience}:${signal.value.toLowerCase()}`,
  );
  checkRepeated(findings, route, "robots", "robots directives", robotValues);
  if (directives(snapshot).has("noindex")) {
    pushFinding(findings, {
      code: "noindex",
      severity: "info",
      url: route.url,
      message: "The route tells search engines not to index it.",
    });
  }

  const duplicateLanguages = new Map<string, number>();
  for (const alternate of signals.hreflangs) {
    const key = alternate.language.toLowerCase();
    duplicateLanguages.set(key, (duplicateLanguages.get(key) ?? 0) + 1);
    if (key !== "x-default" && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(key)) {
      pushFinding(findings, {
        code: "invalid-hreflang",
        severity: "warning",
        url: route.url,
        message: `The route uses an invalid-looking hreflang value: ${alternate.language}.`,
      });
    }
  }
  for (const [language, count] of duplicateLanguages) {
    if (count < 2) continue;
    pushFinding(findings, {
      code: "duplicate-hreflang",
      severity: "warning",
      url: route.url,
      message: `The route declares ${language} more than once.`,
      evidence: { language, count },
    });
  }

  checkRenderedEvidence(findings, route, snapshot);
}

function checkRenderedEvidence(
  findings: Finding[],
  route: RouteNode,
  snapshot: PageSnapshot,
): void {
  const raw = snapshot.content;
  const rendered = route.rendered;
  if (rendered === undefined) {
    if (
      raw !== undefined &&
      raw.characters <= 20 &&
      snapshot.signals.titles.length === 0 &&
      snapshot.signals.h1s.length === 0
    ) {
      pushFinding(findings, {
        code: "empty-ssr-shell",
        severity: "warning",
        url: route.url,
        message: "The server response contains almost no body text or primary page signals.",
        evidence: { ssrCharacters: raw.characters, ssrWords: raw.words },
      });
    }
    return;
  }

  if (rendered.completion !== "complete") {
    pushFinding(findings, {
      code: "rendered-capture-incomplete",
      severity: "warning",
      url: route.url,
      message: `The browser-rendered comparison was incomplete (${rendered.completion}).`,
    });
    return;
  }

  if (rendered.status !== snapshot.status) {
    const ssrSuccessful =
      snapshot.status !== undefined && snapshot.status >= 200 && snapshot.status < 300;
    const renderedSuccessful =
      rendered.status !== undefined && rendered.status >= 200 && rendered.status < 300;
    pushFinding(findings, {
      code: "rendered-status-mismatch",
      severity: ssrSuccessful === renderedSuccessful ? "warning" : "error",
      url: route.url,
      message: "The browser navigation and server capture returned different HTTP statuses.",
      evidence: {
        ssrStatus: snapshot.status ?? "<missing>",
        renderedStatus: rendered.status ?? "<missing>",
      },
    });
    if (!renderedSuccessful) return;
  }

  const hydrated = rendered.content;
  if (
    raw !== undefined &&
    hydrated !== undefined &&
    raw.characters < 80 &&
    hydrated.characters >= Math.max(200, raw.characters * 3)
  ) {
    pushFinding(findings, {
      code: "client-only-content",
      severity: "error",
      url: route.url,
      message: "Most visible page content appears only after JavaScript runs.",
      evidence: {
        ssrCharacters: raw.characters,
        renderedCharacters: hydrated.characters,
        ssrWords: raw.words,
        renderedWords: hydrated.words,
      },
    });
  }
  if (snapshot.signals.titles.length === 0 && rendered.signals.titles.length > 0) {
    pushFinding(findings, {
      code: "rendered-only-title",
      severity: "error",
      url: route.url,
      message:
        "The title appears only after JavaScript runs and is absent from the server response.",
    });
  }
  if (snapshot.signals.canonicals.length === 0 && rendered.signals.canonicals.length > 0) {
    pushFinding(findings, {
      code: "rendered-only-canonical",
      severity: "error",
      url: route.url,
      message: "The canonical link appears only after JavaScript runs.",
    });
  }
  if (snapshot.signals.h1s.length === 0 && rendered.signals.h1s.length > 0) {
    pushFinding(findings, {
      code: "rendered-only-h1",
      severity: "warning",
      url: route.url,
      message: "The primary heading appears only after JavaScript runs.",
    });
  }
}

function evidenceValue(value: string | number | undefined): string | number {
  return value ?? "<missing>";
}

function agentPairEvidence(
  primary: PageSnapshot,
  compared: PageSnapshot,
  values: Readonly<Record<string, string | number | boolean>> = {},
): Readonly<Record<string, string | number | boolean>> {
  return {
    primaryAgent: primary.agent.key,
    comparedAgent: compared.agent.key,
    ...values,
  };
}

function normalizedSignal(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizedText(value);
}

function redirectSignature(snapshot: PageSnapshot): string {
  return snapshot.redirects.map((hop) => `${hop.status}:${hop.url}->${hop.location}`).join("|");
}

function statusMismatchSeverity(
  primary: number | undefined,
  compared: number | undefined,
): Severity {
  const primaryHealthy = primary !== undefined && primary >= 200 && primary < 400;
  const comparedHealthy = compared !== undefined && compared >= 200 && compared < 400;
  return primaryHealthy !== comparedHealthy ? "error" : "warning";
}

function comparableHtml(snapshot: PageSnapshot): boolean {
  return (
    getSnapshotIndexability(snapshot) !== "unknown" &&
    (snapshot.contentType === undefined ||
      /^(text\/html|application\/xhtml\+xml)\b/i.test(snapshot.contentType))
  );
}

/** Compare every secondary response with the primary agent's SSR response. */
function checkAgentDifferences(findings: Finding[], route: RouteNode): void {
  const primary = primarySnapshot(route);
  if (primary === undefined || route.snapshots.length < 2) return;

  for (const compared of route.snapshots.slice(1)) {
    if (compared.completion !== "complete") {
      pushFinding(findings, {
        code: "agent-incomplete-fetch",
        severity:
          compared.completion === "max-bytes-exceeded" || compared.completion === "robots-blocked"
            ? "warning"
            : "error",
        url: route.url,
        message: `${compared.agent.label} did not return complete evidence (${compared.completion}).`,
        evidence: agentPairEvidence(primary, compared, {
          completion: compared.completion,
          bytesRead: compared.bytesRead,
        }),
      });
    }

    if (primary.completion !== compared.completion) {
      const robotsMismatch =
        (primary.completion === "robots-blocked") !== (compared.completion === "robots-blocked");
      pushFinding(findings, {
        code: "agent-fetch-mismatch",
        severity: robotsMismatch ? "error" : "warning",
        url: route.url,
        message: `${primary.agent.label} and ${compared.agent.label} have different fetch outcomes.`,
        evidence: agentPairEvidence(primary, compared, {
          primaryCompletion: primary.completion,
          comparedCompletion: compared.completion,
        }),
      });
    }

    if (primary.completion !== "complete" || compared.completion !== "complete") continue;

    if (primary.status !== compared.status) {
      pushFinding(findings, {
        code: "agent-status-mismatch",
        severity: statusMismatchSeverity(primary.status, compared.status),
        url: route.url,
        message: `${primary.agent.label} and ${compared.agent.label} receive different HTTP statuses.`,
        evidence: agentPairEvidence(primary, compared, {
          primaryStatus: evidenceValue(primary.status),
          comparedStatus: evidenceValue(compared.status),
        }),
      });
    }

    const primaryRedirects = redirectSignature(primary);
    const comparedRedirects = redirectSignature(compared);
    if (primary.finalUrl !== compared.finalUrl || primaryRedirects !== comparedRedirects) {
      pushFinding(findings, {
        code: "agent-redirect-mismatch",
        severity: "warning",
        url: route.url,
        relatedUrls: [...new Set([primary.finalUrl, compared.finalUrl])],
        message: `${primary.agent.label} and ${compared.agent.label} follow different redirect paths.`,
        evidence: agentPairEvidence(primary, compared, {
          primaryHops: primary.redirects.length,
          comparedHops: compared.redirects.length,
        }),
      });
    }

    const primaryContentType = primary.contentType?.toLowerCase();
    const comparedContentType = compared.contentType?.toLowerCase();
    if (primaryContentType !== comparedContentType) {
      pushFinding(findings, {
        code: "agent-content-type-mismatch",
        severity: "warning",
        url: route.url,
        message: `${primary.agent.label} and ${compared.agent.label} receive different content types.`,
        evidence: agentPairEvidence(primary, compared, {
          primaryContentType: evidenceValue(primaryContentType),
          comparedContentType: evidenceValue(comparedContentType),
        }),
      });
    }

    if (!comparableHtml(primary) || !comparableHtml(compared)) continue;

    const primaryTitle = normalizedSignal(primary.signals.titles[0]?.value);
    const comparedTitle = normalizedSignal(compared.signals.titles[0]?.value);
    if (primaryTitle !== comparedTitle) {
      pushFinding(findings, {
        code: "agent-title-mismatch",
        severity: "warning",
        url: route.url,
        message: `${primary.agent.label} and ${compared.agent.label} receive different titles.`,
        evidence: agentPairEvidence(primary, compared, {
          primaryTitle: evidenceValue(primaryTitle),
          comparedTitle: evidenceValue(comparedTitle),
        }),
      });
    }

    const primaryDescription = normalizedSignal(primary.signals.descriptions[0]?.value);
    const comparedDescription = normalizedSignal(compared.signals.descriptions[0]?.value);
    if (primaryDescription !== comparedDescription) {
      pushFinding(findings, {
        code: "agent-description-mismatch",
        severity: "warning",
        url: route.url,
        message: `${primary.agent.label} and ${compared.agent.label} receive different meta descriptions.`,
        evidence: agentPairEvidence(primary, compared, {
          primaryDescription: evidenceValue(primaryDescription),
          comparedDescription: evidenceValue(comparedDescription),
        }),
      });
    }

    const primaryCanonical = snapshotCanonicalUrl(primary);
    const comparedCanonical = snapshotCanonicalUrl(compared);
    if (primaryCanonical !== comparedCanonical) {
      pushFinding(findings, {
        code: "agent-canonical-mismatch",
        severity: "warning",
        url: route.url,
        relatedUrls: [primaryCanonical, comparedCanonical].filter(
          (value): value is string => value !== undefined,
        ),
        message: `${primary.agent.label} and ${compared.agent.label} receive different canonicals.`,
        evidence: agentPairEvidence(primary, compared, {
          primaryCanonical: evidenceValue(primaryCanonical),
          comparedCanonical: evidenceValue(comparedCanonical),
        }),
      });
    }

    const primaryRobots = [...directives(primary)].sort().join(",") || "<none>";
    const comparedRobots = [...directives(compared)].sort().join(",") || "<none>";
    if (primaryRobots !== comparedRobots) {
      const indexabilityChanged =
        getSnapshotIndexability(primary) !== getSnapshotIndexability(compared);
      pushFinding(findings, {
        code: "agent-robots-mismatch",
        severity: indexabilityChanged ? "error" : "warning",
        url: route.url,
        message: `${primary.agent.label} and ${compared.agent.label} receive different robots directives.`,
        evidence: agentPairEvidence(primary, compared, {
          primaryRobots,
          comparedRobots,
        }),
      });
    }
  }
}

function checkGraph(input: AuditInput, findings: Finding[]): void {
  const byUrl = new Map(input.routes.map((route) => [route.url, route]));
  const baseOrigin = new URL(input.baseUrl).origin;

  for (const route of input.routes) {
    const routeOptions = optionsForRoute(input.options, route.url);
    const snapshot = primarySnapshot(route);
    const indexability = getIndexability(route);
    const canonical = canonicalUrl(route);

    if (route.depth >= 0 && route.depth > routeOptions.maxDepth && indexability === "indexable") {
      pushFinding(findings, {
        code: "deep-route",
        severity: "warning",
        url: route.url,
        message: `The shortest discovered path is ${route.depth} clicks deep.`,
        evidence: { depth: route.depth, recommendedMax: routeOptions.maxDepth },
      });
    }

    if (
      route.depth < 0 &&
      route.url !== input.baseUrl &&
      (route.sitemap !== undefined || route.build !== undefined) &&
      indexability === "indexable"
    ) {
      pushFinding(findings, {
        code: "orphan-route",
        severity: "warning",
        url: route.url,
        message: "This indexable route was found outside the internal link graph.",
      });
    }

    if (route.outbound.length === 0 && indexability === "indexable") {
      pushFinding(findings, {
        code: "dead-end-route",
        severity: "info",
        url: route.url,
        message: "This indexable route has no crawlable internal links.",
      });
    }

    if (
      routeOptions.requireSitemapCoverage &&
      indexability === "indexable" &&
      route.sitemap === undefined
    ) {
      pushFinding(findings, {
        code: "not-in-sitemap",
        severity: "warning",
        url: route.url,
        message: "This indexable route is not present in a fetched sitemap.",
      });
    }

    if (route.sitemap !== undefined) {
      if (snapshot?.completion === "complete" && snapshot.redirects.length > 0) {
        pushFinding(findings, {
          code: "sitemap-redirect",
          severity: "error",
          url: route.url,
          relatedUrls: [snapshot.finalUrl],
          message: "A sitemap URL redirects instead of returning its canonical page directly.",
        });
      }
      if (
        snapshot?.completion === "complete" &&
        snapshot.status !== undefined &&
        snapshot.status >= 400
      ) {
        pushFinding(findings, {
          code: "sitemap-broken-url",
          severity: "error",
          url: route.url,
          message: `A sitemap URL returns HTTP ${snapshot.status}.`,
          evidence: { status: snapshot.status },
        });
      }
      if (indexability === "noindex") {
        pushFinding(findings, {
          code: "sitemap-noindex",
          severity: "error",
          url: route.url,
          message: "A sitemap URL is marked noindex.",
        });
      }
      if (snapshot?.completion === "robots-blocked") {
        pushFinding(findings, {
          code: "sitemap-robots-blocked",
          severity: "error",
          url: route.url,
          message: "A sitemap URL is blocked by robots.txt.",
        });
      }
    }

    if (canonical !== undefined) {
      if (
        snapshot !== undefined &&
        canonical !== normalizedUrl(snapshot.finalUrl, snapshot.finalUrl)
      ) {
        pushFinding(findings, {
          code: "non-self-canonical",
          severity: "warning",
          url: route.url,
          relatedUrls: [canonical],
          message: `The route canonicalizes to ${canonical}.`,
        });
      }
      const canonicalTarget = byUrl.get(canonical);
      if (new URL(canonical).origin === baseOrigin && canonicalTarget === undefined) {
        pushFinding(findings, {
          code: "canonical-target-unseen",
          severity: input.truncated ? "info" : "warning",
          url: route.url,
          relatedUrls: [canonical],
          message: input.truncated
            ? "The internal canonical target was not fetched before the page budget was reached."
            : "The internal canonical target was not discovered.",
        });
      }
      if (canonicalTarget !== undefined) {
        const targetSnapshot = primarySnapshot(canonicalTarget);
        if (
          targetSnapshot?.completion === "complete" &&
          targetSnapshot.status !== undefined &&
          targetSnapshot.status >= 400
        ) {
          pushFinding(findings, {
            code: "broken-canonical-target",
            severity: "error",
            url: route.url,
            relatedUrls: [canonicalTarget.url],
            message: `The canonical target returns HTTP ${targetSnapshot.status}.`,
          });
        }
        if (targetSnapshot?.completion === "complete" && targetSnapshot.redirects.length > 0) {
          pushFinding(findings, {
            code: "redirecting-canonical-target",
            severity: "warning",
            url: route.url,
            relatedUrls: [canonicalTarget.url, targetSnapshot.finalUrl],
            message: "The canonical points to a URL that redirects.",
          });
        }
        if (getIndexability(canonicalTarget) === "noindex") {
          pushFinding(findings, {
            code: "noindex-canonical-target",
            severity: "error",
            url: route.url,
            relatedUrls: [canonicalTarget.url],
            message: "The canonical target is marked noindex.",
          });
        }
      }
    }

    for (const targetUrl of route.outbound) {
      const target = byUrl.get(targetUrl);
      if (target === undefined) continue;
      const targetSnapshot = primarySnapshot(target);
      if (
        targetSnapshot?.completion === "complete" &&
        targetSnapshot.status !== undefined &&
        targetSnapshot.status >= 400
      ) {
        pushFinding(findings, {
          code: "broken-internal-link",
          severity: "error",
          url: route.url,
          relatedUrls: [targetUrl],
          message: `An internal link points to a URL returning HTTP ${targetSnapshot.status}.`,
          evidence: { status: targetSnapshot.status },
        });
      } else if (targetSnapshot?.completion === "complete" && targetSnapshot.redirects.length > 0) {
        pushFinding(findings, {
          code: "redirecting-internal-link",
          severity: "warning",
          url: route.url,
          relatedUrls: [targetUrl, targetSnapshot.finalUrl],
          message: "An internal link points to a redirect.",
        });
      } else if (getIndexability(target) === "noindex") {
        pushFinding(findings, {
          code: "internal-link-to-noindex",
          severity: "warning",
          url: route.url,
          relatedUrls: [targetUrl],
          message: "An internal link points to a noindex route.",
        });
      }
    }

    if (snapshot?.completion === "complete") {
      for (const alternate of snapshot.signals.hreflangs) {
        const alternateUrl =
          alternate.resolvedUrl ?? normalizedUrl(alternate.href, snapshot.finalUrl);
        if (alternateUrl === undefined || new URL(alternateUrl).origin !== baseOrigin) continue;
        const target = byUrl.get(alternateUrl);
        if (target === undefined) {
          pushFinding(findings, {
            code: "hreflang-target-unseen",
            severity: input.truncated ? "info" : "warning",
            url: route.url,
            relatedUrls: [alternateUrl],
            message: "An internal hreflang target was not discovered.",
          });
          continue;
        }
        if (getIndexability(target) === "noindex") {
          pushFinding(findings, {
            code: "hreflang-target-noindex",
            severity: "error",
            url: route.url,
            relatedUrls: [alternateUrl],
            message: "An hreflang target is marked noindex.",
          });
        }
        const targetSnapshot = primarySnapshot(target);
        if (targetSnapshot?.completion !== "complete") continue;
        const returnsLink = targetSnapshot?.signals.hreflangs.some((candidate) => {
          const resolved =
            candidate.resolvedUrl ?? normalizedUrl(candidate.href, targetSnapshot.finalUrl);
          return resolved === route.url;
        });
        if (returnsLink !== true) {
          pushFinding(findings, {
            code: "hreflang-missing-return-link",
            severity: "warning",
            url: route.url,
            relatedUrls: [alternateUrl],
            message: "An hreflang target does not link back to this route.",
          });
        }
      }
    }
  }
}

function checkDuplicates(routes: readonly RouteNode[], findings: Finding[]): void {
  const canonicalGroups = new Map<string, string[]>();
  const titleGroups = new Map<string, string[]>();
  const descriptionGroups = new Map<string, string[]>();
  const contentGroups = new Map<string, string[]>();

  for (const route of routes) {
    if (getIndexability(route) !== "indexable") continue;
    const snapshot = primarySnapshot(route);
    const canonical = canonicalUrl(route);
    if (canonical !== undefined) {
      const list = canonicalGroups.get(canonical) ?? [];
      list.push(route.url);
      canonicalGroups.set(canonical, list);
    }
    const title = snapshot?.signals.titles[0]?.value;
    if (title !== undefined && normalizedText(title).length > 0) {
      const key = normalizedText(title).toLowerCase();
      const list = titleGroups.get(key) ?? [];
      list.push(route.url);
      titleGroups.set(key, list);
    }
    const description = snapshot?.signals.descriptions[0]?.value;
    if (description !== undefined && normalizedText(description).length > 0) {
      const key = normalizedText(description).toLowerCase();
      const list = descriptionGroups.get(key) ?? [];
      list.push(route.url);
      descriptionGroups.set(key, list);
    }
    if ((snapshot?.content?.words ?? 0) >= 20 && snapshot?.content?.sha256 !== undefined) {
      const list = contentGroups.get(snapshot.content.sha256) ?? [];
      list.push(route.url);
      contentGroups.set(snapshot.content.sha256, list);
    }
  }

  const reportGroups = (
    groups: ReadonlyMap<string, readonly string[]>,
    code: string,
    message: string,
  ): void => {
    for (const urls of groups.values()) {
      if (urls.length < 2) continue;
      pushFinding(findings, {
        code,
        severity: "warning",
        ...(urls[0] === undefined ? {} : { url: urls[0] }),
        relatedUrls: urls.slice(1),
        message,
        evidence: { routes: urls.length },
      });
    }
  };

  reportGroups(
    canonicalGroups,
    "duplicate-canonical-target",
    "Multiple indexable routes declare the same canonical target.",
  );
  reportGroups(
    titleGroups,
    "duplicate-title-across-routes",
    "Multiple indexable routes use the same title.",
  );
  reportGroups(
    descriptionGroups,
    "duplicate-description-across-routes",
    "Multiple indexable routes use the same meta description.",
  );
  reportGroups(
    contentGroups,
    "duplicate-content-across-routes",
    "Multiple indexable routes return the same normalized server-rendered body text.",
  );

  const variants = new Map<string, string[]>();
  for (const route of routes) {
    const url = new URL(route.url);
    const pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/$/, "");
    const signature = `${url.origin}${pathname.toLowerCase()}${url.search}`;
    const list = variants.get(signature) ?? [];
    list.push(route.url);
    variants.set(signature, list);
  }
  reportGroups(
    variants,
    "route-case-or-slash-variant",
    "Several discovered URLs differ only by case or a trailing slash.",
  );
}

function isSuccessfulHtml(snapshot: PageSnapshot | undefined): snapshot is PageSnapshot {
  return (
    snapshot !== undefined &&
    snapshot.completion === "complete" &&
    snapshot.status !== undefined &&
    snapshot.status >= 200 &&
    snapshot.status < 300 &&
    snapshot.redirects.length === 0 &&
    (snapshot.contentType === undefined ||
      /^(text\/html|application\/xhtml\+xml)\b/i.test(snapshot.contentType))
  );
}

function checkSoft404s(routes: readonly RouteNode[], findings: Finding[]): void {
  const references = routes
    .map((route) => ({ route, snapshot: primarySnapshot(route) }))
    .filter(
      (entry): entry is { route: RouteNode; snapshot: PageSnapshot } =>
        entry.snapshot !== undefined &&
        entry.snapshot.completion === "complete" &&
        (entry.snapshot.status === 404 || entry.snapshot.status === 410) &&
        entry.snapshot.content !== undefined,
    );

  for (const route of routes) {
    const snapshot = primarySnapshot(route);
    if (!isSuccessfulHtml(snapshot)) continue;
    const content = snapshot.content;
    if (content !== undefined && content.words >= 8) {
      const matched = references.find(({ snapshot: reference }) => {
        const other = reference.content;
        if (other === undefined || other.words < 8) return false;
        if (content.sha256 === other.sha256) return true;
        const ratio = content.characters / Math.max(1, other.characters);
        const distance = simhashDistance(content.simhash, other.simhash);
        return content.words >= 15 && ratio >= 0.75 && ratio <= 1.25 && (distance ?? 65) <= 3;
      });
      if (matched !== undefined) {
        const reference = matched.snapshot.content;
        const exact = reference !== undefined && content.sha256 === reference.sha256;
        pushFinding(findings, {
          code: exact ? "soft-404" : "possible-soft-404",
          severity: exact ? "error" : "warning",
          url: route.url,
          relatedUrls: [matched.route.url],
          message: exact
            ? "This successful response exactly matches a captured 404 or 410 page."
            : "This successful response is a near-duplicate of a captured 404 or 410 page.",
          evidence: {
            status: snapshot.status ?? 200,
            referenceStatus: matched.snapshot.status ?? 404,
            simhashDistance:
              reference === undefined
                ? -1
                : (simhashDistance(content.simhash, reference.simhash) ?? -1),
          },
        });
        continue;
      }
    }

    const heading = [snapshot.signals.titles[0]?.value, snapshot.signals.h1s[0]?.value]
      .filter((value): value is string => value !== undefined)
      .join(" ");
    if (
      (snapshot.content?.characters ?? 0) <= 2_000 &&
      /(?:^|\b)(?:404|page not found|not found|does not exist)(?:\b|$)/i.test(heading)
    ) {
      pushFinding(findings, {
        code: "possible-soft-404",
        severity: "warning",
        url: route.url,
        message: "This successful response uses a title or H1 that looks like a not-found page.",
        evidence: { status: snapshot.status ?? 200 },
      });
    }
  }
}

function addInventoryFindings(input: AuditInput, findings: Finding[]): void {
  for (const warning of input.sitemap.warnings) {
    pushFinding(findings, {
      code: "sitemap-warning",
      severity: "warning",
      message: warning,
    });
  }
  for (const warning of input.robots?.warnings ?? []) {
    pushFinding(findings, {
      code: "robots-warning",
      severity: "warning",
      message: warning,
      ...(input.robots === undefined ? {} : { url: input.robots.url }),
    });
  }
  for (const warning of input.build?.warnings ?? []) {
    pushFinding(findings, {
      code: "next-discovery-warning",
      severity: "warning",
      message: warning,
    });
  }
  for (const pattern of input.build?.unresolvedPatterns ?? []) {
    pushFinding(findings, {
      code: "next-dynamic-route-needs-sample",
      severity: "info",
      message: `No concrete sample was supplied for ${pattern}.`,
      evidence: { pattern },
    });
  }
  if (input.truncated) {
    pushFinding(findings, {
      code: "page-budget-reached",
      severity: "warning",
      message: "The crawl reached its page budget. Missing-target checks are conservative.",
    });
  }
}

function deduplicateFindings(findings: readonly Finding[]): Finding[] {
  const unique = new Map<string, Finding>();
  for (const finding of findings) unique.set(findingKey(finding), finding);
  return [...unique.values()].sort((left, right) => {
    return (
      SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
      (left.url ?? "").localeCompare(right.url ?? "") ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message)
    );
  });
}

function summarize(routes: readonly RouteNode[], findings: readonly Finding[]): RouteLintSummary {
  return {
    routes: routes.length,
    fetched: routes.filter((route) => route.snapshots.length > 0).length,
    indexable: routes.filter((route) => getIndexability(route) === "indexable").length,
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length,
    info: findings.filter((finding) => finding.severity === "info").length,
    brokenLinks: findings.filter((finding) => finding.code === "broken-internal-link").length,
    redirects: routes.filter((route) => (primarySnapshot(route)?.redirects.length ?? 0) > 0).length,
    noindex: routes.filter((route) => getIndexability(route) === "noindex").length,
    maxDepth: Math.max(0, ...routes.map((route) => route.depth).filter((depth) => depth >= 0)),
  };
}

export function auditSite(input: AuditInput): AuditOutput {
  const findings: Finding[] = [];
  const redirectAudit = auditRedirectContracts(
    input.routes,
    input.redirectContracts ?? [],
    input.skippedBuildRedirects ?? 0,
  );
  const redirectSources = new Set((input.redirectContracts ?? []).map((contract) => contract.from));
  addInventoryFindings(input, findings);
  findings.push(...redirectAudit.findings);
  for (const route of input.routes) {
    checkPage(findings, route, input.options, redirectSources.has(route.url));
    checkAgentDifferences(findings, route);
  }
  checkGraph(input, findings);
  checkDuplicates(input.routes, findings);
  checkSoft404s(input.routes, findings);
  const deduplicated = deduplicateFindings(applySeverityConfiguration(findings, input.options));
  return {
    findings: deduplicated,
    summary: summarize(input.routes, deduplicated),
    redirectContracts: redirectAudit.report,
  };
}

export function highestSeverity(findings: readonly Finding[]): Severity | undefined {
  return findings.reduce<Severity | undefined>((highest, finding) => {
    if (highest === undefined || SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[highest]) {
      return finding.severity;
    }
    return highest;
  }, undefined);
}

export function meetsFailureThreshold(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER[severity] <= SEVERITY_ORDER[threshold];
}

export function routeStatus(route: RouteNode): string {
  return statusLabel(primarySnapshot(route));
}
