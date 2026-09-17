import assert from 'node:assert/strict';

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

const store = await import('../lib/store.js');
const auth = await import(`../lib/auth.js?auth-client=${Date.now()}`);
const projectUrl = 'https://example.supabase.co';
const accountId = '10000000-0000-4000-8000-000000000001';
const playerId = '20000000-0000-4000-8000-000000000002';
const updates = [];
const user = {
  id: accountId,
  email: 'verified@example.test',
  created_at: '2026-09-17T00:00:00.000Z',
  user_metadata: { name: 'Bracket Tester' },
  app_metadata: { providers: ['discord'] },
  identities: [{ id: 'discord-user', provider: 'discord' }],
};
const backend = {
  invalidate() {},
  async identity() { return { id: playerId, tag: 'Bracket Tester' }; },
  async listEvents() { return { events: [], orgs: [], players: [] }; },
};
const client = {
  auth: {
    async getSession() { return { data: { session: { user } }, error: null }; },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    async updateUser(payload) { updates.push(payload); return { data: { user }, error: null }; },
  },
};

store.boot({ scope: { projectUrl, accountId: 'anonymous' } });
store.attachBackend(backend, { projectUrl, accountId: 'anonymous' });
await auth.initAuth(client, { connectedBackend: backend });
assert.equal(auth.currentSession().needsPasswordFallback, true,
  'a Discord-only account with verified email should be offered a fallback');

await auth.addPasswordFallback('correct horse battery staple');
assert.deepEqual(updates[0], {
  password: 'correct horse battery staple',
  data: { brackets_password_fallback: true },
}, 'password update records durable fallback display state in the same request');
assert.equal(auth.currentSession().needsPasswordFallback, false);
assert.equal(auth.currentSession().methods.includes('email'), true);

user.user_metadata.brackets_password_fallback = true;
await auth.initAuth(client, { connectedBackend: backend });
assert.equal(auth.currentSession().needsPasswordFallback, false,
  'the fallback remains recognized after a fresh session is adopted');
assert.equal(auth.currentSession().methods.includes('email'), true);

console.log('PASS auth client: Discord password fallback request and reload persistence');
