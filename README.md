# Batty Brackets

Tournament brackets for fighting games, built for the people running them.
Served at [battybrackets.com](https://battybrackets.com/).

For the next tester handoff, see [TEST-READINESS.md](TEST-READINESS.md): the
three-view scope, confirmed connected-workflow gaps, and a short manual check.
Follow [DEVELOPMENT-WORKFLOW.md](DEVELOPMENT-WORKFLOW.md) for ordered copy/paste
prompts, recommended models, manual checkpoints, and handoffs between agents.

Production is connected to Supabase through the explicit RPC boundary. Local
development deliberately stays device-only: open it on localhost and a
28-entrant demo event is seeded into your browser, with no account or network
dependency.

## Running it

No build step. Any static server will do:

```
python3 -m http.server 8000
# http://localhost:8000/
```

The demo seeds on first load only, and never over real data.

## Testing

```
node test/run.mjs              # everything
node test/run.mjs tv roster    # only suites matching those names
node test/backend/contract-static.test.mjs # staging/client contract drift
```

The runner discovers the dependency-free Node suites and browser suites by
filename. Browser suites need Playwright and axe:

```
cd test && npm install && npx playwright install chromium
```

Missing those, the browser half skips with a note so the fast half always runs.
`test/README.md` covers each suite.

## What's here

```
index.html      app shell
platform-admin.html  separate MFA-gated platform administration console
brackets.css    the design system, hand-rolled (~2.1k lines)
config.js       production Supabase URL + publishable key; localhost stays blank
app.js          boot, hash router, chrome
data/           game registry, rulesets, themes, demo seed
lib/            bracket engine, store, auth, guidance, CSV, UI helpers
views/          one module per screen
sql/            reviewed schema, policies and ordered staging migrations
backend/        the staging backend contract
test/           see test/README.md
docs/history/   the original design record, archived
```

About 12k lines of vanilla ES modules, no runtime dependencies, no framework.

## State of things

**Working end to end:** game registry and rulesets, setup wizard, entrant grid
with bulk ops and undo, CSV import with column mapping and dry-run diff, export,
seeding with separation and projection, single and double elimination with byes
and DQ and un-reporting, station queue, guidance engine, player passport,
claimable walk-up players, document signing, offline write queue, light/dark and
per-game theming, and the guest tour.

**Connected in production.** `battybrackets.com` uses the configured Supabase
project for authentication, event discovery and explicit versioned commands.
Localhost intentionally keeps the connection blank so tests and device-only
events cannot touch production data.

**Platform administration is staged on this branch.** `/platform-admin.html`
uses its own Supabase session namespace and requires email/password, TOTP AAL2,
and a current private admin membership. Analysts can read metrics; moderators
and super admins can review the whitelisted public content feed, make audited
moderation decisions, and inspect the moderation log. The `106_admin.sql`
migration and first super-admin membership must pass staging before production
activation.

**Not built:** start.gg import, Discord notifications, self-reporting and
disputes, pools → top cut, printable brackets and signage, payments, per-player
privacy controls, stream tooling.

`ROADMAP.md` has the outstanding work in rough order, including what is
deliberately being left alone for now.

## Backend boundary

`sql/001_schema.sql` is a historical design, **not** a safe install script —
review found contact-consent, grants, identity and registration weaknesses. The
replacement is in `sql/staging/`, with its contract under `backend/`. New
backend changes extend that ordered migration set; the historical file remains
documentation rather than an install path.

`config.js` holds the public project URL, publishable key, and CAPTCHA site key.
A service role key, CAPTCHA secret, or database password must never be placed
on a page whose source anyone can read.

## Deploying

GitHub Pages publishes this repository directly at the domain root. A push to
`main` runs every Node and browser suite first; the same workflow deploys only
after that test job succeeds. The custom domain is configured in the
repository's Pages settings, not by committing a `CNAME` file.

The old `battydev.com/brackets` assembly can remain available during the
transition. Share links derive their origin and path from the page currently
serving the app, so both locations continue to produce usable links.
