# Security policy

## Supported versions

Security fixes are applied to the latest released version.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials, leak headers across origins, produce unsafe report HTML, or cause unbounded file or network behavior. Use GitHub private vulnerability reporting:

<https://github.com/lame13/routelint/security/advisories/new>

Include the affected version, a minimal reproduction, expected impact, and any suggested mitigation. Remove real tokens, cookies, and private URLs. You should receive an initial response within seven days.

## Operational safety

RouteLint sends real HTTP requests and may enumerate routes from a local Next.js build. Run it only against systems and build directories you are authorized to inspect. Treat custom headers as secrets. Do not commit populated environment files or reports containing private routes.
