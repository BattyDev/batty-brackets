# AGENTS.md — /brackets

Scope: **this directory only.** `brackets/` is a self-contained app inside a
static personal site. Nothing else in the repository shares code with it.

## Getting a copy

```
git clone https://github.com/BattyDev/BattyDev.github.io
cd BattyDev.github.io/brackets
```

Sparse checkout, if you only want this directory:

```
git clone --filter=blob:none --sparse https://github.com/BattyDev/BattyDev.github.io
cd BattyDev.github.io
git sparse-checkout set brackets
```

## What it is

A tournament bracket site for the fighting game community — `battydev.com/brackets`.
About 10,900 lines of vanilla JavaScript. Local-first: reads are synchronous
from memory, writes land on the device and queue for Supabase. That design is
the answer to the complaint the project started from ("performance" — meaning
venue wifi), so it is load-bearing rather than incidental.

Read `README.md` before changing anything. It is long and it is the design
record: what was tried, what failed, and why the code looks the way it does.
`ROADMAP.md` is what is outstanding, in order, including a section on what is
deliberately **not** being built yet.

## Running it

Any static server. There is no build step.

```
python3 -m http.server 8000    # from the repository root
# http://localhost:8000/brackets/
```

It seeds a demo tournament on first load — 28 entrants, four no-shows, a
duplicate, a walk-up with a claim code, a season of past results. Chosen to
exercise awkward cases rather than to look good.

## Testing

```
node test/run.mjs              # everything: 12 suites
node test/run.mjs tv roster    # only suites whose filename matches
```

Two Node suites (bracket engine, colour palettes) need nothing installed. Ten
browser suites need Playwright and axe:

```
cd test && npm install && npx playwright install chromium
```

They are skipped with a note if those are missing, so the fast half always
runs. **Run the browser half before claiming a change works.** Every bug this
project has actually shipped — a tour card that rebuilt itself once a second,
`opacity` dimming text below contrast, a bracket pane you could not scroll
without a mouse, a TV screen drawing eight perfectly sized empty columns —
lived outside the reach of a unit test.

`test/README.md` explains each suite and the rule they follow: **assert rather
than print, and prove each assertion can fail by putting the original bug
back.** That step caught a bad test once already; do not skip it when adding
one.

## Hard constraints

Breaking any of these is a rewrite, not a change.

1. **No build step and no framework.** Vanilla ES modules served as files. Do
   not add Vite, React, Tailwind, TypeScript compilation or a bundler. The
   whole point is that the deployed thing is the source.
2. **The app has zero runtime dependencies.** `test/` holds the only
   `node_modules` in the repository and it is dev-only and optional. Nothing
   under `app.js`, `lib/`, `views/` or `data/` may import from npm.
3. **`config.js` may contain only the public Supabase URL and the publishable
   key.** Never a service role key, never the database password. Both of those
   bypass row-level security entirely. The file is blank on purpose right now —
   there is no backend connected yet.
4. **Material 3 is hand-rolled in `brackets.css`.** Tokens, type scale, state
   layers, elevation, shape. Do not add `@material/web`, a web font or an icon
   font; icons are inline SVG for a reason stated in `lib/ui.js`.
5. **Accessibility is at zero axe violations and WCAG 2.2 AA**, and there are
   committed tests holding it there. Do not use `opacity` to de-emphasise
   text — that has failed contrast twice in this codebase. Use an explicit
   colour token.
6. **`main` is production.** GitHub Pages serves it directly with no CI step,
   so a push to `main` deploys `battydev.com` immediately. Work on a branch.

## House style

Heavy "why" comments. This codebase documents reasoning, not mechanics — what
was tried, what broke, and what the alternative would have cost. Several
comments record a fix that was reverted once already, which is the reason they
exist. Match that density; a change with no explanation attached is harder to
review here than a longer one with it.

Match the surrounding file for everything else: naming, structure, the
tagged-template `html` helper in `lib/ui.js`, and event delegation through
`data-act` attributes rather than per-element listeners.

## Layout

```
app.js          router, shell, global actions
config.js       Supabase URL and publishable key (blank by design)
brackets.css    the whole design system
lib/            store, auth, bracket engine, guidance, CSV, UI helpers
views/          one module per screen
data/           games, rulesets, themes, demo seed
sql/            schema, RLS policies, RPCs — written, never yet applied
test/           see test/README.md
```

Two references reach outside this directory, both harmless: the home button
links to `../index.html`, and the official-artwork slot in `data/themes.js`
reads `../assets/games/<id>/<file>`, a directory that does not exist and is
empty on purpose — see the licensing note in `README.md`.
