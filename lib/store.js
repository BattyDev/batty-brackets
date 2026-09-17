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

const BASE_KEYS = {
  state: 'battydev.brackets.state.v1',
  queue: 'battydev.brackets.queue.v1',
  snapshot: 'battydev.brackets.snapshot.v2',
  snapshotBackup: 'battydev.brackets.snapshot.backup.v2',
  device: 'battydev.brackets.device',
};
const STORAGE_VERSION = 2;

/* Connected data is never hydrated from the device-only keys. A project URL
   and the Supabase auth account form the cache namespace; anonymous public
   data has its own namespace. The fingerprint is intentionally non-secret --
   it is only a compact storage-key suffix, not an access credential. */
let activeScope = { projectUrl: null, accountId: null };
let activeKeys = { ...BASE_KEYS };

function scopeFingerprint(projectUrl, accountId) {
  const project = String(projectUrl).replace(/\/+$/, '').replace(/^https?:\/\//, '');
  const account = String(accountId || 'anonymous');
  return encodeURIComponent(`${project}__${account}`);
}

function keysForScope(projectUrl, accountId) {
  if (!projectUrl) return { ...BASE_KEYS };
  const suffix = scopeFingerprint(projectUrl, accountId);
  return Object.fromEntries(Object.entries(BASE_KEYS).map(([name, key]) => [name, `${key}.${suffix}`]));
}

function selectScope(projectUrl = null, accountId = null) {
  activeScope = projectUrl
    ? { projectUrl: String(projectUrl).replace(/\/+$/, ''), accountId: String(accountId || 'anonymous') }
    : { projectUrl: null, accountId: null };
  activeKeys = keysForScope(activeScope.projectUrl, activeScope.accountId);
}

export const storageScope = () => ({ ...activeScope });
export const storageKeyForScope = (projectUrl, accountId, name = 'state') => {
  const key = keysForScope(projectUrl, accountId)[name];
  if (!key) throw new Error(`Unknown Brackets storage key: ${name}`);
  return key;
};

/* The old pair of keys remains as a compatibility mirror. Existing installs
   and a few integrations read the state key directly, but it is no longer the
   recovery source of truth: the envelope below keeps state and queue together
   so a quota failure or interrupted write cannot silently mix generations. */
const COLLECTIONS = [
  'players', 'orgs', 'events', 'entries', 'brackets', 'results',
  'stations', 'signatures',
];

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

const storage = {
  available: true,
  error: null,
  warning: null,
  recovered: false,
  source: 'memory',
  lastSavedAt: null,
};

let persistBatchDepth = 0;
let persistNeeded = false;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isStringOrNull = (value) => value === null || typeof value === 'string';

function validStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validPointer(value) {
  return value === null || (isRecord(value)
    && typeof value.match === 'string'
    && Number.isInteger(value.slot) && value.slot >= 0 && value.slot < 2);
}

function validSlot(slot) {
  if (!isRecord(slot) || !['seed', 'from'].includes(slot.kind)) return false;
  if (!isStringOrNull(slot.entrantId)) return false;
  if (slot.bye !== undefined && typeof slot.bye !== 'boolean') return false;
  if (slot.kind === 'seed') return Number.isInteger(slot.seed) && slot.seed > 0;
  return isStringOrNull(slot.from) && ['winner', 'loser'].includes(slot.take);
}

function validMatch(match) {
  if (!isRecord(match) || typeof match.id !== 'string' || !match.id) return false;
  if (!['W', 'L', 'GF'].includes(match.bracket)) return false;
  if (!Number.isInteger(match.round) || match.round < 1) return false;
  if (!Number.isInteger(match.index) || match.index < 0) return false;
  if (typeof match.name !== 'string' || !Array.isArray(match.slots) || match.slots.length !== 2) return false;
  if (!match.slots.every(validSlot) || !validPointer(match.winnerTo) || !validPointer(match.loserTo)) return false;
  if (match.conditional !== undefined && typeof match.conditional !== 'boolean') return false;
  if (match.cancelled !== undefined && typeof match.cancelled !== 'boolean') return false;
  if (match.state !== undefined && typeof match.state !== 'string') return false;
  for (const key of ['winnerId', 'loserId', 'calledAt', 'reportedAt', 'stationId']) {
    if (match[key] !== undefined && !isStringOrNull(match[key])) return false;
  }
  if (match.score !== undefined) {
    if (!isRecord(match.score) || !isFiniteNumber(match.score.a) || !isFiniteNumber(match.score.b)) return false;
  }
  return true;
}

function validDocument(document) {
  return isRecord(document)
    && typeof document.id === 'string'
    && (document.title === undefined || typeof document.title === 'string')
    && (document.required === undefined || typeof document.required === 'boolean')
    && (document.version === undefined || Number.isInteger(document.version));
}

function validRow(collection, row) {
  if (!isRecord(row) || typeof row.id !== 'string' || !row.id) return false;
  if (row.createdAt !== undefined && !isStringOrNull(row.createdAt)) return false;
  if (row.updatedAt !== undefined && !isStringOrNull(row.updatedAt)) return false;

  switch (collection) {
    case 'players':
      return (row.tag === undefined || typeof row.tag === 'string')
        && (row.connections === undefined || isRecord(row.connections))
        && (row.mains === undefined || isRecord(row.mains))
        && (row.methods === undefined || validStringArray(row.methods));
    case 'orgs':
      return row.name === undefined || typeof row.name === 'string';
    case 'events':
      return (row.orgId === undefined || isStringOrNull(row.orgId))
        && (row.ownerId === undefined || isStringOrNull(row.ownerId))
        && (row.name === undefined || typeof row.name === 'string')
        && (row.gameId === undefined || typeof row.gameId === 'string')
        && (row.format === undefined || typeof row.format === 'string')
        && (row.status === undefined || typeof row.status === 'string')
        && (row.platforms === undefined || validStringArray(row.platforms))
        && (row.documents === undefined || (Array.isArray(row.documents) && row.documents.every(validDocument)))
        && (row.overrides === undefined || isRecord(row.overrides));
    case 'entries':
      return typeof row.eventId === 'string'
        && typeof row.playerId === 'string'
        && (row.seed === undefined || row.seed === null || Number.isInteger(row.seed))
        && (row.signedDocuments === undefined || validStringArray(row.signedDocuments))
        && (row.checkedInAt === undefined || isStringOrNull(row.checkedInAt))
        && (row.paidAt === undefined || isStringOrNull(row.paidAt))
        && (row.waitlisted === undefined || typeof row.waitlisted === 'boolean');
    case 'brackets': {
      if (typeof row.eventId !== 'string' || !['single', 'double'].includes(row.type)) return false;
      if (!Number.isInteger(row.size) || row.size < 2 || (row.size & (row.size - 1)) !== 0) return false;
      if (!Number.isInteger(row.rounds) || row.rounds < 1 || !Array.isArray(row.matches) || !row.matches.length) return false;
      if (row.losersRounds !== undefined && (!Number.isInteger(row.losersRounds) || row.losersRounds < 1)) return false;
      const ids = new Set();
      return row.matches.every((match) => {
        if (!validMatch(match) || ids.has(match.id)) return false;
        ids.add(match.id);
        return true;
      });
    }
    case 'results':
      return isStringOrNull(row.eventId)
        && isStringOrNull(row.matchId)
        && typeof row.winnerPlayerId === 'string'
        && typeof row.loserPlayerId === 'string'
        && isFiniteNumber(row.scoreWinner)
        && isFiniteNumber(row.scoreLoser)
        && typeof row.reportedAt === 'string'
        && (row.superseded === undefined || typeof row.superseded === 'boolean');
    case 'stations':
      return typeof row.eventId === 'string'
        && (row.number === undefined || isFiniteNumber(row.number))
        && (row.label === undefined || typeof row.label === 'string')
        && (row.matchId === undefined || isStringOrNull(row.matchId));
    case 'signatures':
      return typeof row.entryId === 'string'
        && typeof row.eventId === 'string'
        && typeof row.playerId === 'string'
        && typeof row.documentId === 'string'
        && (row.documentVersion === undefined || Number.isInteger(row.documentVersion))
        && typeof row.typedName === 'string'
        && typeof row.signedAt === 'string';
    default:
      return false;
  }
}

function validRowMap(collection, rows) {
  if (!isRecord(rows)) return false;
  return Object.entries(rows).every(([id, row]) => validRow(collection, row) && row.id === id);
}

const PRIVATE_KEY = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|authorization|cookie|session)$/i;

function containsCredential(value) {
  if (Array.isArray(value)) return value.some(containsCredential);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    ((PRIVATE_KEY.test(key) && nested !== null && nested !== undefined) || containsCredential(nested)));
}

function safeCopy(value) {
  if (Array.isArray(value)) return value.map(safeCopy);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_KEY.test(key))
    .map(([key, nested]) => [key, safeCopy(nested)]));
}

function storageMessage(err) {
  if (err?.name === 'QuotaExceededError') {
    return 'The browser storage limit was reached. Your latest change is only in memory; download a backup and free some site storage.';
  }
  return 'The browser could not save this change on the device. Download a backup before leaving this page.';
}

function readStorage(key) {
  try {
    return { value: localStorage.getItem(key), error: null };
  } catch (error) {
    storage.available = false;
    return { value: null, error };
  }
}

function parseStorage(raw) {
  if (raw === null) return { value: null, error: null };
  try { return { value: JSON.parse(raw), error: null }; }
  catch (error) { return { value: null, error }; }
}

function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normaliseState(input) {
  if (!isRecord(input)) return null;
  const next = EMPTY();
  for (const collection of COLLECTIONS) {
    if (input[collection] !== undefined && !validRowMap(collection, input[collection])) return null;
    next[collection] = { ...next[collection], ...(input[collection] || {}) };
  }
  if (input.session !== undefined && input.session !== null && !isRecord(input.session)) return null;
  if (input.device !== undefined && input.device !== null && !isRecord(input.device)) return null;
  next.session = input.session || null;
  next.device = { ...next.device, ...(input.device || {}) };
  return next;
}

function normaliseQueue(input) {
  if (!Array.isArray(input)) return null;
  const allowed = new Set(COLLECTIONS);
  const out = [];
  for (const item of input) {
    if (!isRecord(item) || typeof item.op !== 'string' || !item.op
        || typeof item.id !== 'string' || !item.id || !allowed.has(item.collection)) return null;
    if (item.patch !== null && !isRecord(item.patch)) return null;
    if (item.requiresReview !== undefined && typeof item.requiresReview !== 'boolean') return null;
    if (item.patch !== null && containsCredential(item.patch)) return null;
    if (item.at !== undefined && typeof item.at !== 'string') return null;
    if (item.device !== undefined && item.device !== null && typeof item.device !== 'string') return null;
    if (item.tries !== undefined && (!isFiniteNumber(item.tries) || item.tries < 0)) return null;
    if (item.blocked !== undefined && typeof item.blocked !== 'boolean') return null;
    if (item.lastError !== undefined && typeof item.lastError !== 'string') return null;
    if (item.failedAt !== undefined && typeof item.failedAt !== 'string') return null;
    out.push({
      op: item.op,
      collection: item.collection,
      id: item.id,
      patch: item.patch === null ? null : { ...item.patch },
      at: typeof item.at === 'string' ? item.at : new Date().toISOString(),
      device: typeof item.device === 'string' ? item.device : null,
      tries: Number.isFinite(Number(item.tries)) ? Math.max(0, Number(item.tries)) : 0,
      blocked: Boolean(item.blocked),
      requiresReview: Boolean(item.requiresReview),
      ...(item.lastError ? { lastError: String(item.lastError) } : {}),
      ...(item.failedAt ? { failedAt: String(item.failedAt) } : {}),
    });
  }
  return out;
}

function snapshotFrom(input) {
  if (!isRecord(input) || input.version !== STORAGE_VERSION || !isRecord(input.state)
      || !COLLECTIONS.every((collection) => Object.prototype.hasOwnProperty.call(input.state, collection))) return null;
  const nextState = normaliseState(input.state);
  const nextQueue = normaliseQueue(input.queue);
  if (!nextState || !nextQueue) return null;
  return {
    state: nextState,
    queue: nextQueue,
    savedAt: typeof input.savedAt === 'string' ? input.savedAt : null,
  };
}

function sameJson(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

function setStorageIssue(error, { warning = false, notifyIssue = true } = {}) {
  const message = typeof error === 'string' ? error : storageMessage(error);
  const key = warning ? 'warning' : 'error';
  if (storage[key] === message) return;
  storage[key] = message;
  if (notifyIssue) {
    console.warn(`[brackets] ${message}`, error);
    notify({ type: warning ? 'storage-warning' : 'storage-error', error, message });
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    storage.available = true;
    return null;
  } catch (error) {
    return error;
  }
}

/* One synchronous commit for each user action. Bulk operations and demo
   seeding enter a short batch, so they still serialize the whole event once,
   but a reload or a dead battery cannot strand the last 120ms of edits in a
   timer that never fired. The single envelope is the recovery copy; the two
   old keys are mirrors for older tabs and test fixtures. */
function persistNow() {
  const savedAt = new Date().toISOString();
  const envelope = { version: STORAGE_VERSION, savedAt, state, queue };
  const snapshotRaw = JSON.stringify(envelope);
  const stateRaw = JSON.stringify(state);
  const queueRaw = JSON.stringify(queue);
  const errors = [];

  const previous = readStorage(activeKeys.snapshot);
  if (previous.error) errors.push(previous.error);
  else if (previous.value) {
    const error = writeStorage(activeKeys.snapshotBackup, previous.value);
    if (error) errors.push(error);
  }

  /* Commit the combined copy first. If it cannot fit, do not update either
     compatibility mirror: leaving the previous generation in every durable
     key is safer than writing a new state next to an old queue. */
  const snapshotError = writeStorage(activeKeys.snapshot, snapshotRaw);
  if (snapshotError) {
    setStorageIssue(snapshotError);
    return false;
  }

  for (const [key, value] of [[activeKeys.state, stateRaw], [activeKeys.queue, queueRaw]]) {
    const error = writeStorage(key, value);
    if (error) errors.push(error);
  }

  const durable = true;
  if (durable) {
    storage.lastSavedAt = savedAt;
    storage.recovered = false;
    storage.source = 'device';
  }
  if (errors.length) {
    setStorageIssue('The local save completed, but a compatibility mirror or recovery copy could not be updated. Download a fresh backup and free some site storage.', { warning: false });
  } else {
    storage.error = null;
    storage.warning = null;
  }
  return durable;
}

function requestPersist() {
  if (persistBatchDepth) {
    persistNeeded = true;
    return true;
  }
  return persistNow();
}

function withPersistBatch(fn) {
  persistBatchDepth += 1;
  try { return fn(); }
  finally {
    persistBatchDepth -= 1;
    if (!persistBatchDepth && persistNeeded) {
      persistNeeded = false;
      persistNow();
    }
  }
}

function hydrate() {
  const storedState = readStorage(activeKeys.state);
  const storedQueue = readStorage(activeKeys.queue);
  const storedSnapshot = readStorage(activeKeys.snapshot);
  const storedBackup = readStorage(activeKeys.snapshotBackup);
  const stateJson = parseStorage(storedState.value);
  const queueJson = parseStorage(storedQueue.value);
  const snapshotJson = parseStorage(storedSnapshot.value);
  const backupJson = parseStorage(storedBackup.value);
  const legacyState = normaliseState(stateJson.value);
  const legacyQueue = normaliseQueue(queueJson.value);
  const snapshot = snapshotFrom(snapshotJson.value);
  const backup = snapshotFrom(backupJson.value);

  if (legacyState && legacyQueue && snapshot
      && (sameJson(legacyState, snapshot.state) && sameJson(legacyQueue, snapshot.queue))) {
    state = legacyState;
    queue = legacyQueue;
    storage.source = 'device';
    storage.lastSavedAt = snapshot.savedAt;
    return;
  }

  if (snapshot) {
    state = snapshot.state;
    queue = snapshot.queue;
    storage.source = 'snapshot';
    storage.lastSavedAt = snapshot.savedAt;
    if (stateJson.error || queueJson.error || !legacyState || !legacyQueue) {
      setStorageIssue('The legacy local save was unreadable; the combined device snapshot was used.', { warning: true, notifyIssue: false });
    }
    return;
  }

  if (backup) {
    state = backup.state;
    queue = backup.queue;
    storage.source = 'backup';
    storage.recovered = true;
    storage.lastSavedAt = backup.savedAt;
    setStorageIssue('The primary local save was unreadable; a recovery copy was restored. Download a fresh backup.', { warning: true, notifyIssue: false });
    return;
  }

  if (legacyState || legacyQueue) {
    state = legacyState || EMPTY();
    queue = legacyQueue || [];
    storage.source = 'legacy';
    if (stateJson.error || queueJson.error || snapshotJson.error) {
      setStorageIssue('Part of the local save was unreadable; the readable data was opened. Download a backup now.', { warning: true, notifyIssue: false });
    }
    return;
  }

  state = EMPTY();
  queue = [];
  storage.source = 'empty';
  if (stateJson.error || queueJson.error || snapshotJson.error || backupJson.error) {
    setStorageIssue('Local data was unreadable, so the app started with an empty in-memory copy. Download a backup before entering more data.', { warning: true, notifyIssue: false });
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
  requestPersist();
  notify({ type: 'session' });
  return state.session;
}
export const getPlayer = (id) => state.players[id] || null;
export const getEvent = (id) => state.events[id] || null;
export const getOrg = (id) => state.orgs[id] || null;

/* Every event, newest first.
   --------------------------------------------------------------------------
   `listEvents` is the BROWSING query, so it hides unlisted events by default:
   an unlisted event is one you are meant to reach with a code or a link, and
   a listing is the one place it must not turn up. Anything that already has
   the id -- the event page, the join-by-code path, a TO's own dashboard --
   goes through `getEvent` or `eventByInvite` and is unaffected.

   `{ all: true }` is for the organiser's own view, where hiding their own
   event from them would be absurd.

   Worth being precise about what this is: unlisted is DISCOVERABILITY, not
   access control. Locally there is nothing to enforce -- the whole store is
   on the device. Against a backend the schema does enforce it (see the read
   policy on bkt_events in sql/001_schema.sql), but anyone holding the link
   can still open it and pass it on. It hides the event from browsing; it does
   not lock it. The UI says so in those words rather than implying secrecy. */
export const listEvents = ({ all = false } = {}) => Object.values(state.events)
  .filter((e) => all || e.visibility !== 'unlisted')
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
  if (remoteBackend) return serverUid();
  const rand = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

/* Connected creation is the one place a client must mint an identifier that
   PostgreSQL can accept. Local/demo records keep their readable prefixed IDs;
   this helper is never used by local creation paths. */
export function serverUid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
  const previous = state[collection][id] || null;

  if (patch === null) {
    delete state[collection][id];
  } else {
    const before = state[collection][id] || { id, createdAt: now };
    state[collection][id] = { ...before, ...patch, id, updatedAt: now };
  }

  if (queueIt && remoteBackend) {
    const eventIds = eventIdsForWrite(collection, id, patch, previous);
    if (eventIds.length) eventIds.forEach(queueRemoteSave);
    else {
      localOnlyWrites += 1;
      lastServerError = 'That connected change is not part of an event and was kept on this device only.';
    }
  } else if (queueIt) {
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

  requestPersist();
  if (!silent) notify({ type: 'change', collection, id });
  return patch === null ? null : state[collection][id];
}

/* Several writes as one unit. The bulk editor uses this: 200 entrants renamed
   is ONE notify and ONE persist rather than 200 of each, which is the
   difference between instant and a visible freeze on a phone. */
export function applyMany(writes) {
  withPersistBatch(() => {
    for (const w of writes) apply(w.collection, w.id, w.patch, { silent: true });
  });
  notify({ type: 'bulk', count: writes.length });
}

/* Local device identity. Not an auth credential -- it only exists so the sync
   loop can tell its own echoes apart and so an audit row can say "reported
   from the station tablet" rather than just "reported". */
function deviceId() {
  const stored = readStorage(activeKeys.device);
  let id = stored.value;
  if (!id) {
    id = uid('dev');
    const error = writeStorage(activeKeys.device, id);
    if (error) setStorageIssue(error);
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

/* `legacyClient` exists only for the old recovery test/compatibility path.
   Production connected mode uses `remoteBackend` below and never calls
   Supabase table methods. */
let legacyClient = null;
let remoteBackend = null;
let syncing = false;
let backoff = 0;
let online = navigator.onLine;
let lastServerSyncAt = null;
let lastServerError = null;
let localOnlyWrites = 0;
let lifecycleBound = false;
let remotePending = 0;
let remoteFlushQueued = false;
const remoteRevisions = new Map();
const remoteDirtyEvents = new Set();
const remoteSaveChains = new Map();

function eventIdsForWrite(collection, id, patch, previous) {
  if (collection === 'events') return patch === null ? [] : [id];
  if (collection === 'brackets') return [patch?.eventId || previous?.eventId || id].filter(Boolean);
  if (['entries', 'stations', 'results'].includes(collection)) {
    return [patch?.eventId || previous?.eventId].filter(Boolean);
  }
  if (collection === 'players') {
    return [...new Set(Object.values(state.entries)
      .filter((entry) => entry.playerId === id).map((entry) => entry.eventId))];
  }
  return [];
}

function connectedEventState(eventId) {
  const event = state.events[eventId];
  if (!event) throw new Error('Connected events cannot be deleted from this release.');
  const entries = Object.values(state.entries).filter((row) => row.eventId === eventId);
  const playerIds = new Set(entries.map((row) => row.playerId));
  return {
    event: structuredClone(event),
    entries: structuredClone(entries),
    players: structuredClone(Object.values(state.players).filter((row) => playerIds.has(row.id))),
    stations: structuredClone(Object.values(state.stations).filter((row) => row.eventId === eventId)),
    bracket: state.brackets[eventId] ? structuredClone(state.brackets[eventId]) : null,
    results: structuredClone(Object.values(state.results).filter((row) => row.eventId === eventId)),
  };
}

async function saveRemoteEvent(eventId) {
  const revision = remoteRevisions.get(eventId);
  if (!Number.isSafeInteger(revision)) {
    throw new Error('Refresh this event before changing organizer controls.');
  }
  remotePending += 1;
  syncing = true;
  notify({ type: 'sync', phase: 'start', eventId });
  try {
    const result = await remoteBackend.saveEventState(eventId, revision, connectedEventState(eventId));
    if (!Number.isSafeInteger(result.revision) || result.revision <= revision) {
      throw new Error('The server did not acknowledge a new event revision.');
    }
    remoteRevisions.set(eventId, result.revision);
    lastServerSyncAt = new Date().toISOString();
    lastServerError = null;
    notify({ type: 'sync', phase: 'done', eventId, revision: result.revision });
  } catch (error) {
    lastServerError = String(error?.message || error || 'The server rejected this event change.');
    notify({ type: 'sync-failed', eventId, error });
    throw error;
  } finally {
    remotePending -= 1;
    syncing = remotePending > 0;
  }
}

function flushRemoteSaves() {
  remoteFlushQueued = false;
  for (const eventId of [...remoteDirtyEvents]) {
    remoteDirtyEvents.delete(eventId);
    const previous = remoteSaveChains.get(eventId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => saveRemoteEvent(eventId));
    remoteSaveChains.set(eventId, next);
    next.catch(() => {}).finally(() => {
      if (remoteSaveChains.get(eventId) === next) remoteSaveChains.delete(eventId);
    });
  }
}

function queueRemoteSave(eventId) {
  remoteDirtyEvents.add(eventId);
  if (remoteFlushQueued) return;
  remoteFlushQueued = true;
  queueMicrotask(flushRemoteSaves);
}

export const syncState = () => ({
  configured: Boolean(remoteBackend || legacyClient),
  connected: Boolean(remoteBackend),
  remoteWrites: Boolean(remoteBackend || legacyClient),
  localOnlyWrites,
  scope: storageScope(),
  online,
  pending: queue.length + remotePending + remoteDirtyEvents.size,
  failed: queue.filter((op) => op.blocked).length,
  review: queue.filter((op) => op.requiresReview && !op.blocked).length,
  syncing,
  lastServerSyncAt,
  lastServerError,
  storage: {
    available: storage.available,
    error: storage.error,
    warning: storage.warning,
    recovered: storage.recovered,
    source: storage.source,
    lastSavedAt: storage.lastSavedAt,
  },
});

/* --------------------------------------------------------------------------
   Connected cache boundary
   --------------------------------------------------------------------------
   The staging backend is command-shaped. It has no generic record replay, so
   connected data enters this store only through the explicit RPC methods
   below. A cache merge is deliberately `queueIt: false`; it is an observed
   server response, never a client-authored write. */

function resetRuntime({ clearErrors = true } = {}) {
  state = EMPTY();
  queue = [];
  undoStack.length = 0;
  syncing = false;
  backoff = 0;
  localOnlyWrites = 0;
  remotePending = 0;
  remoteFlushQueued = false;
  remoteRevisions.clear();
  remoteDirtyEvents.clear();
  remoteSaveChains.clear();
  if (clearErrors) {
    lastServerSyncAt = null;
    lastServerError = null;
  }
  storage.lastSavedAt = null;
  storage.error = null;
  storage.warning = null;
  storage.recovered = false;
  storage.source = 'empty';
}

function removeScopeStorage(keys = activeKeys) {
  for (const key of [keys.state, keys.queue, keys.snapshot, keys.snapshotBackup]) {
    try { localStorage.removeItem(key); } catch (error) { setStorageIssue(error); }
  }
}

function sameScope(projectUrl, accountId) {
  const normalizedUrl = projectUrl ? String(projectUrl).replace(/\/+$/, '') : null;
  const normalizedAccount = projectUrl ? String(accountId || 'anonymous') : null;
  return activeScope.projectUrl === normalizedUrl && activeScope.accountId === normalizedAccount;
}

/* Select a connected cache namespace. Account scopes are not trusted as
   authentication; Supabase still owns authentication. They only ensure a
   cached response from account A cannot appear while account B is active. */
export function useConnectedScope(projectUrl, accountId = 'anonymous', { clearPrevious = false } = {}) {
  if (!projectUrl) throw new Error('A project URL is required for connected storage.');
  if (sameScope(projectUrl, accountId)) return false;

  if (remoteBackend?.invalidate) remoteBackend.invalidate();
  if (clearPrevious && activeScope.projectUrl && activeScope.accountId !== 'anonymous') {
    removeScopeStorage(activeKeys);
  }
  resetRuntime();
  selectScope(projectUrl, accountId);
  hydrate();
  notify({ type: 'scope', scope: storageScope() });
  return true;
}

/* Sign-out is a privacy boundary, not just an auth event. Drop the current
   authenticated cache and return to the project-scoped anonymous namespace,
   retaining only public data that can be fetched without an account. */
export function clearConnectedSession() {
  if (!activeScope.projectUrl) {
    resetRuntime();
    notify({ type: 'scope-clear' });
    return false;
  }
  /* Supabase emits an INITIAL_SESSION callback with a null session during an
     ordinary signed-out boot. We are already in the anonymous namespace at
     that point, so treating it as a second sign-out would invalidate the
     first bkt_list_events request and leave a false "Save failed" status in
     the header. Real sign-out still crosses this boundary because an active
     account always has a non-anonymous scope. */
  if (!activeScope.accountId || activeScope.accountId === 'anonymous') return false;
  if (remoteBackend?.invalidate) remoteBackend.invalidate();
  if (activeScope.accountId && activeScope.accountId !== 'anonymous') removeScopeStorage(activeKeys);
  resetRuntime();
  selectScope(activeScope.projectUrl, 'anonymous');
  hydrate();
  notify({ type: 'scope-clear', scope: storageScope() });
  return true;
}

export function attachBackend(backend, { projectUrl, accountId = 'anonymous', pull = false } = {}) {
  if (typeof backend?.listEvents !== 'function' || typeof backend?.identity !== 'function') {
    throw new Error('The connected Brackets backend is incomplete.');
  }
  remoteBackend = backend;
  legacyClient = null;
  if (!sameScope(projectUrl, accountId)) useConnectedScope(projectUrl, accountId);
  if (pull) return pullRemote();
  return Promise.resolve(null);
}

export const connectedBackend = () => remoteBackend;

function cacheKey(collection, row) {
  if (collection === 'brackets') return row.eventId || row.id;
  return row.id;
}

/* The reviewed SQL slice has complete local shapes for identity, events,
   organisations, entries and stations. Bracket/result rows are reserved for
   later authoritative commands and are not allowed to poison the strict
   local snapshot validator with their current partial SQL shape. */
const REMOTE_CACHE_COLLECTIONS = new Set(['players', 'orgs', 'events', 'entries', 'stations', 'brackets', 'results']);

export function cacheRemote(data, { silent = false } = {}) {
  if (!remoteBackend || !data || typeof data !== 'object') return 0;
  let count = 0;
  for (const collection of REMOTE_CACHE_COLLECTIONS) {
    for (const source of data[collection] || []) {
      if (!source || typeof source !== 'object') continue;
      const id = cacheKey(collection, source);
      if (typeof id !== 'string' || !id) continue;
      const row = { ...source, id };
      if (!validRow(collection, row)) continue;
      state[collection][id] = { ...(state[collection][id] || {}), ...row };
      if (collection === 'events' && Number.isSafeInteger(row.revision)) {
        remoteRevisions.set(id, row.revision);
      }
      count += 1;
    }
  }
  if (count) {
    requestPersist();
    if (!silent) notify({ type: 'remote-cache', count });
  }
  return count;
}

export async function createRemoteEvent(eventId, input) {
  if (!remoteBackend) throw new Error('No connected backend is available.');
  const result = await remoteBackend.createEvent(eventId, input);
  cacheRemote({ events: [{ ...result.event, inviteCode: result.inviteCode }], orgs: [result.org], stations: result.stations }, { silent: true });
  notify({ type: 'remote-create', eventId: result.event?.id || eventId });
  return result;
}

export async function redeemRemoteCode(code) {
  if (!remoteBackend) throw new Error('No connected backend is available.');
  const result = await remoteBackend.redeemCode(code);
  cacheRemote({ events: result.event ? [{ ...result.event, inviteCode: String(code).trim().toUpperCase() }] : [] }, { silent: true });
  if (result.event?.id) await readRemoteEvent(result.event.id);
  return result;
}

export async function joinRemoteEvent(eventId, options) {
  if (!remoteBackend) throw new Error('No connected backend is available.');
  const entry = await remoteBackend.joinEvent(eventId, options);
  cacheRemote({ entries: [entry] }, { silent: true });
  /* The entry response is enough to render the immediate outcome. A fresh
     event read also makes capacity/waitlist counts and related public rows
     agree with the server before navigation. */
  await readRemoteEvent(eventId);
  return entry;
}

export async function createRemoteWalkup(eventId, tag, group = null) {
  if (!remoteBackend) throw new Error('No connected backend is available.');
  const result = await remoteBackend.createWalkup(eventId, tag);
  const entry = {
    ...result.entry,
    group: group || null,
    checkedInAt: result.entry.checkedInAt || new Date().toISOString(),
    source: 'door',
    signedDocuments: result.entry.signedDocuments || [],
  };
  cacheRemote({ players: [result.player], entries: [entry] }, { silent: true });
  await readRemoteEvent(eventId);
  /* Persist organizer-only fields the narrow walk-up command does not accept,
     such as crew and immediate desk check-in, through the versioned state RPC. */
  state.entries[entry.id] = { ...(state.entries[entry.id] || {}), ...entry };
  queueRemoteSave(eventId);
  requestPersist();
  notify({ type: 'remote-walkup', eventId, entryId: entry.id });
  return { ...result, entry };
}

export async function readRemoteEvent(eventId) {
  if (!remoteBackend) throw new Error('No connected backend is available.');
  const pendingSave = remoteSaveChains.get(eventId);
  if (pendingSave) await pendingSave;
  const result = await remoteBackend.readEvent(eventId);
  /* An event bundle is authoritative for its child rows. Remove cached rows
     that the server no longer returned before merging the new snapshot. */
  for (const collection of ['entries', 'stations', 'results']) {
    for (const [id, row] of Object.entries(state[collection])) {
      if (row.eventId === eventId) delete state[collection][id];
    }
  }
  delete state.brackets[eventId];
  cacheRemote(result, { silent: true });
  if (Number.isSafeInteger(result.revision)) remoteRevisions.set(eventId, result.revision);
  requestPersist();
  return result;
}

async function pullRemote() {
  if (!remoteBackend) return null;
  try {
    const result = await remoteBackend.listEvents();
    const visible = new Set((result.events || []).map((event) => event.id));
    state.events = {};
    state.orgs = {};
    state.players = {};
    for (const collection of ['entries', 'stations']) {
      for (const [id, row] of Object.entries(state[collection])) {
        if (!visible.has(row.eventId)) delete state[collection][id];
      }
    }
    cacheRemote(result, { silent: true });
    requestPersist();
    lastServerSyncAt = new Date().toISOString();
    lastServerError = null;
    notify({ type: 'pull' });
    return result;
  } catch (err) {
    lastServerError = String(err?.message || err || 'Could not load events from the server.');
    notify({ type: 'pull-error', error: err });
    return null;
  }
}

/* Legacy generic transport kept solely because recovery.test.mjs verifies
   that an imported old queue remains recoverable. The application boot path
   never calls this function; connected production code uses attachBackend. */
export function attach(supabaseClient) {
  legacyClient = supabaseClient;
  remoteBackend = null;
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
  /* The connected backend is RPC-only. Never reinterpret its cache or an old
     local queue as generic table writes. */
  if (remoteBackend) return;
  if (syncing || !legacyClient || !online || !queue.some((op) => !op.blocked && !op.requiresReview)) return;
  syncing = true;
  notify({ type: 'sync', phase: 'start' });

  while (queue.some((op) => !op.blocked && !op.requiresReview)) {
    /* A permanently failing operation must not block unrelated writes behind
       it. It remains in the queue as a recoverable, explicitly parked item;
       the recovery screen can retry it after the backend is fixed or discard
       only that server operation after confirmation. */
    const index = queue.findIndex((op) => !op.blocked && !op.requiresReview);
    const op = queue[index];
    const table = TABLE[op.collection];
    if (!table) {
      op.blocked = true;
      op.lastError = `Unknown collection: ${op.collection}`;
      op.failedAt = new Date().toISOString();
      requestPersist();
      notify({ type: 'sync-failed', op, error: new Error(op.lastError) });
      continue;
    }

    try {
      let result;
      if (op.patch === null) {
        result = await legacyClient.from(table).delete().eq('id', op.id);
      } else {
        /* Upsert rather than update: the row may not exist server-side yet if
           it was created offline, and two round trips to find out is exactly
           the latency this design exists to avoid. */
        result = await legacyClient.from(table).upsert({ ...rowFor(op.patch), id: op.id, updated_at: op.at });
      }
      /* Supabase resolves the promise for HTTP/RLS errors and returns the
         error in the result. Treating that response as success was the most
         dangerous version of "Saved": the local copy was durable, but the
         server had rejected it and the queue quietly forgot why. */
      if (result?.error) throw result.error;
      queue.splice(index, 1);
      backoff = 0;
      lastServerSyncAt = new Date().toISOString();
      lastServerError = queue.find((item) => item.blocked)?.lastError || null;
      requestPersist();
    } catch (err) {
      op.tries = Number(op.tries || 0) + 1;
      op.lastError = String(err?.message || err || 'Server rejected the write');
      lastServerError = op.lastError;
      /* Ten retries is a backstop against a poison operation, not permission
         to throw away the only copy of a TO's result. Park it and keep the
         record in the recovery export until the TO chooses what to do. */
      if (op.tries > 10) {
        op.blocked = true;
        op.failedAt = new Date().toISOString();
        requestPersist();
        notify({ type: 'sync-failed', op, error: err });
        continue;
      }
      requestPersist();
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

/* A failed write stays in the queue until a human decides. Retrying resets
   the transport bookkeeping but keeps the original patch and timestamp, so
   it is still the same operation from the server's point of view. */
export function retryFailed() {
  let count = 0;
  for (const op of queue) {
    if (!op.blocked) continue;
    op.blocked = false;
    op.tries = 0;
    delete op.failedAt;
    delete op.lastError;
    count += 1;
  }
  if (count) {
    requestPersist();
    notify({ type: 'sync-retry', count });
    drain();
  }
  return count;
}

/* A queue imported from a file is foreign to this browser, even when the
   backup came from another Brackets device owned by the same organiser. Keep
   it out of the automatic boot/reconnect drain until the organiser explicitly
   approves sending those operations to this configured backend. */
export function approveRestoredWrites() {
  let count = 0;
  for (const op of queue) {
    if (!op.requiresReview || op.blocked) continue;
    delete op.requiresReview;
    count += 1;
  }
  if (count) {
    requestPersist();
    notify({ type: 'sync-approve-restored', count });
    drain();
  }
  return count;
}

/* Discarding a failed operation never deletes local event data; it only says
   this device should stop attempting that server write. The UI wraps this in
   a destructive confirmation and names the count before calling it. */
export function discardFailed() {
  const before = queue.length;
  queue = queue.filter((op) => !op.blocked);
  const count = before - queue.length;
  if (count) {
    requestPersist();
    notify({ type: 'sync-discard', count });
  }
  return count;
}

/* Pull everything this account can see. Called once at boot and after a
   reconnect. Server rows win over local ones ONLY where the local row has no
   pending write in the queue -- otherwise a slow sync would clobber the edit
   the TO made twenty seconds ago. */
export async function pull() {
  if (remoteBackend) return pullRemote();
  if (!legacyClient) return;
  const pendingIds = new Set(queue.map((op) => `${op.collection}:${op.id}`));

  for (const [collection, table] of Object.entries(TABLE)) {
    try {
      const { data, error } = await legacyClient.from(table).select('*');
      if (error || !data) continue;
      for (const row of data) {
        if (pendingIds.has(`${collection}:${row.id}`)) continue;
        state[collection][row.id] = recordFor(row);
      }
    } catch (err) {
      console.warn(`[brackets] could not pull ${table}`, err);
    }
  }
  requestPersist();
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
  withPersistBatch(() => seedDemoData({ apply, uid, inviteCode, setSession }));
  notify({ type: 'seed' });
  return true;
}

export function boot({ demo = false, scope = null } = {}) {
  /* Scope selection happens before hydration. A configured deployment must
     never open the unscoped device/demo snapshot, even for one render. */
  if (scope?.projectUrl) selectScope(scope.projectUrl, scope.accountId || 'anonymous');
  else selectScope();
  hydrate();

  if (demo) seedDemo();

  if (lifecycleBound) return state;
  lifecycleBound = true;
  window.addEventListener('online', () => {
    online = true;
    notify({ type: 'net' });
    if (remoteBackend) pullRemote();
    else drain();
  });
  window.addEventListener('offline', () => { online = false; notify({ type: 'net' }); });

  /* pagehide is the last reliable lifecycle hook on mobile browsers. It is a
     cheap belt-and-suspenders flush for callers that changed state through a
     batch or while a storage implementation was temporarily busy. */
  window.addEventListener('pagehide', () => persistNow(), { once: true });

  /* Another tab of the same app made a write. Re-hydrating rather than
     merging is fine because both tabs share one localStorage -- the other tab
     has already written the merged truth. A TO with the bracket on a laptop
     and the queue on a phone is the multi-DEVICE case, and that is what the
     server sync is for. */
  window.addEventListener('storage', (e) => {
    if (e.key !== activeKeys.state) return;
    hydrate();
    notify({ type: 'external' });
  });

  return state;
}

/* Wipe. Behind a confirm in the UI. Exists because the demo data has to be
   removable without clearing the browser's site data, and because a shared
   station tablet needs a "hand this to the next event" button. */
export function reset() {
  resetRuntime();
  removeScopeStorage();
  notify({ type: 'reset' });
}

/* --------------------------------------------------------------------------
   Backup / restore
   -------------------------------------------------------------------------- */

/* Parse and validate before touching the live store. A backup can contain
   event data from a different device, but it must not smuggle in a session or
   an auth token. The accepted shape is deliberately strict enough to reject a
   truncated file while still accepting the old flat v1 export. */
export function inspectBackup(input) {
  let payload = input;
  try {
    if (typeof input === 'string') payload = JSON.parse(input);
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' };
  }

  if (!isRecord(payload)) return { ok: false, error: 'This backup must be a JSON object.' };
  const envelope = isRecord(payload.state);
  if (envelope) {
    if (payload.backup !== 'battydev.brackets' || payload.version !== STORAGE_VERSION) {
      return { ok: false, error: 'This backup format is not supported.' };
    }
  } else if (payload.version !== 1) {
    return { ok: false, error: 'This backup format is not supported.' };
  }
  const backupState = isRecord(payload.state) ? payload.state : payload;
  if (backupState.session !== undefined && backupState.session !== null) {
    return { ok: false, error: 'This file contains a sign-in session. Sessions are never imported.' };
  }
  if (backupState.device !== undefined && backupState.device !== null) {
    return { ok: false, error: 'This file contains device-only settings. Export a fresh backup from Brackets.' };
  }
  if (containsCredential(backupState) || containsCredential(payload.queue)) {
    return { ok: false, error: 'This file contains a credential-like field and cannot be imported.' };
  }
  if (!COLLECTIONS.every((collection) => Object.prototype.hasOwnProperty.call(backupState, collection))) {
    return { ok: false, error: 'This backup does not contain valid Brackets data; part of the data set is missing.' };
  }

  const nextState = normaliseState(backupState);
  const nextQueue = normaliseQueue(payload.queue === undefined ? [] : payload.queue);
  if (!nextState) return { ok: false, error: 'The backup does not contain valid Brackets data.' };
  if (!nextQueue) return { ok: false, error: 'The backup write queue is malformed.' };

  const data = {
    state: { ...nextState, session: null, device: undefined },
    queue: nextQueue,
  };
  return {
    ok: true,
    data,
    summary: {
      events: Object.keys(data.state.events).length,
      players: Object.keys(data.state.players).length,
      pending: data.queue.length,
      failed: data.queue.filter((op) => op.blocked).length,
      review: data.queue.filter((op) => op.requiresReview).length,
    },
  };
}

/* Replace local event data only after the caller has validated and confirmed
   the destructive action. Keep the current auth session and device settings
   out of the replacement, then persist the replacement synchronously so a
   successful restore has the same durability guarantee as an edit. */
export function restoreBackup(input) {
  const parsed = input?.ok === true && input.data
    ? inspectBackup(JSON.stringify({
      backup: 'battydev.brackets', version: STORAGE_VERSION,
      state: input.data.state, queue: input.data.queue,
    }))
    : inspectBackup(input);
  if (!parsed.ok) throw new Error(parsed.error);

  const currentSession = state.session;
  const currentDevice = state.device;
  undoStack.length = 0;
  state = normaliseState({ ...parsed.data.state, session: currentSession, device: currentDevice });
  queue = parsed.data.queue.map((op) => ({ ...op, device: deviceId(), requiresReview: true }));
  const durable = persistNow();
  notify({ type: 'restore', summary: parsed.summary, durable });
  return { ...parsed.summary, durable };
}

/* Export everything as JSON. Data portability is a feature, not a courtesy:
   the reason nobody moves off start.gg is that their history is stuck there,
   and a new site that recreates that lock-in deserves to lose for the same
   reason. See the README on imports. */
export function exportAll() {
  const portableState = safeCopy(copyJson(state));
  return JSON.stringify({
    backup: 'battydev.brackets',
    exportedAt: new Date().toISOString(),
    version: STORAGE_VERSION,
    /* A backup is portable event data, not an authentication export. The
       current session and the per-device id never leave this browser. */
    state: {
      ...portableState,
      session: null,
      device: undefined,
    },
    queue: safeCopy(queue.map(({ op, collection, id, patch, at, tries, blocked, requiresReview, lastError, failedAt }) => ({
      op, collection, id, patch, at, tries, blocked, requiresReview,
      ...(lastError ? { lastError } : {}),
      ...(failedAt ? { failedAt } : {}),
    }))),
  }, null, 2);
}
