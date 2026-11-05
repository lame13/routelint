/** Public rule reference shipped with every report link and the `explain` command. */
export const RULE_DOCS_URL = "https://github.com/lame13/routelint/blob/main/docs/RULES.md";

const FETCH_AND_DELIVERY = new Set([
  "route-not-fetched",
  "robots-blocked",
  "incomplete-fetch",
  "missing-http-response",
  "not-found",
  "server-error",
  "unexpected-status",
  "redirected-route",
  "slow-route",
  "slow-redirect",
  "non-html-route",
  "rendered-capture-incomplete",
  "rendered-status-mismatch",
]);

const REDIRECT_CONTRACTS = new Set([
  "expected-redirect-missing",
  "redirect-status-mismatch",
  "redirect-target-mismatch",
  "redirect-chain",
  "redirect-target-unhealthy",
  "redirect-contract-unchecked",
  "redirect-pattern-unmatched",
]);

const INVENTORY_AND_LIMITS = new Set([
  "sitemap-warning",
  "robots-warning",
  "crawl-policy",
  "next-discovery-warning",
  "next-dynamic-route-needs-sample",
  "page-budget-reached",
]);

const SITEMAPS_CANONICALS_HREFLANG = new Set([
  "not-in-sitemap",
  "sitemap-redirect",
  "sitemap-broken-url",
  "sitemap-noindex",
  "sitemap-robots-blocked",
  "non-self-canonical",
  "canonical-target-unseen",
  "broken-canonical-target",
  "redirecting-canonical-target",
  "noindex-canonical-target",
  "duplicate-canonical-target",
  "hreflang-target-unseen",
  "hreflang-target-noindex",
  "hreflang-missing-return-link",
]);

const SITE_GRAPH = new Set([
  "deep-route",
  "orphan-route",
  "dead-end-route",
  "broken-internal-link",
  "redirecting-internal-link",
  "internal-link-to-noindex",
  "route-case-or-slash-variant",
  "duplicate-title-across-routes",
  "duplicate-description-across-routes",
  "duplicate-content-across-routes",
]);

const RICH_METADATA = new Set([
  "invalid-json-ld",
  "json-ld-missing-context",
  "json-ld-missing-type",
  "duplicate-json-ld",
  "conflicting-json-ld-id",
  "rendered-only-json-ld",
  "rendered-only-og",
  "missing-og-title",
  "missing-og-description",
  "missing-og-image",
]);

/** Heading anchor in docs/RULES.md for a finding code. */
export function findingDocsSection(code: string): string {
  if (RICH_METADATA.has(code)) return "structured-data-and-social-metadata";
  if (code.startsWith("agent-") || FETCH_AND_DELIVERY.has(code)) return "fetch-and-delivery";
  if (REDIRECT_CONTRACTS.has(code)) return "redirect-contracts";
  if (INVENTORY_AND_LIMITS.has(code)) return "inventory-and-limits";
  if (SITEMAPS_CANONICALS_HREFLANG.has(code)) return "sitemaps-canonicals-and-hreflang";
  if (SITE_GRAPH.has(code)) return "site-graph";
  return "page-signals";
}

export function findingDocsUrl(code: string): string {
  return `${RULE_DOCS_URL}#${findingDocsSection(code)}`;
}
