export type Severity = "error" | "warning" | "info";
export type RuleSeverity = Severity | "off";
export type ReportFormat = "terminal" | "json" | "sarif" | "html";
export type QueryPolicy = "drop" | "keep";
export type RedirectStatus = 301 | 302 | 303 | 307 | 308;
export type PageCompletion =
  | "complete"
  | "max-bytes-exceeded"
  | "timeout"
  | "network-error"
  | "invalid-response"
  | "robots-blocked";
export type RouteSourceKind =
  | "seed"
  | "sitemap"
  | "internal-link"
  | "next-build"
  | "sample"
  | "url-list"
  | "redirect-contract";
export type RenderMode = "static" | "isr" | "dynamic" | "unknown";

export interface AgentProfile {
  readonly key: string;
  readonly label: string;
  readonly userAgent: string;
}

export interface RouteSource {
  readonly kind: RouteSourceKind;
  readonly from?: string;
  readonly detail?: string;
}

export interface BuildRoute {
  readonly pathname: string;
  readonly pattern?: string;
  readonly renderMode: RenderMode;
  readonly revalidateSeconds?: number | false;
  readonly sourceManifest: string;
}

export interface BuildInventory {
  readonly framework: "next";
  readonly root: string;
  readonly buildDirectory: string;
  readonly nextVersion?: string;
  readonly buildId?: string;
  readonly routes: readonly BuildRoute[];
  readonly unresolvedPatterns: readonly string[];
  readonly redirects: readonly BuildRedirect[];
  readonly warnings: readonly string[];
}

export interface BuildRedirect {
  readonly source: string;
  readonly destination: string;
  readonly status: number;
  /** Conditional redirects cannot be verified without reproducing their request matcher. */
  readonly conditional?: boolean;
}

/** An exact redirect behavior declared by configuration. */
export interface RedirectExpectation {
  readonly from: string;
  readonly to: string;
  readonly status: RedirectStatus;
  readonly maxHops: number;
}

export type RedirectContractSource = "config" | "next-build";

/** An effective redirect expectation, including its source of truth. */
export interface RedirectContract extends RedirectExpectation {
  readonly source: RedirectContractSource;
}

export type RedirectContractOutcome = "verified" | "failed" | "unchecked";
export type RedirectTargetIndexability = "indexable" | "noindex" | "unknown";

export interface RedirectContractObservation {
  readonly completion: PageCompletion | "not-fetched";
  readonly hops: readonly RedirectHop[];
  readonly finalUrl?: string;
  readonly finalStatus?: number;
  readonly targetIndexability: RedirectTargetIndexability;
}

/** Structured evidence for one redirect contract. */
export interface RedirectContractCheck {
  readonly contract: RedirectContract;
  readonly observed: RedirectContractObservation;
  readonly outcome: RedirectContractOutcome;
  readonly findingCodes: readonly string[];
}

export interface RedirectContractReport {
  readonly declared: number;
  readonly verified: number;
  readonly failed: number;
  readonly unchecked: number;
  readonly skippedBuildRedirects: number;
  readonly checks: readonly RedirectContractCheck[];
}

export interface SitemapEntry {
  readonly url: string;
  readonly sitemapUrl: string;
  readonly lastModified?: string;
  readonly alternates: readonly HreflangSignal[];
}

export interface SitemapInventory {
  readonly requested: readonly string[];
  readonly fetched: readonly string[];
  readonly entries: readonly SitemapEntry[];
  readonly warnings: readonly string[];
}

export interface RobotsRule {
  readonly directive: "allow" | "disallow";
  readonly pattern: string;
}

export interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
}

export type RobotsUnavailableReason =
  | "not-fetched"
  | "http-error"
  | "timeout"
  | "response-too-large"
  | "read-error"
  | "parse-error"
  | "network-error";

export type RobotsAvailability =
  | { readonly state: "available" }
  | { readonly state: "missing" }
  | { readonly state: "unavailable"; readonly reason: RobotsUnavailableReason };

export interface RobotsFile {
  readonly url: string;
  readonly status?: number;
  /** Optional only for compatibility with reports and callers created before availability was recorded. */
  readonly availability?: RobotsAvailability;
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
  readonly warnings: readonly string[];
}

/** A current discovery result always records whether robots.txt was usable. */
export interface DiscoveredRobotsFile extends RobotsFile {
  readonly availability: RobotsAvailability;
}

export interface RedirectHop {
  readonly url: string;
  readonly status: number;
  readonly location: string;
  readonly durationMs: number;
}

export interface MetadataSignal {
  readonly value: string;
  readonly location: "head" | "body";
}

export interface RobotsSignal extends MetadataSignal {
  readonly audience: "robots" | "googlebot" | "bingbot";
  readonly source: "meta" | "header";
}

export interface LinkSignal {
  readonly href: string;
  readonly resolvedUrl?: string;
  readonly text: string;
  readonly rel: readonly string[];
  readonly nofollow: boolean;
}

export interface HreflangSignal {
  readonly language: string;
  readonly href: string;
  readonly resolvedUrl?: string;
}

export interface PageSignals {
  readonly titles: readonly MetadataSignal[];
  readonly descriptions: readonly MetadataSignal[];
  readonly canonicals: readonly MetadataSignal[];
  readonly robots: readonly RobotsSignal[];
  readonly h1s: readonly MetadataSignal[];
  readonly links: readonly LinkSignal[];
  readonly hreflangs: readonly HreflangSignal[];
  readonly htmlLang?: string;
  readonly baseHref?: string;
}

/** Body-text measurements and fingerprints. The normalized text itself is never stored. */
export interface PageContentEvidence {
  readonly characters: number;
  readonly words: number;
  readonly sha256: string;
  /** 64-bit SimHash encoded as 16 lowercase hexadecimal characters. */
  readonly simhash: string;
}

export interface PageSnapshot {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly agent: AgentProfile;
  readonly status?: number;
  readonly contentType?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly redirects: readonly RedirectHop[];
  readonly signals: PageSignals;
  readonly bytesRead: number;
  readonly bodySha256?: string;
  readonly content?: PageContentEvidence;
  readonly durationMs: number;
  readonly completion: PageCompletion;
  readonly error?: string;
}

export type RenderedCompletion = "complete" | "timeout" | "navigation-error" | "capture-error";

/** Evidence collected after a browser executes the page's JavaScript. */
export interface RenderedPageSnapshot {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status?: number;
  readonly completion: RenderedCompletion;
  readonly signals: PageSignals;
  readonly content?: PageContentEvidence;
  readonly htmlBytes: number;
  readonly durationMs: number;
  readonly error?: string;
}

export interface RouteNode {
  readonly url: string;
  /** Shortest internal-link distance from a seed, or -1 when no seed can reach the route. */
  readonly depth: number;
  readonly sources: readonly RouteSource[];
  readonly sitemap?: SitemapEntry;
  readonly build?: BuildRoute;
  readonly snapshots: readonly PageSnapshot[];
  readonly rendered?: RenderedPageSnapshot;
  readonly inbound: readonly string[];
  readonly outbound: readonly string[];
}

export interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly url?: string;
  readonly relatedUrls?: readonly string[];
  readonly evidence?: Readonly<Record<string, string | number | boolean>>;
}

export interface RouteLintSummary {
  readonly routes: number;
  readonly fetched: number;
  readonly indexable: number;
  readonly errors: number;
  readonly warnings: number;
  readonly info: number;
  readonly brokenLinks: number;
  readonly redirects: number;
  readonly noindex: number;
  readonly maxDepth: number;
}

export interface RouteLintReport {
  readonly schemaVersion: string;
  readonly toolVersion: string;
  readonly generatedAt: string;
  readonly durationMs: number;
  readonly baseUrl: string;
  readonly config: ReportConfigSnapshot;
  readonly inputs?: InputInventory;
  readonly build?: BuildInventory;
  readonly redirectContracts?: RedirectContractReport;
  readonly sitemap: SitemapInventory;
  readonly robots?: RobotsFile;
  readonly routes: readonly RouteNode[];
  readonly findings: readonly Finding[];
  readonly summary: RouteLintSummary;
  readonly truncated: boolean;
  readonly comparison?: ChangedOnlyComparison;
}

export interface InputInventory {
  readonly urlListFiles: number;
  readonly urlListUrls: number;
  readonly warnings: readonly string[];
}

export interface ChangedOnlyComparison {
  readonly mode: "changed-only";
  readonly baselineGeneratedAt: string;
  readonly newFindings: number;
  readonly worsenedFindings: number;
  readonly resolvedFindings: number;
  readonly unchangedFindings: number;
}

export interface ReportConfigSnapshot {
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly agents: readonly string[];
  readonly respectRobots: boolean;
  readonly queryPolicy: QueryPolicy;
  readonly seeds?: readonly string[];
  readonly sitemapMode?: "auto" | "explicit";
  readonly sitemapUrls?: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly rendered?: boolean;
  readonly renderedConcurrency?: number;
  readonly renderedTimeoutMs?: number;
  readonly renderedSettleMs?: number;
  readonly headerNames?: readonly string[];
  readonly urlListFiles?: number;
  readonly redirects?: readonly RedirectExpectation[];
  readonly audit?: AuditOptions;
}

export interface CrawlLimits {
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
}

export interface CrawlOptions extends CrawlLimits {
  readonly baseUrl: string;
  readonly seeds: readonly string[];
  readonly candidates: readonly RouteCandidate[];
  readonly agents: readonly AgentProfile[];
  readonly headers: Readonly<Record<string, string>>;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly queryPolicy: QueryPolicy;
  readonly respectRobots: boolean;
  readonly robots?: RobotsFile;
}

export interface RouteCandidate {
  readonly url: string;
  readonly depth: number;
  readonly sources: readonly RouteSource[];
  readonly sitemap?: SitemapEntry;
  readonly build?: BuildRoute;
}

export interface AuditOptions {
  readonly requireTitle: boolean;
  readonly requireDescription: boolean;
  readonly requireCanonical: boolean;
  readonly requireH1: boolean;
  readonly requireSitemapCoverage: boolean;
  readonly maxDepth: number;
  readonly severities?: Readonly<Record<string, RuleSeverity>>;
  readonly paths?: readonly PathAuditOptions[];
}

export interface PathAuditOptions {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly requireTitle?: boolean;
  readonly requireDescription?: boolean;
  readonly requireCanonical?: boolean;
  readonly requireH1?: boolean;
  readonly requireSitemapCoverage?: boolean;
  readonly maxDepth?: number;
  readonly severities?: Readonly<Record<string, RuleSeverity>>;
}

export interface RenderedOptions {
  readonly enabled: boolean;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly settleMs: number;
}

export interface NextOptions {
  readonly root: string;
  readonly buildDirectory: string;
  readonly samples: Readonly<Record<string, readonly string[]>>;
}

export interface RouteLintConfig {
  readonly baseUrl: string;
  readonly seeds: readonly string[];
  readonly urlFiles?: readonly string[];
  readonly sitemaps: "auto" | readonly string[];
  readonly agents: readonly AgentProfile[];
  readonly headers: Readonly<Record<string, string>>;
  readonly redirects?: readonly RedirectExpectation[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly queryPolicy: QueryPolicy;
  readonly respectRobots: boolean;
  readonly limits: CrawlLimits;
  readonly audit: AuditOptions;
  readonly rendered?: RenderedOptions;
  readonly next?: NextOptions;
}

export interface DiffChange {
  readonly kind: "added" | "removed" | "changed";
  readonly code: string;
  readonly severity: Severity;
  readonly url?: string;
  readonly message: string;
  readonly before?: string | number | boolean;
  readonly after?: string | number | boolean;
}

export interface RouteLintDiff {
  readonly schemaVersion: string;
  readonly generatedAt: string;
  readonly baselineGeneratedAt: string;
  readonly currentGeneratedAt: string;
  readonly changes: readonly DiffChange[];
  readonly summary: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly errors: number;
    readonly warnings: number;
    readonly info: number;
  };
}
