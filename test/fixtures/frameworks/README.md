# Framework fixtures

These are small, representative frozen artifacts for parser compatibility tests. They are not full framework applications and are not claimed to be byte-for-byte output from every patch release.

- `next-16-app` models the App Router, Pages Router, prerender, redirect, build ID, and framework-version manifest fields RouteLint consumes.
- `astro-ssr` models server HTML containing ordinary metadata, links, and an Astro island marker.

Keep fixtures text-only, deterministic, free of project data, and limited to fields exercised by RouteLint.
