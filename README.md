# RouteLint

[![CI](https://github.com/lame13/routelint/actions/workflows/ci.yml/badge.svg)](https://github.com/lame13/routelint/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/routelint)](https://www.npmjs.com/package/routelint)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

RouteLint is a CLI for finding technical SEO problems in your deployed site. It catches broken links, redirects that land in the wrong place, empty server-rendered pages, and conflicts between your canonicals, sitemaps, and indexing rules.

Use it after a deploy, during a URL migration, or in CI to catch regressions. Start with a URL:

```bash
npx routelint check https://example.com
```

Checks start with the HTML and headers your server returns. Add `--rendered` to compare them with the DOM after JavaScript runs, using Playwright. Reports give you findings tied to URLs and the evidence behind them.

## What it checks

| Area | What RouteLint looks for |
| --- | --- |
| Route discovery | URLs from seeds, files or stdin, sitemaps and sitemap indexes, `robots.txt`, internal links, and optional Next.js build manifests |
| HTTP delivery | Errors, redirect chains, final destinations, content types, response sizes, timeouts, and different responses for different bots |
| Redirect contracts | Whether a redirect uses the expected first-hop status, reaches the right destination within the hop limit, and lands on a healthy target |
| Server-rendered HTML | Missing or misplaced titles, descriptions, canonicals, robots directives, H1s, and language; empty shells, soft 404s, and duplicate body content |
| Rendered comparison | Content and SEO tags that only appear after JavaScript runs, plus differences from the server response |
| Link graph | Broken links, links through redirects or to `noindex` pages, orphan pages, dead ends, and pages buried too deep |
| Indexing consistency | Sitemap URLs that redirect, fail, or use `noindex`; missing sitemap coverage; robots conflicts; unhealthy or shared canonical targets |
| International SEO | Invalid or duplicate hreflang values, missing or `noindex` targets, and missing return links |
| Next.js | App Router and Pages Router paths, prerendered and ISR routes, redirects, dynamic route samples, `basePath`, and routes missing after deployment |
| Regression checks | Differences between saved reports, or output limited to new and worsened findings |

HTML checks ignore unused `<template>` contents. If your page inserts that content with JavaScript, use `--rendered` to check the resulting DOM.

You control the crawl's page count, depth, response size, redirects, timeout, and concurrency. The crawl graph stays on the origin you provide.

RouteLint respects `robots.txt` by default. A missing file (404/410) allows crawling. If the file is unavailable, invalid, too large, or times out, RouteLint skips requests and records why. Use `--ignore-robots` when you intend to bypass that policy.

## Quick start

RouteLint requires Node.js 22.12.0 or newer.

### Check a deployed site

```bash
npx routelint check https://example.com
```

For a report you can open in a browser or save as a CI artifact:

```bash
npx routelint check https://example.com \
  --format html \
  --output routelint-report.html
```

The HTML report is a single file with no external assets. The graph and tables work without JavaScript; enable it for search and filtering.

### Add Next.js build routes

Build your app and start its production server, then run:

```bash
npx routelint next http://localhost:3000 --root .
```

RouteLint reads supported `.next` manifests and checks those routes against the running site. It does not import or execute your application code. For a dynamic route such as `/blog/[slug]`, provide real URLs through config, a sitemap, or internal links:

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

Next.js manifests are internal build files, so their formats can change. RouteLint warns about unsupported data and marks ambiguous rendering modes as `unknown`, including partially prerendered routes it cannot classify.

### Nuxt, Astro, and other SSR sites

Use `check` with your site's URL. Sitemaps and internal links supply the routes:

```bash
npx routelint check https://example.com \
  --sitemap https://example.com/sitemap-index.xml
```

No framework adapter is needed: these checks work with the HTTP responses and HTML your site serves.

### Check an explicit route inventory

Already have a list of routes? Put one URL or path on each line. Blank lines and `#` comments are ignored. Invalid entries fail the run with a line number; URLs on other origins are skipped and reported.

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

### Verify intentional redirects

For a migration or URL cleanup, tell RouteLint where each old path should go:

```yaml
baseUrl: https://example.com

redirects:
  - from: /old-pricing
    to: /pricing
    status: 301
    maxHops: 1
```

This expects `/old-pricing` to return a `301` and reach `/pricing` in one hop. RouteLint adds both URLs to the crawl and reports a missing redirect, wrong status, wrong destination, or unhealthy target as an error. Extra hops produce a warning. Redirects that match are counted as verified.

Contracts cover exact, same-origin URLs. `routelint next` also checks concrete, unconditional redirects from supported build manifests. See the [redirect guide](docs/REDIRECTS.md) for the supported cases and finding codes.

### Compare SSR with the rendered DOM

If content or metadata depends on JavaScript, enable browser comparison. Install Playwright and Chromium alongside RouteLint:

```bash
npm install --save-dev routelint playwright
npx playwright install chromium
npx routelint check https://example.com --rendered
```

Playwright is optional; a normal RouteLint install does not download a browser. During rendered checks, preview headers are sent only to the audited origin, and service workers are blocked.

## Commands

```text
routelint check [base-url]       Crawl and lint any HTTP(S) site
routelint next [base-url]        Add Next.js build routes to the live crawl
routelint diff <old> <new>       Compare two JSON reports
routelint init [file]            Write a documented starter config
```

Run `routelint <command> --help` for the full option list.

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

# Save a baseline before a deployment
npx routelint check https://example.com --format json -o baseline.json

# After deploying, capture a new report and compare
npx routelint check https://example.com --format json -o current.json
npx routelint diff baseline.json current.json --fail-on warning

# On later CI runs, emit and fail only on new or worsened findings
npx routelint check https://example.com \
  --changed-only baseline.json \
  --format sarif \
  --output routelint.sarif
```

## Configuration

Save your usual options in `routelint.config.yml`. Generate a starter file with:

```bash
npx routelint init
```

Here's an example with a redirect contract, crawl limits, and a rule override for `/docs/**`:

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

redirects:
  - from: /old-pricing
    to: /pricing
    status: 301
    maxHops: 1

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

Command-line options override the config file. JSON config works too.

### Preview credentials

For a protected preview, read credentials from an environment variable:

```yaml
headers:
  Authorization: ${ROUTELINT_AUTHORIZATION}
```

```bash
export ROUTELINT_AUTHORIZATION='Bearer replace-me'
npx routelint check https://preview.example.com
```

You can also repeat `--header 'Name: value'` on the command line. Configured header values stay out of reports, sensitive response headers are redacted, and configured headers are stripped when a redirect crosses an origin.

Reports can still contain private URLs. Keep them and real credentials out of Git, and only check systems you have permission to access.

## Reports and CI

Choose `terminal` for a quick read, `html` for a shareable report, `json` for saved baselines or tooling, and `sarif` for code-scanning integrations.

```bash
npx routelint check https://example.com \
  --format sarif \
  --output routelint.sarif \
  --fail-on error
```

Set `--fail-on` to `error`, `warning`, `info`, or `none` to choose which findings fail the command.

- Exit `0`: the command completed and no finding met the threshold.
- Exit `1`: at least one finding met the threshold.
- Exit `2`: configuration, arguments, or the command itself failed.

To check your own site in CI, start with [examples/github-actions.yml](examples/github-actions.yml).

This repository's CI verifies RouteLint itself: lint, types, tests, builds, and package installation, with jobs on Linux, macOS, and Windows. Releases go through a PR; npm publishing happens interactively from a maintainer's terminal. See [PUBLISHING.md](PUBLISHING.md).

## Reading the result honestly

A route that failed and a route that could not be checked need different follow-up. Reports tell you when robots rules, crawl limits, timeouts, or oversized responses prevented a check. If the crawl is cut short, RouteLint avoids treating every unseen target as missing.

RouteLint checks delivery and technical SEO. It does not:

- calculate an SEO score;
- claim browser equivalence unless `--rendered` was enabled and the capture completed;
- diagnose hydration errors or user interactions;
- calculate Core Web Vitals;
- submit URLs to search engines;
- crawl external links by default;
- emulate dynamic, conditional, query-bearing, or off-origin redirect rules;
- claim that an unobserved dynamic route exists;
- replace a full authenticated browser test or a search-engine index report.

For details, read the [finding reference](docs/RULES.md), [redirect guide](docs/REDIRECTS.md), [rendered checks](docs/RENDERED.md), [URL-list guide](docs/URL_LISTS.md), or [Next.js discovery notes](docs/NEXT.md).

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

Reports carry a schema version, which RouteLint validates when reading a saved baseline. Redirect helpers and their TypeScript types are also exported; `report.redirectContracts` gives you the results from a normal run.

## Development

```bash
npm ci
npm run check
```

`npm run check` runs Biome, strict TypeScript, the full test suite, a clean build, and an installed-tarball smoke test.

## License

MIT. Built by [Niko M.](https://nikom.work).
