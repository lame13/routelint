# Rendered DOM comparison

RouteLint audits raw HTTP responses by default. `--rendered` adds a second, bounded pass over successful HTML routes using Playwright Chromium.

## Install

Playwright is an optional peer dependency. Install it only in projects that use rendered comparison:

```bash
npm install --save-dev routelint playwright
npx playwright install chromium
```

Then run:

```bash
routelint check https://example.com --rendered
```

Or configure it:

```yaml
rendered:
  enabled: true
  concurrency: 2
  timeoutMs: 20000
  settleMs: 250
```

## Evidence boundary

The browser waits for `DOMContentLoaded`, then waits the configured settle interval. It records:

- final URL and main-document status when available;
- parsed title, description, canonical, robots, H1, links, hreflang, and language signals;
- HTML byte count;
- normalized visible-body character/word counts, SHA-256, and 64-bit SimHash;
- completion state, duration, and a redacted error when capture fails.

HTML and visible text are not retained in the report. The configured response byte limit is also applied to the serialized DOM before parsing. Browser capture does not perform user actions, accept consent dialogs, wait for arbitrary network-idle states, or claim that every lazy component rendered.

## Credential boundary

Configured headers are injected only into requests whose origin matches the audited page. Cross-origin requests continue without those headers, and service workers are blocked so they cannot bypass this boundary. Cookies created by the audited site remain subject to normal browser cookie rules.

## Failure behavior

Missing Playwright or Chromium stops a rendered run with installation instructions. A failure on an individual route becomes a `rendered-capture-incomplete` finding while other eligible routes continue. Browser concurrency, an end-to-end per-page timeout, settling time, and a pre-transfer DOM size check are explicit limits.
