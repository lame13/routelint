# Changelog

All notable changes are documented here. This project follows semantic versioning.

## 0.5.1 - 2026-11-06

### Fixed

- Make pacing tests deterministic by measuring request dispatch with a controlled clock and HTTP responses. Exact assertions cover configured and robots.txt delays, redirects, multiple agents, and exclusion of queued time from response durations and timeout budgets. Local socket and event-loop latency no longer cause intermittent release-check failures.

## 0.5.0 - 2026-11-05

### Added

- Structured-data evidence for every JSON-LD block, including its `@type` values, `@id` values, a content fingerprint, and whether its `@context` names Schema.org. Reports never retain the JSON-LD payload. New findings cover unreadable blocks, missing context or type, identical repeated blocks, and conflicting blocks for the same `@id`.
- Open Graph and Twitter card capture, with opt-in `audit.requireOpenGraph` and `audit.requireOgImage` requirements. Both work with global and path-scoped audit configuration, and missing tags use dedicated finding codes.
- Rendered-DOM comparison for structured data and social metadata, reporting JSON-LD or Open Graph tags that appear only after JavaScript runs.
- `routelint explain <code>` prints the matching rule, its default severity, and a documentation link from the rule reference bundled with the package.
- Finding codes in HTML reports link to the rule reference, and SARIF rules carry a `helpUri`.

### Changed

- JSON report schema is now version 5. The report reader and diff command remain compatible with schemas 1, 2, 3, and 4.
- Raw and rendered snapshots record structured-data and social-metadata evidence. The new fields are optional so older reports still validate.
- The starter configuration, README, and finding reference document the new checks and their limits.

## 0.4.0 - 2026-09-21

### Added

- Opt-in response-time budgets. `audit.maxResponseMs` reports `slow-route` findings and `audit.maxRedirectHopMs` reports `slow-redirect` findings, each carrying the observed duration, the configured budget, and the route or hop involved. Both are disabled until a threshold is configured and can be narrowed or widened per path scope.
- Redirect pattern contracts. A source may use `*` for one path segment and a trailing `**` for the remaining path; each placeholder in `to` is replaced in order, so `/blog/old/*` → `/blog/new/*` is verified against matching crawl URLs and explicit `samples`. Samples enter the crawl subject to its filters and limits; unfetched samples are unchecked. `redirect-pattern-unmatched` records a pattern without matching sources.
- Query strings in redirect contracts, and destinations that leave the audited origin. Cross-origin targets are verified through the source's own redirect chain instead of being added to the same-origin crawl.
- Markdown, CSV, and JUnit report formats. `--format markdown` writes a GitHub step summary, `--format csv` writes a spreadsheet-friendly table of findings, and `--format junit` writes JUnit XML for CI test reporters. Markdown and XML output neutralize report values instead of embedding them as markup.
- Crawl pacing. `Crawl-delay` and `Request-rate` records in robots.txt now space raw page request starts, including redirect hops and agent comparisons, with the declared delay capped at 10 seconds. `limits.delayMs` and `--delay <duration>` set uncapped explicit minimum spacing, `limits.honorCrawlDelay` and `--ignore-crawl-delay` control whether the declared value is honored, and a `crawl-policy` finding records the pacing that was applied or warns when a declared delay had to be capped. Pacing waits do not consume capture timeout or response-time budgets.

### Changed

- JSON report schema is now version 4. The report reader and diff command remain compatible with schemas 1, 2, and 3.
- Redirect contract checks are counted per matched source, so `redirectContracts` adds `patterns`, `patternMatches`, and `unmatchedPatterns`, and each check records the pattern it came from.
- Report configuration snapshots record `delayMs` and `honorCrawlDelay`.
- The starter and example configurations document the new budgets, pacing options, and pattern contracts.

### Fixed

- Preserve exact query ordering and encoding throughout redirect candidate collection; retain trailing slashes in `**` captures and merge duplicate pattern samples.
- Redact sensitive values in redirect samples and pattern fields, and preserve per-agent robots delay evidence in serialized reports.
- Neutralize Markdown formatting and spreadsheet formulas in report values, remove invalid XML characters from JUnit output, and show unmatched patterns even when no concrete checks ran.
- Apply redirect response-time budgets to each hop's own path scope, compare pacing settings in changed-only reports, and accept `--delay 0`.

## 0.3.1 - 2026-09-08

### Fixed

- Ignore links, metadata, headings, and base URLs inside HTML `<template>` elements, including nested templates. Unused template content no longer creates phantom crawl routes or false SEO findings.

### Changed

- Rewrite the README and package description with clearer explanations and practical examples.
- Update the publishing guide to release through a pull request to protected `main`, then publish to npm interactively from the merged commit.

## 0.3.0 - 2026-08-27

### Added

- Exact same-origin redirect contracts with first-hop status, final destination, hop-limit, target-status, and target-indexability checks.
- Automatic live validation for concrete, unconditional, query-free, same-origin redirects found in supported Next.js build manifests.
- Structured redirect-contract results in JSON, a dedicated HTML table, terminal outcome totals, SARIF findings, and public TypeScript APIs.

### Changed

- JSON report schema is now version 3. The report reader and diff command remain compatible with schemas 1 and 2.
- Correctly declared redirect sources no longer produce the generic `redirected-route` or ordinary page-response findings; sitemap and internal-link findings still apply.
- Configured redirect contracts participate in changed-only baseline comparability.

## 0.2.0 - 2026-08-24

### Added

- Optional Playwright Chromium pass that compares raw SSR evidence with the rendered DOM while injecting configured headers only into audited-origin requests.
- Body-text evidence with word/character counts, SHA-256, and SimHash; reports do not retain page text.
- Empty SSR shell, client-only content, rendered-only SEO signal, soft-404, possible-soft-404, and duplicate SSR body checks.
- Explicit URL-list files and stdin input with source-line diagnostics, same-origin enforcement, size limits, and stable de-duplication.
- Global and path-scoped requirement/severity configuration, including disabling finding codes.
- `--changed-only` output for new or worsened findings against a schema-validated baseline.
- Dedicated agent-response comparison in HTML reports and clearer collection scope in terminal/HTML output.
- Representative frozen Next.js 16 App Router manifests and Astro SSR output fixtures.

### Changed

- JSON report schema is now version 2. The report reader and diff command remain compatible with schema 1.
- Browser rendering is an optional peer dependency; default installs remain raw-HTTP only and do not download Chromium.
- Runtime and development dependencies use the updated versions supplied in the Dependabot-clean 0.1.0 baseline.
- CI remains verification-only. npm publishing is still an interactive local operation protected by account and package 2FA.

## 0.1.0 - 2026-08-22

### Added

- Bounded same-origin crawler with explicit redirects, response limits, bot/browser delivery comparisons, and credential redaction.
- Recursive sitemap, robots.txt, internal-link, and Next.js build-manifest route discovery.
- Server-rendered metadata, canonical, robots, H1, language, link, and hreflang capture.
- Cross-route sitemap, indexability, canonical, hreflang, link-graph, depth, orphan, duplicate, and route-variant checks.
- Terminal, JSON, SARIF, and self-contained HTML reports.
- Schema-validated baseline report diffs.
- Fail-closed robots handling for unavailable policies and API/route-handler filtering in Next.js discovery.
- Cloudflare email-protection pseudo-links excluded from route discovery.
- Strict TypeScript API, CLI, cross-platform package smoke tests, and GitHub Actions CI without npm publishing credentials.
