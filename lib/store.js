/* Brackets · the store
   ===========================================================================
   Local-first. Every read is synchronous, out of memory. Every write lands in
   memory and in localStorage immediately, and is THEN queued for the server.
   Nothing in the UI ever awaits the network.

   ## Why this shape

   The complaint the project started from was performance, and the reason the
   existing sites feel slow is not that their servers are slow -- it is that
   they are online-first. Every screen is a round trip, so at a venue on a
   congested 2.4GHz access point shared with sixty phones and eight consoles,
   every screen is a spinner. Reporting a set means: tap, wait, wonder, tap
   again, create a duplicate.

   Turning that around is the single highest-leverage decision in this whole
   project. A TO's phone holds the entire event -- it is a few hundred kB of
   JSON -- so there is no reason to ask the network for anything on the hot
   path. The network's job is to make other people's copies agree with yours,
   eventually.

   Concretely:

     * reads are `get()`, synchronous, no promise, no loading state
     * writes are `apply()`, synchronous, and return once local state is updated
     * the queue drains in the background, retries with backoff, and survives a
       reload, a crash and a dead battery
     * the sync chip in the app bar always says exactly how many writes are
       waiting, because an app that silently swallows writes on bad wifi is
       how you get a TO who does not trust it

   ## Storage: localStorage, deliberately

   IndexedDB is the technically correct choice and this uses localStorage
   anyway. An event is small (a 256-entrant major with full match history is
   under 400kB, comfortably inside the 5MB budget), localStorage is
   synchronous -- which is what makes `get()` synchronous without a hydration
   dance -- and it has no upgrade/versioning ceremony to get wrong. When an org
   wants season-long history on device, THAT is when this moves to IndexedDB,
   behind the same interface. `persist()` and `hydrate()` are the only two
   functions that would change.

   ## Conflict resolution

   Last-write-wins per RECORD, with a client timestamp, except for match
   results which are last-write-wins per MATCH and keep the losing write in an
   audit log rather than discarding it.

   That is not the fanciest option and it is the right one here. Genuine
   concurrent edits are rare (two TOs editing the same entrant's name at the
   same second) and genuinely ambiguous when they happen; what is NOT rare is
   two people reporting the same set from two phones, which LWW handles fine
   because they are almost always reporting the same result. The audit log is
   what makes the rare disagreement recoverable -- "station 3 said 2-1 to Rae,
   the bracket says 2-0 to Kira, here are both with timestamps" is a thing a TO
   can settle. Silently dropping one is not.
   =========================================================================== */

'use strict';

import { seedDemoData } from '../data/demo.js';

const LS_STATE = 'battydev.brackets.state.v1';
const LS_QUEUE = 'battydev.brackets.queue.v1';

/* --------------------------------------------------------------------------
   Shape of the world.

   Collections are keyed objects rather than arrays: every write is by id, and
   an array means an indexOf on every one of them. `players` is the collection
   that outlives everything else -- see the README on why identity is not
   scoped to an event.
   -------------------------------------------------------------------------- */
const EMPTY = () => ({
  /* People. Event-agnostic by design: a player row is created once and
     referenced by every entry they ever make, at any org, in any game. */
  players: {},
  /* Organisations — a venue, a store, a Discord. Owns events, has staff. */
  orgs: {},
  events: {},
  /* An entry is a player IN an event. The join row. Carries seed, check-in,
     payment, signed documents -- everything that is true of them at THIS
     event and nowhere else. */
  entries: {},
  /* Generated bracket state, per event. */
  brackets: {},
  /* Every reported result, append-only, including superseded ones. */
  results: {},
  /* Stations at a venue, and what is on them. */
  stations: {},
  /* Signed documents: waivers, codes of conduct, media releases. */
  signatures: {},
  /* Local session: who is signed in on this device. */
  session: null,
  /* Per-device preferences that never sync. */
  device: { theme: 'auto', lastEvent: null },
});

let state = EMPTY();
let queue = [];
const listeners = new Set();

/* --------------------------------------------------------------------------
   Persistence
   -------------------------------------------------------------------------- */

let persistTimer = null;

/* Debounced because a bulk edit of 200 entrants is 200 applies in a tick and
   serialising the whole state 200 times would be the one thing in this app
   that actually janked. 120ms is under the threshold where a reload could lose
   a write a human made deliberately, and above the cost of a burst. */
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify(state));
      localStorage.setItem(LS_QUEUE, JSON.stringify(queue));
    } catch (err) {
      /* QuotaExceededError, or Safari private mode where localStorage throws
         on write. Neither should take the app down -- the in-memory state is
         still correct and the queue still drains. What it must NOT do is fail
         silently forever, so it surfaces once. */
      console.warn('[brackets] could not persist locally', err);
      notify({ type: 'storage-error', error: err });
    }
  }, 120);
}

function hydrate() {
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (raw) state = { ...EMPTY(), ...JSON.parse(raw) };
    const q = localStorage.getItem(LS_QUEUE);
    if (q) queue = JSON.parse(q);
  } catch (err) {
    /* A corrupt blob must not brick the app. Start clean and say so -- the
       server copy is authoritative anyway once we reconnect. */
    console.warn('[brackets] local state was unreadable, starting fresh', err);
    state = EMPTY();
    queue = [];
  }
}

/* --------------------------------------------------------------------------
   Subscriptions
   -------------------------------------------------------------------------- */

function notify(event) {
  for (const fn of listeners) {
    try { fn(state, event); } catch (err) { console.error('[brackets] listener threw', err); }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* --------------------------------------------------------------------------
   Reads
   -------------------------------------------------------------------------- */

export const get = () => state;

/* --------------------------------------------------------------------------
   The session
   --------------------------------------------------------------------------
   Its own pair of accessors rather than going through `apply`, because it is
   not a collection: there is exactly one, and it is keyed by nothing.

   Routing it through `apply('session', 'session', …)` was the original
   shortcut and it was quietly broken. `apply` writes `state[collection][id]`,
   so the session landed at `state.session.session` while every reader asked
   for `state.session` -- getting the wrapper object instead of the session.
   In memory nothing noticed, because auth.js also keeps its own copy; the
   damage showed up only after a reload, when the copy was rebuilt from
   storage and `session.playerId` was undefined. Signing out was worse: it
   deleted the inner key and left `{}` behind, which is truthy, so a
   signed-out visitor read as signed in.

   A session is also never queued for the server -- it is a property of this
   browser, and the server has its own idea of who is authenticated. */
export const getSession = () => state.session || null;

export function setSession(next) {
  state.session = next || null;
  persist();
  notify({ type: 'session' });
  return state.session;
}
export const getPlayer = (id) => state.players[id] || null;
export const getEvent = (id) => state.events[id] || null;
export const getOrg = (id) => state.orgs[id] || null;

export const listEvents = () => Object.values(state.events)
  .sort((a, b) => (b.startsAt || '').localeCompare(a.startsAt || ''));

export const entriesFor = (eventId) => Object.values(state.entries)
  .filter((e) => e.eventId === eventId)
  .sort((a, b) => (a.seed || 9999) - (b.seed || 9999));

export const entryFor = (eventId, playerId) => Object.values(state.entries)
  .find((e) => e.eventId === eventId && e.playerId === playerId) || null;

export const stationsFor = (eventId) => Object.values(state.stations)
  .filter((s) => s.eventId === eventId)
  .sort((a, b) => a.number - b.number);

export const eventByInvite = (code) => Object.values(state.events)
  .find((e) => (e.inviteCode || '').toUpperCase() === String(code || '').toUpperCase()) || null;

/* Every set a player has ever played, across every event and every game.
   This is the query the whole "players exist outside events" idea exists to
   make possible, and it is one pass over results because a result stores the
   player ids directly rather than only the entry ids. Storing both is
   denormalisation, and it is worth it: without it this query needs a join
   through entries and cannot run offline against a partial cache. */
export function historyFor(playerId) {
  return Object.values(state.results)
    .filter((r) => !r.superseded && (r.winnerPlayerId === playerId || r.loserPlayerId === playerId))
    .sort((a, b) => (b.reportedAt || '').localeCompare(a.reportedAt || ''));
}

/* Head-to-head. The single most requested thing on a player profile and the
   thing no bracket site surfaces well -- "have I played this person before,
   and what happened" is the question every player asks when they see a name
   in their bracket. */
export function headToHead(playerId, opponentId) {
  const sets = historyFor(playerId).filter((r) => r.winnerPlayerId === opponentId || r.loserPlayerId === opponentId);
  const wins = sets.filter((r) => r.winnerPlayerId === playerId).length;
  return { sets, wins, losses: sets.length - wins };
}

/* --------------------------------------------------------------------------
   Writes
   --------------------------------------------------------------------------
   Everything goes through `apply`. One entry point means one place that
   stamps timestamps, one place that queues, one place that persists, and one
   place to put an audit hook when this grows one.
   -------------------------------------------------------------------------- */

export function uid(prefix = 'id') {
  /* crypto.randomUUID is not available on http:// origins in some browsers,
     and this page is opened from a file:// path during development. Falling
     back rather than crashing at import time. */
  const rand = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

/* A short, human-sayable invite code. No 0/O/1/I/L -- a TO reads these out
   over a PA and writes them on a whiteboard, and every ambiguous glyph is a
   support request. */
export function inviteCode(length = 6) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/* collection: which map. id: the record. patch: fields to merge, or null to
   delete. Returns the resulting record. */
export function apply(collection, id, patch, { queueIt = true, silent = false } = {}) {
  if (!state[collection]) state[collection] = {};
  const now = new Date().toISOString();

  if (patch === null) {
    delete state[collection][id];
  } else {
    const before = state[collection][id] || { id, createdAt: now };
    state[collection][id] = { ...before, ...patch, id, updatedAt: now };
  }

  if (queueIt) {
    queue.push({
      op: uid('op'), collection, id,
      patch: patch === null ? null : { ...patch },
      at: now,
      /* Which device made this. Used to skip echoing our own writes back at
         ourselves when realtime is on. */
      device: deviceId(),
      tries: 0,
    });
  }

  persist();
  if (!silent) notify({ type: 'change', collection, id });
  return patch === null ? null : state[collection][id];
}

/* Several writes as one unit. The bulk editor uses this: 200 entrants renamed
   is ONE notify and ONE persist rather than 200 of each, which is the
   difference between instant and a visible freeze on a phone. */
export function applyMany(writes) {
  for (const w of writes) apply(w.collection, w.id, w.patch, { silent: true });
  notify({ type: 'bulk', count: writes.length });
}

/* Local device identity. Not an auth credential -- it only exists so the sync
   loop can tell its own echoes apart and so an audit row can say "reported
   from the station tablet" rather than just "reported". */
function deviceId() {
  let id = localStorage.getItem('battydev.brackets.device');
  if (!id) {
    id = uid('dev');
    try { localStorage.setItem('battydev.brackets.device', id); } catch { /* private mode */ }
  }
  return id;
}

/* --------------------------------------------------------------------------
   Undo
   --------------------------------------------------------------------------
   A bounded stack of inverse patches. The bulk editor is the reason this
   exists: "update all 180 entrants from this CSV" is exactly the operation a
   TO will get wrong once, and an import tool without an undo is a tool nobody
   dares use twice.

   The stack holds the PREVIOUS value of every record a step touched, so undo
   is just applyMany of those. Bounded at 20 because this is in localStorage
   and an unbounded history of a 200-row import would fill it.
   -------------------------------------------------------------------------- */
const undoStack = [];

export function checkpoint(label, ids) {
  const snapshot = ids.map(({ collection, id }) => ({
    collection, id,
    patch: state[collection]?.[id] ? { ...state[collection][id] } : null,
  }));
  undoStack.push({ label, snapshot, at: new Date().toISOString() });
  if (undoStack.length > 20) undoStack.shift();
}

export const canUndo = () => undoStack.length > 0;
export const undoLabel = () => undoStack.at(-1)?.label || null;

export function undo() {
  const step = undoStack.pop();
  if (!step) return null;
  /* A record that did not exist before is deleted rather than restored to an
     empty object -- otherwise undoing an import leaves 180 blank rows. */
  applyMany(step.snapshot.map((s) => ({ ...s, patch: s.patch })));
  for (const s of step.snapshot) {
    if (s.patch === null) apply(s.collection, s.id, null, { silent: true });
  }
  notify({ type: 'undo', label: step.label });
  return step.label;
}

/* --------------------------------------------------------------------------
   Sync
   --------------------------------------------------------------------------
   The queue drains oldest-first against Supabase. If the site is unconfigured
   -- which is how it runs as a demo, and how it runs on a laptop with no
   backend -- the queue simply never drains and everything stays local. That is
   a legitimate mode, not a degraded one: a TO running a 16-person weekly on
   one phone genuinely does not need a server, and telling them so is more
   honest than making them sign up for one.
   -------------------------------------------------------------------------- */

let client = null;
let syncing = false;
let backoff = 0;
let online = navigator.onLine;

export const syncState = () => ({
  configured: Boolean(client),
  online,
  pending: queue.length,
  syncing,
});

export function attach(supabaseClient) {
  client = supabaseClient;
  drain();
}

/* Table name for a collection. The DB prefixes everything `bkt_` because the
   Supabase project is shared with /fcevents and /health -- see sql/001_schema.sql. */
const TABLE = {
  players: 'bkt_players', orgs: 'bkt_orgs', events: 'bkt_events',
  entries: 'bkt_entries', brackets: 'bkt_brackets', results: 'bkt_results',
  stations: 'bkt_stations', signatures: 'bkt_signatures',
};

/* --------------------------------------------------------------------------
   Field naming across the wire
   --------------------------------------------------------------------------
   In here everything is camelCase, because it is JavaScript. In Postgres
   everything is snake_case, because it is SQL and an unquoted mixed-case
   identifier is folded to lowercase anyway.

   Converting at the boundary is the only place the two can meet without one of
   them being wrong everywhere else. Mechanical for almost every field, with a
   short table of exceptions for the ones where the two names genuinely differ
   -- `group` and `grouping` are both reserved words in Postgres, so the column
   is `crew`, and pretending otherwise here would just move the breakage. */
const FIELD_ALIASES = {
  group: 'crew',
  avatarUrl: 'avatar_url',
};
const FIELD_ALIASES_BACK = Object.fromEntries(
  Object.entries(FIELD_ALIASES).map(([k, v]) => [v, k]));

const toSnake = (key) => FIELD_ALIASES[key]
  || key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (key) => FIELD_ALIASES_BACK[key]
  || key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/* Only the top level is converted. Values that are themselves documents --
   a bracket's `matches`, a player's `connections`, an event's `overrides` --
   are stored as jsonb and must round-trip byte for byte, so touching their
   keys would corrupt them. */
function rowFor(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('_')) continue;
    out[toSnake(key)] = value;
  }
  return out;
}

function recordFor(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) out[toCamel(key)] = value;
  return out;
}

export async function drain() {
  if (syncing || !client || !online || !queue.length) return;
  syncing = true;
  notify({ type: 'sync', phase: 'start' });

  while (queue.length) {
    const op = queue[0];
    const table = TABLE[op.collection];
    if (!table) { queue.shift(); continue; }

    try {
      if (op.patch === null) {
        await client.from(table).delete().eq('id', op.id);
      } else {
        /* Upsert rather than update: the row may not exist server-side yet if
           it was created offline, and two round trips to find out is exactly
           the latency this design exists to avoid. */
        await client.from(table).upsert({ ...rowFor(op.patch), id: op.id, updated_at: op.at });
      }
      queue.shift();
      backoff = 0;
      persist();
    } catch (err) {
      op.tries += 1;
      /* A write that has failed ten times is not going to succeed on the
         eleventh and is blocking everything behind it. Park it so the rest of
         the queue drains, and surface it -- a stuck write the TO cannot see is
         worse than one they can. */
      if (op.tries > 10) {
        queue.shift();
        notify({ type: 'sync-dropped', op, error: err });
      }
      backoff = Math.min(30000, (backoff || 500) * 2);
      syncing = false;
      notify({ type: 'sync', phase: 'error', error: err });
      setTimeout(drain, backoff);
      return;
    }
  }

  syncing = false;
  notify({ type: 'sync', phase: 'done' });
}

/* Pull everything this account can see. Called once at boot and after a
   reconnect. Server rows win over local ones ONLY where the local row has no
   pending write in the queue -- otherwise a slow sync would clobber the edit
   the TO made twenty seconds ago. */
export async function pull() {
  if (!client) return;
  const pendingIds = new Set(queue.map((op) => `${op.collection}:${op.id}`));

  for (const [collection, table] of Object.entries(TABLE)) {
    try {
      const { data, error } = await client.from(table).select('*');
      if (error || !data) continue;
      for (const row of data) {
        if (pendingIds.has(`${collection}:${row.id}`)) continue;
        state[collection][row.id] = recordFor(row);
      }
    } catch (err) {
      console.warn(`[brackets] could not pull ${table}`, err);
    }
  }
  persist();
  notify({ type: 'pull' });
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

/* Seed the demo tournament, once, and never over real data. Someone who has
   run an actual event on this device must not have it filled with fictional
   players because they opened the page while the backend was down.

   Separate from `boot` so it can also be called AFTER auth resolves, which is
   when a live deployment knows whether this visitor is a signed-out guest --
   the audience the demo exists for. Idempotent, so calling it twice is free.

   Every write inside carries `queueIt: false`, so no demo row ever enters the
   sync queue. The demo lives in this browser and nowhere else. */
export function seedDemo() {
  if (Object.keys(state.events).length || Object.keys(state.players).length) return false;
  seedDemoData({ apply, uid, inviteCode, setSession });
  persist();
  notify({ type: 'seed' });
  return true;
}

export function boot({ demo = false } = {}) {
  hydrate();

  if (demo) seedDemo();

  window.addEventListener('online', () => { online = true; notify({ type: 'net' }); drain(); });
  window.addEventListener('offline', () => { online = false; notify({ type: 'net' }); });

  /* Another tab of the same app made a write. Re-hydrating rather than
     merging is fine because both tabs share one localStorage -- the other tab
     has already written the merged truth. A TO with the bracket on a laptop
     and the queue on a phone is the multi-DEVICE case, and that is what the
     server sync is for. */
  window.addEventListener('storage', (e) => {
    if (e.key !== LS_STATE) return;
    hydrate();
    notify({ type: 'external' });
  });

  return state;
}

/* Wipe. Behind a confirm in the UI. Exists because the demo data has to be
   removable without clearing the browser's site data, and because a shared
   station tablet needs a "hand this to the next event" button. */
export function reset() {
  state = EMPTY();
  queue = [];
  try {
    localStorage.removeItem(LS_STATE);
    localStorage.removeItem(LS_QUEUE);
  } catch { /* private mode */ }
  notify({ type: 'reset' });
}

/* Export everything as JSON. Data portability is a feature, not a courtesy:
   the reason nobody moves off start.gg is that their history is stuck there,
   and a new site that recreates that lock-in deserves to lose for the same
   reason. See the README on imports. */
export function exportAll() {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    version: 1,
    ...state,
    session: null,
    device: undefined,
  }, null, 2);
}
