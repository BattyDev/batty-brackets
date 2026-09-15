/* Brackets · the venue display
   ===========================================================================
   What goes on the television in the corner of the room.

   ## What this is for

   At a local the single most expensive failure is somebody missing their set,
   and the cause is almost always the same: they did not hear their name. A TO
   shouting across a room with two hundred people and eight consoles running
   does not scale, and it is the reason DQ timers exist at all.

   A screen that answers "am I up?" from across the room fixes most of it, and
   it is the cheapest thing in this entire project to build. The venue already
   owns a television.

   ## What a display is NOT

   It is not the app with bigger text. Three things follow from that, and each
   one is a decision the rest of the app makes differently:

   **It has no controls.** A television has no mouse. Everything on screen is
   read-only, and the settings live in a bar that is only there for the person
   setting it up on the laptop plugged into the HDMI cable — it hides itself
   once the display is running.

   **It is read from four metres away, not forty centimetres.** Type is sized
   in `vmin` so it scales with whatever screen it lands on, from a 24" monitor
   on a table to a projector. The layout carries far fewer things than the
   organiser's run view because at that distance you can hold about five.

   **It has to survive being glanced at.** Somebody looks up for two seconds
   between games. So what changed recently is marked, the rotation is slow
   enough to read (fifteen seconds, not five), and nothing slides or fades in
   a way that means a glance catches a half-drawn screen.

   ## Screens

     queue     who is on now, and who is up next. The default, and the one
               that earns the television.
     bracket   the live rounds and what just finished — see the note on that
               screen for why it is not the whole tree.
     cycle     alternates the two, with a progress bar so a viewer knows how
               long they have before it moves on.
   =========================================================================== */

'use strict';

import { html, raw, list, icon, esc, on, elapsed } from '../lib/ui.js';
import * as store from '../lib/store.js';
import { gameById, resolveRuleset } from '../data/games.js';
import { readyMatches } from '../lib/bracket.js';
import { brandSignature } from '../lib/brand.js';

/* Display state is per-device and never synced: the laptop driving the TV has
   its own idea of which screen is showing, and it is nobody else's business.
   Held in localStorage so a browser that reloads (or a venue PC that reboots
   between weeklies) comes back to the same screen. */
const LS = 'battydev.brackets.tv';

const read = () => {
  try { return JSON.parse(localStorage.getItem(LS)) || {}; }
  catch { return {}; }
};
const write = (patch) => {
  try { localStorage.setItem(LS, JSON.stringify({ ...read(), ...patch })); }
  catch { /* private mode */ }
};

export const SCREENS = [
  { id: 'queue', label: 'Who is up', icon: 'bell' },
  { id: 'bracket', label: 'Bracket', icon: 'bracket' },
  { id: 'cycle', label: 'Cycle both', icon: 'shuffle' },
];

/* Fifteen seconds. Five felt responsive when testing it at a desk and is far
   too fast in a room -- somebody looking up has to find the screen, work out
   which half of it matters, and then read down a list for their own tag. */
const CYCLE_SECONDS = 15;

const state = () => ({ screen: 'queue', showing: 'queue', ...read() });

/* --------------------------------------------------------------------------
   The rotation
   --------------------------------------------------------------------------
   One interval, owned by this module, that stops itself the moment the route
   is no longer the display. There is no unmount hook in the router, so the
   timer has to check rather than be told -- which is also why it is idempotent
   to start.
   -------------------------------------------------------------------------- */

let cycleTimer = null;
let cycleStartedAt = 0;

function ensureCycleTimer(onTick) {
  const isTv = () => window.location.hash.includes('/tv');
  if (state().screen !== 'cycle' || !isTv()) {
    if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
    return;
  }
  if (cycleTimer) return;

  cycleStartedAt = Date.now();
  cycleTimer = setInterval(() => {
    if (!isTv() || state().screen !== 'cycle') {
      clearInterval(cycleTimer); cycleTimer = null; return;
    }
    const elapsedSecs = (Date.now() - cycleStartedAt) / 1000;
    /* The progress bar is a CSS transition driven from here rather than a
       keyframe animation, so a re-render mid-cycle does not restart it. */
    const bar = document.querySelector('.tv-progress > i');
    if (bar) bar.style.width = `${Math.min(100, (elapsedSecs / CYCLE_SECONDS) * 100)}%`;
    if (elapsedSecs < CYCLE_SECONDS) return;
    cycleStartedAt = Date.now();
    write({ showing: state().showing === 'queue' ? 'bracket' : 'queue' });
    onTick();
  }, 250);
}

/* --------------------------------------------------------------------------
   View
   -------------------------------------------------------------------------- */

export function view(ctx) {
  const event = store.getEvent(ctx.params.eventId);
  if (!event) {
    return {
      title: 'Display', back: '/', chromeless: true,
      body: html`<div class="tv"><div class="tv-empty">No event with that id on this device.</div></div>`,
    };
  }

  const game = gameById(event.gameId);
  const org = store.getOrg(event.orgId);
  const ruleset = game ? resolveRuleset(game, event.presetId, event.overrides || {}) : null;
  const entries = store.entriesFor(event.id);
  const players = new Map(entries.map((e) => [e.playerId, store.getPlayer(e.playerId)]));
  const bracket = store.get().brackets[event.id] || null;
  const stations = store.stationsFor(event.id);
  const view$ = state();
  const showing = view$.screen === 'cycle' ? view$.showing : view$.screen;
  const checkIn = checkInStats(entries);

  ensureCycleTimer(() => window.dispatchEvent(new HashChangeEvent('hashchange')));

  const nameOf = (entrantId) => {
    const entry = entries.find((e) => e.id === entrantId);
    return players.get(entry?.playerId)?.tag || '—';
  };

  return {
    title: `${event.name} — display`,
    back: `/e/${event.id}/admin`,
    gameId: event.gameId,
    /* The shell's app bar and nav are suppressed: a television showing a
       navigation rail is showing 88px of nothing. */
    chromeless: true,
    body: html`
      <div class="tv">
        ${raw(controlBar(event, view$))}

        <header class="tv-head">
          <div>
            <p class="tv-brand">${raw(brandSignature())}</p>
            <h1 class="tv-title">${event.name}</h1>
            <p class="tv-eyebrow">${org ? `Organized by ${org.name} · ` : ''}${game?.name || ''}</p>
          </div>
          <div class="tv-head-right">
            ${canJoinFromDisplay(event) ? html`
              <p class="tv-join">Join code <b>${event.inviteCode}</b></p>` : html`
              <p class="tv-join">${event.demo ? 'Demo event · local display' : 'Local event · check in with the organiser'}</p>`}
            ${bracket ? html`<p class="tv-count ${raw(bracketComplete(bracket) ? 'complete' : '')}"
              data-tv-status>${countLeft(bracket)}</p>` : html`
              <p class="tv-count" data-tv-status>${checkIn.checkedIn} of ${checkIn.total} checked in</p>`}
          </div>
        </header>

        ${showing === 'bracket' && bracket
          ? raw(bracketScreen(bracket, nameOf))
          : raw(queueScreen({ event, bracket, stations, entries, players, nameOf, ruleset }))}

        ${view$.screen === 'cycle' ? html`
          <div class="tv-progress" aria-hidden="true"><i></i></div>` : ''}
      </div>`,
  };
}

const countLeft = (bracket) => {
  const total = bracket.matches.filter((m) => !m.cancelled).length;
  const done = bracket.matches.filter((m) => m.state).length;
  return total - done === 0 ? 'Complete' : `${total - done} sets left`;
};

const canJoinFromDisplay = (event) => Boolean(
  event.inviteCode && store.syncState().configured && !event.demo,
);

const checkInStats = (entries) => {
  const checkedIn = entries.filter((entry) => entry.checkedInAt).length;
  return { checkedIn, total: entries.length, missing: entries.length - checkedIn };
};

const bracketComplete = (bracket) => {
  const matches = bracket?.matches?.filter((match) => !match.cancelled) || [];
  /* `every([])` is true. An empty/cancelled bracket is not a completed event,
     and without the final-match check it would announce a champion that does
     not exist. Keep the display in its ordinary empty-queue state instead. */
  return matches.length > 0 && matches.every((match) => match.state) && Boolean(finalMatch(bracket));
};

/* The final match is not always GF-2: a double-elimination final can end on
   GF-1, and a single-elimination bracket has no GF rows at all. Keeping this
   selection here means the completion card can say who won without teaching
   the display about the bracket engine's internal progression rules. */
const finalMatch = (bracket) => {
  const completed = bracket.matches.filter((match) => match.state && !match.cancelled);
  const grandFinal = completed
    .filter((match) => match.bracket === 'GF')
    .sort((a, b) => b.round - a.round)[0];
  if (grandFinal) return grandFinal;
  return completed
    .filter((match) => match.bracket === 'W')
    .sort((a, b) => b.round - a.round)[0] || null;
};

const matchScore = (match) => match?.score
  ? `${Math.max(match.score.a ?? 0, match.score.b ?? 0)}–${Math.min(match.score.a ?? 0, match.score.b ?? 0)}`
  : '';

/* --------------------------------------------------------------------------
   The control bar
   --------------------------------------------------------------------------
   For the person plugging the laptop in, not for the room. It fades out and
   comes back on mouse movement, the way a video player's controls do -- the
   same problem and the same solution.
   -------------------------------------------------------------------------- */

function controlBar(event, view$) {
  return html`
    <div class="tv-controls" data-tv-controls>
      <a class="btn btn-text btn-sm" href="#/e/${event.id}/admin">${raw(icon('back', 'icon-sm'))} Organiser</a>
      <span class="spacer"></span>
      <div class="segmented" role="group" aria-label="Which screen to show">
        ${list(SCREENS.map((s) => html`
          <button type="button" data-act="tv-screen" data-screen="${s.id}"
                  aria-pressed="${view$.screen === s.id}">
            ${raw(icon(s.icon, 'icon-sm'))} ${s.label}
          </button>`))}
      </div>
      <button class="btn btn-tonal btn-sm" data-act="tv-fullscreen">
        ${raw(icon('eye', 'icon-sm'))} Full screen
      </button>
    </div>`;
}

/* --------------------------------------------------------------------------
   Screen: who is up
   -------------------------------------------------------------------------- */

function queueScreen({ event, bracket, stations, entries, players, nameOf, ruleset }) {
  if (!bracket) {
    const checkIn = checkInStats(entries);
    return html`
      <div class="tv-body">
        <div class="tv-empty tv-checkin">
          <p class="tv-empty-kicker">Check-in in progress</p>
          <p class="tv-empty-lead">${checkIn.checkedIn} <span>of</span> ${checkIn.total} checked in</p>
          <p class="tv-empty-supporting">${checkIn.missing
            ? `${checkIn.missing} ${checkIn.missing === 1 ? 'entrant is' : 'entrants are'} still to arrive.`
            : 'Everyone is here — the organiser can make the bracket.'}</p>
          <p class="tv-empty-supporting">The bracket has not been made yet.</p>
          <p class="tv-empty-code">${canJoinFromDisplay(event)
            ? html`Join with <b>${event.inviteCode}</b>`
            : 'Check in with the organiser. Match calls will appear here.'}</p>
        </div>
      </div>`;
  }

  if (bracketComplete(bracket)) return completionScreen(bracket, nameOf);

  const called = new Set(bracket.matches.filter((m) => m.calledAt && !m.state).map((m) => m.id));
  const live = stations
    .filter((s) => !s.closed)
    .map((s) => ({ station: s, match: bracket.matches.find((m) => m.id === s.matchId && !m.state) }));
  const queue = readyMatches(bracket.matches).filter((m) => !called.has(m.id));
  const dq = Number(ruleset?.values?.dqTimer || 5);

  return html`
    <div class="tv-body">
      <section class="tv-now">
        <h2 class="tv-section">On now</h2>
        <div class="tv-stations">
          ${list(live.map(({ station, match }) => {
            const first = match ? nameOf(match.slots[0].entrantId) : '';
            const second = match ? nameOf(match.slots[1].entrantId) : '';
            return html`
            <div class="tv-station ${raw(match ? 'busy' : 'free')}" data-live-scope>
              <div class="tv-station-meta">
                <p class="tv-station-name">${station.label}</p>
                <span class="tv-station-state">${match ? 'Now playing' : 'Open'}</span>
              </div>
              ${match ? html`
                <p class="tv-vs">
                  <span class="tv-player" title="${first}">${first}</span>
                  <span class="tv-vs-mark">vs</span>
                  <span class="tv-player" title="${second}">${second}</span>
                </p>
                <p class="tv-round">${match.name}
                  ${match.calledAt ? html` · <span data-live-since="${match.calledAt}"
                    data-live-over="${dq}">${elapsed(match.calledAt)}</span>` : ''}</p>`
              : html`<p class="tv-free">Free</p>`}
            </div>`;
          }))}
        </div>
      </section>

      <section class="tv-next">
        <h2 class="tv-section">Up next</h2>
        ${queue.length ? html`
          <ol class="tv-queue">
            ${list(queue.slice(0, 8).map((match, i) => html`
              <li class="tv-queue-row ${raw(i === 0 ? 'first' : '')}">
                <span class="tv-queue-num">${i + 1}</span>
                <span class="tv-queue-names">
                  <span class="tv-queue-player" title="${nameOf(match.slots[0].entrantId)}">${nameOf(match.slots[0].entrantId)}</span>
                  <span class="tv-vs-mark">vs</span>
                  <span class="tv-queue-player" title="${nameOf(match.slots[1].entrantId)}">${nameOf(match.slots[1].entrantId)}</span>
                </span>
                <span class="tv-queue-round">${match.name}</span>
              </li>`))}
          </ol>
          ${queue.length > 8 ? html`
            <p class="tv-queue-more">…and ${queue.length - 8} more</p>` : ''}`
        : html`<p class="tv-free">Nothing waiting — every playable set is out.</p>`}
      </section>
    </div>`;
}

function completionScreen(bracket, nameOf) {
  const final = finalMatch(bracket);
  if (!final?.winnerId) {
    return html`<div class="tv-body"><p class="tv-free">Final results are not available yet.</p></div>`;
  }
  const champion = nameOf(final.winnerId);
  const runnerUp = final?.slots?.find((slot) => slot.entrantId && slot.entrantId !== final.winnerId);
  return html`
    <div class="tv-body tv-body-complete">
      <section class="tv-complete" aria-labelledby="tv-complete-title">
        <p class="tv-complete-kicker">Tournament complete</p>
        <h2 id="tv-complete-title">${champion}</h2>
        <p class="tv-complete-label">Champion</p>
        ${final ? html`<p class="tv-complete-final">${final.name}${matchScore(final) ? html` · ${matchScore(final)}` : ''}
          ${runnerUp ? html`<span>over ${nameOf(runnerUp.entrantId)}</span>` : ''}</p>` : ''}
      </section>
      <section class="tv-next tv-complete-next">
        <h2 class="tv-section">What’s next</h2>
        <p class="tv-free">All sets are complete. Please check with the organiser for final standings and the next event.</p>
      </section>
    </div>`;
}

/* --------------------------------------------------------------------------
   Screen: bracket
   --------------------------------------------------------------------------
   The TOP CUT, not the whole tree, and that is the important decision here.

   The first version rendered every round. A 32-entrant double elimination is
   fifteen columns and sixteen first-round matches, which on a 1080p screen
   works out at about eleven pixels a name -- illegible at arm's length, never
   mind from across a room, and overflowing the bottom of the screen besides.
   It technically showed the bracket and communicated nothing.

   Nobody standing in a venue is reading winners round one of a 32-man. What
   they want from a bracket screen is where the event has got to: who is still
   in on each side, and what just happened. So this shows a window of rounds
   around wherever play has actually reached -- preferring the narrow ones,
   because those draw big -- plus a strip of the most recent results, which is
   what fills the screen usefully in the first half hour before anybody has
   been knocked out.

   A small bracket shows entirely, because then it fits.
   -------------------------------------------------------------------------- */

/* A round earns a column if it is narrow enough to draw big. Four matches is
   about the limit at which two names and a score stay legible across a room. */
const TV_MAX_MATCHES_PER_ROUND = 4;
/* Per side, so the two halves stay balanced. Taking the last N columns of the
   whole list was the first attempt and it showed nothing but empty losers
   rounds: the winners side sorts first, so the tail of the array is entirely
   losers and grand finals, which early in an event are all dashes. */
const TV_ROUNDS_PER_SIDE = 3;

function bracketRounds(bracket) {
  const bySide = { W: [], L: [], GF: [] };
  for (const side of bracket.type === 'double' ? ['W', 'L', 'GF'] : ['W']) {
    const nums = [...new Set(bracket.matches.filter((m) => m.bracket === side).map((m) => m.round))]
      .sort((a, b) => a - b);
    for (const num of nums) {
      const matches = bracket.matches.filter((m) => m.bracket === side && m.round === num && !m.cancelled);
      if (matches.length) bySide[side].push({ side, name: matches[0].name, matches });
    }
  }

  const all = [...bySide.W, ...bySide.L, ...bySide.GF];
  const narrow = (rounds) => rounds.filter((r) => r.matches.length <= TV_MAX_MATCHES_PER_ROUND);
  /* Everything narrow means the bracket is small enough to show whole. */
  if (narrow(all).length === all.length) return { rounds: all, trimmed: false };

  /* Prefer rounds somebody has actually reached. A column of dashes tells the
     room nothing, and early on the deepest rounds are all dashes. */
  const populated = (r) => r.matches.some((m) => m.slots.some((sl) => sl.entrantId));
  /* A window that starts where people currently are and runs forward, so the
     screen shows the path ahead rather than only the row somebody is standing
     on. Backs off the end so it still fills its columns near the final. */
  const window = (list, n) => {
    if (list.length <= n) return list;
    const deepestLive = list.map(populated).lastIndexOf(true);
    if (deepestLive < 0) return list.slice(-n);
    const start = Math.max(0, Math.min(deepestLive, list.length - n));
    return list.slice(start, start + n);
  };

  /* Prefer the narrow rounds, because those are the ones that draw big. But
     an empty column is worth nothing at any size, so if nobody has reached
     them yet, fall back to showing where people ACTUALLY are even though that
     round is wider and the type comes out smaller.

     This is the bug the demo surfaced, and it was not only a demo bug: for the
     first third of every real event the later rounds are empty, so the bracket
     screen showed eight columns of dashes while a fully populated round sat
     one step earlier. That is the window when the most people are looking at
     it. Something legible-but-small beats nothing legible-but-large. */
  /* Keep exactly one empty round after the last populated one -- enough to
     show where the winners go next, without spending half a television on
     columns nobody can reach yet. Three rounds ahead is padding; one is
     context. */
  const trimTrailingEmpty = (rounds) => {
    const lastLive = rounds.map(populated).lastIndexOf(true);
    return lastLive < 0 ? rounds : rounds.slice(0, lastLive + 2);
  };

  const pick = (rounds) => {
    const preferred = window(narrow(rounds), TV_ROUNDS_PER_SIDE);
    if (preferred.some(populated)) return trimTrailingEmpty(preferred);
    return trimTrailingEmpty(window(rounds, TV_ROUNDS_PER_SIDE));
  };

  /* Grand finals only once somebody is in them. For most of an event those
     two columns are guaranteed empty, and spending a quarter of the screen on
     a match that cannot happen yet is worse than not showing it -- the space
     goes to rounds that have people in them instead. */
  const gf = bySide.GF.some(populated) ? bySide.GF : [];
  const rounds = [...pick(bySide.W), ...pick(bySide.L), ...gf];
  return { rounds, trimmed: rounds.length < all.length };
}

function recentResults(bracket, nameOf, limit = 4) {
  return bracket.matches
    .filter((m) => m.state === 'complete' && m.reportedAt)
    .sort((a, b) => String(b.reportedAt).localeCompare(String(a.reportedAt)))
    .slice(0, limit)
    .map((m) => ({
      winner: nameOf(m.winnerId),
      loser: nameOf(m.loserId),
      score: `${Math.max(m.score?.a ?? 0, m.score?.b ?? 0)}–${Math.min(m.score?.a ?? 0, m.score?.b ?? 0)}`,
      round: m.name,
    }));
}

function bracketScreen(bracket, nameOf) {
  const { rounds, trimmed } = bracketRounds(bracket);
  const recent = recentResults(bracket, nameOf);

  /* Type scales PER COLUMN, from how many matches that column has to fit.
     ------------------------------------------------------------------------
     Height is the constraint nobody thinks about until it bites. A column of
     eight matches at the size two matches want is taller than the television,
     and the overflow silently ate the recent-results strip along the bottom.

     Scaling everything to the widest column fixed the overflow and cost too
     much: one eight-match losers round dragged the four-match quarter-final
     down with it, and the names people actually want to read came out at
     eleven pixels. Each column gets its own scale instead, so a narrow round
     stays large next to a wide one. Earlier rounds rendering smaller than
     later ones is what every bracket on a stream already does. */
  const columnScale = (count) => Math.max(0.45, Math.min(1, 5 / Math.max(count, 1)));

  return html`
    <div class="tv-body tv-body-bracket">
      <section class="tv-cut">
        <h2 class="tv-section">
          ${trimmed ? 'How it stands' : 'Bracket'}
          ${trimmed ? html`<span class="tv-section-note">the full bracket is on the organiser view</span>` : ''}
        </h2>
        ${rounds.length ? html`
          <div class="tv-bracket">
            ${list(rounds.map((round) => html`
              <div class="tv-round-col" style="--tv-scale:${columnScale(round.matches.length).toFixed(2)}">
                <h3>${round.name}</h3>
                <div class="tv-round-body">
                  ${list(round.matches.map((match) => {
                    const done = match.state === 'complete';
                    const bye = match.state === 'bye';
                    const live = Boolean(match.calledAt && !match.state);
                    return html`
                      <div class="tv-match ${raw(bye ? 'bye' : done ? 'done' : live ? 'live' : '')}">
                        ${list(match.slots.map((slot) => {
                          if (!slot.entrantId) return html`<span class="tv-side tbd"><span class="tv-side-name">—</span></span>`;
                          const won = done && match.winnerId === slot.entrantId;
                          const score = done ? (won
                            ? Math.max(match.score?.a ?? 0, match.score?.b ?? 0)
                            : Math.min(match.score?.a ?? 0, match.score?.b ?? 0)) : '';
                          return html`
                            <span class="tv-side ${raw(won ? 'won' : done ? 'lost' : '')}">
                              <span class="tv-side-name">${nameOf(slot.entrantId)}</span>
                              <span class="tv-side-score">${score}</span>
                            </span>`;
                        }))}
                      </div>`;
                  }))}
                </div>
              </div>`))}
          </div>`
        : html`<p class="tv-free">The bracket has not started yet.</p>`}
      </section>

      ${recent.length ? html`
        <section class="tv-recent">
          <h2 class="tv-section">Just finished</h2>
          <ul class="tv-recent-list">
            ${list(recent.map((r) => html`
              <li>
                <b>${r.winner}</b>
                <span class="tv-recent-score">${r.score}</span>
                <span class="tv-recent-loser">${r.loser}</span>
                <span class="tv-recent-round">${r.round}</span>
              </li>`))}
          </ul>
        </section>` : ''}
    </div>`;
}

/* --------------------------------------------------------------------------
   Actions
   -------------------------------------------------------------------------- */

const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

on('tv-screen', ({ screen }) => {
  write({ screen, showing: screen === 'cycle' ? state().showing : screen });
  /* Restart the rotation from zero on a manual change, so switching to Cycle
     does not immediately flip because the old timer was nearly up. */
  if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
  rerender();
});

on('tv-fullscreen', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    /* Blocked (no user gesture, or an iframe without allowfullscreen). The
       display is still perfectly usable at window size, so this is not worth
       an error dialog on a screen nobody is standing at. */
  }
});
