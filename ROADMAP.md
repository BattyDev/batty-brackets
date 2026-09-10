# Roadmap

Everything outstanding, in the order I would do it, with the reasoning
attached. Two rules for this file: nothing goes in without a reason, and
anything that gets done comes out. A to-do list nobody deletes from stops
being read.

Status as of this writing: the app is built and tested, has never touched a
server, and has never run an event.

---

## Now — the two that block everything else

### 1. Connect the backend

**Nothing in `sql/` has ever run.** The RLS policies, the claim RPC, the
entry-guard trigger, the auth-methods lookup and the new
`bkt_event_by_code` are all written and unapplied. The camelCase ↔
snake_case boundary in `store.js` is untested against real PostgREST.

This is first because **decisions upstream of it change if the security model
has a flaw**. It is much cheaper to find that now than after there are events
in it.

- [ ] Apply `sql/001_schema.sql` to the `battydevsite` project
- [ ] Enable the Discord provider — redirect `https://battydev.com/brackets/`, scopes `identify email`
- [ ] Fill in `config.js` (public URL and publishable key only — **never** a service role key or the database password)
- [ ] Verify demo seeding stops the moment a project is named; an account with a real backend must look empty when it is empty
- [ ] Test the sync queue against a genuinely bad connection, not a fast one — that is the case it exists for
- [ ] Re-run the browser suites against the connected build

**Expect to fix things on first connection.** Sync code that has never seen a
server is not working code, it is code that has not failed yet.

### 2. Run one real event on it

Every design argument in this project traces back to five complaints from one
person and my inference from them. The guidance engine's sixteen rules, the DQ
thresholds, the seeding tolerance of two — all plausible, none tested against a
room with thirty people in it.

- [ ] Run a weekly on it. Eight people is enough. Shadow start.gg so nothing is at risk
- [ ] Watch what the TO actually does, not what they say afterwards
- [ ] Note every time somebody asks a question the screen should have answered

**One night of this is worth more than another month of features.** It is also
the only way to find out whether the local-first bet pays off, which is the
whole thesis.

---

## Next — the adoption lever

### start.gg import

The single biggest thing standing between this and anyone using it, and still
not built.

Nobody switches bracket sites when their history is empty. That is the entire
reason the incumbent is sticky — not its features, which people complain about
constantly, but the four years of results attached to their account. Everything
else on this list is a nicer version of something people already have.

- [ ] Read a start.gg event: entrants, seeds, sets, placements
- [ ] Map their player identities onto ours, including the ones with no Discord
- [ ] Import past results into player passports so a new account is not empty on day one
- [ ] Handle the halfway case: an event that started there and needs to continue here

---

## Then

### Player self-reporting and disputes

Staff-only reporting caps an event at about 32 entrants, because past that one
person cannot keep up with the queue. The data model is already ready — results
are superseded rather than deleted, so the audit trail exists — and only the
flow is missing.

- [ ] A player reports their own set; the opponent confirms or disputes
- [ ] A disputed set goes to a staff queue with both claims visible
- [ ] Trust weighting: somebody who has never been disputed should not need a confirmation for every set

### Discord notifications

"You're up, station 4" is probably the most-loved feature this could have. It
needs a bot and a server, so it is the first thing that breaks the no-backend
architecture — which is why it is here and not higher.

- [ ] Bot, per-org install
- [ ] DM on: called to station, DQ warning, bracket posted, event starting
- [ ] Opt-out that actually works, per event and globally

### Pools → top cut

Anything over about 64 entrants needs it. Snake seeding is implemented and
tested; it is the phase model and the UI that do not exist.

- [ ] Phase model in the data
- [ ] Pool assignment honouring the separation rules already written
- [ ] Advancing N from each pool into a bracket, with the arithmetic shown

---

## Known gaps in what is already built

These are real and they are not urgent. Written down so they are decisions
rather than oversights.

- [ ] **The bracket blob is written by a client you must assume is hostile.**
      Staff can write anything into `bkt_brackets.matches`. Fine for a weekly,
      not fine once there is a pot. Progression should move into a server-side
      function before money is involved.
- [ ] **`bkt_event_by_code` has no rate limit.** Invite codes are short. It
      requires a signed-in caller, which buys something — a guesser needs an
      account, and accounts can be banned — and it is not sufficient on its
      own. Needs a per-caller attempt limit before unlisted events are relied
      on for anything sensitive.
- [ ] **Unlisted is not private.** It is a discoverability setting and the UI
      says so in those words. Genuinely private events — where the entrant
      list is not visible to everyone holding the link — are a different
      feature and would need per-event membership checks on entries and
      brackets too.
- [ ] **The guidance rules have never been tuned.** Some of those sixteen will
      be noise at a real event. Instrument which get acted on versus dismissed
      and cut the losers. An assistant that cries wolf is ignored by lunchtime,
      which is worse than not having one.
- [ ] **`localStorage` will run out.** Fine for one event, not for season-long
      history. It moves to IndexedDB behind the same two functions when that
      day comes — the store was written so this is a swap, not a rewrite.
- [ ] **The waiver question is legal, not technical.** Minors cannot consent, so
      a waiver needs a guardian. It is flagged in the UI and in the README and
      it needs an actual answer from the venue before anyone relies on it.
- [ ] **Nineteen games have placeholder identities.** Colour ramps and letter
      marks, no artwork. That is deliberate — see below.

---

## What I would deliberately not do yet

**Resist adding surface.** The project got broad fast: 21 games, a venue
display, three demo tours. The risk now is breadth without validation.

- **No bespoke artwork for the other 20 games** until a TO actually runs one of
  them on this. The placeholder identities are honest and they work; commissioning
  or drawing twenty more is a month spent on something nobody has asked for.
- **No official game assets** without written permission. The Marvel Tokon
  artwork here is original for exactly this reason — there is no official fan
  kit, and Marvel art is Disney IP. The licensing path is documented in the
  README; the slot to drop official assets into exists and is empty on purpose.
- **No payments** until an event has run without them and somebody has asked.
- **No mobile app.** The web app works at 390px and is tested there. An app is
  a second thing to maintain and a store review cycle between a bug and its fix,
  which is the wrong trade for software used in a room for four hours a week.

---

## Advice given and not yet acted on

Kept separately from the plan because these were recommendations rather than
decisions — they are here so they do not quietly disappear.

- **Instrument the guidance engine before tuning it.** Guessing which of the
  sixteen rules are noise is how you delete the useful ones.
- **Watch a TO use it before changing the organiser tools.** Every complaint
  that started this project came from someone using the alternatives, and the
  next round of them will come from someone using this.
- **The local-first bet is unproven.** It is the whole thesis — writes land on
  the device, sync is background — and it has never been tested on venue wifi.
  If it turns out not to matter, several design decisions get simpler.
- **Do not promote a placeholder game to bespoke on aesthetics alone.** The
  trigger should be a TO running that game, not a free afternoon.
