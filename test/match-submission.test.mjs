import assert from 'node:assert/strict';

const memory = new Map();
globalThis.localStorage = {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: key => memory.delete(key),
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
globalThis.window = { addEventListener() {} };

const store = await import(`../lib/store.js?match-submission=${Date.now()}`);
const projectUrl = 'https://disposable.example';
const eventId = '20000000-0000-4000-8000-000000000002';
const playerId = '10000000-0000-4000-8000-000000000001';
const winnerEntryId = '30000000-0000-4000-8000-000000000003';
let calls = [];
let remote = null;
let readable = false;
let reviewCalls = [];
const backend = {
  invalidate() {},
  async identity() { return { id: playerId, tag: 'Player' }; },
  async listEvents() { return { events: [], orgs: [], players: [] }; },
  async submitMatchResult(input) {
    calls.push({ ...input });
    if (!remote) {
      remote = { ...input, status: 'pending' };
      throw new Error('response lost');
    }
    return remote;
  },
  async readEvent() {
    if (!readable) throw new Error('offline');
    return { event: { id: eventId, revision: 3 }, revision: 3,
      entries: [], players: [], stations: [], orgs: [], brackets: [], results: [],
      matchSubmissions: remote ? [remote] : [] };
  },
  async reviewMatchResult(id, revision, state, decision) {
    reviewCalls.push({ id, revision, state, decision });
    remote = { ...remote, status: decision };
    return { event: { id: eventId, revision: 4 }, revision: 4,
      entries: [], players: [], stations: [], orgs: [], brackets: [], results: [],
      matchSubmissions: [remote] };
  },
};

store.boot({ scope: { projectUrl, accountId: 'account-a' } });
store.attachBackend(backend, { projectUrl, accountId: 'account-a' });
store.cacheRemote({ events: [{ id: eventId, revision: 3, name: 'Weekly', gameId: 'mvci' }] });
store.setSession({ playerId });
const choice = { eventId, matchId: 'W-1-0', playerId, winnerEntryId, scoreA: 2, scoreB: 1 };
await assert.rejects(store.submitRemoteMatchResult(choice), /response lost/);
const failed = Object.values(store.get().matchSubmissions)[0];
assert.equal(failed.status, 'failed');
assert.equal(failed.scoreB, 1, 'a failed request retains the entered score');
assert.equal(calls.length, 1);
assert.equal(store.syncState().pending, 0, 'a proposal must not enter the host save queue');
assert.equal((await store.submitRemoteMatchResult(choice)).status, 'pending');
assert.equal(calls.length, 2);
assert.equal(calls[1].id, calls[0].id, 'retry uses the same idempotency key');
assert.equal((await store.submitRemoteMatchResult(choice)).status, 'pending');
assert.equal(calls.length, 2, 'another tap does not submit a second proposal');
readable = true;
await store.readRemoteEvent(eventId);
assert.equal(store.get().matchSubmissions[failed.id].status, 'pending');
await store.reviewRemoteMatchResult(failed.id, 'accepted', [
  { collection: 'brackets', id: eventId, patch: { eventId, matches: [{ id: 'W-1-0', state: 'complete' }] } },
]);
assert.equal(reviewCalls.length, 1);
assert.equal(reviewCalls[0].id, failed.id);
assert.equal(reviewCalls[0].revision, 3);
assert.equal(reviewCalls[0].state.bracket.matches[0].state, 'complete');
assert.equal(store.get().matchSubmissions[failed.id].status, 'accepted');
await assert.rejects(store.reviewRemoteMatchResult(failed.id, 'accepted', []), /pending/);
assert.equal(reviewCalls.length, 1, 'an accepted review is not sent again');
store.useConnectedScope(projectUrl, 'account-b', { clearPrevious: true });
assert.deepEqual(store.get().matchSubmissions, {}, 'another account cannot see cached submissions');

console.log('PASS match submission: failed choice, stable retry, repeated tap, review, account isolation');
