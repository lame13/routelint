import { getSnapshotIndexability } from "../audit.js";
import type { Finding, PageCompletion, RouteLintReport, RouteNode, Severity } from "../types.js";

const GRAPH_ROUTE_LIMIT = 120;
const GRAPH_EDGE_LIMIT = 500;

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

function escapeHtml(value: string | number | boolean): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function compareFindings(left: Finding, right: Finding): number {
  return (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    left.code.localeCompare(right.code) ||
    (left.url ?? "").localeCompare(right.url ?? "") ||
    left.message.localeCompare(right.message)
  );
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(2)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}${url.hash}` || "/";
  } catch {
    return value;
  }
}

function shortLabel(value: string, length = 28): string {
  const characters = [...displayUrl(value)];
  return characters.length <= length
    ? characters.join("")
    : `${characters.slice(0, length - 1).join("")}…`;
}

function routeCompletions(route: RouteNode): readonly (PageCompletion | "not-fetched")[] {
  if (route.snapshots.length === 0) return ["not-fetched"];
  return [...new Set(route.snapshots.map((snapshot) => snapshot.completion))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function routeEvidence(route: RouteNode): { readonly complete: boolean; readonly label: string } {
  const completions = routeCompletions(route);
  const complete = completions.length === 1 && completions[0] === "complete";
  const label =
    route.snapshots.length < 2
      ? completions.join(", ")
      : route.snapshots
          .map((snapshot) => `${snapshot.agent.label}: ${snapshot.completion}`)
          .join(" · ");
  return { complete, label };
}

function routeStatuses(route: RouteNode): string {
  if (route.snapshots.length > 1) {
    return route.snapshots
      .map(
        (snapshot) =>
          `${snapshot.agent.label}: ${snapshot.status === undefined ? "—" : snapshot.status}`,
      )
      .join(" · ");
  }
  const statuses = [
    ...new Set(
      route.snapshots
        .map((snapshot) => snapshot.status)
        .filter((status): status is number => status !== undefined),
    ),
  ].sort((left, right) => left - right);
  return statuses.length === 0 ? "—" : statuses.join(" / ");
}

function indexingSignal(route: RouteNode): string {
  if (route.snapshots.length === 0) return "Unknown — not fetched";
  const values = route.snapshots.map((snapshot) => ({
    label: snapshot.agent.label,
    indexability: getSnapshotIndexability(snapshot),
  }));
  if (values.length === 1) return values[0]?.indexability ?? "unknown";
  return values.map((value) => `${value.label}: ${value.indexability}`).join(" · ");
}

function findingCountsByUrl(findings: readonly Finding[]): ReadonlyMap<string, readonly Finding[]> {
  const byUrl = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (finding.url === undefined) continue;
    const current = byUrl.get(finding.url) ?? [];
    current.push(finding);
    byUrl.set(finding.url, current);
  }
  return byUrl;
}

function highestSeverity(findings: readonly Finding[]): Severity | undefined {
  return findings.slice().sort(compareFindings)[0]?.severity;
}

function severityBadge(severity: Severity, label: string = severity): string {
  return `<span class="badge badge-${severity}">${escapeHtml(label)}</span>`;
}

function summaryCard(label: string, value: number, detail: string): string {
  return `<div class="summary-card">
    <dt>${escapeHtml(label)}</dt>
    <dd>${escapeHtml(value.toLocaleString("en-US"))}</dd>
    <dd class="summary-detail">${escapeHtml(detail)}</dd>
  </div>`;
}

interface GraphNode {
  readonly route: RouteNode;
  readonly x: number;
  readonly y: number;
  readonly severity: Severity | undefined;
  readonly complete: boolean;
}

function depthOrder(depth: number): number {
  return depth < 0 ? Number.MAX_SAFE_INTEGER : depth;
}

function depthLabel(depth: number): string {
  return depth < 0 ? "Unlinked" : String(depth);
}

function compareRouteDepth(left: RouteNode, right: RouteNode): number {
  return depthOrder(left.depth) - depthOrder(right.depth) || left.url.localeCompare(right.url);
}

function renderGraph(
  report: RouteLintReport,
  findingsByUrl: ReadonlyMap<string, readonly Finding[]>,
): string {
  const sortedRoutes = report.routes.slice().sort(compareRouteDepth);
  const routes = sortedRoutes.slice(0, GRAPH_ROUTE_LIMIT);
  const depths = [...new Set(routes.map((route) => route.depth))].sort(
    (left, right) => depthOrder(left) - depthOrder(right),
  );
  const depthIndexes = new Map(depths.map((depth, index) => [depth, index]));
  const perDepth = new Map<number, number>();
  const nodes: GraphNode[] = routes.map((route) => {
    const index = perDepth.get(route.depth) ?? 0;
    perDepth.set(route.depth, index + 1);
    return {
      route,
      x: 34 + (depthIndexes.get(route.depth) ?? 0) * 230,
      y: 42 + index * 54,
      severity: highestSeverity(findingsByUrl.get(route.url) ?? []),
      complete: routeEvidence(route).complete,
    };
  });
  const nodesByUrl = new Map(nodes.map((node) => [node.route.url, node]));
  const allEdges = nodes.flatMap((source) =>
    source.route.outbound.flatMap((url) => {
      const target = nodesByUrl.get(url);
      return target === undefined ? [] : [{ source, target }];
    }),
  );
  const edges = allEdges.slice(0, GRAPH_EDGE_LIMIT);
  const width = Math.max(760, depths.length * 230 + 44);
  const tallestColumn = Math.max(1, ...perDepth.values());
  const height = Math.max(260, tallestColumn * 54 + 54);
  const omittedRoutes = sortedRoutes.length - routes.length;
  const omittedEdges = allEdges.length - edges.length;

  if (nodes.length === 0) {
    return `<div class="empty-state">No routes were available for the graph.</div>`;
  }

  const edgeMarkup = edges
    .map(
      ({ source, target }) =>
        `<line class="graph-edge" x1="${source.x + 96}" y1="${source.y + 17}" x2="${target.x + 96}" y2="${target.y + 17}" marker-end="url(#arrow)" />`,
    )
    .join("\n");
  const nodeMarkup = nodes
    .map((node) => {
      const statusClass =
        node.severity === undefined ? (node.complete ? "clean" : "incomplete") : node.severity;
      const fullLabel = `${node.route.url}; ${
        node.route.depth < 0 ? "not reachable from a seed" : `depth ${node.route.depth}`
      }; ${node.severity === undefined ? "no route finding" : `${node.severity} finding`}`;
      return `<g class="graph-node graph-${statusClass}" role="listitem" aria-label="${escapeHtml(fullLabel)}">
        <title>${escapeHtml(fullLabel)}</title>
        <rect x="${node.x}" y="${node.y}" width="192" height="34" rx="6" />
        <text x="${node.x + 10}" y="${node.y + 21}">${escapeHtml(shortLabel(node.route.url))}</text>
      </g>`;
    })
    .join("\n");
  const omissions = [
    omittedRoutes > 0 ? `${omittedRoutes} deeper routes` : undefined,
    omittedEdges > 0 ? `${omittedEdges} edges` : undefined,
  ].filter((value): value is string => value !== undefined);
  const graphNote =
    omissions.length === 0
      ? `All ${routes.length.toLocaleString("en-US")} routes are shown.`
      : `Graph omits ${omissions.join(" and ")} for readability. The tables below remain complete.`;

  return `<p class="section-note">${escapeHtml(graphNote)}</p>
  <div class="graph-scroll" tabindex="0" aria-label="Scrollable route graph">
    <svg class="route-graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="graph-title graph-description">
      <title id="graph-title">Internal route graph</title>
      <desc id="graph-description">Routes are grouped by crawl depth, with routes that cannot be reached from a seed in a separate column. Lines represent internal links. Node color indicates the most severe finding or incomplete evidence.</desc>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      <g class="graph-edges" aria-hidden="true">${edgeMarkup}</g>
      <g role="list">${nodeMarkup}</g>
    </svg>
  </div>`;
}

function renderRouteRows(
  report: RouteLintReport,
  findingsByUrl: ReadonlyMap<string, readonly Finding[]>,
): string {
  return report.routes
    .slice()
    .sort(compareRouteDepth)
    .map((route) => {
      const findings = findingsByUrl.get(route.url) ?? [];
      const severity = highestSeverity(findings);
      const evidence = routeEvidence(route);
      const findingLabel =
        findings.length === 0
          ? "None"
          : `${severityBadge(severity ?? "info", String(findings.length))}<span class="sr-only"> findings</span>`;
      return `<tr data-route-row>
        <th scope="row"><code class="url-value">${escapeHtml(route.url)}</code></th>
        <td>${escapeHtml(depthLabel(route.depth))}</td>
        <td>${escapeHtml(routeStatuses(route))}</td>
        <td><span class="evidence-${evidence.complete ? "complete" : "incomplete"}">${escapeHtml(evidence.label)}</span></td>
        <td>${escapeHtml(indexingSignal(route))}</td>
        <td>${escapeHtml(route.inbound.length)} / ${escapeHtml(route.outbound.length)}</td>
        <td>${findingLabel}</td>
      </tr>`;
    })
    .join("\n");
}

function evidenceMarkup(finding: Finding): string {
  const entries = Object.entries(finding.evidence ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return "—";
  return `<dl class="evidence-list">${entries
    .map(
      ([key, value]) =>
        `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd></div>`,
    )
    .join("")}</dl>`;
}

function relatedMarkup(finding: Finding): string {
  const related = (finding.relatedUrls ?? [])
    .slice()
    .sort((left, right) => left.localeCompare(right));
  if (related.length === 0) return "";
  return `<details class="related"><summary>${escapeHtml(related.length)} related route${related.length === 1 ? "" : "s"}</summary><ul>${related
    .map((url) => `<li><code class="url-value">${escapeHtml(url)}</code></li>`)
    .join("")}</ul></details>`;
}

function renderFindingRows(findings: readonly Finding[]): string {
  return findings
    .slice()
    .sort(compareFindings)
    .map(
      (finding) => `<tr data-finding-row data-severity="${finding.severity}">
        <td>${severityBadge(finding.severity)}</td>
        <td><code>${escapeHtml(finding.code)}</code></td>
        <td>${
          finding.url === undefined
            ? '<span class="muted">Site-wide</span>'
            : `<code class="url-value">${escapeHtml(finding.url)}</code>`
        }</td>
        <td><p class="finding-message">${escapeHtml(finding.message)}</p>${relatedMarkup(finding)}</td>
        <td>${evidenceMarkup(finding)}</td>
      </tr>`,
    )
    .join("\n");
}

function incompleteSummary(report: RouteLintReport): {
  readonly routes: number;
  readonly reasons: readonly string[];
} {
  const counts = new Map<PageCompletion | "not-fetched", number>();
  let routes = 0;
  for (const route of report.routes) {
    const incomplete = routeCompletions(route).filter((completion) => completion !== "complete");
    if (incomplete.length === 0) continue;
    routes += 1;
    for (const completion of incomplete) {
      counts.set(completion, (counts.get(completion) ?? 0) + 1);
    }
  }
  return {
    routes,
    reasons: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `${reason}: ${count}`),
  };
}

function incompleteBanner(report: RouteLintReport): string {
  const incomplete = incompleteSummary(report);
  if (!report.truncated && incomplete.routes === 0) return "";
  const details: string[] = [];
  if (report.truncated) {
    details.push(
      "Collection stopped at a configured limit. Absence of a finding is not proof that unchecked routes are healthy.",
    );
  }
  if (incomplete.routes > 0) {
    details.push(
      `${incomplete.routes.toLocaleString("en-US")} route${incomplete.routes === 1 ? " has" : "s have"} incomplete evidence (${incomplete.reasons.join(", ")}).`,
    );
  }
  return `<aside class="notice" aria-labelledby="incomplete-heading">
    <h2 id="incomplete-heading">Incomplete evidence</h2>
    ${details.map((detail) => `<p>${escapeHtml(detail)}</p>`).join("")}
  </aside>`;
}

const STYLES = `
:root {
  color-scheme: light;
  --paper: #f5f2e9;
  --surface: #ffffff;
  --ink: #1d2025;
  --muted: #5e6670;
  --line: #c8c2b5;
  --strong-line: #888174;
  --error: #a32832;
  --error-soft: #fbe9eb;
  --warning: #765000;
  --warning-soft: #fff3cf;
  --info: #185d78;
  --info-soft: #e2f3f8;
  --complete: #22653e;
  --complete-soft: #e6f5eb;
  --focus: #075ec7;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}
* { box-sizing: border-box; }
html { background: var(--paper); color: var(--ink); }
body { margin: 0; font-size: 1rem; line-height: 1.5; }
a { color: #0755a3; text-underline-offset: 0.18em; }
a:hover { text-decoration-thickness: 0.14em; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
[hidden] { display: none !important; }
.skip-link { position: fixed; z-index: 20; top: 0.75rem; left: 0.75rem; padding: 0.6rem 0.8rem; background: var(--ink); color: white; transform: translateY(-180%); }
.skip-link:focus { transform: translateY(0); }
.page-header { border-bottom: 1px solid var(--strong-line); background: var(--surface); }
.page-header-inner, main, footer { width: min(1180px, calc(100% - 2rem)); margin-inline: auto; }
.page-header-inner { padding: 2.6rem 0 2rem; }
.eyebrow { margin: 0 0 0.4rem; color: var(--muted); font-size: 0.76rem; font-weight: 750; letter-spacing: 0.12em; text-transform: uppercase; }
h1, h2 { line-height: 1.15; letter-spacing: -0.025em; }
h1 { margin: 0; font-size: clamp(2rem, 6vw, 3.7rem); }
h2 { margin: 0 0 1rem; font-size: clamp(1.35rem, 3vw, 2rem); }
.base-url { margin: 0.65rem 0 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.run-meta { margin: 0.5rem 0 0; color: var(--muted); }
main { padding-block: 2rem 4rem; }
section { margin-top: 3rem; }
.notice { padding: 1rem 1.15rem; border: 2px solid var(--warning); background: var(--warning-soft); }
.notice h2 { margin: 0 0 0.35rem; font-size: 1.05rem; letter-spacing: 0; }
.notice p { margin: 0.25rem 0 0; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; border-top: 1px solid var(--strong-line); border-left: 1px solid var(--strong-line); }
.summary-card { min-width: 0; padding: 1rem; border-right: 1px solid var(--strong-line); border-bottom: 1px solid var(--strong-line); background: var(--surface); }
.summary-card dt { color: var(--muted); font-size: 0.78rem; font-weight: 750; letter-spacing: 0.06em; text-transform: uppercase; }
.summary-card dd { margin: 0.15rem 0; font-size: clamp(1.65rem, 4vw, 2.4rem); font-weight: 760; line-height: 1; font-variant-numeric: tabular-nums; }
.summary-card .summary-detail { margin: 0.45rem 0 0; color: var(--muted); font-size: 0.88rem; }
.section-note { max-width: 76ch; margin: -0.45rem 0 1rem; color: var(--muted); }
.legend { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; padding: 0; margin: 0 0 0.8rem; list-style: none; font-size: 0.88rem; }
.legend li::before { display: inline-block; width: 0.72rem; height: 0.72rem; margin-right: 0.35rem; border: 2px solid var(--strong-line); border-radius: 2px; content: ""; vertical-align: -0.05rem; }
.legend .error::before { border-color: var(--error); background: var(--error-soft); }
.legend .warning::before { border-color: var(--warning); background: var(--warning-soft); }
.legend .info::before { border-color: var(--info); background: var(--info-soft); }
.legend .incomplete::before { border-color: var(--muted); background: #efefef; }
.legend .clean::before { border-color: var(--complete); background: var(--complete-soft); }
.graph-scroll { overflow: auto; max-height: 46rem; border: 1px solid var(--strong-line); background: var(--surface); }
.route-graph { display: block; max-width: none; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
.graph-edge { stroke: #989287; stroke-width: 1.2; opacity: 0.58; }
.graph-edges path { fill: #989287; }
.graph-node rect { stroke-width: 2; }
.graph-node text { fill: var(--ink); }
.graph-error rect { fill: var(--error-soft); stroke: var(--error); }
.graph-warning rect { fill: var(--warning-soft); stroke: var(--warning); }
.graph-info rect { fill: var(--info-soft); stroke: var(--info); }
.graph-incomplete rect { fill: #efefef; stroke: var(--muted); stroke-dasharray: 4 3; }
.graph-clean rect { fill: var(--complete-soft); stroke: var(--complete); }
.controls { display: flex; flex-wrap: wrap; align-items: end; gap: 0.8rem; margin-bottom: 0.9rem; padding: 0.9rem; border: 1px solid var(--line); background: var(--surface); }
.control { display: grid; gap: 0.28rem; min-width: min(100%, 15rem); }
.control label { font-size: 0.82rem; font-weight: 700; }
input, select { width: 100%; min-height: 2.55rem; padding: 0.48rem 0.6rem; border: 1px solid var(--strong-line); border-radius: 0; background: white; color: var(--ink); font: inherit; }
.match-count { margin: 0 0 0.55rem auto; color: var(--muted); font-size: 0.9rem; }
.table-scroll { overflow-x: auto; border: 1px solid var(--strong-line); background: var(--surface); }
table { width: 100%; min-width: 880px; border-collapse: collapse; font-size: 0.88rem; }
th, td { padding: 0.72rem 0.75rem; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
thead th { position: sticky; z-index: 1; top: 0; background: #ebe7dc; color: #33383e; font-size: 0.74rem; letter-spacing: 0.045em; text-transform: uppercase; }
tbody tr:last-child > * { border-bottom: 0; }
tbody tr:hover { background: #fbfaf6; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.93em; }
.url-value { overflow-wrap: anywhere; word-break: break-word; }
.badge { display: inline-block; min-width: 4.6rem; padding: 0.15rem 0.42rem; border: 1px solid currentColor; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.035em; text-align: center; text-transform: uppercase; }
.badge-error { color: var(--error); background: var(--error-soft); }
.badge-warning { color: var(--warning); background: var(--warning-soft); }
.badge-info { color: var(--info); background: var(--info-soft); }
.evidence-complete { color: var(--complete); }
.evidence-incomplete { color: var(--warning); font-weight: 700; }
.finding-message { max-width: 55ch; margin: 0; }
.evidence-list { margin: 0; }
.evidence-list div { display: grid; grid-template-columns: minmax(5rem, auto) 1fr; gap: 0.45rem; }
.evidence-list dt { color: var(--muted); }
.evidence-list dd { margin: 0; overflow-wrap: anywhere; }
.related { margin-top: 0.45rem; }
.related summary { cursor: pointer; color: #0755a3; }
.related ul { margin: 0.4rem 0 0; padding-left: 1.1rem; }
.scope-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; border-top: 1px solid var(--line); }
.scope-list div { padding: 0.7rem 0; border-bottom: 1px solid var(--line); }
.scope-list dt { color: var(--muted); font-size: 0.78rem; }
.scope-list dd { margin: 0.12rem 0 0; font-weight: 650; }
.empty-state { padding: 1rem; border: 1px solid var(--line); background: var(--surface); color: var(--muted); }
.muted { color: var(--muted); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.no-js .enhancement { display: none; }
footer { padding: 1.2rem 0 2.5rem; border-top: 1px solid var(--strong-line); color: var(--muted); }
footer p { margin: 0; }
@media (max-width: 760px) {
  .page-header-inner, main, footer { width: min(100% - 1.1rem, 1180px); }
  .page-header-inner { padding-top: 1.8rem; }
  main { padding-top: 1.2rem; }
  section { margin-top: 2.2rem; }
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .scope-list { grid-template-columns: 1fr 1fr; }
  .controls { align-items: stretch; }
  .control { width: 100%; }
  .match-count { margin-left: 0; }
}
@media (max-width: 430px) {
  .summary-grid, .scope-list { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
}
@media print {
  .enhancement, .skip-link { display: none !important; }
  body { background: white; font-size: 9pt; }
  .page-header-inner, main, footer { width: 100%; }
  .graph-scroll, .table-scroll { overflow: visible; max-height: none; }
  .route-graph { max-width: 100%; height: auto; }
  thead th { position: static; }
  section { break-inside: avoid-page; }
}
`;

const SCRIPTS = `
(() => {
  const wireFilter = ({ inputId, selectId, rowSelector, outputId, noun }) => {
    const input = document.getElementById(inputId);
    const select = selectId ? document.getElementById(selectId) : null;
    const output = document.getElementById(outputId);
    const rows = [...document.querySelectorAll(rowSelector)];
    if (!(input instanceof HTMLInputElement) || !(output instanceof HTMLElement)) return;

    const update = () => {
      const query = input.value.trim().toLocaleLowerCase();
      const severity = select instanceof HTMLSelectElement ? select.value : "all";
      let visible = 0;
      for (const row of rows) {
        const matchesText = query.length === 0 || (row.textContent || "").toLocaleLowerCase().includes(query);
        const matchesSeverity = severity === "all" || row.getAttribute("data-severity") === severity;
        row.hidden = !(matchesText && matchesSeverity);
        if (!row.hidden) visible += 1;
      }
      output.textContent = "Showing " + visible.toLocaleString("en-US") + " " + noun + (visible === 1 ? "." : "s.");
    };

    input.addEventListener("input", update);
    if (select instanceof HTMLSelectElement) select.addEventListener("change", update);
    update();
  };

  wireFilter({ inputId: "route-search", rowSelector: "[data-route-row]", outputId: "route-match", noun: "route" });
  wireFilter({ inputId: "finding-search", selectId: "severity-filter", rowSelector: "[data-finding-row]", outputId: "finding-match", noun: "finding" });
})();
`;

/** Render a single, portable HTML report. All report data is present without JavaScript. */
export function renderHtmlReport(report: RouteLintReport): string {
  const findingsByUrl = findingCountsByUrl(report.findings);
  const routeRows = renderRouteRows(report, findingsByUrl);
  const findingRows = renderFindingRows(report.findings);
  const findingContent =
    report.findings.length === 0
      ? `<div class="empty-state">No findings were recorded for the collected evidence.</div>`
      : `<div class="table-scroll"><table>
          <thead><tr><th scope="col">Severity</th><th scope="col">Check</th><th scope="col">Route</th><th scope="col">Finding</th><th scope="col">Evidence</th></tr></thead>
          <tbody>${findingRows}</tbody>
        </table></div>`;
  const routeContent =
    report.routes.length === 0
      ? `<div class="empty-state">No routes were collected.</div>`
      : `<div class="table-scroll"><table>
          <thead><tr><th scope="col">Route</th><th scope="col">Depth</th><th scope="col">HTTP</th><th scope="col">Evidence</th><th scope="col">Indexing signal</th><th scope="col">Links in / out</th><th scope="col">Findings</th></tr></thead>
          <tbody>${routeRows}</tbody>
        </table></div>`;
  const safeTitleUrl = escapeHtml(report.baseUrl);

  return `<!doctype html>
<html lang="en" class="no-js">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="robots" content="noindex, nofollow">
  <title>RouteLint report — ${safeTitleUrl}</title>
  <script>document.documentElement.classList.replace("no-js", "js");</script>
  <style>${STYLES}</style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to report</a>
  <header class="page-header">
    <div class="page-header-inner">
      <p class="eyebrow">RouteLint</p>
      <h1>Site report</h1>
      <p class="base-url">${safeTitleUrl}</p>
      <p class="run-meta">Generated ${escapeHtml(report.generatedAt)} in ${escapeHtml(formatDuration(report.durationMs))}</p>
    </div>
  </header>
  <main id="main-content">
    ${incompleteBanner(report)}
    <section aria-labelledby="summary-heading">
      <h2 id="summary-heading">Summary</h2>
      <dl class="summary-grid">
        ${summaryCard("Routes", report.summary.routes, `${report.summary.fetched} fetched`)}
        ${summaryCard("Indexable", report.summary.indexable, `${report.summary.noindex} noindex`)}
        ${summaryCard("Errors", report.summary.errors, `${report.summary.brokenLinks} broken links`)}
        ${summaryCard("Warnings", report.summary.warnings, `${report.summary.info} informational findings`)}
        ${summaryCard("Redirects", report.summary.redirects, "Observed redirect responses")}
        ${summaryCard("Max depth", report.summary.maxDepth, "Deepest collected route")}
        ${summaryCard("Sitemap URLs", report.sitemap.entries.length, `${report.sitemap.fetched.length} sitemap files fetched`)}
        ${summaryCard("Findings", report.findings.length, "Evidence-backed checks")}
      </dl>
    </section>

    <section aria-labelledby="graph-heading">
      <h2 id="graph-heading">Route graph</h2>
      <ul class="legend" aria-label="Graph legend">
        <li class="error">Error</li><li class="warning">Warning</li><li class="info">Info</li><li class="incomplete">Incomplete</li><li class="clean">No route finding</li>
      </ul>
      ${renderGraph(report, findingsByUrl)}
    </section>

    <section aria-labelledby="routes-heading">
      <h2 id="routes-heading">Routes</h2>
      <div class="controls enhancement">
        <div class="control"><label for="route-search">Search routes</label><input id="route-search" type="search" autocomplete="off" placeholder="URL, status or signal"></div>
        <p id="route-match" class="match-count" role="status" aria-live="polite">Showing ${escapeHtml(report.routes.length)} routes.</p>
      </div>
      ${routeContent}
    </section>

    <section aria-labelledby="findings-heading">
      <h2 id="findings-heading">Findings</h2>
      ${
        report.findings.length === 0
          ? ""
          : `<div class="controls enhancement">
        <div class="control"><label for="finding-search">Search findings</label><input id="finding-search" type="search" autocomplete="off" placeholder="Check, route or message"></div>
        <div class="control"><label for="severity-filter">Severity</label><select id="severity-filter"><option value="all">All severities</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option></select></div>
        <p id="finding-match" class="match-count" role="status" aria-live="polite">Showing ${escapeHtml(report.findings.length)} findings.</p>
      </div>`
      }
      ${findingContent}
    </section>

    <section aria-labelledby="scope-heading">
      <h2 id="scope-heading">Evidence scope</h2>
      <p class="section-note">These limits describe what was collected. Routes outside this scope were not evaluated.</p>
      <dl class="scope-list">
        <div><dt>Page limit</dt><dd>${escapeHtml(report.config.maxPages)}</dd></div>
        <div><dt>Depth limit</dt><dd>${escapeHtml(report.config.maxDepth)}</dd></div>
        <div><dt>Agents</dt><dd>${escapeHtml(report.config.agents.join(", ") || "None")}</dd></div>
        <div><dt>Robots respected</dt><dd>${report.config.respectRobots ? "Yes" : "No"}</dd></div>
        <div><dt>Query policy</dt><dd>${escapeHtml(report.config.queryPolicy)}</dd></div>
        <div><dt>Schema version</dt><dd>${escapeHtml(report.schemaVersion)}</dd></div>
      </dl>
    </section>
  </main>
  <footer><p>Niko M. · <a href="https://nikom.work" rel="author noopener">nikom.work</a></p></footer>
  <script>${SCRIPTS}</script>
</body>
</html>
`;
}
