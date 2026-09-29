import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const app = source('app.js');
const config = source('config.js');
const setup = source('views/setup.js');

assert.match(app, /store\.attachBackend\(backend/,
  'configured boot must attach the explicit RPC backend');
assert.doesNotMatch(app, /store\.attach\(client\)/,
  'configured boot must never attach the generic table outbox');
assert.match(setup, /store\.createRemoteEvent\(id/,
  'connected event publication must use the explicit server command');
assert.match(setup, /draft\.pendingEventId/,
  'connected event publication must keep an idempotency key across retries');
assert.match(config, /location\.hostname/,
  'production configuration must be host-scoped so local tests never touch live data');
assert.match(config, /url:\s*'https:\/\/bbqauqqymjxqcyurxmna\.supabase\.co'/);
assert.match(config, /key:\s*'sb_publishable_/);
assert.match(config, /captchaSiteKey:\s*'[0-9a-f-]+'/,
  'production configuration includes only the public hCaptcha sitekey');
assert.doesNotMatch(config, /service_role|sb_secret_/,
  'browser configuration must never contain privileged Supabase credentials');

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.has(key) ? memory.get(key) : null,
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { onLine: true },
});
globalThis.window = { addEventListener() {} };

const store = await import(`../lib/store.js?connected-boundary=${Date.now()}`);
const projectUrl = 'https://example.supabase.co';
const playerId = '10000000-0000-4000-8000-000000000001';
const eventId = '20000000-0000-4000-8000-000000000002';
const entryId = '30000000-0000-4000-8000-000000000003';
const saves = [];
let invalidations = 0;
const backend = {
  invalidate() { invalidations += 1; },
  async identity() { return { id: playerId, tag: 'A' }; },
  async listEvents() { return { events: [], orgs: [], players: [] }; },
  async saveEventState(id, revision, state) {
    saves.push({ id, revision, state });
    return { revision: revision + 1, event: state.event, entries: state.entries,
      players: state.players, stations: state.stations, orgs: [], brackets: [], results: state.results };
  },
};

store.boot({ scope: { projectUrl, accountId: 'anonymous' } });
store.attachBackend(backend, { projectUrl, accountId: 'anonymous' });
store.useConnectedScope(projectUrl, 'account-a');
store.cacheRemote({
  players: [{ id: playerId, tag: 'A' }],
  events: [{ id: eventId, name: 'Remote', gameId: 'mvci', revision: 1 }],
  entries: [{ id: entryId, eventId, playerId, waitlisted: false }],
});
assert.equal(Object.keys(store.get().players).length, 1);
store.apply('entries', entryId, { checkedInAt: '2026-09-16T12:00:00.000Z' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(saves.length, 1, 'connected organizer writes use one versioned state command');
assert.equal(saves[0].revision, 1);
assert.equal(saves[0].state.entries[0].checkedInAt, '2026-09-16T12:00:00.000Z');
assert.equal(store.syncState().localOnlyWrites, 0);

const aKey = store.storageKeyForScope(projectUrl, 'account-a');
const bKey = store.storageKeyForScope(projectUrl, 'account-b');
assert.notEqual(aKey, bKey, 'accounts must not share a persistent cache key');

store.useConnectedScope(projectUrl, 'account-b', { clearPrevious: true });
assert.deepEqual(store.get().players, {}, 'switching accounts must not expose the previous cache');
assert.equal(memory.has(aKey), false, 'switching accounts clears the previous protected cache');

store.clearConnectedSession();
assert.equal(store.storageScope().accountId, 'anonymous');
assert.deepEqual(store.get().players, {}, 'sign-out returns to an isolated anonymous cache');
const invalidationsAfterSignOut = invalidations;
assert.equal(store.clearConnectedSession(), false,
  'a duplicate anonymous sign-out is a no-op');
assert.equal(invalidations, invalidationsAfterSignOut,
  'a duplicate anonymous sign-out must not invalidate an in-flight public pull');

/* Reproduced failure: an edit rejected by the server used to vanish after a
   list refresh, with no retryable work left in the store. */
const recoveryProject = 'https://recovery.supabase.co';
let serverRevision = 1;
let serverName = 'Server name';
let rejectSave = true;
const recoverySaves = [];
const recoveryBackend = {
  invalidate() {},
  async identity() { return { id: playerId, tag: 'A' }; },
  async listEvents() { return { events: [{ id: eventId, name: serverName, gameId: 'mvci', revision: serverRevision }], orgs: [], players: [] }; },
  async readEvent() { return { event: { id: eventId, name: serverName, gameId: 'mvci', revision: serverRevision }, revision: serverRevision,
    entries: [], players: [], stations: [], orgs: [], brackets: [], results: [] }; },
  async saveEventState(id, revision, data) {
    recoverySaves.push({ id, revision, name: data.event.name });
    if (rejectSave) throw new Error('Network rejected save');
    assert.equal(revision, serverRevision);
    serverRevision += 1;
    serverName = data.event.name;
    return { revision: serverRevision };
  },
};
const recovery = await import(`../lib/store.js?recovery=${Date.now()}`);
recovery.boot({ scope: { projectUrl: recoveryProject, accountId: 'host-a' } });
recovery.attachBackend(recoveryBackend, { projectUrl: recoveryProject, accountId: 'host-a' });
recovery.cacheRemote(await recoveryBackend.listEvents());
recovery.apply('events', eventId, { name: 'Unsaved name' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(recovery.syncState().failed, 1);
await recovery.pull();
await recovery.readRemoteEvent(eventId);
assert.equal(recovery.getEvent(eventId).name, 'Unsaved name', 'incoming reads preserve failed edits');
assert.equal(recovery.syncState().failed, 1, 'refresh retains the failed status');

const reloaded = await import(`../lib/store.js?reload=${Date.now()}`);
reloaded.boot({ scope: { projectUrl: recoveryProject, accountId: 'host-a' } });
reloaded.attachBackend(recoveryBackend, { projectUrl: recoveryProject, accountId: 'host-a' });
assert.equal(reloaded.getEvent(eventId).name, 'Unsaved name', 'reload retains the local edit');
assert.equal(reloaded.syncState().failed, 1, 'reload retains retry state');
rejectSave = false;
assert.equal(await reloaded.retryConnectedSave(eventId), true);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(serverName, 'Unsaved name');
assert.equal(reloaded.syncState().pending, 0);
assert.equal(reloaded.syncState().failed, 0);

rejectSave = true;
reloaded.apply('events', eventId, { name: 'Second local edit' });
await new Promise(resolve => setTimeout(resolve, 0));
serverRevision += 1;
serverName = 'Newer server edit';
await reloaded.pull();
assert.equal(reloaded.syncState().conflicts, 1);
assert.equal(reloaded.getEvent(eventId).name, 'Second local edit');
const attemptsBeforeRetry = recoverySaves.length;
assert.equal(await reloaded.retryConnectedSave(eventId), false);
assert.equal(recoverySaves.length, attemptsBeforeRetry, 'stale retry never sends an overwrite');
reloaded.useConnectedScope(recoveryProject, 'host-b');
assert.equal(reloaded.getEvent(eventId), null, 'another account cannot see host-a pending work');

/* A walk-up's organizer-only fields must enter the same connected save queue
   as ordinary host edits, then survive a failed write and an authoritative read. */
const walkupProject = 'https://walkup.supabase.co';
const walkupEntryId = '30000000-0000-4000-8000-000000000013';
const walkupPlayerId = '10000000-0000-4000-8000-000000000013';
let walkupRevision = 1;
let rejectWalkupSave = true;
let walkupServerEntries = [];
const walkupSaves = [];
const walkupBackend = {
  invalidate() {},
  async identity() { return { id: playerId, tag: 'A' }; },
  async listEvents() { return { events: [], orgs: [], players: [] }; },
  async createWalkup() {
    const player = { id: walkupPlayerId, tag: 'Door Player' };
    const entry = { id: walkupEntryId, eventId, playerId: walkupPlayerId, waitlisted: false };
    return { player, entry, claimCode: 'claim-code' };
  },
  async readEvent() {
    return {
      event: { id: eventId, name: 'Walk-up event', gameId: 'mvci', revision: walkupRevision },
      revision: walkupRevision,
      entries: walkupServerEntries.length ? structuredClone(walkupServerEntries)
        : [{ id: walkupEntryId, eventId, playerId: walkupPlayerId, waitlisted: false }],
      players: [{ id: walkupPlayerId, tag: 'Door Player' }],
      stations: [], orgs: [], brackets: [], results: [],
    };
  },
  async saveEventState(id, revision, data) {
    walkupSaves.push({ id, revision, entries: structuredClone(data.entries) });
    if (rejectWalkupSave) throw new Error('Temporary network failure');
    assert.equal(revision, walkupRevision);
    walkupRevision += 1;
    walkupServerEntries = structuredClone(data.entries);
    return { revision: walkupRevision };
  },
};
const walkup = await import(`../lib/store.js?walkup=${Date.now()}`);
walkup.boot({ scope: { projectUrl: walkupProject, accountId: 'host-walkup' } });
walkup.attachBackend(walkupBackend, { projectUrl: walkupProject, accountId: 'host-walkup' });
walkup.cacheRemote({
  players: [],
  events: [{ id: eventId, name: 'Walk-up event', gameId: 'mvci', revision: 1 }],
});
const createdWalkup = await walkup.createRemoteWalkup(eventId, 'Door Player', 'Pool B');
assert.equal(createdWalkup.entry.group, 'Pool B');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(walkupSaves.length, 1, 'walk-up organizer fields queue one versioned event save');
assert.equal(walkupSaves[0].revision, 1);
assert.equal(walkupSaves[0].entries[0].group, 'Pool B');
assert.equal(walkupSaves[0].entries[0].source, 'door');
assert.ok(walkupSaves[0].entries[0].checkedInAt);
assert.equal(walkup.syncState().failed, 1, 'a rejected walk-up save remains visible for retry');
await walkup.readRemoteEvent(eventId);
assert.equal(walkup.get().entries[walkupEntryId].group, 'Pool B', 'remote reads preserve the local group');
assert.equal(walkup.get().entries[walkupEntryId].source, 'door', 'remote reads preserve walk-up source');
assert.ok(walkup.get().entries[walkupEntryId].checkedInAt, 'remote reads preserve desk check-in');
assert.equal(walkup.syncState().failed, 1);
rejectWalkupSave = false;
assert.equal(await walkup.retryConnectedSave(eventId), true);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(walkup.syncState().pending, 0);
assert.equal(walkup.syncState().failed, 0);
await walkup.readRemoteEvent(eventId);
assert.equal(walkup.get().entries[walkupEntryId].group, 'Pool B', 'accepted walk-up fields survive a later server read');
assert.equal(walkup.get().entries[walkupEntryId].source, 'door');
assert.ok(walkup.get().entries[walkupEntryId].checkedInAt);

/* A mocked server exercises the two withdrawal acknowledgements and the
   ambiguous-delivery retry. SQL ownership and locking need live PostgreSQL. */
const withdrawalProject = 'https://withdrawal.supabase.co';
const withdrawal = await import(`../lib/store.js?withdrawal=${Date.now()}`);
let serverEntry = { id: entryId, eventId, playerId, waitlisted: false };
let serverWithdrawal = null;
let withdrawalCalls = 0;
let loseAcknowledgement = true;
const withdrawalBackend = {
  invalidate() {},
  async identity() { return { id: playerId, tag: 'A' }; },
  async listEvents() { return { events: [], orgs: [], players: [] }; },
  async readEvent() { return {
    event: { id: eventId, name: 'Withdrawal event', gameId: 'mvci', status: 'registration', revision: 2 }, revision: 2,
    entries: serverEntry ? [serverEntry] : [], players: [{ id: playerId, tag: 'A' }],
    stations: [], orgs: [], brackets: [], results: [], withdrawals: serverWithdrawal ? [serverWithdrawal] : [],
  }; },
  async withdrawEntry(id) {
    withdrawalCalls += 1;
    if (!serverWithdrawal) {
      serverWithdrawal = { id, eventId, entryId, playerId, status: 'withdrawn' };
      serverEntry = null;
    }
    if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Response lost'); }
    return serverWithdrawal;
  },
};
withdrawal.boot({ scope: { projectUrl: withdrawalProject, accountId: 'player-a' } });
withdrawal.attachBackend(withdrawalBackend, { projectUrl: withdrawalProject, accountId: 'player-a' });
withdrawal.setSession({ playerId });
await withdrawal.readRemoteEvent(eventId);
assert.equal((await withdrawal.withdrawRemoteEntry(eventId)).status, 'withdrawn',
  'an ambiguous delivery is reconciled from the server');
assert.equal(withdrawal.entryFor(eventId, playerId), null, 'pre-bracket withdrawal removes the entry');
assert.equal(withdrawal.get().players[playerId].tag, 'A', 'identity survives withdrawal');
assert.equal(withdrawalCalls, 1, 'confirmed delivery needs no duplicate retry');

const active = await import(`../lib/store.js?active-withdrawal=${Date.now()}`);
const activeProject = 'https://active-withdrawal.supabase.co';
const activeBackend = { ...withdrawalBackend, async readEvent() { return {
  event: { id: eventId, name: 'Active event', gameId: 'mvci', status: 'running', revision: 3 }, revision: 3,
  entries: [{ id: entryId, eventId, playerId, waitlisted: false }], players: [{ id: playerId, tag: 'A' }],
  stations: [], orgs: [], brackets: [], results: [], withdrawals: serverWithdrawal ? [serverWithdrawal] : [],
}; }, async withdrawEntry(id) {
  withdrawalCalls += 1;
  serverWithdrawal = { id, eventId, entryId, playerId, status: 'pending' };
  return serverWithdrawal;
} };
serverWithdrawal = null;
active.boot({ scope: { projectUrl: activeProject, accountId: 'player-a' } });
active.attachBackend(activeBackend, { projectUrl: activeProject, accountId: 'player-a' });
active.setSession({ playerId });
await active.readRemoteEvent(eventId);
assert.equal((await active.withdrawRemoteEntry(eventId)).status, 'pending');
assert.ok(active.entryFor(eventId, playerId), 'active request keeps the bracket entry');
assert.equal((await active.withdrawRemoteEntry(eventId)).status, 'pending');
assert.equal(withdrawalCalls, 2, 'repeat taps do not send another active request');

console.log('PASS connected boundary: RPC boot, blank config, fail-closed publish, and account isolation');
