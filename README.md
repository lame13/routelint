# RouteLint

[![CI](https://github.com/lame13/routelint/actions/workflows/ci.yml/badge.svg)](https://github.com/lame13/routelint/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/routelint)](https://www.npmjs.com/package/routelint)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

RouteLint finds technical-SEO mistakes that become obvious only when routes are compared as a system: broken internal links, soft 404s, empty SSR shells, duplicate server content, sitemap conflicts, unhealthy canonical targets, missing hreflang return links, orphan pages, and Next.js build routes that do not survive deployment.

Raw server responses remain the primary evidence. An optional Playwright pass compares that evidence with the browser-rendered DOM. RouteLint does not invent an SEO score.

```bash
npx routelint check https://example.com
```

## What it checks

| Area | Evidence and checks |
| --- | --- |
| Route discovery | Seeds, URL-list files or stdin, recursive sitemap indexes, `robots.txt`, crawlable internal links, and optional Next.js build manifests |
| HTTP delivery | Status, explicit redirect chain, final URL, content type, response size, timeouts, and bot-specific responses |
| Server-rendered HTML | Title, description, canonical, robots/googlebot/bingbot directives, H1, language, links, hreflang, body-text fingerprints, empty shells, soft 404s, and duplicate bodies |
| Rendered comparison | Optional browser evidence for content and SEO signals that appear only after JavaScript runs |
| Link graph | Broken and redirecting links, links to `noindex`, orphans, dead ends, and crawl depth |
| Indexing consistency | Sitemap redirects/errors/noindex, indexable routes missing from sitemaps, robots conflicts, canonical target health, and duplicate canonical targets |
| International SEO | Invalid or duplicate hreflang, missing targets, noindex targets, and missing reciprocal links |
| Next.js | Concrete App Router and Pages Router paths, prerendered and ISR routes, redirects, dynamic route samples, `basePath`, and unresolved patterns |
| Regression checks | Full report diffs, plus changed-only audit output containing only new or worsened findings |

Every crawl is bounded by page, depth, response-size, redirect, timeout, and concurrency limits. Off-origin pages are never added to the crawl graph.

When robots rules are respected, a missing `robots.txt` (404/410) permits crawling; an unavailable, invalid, timed-out, or oversized policy fails closed and records skipped evidence. Use `--ignore-robots` only when bypassing that policy is intentional.

## Quick start

RouteLint requires Node.js 22.12.0 or newer.

### Check a deployed site

```bash
npx routelint check https://example.com
```

Write a self-contained report you can open locally or attach to CI:

```bash
npx routelint check https://example.com \
  --format html \
  --output routelint-report.html
```

The HTML report works without external assets. Its route graph and tables remain useful with JavaScript disabled; JavaScript only adds filtering and search.

### Add Next.js build routes

Build the app, start its production server, then run:

```bash
npx routelint next http://localhost:3000 --root .
```

RouteLint reads known `.next` manifests without importing or executing the application. Static and prerendered paths become crawl candidates. Dynamic patterns need concrete samples from config, a sitemap, or an internal link:

```yaml
baseUrl: http://localhost:3000

next:
  root: .
  buildDirectory: .next
  samples:
    /blog/[slug]:
      - /blog/hello-world
    /shop/[...path]:
      - /shop/shoes/running
```

Manifest formats are not a public Next.js API. Unsupported or ambiguous evidence is reported as a warning or `unknown`; RouteLint does not guess that a partially prerendered route is fully static.

### Nuxt, Astro, and other SSR sites

Use URL mode. Sitemaps and internal links provide the route inventory:

```bash
npx routelint check https://example.com \
  --sitemap https://example.com/sitemap-index.xml
```

The checks depend on HTTP and HTML, not a framework integration.

### Check an explicit route inventory

Use one URL or path per line. Blank lines and `#` comments are ignored. Invalid lines fail the run; off-origin lines are excluded and reported.

```text
# routes.txt
/
/pricing
/docs/getting-started
https://example.com/legal
```

```bash
npx routelint check https://example.com --urls routes.txt
cat routes.txt | npx routelint check https://example.com --urls -
```

### Compare SSR with the rendered DOM

Browser comparison is opt-in. Playwright is an optional peer so normal installs do not download a browser.

```bash
npm install --save-dev routelint playwright
npx playwright install chromium
npx routelint check https://example.com --rendered
```

Configured preview headers are injected only into audited-origin browser requests. Cross-origin requests do not receive them, and rendered contexts block service workers.

## Commands

```text
routelint check [base-url]       Crawl and lint any HTTP(S) site
routelint next [base-url]        Add Next.js build routes to the live crawl
routelint diff <old> <new>       Compare two JSON reports
routelint init [file]            Write a documented starter config
```

Run `routelint <command> --help` for every option.

Useful examples:

```bash
# Compare Googlebot with a browser-like request
npx routelint check https://example.com --agent googlebot --agent browser

# Keep meaningful query-string routes
npx routelint check https://example.com --query keep

# Limit the crawl to public product and article paths
npx routelint check https://example.com \
  --include '/products/**' \
  --include '/articles/**' \
  --exclude '/articles/preview/**'

# Save a baseline, then compare a later deployment
npx routelint check https://example.com --format json -o baseline.json
npx routelint diff baseline.json current.json --fail-on warning

# On later CI runs, emit and fail only on new or worsened findings
npx routelint check https://example.com \
  --changed-only baseline.json \
  --format sarif \
  --output routelint.sarif
```

## Configuration

Create `routelint.config.yml`:

```bash
npx routelint init
```

```yaml
baseUrl: https://example.com
seeds:
  - /
urls: []
sitemaps: auto
agents:
  - routelint
respectRobots: true
queryPolicy: drop

include: []
exclude:
  - /account/**

limits:
  maxPages: 250
  maxDepth: 8
  concurrency: 6
  timeoutMs: 15000
  maxBytes: 2000000
  maxRedirects: 5

audit:
  requireTitle: true
  requireDescription: true
  requireCanonical: true
  requireH1: true
  requireSitemapCoverage: true
  maxDepth: 4
  severities:
    noindex: info
  paths:
    - include:
        - /docs/**
      requireDescription: false
      severities:
        missing-h1: info

rendered:
  enabled: false
  concurrency: 2
  timeoutMs: 20000
  settleMs: 250
```

Command-line values override the config. JSON config is supported too.

### Preview credentials

RouteLint accepts repeated request headers. Header values are never written into reports, sensitive response headers are redacted, and configured headers are removed when a redirect crosses an origin.

```yaml
headers:
  Authorization: ${ROUTELINT_AUTHORIZATION}
```

```bash
export ROUTELINT_AUTHORIZATION='Bearer replace-me'
npx routelint check https://preview.example.com
```

Do not commit real credentials or reports containing private URLs. Only test systems you are authorized to access.

## Reports and CI

RouteLint emits `terminal`, `json`, `sarif`, and `html` reports.

```bash
npx routelint check https://example.com \
  --format sarif \
  --output routelint.sarif \
  --fail-on error
```

`--fail-on` accepts `error`, `warning`, `info`, or `none`.

- Exit `0`: the command completed and no finding met the threshold.
- Exit `1`: at least one finding met the threshold.
- Exit `2`: configuration, arguments, or the command itself failed.

The repository CI only installs, lints, typechecks, tests, builds, packs, and smoke-tests the tarball on Linux, macOS, and Windows. It does not publish to npm and it needs no npm token.

See [examples/github-actions.yml](examples/github-actions.yml) for a site-check job and [PUBLISHING.md](PUBLISHING.md) for the first interactive npm release.

## Reading the result honestly

A failed request and an unchecked request are different states. If a page budget, robots rule, timeout, or response-size limit prevents RouteLint from collecting enough evidence, the report says so. Target-existence checks become conservative when the crawl is truncated.

RouteLint deliberately does not:

- claim browser equivalence unless `--rendered` was enabled and the capture completed;
- diagnose hydration errors or user interactions;
- calculate Core Web Vitals;
- submit URLs to search engines;
- crawl external links by default;
- claim that an unobserved dynamic route exists;
- replace a full authenticated browser test or a search-engine index report.

See [docs/RULES.md](docs/RULES.md) for finding codes, [docs/RENDERED.md](docs/RENDERED.md) for browser evidence, [docs/URL_LISTS.md](docs/URL_LISTS.md) for explicit inventories, and [docs/NEXT.md](docs/NEXT.md) for Next.js discovery details.

## Programmatic API

```ts
import { loadConfig, renderJsonReport, runRouteLint } from "routelint";

const config = await loadConfig({
  overrides: {
    baseUrl: "https://example.com",
    maxPages: 100,
  },
});

const report = await runRouteLint(config);
process.stdout.write(renderJsonReport(report));
```

The report includes a schema version so stored baselines can be validated before comparison.

## Development

```bash
npm ci
npm run check
```

`npm run check` runs Biome, strict TypeScript, the full test suite, a clean build, and an installed-tarball smoke test.

## License

MIT. Built by [Niko M.](https://nikom.work).
