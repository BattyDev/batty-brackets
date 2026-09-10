/* Brackets · the guided demo
   ===========================================================================
   A Marvel Tōkon weekly that anyone can walk through without signing in, and
   reset when they are done.

   ## Why it works this way

   The obvious way to demo software is a video or a click-through of dead
   screens. Both lie a little: they show the happy path at the moment it looks
   best, and they cannot show you what happens when you do the thing the
   demo did not anticipate.

   This instead drives the REAL application against real local data. Every step
   below performs the same store writes a TO would perform — checking people
   in, seeding, generating the bracket, reporting sets — and then hands control
   back. Nothing is mocked and nothing is a screenshot, so a visitor can stop
   the tour at any point, click something else entirely, and everything still
   behaves, because it is the actual app.

   That is possible only because of the local-first design: with no backend
   involved, "a demo tournament" is just a store the visitor happens to own. It
   costs no account, no server row, and nobody else can see it.

   ## Reset

   The tour is only trustworthy if it is repeatable, and it is only safe to
   offer if it cannot eat somebody's real event. So:

     * `snapshot()` captures the demo's pristine state the first time it runs
     * `reset()` restores exactly that, and nothing else — an event the visitor
       created themselves is untouched
     * a reset is offered at the end of the tour, from the demo banner, and
       from the last step

   ## Guest, not signed in

   The tour never signs anyone in. The organiser views are reachable because a
   locally-owned event has no owner to check against (see `canAdmin` in the
   event list) — which is the same reason a TO can run a weekly on one phone
   with no account. The player-side steps use a "you are this entrant" framing
   rather than a fake session, because pretending to be signed in would be the
   one dishonest thing in an otherwise real demo.
   =========================================================================== */

'use strict';

import * as store from './store.js';
import * as auth from './auth.js';
import { html, raw, list, icon, snack } from './ui.js';
import { singleElimination, doubleElimination, reportResult, readyMatches } from './bracket.js';

export const DEMO_EVENT = 'evt_demo_tokon';

/* --------------------------------------------------------------------------
   State
   --------------------------------------------------------------------------
   Kept in localStorage rather than in the store, because where somebody has
   got to in a tour is a property of this browser, not of the tournament -- and
   because it must survive `reset()`, which wipes the tournament back.
   -------------------------------------------------------------------------- */

const LS_TOUR = 'battydev.brackets.tour.id';
const LS_STEP = 'battydev.brackets.tour.step';
const LS_SNAPSHOT = 'battydev.brackets.tour.snapshot';
const LS_DISMISSED = 'battydev.brackets.tour.dismissed';

const read = (key, fallback = null) => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

export const tourStep = () => read(LS_STEP, null);
export const currentTourId = () => read(LS_TOUR, 'organiser');
export const currentTour = () => TOURS.find((t) => t.id === currentTourId()) || TOURS[0];
export const isRunning = () => tourStep() !== null;
export const isDismissed = () => read(LS_DISMISSED, false) === true;

/* Is this device looking at the seeded demo, or at real events somebody made?
   The banner and the tour offer only apply to the former. */
export function isDemoData() {
  const event = store.getEvent(DEMO_EVENT);
  return Boolean(event?.demo);
}

/* --------------------------------------------------------------------------
   Snapshot and reset
   -------------------------------------------------------------------------- */

/* Capture only the collections the demo owns, keyed by the `demo: true` flag
   that data/demo.js stamps on every row it creates. Anything the visitor made
   themselves has no flag and is therefore never captured -- and so never
   restored over. */
function collectDemoRows() {
  const state = store.get();
  const out = {};
  for (const collection of ['players', 'orgs', 'events', 'entries', 'brackets', 'results', 'stations']) {
    out[collection] = {};
    for (const [id, row] of Object.entries(state[collection] || {})) {
      if (row?.demo) out[collection][id] = row;
    }
  }
  return out;
}

export function snapshot({ force = false } = {}) {
  if (!force && read(LS_SNAPSHOT)) return;
  if (!isDemoData()) return;
  write(LS_SNAPSHOT, collectDemoRows());
}

export function reset() {
  const snap = read(LS_SNAPSHOT);
  if (!snap) return false;

  const state = store.get();
  const writes = [];

  /* Remove every demo row currently present, plus the bracket, which is
     generated during the tour and has no `demo` flag of its own. */
  for (const collection of Object.keys(snap)) {
    for (const [id, row] of Object.entries(state[collection] || {})) {
      if (row?.demo || (collection === 'brackets' && id === DEMO_EVENT)) {
        writes.push({ collection, id, patch: null });
      }
    }
  }
  /* Put the pristine rows back. */
  for (const [collection, rows] of Object.entries(snap)) {
    for (const [id, row] of Object.entries(rows)) {
      writes.push({ collection, id, patch: row });
    }
  }

  store.applyMany(writes);
  write(LS_STEP, null);
  releasePlayer();
  return true;
}

/* --------------------------------------------------------------------------
   The steps
   --------------------------------------------------------------------------
   Each step is:

     route   where to send the visitor
     title   what this screen is
     body    what to look at, and why it matters
     act     optional — the store writes that get the data into the state this
             step is meant to show. Runs BEFORE the route change.

   `act` is what makes the tour a walkthrough rather than a slideshow: by the
   time the run view appears, sets really have been reported, so the bracket on
   screen is a bracket with results in it.
   -------------------------------------------------------------------------- */

const entriesOf = () => store.entriesFor(DEMO_EVENT);
const nameOf = (playerId) => store.getPlayer(playerId)?.tag || 'a player';

const ORGANISER_STEPS = [
  {
    id: 'welcome',
    route: `/e/${DEMO_EVENT}`,
    title: 'A Tuesday night at a local',
    body: 'This is a real, working tournament — 28 people signed up for a Marvel Tōkon weekly, four of whom will not show. Every screen from here is the actual app writing to actual data on your device. Nothing is a mock-up, and none of it leaves this browser.',
  },
  {
    id: 'player-view',
    route: `/e/${DEMO_EVENT}/rules`,
    title: 'What a player sees',
    body: 'The rules a player argues about at 11pm, in one place — and marked provisional, because Tōkon is new enough that nobody has ratified a competitive ruleset. Note the team, order and assist rules are three separate settings: in a 4v4 tag game they are three separate arguments.',
  },
  {
    id: 'entrants',
    route: `/e/${DEMO_EVENT}/admin/entrants`,
    title: 'The roster',
    body: 'Select rows and the bulk bar appears — check in, mark paid, set a team, re-seed, all undoable. Import takes a pasted spreadsheet of any size and shows you a per-row diff before it writes anything. This is the part organisers say is missing everywhere else.',
  },
  {
    id: 'checkin',
    route: `/e/${DEMO_EVENT}/admin`,
    title: 'Four people did not show',
    body: 'Check-in has closed. Look at Next steps: it has worked out what running as-is costs versus re-seeding, in real numbers, and offers both. It is not deciding for you — it is doing the arithmetic you would otherwise do in your head while forty people wait.',
    act() {
      /* Close the check-in window so the guidance engine has something real to
         say, rather than manufacturing a fake suggestion. */
      store.apply('events', DEMO_EVENT, {
        status: 'checkin',
        checkInClosesAt: new Date(Date.now() - 60_000).toISOString(),
      });
    },
  },
  {
    id: 'seeding',
    route: `/e/${DEMO_EVENT}/admin/seeding`,
    title: 'Seeding you can check before you commit',
    body: 'The right-hand column is who meets whom in every round if nobody upsets — the check an organiser actually wants. On the left, separation has moved people from the same venue apart, within two seed places so nobody\'s expected opponent changes, and it says which swaps it made and why.',
    act() {
      store.apply('events', DEMO_EVENT, { status: 'seeding' });
    },
  },
  {
    id: 'bracket',
    route: `/e/${DEMO_EVENT}/admin/run`,
    title: 'The bracket, and the first sets',
    body: 'Generated from the 24 people who are here. Some sets have been played already. Stations are being called, DQ timers are running, and reporting a set is two taps — with no network involved, so it is instant even on venue wifi.',
    act() {
      generateAndPlay(6);
    },
  },
  {
    id: 'report',
    route: `/e/${DEMO_EVENT}/admin/run`,
    title: 'Try reporting one',
    body: 'Tap any set with a bright outline — those are ready to play. Pick a score and save. The winner moves on, the loser drops into losers, and the station frees itself. Get it wrong and you can un-report it; the old result is kept in the log rather than deleted, which is what makes a disagreement settleable.',
  },
  {
    id: 'profile',
    route: '/p/plr_demo01',
    title: 'Players outlive events',
    body: 'Kira\'s record is not owned by this tournament. Head-to-head against everyone she has played, at any event, in any game — which is the query the whole design exists to make possible, and the thing that breaks everywhere else the moment somebody changes their tag.',
  },
  {
    id: 'done',
    route: `/e/${DEMO_EVENT}/admin`,
    title: 'That is the tour',
    body: 'Keep clicking — everything works, including the parts the tour skipped. When you are finished, reset puts the demo back exactly as it started. Nothing you did here left your browser.',
    last: true,
  },
];

/* ==========================================================================
   TOUR 2 — the venue display
   --------------------------------------------------------------------------
   Short on purpose. There are two screens and a switch; the point is made in
   four steps and a fifth would be padding.
   ========================================================================== */

const TV_STEPS = [
  {
    id: 'tv-why',
    route: `/e/${DEMO_EVENT}/admin/run`,
    title: 'The screen in the corner of the room',
    body: 'The most expensive failure at a local is somebody missing their set, and it is almost always because they did not hear their name. A TO shouting over two hundred people and eight consoles does not scale. The venue already owns a television — this is what goes on it.',
    act() { generateAndPlay(8); },
  },
  {
    id: 'tv-queue',
    route: `/e/${DEMO_EVENT}/tv`,
    title: 'Who is on, and who is next',
    body: 'Names at a size you can read from four metres, not four hundred millimetres. The next set out is highlighted, because that is the one people are scanning for. DQ timers run on screen, so nobody has to be told twice.',
    act() { setTvScreen('queue'); },
  },
  {
    id: 'tv-bracket',
    route: `/e/${DEMO_EVENT}/tv`,
    title: 'And where the event has got to',
    body: 'The business end, not the whole tree — a 32-entrant double elimination is fifteen columns and nobody across a room is reading winners round one. Recent results run along the bottom, which is what fills the screen usefully before anyone reaches the top cut.',
    act() { setTvScreen('bracket'); },
  },
  {
    id: 'tv-cycle',
    route: `/e/${DEMO_EVENT}/tv`,
    title: 'Or both, on rotation',
    body: 'Fifteen seconds each, with a progress bar so a viewer knows how long they have before it moves on. Move the mouse to bring the controls back — they hide themselves, because a television has no mouse and the settings are for whoever is plugging the laptop in.',
    act() { setTvScreen('cycle'); },
    last: true,
  },
];

function setTvScreen(screen) {
  try {
    const key = 'battydev.brackets.tv';
    const now = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({ ...now, screen, showing: screen === 'cycle' ? 'queue' : screen }));
  } catch { /* private mode */ }
}

/* ==========================================================================
   TOUR 3 — the player's half
   --------------------------------------------------------------------------
   The organiser tour shows the machinery. This one shows what the machinery
   is FOR, from the seat of somebody who paid five dollars and wants to know
   when they are up.

   It borrows an identity rather than faking one. `becomePlayer` points the
   local session at a demo entrant, so the "You" tab and the profile are
   running the same queries they would for a real account -- there is no
   separate mocked player view to drift out of sync with the real one. Ending
   the tour or resetting hands the identity back.
   ========================================================================== */

const HERO = 'plr_demo01'; // Kira

const PLAYER_STEPS = [
  {
    id: 'p-you',
    route: `/e/${DEMO_EVENT}`,
    title: 'You are Kira tonight',
    body: 'This is the same page every entrant sees, running the same queries — nothing here is a mock-up of the player view. Your seed, whether you are checked in, and what you still have to sign, in the order you need them.',
    act() {
      becomePlayer(HERO);
      store.apply('events', DEMO_EVENT, { status: 'checkin' });
      const entry = store.entryFor(DEMO_EVENT, HERO);
      /* Roll Kira back to un-checked-in and unsigned so the next step has
         something real to do rather than describing a button. */
      if (entry) store.apply('entries', entry.id, { checkedInAt: null, signedDocuments: [] });
    },
  },
  {
    id: 'p-checkin',
    route: `/e/${DEMO_EVENT}`,
    title: 'Check in, and sign the thing',
    body: 'Try it: sign the code of conduct, then check in. Signing records your typed name, the time and the document version — so "they agreed to it" is a fact with a date rather than somebody\'s memory. A required document blocks check-in until it is done.',
  },
  {
    id: 'p-next',
    route: `/e/${DEMO_EVENT}`,
    title: 'Who you are playing',
    body: 'Your next set, your opponent, and the head-to-head: how many times you have played them anywhere on this site, and what happened last time. Every player wants that before a set and no bracket site tells them.',
    act() {
      const entry = store.entryFor(DEMO_EVENT, HERO);
      if (entry) store.apply('entries', entry.id, { checkedInAt: new Date().toISOString(), signedDocuments: ['doc_coc'] });
      generateAndPlay(4);
    },
  },
  {
    id: 'p-called',
    route: `/e/${DEMO_EVENT}`,
    /* Deliberately not naming a station: the app puts the set on whichever
         one is free, and a tour that says "station 2" while the screen says
         "Station 3" undermines everything else it claims. */
    title: 'You are up — go to your station',
    body: 'When the organiser calls your set it appears here with the station on it, and the DQ clock starts. The same information is on the venue display at the same moment. This is the part that stops people being disqualified for standing twenty feet away.',
    act() { callHeroToStation(); },
  },
  {
    id: 'p-rules',
    route: `/e/${DEMO_EVENT}/rules`,
    title: 'The rules, before the argument',
    body: 'Exactly what this organiser is running, including anything they changed from the preset — marked, so you can see what is different. For Tokon it says whether the loser may change team, order and assists, which are three separate questions and three separate arguments.',
  },
  {
    id: 'p-profile',
    route: '/p/plr_demo01',
    title: 'And it stays on your record',
    body: 'Tonight\'s sets are already here, alongside every other event on the site. Head-to-head against everyone you have played, at any venue, in any game — because the player is the durable thing and the tournament is what points at it. Change your tag and none of this breaks.',
    act() { reportHeroSet(); },
    last: true,
  },
];

/* Point the local session at an existing demo entrant. Only ever used by the
   tour, and only for demo data -- it refuses to attach to anything else, so it
   cannot become a way to act as another person. */
function becomePlayer(playerId) {
  const player = store.getPlayer(playerId);
  if (!player?.demo) return;
  auth.adoptLocalSession({
    playerId, email: null, methods: ['demo'],
    needsPasswordFallback: false, local: true, demo: true,
  });
}

function releasePlayer() {
  if (store.getSession()?.demo) auth.adoptLocalSession(null);
}

/* Put the hero's next set on a station, so the "you are up" step is showing a
   real called set rather than a description of one. */
function callHeroToStation() {
  const bracket = store.get().brackets[DEMO_EVENT];
  const entry = store.entryFor(DEMO_EVENT, HERO);
  if (!bracket || !entry) return;

  const match = readyMatches(bracket.matches)
    .find((m) => m.slots.some((sl) => sl.entrantId === entry.id) && !m.calledAt);
  if (!match) return;

  const station = store.stationsFor(DEMO_EVENT).find((s) => !s.matchId && !s.closed);
  const matches = bracket.matches.map((m) => (m.id === match.id
    ? { ...m, calledAt: new Date(Date.now() - 40_000).toISOString(), stationId: station?.id || null }
    : m));
  store.apply('brackets', DEMO_EVENT, { matches });
  if (station) store.apply('stations', station.id, { matchId: match.id });
}

/* Report the hero's called set so the profile step has tonight on it. */
function reportHeroSet() {
  const bracket = store.get().brackets[DEMO_EVENT];
  const entry = store.entryFor(DEMO_EVENT, HERO);
  if (!bracket || !entry) return;

  const match = bracket.matches.find((m) => m.calledAt && !m.state
    && m.slots.some((sl) => sl.entrantId === entry.id));
  if (!match) return;

  const heroIsA = match.slots[0].entrantId === entry.id;
  const matches = reportResult(bracket.matches, match.id, {
    winnerId: entry.id, scoreA: heroIsA ? 2 : 1, scoreB: heroIsA ? 1 : 2,
  });
  store.apply('brackets', DEMO_EVENT, { matches });

  const station = store.stationsFor(DEMO_EVENT).find((s) => s.matchId === match.id);
  if (station) store.apply('stations', station.id, { matchId: null });

  const opponentEntryId = match.slots.find((sl) => sl.entrantId !== entry.id)?.entrantId;
  const opponent = store.entriesFor(DEMO_EVENT).find((e) => e.id === opponentEntryId);
  if (!opponent) return;

  const id = 'res_tour_hero';
  store.apply('results', id, {
    id, eventId: DEMO_EVENT, gameId: 'tokon',
    matchId: match.id, roundName: match.name,
    winnerPlayerId: HERO, loserPlayerId: opponent.playerId,
    scoreWinner: 2, scoreLoser: 1,
    reportedAt: new Date().toISOString(), demo: true,
  }, { queueIt: false });
}

/* ==========================================================================
   The tours
   ========================================================================== */

export const TOURS = [
  {
    id: 'organiser',
    name: 'Running it',
    blurb: 'The organiser\'s night: a roster, four no-shows, seeding, and a bracket.',
    icon: 'settings',
    steps: ORGANISER_STEPS,
  },
  {
    id: 'tv',
    name: 'On the TV',
    blurb: 'What goes on the screen in the corner of the venue.',
    icon: 'station',
    steps: TV_STEPS,
  },
  {
    id: 'player',
    name: 'Playing in it',
    blurb: 'The same night from the seat of somebody who paid five dollars.',
    icon: 'person',
    steps: PLAYER_STEPS,
  },
];

/* Generate the bracket from whoever is checked in, then play the first few
   sets so the run view has history in it rather than being an empty grid.

   Results are decided by seed with a fixed upset pattern rather than randomly:
   a demo that shuffles on every reset makes it impossible to tell a rendering
   bug from the data changing, and it means two people looking at the same
   demo are not looking at different things. */
function generateAndPlay(setsToPlay) {
  const event = store.getEvent(DEMO_EVENT);
  const entries = entriesOf()
    .filter((e) => e.checkedInAt && !e.waitlisted)
    .sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999));
  if (entries.length < 2) return;

  const seeds = entries.map((entry) => ({ id: entry.id, name: nameOf(entry.playerId) }));
  const built = event.format === 'single'
    ? singleElimination(seeds)
    : doubleElimination(seeds, { grandFinalsReset: true });

  let matches = built.matches;
  const seedOf = new Map(entries.map((e) => [e.id, e.seed ?? 9999]));

  for (let i = 0; i < setsToPlay; i += 1) {
    const ready = readyMatches(matches);
    if (!ready.length) break;
    const match = ready[0];
    const [a, b] = match.slots;
    /* Every third set is an upset, so the bracket does not read as pure
       chalk -- a demo where the top seed always wins shows none of the
       interesting parts of a losers bracket. */
    const upset = i % 3 === 2;
    const favourite = seedOf.get(a.entrantId) <= seedOf.get(b.entrantId) ? a.entrantId : b.entrantId;
    const winnerId = upset ? (favourite === a.entrantId ? b.entrantId : a.entrantId) : favourite;
    const winnerIsA = winnerId === a.entrantId;
    matches = reportResult(matches, match.id, {
      winnerId, scoreA: winnerIsA ? 2 : (i % 2), scoreB: winnerIsA ? (i % 2) : 2,
    });

    /* And the durable result row, so the profiles in the next step have
       tonight's sets on them too. */
    const entryOf = (id) => entries.find((e) => e.id === id);
    const w = entryOf(winnerId)?.playerId;
    const l = entryOf(winnerIsA ? b.entrantId : a.entrantId)?.playerId;
    if (w && l) {
      const resultId = `res_tour_${i}`;
      store.apply('results', resultId, {
        id: resultId, eventId: DEMO_EVENT, gameId: event.gameId,
        matchId: match.id, roundName: match.name,
        winnerPlayerId: w, loserPlayerId: l,
        scoreWinner: 2, scoreLoser: i % 2,
        reportedAt: new Date(Date.now() - (setsToPlay - i) * 240_000).toISOString(),
        demo: true,
      }, { queueIt: false });
    }
  }

  /* Two sets left out on stations, so the run view has live timers. */
  const stations = store.stationsFor(DEMO_EVENT).filter((s) => !s.closed);
  const stillReady = readyMatches(matches);
  stations.slice(0, 2).forEach((station, i) => {
    const match = stillReady[i];
    if (!match) return;
    matches = matches.map((m) => (m.id === match.id
      ? { ...m, calledAt: new Date(Date.now() - (i === 0 ? 9 : 2) * 60_000).toISOString(), stationId: station.id }
      : m));
    store.apply('stations', station.id, { matchId: match.id });
  });

  store.apply('brackets', DEMO_EVENT, {
    id: DEMO_EVENT, eventId: DEMO_EVENT,
    type: built.type, size: built.size, rounds: built.rounds,
    matches,
    generatedAt: new Date().toISOString(),
  });
  store.apply('events', DEMO_EVENT, { status: 'running' });
}

/* --------------------------------------------------------------------------
   Control
   -------------------------------------------------------------------------- */

export function start(tourId = 'organiser') {
  snapshot();
  write(LS_DISMISSED, false);
  write(LS_TOUR, tourId);
  goToStep(0);
}

export function goToStep(index) {
  const step = currentTour().steps[index];
  if (!step) return;
  write(LS_STEP, index);
  /* The writes happen before the navigation so the view renders once, already
     in the right state, instead of flashing the old one. */
  try { step.act?.(); } catch (err) { console.error('[tour] step failed', step.id, err); }

  /* Consecutive steps often share a route -- three of the four display steps
     are all `/tv`, and two organiser steps are both the run view. Assigning an
     unchanged hash fires no hashchange, so the router never redraws and the
     card appears frozen on the previous step.

     That only surfaced once the one-second blanket redraw was removed: until
     then something else happened to repaint within a second and covered it up.
     Asking for the redraw explicitly is the fix; relying on a timer to
     accidentally do it was never correct. */
  const target = `#${step.route}`;
  if (window.location.hash === target) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

export const next = () => goToStep((tourStep() ?? -1) + 1);
export const previous = () => goToStep(Math.max(0, (tourStep() ?? 0) - 1));

export function stop() {
  write(LS_STEP, null);
  /* The player tour borrows an identity to make the player views real. Ending
     the tour hands it back, so nobody is left signed in as somebody who does
     not exist. */
  releasePlayer();
}

export function dismiss() {
  write(LS_DISMISSED, true);
}

/* --------------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------------
   Two pieces of chrome, both docked rather than floating over the content:

     * the demo BANNER, always present on demo data, saying what this is and
       offering the tour and a reset
     * the tour CARD, present while a tour is running, with the current step

   Neither is a spotlight-and-overlay tour. Those look impressive and are
   hostile: they trap focus, break on any layout they did not anticipate, and
   stop you clicking the thing they are pointing at. Docking the guidance
   leaves the whole app live underneath it, which is the entire point here --
   the visitor is meant to poke at it.
   -------------------------------------------------------------------------- */

export function demoBanner() {
  if (!isDemoData() || isRunning()) return '';
  if (isDismissed()) {
    return html`
      <div class="demo-bar demo-bar-slim">
        <span class="spacer body-small">Demo data</span>
        ${list(TOURS.map((t) => html`
          <button class="btn btn-text btn-sm" data-act="tour-start" data-tour="${t.id}">${t.name}</button>`))}
        <button class="btn btn-text btn-sm" data-act="tour-reset">Reset</button>
      </div>`;
  }
  return html`
    <div class="demo-bar">
      ${raw(icon('sparkle'))}
      <div class="spacer">
        <b class="title-small">This is a live demo</b>
        <div class="body-small">
          A Marvel Tōkon weekly with 28 entrants, running entirely in your browser.
          No account, nothing saved to a server. Change anything you like — reset puts it back.
        </div>
        <!-- Three tours rather than one, because the three people who look at
             this want different things: whoever is running it, whoever is
             watching the screen, and whoever is playing. Offering the
             organiser's tour to a player and hoping they extrapolate is how a
             demo fails to land. -->
        <div class="demo-tours">
          ${list(TOURS.map((t) => html`
            <button class="demo-tour" data-act="tour-start" data-tour="${t.id}">
              ${raw(icon(t.icon))}
              <span>
                <b>${t.name}</b>
                <span class="body-small">${t.blurb}</span>
              </span>
              <span class="demo-tour-count">${t.steps.length} steps</span>
            </button>`))}
        </div>
      </div>
      <div class="demo-bar-actions">
        <button class="btn btn-text btn-sm" data-act="tour-reset">Reset</button>
        <button class="btn btn-icon" data-act="tour-dismiss" aria-label="Hide this notice">${raw(icon('close'))}</button>
      </div>
    </div>`;
}

export function tourCard() {
  const index = tourStep();
  const tour = currentTour();
  if (index === null || !tour.steps[index]) return '';
  const step = tour.steps[index];
  const total = tour.steps.length;

  return html`
    <aside class="tour" aria-label="Guided demo">
      <div class="tour-progress" role="group" aria-label="Step ${index + 1} of ${total}">
        ${list(tour.steps.map((s, i) => html`
          <span class="tour-pip ${raw(i === index ? 'on' : i < index ? 'done' : '')}"></span>`))}
      </div>
      <div class="tour-body">
        <p class="tour-count label-medium">${tour.name} · step ${index + 1} of ${total}</p>
        <h2 class="tour-title">${step.title}</h2>
        <p class="tour-text">${step.body}</p>
      </div>
      <div class="tour-actions">
        ${index > 0
          ? html`<button class="btn btn-text btn-sm" data-act="tour-prev">Back</button>`
          : html`<button class="btn btn-text btn-sm" data-act="tour-stop">Skip</button>`}
        <span class="spacer"></span>
        ${step.last
          ? html`
            ${list(TOURS.filter((t) => t.id !== tour.id).map((t) => html`
              <button class="btn btn-text btn-sm" data-act="tour-start" data-tour="${t.id}">${t.name}</button>`))}
            <button class="btn btn-outlined btn-sm" data-act="tour-reset">Reset</button>
            <button class="btn btn-filled btn-sm" data-act="tour-stop">Explore</button>`
          : html`
            <button class="btn btn-text btn-sm" data-act="tour-stop">Stop</button>
            <button class="btn btn-filled btn-sm" data-act="tour-next">Next ${raw(icon('chevron', 'icon-sm'))}</button>`}
      </div>
    </aside>`;
}
