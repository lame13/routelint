export { BUILTIN_AGENTS, resolveAgent } from "./agents.js";
export {
  auditSite,
  getIndexability,
  getSnapshotIndexability,
  highestSeverity,
  meetsFailureThreshold,
  routeStatus,
} from "./audit.js";
export { loadConfig, parseHeaderOptions } from "./config.js";
export { crawl, crawlSite, isAllowedByRobots } from "./crawl.js";
export {
  diffReports,
  parseRouteLintReport,
  readRouteLintReport,
  renderDiffJson,
  renderDiffTerminal,
} from "./diff.js";
export type {
  CandidateCollection,
  InitialCandidateOptions,
} from "./discovery/candidates.js";
export {
  buildInitialCandidates,
  mergeRouteCandidates,
  normalizeCandidateUrl,
} from "./discovery/candidates.js";
export { discoverNextBuild } from "./discovery/next.js";
export type { FetchRobotsOptions } from "./discovery/robots.js";
export {
  fetchRobots,
  isRobotsAllowed,
  parseRobotsText,
  resolveRobotsAvailability,
} from "./discovery/robots.js";
export type { FetchSitemapsOptions, ParsedSitemap } from "./discovery/sitemap.js";
export { fetchSitemaps, parseSitemapXml } from "./discovery/sitemap.js";
export { emptyPageSignals, parseHtml, parseXRobotsTag } from "./html-parser.js";
export { capturePage, captureUrl, isHtmlContentType } from "./http.js";
export { redactReport } from "./redact.js";
export {
  renderHtmlReport,
  renderJsonReport,
  renderReport,
  renderSarifReport,
  renderTerminalReport,
  stableJson,
} from "./reporters/index.js";
export { runRouteLint } from "./run.js";
export type {
  AgentProfile,
  AuditOptions,
  BuildInventory,
  BuildRedirect,
  BuildRoute,
  CrawlLimits,
  CrawlOptions,
  DiffChange,
  DiscoveredRobotsFile,
  Finding,
  HreflangSignal,
  LinkSignal,
  MetadataSignal,
  NextOptions,
  PageCompletion,
  PageSignals,
  PageSnapshot,
  QueryPolicy,
  RedirectHop,
  RenderMode,
  ReportConfigSnapshot,
  ReportFormat,
  RobotsAvailability,
  RobotsFile,
  RobotsGroup,
  RobotsRule,
  RobotsSignal,
  RobotsUnavailableReason,
  RouteCandidate,
  RouteLintConfig,
  RouteLintDiff,
  RouteLintReport,
  RouteLintSummary,
  RouteNode,
  RouteSource,
  RouteSourceKind,
  Severity,
  SitemapEntry,
  SitemapInventory,
} from "./types.js";
export { isSameOrigin, isUrlIncluded, normalizeUrl, redactErrorText, redactUrl } from "./url.js";
export { REPORT_SCHEMA_VERSION, VERSION } from "./version.js";
