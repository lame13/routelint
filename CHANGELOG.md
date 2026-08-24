# Changelog

All notable changes are documented here. This project follows semantic versioning.

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
