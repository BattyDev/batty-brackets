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

console.log('PASS connected boundary: RPC boot, blank config, fail-closed publish, and account isolation');
