# Changelog

All notable changes are documented here. This project follows semantic versioning.

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
