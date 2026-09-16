# AGENTS.md — Batty Brackets

A tournament bracket app for the fighting game community, served at
`battydev.com/brackets`. Self-contained: nothing outside this directory shares
code with it.

## Running and testing

No build step. Serve the directory statically:

```
python3 -m http.server 8000
# http://localhost:8000/brackets/
```

```
node test/run.mjs              # everything: 3 Node suites + 17 browser suites
node test/run.mjs tv roster    # only suites matching those names
node test/backend/contract-static.test.mjs # staging/client contract drift
```

The Node half (bracket engine, colour palettes, backend client) needs nothing
installed. The browser half needs Playwright and axe — `cd test && npm install
&& npx playwright install chromium` — and skips with a note when they are
missing, so a green run does not necessarily mean a full run. Check which half
actually executed before concluding a UI change works.

That matters more here than usual: most bugs this project has shipped were
invisible to unit tests. A tour card rebuilding itself once a second, `opacity`
dimming text below contrast, a bracket pane unscrollable without a mouse, a TV
screen drawing eight perfectly sized empty columns. `test/README.md` covers the
suites and the convention they follow.

## Two things that are actually load-bearing

Everything else in this file is description. These two are not:

1. **`config.js` holds only a public project URL and publishable key.** A
   service role key or database password there bypasses row-level security
   completely, and this is a static page whose source anyone can read. The
   values are blank right now, which is a working mode, not a broken one.

2. **The accessibility tests are load-bearing, not decoration.** `a11y` and
   `wcag22` hold the app at zero axe violations and WCAG 2.2 AA. If a change
   turns them red, the change is what's wrong. Contrast has been broken twice
   here by using `opacity` to de-emphasise text, hence an explicit colour token
   in those spots.

Also worth knowing before touching the backend: `sql/001_schema.sql` is a
historical design, not a safe install script. The reviewed replacement is in
`sql/staging/` with its contract under `backend/`. The setup notes in
`config.js` point at that reviewed staging path.

## How it's currently built

Described so you can find your way around — not a specification to preserve.
If a change is better served by a different approach, that is a normal
engineering call, not a violation.

```
app.js          boot, hash router, chrome
brackets.css    the whole design system
data/           games, rulesets, themes, demo seed
lib/            bracket engine, store, auth, guidance, CSV, UI helpers
views/          one module per screen
sql/, backend/  schema, policies, staging contract
test/           see test/README.md
docs/history/   the original design record
```

Today it is ~12k lines of vanilla ES modules with zero runtime dependencies —
no framework, no bundler, no TypeScript step. Material 3 is hand-rolled in
`brackets.css` rather than pulled from `@material/web`, icons are inline SVG,
rendering goes through a tagged-template `html` helper in `lib/ui.js`, and
events are delegated via `data-act` attributes instead of per-element
listeners. The bracket is CSS grid with border connectors, not SVG.

Those choices came from wanting the deployed thing to *be* the source, and from
venue wifi being the original complaint. They're still reasonable defaults and
following them keeps a diff consistent with its surroundings. They are not
walls. Introducing a build step, a framework, or a dependency is a real option
if it earns its place — it's a judgement call about tradeoffs, and worth saying
out loud in the change, but it is not off limits.

Two references reach outside this directory: the home button links to
`../index.html`, and the artwork slot in `data/themes.js` reads
`../assets/games/<id>/<file>`, a directory left empty for licensing reasons.

## Deploying

This repository is assembled into `BattyDev.github.io` at `/brackets/` by the
site repository's Pages workflow. A push to `main` runs the full test workflow
here first. When `SITE_DISPATCH_TOKEN` is configured, `publish.yml` then asks
the site repository to rebuild immediately; otherwise its hourly schedule is
the fallback. Work on a branch and require green tests before merging.

`docs/history/design-record.md` is the old detailed README: the reasoning trail
for why things look the way they do. It is searchable context when a decision
seems strange, not required reading, and parts of it are out of date.
