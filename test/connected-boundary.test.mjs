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
assert.match(config, /url:\s*''/);
assert.match(config, /key:\s*''/);

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
const backend = {
  invalidate() {},
  async identity() { return { id: '10000000-0000-4000-8000-000000000001', tag: 'A' }; },
  async listEvents() { return { events: [], orgs: [], players: [] }; },
};

store.boot({ scope: { projectUrl, accountId: 'anonymous' } });
store.attachBackend(backend, { projectUrl, accountId: 'anonymous' });
store.useConnectedScope(projectUrl, 'account-a');
store.cacheRemote({ players: [{ id: '10000000-0000-4000-8000-000000000001', tag: 'A' }] });
assert.equal(Object.keys(store.get().players).length, 1);

const aKey = store.storageKeyForScope(projectUrl, 'account-a');
const bKey = store.storageKeyForScope(projectUrl, 'account-b');
assert.notEqual(aKey, bKey, 'accounts must not share a persistent cache key');

store.useConnectedScope(projectUrl, 'account-b', { clearPrevious: true });
assert.deepEqual(store.get().players, {}, 'switching accounts must not expose the previous cache');
assert.equal(memory.has(aKey), false, 'switching accounts clears the previous protected cache');

store.clearConnectedSession();
assert.equal(store.storageScope().accountId, 'anonymous');
assert.deepEqual(store.get().players, {}, 'sign-out returns to an isolated anonymous cache');

console.log('PASS connected boundary: RPC boot, blank config, fail-closed publish, and account isolation');
