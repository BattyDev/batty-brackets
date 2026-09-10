# Brackets — battydev.com/brackets

Tournament brackets for fighting games, built for the people running them.

Static page on GitHub Pages, optionally backed by Supabase — same shape as
`/fcevents` and `/health`. No build step, no server, no framework.

**It runs right now with no backend at all.** `config.js` is blank, so the app
keeps everything on the device and seeds a demo event. That is not a stub for
the sake of a demo: a TO running a 16-person weekly off one phone genuinely
does not need a server, and the corner of the app bar says "On this device"
rather than pretending otherwise.

**Open it and there is a tournament already running.** No sign-in, no account:
a 28-entrant Marvel Tōkon weekly seeded into your own browser, with a guided
walkthrough and a reset button. See [Try it](#try-it).

---

See [ROADMAP.md](ROADMAP.md) for what is outstanding and in what order.

## Contents

- [Try it](#try-it)
- [What is wrong with the existing sites](#what-is-wrong-with-the-existing-sites)
- [What this does differently](#what-this-does-differently)
- [Accessibility](#accessibility)
- [Official game artwork](#official-game-artwork)
- [Holes in the original plan](#holes-in-the-original-plan)
- [The games](#the-games)
- [Marvel Tokon](#marvel-tokon)
- [The player side](#the-player-side)
- [Architecture](#architecture)
- [What is built and what is not](#what-is-built-and-what-is-not)
- [Running it](#running-it)

---

## Try it

Open `battydev.com/brackets` and a demo weekly is already there — 28 entrants
signed up, four of whom will not show, a duplicate registration, a walk-up
entrant with a claim code, and a season of past results behind it.

There are **three tours**, because three different people look at this and want
different things:

| | |
|---|---|
| **Running it** | Nine steps through the organiser's night: the roster and its bulk tools, check-in with four no-shows, the seeding lab, a bracket with sets played and DQ timers running. |
| **On the TV** | Four steps through the venue display — who is up, where the bracket has got to, and the rotation between them. It plays the event forward far enough first that both screens have something real on them: a shallow bracket makes the second screen pointless, and a finished one empties the first. |
| **Playing in it** | Six steps from the seat of somebody who paid five dollars: check in, sign the code of conduct, see who you are against and your head-to-head, get called to a station, and watch the result land on your record. |

Offering the organiser's tour to a player and hoping they extrapolate is how a
demo fails to land.

None of them is a slideshow or a video. Each step performs the same store writes
a real user would and then hands control back, so you can stop at any point,
click something else entirely, and everything still works — because it is the
real application, not a mock of it. The player tour goes furthest: it *borrows*
a demo entrant's identity rather than faking a player view, so those screens run
exactly the queries a real account would. Ending the tour or resetting hands the
identity back.

That is only possible because of the local-first design: with no backend
involved, "a demo tournament" is just a store you happen to own.

**Reset** puts it back exactly as it started. It restores only rows carrying
the demo flag, so an event you made yourself is never touched.

Nothing about the demo reaches a server. There is no server.

---

## What is wrong with the existing sites

The brief came with a list from someone who runs events: *performance, mobile
variations, lack of organizer friendly tools, no way to mass import, update, or
edit, seeding is very annoying to implement.* That list is the specification.
Here is what each one actually is, and what was done about it.

### Performance is an architecture problem, not a tuning problem

start.gg is online-first. Every screen is a round trip. At a venue, on a
congested 2.4GHz access point shared with sixty phones and eight consoles, every
screen is therefore a spinner — and reporting a set becomes: tap, wait, wonder,
tap again, create a duplicate.

You cannot fix that by making the server faster, because the server was never
the slow part. The fix is to stop asking it anything on the hot path.

An entire event is a few hundred kB of JSON. It fits on the phone. So here every
read is synchronous out of memory, every write lands locally and is *then*
queued, and the network's only job is to make other people's copies agree with
yours eventually. Turn the wifi off mid-event and nothing changes except the
chip in the corner, which tells you exactly how many writes are waiting —
because an app that silently swallows writes on bad wifi is how you get a TO who
stops trusting it.

The rest follows from the same commitment: no framework, no component library,
no webfont, no icon font. **108kB over the wire** — 97kB of JavaScript and 11kB
of CSS, gzipped, which is what a static host actually serves. (390kB
uncompressed, but a quarter of that is comments; nothing here is minified,
because there is no build step to minify it.) There is no third-party request
at all unless a Supabase project is configured, and the first paint does not
wait on anything.

### "Mobile variations" means the organiser tools are desktop-only

parry.gg is genuinely mobile-first and it is the better phone experience — but
its browser story for a TO setting an event up is thin. start.gg is the reverse:
a real desktop TO suite and a phone experience that is mostly a viewer.

Both leave the TO chained to a laptop at the door, which is exactly the wrong
place for the one person who needs to be walking around the room.

Here there is one app. Every organiser action — bulk edit, seeding, calling
sets, reporting, changing a rule mid-event — works at 390px. The nav is a bottom
bar on a phone and a rail from 600px up, which is Material 3's own breakpoint
and the only layout decision that actually matters.

### Organiser tooling models the happy path and abandons you at the first deviation

Running a local is not hard because any one step is hard. It is hard because the
steps are conditional on a room that keeps changing, and the TO is the only
person holding the whole state — while also being the person who has to go find
out whether the guy in the red hoodie is still in the parking lot.

The happy path needs no help. What a TO needs is for the software to *notice*
the deviation and lay out the options with their consequences. So there is a
guidance engine (`lib/guidance.js`): sixteen rules over the event's state, each
producing a suggestion with a title, a **why** stated in real numbers, and
one-tap actions.

> **4 entrants have not checked in**
> 24 of 28 are here. Running as-is gives a 32 bracket with 4 byes and 4 sets that
> will end in a no-show. Re-seeding to the 24 who are here keeps it at 32 but
> turns those DQs into 8 byes — a bye costs nobody anything, a DQ costs a
> station call and a DQ-timer wait.
> `[Re-seed to the 24 who are here] [Run it with byes] [See who is missing]`

DQ timers run themselves off the ruleset. Idle stations get noticed. Duplicate
entrants get flagged before the bracket is made rather than after. Every rule is
a pure function, so none of them can do anything on their own — they propose,
the TO disposes.

### Mass import, update and edit

This is three failures, not one.

**Import.** start.gg's bulk-add takes a list of gamertags, caps it at 50 at a
time, and carries nothing but a name. A 120-person pre-registration spreadsheet
is three passes and then a lot of typing.

Here: paste anything. No row cap. Any columns in any order — the parser sniffs
the delimiter (tab first, because the commonest paste of all is a spreadsheet
column range), handles quoted fields with commas and newlines in them, strips
Excel's BOM, and guesses what each column is from about a hundred real-world
header aliases.

**Update.** The half nobody does. Re-importing the same sheet after fixing three
names should update three rows, not create 120 duplicates. So every import is an
upsert keyed strongest-first on email, then Discord, then a normalised tag
(which strips sponsor prefixes — `BTY | Kira` and `kira` are one person).

And nothing is written until you have seen the diff:

| Row | Tag | Action | What changes |
|---|---|---|---|
| 1 | Kira | unchanged | |
| 2 | Brand New Player | create | |
| 3 | Rae | update | seed: 3 → 2 |

An import tool without a preview is one people use once, get burned by, and
never trust again. One without an undo is worse. There is both.

**Edit.** Export produces exactly the shape import accepts, so the workflow is:
export, fix it in a spreadsheet where fixing things is easy, paste it back.
Plus an in-app grid with multi-select and bulk operations — check in, mark paid,
set team, re-seed a selection, remove — all undoable.

Every column sorts, because which one matters depends entirely on what the TO is
doing at that moment: seed while seeding, tag while looking somebody up at the
desk, team while checking a crew all arrived, paid while counting the cash box.
Filters cover the four or five questions actually asked — who is not here, who
owes money, who has not signed, who is on the waitlist — as one tap rather than
an expression builder, and they combine with AND, which is what "checked in" +
"owes" has to mean at the door.

One detail worth stating: **select-all selects what is on screen, not the whole
roster.** With filters applied those are different sets, and "select all"
quietly meaning "including the 180 rows you filtered out" is how a bulk action
goes badly wrong.

One deliberate subtlety: an import that omits the `paid` column must not un-pay
everybody. Absence means "no opinion", not "false". Conflating those is how a
bulk tool eats real data.

### Seeding

"Annoying to implement" is right, and the reason is that seeding is normally
smeared across a form, a drag handler and a server endpoint, so nobody can see
what it actually does. The output is a list of numbers and you find out whether
they were right when the bracket comes out.

`lib/bracket.js` is one file you can read top to bottom, and — more importantly
— everything it does is shown to the TO **before** they commit:

- **Who meets whom, per round, if nobody upsets.** "Seed 3 meets seed 6 in the
  quarters" is a sentence a TO can check against what they know about the room.
  This is the single most useful pre-commit check and nowhere surfaces it well.
- **Separation.** Teammates and people from the same venue get moved apart
  automatically — but only within two seed positions, so nobody moves far enough
  to change who they are expected to play, and every swap is reported in
  English: *"Swap Kira (seed 6) with Dominic (seed 7) — both Batty Mac."*
- **Honesty about what it cannot fix.** With 12 of 16 entrants from one venue,
  some of them are playing each other in round one and no algorithm changes
  that. It says so, with names, rather than silently pretending.
- **Auto-seed from results on this site**, explainable as "you have won 14 of 20
  sets here" — deliberately not a hidden rating, because a TO has to be able to
  justify a seed to the person who got it.

The engine has 112 assertions behind it (`node brackets/test/bracket.test.mjs`),
most of them about double elimination, because the losers bracket is what every
home-grown implementation gets subtly wrong.

---

## What this does differently

Beyond the five above:

**One person, one record, forever.** On every existing site a player is a row
in a tournament, and their history is assembled by searching for their name.
Change your tag and the trail breaks. Here the *player* is the durable record
and an entry points at it — so head-to-head works across venues, games and
years, and a store owner runs events and enters them on the same account with no
"organiser mode".

**Walk-up entrants are real people.** Roughly a third of a local registers at the
door. If identity requires a login, those people are ghosts. So a TO can create
a claimable player — a real row with real match history and a short code — and
when that person eventually makes an account they claim it and inherit
everything. Without this the "players exist outside events" idea quietly excludes
exactly the people a local is made of.

**Rules are versioned, forkable and copied onto the event.** An event does not
reference "the standard ruleset"; it takes a snapshot. A preset that changes next
month cannot silently rewrite the rules of an event that already ran. Forks
record what they came from, so "Batty Weekly rules = Community Standard v0.3,
except the DQ timer is 10 minutes" is a diff a player can read, instead of a
Discord pin nobody has re-read since March.

**Games are data.** `data/games.js` holds every field, default, preset and
validation. The setup wizard, the admin console and the bracket engine mention
no game by name. Adding a third is a file and one line.

---

## Holes in the original plan

Asked for, and worth being blunt about. Roughly in order of how much they matter.

### 1. Nobody switches bracket sites, because their history is trapped

This is the big one and it was not in the plan at all. The reason people stay on
start.gg is not that it is good; it is that ten years of their results are
there. A new site where every profile is empty on day one loses on that alone,
however much better the tooling is.

The fix is a **start.gg importer**: pull a player's public result history in and
attach it to their profile at sign-up. It is the single highest-leverage feature
on the list and it is **not built** — `start.gg` appears in the connected-accounts
list as a disabled field that says so, because a button that quietly does nothing
is worse than an honest gap.

The corollary is export, which *is* built: entrants as CSV, everything as JSON.
Recreating the lock-in that makes the incumbent hard to leave would deserve to
lose for exactly the same reason.

### 2. Discord-only login is one outage from a venue emergency

The plan correctly identified the email fallback. The sharper version of the
problem is: if Discord's OAuth is down — or the venue's captive portal mangles
the redirect, which is more common — a Discord-only TO cannot get into their own
bracket while forty people stand around.

So a password is not a lesser tier here. It is redundancy, the app prompts for
it in those words, and the prompt appears on the organiser's own dashboard.

The related detail the plan asked about — someone whose email is already used by
their Discord login — is handled by asking the server *what that address already
is* **before** asking for a password, so instead of "that email is already
registered" they get: *"codyadcock10@gmail.com signs in with Discord. Continue
with Discord, or set a password to add email sign-in to the same account."*

### 3. "Sign stuff" is a legal question, not a feature

The plan says players should sign things. Recording that is easy and is built:
versioned documents, typed name, timestamp, immutable (there is no update or
delete policy on `bkt_signatures`, so not even staff can rewrite one).

What that does **not** do is make the agreement valid. In particular a minor
cannot give consent, so a waiver from a 16-year-old needs a guardian — and
whether your venue needs one at all is a question for your venue, not a checkbox.
The app says this at setup and at signing. Do not treat it as solved.

### 4. Money

Not in the plan, and TOs will not switch without it. Entry fees, pot bonuses,
payouts, and "paid at the door" are the operational core of a local. What exists
here is the minimum: a fee, a paid flag, a door list, and an outstanding total.
There is no payment processing, no payout splitting, no pot tracking. Adding real
payments also drags in tax reporting and chargebacks, which is a much larger
project than it looks.

### 5. Self-reported results and disputes

Currently only staff can report. Every event above about 32 entrants needs
players to report their own sets, and the moment they can, you need a dispute
path. The right shape is a claims table where both players submit and agreement
promotes the result, with disagreement escalating to staff. The audit trail it
needs is already there — results are superseded rather than deleted, so "station
3 said 2-1 to Rae, the bracket says 2-0 to Kira, here are both with timestamps"
is settleable. The flow is not built.

### 6. Notifications are the actual killer feature

"You are up, station 4" as a Discord DM is worth more than most of the bracket
UI, because a venue PA does not scale and shouting someone's tag across a room
is how sets get DQ'd. This needs a bot and a server; neither exists. The
guidance engine has the buttons and they say so plainly when tapped rather than
pretending.

### 7. Privacy is not a settings screen you add later

The plan wants public, portable match history — correct, and it is what makes a
scene's record useful. But for some people a public trail of which venue they
are at every Tuesday is a genuine safety problem, and real names collected for
prize payouts are a different category of data again.

The schema takes this seriously (contact details are in a separate table, not a
hidden column, because RLS is row-level and a client-side select list is not a
boundary). What does *not* exist is per-player visibility control. That is a
real gap and it should not wait for the second version.

### 8. Scale and the shape of the backend

GitHub Pages plus Supabase is right for a weekly and will not hold a 300-person
major: no server-side jobs, no realtime fan-out to a projector, and bracket
generation happens on a client you must assume is hostile. The schema takes the
defensible half — a client cannot set its own seed, cannot write a result, and
cannot rewrite a signature — but a bracket blob written by a TO's phone is
trusted, and at some size that needs to move server-side.

### 9. Smaller ones, quickly

- **Discord link previews don't work.** GitHub Pages cannot render per-event meta
  tags and Discord's crawler does not run JavaScript, so an event link unfurls as
  the site. "Share your bracket in Discord" is a core workflow, so this is a real
  cost of the static hosting choice.
- **Pools.** Modelled in the seeding engine (snake seeding is implemented and
  tested) but there is no pools→top-cut flow in the UI. Anything over ~64
  entrants needs it.
- **Stream tooling.** Queue, commentator info sheets, overlay JSON. TOs live on
  this and none of it exists.
- **Multi-staff conflict.** Two staff editing from two phones is last-write-wins.
  Fine for a weekly, thin for a major.
- **A new game has no ruleset to be right about.** See below.

---

## The games

Twenty-one titles: every game from **Evo 2025 and Evo 2026** — both years, main
stage and extended — plus MARVEL Tōkon and Smash Ultimate.

Evo is the right list to seed from because it is the closest thing the scene
has to a canon: if a game is on that stage, somebody is running a local for it.
Each entry records where it appeared, and the wizard shows it, so a TO picking
a game can see they are not alone in running it. Tōkon and Smash are on neither
lineup — Tōkon launched after Evo 2026 — and are here because people run them
anyway, which is rather the point.

| | Evo 2026 main | Evo 2025 main | Evo 2025 extended |
|---|---|---|---|
| Street Fighter 6 | ● | ● | |
| Tekken 8 | ● | ● | |
| Guilty Gear -Strive- | ● | ● | |
| Granblue Fantasy Versus: Rising | ● | ● | |
| Fatal Fury: City of the Wolves | ● | ● | |
| Under Night In-Birth II Sys:Celes | ● | ● | |
| 2XKO | ● | | |
| Invincible VS | ● | | |
| Vampire Savior | ● | | |
| Rivals of Aether II | ● | | ● |
| BlazBlue: Central Fiction | ● | | ● |
| Virtua Fighter 5 R.E.V.O. | ● | | ● |
| Mortal Kombat 1 | | ● | |
| Marvel vs. Capcom 2 | | ● | |
| The King of Fighters XV | | | ● |
| Samurai Shodown | | | ● |
| Guilty Gear Xrd REV 2 | | | ● |
| Capcom vs. SNK 2 | | | ● |
| Killer Instinct | | | ● |

### Adding one is a few lines

The settings are assembled from builders in `data/rulesets.js`, because "set
format" is the same four fields in every fighting game ever made and writing
them out twenty-one times means twenty-one places to fix when one turns out to
be wrong. A game supplies only what is genuinely its own:

```js
{
  id: 'sf6', name: 'Street Fighter 6', short: 'Street Fighter 6', mark: 'SF6',
  releaseYear: 2023, platforms: plats('ps5', 'pc', 'xbox'),
  evo: { 2025: 'main', 2026: 'main' },
  rules: {
    match: { rounds: 2, timer: '99' },
    controls: { simplified: { label: 'Modern controls', help: '…' } },
  },
  preset: ['FT2 pools, FT3 top cut, 2 rounds, 99 seconds, Modern controls legal.', '…'],
}
```

An entry should be as long as the game is unusual, and no longer. Most are
about a dozen lines. Tōkon is the longest because a 4v4 tag game with a shared
health bar genuinely has more to say.

Three ruleset shapes cover everything so far — round-based 1v1, team (assist or
sequential), and platform fighter — and the games that need one odd field get
it spliced into an existing group rather than a group of one. Mortal Kombat's
Kameo and CvS2's Groove are the two that do.

### What is settled and what is a guess

Mechanical facts — platforms, team sizes, whether a game ships a simplified
control scheme — are checkable and were checked. Competitive **conventions**
are different. Where a ruleset is settled, the preset says so. Where it is not
— 2XKO, Invincible VS, Tōkon — it is marked `provisional` and the flag reaches
the TO at setup and the player on the rules sheet.

### Identity: one done, nineteen placeholders

Tōkon and Smash have drawn artwork. The other nineteen have a real generated
palette, a mark, a tagline and a generic motif, and are marked
`identity: 'placeholder'` in `data/themes.js` — in the data rather than in a
note, so the list of what is left cannot drift out of date.

Colours are each game's own brand, and they **cluster**. Street Fighter 6 and
Fatal Fury are both orange; four more are the same gold. Two attempts to spread
them are recorded in `test/theme.test.mjs` because the instinct to try again
will come back: rotating hues to hit a comfortable separation turned Street
Fighter pink and Mortal Kombat mauve, and capping the rotation at "still
recognisably that colour" could not reach the target at all. Twenty-one
mutually distinguishable hues do not exist — a categorical palette starts
confusing neighbours around eight to twelve.

So the **mark** carries the identity and the colour reinforces it. "SF6" in
orange and "FF" in orange are not hard to tell apart, because they say SF6 and
FF. That is why the mark is two or three letters rather than the coloured dot a
first draft reaches for. The test checks contrast strictly (lowest 7.98:1) and
distinctness only strictly enough to catch a duplicated seed.

Theming touches **primary only**. Mapping secondary onto the game ramp as well
was the first attempt and it was too much: secondary-container carries the nav
pill, the bulk-action bar and the demo banner, so it made a whole page one loud
colour and painted app chrome as though it belonged to the game.

---

## Marvel Tokon

MARVEL Tōkon: Fighting Souls is a 4v4 tag fighter from Arc System Works with a
**shared team health bar**, "Assemble" assists, third and fourth team members
that unlock during a match, and crossplay between PS5 and PC. Those mechanics
are documented.

What is **not** documented is the competitive convention layered on top, because
the scene has not settled it. So every Tokon preset here is marked
`provisional: true`, its `source` says in as many words that nobody ratified it,
and that flag is surfaced to the TO at setup *and* to the player on the rules
sheet. Presenting a guess as a standard is how a bracket site accidentally writes
a scene's rules. If we are going to do that, it should be on purpose, in the
open, with a version number on it.

The settings a Tokon TO actually needs, grouped as the wizard renders them:

**Teams and assists** — this is why Tokon needs its own schema rather than
inheriting a generic fighting-game one. In a 1v1 game "can the loser change
character" is one setting. In a 4v4 tag game with a shared health bar there are
three separable questions — the four members, the **order** they are in (which
decides who starts point and which two are held back), and the **assist** each
one is set to — and a scene can land on different answers for each. Collapsing
them into one toggle is exactly the modelling shortcut that makes an existing
site feel like it was not built for your game.

- Team size, duplicate characters
- Changing team between games: loser only (the Marvel convention) / both / locked
- Changing team **order**: follows the team rule / always / never
- Changing **assists**: follows the team rule / always / never
- Banned characters (almost always empty, present because a three-month-old game
  occasionally ships something that has to go)

**Set format** — FT2 pools, FT3 top cut, FT3 finals, grand finals bracket reset.

**Match settings** — rounds per game (which in Tokon also gates when your third
and fourth members become available, so it changes the game and not just its
length), timer, stage select, and the **game version**, because when a patch
lands mid-season the version an event ran on is the first thing anyone asks in a
dispute.

**Controllers** — leverless legality and SOCD cleaning, and whether the
**simplified control scheme** is legal. Modern fighting games ship one and
whether it is tournament-legal is a live argument in every scene that has one;
answering it in the ruleset means nobody has to have that argument at a station.

**Conduct** — DQ timer (the run view counts down the number set here), pausing,
coaching, code of conduct.

**Online** — only rendered for online events. Crossplay is on by default and the
setting is buried (Battle → Casual/Ranked → "Match Platform" → All), so the help
text says exactly where it is. Region, how players connect, and the
disconnect rule — which is unusually enforceable in Tokon, because a shared team
health bar means "who was ahead" is a single number both players can see.

Three presets ship: **Community Standard v0.3**, **Fast Local** (for a weekly
that has to be out by 11), and **Major**.

Smash Ultimate is deliberately thin, but thin in the right place: the stage list
*is* the ruleset in a platform fighter, so it gets a real stage model — starters,
counterpicks, strike order, DSR — and skips nearly everything else. It also
proves the registry claim, since it has a completely different shape (stocks, no
teams) and required no change to the wizard, the console or the engine.

---

## The player side

What a player needs, in the order they need it, on a phone, in a loud room:

1. **Am I in?** Seed, check-in, what still needs signing, and — for an online
   event — whether their platform ID is on file, checked *before* the set is
   called rather than when it stalls.
2. **Who am I playing and where do I go?** Opponent, round, station, and the DQ
   clock if it is running. Plus **head-to-head**: *"Head to head: 1–2. Last time
   you lost 3–1, two months ago."* Every player wants this before a set and no
   bracket site tells them.
3. **The rules**, exactly, so the argument at the station is short — including
   which ones this TO changed from the preset.
4. **The bracket**, last. A 128-entrant bracket on a 390px screen is a maze; the
   player's real question is "what do I do now".

Their profile is the passport: tag, pronouns, mains per game, home venue, every
set they have played anywhere, and a rivals list.

**There is deliberately no rating and no leaderboard.** A number next to
someone's name changes how a scene behaves — people dodge sets to protect it —
and a rating designed in an afternoon by someone who will not be at the venue
when it goes wrong is a bad trade.

### Other platforms worth linking

Ranked by how much they actually do for the user, not by how many logos it puts
on the page:

| | Why |
|---|---|
| **Discord** | Sign-in, and where "you are up next" goes when the bot exists |
| **PSN / Steam / Nintendo** | How an online set actually starts. Tokon is crossplay PS5/PC, so an entrant needs whichever they are on — entered once, not once per event |
| **start.gg** | The import path, and the reason a profile is not empty on day one. See hole #1 |
| **Twitch / YouTube** | Sets on a linked stream become VODs on a profile |
| **Bluesky / X** | How a scene talks; low value to the software, high value to a player deciding whether the profile is worth filling in |

Not worth it: anything that needs an OAuth app and a review process to return a
handle you could have typed.

---

## Signing in, and who can see an event

Two rules, and the second exists because of the first.

**You can walk the whole setup wizard as a guest. You cannot finish it as
one.** That is the opposite of the usual arrangement, where an account is
demanded on the first screen before you know whether the thing is any good.
Nobody should have to sign up to find out what the Tokon ruleset form looks
like. But a published event is a public artefact with other people's names on
it, and the moment it exists somebody has to be accountable for it — there is
no way to ban a bad actor who is not anybody.

The gate is only defensible if it is free, so the draft is written to
`localStorage` on every change and survives the whole round trip — including
Discord's OAuth redirect, which leaves the page entirely and comes back on a
fresh load. Coming back that way returns you to the wizard, filled in, on the
publish step. It deliberately does *not* create the event for you: making a
public artefact as a side effect of a page load is how you end up with two of
them when somebody refreshes.

**Events are listed or unlisted.** Unlisted means reachable with the code or
the link and absent from every listing — an invitational, a private house
session, or a weekly you are still filling before you announce it. It is
settable in the wizard and changeable afterwards from settings, mid-event
included.

The UI says, in those words, that **unlisted is not secret**. Anyone with the
link can open it and pass it on. Being precise about that is the difference
between a discoverability setting and a promise you cannot keep.

Against a backend it is enforced rather than merely filtered, which most
bracket sites do not bother with: the read policy on `bkt_events` returns an
unlisted row only to its staff or to somebody already entered, so the event
list cannot be scraped for private sessions. Redeeming a code goes through
`bkt_event_by_code`, a `SECURITY DEFINER` function that returns exactly one
row for an exact code — the code is the capability. It requires a signed-in
caller, and it has no rate limit yet, which is a real gap and is written down
as one.

### What Discord sign-in does with no server

Nothing, now, and it says so. It used to quietly create a device-local profile
named "Local TO" and return as though OAuth had succeeded, which got reported
as "Discord sign in doesn't work" — accurate, even though nothing errored. A
button that does something other than what it says is worse than one that
admits it cannot help yet. With no project configured the dialog explains that
no server is connected, disables the Discord option, and offers an explicit
"continue on this device" instead.

---

## The venue display

`#/e/<id>/tv` — what goes on the television in the corner of the room, opened
from a button in the run view.

The most expensive failure at a local is somebody missing their set, and it is
almost always because they did not hear their name. A TO shouting over two
hundred people and eight consoles does not scale; it is the reason DQ timers
exist. A screen that answers "am I up?" from across the room fixes most of it,
and the venue already owns the television.

Two screens, and a button to pick one or cycle both:

- **Who is up** — the stations with names at a size you can read from four
  metres, the next set out highlighted, and DQ timers running on screen.
- **Bracket** — the rounds that are actually live, not the whole tree, plus a
  strip of recent results. The first version rendered every round and that was
  the wrong call: a 32-entrant double elimination is fifteen columns and sixteen
  first-round matches, which works out at about eleven pixels a name. It showed
  the bracket and communicated nothing. Nobody across a room is reading winners
  round one.

  Trimming it took three goes to get right, and the failures are worth keeping:

  - *Filter to rounds of four matches or fewer.* Readable, and empty. Mid-event
    the deepest round with anybody in it is often the wide one — winners round
    two with eight matches — so the filter kept only rounds nobody had reached
    yet and the screen showed eight blank columns. That is the bug: an empty
    column is worth nothing at any size, so the narrow window is now only a
    *preference*. If nothing in it is populated, the display falls back to the
    window around the deepest live round whatever its width.
  - *Scale the type to fit the widest column.* One eight-match round dragged
    every other column down to eleven pixels with it — the exact problem the
    trimming existed to solve. Each column is scaled on its own count now, so
    the two-match semi-final stays at full size next to a shrunken round of
    eight.
  - Grand finals stay hidden until somebody is in them, and exactly one empty
    round is kept past the last live one — enough to show what a win leads to,
    without a row of blanks.
- **Cycle** — fifteen seconds each with a progress bar. Five felt responsive at
  a desk and is far too fast in a room, where somebody has to find the screen,
  work out which half matters, and then read down a list for their own tag.

A display is not the app with bigger text. It has no controls (a television has
no mouse — the settings hide themselves and are for whoever is plugging the
laptop in), it is sized in `vmin` so one stylesheet serves a monitor and a
projector, and it carries far fewer things per screen because at that distance
you can hold about five.

---

## Accessibility

Audited with axe-core across every route, in light and dark, at desktop and
phone widths: **zero violations** at WCAG 2.1 AA plus axe's best-practice
rules. The rest of the site was brought to **2.2 AA** separately, so this was
checked against 2.2's additions too — target size, focus not obscured, and
dragging movements — which are the three that actually bite an app like this.

All of it is a committed test rather than a claim: `test/browser/a11y.test.mjs`
and `test/browser/wcag22.test.mjs` run those sweeps on every commit, so this
paragraph is checkable by anyone, which it was not when the scripts lived on my
machine.

That is the floor, not the ceiling — axe catches perhaps 40% of real problems,
so the rest was checked by driving the app, and those checks are committed too
(`test/browser/keyboard.test.mjs`):

- **Keyboard.** Skip link first in the tab order and visible when focused;
  every action reachable; dialogs keep focus off the page behind them and close
  on Escape; the bracket pane is focusable so it can be scrolled with the arrow
  keys, which a mouse-only scroll container cannot be.
- **Screen readers.** Navigation is announced — the router moves focus to
  `<main>` and writes the page name into a live region that lives outside the
  re-rendered subtree, because a live region removed and re-added in the same
  tick is not reliably announced. Every match in a bracket states itself as a
  sentence ("Kira beat Mook 2 to 0") with the visual rows hidden, because a
  bracket's meaning is its layout and describing the picture would be useless.
- **Zoom and reflow.** No horizontal scrolling at 200%; every organiser tool
  works at 390px.
- **Motion.** `prefers-reduced-motion` suppresses every transition.
- **Colour.** `test/theme.test.mjs` measures every pairing the app paints, in
  both schemes. Lowest is 9.3:1 against a 4.5:1 requirement.
- **Target size (2.2).** Every control is at least 24×24. The roster table is
  dense on purpose, but its inline editors were 13px tall — compact enough to
  be genuinely hard to hit with a mouse, never mind a thumb.
- **Dragging (2.2).** Nothing is drag-only. The seeding lab reorders with
  explicit move buttons.

Six bugs worth naming, because they are the kind an automated pass alone would
not have caught and they are easy to reintroduce:

1. **Focusing `<main>` on first load made the skip link unreachable.** Moving
   focus after navigation is correct; doing it on the *initial* render puts the
   skip link behind the focus position, so the first Tab lands inside the
   content and the one feature that exists purely for keyboard users can never
   be reached.
2. **`opacity` on completed and bye matches dimmed their text below contrast.**
   Contrast is computed on what is painted, so anything fading a whole subtree
   fades it under the threshold too. De-emphasis has to be a colour choice.
3. **The tabs were not tabs.** They had `role="tablist"` but changed the URL and
   had no tabpanels. The ARIA tab pattern promises a panel, roving arrow-key
   focus and no navigation; promising that and not delivering it is worse than
   plain links, which people already know how to use. They are `<nav>` and
   anchors now.
4. **`aria-current="page"` was on "Events" for every route that was not the
   profile** — telling a screen reader the user is somewhere they are not.
5. **The seeding lab advertised drag-to-reorder against an empty handler.** It
   said "drag to reorder", set `draggable="true"`, and did nothing — so the
   feature was both inaccessible and absent. It has real move buttons now,
   which are keyboard-reachable and work one-handed on a phone, where seeding
   actually gets adjusted.
6. **The lab previewed one order while editing another.** The list showed the
   post-separation proposal, but the move buttons edited the stored order, so
   nudging somebody up re-ran separation over the new order and the row
   appeared not to move. Everything displayed is the stored order now, and
   separation is strictly a proposal you apply. A view that previews one thing
   while editing another is unusable however good either half is.

---

## Official game artwork

Selecting a game re-themes the app: the palette shifts, the app bar takes the
game's accent, the hero banner changes, and every button, chip and focus ring
inside follows, because the override is on Material 3's own colour *roles*
rather than on bespoke classes.

**There is no Marvel artwork in this repository, and that is deliberate.**

There is no official Marvel Tōkon fan kit or press kit. Marvel Games and
PlayStation Studios publish screenshots and trailers through their own channels,
but neither ships a downloadable asset pack with usage terms attached, and the
community sites that index the game are explicit that they host no official
artwork either. Marvel character art is Disney IP; a third-party tournament site
redistributing it is a licensing question, not a fair-use one you can reason
your way into — and not a call this repository should make on the site owner's
behalf.

So the theming is built from things nobody owns:

- **A generated tonal palette per game.** Seed colour → OKLCH → even lightness
  steps → chroma tapered at the extremes to stay in sRGB. Even steps are the
  point: darkening a hex by percentages gives ramps whose perceived contrast
  jumps around, so a tone that passes for one hue fails for another.
- **Original artwork** evoking the *shape* of each game — four slanted slots
  for Tōkon's tag lineup, with the point fighter lit and the three behind it
  stepping back; floating platforms for Smash.
- **Comic-printing texture** for Tōkon: Ben-Day halftone dots and speed lines.
  A printing technique from the 1890s, out of copyright, and the strongest
  "comic book" cue available that involves nobody's character.

### Dropping real art in

Every theme in `data/themes.js` has an `assets` block:

```js
assets: {
  hero: null,        // 'hero.jpg'  — 1600x600 or wider
  logo: null,        // 'logo.svg'  — transparent, light-on-dark
  icon: null,        // 'icon.png'  — square, 128px+
  characters: null,
  credit: null,      // required whenever any of the above is set
}
```

Fill in a filename, put the file in `brackets/assets/games/<game-id>/`, and it
takes over — the drawn motif becomes the fallback. The hero already sits behind
a scrim sized for a busy photograph, so nothing else changes.

Before doing that, get the terms right. In rough order of how likely they are to
be usable:

1. **Ask Marvel Games / PlayStation Partners directly.** An event organiser
   asking for promotional assets for a community tournament is an ordinary
   request and is sometimes granted in writing. Written permission is the only
   version of this that is actually safe.
2. **Check whether a press kit has appeared since.** Publishers often add one
   after launch. If it exists, read its terms — most permit editorial and
   community use with attribution, some do not permit use on a site that takes
   money, which a site charging entry fees may count as.
3. **Commission or draw your own.** No permission needed, and it is what the
   current artwork is.

Set `credit` whenever you use somebody's asset; it renders in the corner of the
hero. And note the licensing question is about *artwork*, not about naming the
game — using a game's name to say which game a tournament is for is nominative
use and is not what any of this is about.

---

## Architecture

```
brackets/
  index.html          app shell; renders a real first paint, not a spinner
  brackets.css        Material 3 — tokens, type scale, state layers, components
  config.js           Supabase url + key. Blank = on-device only
  app.js              boot, hash router, chrome

  data/
    games.js          the game registry — 21 titles, mostly a dozen lines each
    rulesets.js       composable setting groups the registry assembles from
    themes.js         per-game palettes, original artwork, official-asset slot
    demo.js           a working event, seeded only when there is no backend

  lib/
    bracket.js        seeding, separation, single/double elim, progression
    store.js          local-first state, write queue, undo, sync
    auth.js           Discord + email fallback, claimable players, connections
    guidance.js       the "what do I do next" rules engine
    csv.js            import parsing, column mapping, dry run, export
    tour.js           the guest walkthrough and its reset
    ui.js             html templating, delegation, icons, dialogs

  views/              home, setup wizard, admin console, event page, profile,
                      tv (the venue display)
  assets/games/<id>/  where licensed artwork goes, if you have any
  sql/001_schema.sql  the security model
  test/bracket.test.mjs
  test/theme.test.mjs
```

Three decisions worth defending:

**Material 3 by hand, not `@material/web`.** The library ships its own
custom-element runtime before a bracket is drawn, and makes every control a
shadow-DOM boundary you cannot style around at 2am. M3's tokens, type scale,
state layers, elevation and shape are implemented here in 44kB of plain CSS
(11kB gzipped) with zero JavaScript. Shipping a component framework to solve a
design-language problem would have broken the pitch on the first page load.

**No virtual DOM.** The heaviest screen is a 256-entrant double bracket — about
500 nodes. Build it as a string, assign once: one parse, one layout, under a
frame on a cheap Android. `html` is a tagged template that escapes every
interpolation and returns a marked value so templates compose without
double-escaping, and `render` preserves scroll position and focus so reporting a
set does not throw the TO back to the top of the bracket.

**The bracket is CSS grid with border connectors**, not SVG. An SVG-connector
approach needs a measure pass per node and re-measures on every resize; this
needs neither.

### The security model

It lives in `sql/001_schema.sql` and the app is assumed hostile — the publishable
key is in the page source. A bracket is public *by design*, so the interesting
question is who can **write**:

- A player may edit their own profile, and their own entry — but a `BEFORE
  UPDATE` trigger pins seed, team, payment and waitlist state to their old
  values, because a policy can gate a row but not a column, and a client that
  could set its own seed would make the entire seeding feature theatre.
- Contact details are a separate table, not a hidden column.
- Signatures have insert-only policies. Nobody, staff included, can rewrite one.
- Staff permissions are scoped per org, and "can read an entrant's email" is
  scoped to orgs that person actually entered an event for — otherwise anyone
  who made a throwaway org could read every email in the database. (`/fcevents`
  hit the same escalation shape with event creators.)

---

## What is built and what is not

**Built and working, end to end:** the game registry and rulesets; the setup
wizard; the entrant grid with bulk operations and undo; CSV/paste import with
column mapping, dry-run diff and upsert; export; the seeding lab with separation
and projection; single and double elimination with byes, progression, DQ and
un-reporting; the station queue and DQ timers; the guidance engine; the player
passport with head-to-head; claimable walk-up players; document signing;
local-first storage with an offline write queue; light and dark themes;
per-game theming; and the guest demo tour with reset.

**Written but never run against a live server:** everything in `sql/`, and the
Supabase paths in `store.js` and `auth.js`. There is no project configured, so
the schema is unapplied and the sync code is untested against a real PostgREST.
Expect to fix things on first connection.

**Not built:** start.gg import; Discord notifications; player self-reporting and
disputes; pools → top cut in the UI; payments; per-player privacy controls;
stream tooling; per-event link previews.

Everything outstanding, with reasoning and rough order, is in
[ROADMAP.md](ROADMAP.md).

---

## Running it

Open `brackets/index.html` through any static server:

```
python3 -m http.server 8000
# then http://localhost:8000/brackets/
```

It seeds a demo event — 28 entrants, four no-shows, a duplicate, a walk-up with
a claim code, and a season of past results, chosen to exercise the awkward cases
rather than to look good in a screenshot.

It seeds the demo the first time only, and never over real data.

Tests:

```
node brackets/test/run.mjs        # everything: 848 node assertions + 135 browser
node brackets/test/run.mjs tv     # just one suite
```

The Node half needs nothing installed. The browser half needs Playwright and
axe-core (`cd brackets/test && npm install && npx playwright install chromium`)
and is skipped with a note if they are missing, so the fast half always runs.

Ten suites. Two cover the pure functions — the bracket engine and the colour
palettes. The other eight drive a real browser, because every bug this project
has actually shipped lived outside the reach of a unit test: a tour card that
rebuilt itself once a second, `opacity` dimming text below contrast, a bracket
pane you could not scroll without a mouse, a TV screen drawing eight perfectly
sized empty columns. See `test/README.md` for the full list and for the rule
they follow — assert rather than print, and prove each assertion can fail by
putting the original bug back.

To connect a backend: run `sql/001_schema.sql` against the `battydevsite`
project, enable the Discord provider with redirect `https://battydev.com/brackets/`
and scopes `identify email`, then fill in `config.js`. Demo seeding stops as soon
as a project is named — an account with a real backend must look empty when it is
empty.
