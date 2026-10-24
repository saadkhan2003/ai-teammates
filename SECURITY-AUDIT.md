# Security audit

Application dependency audits (`npm audit`, `dotnet list package --vulnerable --include-transitive`, and `pip-audit`) are clean at every severity. `scripts/audit-ci.sh` fails the build on any remaining finding. `scripts/trivy-images.sh` builds the shipped images and fails on any fixable finding, and on unfixed critical or high findings, except the bot computer image.

## Cleared

- `apps/web` pins `next@15.5.28`, `react@19.3.1`, `react-dom@19.3.1`, `sharp@0.35.5`, and `postcss@8.5.31`. `overrides` also force `postcss-selector-parser@7.1.7`, which removes the Tailwind 3 advisory chain without a Tailwind 4 migration.
- `next.config.ts` sets `images.dangerouslyAllowSVG` to false and sends a locked-down image response CSP.
- `tests/e2e` pins `@playwright/test@1.64.1`.
- Python services pin FastAPI 0.162.0, Starlette 1.9.0, Uvicorn 0.54.0, httpx 0.28.1, and Playwright 1.64.1. Dev tests pin pytest 9.1.1.
- The API image is `mcr.microsoft.com/dotnet/aspnet:10.0.13-alpine3.24`. The project references `System.Security.Cryptography.Pkcs` and `System.Security.Cryptography.Xml` at 10.0.13. Trivy on the published image is clean, including the shared framework. Microsoft has not published an SDK tag newer than `10.0.402`; the build stage uses `sdk:10.0.402-alpine3.24` and is not the shipped image.
- The web runtime drops npm. The build stage still installs npm 11.19.1 so `npm ci` can run. The computer image keeps Node 24.22.1, whose npm is 11.19.1.
- The agent image is Chainguard Python (`latest-dev`, digest-pinned, glibc) so Playwright's manylinux wheel still installs. The mock OpenRouter image and the isolation guard are Alpine 3.22. The API health check uses `wget`, which is on the Alpine runtime.

## Image scan

Trivy 0.69.3 on 2026-10-24. Counts are advisory instances.

| Image | Before (low / medium / high / critical) | After |
| --- | --- | --- |
| API runtime (`aspnet:10.0` Ubuntu) | 5 / 22 / 0 / 0 | `aspnet:10.0.13-alpine3.24` published app: 0 |
| Web runtime (`node:22-alpine` with npm 10) | 1 / 10 / 11 / 0 | npm removed from the runtime stage: 0 |
| Agent (`python:3.12-slim`) | 62 / 63 / 44 / 0 | Chainguard Python: 0 |
| Mock OpenRouter (`python:3.12-slim`) | 62 / 63 / 44 / 0 | `alpine:3.22` + python3: 0 |
| Isolation guard (`debian:trixie-slim`) | 60 / 58 / 43 / 0 | `alpine:3.22` + iptables: 0 |
| Computer (`debian:trixie-slim`) | 60 / 58 / 43 / 0, 0 fixable | unchanged: 60 / 58 / 43 / 0, 0 fixable |

The computer image still needs Debian packages for Chromium, Xvfb, s6, and librsvg. Those highs have no fixed package version and no smaller base that can run that tool set. The scan allows that image's unfixed highs and still fails if a fixable finding appears.

The SDK build image `sdk:10.0.402-alpine3.24` still has 5 high and 1 medium, all fixable upstream: `System.Security.Cryptography.Pkcs` and `Xml` 10.0.10 (fixed in 10.0.13, which this SDK tag does not contain) and `brotli-libs` 1.2.0-r1. Those assemblies are not in the published API image. The runtime scan of `aspnet:10.0.13-alpine3.24` plus the published app is clean.
