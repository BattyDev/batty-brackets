# Batty Brackets

Tournament brackets for fighting games, built for the people running them.
Served at [battydev.com/brackets](https://battydev.com/brackets).

Open it and a tournament is already running — a 28-entrant demo event seeded
into your own browser, no sign-in, with a reset button. There is no backend
connected yet, so everything lives on the device.

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

Three Node suites (bracket engine, colour palettes, backend client) need
nothing installed. Seventeen browser suites need Playwright and axe:

```
cd test && npm install && npx playwright install chromium
```

Missing those, the browser half skips with a note so the fast half always runs.
`test/README.md` covers each suite.

## What's here

```
index.html      app shell
brackets.css    the design system, hand-rolled (~2.1k lines)
config.js       Supabase URL + publishable key — blank, so it runs on-device
app.js          boot, hash router, chrome
data/           game registry, rulesets, themes, demo seed
lib/            bracket engine, store, auth, guidance, CSV, UI helpers
views/          one module per screen
sql/            schema and policies — written, not yet applied
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

**Not connected to a backend.** No Supabase project is configured, so the sync
paths in `store.js` and `auth.js` have never run against a real PostgREST.
Expect to fix things on first connection.

**Not built:** start.gg import, Discord notifications, self-reporting and
disputes, pools → top cut, printable brackets and signage, payments, per-player
privacy controls, stream tooling.

`ROADMAP.md` has the outstanding work in rough order, including what is
deliberately being left alone for now.

## Before connecting a backend

`sql/001_schema.sql` is a historical design, **not** a safe install script —
review found contact-consent, grants, identity and registration weaknesses. The
replacement is in `sql/staging/`, with its contract under `backend/`, and it
targets an empty staging database rather than an in-place upgrade. The setup
notes in `config.js` point at that reviewed staging path.

`config.js` takes a project URL and a publishable key, both public by design.
A service role key or database password there would bypass row-level security
entirely on a page whose source anyone can read.
