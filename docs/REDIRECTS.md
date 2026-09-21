# Redirect contracts

Redirect contracts verify intentional URL migrations against the running site. A contract declares a source URL or path pattern, permanent or temporary redirect status, final destination, and maximum hop count.

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

Exact sources and concrete same-origin targets are added to the crawl frontier. A matching contract requires:

- a redirect response from the source;
- the configured status on the first hop;
- the configured final URL;
- no more than `maxHops`, which defaults to one;
- a complete 2xx response from the final target;
- no applicable `noindex` directive on the final target.

The source must resolve to the configured origin. Destinations may leave it; those targets are checked through the source's redirect chain rather than added to the crawl frontier. Configured request headers are stripped on off-origin requests. Query strings are compared exactly, including ordering and encoding, and explicit contract URLs retain their queries even with `queryPolicy: drop`. `maxHops` cannot exceed `limits.maxRedirects`.

Correct contracts do not produce findings. The terminal report shows aggregate verified, failed, and unchecked counts. JSON and HTML reports retain one structured check per concrete source and contract, including every observed redirect hop. SARIF contains contract findings.

An expected redirect source does not receive the generic `redirected-route`, `not-found`, or page-metadata findings. It can still receive graph findings. For example, a correct redirect listed in a sitemap still produces `sitemap-redirect`, and an internal link to it still produces `redirecting-internal-link`.

## Pattern contracts

```yaml
redirects:
  - from: /blog/old/*
    to: /blog/new/*
    status: 308
    samples: [/blog/old/hello]
  - from: /docs/legacy/**
    to: https://archive.example.com/docs/**
    status: 301
```

`*` matches one nonempty path segment. A trailing `**` captures the remaining path, including trailing slashes or an empty remainder. Wildcards occupy whole segments and cannot occur in the host or query. Target placeholders use captures in source order; a target may also be a fixed URL.

Patterns check matching crawl URLs and explicit `samples`. Samples must be concrete matching URLs; they get source priority in the crawl frontier, and an unfetched sample is reported as unchecked. Page limits, include/exclude filters, and robots access rules still apply. Duplicate declarations with the same behavior merge their samples. Overlapping patterns are checked independently, while `patternMatches` counts distinct matched sources.

A pattern without any matching crawl URL or sample produces `redirect-pattern-unmatched`. Patterns do not invent URLs. Use `queryPolicy: keep` when discovery needs to retain query-bearing routes, or supply exact sample URLs.

## Next.js redirects

`routelint next` automatically converts exact, unconditional, query-free, same-origin redirects from supported build manifests into contracts. A configured contract for the same source takes precedence.

Dynamic patterns, request-header or cookie conditions, query-bearing destinations, conflicting definitions, and off-origin destinations remain in the Next.js build inventory but are not asserted. Reports count these skipped build definitions without turning them into findings.

RouteLint does not emulate a framework's redirect matcher. Add configured exact or simple wildcard contracts for the deployed URLs that matter.

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
| `redirect-pattern-unmatched` | info | No crawl URL or explicit sample matched the pattern. |
