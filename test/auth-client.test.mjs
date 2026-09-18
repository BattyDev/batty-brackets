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
globalThis.window = { addEventListener() {}, location: { origin: 'https://brackets.test', pathname: '/' } };

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

// A guest must be upgraded in place. Signing up or signing into another auth
// user would orphan the tournament entry attached to this stable player ID.
let authListener = null;
const anonymousUser = {
  id: '30000000-0000-4000-8000-000000000003', is_anonymous: true,
  created_at: '2026-09-17T01:00:00.000Z', user_metadata: { full_name: 'Rushdown' },
  app_metadata: {}, identities: [],
};
const guestCalls = [];
const guestClient = { auth: {
  async getSession() { return { data: { session: null }, error: null }; },
  onAuthStateChange(fn) { authListener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
  async signInAnonymously(payload) {
    guestCalls.push(['anonymous', payload]);
    return { data: { session: { user: anonymousUser } }, error: null };
  },
  async updateUser(payload, options) {
    guestCalls.push(['email', payload, options]);
    return { data: { user: anonymousUser }, error: null };
  },
  async linkIdentity(payload) { guestCalls.push(['link', payload]); return { data: {}, error: null }; },
} };
const guestAuth = await import(`../lib/auth.js?guest-auth=${Date.now()}`);
await guestAuth.initAuth(guestClient, { connectedBackend: backend });
await guestAuth.createTemporaryPlayer({ tag: '  Rushdown  ' });
assert.deepEqual(guestCalls[0], ['anonymous', { options: { data: { full_name: 'Rushdown' } } }]);
assert.equal(guestAuth.currentSession().temporary, true);
assert.equal(guestAuth.currentPlayer().id, playerId, 'guest auth UUID resolves to a durable player identity');
await assert.rejects(guestAuth.signUpWithEmail('new@example.test', 'password123', 'Rushdown'), /upgrade option/);
await assert.rejects(guestAuth.signInWithEmail('old@example.test', 'password123'), /split this guest record/);
await guestAuth.upgradeTemporaryWithEmail(' SAVE@Example.Test ', 'Rushdown');
assert.deepEqual(guestCalls[1][1], {
  email: 'save@example.test', data: { full_name: 'Rushdown', brackets_guest_upgrade: true },
});
assert.equal(guestAuth.currentSession().pendingUpgradeEmail, 'save@example.test');
await guestAuth.upgradeTemporaryWithDiscord();
assert.equal(guestCalls[2][1].provider, 'discord');

const upgradedUser = { ...anonymousUser, is_anonymous: false, email: 'save@example.test', identities: [{ provider: 'email' }] };
await authListener('USER_UPDATED', { user: upgradedUser });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(guestAuth.currentSession().temporary, false);
assert.equal(guestAuth.currentPlayer().id, playerId, 'verification callback keeps the original player identity');

console.log('PASS auth client: fallback persistence and in-place anonymous account upgrade');
