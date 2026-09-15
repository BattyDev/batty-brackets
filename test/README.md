# Tests

```
node brackets/test/run.mjs              # everything
node brackets/test/run.mjs tv roster    # only suites whose filename matches
node brackets/test/browser/tv.test.mjs  # one suite, directly
```

Two kinds, in two directories, for two different reasons.

## The Node tests — pure functions, no dependencies

`bracket.test.mjs` and `theme.test.mjs` run on a bare `node` with nothing
installed. Between them they make 848 assertions about the two parts of this
app that are pure functions, and pure functions are the cheap half to test:

- **`bracket.test.mjs`** — double elimination. Seeding order against the
  Challonge/start.gg convention, byes, forward pointers, losers-side drop
  routing, grand final reset, DQ propagation, undo, and the projection an
  undo has to rebuild. It has been right and my expectations wrong at least
  once: the engine produced `1v8, 4v5, 2v7, 3v6` and I had written the test
  expecting a different order. The engine was following the convention every
  other bracket site uses. I fixed the test.
- **`theme.test.mjs`** — the 21 game palettes. Every colour pairing the app
  can paint, in both schemes, against the WCAG contrast requirement, plus
  perceptual distinctness between games in OKLab. This is where the record of
  two failed attempts at spreading 21 hues lives.

## The browser tests — everything that is not a pure function

`browser/` needs Playwright and axe-core:

```
cd brackets/test && npm install && npx playwright install chromium
```

They are optional. `run.mjs` skips them with a note if Playwright is not
installed, so the fast half stays runnable on a machine that does not want a
300MB dependency. `node_modules/` is gitignored; the app itself still has no
dependencies and no build step.

### Why they exist

Every bug this project has actually shipped lived outside the reach of a unit
test:

| What shipped | What would have caught it |
|---|---|
| A tour card that rebuilt itself once a second, so it jumped away from the pointer | `stability` |
| `opacity` dimming text below contrast — twice, in two views | `a11y` |
| A bracket pane that could not be scrolled without a mouse | `keyboard` |
| A drag handle wired to an empty function — inaccessible *and* broken | `wcag22` |
| A session written one level too deep, so a reload signed you out | `tours` |
| A TV screen drawing eight perfectly sized empty columns | `tv` |
| Tour steps sharing a route silently never advancing | `tours` |

Not one is visible to a unit test. All of them are visible in about four lines
of Playwright.

### The suites

| Suite | What it holds down |
|---|---|
| `a11y` | axe-core across 15 routes × dark, light and phone. Zero violations is the bar. |
| `wcag22` | The three 2.2 criteria axe does not fully cover: target size, focus not obscured, no drag-only interaction. |
| `keyboard` | Skip link, focus containment in dialogs, Escape, the bracket pane's tab order, accessible names, 200% zoom reflow, reduced motion. |
| `flows` | Twenty steps from landing page to reported result, then the same routes at 390px. Asserts each step's *outcome*, and that nothing threw anywhere along the way. |
| `roster` | Sorting by every header, filters that replace within a group and combine across groups, and select-all staying scoped to the filtered view. |
| `stability` | The tour card is the same DOM node six seconds later — **and** the live clock is still ticking, because a fix that stopped the flicker by stopping the clock would pass half a test and fail a user. |
| `tours` | All three demos walked end to end, every step landing on a real route and no step repeating itself; the borrowed player identity handed back on reset. |
| `tv` | Both screens have real content at **five different event depths**, no column scaled below the readable floor, the rotation rotating, and no timer left running after you leave. |
| `local` | Both demo and real device-only events direct arrivals to the organiser instead of advertising a join link that cannot work on another device. |
| `brand` | Publisher/creator identity, editorial typography, real setup action, 320/390px reflow in both schemes, and broadcast station rows with actual calls. Includes negative probes for lost typography and missing TV identity. |
| `setup` | Local capacity/station creation, station bounds, provisional-rule acknowledgement, and truthful device-only setup controls. |
| `recovery` | Immediate durable snapshots, reload/corruption/quota failures, validated portable backups, cleared undo history, and deliberate approval of imported server writes. |

For optional design-review screenshots, set `BRACKETS_SCREENSHOTS` to a local
output directory before running `node test/run.mjs brand`. The test captures
desktop and phone landing pages and an active venue queue in both schemes.

The local-event regression was checked by restoring the TV header's original
unconditional join code: both demo and real-event assertions failed. Restoring
the configuration/demo guard made all nine assertions pass.

### The rule these follow

`rehearsal` creates a fresh eight-place Tōkon event through the wizard, imports
a duplicate and an overflow entrant, adds a walk-up, generates the admitted
bracket, un-reports a score, records a DQ, downloads a real backup and restores
it after reload. It uses an isolated browser context and never touches a real
organiser's data. Run with `node test/run.mjs rehearsal`.

The initial rehearsal failed on both import and walk-up capacity handling:
neither path set `waitlisted`, and the generated bracket exceeded the cap.
The fix counts admitted entrants (including the pending import batch), leaves
overflow on the roster as waitlisted, and states that consequence in the import
preview before committing. This is a local follow-up to release `f84f029`, not
part of that deployed snapshot.

**Assert, do not print.** An earlier version of these scripts logged what they
found and left a human to notice something was wrong, which is not a test — it
is a screenshot with extra steps. Every check ends in `ok()` and the process
exits non-zero if any failed.

**And prove the assertion can fail.** Each of these was checked by putting the
original bug back and confirming the suite goes red. That step is not optional
and it caught a bad test: the TV suite as first written played the demo forward
to one depth, looked at the bracket, and passed — *with the original bug
reintroduced*. The failure is depth-dependent by nature, so one depth proves
nothing. It sweeps five now, and fails at exactly the three where the bug lived.

### Notes

- The runner starts its own static server on a **free** port and passes it to
  every suite. Suites hardcoded `8765` once and could pass against a stale
  server left running from an earlier session — testing the old code, in green.
- `harness.mjs` finds Chromium in three steps: `BRACKETS_CHROMIUM` if set, then
  a normal `chromium.launch()`, then a scan of `PLAYWRIGHT_BROWSERS_PATH`. The
  third exists for containers that ship a browser build older than the installed
  Playwright expects — the browser works fine, only the revision number in the
  path disagrees.
- `openApp` waits for the demo seed rather than sleeping a fixed 800ms. Waiting
  for the thing you need is both faster and less flaky, which is a rare
  combination.
