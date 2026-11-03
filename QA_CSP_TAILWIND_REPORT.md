# Mahyar Gap — CSP, UI Interactions, and Production Build QA Report

**Status:** The frontend event-handler/CSP root cause and Tailwind CDN dependency have been corrected. The production build succeeds. A local Chromium smoke test is clean. This is **not** a claim that authenticated Railway, database, two-user messaging, or LiveKit media flows were end-to-end verified; those services and credentials were not available in this environment.

## Root causes and fixes

1. **CSP blocked inline event attributes.** The project contained 135 inline HTML event handlers. They were replaced by `data-action`/keyboard metadata and external JavaScript event delegation registered from the app after `DOMContentLoaded`. The dispatcher uses an explicit allowlist, parses JSON-encoded arguments, routes input/change/keyboard actions, and supports dynamically rendered controls. Nested role selectors stop click propagation so they do not trigger their parent row. The emoji picker now opens/closes on click as well as hover.
2. **The script policy remains strict.** Helmet emits `script-src 'self'` and `script-src-attr 'none'`. No `unsafe-inline`, `unsafe-eval`, or Tailwind CDN was added to the JavaScript policy. `style-src` still includes `unsafe-inline` because existing UI templates use style attributes; this is documented as remaining CSP hardening work and is separate from inline JavaScript execution.
3. **Tailwind CDN was replaced with a local production build.** Tailwind CSS 3.4 is a project dev dependency; `tailwind.config.cjs` scans the page and JavaScript templates, and `css/tailwind.input.css` produces minified `css/tailwind.generated.css` as part of `npm run build`. `index.html` loads the local asset. The generated stylesheet is ignored as a build output and excluded from Docker context; the Docker builder regenerates it before copying `/app/css` to the runner.
4. **The invalid SVG path error was investigated.** No first-party inline SVG/path markup or dynamic SVG path-generation API was found in the app HTML, JavaScript, CSS, or backend. No invalid-path error appeared in the final browser smoke test. The reported error was therefore not reproducible from this repository state; a Railway stack trace or source URL would be needed to attribute any recurrence to a browser extension, third-party asset, or authenticated state.
5. **A real browser 404 was also fixed.** The first browser run found the browser’s `/favicon.ico` request returned 404. A small brand-colored ICO, an explicit static route, an HTML favicon link, and a Docker runner copy rule were added. The final route returns HTTP 200.

## Files changed for this work

- `index.html` — local Tailwind stylesheet and favicon links; inline click attributes removed/replaced.
- `js/app.js` — delegated action allowlist/dispatcher, input/change/keyboard listeners, JSON attribute encoding, and click-toggle for the emoji picker.
- `server/index.ts` — strict script CSP directives and explicit `/favicon.ico` route.
- `css/tailwind.input.css`, `tailwind.config.cjs` — local Tailwind build inputs/configuration.
- `package.json`, `package-lock.json` — Tailwind build integration and locked Tailwind v3.4.19.
- `Dockerfile`, `.dockerignore`, `.gitignore` — copy favicon into production, rebuild generated CSS in Docker, and ignore generated assets.
- `favicon.ico` — local favicon asset.
- `tests/api.test.js` — regression checks for action resolution, buttons, CSP/Tailwind configuration, favicon delivery, SVG source scan, and existing API/Prisma contracts.
- `README.md`, `AUDIT_REPORT_FA.md` — deployment and prior audit documentation updated.

No API request URLs were changed; the client continues to use same-origin relative API paths. No Prisma schema or database migration was added. No production database was accessed or modified, and no mock user/message data was introduced.

## Verification results

| Check | Result |
|---|---|
| Clean dependency install (`npm ci`) on Node v22.23.4 | Completed successfully |
| Prisma Client generation (`npx prisma generate`) | Passed; Prisma Client v5.22.0 generated |
| Prisma schema validation | Passed using a local placeholder `DATABASE_URL`; this does not connect to a database |
| TypeScript compile (`npx tsc --noEmit -p tsconfig.json`) | Passed |
| Production build (`npm run build`) | Passed; generated local Tailwind CSS, bundled LiveKit browser SDK, and compiled TypeScript |
| JavaScript syntax (`node --check` on app/API/WebRTC/test files) | Passed |
| Existing and added Node tests (`npm test`) | **10/10 passed**, including LiveKit token grant and safe error-diagnostic regressions |
| Runtime dependency audit (`npm audit --omit=dev`) | 0 vulnerabilities reported |
| Chromium production-page smoke test | Passed: CSP headers checked; local CSS and favicon returned HTTP 200; delegated theme action worked; User Settings modal opened/closed; 0 inline event attributes and 0 non-submit buttons without an action in the rendered sample; **0 browser console entries** |
| First-party SVG source scan | No SVG path markup or dynamic path-construction code found |

The regression suite verifies that every non-submit button template has an action and that each action is allowlisted and maps to an implemented method or an explicitly handled special case. The browser test exercises dynamic event delegation, but it does not simulate or mock database-backed authenticated flows.

## Remaining limitations and warnings

- The build still prints a non-fatal Tailwind/Browserslist notice: `caniuse-lite is outdated`. It was not suppressed; build output is still produced successfully.
- `npm ci` still prints deprecation notices from existing transitive development dependencies (`inflight`, `rimraf@2`, `glob@7`). These were not hidden. On 2026-10-31 the full `npm audit` reported four moderate advisories in the dev-only `ts-node-dev`/`glob`/`minimatch`/`rimraf` dependency chain, with no automatic fix available; `npm audit --omit=dev` reported zero runtime vulnerabilities. This pre-existing development-toolchain issue is outside the CSP fix.
- Chromium was tested against the unauthenticated login/static shell using an intentionally unreachable local test database. Real-account registration/login, server creation/invite join, channel creation/selection, persisted two-user messages and Socket.IO delivery were not end-to-end tested.
- No LiveKit URL/key or two independent accounts/browsers were available. Real voice, camera, screen sharing, network recovery, and permission revocation were not end-to-end tested.
- Docker was not available for an actual image build, and no GitHub push or Railway deployment was performed. Dockerfile, Railway configuration, build inputs, and health route were inspected; after deployment, execute the two-user/database/LiveKit acceptance plan in `AUDIT_REPORT_FA.md` before treating those capabilities as production-verified.

## Rebuild and deploy notes

The ZIP is a source project: it intentionally excludes `node_modules`, `dist`, the generated Tailwind stylesheet, and the generated LiveKit browser bundle. Run `npm ci` and `npm run build` for local execution. Railway’s Docker builder performs the build and runs `prisma migrate deploy` at startup. Configure Railway’s PostgreSQL `DATABASE_URL`, a strong `JWT_ACCESS_SECRET`, and LiveKit variables before validating authenticated or media features. No database reset or migration was performed as part of this fix.
