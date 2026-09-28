# Batty Brackets agent workflow

## Scope and prototype mode

Work in this checkout only. Do not search sibling worktrees, the old website,
backups, or docs/history unless the task specifically needs them. Inspect the
working diff first and preserve unrelated unfinished work.

Prototype mode stays active until the user explicitly asks to harden the product.
A demo, next-week tester, or pilot is still prototype work; it is not permission
to expand into a release-hardening project.
Implement the requested outcome and necessary supporting changes, then stop.
Do not add regression/smoke suites, broad refactors, dependencies, expanded
documentation, or adjacent cleanup by default. Record deferred verification
briefly; do not claim unperformed checks passed. Extract modules only when the
feature benefits directly. Search for relevant symbols and read bounded sections
rather than repeatedly loading large files or the whole repository.

## Product focus

Optimize for three working views: a snappy desktop host workspace (including
100-entrant events), a minimal mobile player screen, and a readable live TV.
The host can assume reliable internet. Players need fast signup, their next
opponent/station, result submission, and withdrawal on unreliable connections.
Keep profile customization, history, and other secondary content out of the
player's critical path. Keep the showcase demo separate from real event work
and isolated from real event data and sessions.

Complete one observable workflow at a time. Prefer existing vanilla modules
and narrow server commands over new frameworks or broad rewrites. Do not add
platform-admin features, integrations, or generalized infrastructure unless
requested or needed for the current workflow. Local/demo checks do not prove
cross-device sync; distinguish local, mocked-backend, and live-server evidence.

## Verification budget

- Copy/style changes: inspect the diff; check the affected screen when useful.
- UI interactions: exercise the changed path once OR run a relevant existing suite.
- Bracket calculations, persistence, undo: run focused existing tests.
- Authentication, permissions, production data: retain focused boundary checks.
- No mandatory bug reintroduction or new test for every prototype feature.
- After relevant checks pass, stop. Repeat only after relevant code changes or
  new evidence of a problem. Do not repair unrelated failures; report them.
- Before a tester handoff, check the affected end-to-end paths once and state
  known gaps. Run the broader regression/accessibility suites once when the
  user requests an integrated readiness review or release. Keep the CI gate.

## Delegation

These instructions apply equally to Codex and Claude; use the user's configured
model. Work in one agent by default to keep cost and coordination low. Delegate
only when requested or when a clearly independent task saves meaningful time;
use at most one delegate by default. Never assign concurrent edits to the same
shared file (especially views/admin.js, brackets.css, or lib/store.js).

Give delegates a self-contained brief instead of full conversation history when
supported. The supervisor identifies scope, reviews the resulting diff, and
resolves integration issues without repeating completed exploration or checks.
After two unsuccessful attempts at the same blocker, delegates return the error
and attempted fixes for supervisor diagnosis rather than continuing a retry loop.

Reusable delegate brief:
- Outcome and observable acceptance criteria:
- Checkout, owned files, relevant symbols, and necessary context:
- Excluded work and verification allowance:
- Return changed files, checks run/skipped, and blockers in a short handoff.

## Commands and map

No build step; serve this directory with `python -m http.server 8000`.

```
node test/run.mjs tv roster    # selected suites; quiet summaries by default
node test/run.mjs bracket     # Node-only selection avoids browser startup
node test/run.mjs --verbose tv # stream full diagnostics when needed
node test/run.mjs              # full suite for integration/release
node test/backend/contract-static.test.mjs # only for relevant contract changes
```

Browser suites require Playwright and axe (`cd test`, `npm install`, then
`npx playwright install chromium`). Missing Playwright skips selected browser
suites explicitly; a successful exit does not prove they ran. Read test/README.md
only when choosing a suite or diagnosing the harness.
On Windows, an installed Chrome/Edge can be selected through
`$env:BRACKETS_CHROMIUM='C:/Program Files/Google/Chrome/Application/chrome.exe'`
before the test command; verify the path exists instead of installing another
browser by default.

- app.js: boot, hash router, chrome
- views/: screen modules; views/admin.js: organizer tabs and event operations
- brackets.css: shared design system
- lib/: bracket engine, store, auth, guidance, CSV, UI helpers
- data/: games, rulesets, themes, demo seed
- sql/staging/, backend/: reviewed migrations and contracts
- docs/history/: optional historical context, possibly outdated

Vanilla ES modules, tagged-template html helper in lib/ui.js, delegated data-act
events, inline SVG icons. Follow surrounding patterns; no architectural rewrite
for token savings. Localhost is deliberately device-only for development.

## Boundaries and release

config.js contains only public browser configuration; never add service-role
keys, CAPTCHA secrets, or passwords. sql/001_schema.sql is historical, not an
install script; use the reviewed staging migration path for backend work.
Preserve accessible controls and contrast; do not weaken accessibility assertions
to hide regressions. Full accessibility sweeps are milestone checks, not required
for every small prototype edit.

Work on a branch. Main publishes to battybrackets.com through GitHub Pages after
the full CI test job succeeds. Require green CI before merging; do not duplicate
the whole CI run locally unless investigating a failure or preparing a milestone.
