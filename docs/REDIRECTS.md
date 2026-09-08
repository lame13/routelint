# Redirect contracts

Redirect contracts verify intentional URL migrations against the running site. A contract declares an exact source URL, permanent or temporary redirect status, final destination, and maximum hop count.

```yaml
baseUrl: https://example.com

redirects:
  - from: /old-pricing
    to: /pricing
    status: 301
  - from: /docs/v1/install
    to: /docs/install
    status: 308
    maxHops: 1
```

Both `from` and `to` are added to the crawl frontier. A matching contract requires:

- a redirect response from the source;
- the configured status on the first hop;
- the configured final URL;
- no more than `maxHops`, which defaults to one;
- a complete 2xx response from the final target;
- no applicable `noindex` directive on the final target.

The source and destination must resolve to the configured origin. Query-bearing contracts are rejected because query retention and rewriting cannot be represented safely by this exact-path contract. `maxHops` cannot exceed `limits.maxRedirects`.

Correct contracts do not produce findings. The terminal report shows aggregate verified, failed, and unchecked counts. JSON and HTML reports retain one structured check per contract, including every observed redirect hop. SARIF contains contract failures only.

An expected redirect source does not receive the generic `redirected-route`, `not-found`, or page-metadata findings. It can still receive graph findings. For example, a correct redirect listed in a sitemap still produces `sitemap-redirect`, and an internal link to it still produces `redirecting-internal-link`.

## Next.js redirects

`routelint next` automatically converts exact, unconditional, query-free, same-origin redirects from supported build manifests into contracts. A configured contract for the same source takes precedence.

Dynamic patterns, request-header or cookie conditions, query-bearing destinations, conflicting definitions, and off-origin destinations remain in the Next.js build inventory but are not asserted. Reports count these skipped build definitions without turning them into findings.

RouteLint does not emulate a framework's redirect matcher. Add concrete configured contracts for the deployed URLs that matter.

## Programmatic API

The package exports `collectRedirectContracts`, `redirectContractCandidates`, and `auditRedirectContracts`. It also exports the `RedirectExpectation`, `RedirectContract`, `RedirectContractCheck`, `RedirectContractReport`, `RedirectStatus`, and related redirect-contract types. Normal callers can use `runRouteLint` and read the structured result from `report.redirectContracts` without calling the lower-level functions.

## Findings

| Code | Default severity | Meaning |
| --- | --- | --- |
| `expected-redirect-missing` | error | The source completed without returning a redirect. |
| `redirect-status-mismatch` | error | The first hop returned a different redirect status. |
| `redirect-target-mismatch` | error | The observed chain ended at a different URL. |
| `redirect-chain` | warning | The chain exceeded the contract's maximum hop count. |
| `redirect-target-unhealthy` | error | The final target returned a non-2xx response or was `noindex`. |
| `redirect-contract-unchecked` | warning | Collection limits, robots policy, or a fetch failure prevented verification. |
