# Roadmap

Everything outstanding, in the order I would do it, with the reasoning
attached. Two rules for this file: nothing goes in without a reason, and
anything that gets done comes out. A to-do list nobody deletes from stops
being read.

Status as of September 2026: the local app and refreshed player/host UI are
built and tested, but no connected backend has been activated and no real event
has run. A replacement staging schema and explicit client contract exist; their
presence is not proof that database permissions or cross-device operation work.

The first pilot targets a Marvel Tōkon local. The selected sports-publication
identity and broadcast-style venue display are implemented locally, alongside
reviewed setup, backup/recovery and TV-completion improvements. Creator identity
is Batty Brackets, By BattyDev; game identity remains separate. Local/demo
screens do not advertise cross-device joining. Follow LOCAL-REHEARSAL.md before
the first event. This does not replace backend validation or the observed event
below: online registration is still unconnected.

---

## Now — the two that block everything else

### 1. Verify and connect the replacement backend

**Nothing in `sql/` has ever run against a real project.** The historical
`sql/001_schema.sql` must not be applied: review found authorization, contact
consent, identity and registration-insert defects. The replacement is the
isolated schema under `sql/staging/`, with the wire contract in `backend/` and
an explicit client boundary in `lib/backend.js`.

This is first because **decisions upstream of it change if the security model
has a flaw**. It is much cheaper to find that now than after there are events
in it.

- [ ] Choose and provision a dedicated empty Supabase staging project; confirm
      owner, region and budget before any paid resource is created
- [ ] Apply `sql/staging/` only, then run every adversarial test in
      `test/backend/` with anonymous, player, staff and owner roles
- [ ] Integrate authenticated identity, create, list, code redemption, join and
      event reads through `lib/backend.js`; do not enable the generic store
      outbox or automatically upload local/demo data
- [ ] Partition connected caches and queues by project and account; clear
      protected data on sign-out/account switch
- [ ] Add authoritative report/correct/station-release commands with operation
      IDs and expected revisions before promising a connected live bracket
- [ ] Rehearse organiser laptop, player phone and TV as independent clients,
      including capacity races, reconnect, stale state and failed writes
- [ ] Only then fill in `config.js` with the public URL and publishable key —
      **never** a service-role key or database password

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

Anything over about 64 entrants needs it, and plenty of smaller events want it
anyway — pools are how you keep six stations busy instead of two. Snake seeding
is implemented and tested; it is the phase model and the UI that do not exist.

The wizard already has a `poolsEnabled` flag and a pool count that currently do
nothing, which is worse than not having them. Either build this or take them
out.

- [ ] **Phase model in the data.** An event becomes an ordered list of phases
      rather than one bracket. This is the change everything else waits on, and
      it reaches the bracket engine, the run view, the TV display and the
      player view. Doing it as a bolt-on beside the existing single-bracket
      shape is the version that has to be undone later.
- [ ] **Pool assignment**, honouring the separation rules already written —
      same team, same region, and a rematch from the last event apart where the
      arithmetic allows it
- [ ] **Advancing N from each pool**, with the arithmetic shown. A TO should
      never have to work out whether 7 pools of 5 advancing 2 fills a 16 bracket
      — the screen should say what it fills and what the byes look like
- [ ] **Pool formats that are not brackets.** Round robin is what most pools
      actually are, and the engine only does elimination today
- [ ] **Tie-breaking**, stated up front rather than argued about after: sets
      won, then games, then head-to-head, then a coin flip nobody enjoys
- [ ] **Per-pool everything** — the run view, the queue and the TV display all
      need a pool filter, or a TO with six pools is reading one list of ninety
      sets
- [ ] Pool assignment must survive the thing that always happens: four people
      no-show after pools are drawn and one pool is suddenly a three-man

### Printable brackets

Every venue has a wall and most have a printer, and the paper bracket is not
nostalgia — it is the thing that keeps working when the wifi does not, which is
the same argument the whole local-first design rests on. It is also how a
spectator sees the bracket without being handed somebody's phone.

The web view cannot be reused as-is. A bracket sized to be legible on a screen
you can pan is not one that fits A4, and the interactive affordances — buttons,
hover states, the scroll container — are all noise on paper.

- [ ] **A print stylesheet**, not a separate renderer. `@media print` against
      the existing bracket markup: drop the chrome, flatten the scroll pane,
      force light colours, and put the event name, game, date and generated-at
      time in a header so a sheet on a wall says which event it is and how old
      it is
- [ ] **Paginate a large bracket** across sheets that can be taped together,
      with round labels repeated on every sheet. A 128-entrant bracket on one
      A4 is a grey smear
- [ ] **Blank lines where results are missing**, wide enough to write on. The
      printed bracket's real job at a local is to be filled in with a pen and
      typed back in later
- [ ] **The other three things people actually print**, which matter more than
      the bracket and are far less work:
      - a **check-in sheet** — tag, seed, paid, signed, with a box to tick
      - **station signs** — one number per sheet, readable across a room
      - **top 8 for the stream**, and the payout split
- [ ] **Test it against a real printer**, not a PDF preview. Margins, colour
      that goes muddy in greyscale, and a browser that decides the second page
      is blank are all things a preview will not tell you
- [ ] Consider **paper as an input**: a printed bracket filled in by hand is a
      queue of results waiting to be entered, and entering them one dialog at a
      time is the slow path this app exists to avoid

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
