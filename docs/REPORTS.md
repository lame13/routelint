# Reports and baselines

## Formats

- `terminal` is concise and deterministic when color is disabled.
- `json` contains the complete route graph, evidence, findings, and run limits.
- `sarif` maps findings to URL artifact locations for code-scanning tools.
- `html` is one portable file with no external assets or network requests.

```bash
routelint check https://example.com --format json -o report.json
routelint check https://example.com --format sarif -o report.sarif
routelint check https://example.com --format html -o report.html
```

## JSON stability

Reports include `schemaVersion`, `toolVersion`, and `generatedAt`. Object keys and route/finding order are deterministic for the same evidence. Timing values and generation dates naturally differ.

Schema 2 adds text-free SSR body measurements and fingerprints, optional rendered snapshots, URL-list inventory, changed-only comparison metadata, and the effective crawl policy needed to reject misleading changed-only comparisons. The baseline reader accepts both schema 1 and schema 2 reports.

Request-header values are excluded. Schema 2 records only the normalized names of configured request headers so changed-only mode can detect a changed authentication mechanism without storing credentials. Response headers are allowlisted/redacted by the capture layer. URLs can still reveal private route names, so treat preview reports as potentially sensitive.

## Baseline comparison

```bash
routelint diff baseline.json current.json
routelint diff baseline.json current.json --format json -o diff.json
```

The reader validates nested report data before comparison. A malformed or unsupported schema exits with code 2 instead of being cast to an internal type.

The diff covers:

- route additions and removals;
- status and final URL;
- canonical and title;
- robots directives and effective indexability;
- secondary-agent fetch, status, URL, canonical, title, robots, and indexability changes;
- Next.js render mode;
- added, resolved, and severity-changed findings.

Baseline comparison describes observed change. It does not prove that an omitted route was deleted when either crawl was truncated; keep page/depth/robots/query settings stable between runs.

## Changed-only audit output

Use a stored JSON report as a CI baseline while still running the complete current audit:

```bash
routelint check https://example.com \
  --changed-only baseline.json \
  --format json \
  --output changed.json \
  --fail-on warning
```

The output keeps the current route evidence but filters `findings` to entries that are new or more severe than the same finding in the baseline. Its summary counts are recalculated from that filtered set. The `comparison` object records new, worsened, resolved, and unchanged counts. Resolved and unchanged findings are counted but omitted from the finding list.

Finding identity uses code, route, and related routes. A message-only change does not make an existing finding new.

Changed-only mode rejects incomplete runs and a baseline whose recorded evidence policy differs from the current run. The policy covers the base URL; page/depth/request limits; seed, sitemap, URL-list, include, and exclude inputs; query and robots handling; ordered agents; configured request-header names; rendered capture settings; and audit rules. Schema 1 reports remain readable, but a report without a recorded policy field cannot be assumed comparable to a current report that has it.
