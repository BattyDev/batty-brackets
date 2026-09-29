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
const { singleElimination } = await import('../lib/bracket.js');
const { selectPlayerMatchSubmission } = await import('../views/event.js');
const projectUrl = 'https://disposable.example';
const eventId = '20000000-0000-4000-8000-000000000002';
const playerId = '10000000-0000-4000-8000-000000000001';
const winnerEntryId = '30000000-0000-4000-8000-000000000003';
const opponentEntryId = '40000000-0000-4000-8000-000000000004';
let bracket = { ...singleElimination([{ id: winnerEntryId }, { id: opponentEntryId }]),
  eventId, revision: 1 };
bracket.matches[0].calledAt = '2026-09-28T00:00:00Z';
const matchId = bracket.matches[0].id;
let calls = [];
let remote = null;
let readable = false;
let reviewCalls = [];
let revision = 3;
let mode = 'ambiguous';
const backend = {
  invalidate() {},
  async identity() { return { id: playerId, tag: 'Player' }; },
  async listEvents() { return { events: [], orgs: [], players: [] }; },
  async submitMatchResult(input) {
    calls.push({ ...input });
    if (mode === 'stale' && input.expectedRevision !== revision) throw new Error('stale_match');
    if (!remote && mode === 'ambiguous') {
      remote = { ...input, status: 'pending' };
      throw new Error('response lost');
    }
    if (!remote) remote = { ...input, status: 'pending' };
    return remote;
  },
  async readEvent() {
    if (!readable) throw new Error('offline');
    return { event: { id: eventId, revision, status: 'running' }, revision,
      entries: [], players: [], stations: [], orgs: [], brackets: [bracket], results: [],
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
store.cacheRemote({ events: [{ id: eventId, revision: 3, status: 'running', name: 'Weekly', gameId: 'mvci' }],
  brackets: [bracket] });
store.setSession({ playerId });
const choice = { eventId, matchId, playerId, winnerEntryId, scoreA: 2, scoreB: 1 };
await assert.rejects(store.submitRemoteMatchResult(choice), /response lost/);
const failed = Object.values(store.get().matchSubmissions)[0];
assert.equal(failed.status, 'failed');
assert.equal(failed.scoreB, 1, 'a failed request retains the entered score');
assert.equal(calls.length, 1);
assert.equal(store.syncState().pending, 0, 'a proposal must not enter the host save queue');
readable = true;
assert.equal((await store.submitRemoteMatchResult(choice)).status, 'pending');
assert.equal(calls.length, 1, 'a read finds an ambiguously acknowledged proposal before retrying');
assert.equal((await store.submitRemoteMatchResult(choice)).status, 'pending');
assert.equal(calls.length, 1, 'another tap does not submit a second proposal');
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

/* The host changed an unrelated event field before this request reached the
   server. A read proves there is no proposal for this ID and the same called
   match is still open, so retry uses the new revision with the original ID. */
remote = null;
mode = 'stale';
revision = 4;
store.cacheRemote({ events: [{ id: eventId, revision: 3, status: 'running', name: 'Weekly', gameId: 'mvci' }],
  brackets: [bracket] });
store.setSession({ playerId });
await assert.rejects(store.submitRemoteMatchResult(choice), /stale_match/);
const staleChoice = Object.values(store.get().matchSubmissions)[0];
assert.equal(staleChoice.status, 'failed');
assert.equal(staleChoice.expectedRevision, 4, 'a confirming read refreshes the retry revision');
assert.equal(staleChoice.entryA, winnerEntryId);
assert.equal(staleChoice.entryB, opponentEntryId);
assert.equal((await store.submitRemoteMatchResult(choice)).status, 'pending');
assert.equal(calls.at(-1).id, staleChoice.id, 'retry preserves the request ID');
assert.equal(calls.at(-1).expectedRevision, 4);

store.useConnectedScope(projectUrl, 'account-c', { clearPrevious: true });
remote = null;
revision = 6;
store.cacheRemote({ events: [{ id: eventId, revision: 5, status: 'running', name: 'Weekly', gameId: 'mvci' }],
  brackets: [bracket] });
store.setSession({ playerId });
const changed = structuredClone(bracket);
changed.matches[0].slots[1].entrantId = '50000000-0000-4000-8000-000000000005';
bracket = changed;
await assert.rejects(store.submitRemoteMatchResult(choice), /stale_match/);
const changedChoice = Object.values(store.get().matchSubmissions)[0];
assert.equal(changedChoice.status, 'stale', 'a changed opponent closes the saved choice');
assert.equal(changedChoice.expectedRevision, 5, 'a changed match must not refresh the retry revision');

const proposals = [
  { id: 'old', matchId, status: 'stale', submittedAt: '2026-09-27T00:00:00Z' },
  { id: 'new', matchId, status: 'pending', submittedAt: '2026-09-28T00:00:00Z' },
];
assert.equal(selectPlayerMatchSubmission(proposals, matchId).id, 'new');
assert.equal(selectPlayerMatchSubmission([...proposals].reverse(), matchId).id, 'new',
  'cached insertion order cannot elevate stale history above pending review');

// Reload after the phone closes during a withdrawal must allow the same ID to retry.
store.cacheRemote({ entries: [{ id: winnerEntryId, eventId, playerId }] });
backend.withdrawEntry = () => new Promise(() => {});
void store.withdrawRemoteEntry(eventId);
const interrupted = Object.values(store.get().withdrawals)[0];
assert.equal(interrupted.status, 'sending');
const reloaded = await import(`../lib/store.js?withdrawal-reload=${Date.now()}`);
reloaded.boot({ scope: { projectUrl, accountId: 'account-c' } });
let withdrawalCalls = 0;
let acceptedWithdrawal;
const readBeforeWithdrawal = backend.readEvent;
backend.readEvent = async () => ({ ...await readBeforeWithdrawal(),
  withdrawals: acceptedWithdrawal ? [acceptedWithdrawal] : [] });
backend.withdrawEntry = async (id) => {
  withdrawalCalls += 1;
  assert.equal(id, interrupted.id, 'reload retry preserves the idempotency key');
  acceptedWithdrawal = { ...interrupted, status: 'pending' };
  return acceptedWithdrawal;
};
await reloaded.attachBackend(backend, { projectUrl, accountId: 'account-c' });
assert.equal(reloaded.get().withdrawals[interrupted.id].status, 'failed');
assert.equal((await reloaded.withdrawRemoteEntry(eventId)).status, 'pending');
assert.equal((await reloaded.withdrawRemoteEntry(eventId)).status, 'pending');
assert.equal(withdrawalCalls, 1);

console.log('PASS match submission and withdrawal: retry, reload, proposal ordering, review, account isolation');
