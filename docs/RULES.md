# Finding reference

RouteLint findings use stable codes, a severity, a direct message, and the URLs or evidence involved. Severity reflects how strong the observed evidence is, not a generic SEO score.

## Fetch and delivery

| Code | Default severity | Meaning |
| --- | --- | --- |
| `route-not-fetched` | info | The route was found but did not fit within the run's fetch set. |
| `robots-blocked` | info | The selected user agent was disallowed by robots.txt. |
| `incomplete-fetch` | warning/error | The response exceeded a limit, timed out, or failed before complete evidence was collected. |
| `missing-http-response` | error | No HTTP response was received. |
| `not-found` | error | The final response is a client error. |
| `server-error` | error | The final response is a server error. |
| `unexpected-status` | warning | The final response is outside the normal successful range. |
| `redirected-route` | warning | A discovered route redirects before returning its final page. |
| `non-html-route` | info | A discovered URL returned a non-HTML content type. |
| `agent-incomplete-fetch`, `agent-fetch-mismatch` | warning/error | A secondary agent failed or had a different fetch outcome. |
| `agent-status-mismatch`, `agent-redirect-mismatch`, `agent-content-type-mismatch` | warning/error | Bot and browser-like requests received different HTTP delivery. |
| `agent-title-mismatch`, `agent-description-mismatch`, `agent-canonical-mismatch`, `agent-robots-mismatch` | warning/error | Server-rendered SEO signals differ between configured agents. |
| `rendered-capture-incomplete` | warning | The optional browser comparison could not collect complete DOM evidence. |
| `rendered-status-mismatch` | warning/error | Raw capture and browser navigation returned different HTTP statuses; a success/error split is an error. |

Incomplete captures are not treated as indexable and are not passed through metadata, graph, or duplicate-content checks.

## Redirect contracts

| Code | Default severity | Meaning |
| --- | --- | --- |
| `expected-redirect-missing` | error | A declared redirect source did not redirect. |
| `redirect-status-mismatch` | error | The first hop did not use the declared redirect status. |
| `redirect-target-mismatch` | error | The observed chain did not end at the declared destination. |
| `redirect-chain` | warning | The observed chain exceeded the declared hop limit. |
| `redirect-target-unhealthy` | error | The declared destination returned a non-2xx response or was `noindex`. |
| `redirect-contract-unchecked` | warning | The contract lacked complete source evidence because of limits, robots policy, or a fetch failure. |

A contract source is exempt from the generic `redirected-route` and ordinary page-response findings. Sitemap and link-graph checks still apply because intentional redirects should not remain in sitemaps or internal links. See [REDIRECTS.md](REDIRECTS.md).

## Page signals

| Code family | Meaning |
| --- | --- |
| `missing-title`, `missing-description`, `missing-canonical`, `missing-h1` | Required server-rendered metadata is absent. |
| `duplicate-*`, `conflicting-*` | A response contains repeated or contradictory values. |
| `multiple-h1` | The server-rendered HTML contains more than one H1. |
| `noindex` | An applicable meta or X-Robots-Tag directive prevents indexing. |
| `invalid-hreflang`, `duplicate-hreflang` | A page-level hreflang value is invalid-looking or repeated. |
| `empty-ssr-shell` | The raw response contains almost no body text or primary page signals. Browser evidence is required before RouteLint calls it client-only. |
| `client-only-content` | The raw response is nearly empty while the rendered DOM contains substantial visible text. |
| `rendered-only-title`, `rendered-only-canonical`, `rendered-only-h1` | A search-relevant signal is absent from raw server HTML and appears only after JavaScript runs. |
| `soft-404` | A successful response exactly matches a captured 404/410 body. |
| `possible-soft-404` | A successful response closely resembles a captured error body, or a short response uses a not-found-looking title or H1. |

## Site graph

| Code | Meaning |
| --- | --- |
| `deep-route` | The shortest discovered internal path exceeds the configured audit depth. |
| `orphan-route` | An indexable sitemap/build route has no non-self internal link. |
| `dead-end-route` | An indexable page exposes no crawlable internal links. |
| `broken-internal-link` | An internal link target returns an error status. |
| `redirecting-internal-link` | An internal link target redirects. |
| `internal-link-to-noindex` | An internal link points to a noindex route. |
| `route-case-or-slash-variant` | URLs differ only by case or a trailing slash. Review intentional case-sensitive routes before acting. |
| `duplicate-title-across-routes` | Multiple indexable routes use the same normalized title. |
| `duplicate-description-across-routes` | Multiple indexable routes use the same normalized description. |
| `duplicate-content-across-routes` | Multiple indexable routes return the same normalized SSR body text, with a minimum-content threshold. |

## Sitemaps, canonicals, and hreflang

| Code family | Meaning |
| --- | --- |
| `not-in-sitemap` | An observed indexable route is absent from fetched sitemaps. |
| `sitemap-redirect`, `sitemap-broken-url`, `sitemap-noindex`, `sitemap-robots-blocked` | A sitemap entry conflicts with the live route. |
| `non-self-canonical` | A route declares another URL as canonical. This may be intentional and is reported for review. |
| `canonical-target-unseen` | An internal canonical target was not found. The severity is reduced when the crawl is truncated. |
| `broken-canonical-target`, `redirecting-canonical-target`, `noindex-canonical-target` | A canonical points to an unhealthy or contradictory target. |
| `duplicate-canonical-target` | Multiple indexable routes declare the same canonical target. |
| `hreflang-target-unseen` | An internal alternate target was not found. The severity is reduced when evidence is truncated. |
| `hreflang-target-noindex` | An alternate target is noindex. |
| `hreflang-missing-return-link` | An alternate page does not reference the source page. |

## Inventory and limits

| Code | Meaning |
| --- | --- |
| `sitemap-warning` | A sitemap fetch, XML, recursion, or size issue occurred. |
| `robots-warning` | robots.txt could not be fetched or parsed completely. |
| `next-discovery-warning` | A Next.js artifact was missing, ambiguous, or unsupported. |
| `next-dynamic-route-needs-sample` | A dynamic build pattern has no concrete URL. |
| `page-budget-reached` | The run stopped adding routes at its configured page limit. Missing-target conclusions become conservative. |

## Changing severity and path requirements

`--fail-on` controls the process threshold. Config can separately change or disable a finding code globally:

```yaml
audit:
  severities:
    noindex: info
    dead-end-route: off
```

Path scopes change requirements or severity for matching routes. Scopes are applied in declaration order; later matching scopes win. `exclude` removes routes from that scope only.

```yaml
audit:
  paths:
    - include: [/docs/**]
      exclude: [/docs/archive/**]
      requireDescription: false
      maxDepth: 6
      severities:
        missing-h1: info
```

Unknown finding codes are accepted so a config can be prepared before a new rule ships. They have no effect until that code exists.
