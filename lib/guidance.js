/* Brackets · the guidance engine
   ===========================================================================
   Given the state of an event, what should the organiser do next?

   ## Why this is a feature and not a gimmick

   Running a local is not hard because any one step is hard. It is hard because
   the steps are conditional on a room that keeps changing, and the TO is the
   only person holding the whole state -- while also being the person who has
   to go find out whether the guy in the red hoodie is still in the parking
   lot. Eight of thirty-two do not show. Two people register at the door after
   the bracket is made. Station 3's console updates itself mid-set.

   Every existing site models the happy path and leaves the deviations to the
   TO. That is exactly backwards: the happy path needs no help. What a TO needs
   is for the software to NOTICE the deviation and say what the options are,
   with the consequence of each, and then do the boring part.

   ## The rules

   Each rule is a pure function of `(context) -> Suggestion[]`. No rule reads
   the DOM, none of them writes anything, and the actions they return are
   descriptions of work, not closures that do it. The view decides what a
   button does; the rule decides what is worth offering. That split is what
   makes the whole set testable and what stops "helpfulness" quietly becoming
   "the software did something I did not ask for".

   A Suggestion is:

     { id, level, title, why, actions: [{ id, label, kind, payload }] }

   `level` is one of 'urgent' | 'attention' | 'info'.

     urgent    — the event is blocked or losing time RIGHT NOW
     attention — a decision only the TO can make, and it is due
     info      — worth knowing, no action required

   `why` is not optional and is not flavour text. A suggestion a TO does not
   understand is a suggestion they will ignore for the rest of the event, so
   every one of them states the fact that triggered it, in numbers.
   =========================================================================== */

'use strict';

import { readyMatches, findRematches, bracketSize } from './bracket.js';

const MINUTE = 60 * 1000;
const minutesSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / MINUTE : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* --------------------------------------------------------------------------
   The rules
   -------------------------------------------------------------------------- */

/* ---- registration and check-in ---- */

function ruleCheckInWindow({ event, entries }) {
  if (event.status !== 'checkin') return [];
  const checkedIn = entries.filter((e) => e.checkedInAt).length;
  const missing = entries.length - checkedIn;
  if (!entries.length) return [];

  const closesIn = event.checkInClosesAt ? -minutesSince(event.checkInClosesAt) : null;

  if (closesIn !== null && closesIn <= 0 && missing > 0) {
    return [{
      id: 'checkin-closed-with-missing',
      level: 'urgent',
      title: `Check-in has closed with ${plural(missing, 'entrant', 'entrants')} not checked in`,
      why: `${checkedIn} of ${entries.length} checked in. Every minute you hold the bracket for someone who is not coming is a minute ${checkedIn} people are standing around.`,
      actions: [
        { id: 'dq-missing', label: `Remove all ${missing}`, kind: 'danger', payload: { scope: 'not-checked-in' } },
        { id: 'extend-checkin', label: 'Give them 10 more minutes', kind: 'tonal', payload: { minutes: 10 } },
        { id: 'review-missing', label: 'Review one by one', kind: 'text' },
      ],
    }];
  }

  if (closesIn !== null && closesIn > 0 && closesIn < 10 && missing > 0) {
    return [{
      id: 'checkin-closing',
      level: 'attention',
      title: `Check-in closes in ${Math.ceil(closesIn)} minutes — ${plural(missing, 'entrant is', 'entrants are')} still out`,
      why: 'Now is the moment to ping them, while it is still cheap to fix.',
      actions: [
        { id: 'ping-missing', label: 'Ping them on Discord', kind: 'filled', payload: { scope: 'not-checked-in' } },
        { id: 'view-missing', label: 'See who', kind: 'text' },
      ],
    }];
  }
  return [];
}

/* The single most valuable thing in this file.

   When a chunk of a bracket does not show, the TO's real options are: run it
   with byes (fast, but the bracket is lumpy and someone gets a free round), or
   re-seed to the actual head count (a better bracket, but it invalidates
   anything already announced). Which is right depends on how many, and on
   whether anything has been played yet -- and that is a judgement the software
   can lay out even though it cannot make it.

   The threshold is a QUARTER of the field, not a fixed number, because eight
   no-shows out of 32 is a crisis and eight out of 300 is a Tuesday. */
function ruleNoShows({ event, entries, bracket }) {
  if (!['checkin', 'seeding'].includes(event.status)) return [];
  const missing = entries.filter((e) => !e.checkedInAt);
  if (missing.length < 2) return [];

  const present = entries.length - missing.length;
  const sizeNow = bracketSize(entries.length);
  const sizeAfter = bracketSize(present);
  /* Running as-is keeps the no-shows IN the bracket: they occupy real slots
     and each one becomes a called set that nobody turns up to, then a DQ.
     Re-seeding drops them, which shrinks the field but usually creates more
     byes -- byes are cheap, DQs cost a station call and a DQ-timer wait each.
     Saying which way the trade actually falls is the whole value of this
     suggestion; the earlier version compared two bracket sizes that were
     often identical and read as noise. */
  const byesIfKept = sizeNow - entries.length;
  const byesIfDropped = sizeAfter - present;

  const severe = missing.length >= entries.length / 4;

  const trade = sizeAfter < sizeNow
    ? `Re-seeding to the ${present} who are here shrinks it to a ${sizeAfter} bracket with ${plural(byesIfDropped, 'bye', 'byes')}.`
    : `Re-seeding to the ${present} who are here keeps it at ${sizeAfter} but turns those DQs into ${plural(byesIfDropped, 'bye', 'byes')} — a bye costs nobody anything, a DQ costs a station call and a DQ-timer wait.`;

  return [{
    id: 'no-shows',
    level: severe ? 'attention' : 'info',
    title: `${plural(missing.length, 'entrant has', 'entrants have')} not checked in`,
    why: `${present} of ${entries.length} are here. Running as-is gives a ${sizeNow} bracket with ${plural(byesIfKept, 'bye', 'byes')} and ${plural(missing.length, 'set', 'sets')} that will end in a no-show. ${trade}${bracket ? ' The bracket is already generated, so anyone who has seen it will see it change.' : ''}`,
    actions: [
      { id: 'reseed-present', label: `Re-seed to the ${present} who are here`, kind: 'filled', payload: { scope: 'checked-in' } },
      { id: 'run-with-byes', label: 'Run it with byes', kind: 'tonal' },
      { id: 'view-missing', label: 'See who is missing', kind: 'text' },
    ],
  }];
}

/* ---- seeding ---- */

function ruleUnseeded({ event, entries }) {
  if (event.status !== 'seeding' && event.status !== 'checkin') return [];
  if (entries.length < 4) return [];
  const seeded = entries.filter((e) => e.seed != null).length;
  if (seeded >= entries.length) return [];

  return [{
    id: 'unseeded',
    level: 'attention',
    title: `${plural(entries.length - seeded, 'entrant has', 'entrants have')} no seed`,
    why: 'Unseeded entrants get dropped in at the bottom, which usually means the two best players in the room meet in round one. Seeding by past results here takes one tap.',
    actions: [
      { id: 'autoseed-history', label: 'Seed from results on this site', kind: 'filled' },
      { id: 'autoseed-random', label: 'Randomise', kind: 'tonal' },
      { id: 'open-seeding', label: 'Seed by hand', kind: 'text' },
    ],
  }];
}

function ruleSeedCollisions({ event, seedingReport }) {
  if (!seedingReport?.collisions?.length) return [];
  const round1 = seedingReport.collisions.filter((c) => c.round === 1);
  if (!round1.length) return [];

  return [{
    id: 'seed-collisions',
    level: 'info',
    title: `${plural(round1.length, 'round-one match pits', 'round-one matches pit')} teammates against each other`,
    why: `${round1.map((c) => `${c.a.name} v ${c.b.name}`).join(', ')} — same ${round1[0].group}. Separation has already done what it can within the seed tolerance; going further would move people far enough to change who they are expected to play.`,
    actions: [
      { id: 'open-seeding', label: 'Open the seeding lab', kind: 'tonal' },
      { id: 'raise-tolerance', label: 'Allow bigger seed moves', kind: 'text', payload: { tolerance: 4 } },
    ],
  }];
}

/* ---- running ---- */

/* A set that was called and is still open long after it should have finished.
   The threshold is derived from the actual set length rather than fixed: an
   FT3 in a game with a 99-second timer can legitimately take 25 minutes, and
   a tool that cries wolf on every long set gets ignored by lunchtime. */
function ruleStalledSets({ event, bracket, matchState, ruleset }) {
  if (event.status !== 'running' || !bracket) return [];

  const games = { ft1: 1, ft2: 3, ft3: 5, ft4: 7 }[ruleset?.values?.setLengthPools || 'ft2'] || 3;
  const budget = Math.max(12, games * 5);

  const stalled = (matchState || [])
    .filter((m) => m.calledAt && !m.state)
    .map((m) => ({ match: m, mins: minutesSince(m.calledAt) }))
    .filter((x) => x.mins > budget)
    .sort((a, b) => b.mins - a.mins);

  if (!stalled.length) return [];
  const worst = stalled[0];

  return [{
    id: 'stalled-sets',
    level: worst.mins > budget * 2 ? 'urgent' : 'attention',
    title: `${plural(stalled.length, 'set has', 'sets have')} been out longer than expected`,
    why: `${worst.match.name} has been open ${Math.round(worst.mins)} minutes; a ${String(ruleset?.values?.setLengthPools || 'ft2').toUpperCase()} usually lands inside ${budget}. Either it is a long set, or nobody went to the station.`,
    actions: [
      { id: 'find-set', label: 'Go to the set', kind: 'filled', payload: { matchId: worst.match.id } },
      { id: 'ping-players', label: 'Ping both players', kind: 'tonal', payload: { matchId: worst.match.id } },
    ],
  }];
}

/* DQ timers. The clock started when the set was called; the ruleset says how
   long they get. Surfacing it rather than making the TO remember is the point:
   a DQ that happens on time is fair, and one that happens whenever the TO next
   thinks about it is not. */
function ruleDqTimers({ event, matchState, ruleset }) {
  if (event.status !== 'running') return [];
  const limit = Number(ruleset?.values?.dqTimer || 5);

  const expired = (matchState || [])
    .filter((m) => m.calledAt && !m.state && m.awaiting?.length)
    .map((m) => ({ match: m, mins: minutesSince(m.calledAt) }))
    .filter((x) => x.mins >= limit);

  if (!expired.length) return [];
  const first = expired[0];

  return [{
    id: 'dq-timer',
    level: 'urgent',
    title: `DQ timer expired on ${plural(expired.length, 'set', 'sets')}`,
    why: `${first.match.name}: ${first.match.awaiting.join(' and ')} did not show within the ${limit}-minute DQ window set by your ruleset. It has been ${Math.round(first.mins)}.`,
    actions: [
      { id: 'dq-player', label: 'Disqualify and advance', kind: 'danger', payload: { matchId: first.match.id } },
      { id: 'extend-dq', label: 'Give them 5 more minutes', kind: 'tonal', payload: { matchId: first.match.id, minutes: 5 } },
    ],
  }];
}

function ruleIdleStations({ event, stations, bracket, matchState }) {
  if (event.status !== 'running' || !bracket) return [];
  const open = (stations || []).filter((s) => !s.matchId && !s.closed);
  if (!open.length) return [];

  const called = new Set((matchState || []).filter((m) => m.calledAt && !m.state).map((m) => m.id));
  const waiting = readyMatches(bracket.matches).filter((m) => !called.has(m.id));
  if (!waiting.length) return [];

  return [{
    id: 'idle-stations',
    level: 'attention',
    title: `${plural(open.length, 'station is', 'stations are')} free with ${plural(waiting.length, 'set', 'sets')} waiting`,
    why: 'Idle stations are the main reason a local runs late. Assigning the queue takes one tap and the players get pinged automatically.',
    actions: [
      { id: 'assign-queue', label: `Fill ${open.length === 1 ? 'it' : 'them'} from the queue`, kind: 'filled' },
      { id: 'open-run', label: 'Open the run view', kind: 'text' },
    ],
  }];
}

function ruleRematches({ event, bracket }) {
  if (!bracket || event.status !== 'running') return [];
  const early = findRematches(bracket.matches)
    .filter((r) => r.match.bracket === 'L' && r.match.round <= 2);
  if (!early.length) return [];

  return [{
    id: 'early-rematch',
    level: 'info',
    title: `${plural(early.length, 'early losers set is', 'early losers sets are')} a rematch`,
    why: `${early.map((r) => r.match.name).join(', ')} pairs players who already met in winners. At this bracket size the drop pattern cannot always avoid it — worth knowing before someone points it out.`,
    actions: [{ id: 'dismiss', label: 'Understood', kind: 'text' }],
  }];
}

/* ---- data quality ---- */

/* Two entrants who are probably the same human. Catches the classic: someone
   pre-registers online AND gets typed in again at the door because the TO did
   not find them in the list. Left alone, that person's history splits in two
   and the bracket has a ghost in it. */
function ruleDuplicates({ entries, players }) {
  const byKey = new Map();
  const dupes = [];

  for (const entry of entries) {
    const player = players.get(entry.playerId);
    if (!player) continue;
    const keys = [
      player.email && `email:${player.email.toLowerCase()}`,
      player.discordId && `discord:${player.discordId}`,
      /* Tag comparison is normalised hard -- "Kira", "kira" and "K I R A" are
         one person at a local, and sponsor prefixes ("BTY | Kira") are the
         other half of this problem. */
      `tag:${normaliseTag(player.tag)}`,
    ].filter(Boolean);

    for (const key of keys) {
      if (byKey.has(key)) {
        const other = byKey.get(key);
        if (other.playerId !== entry.playerId) {
          dupes.push({ a: other, b: entry, on: key.split(':')[0] });
        }
      } else {
        byKey.set(key, entry);
      }
    }
  }

  if (!dupes.length) return [];
  return [{
    id: 'duplicates',
    level: 'attention',
    title: `${plural(dupes.length, 'possible duplicate entrant', 'possible duplicate entrants')}`,
    why: `${dupes.slice(0, 3).map((d) => `${players.get(d.a.playerId)?.tag} / ${players.get(d.b.playerId)?.tag} (same ${d.on})`).join('; ')}. If they are the same person, merging now keeps their record in one place; merging after the bracket is made is much more annoying.`,
    actions: [
      { id: 'review-duplicates', label: 'Review them', kind: 'filled' },
      { id: 'dismiss', label: 'They are different people', kind: 'text' },
    ],
  }];
}

export function normaliseTag(tag) {
  return String(tag || '')
    /* Strip a sponsor or team prefix: "BTY | Kira", "BTY|Kira", "BTY Kira". */
    .replace(/^[^|]{1,12}\s*\|\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function ruleMissingPlatformIds({ event, entries, players }) {
  if (event.venueType !== 'online') return [];
  const needsPsn = (event.platforms || []).includes('ps5');
  const needsSteam = (event.platforms || []).includes('pc');
  if (!needsPsn && !needsSteam) return [];

  const missing = entries.filter((entry) => {
    const player = players.get(entry.playerId);
    const conn = player?.connections || {};
    if (needsPsn && needsSteam) return !conn.psn && !conn.steam;
    if (needsPsn) return !conn.psn;
    return !conn.steam;
  });
  if (!missing.length) return [];

  return [{
    id: 'missing-platform-ids',
    level: event.status === 'running' ? 'urgent' : 'attention',
    title: `${plural(missing.length, 'entrant has', 'entrants have')} no platform ID`,
    why: 'This is an online event — without a PSN or Steam ID their opponent cannot find them, and the set stalls at the moment it is called rather than before it.',
    actions: [
      { id: 'request-ids', label: 'Ask them for it', kind: 'filled', payload: { scope: 'missing-platform' } },
      { id: 'view-missing-ids', label: 'See who', kind: 'text' },
    ],
  }];
}

function ruleUnsignedDocuments({ event, entries }) {
  const required = (event.documents || []).filter((d) => d.required);
  if (!required.length) return [];
  const unsigned = entries.filter((e) => {
    const signed = new Set(e.signedDocuments || []);
    return required.some((d) => !signed.has(d.id));
  });
  if (!unsigned.length) return [];

  return [{
    id: 'unsigned-documents',
    level: event.status === 'running' ? 'urgent' : 'attention',
    title: `${plural(unsigned.length, 'entrant has', 'entrants have')} not signed everything`,
    why: `${required.map((d) => d.title).join(', ')} ${required.length === 1 ? 'is' : 'are'} marked required. Letting someone play without it is the kind of thing that only matters on the day it matters.`,
    actions: [
      { id: 'chase-signatures', label: 'Send them the link', kind: 'filled', payload: { scope: 'unsigned' } },
      { id: 'view-unsigned', label: 'See who', kind: 'text' },
    ],
  }];
}

function ruleUnpaid({ event, entries }) {
  if (!event.entryFee) return [];
  const unpaid = entries.filter((e) => e.checkedInAt && !e.paidAt);
  if (!unpaid.length) return [];

  return [{
    id: 'unpaid',
    level: 'attention',
    title: `${plural(unpaid.length, 'entrant is', 'entrants are')} checked in but not marked paid`,
    why: `At ${formatMoney(event.entryFee, event.currency)} each that is ${formatMoney(unpaid.length * event.entryFee, event.currency)} outstanding. Easier to collect now than to work out afterwards who owes what.`,
    actions: [
      { id: 'open-payments', label: 'Open the door list', kind: 'filled' },
      { id: 'mark-all-paid', label: 'Mark all paid', kind: 'text' },
    ],
  }];
}

export function formatMoney(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 })
      .format(amount);
  } catch { return `${amount} ${currency}`; }
}

/* ---- lifecycle nudges ---- */

function ruleReadyToStart({ event, entries, bracket }) {
  if (event.status !== 'seeding' || bracket) return [];
  const checkedIn = entries.filter((e) => e.checkedInAt).length;
  if (checkedIn < 2) return [];

  return [{
    id: 'ready-to-start',
    level: 'attention',
    title: `${checkedIn} checked in — ready to make the bracket`,
    why: 'Once it is generated, players can see their first opponent and the queue starts assigning stations.',
    actions: [
      { id: 'preview-bracket', label: 'Preview the seeding first', kind: 'tonal' },
      { id: 'generate-bracket', label: 'Generate the bracket', kind: 'filled' },
    ],
  }];
}

function ruleAlmostDone({ event, bracket, matchState }) {
  if (event.status !== 'running' || !bracket) return [];
  const played = (matchState || []).filter((m) => m.state).length;
  const total = bracket.matches.filter((m) => !m.cancelled).length;
  if (!total || played < total - 3 || played >= total) return [];

  const gf = bracket.matches.find((m) => m.bracket === 'GF' && m.round === 1);
  const resetLive = bracket.matches.some((m) => m.id === 'GF-2' && !m.cancelled);

  return [{
    id: 'almost-done',
    level: 'info',
    title: `${plural(total - played, 'set', 'sets')} left`,
    why: resetLive && gf
      ? 'Grand finals could go to a bracket reset — keep a station and, if you are streaming, the stream free for one more set than you think you need.'
      : 'Worth deciding now where top 3 is being played and whether it is going on stream.',
    actions: [{ id: 'open-run', label: 'Open the run view', kind: 'text' }],
  }];
}

function ruleFinished({ event, bracket, matchState }) {
  if (event.status !== 'running' || !bracket) return [];
  const remaining = bracket.matches.filter((m) => !m.cancelled && !m.state);
  if (remaining.length) return [];

  return [{
    id: 'finished',
    level: 'attention',
    title: 'Every set is reported',
    why: 'Publishing writes the results to every entrant\'s profile and closes the event. Do it before you pack up — it is much harder to reconstruct on Monday.',
    actions: [
      { id: 'publish-results', label: 'Publish the results', kind: 'filled' },
      { id: 'review-standings', label: 'Check the standings first', kind: 'tonal' },
    ],
  }];
}

/* Not about the bracket at all -- about the TO's own account. A Discord-only
   organiser who cannot sign in because Discord is having a bad morning is the
   worst failure this product can have, and it is entirely preventable. */
function ruleOrganiserFallback({ session }) {
  if (!session?.needsPasswordFallback) return [];
  return [{
    id: 'organiser-fallback',
    level: 'attention',
    title: 'Add a password to your account',
    why: 'You sign in with Discord only. If Discord is down, or the venue wifi breaks its login redirect, you would not be able to get into your own bracket. A password takes ten seconds and is the same account.',
    actions: [
      { id: 'add-password', label: 'Set a password', kind: 'filled' },
      { id: 'dismiss', label: 'Not now', kind: 'text' },
    ],
  }];
}

/* --------------------------------------------------------------------------
   Assembly
   -------------------------------------------------------------------------- */

const RULES = [
  ruleDqTimers,
  ruleStalledSets,
  ruleCheckInWindow,
  ruleNoShows,
  ruleMissingPlatformIds,
  ruleUnsignedDocuments,
  ruleDuplicates,
  ruleIdleStations,
  ruleUnseeded,
  ruleSeedCollisions,
  ruleUnpaid,
  ruleReadyToStart,
  ruleFinished,
  ruleAlmostDone,
  ruleRematches,
  ruleOrganiserFallback,
];

const LEVEL_RANK = { urgent: 0, attention: 1, info: 2 };

/* `dismissed` is a set of suggestion ids the TO has waved away for this event.
   Held per event and per device rather than synced: a dismissal is "I have
   seen this", which is a property of a person looking at a screen, not of the
   tournament. Two staff should each get the warning once. */
export function suggestionsFor(context, dismissed = new Set()) {
  const out = [];
  for (const rule of RULES) {
    try {
      for (const suggestion of rule(context) || []) {
        if (dismissed.has(suggestion.id)) continue;
        out.push(suggestion);
      }
    } catch (err) {
      /* One broken rule must never take the panel down -- a TO mid-event needs
         the other fifteen. */
      console.error('[guidance] rule failed', rule.name, err);
    }
  }
  return out.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}

/* A one-line summary for the app bar, so the TO knows there is something to
   look at without opening the panel. */
export function guidanceSummary(suggestions) {
  const urgent = suggestions.filter((s) => s.level === 'urgent').length;
  const attention = suggestions.filter((s) => s.level === 'attention').length;
  if (urgent) return { level: 'urgent', text: `${urgent} need${urgent === 1 ? 's' : ''} you now` };
  if (attention) return { level: 'attention', text: `${attention} to decide` };
  return { level: 'ok', text: 'Nothing waiting' };
}
