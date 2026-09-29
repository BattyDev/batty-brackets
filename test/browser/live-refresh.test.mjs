/* Connected event refresh across independent browser contexts.
   A shared in-memory backend stands in for the RPC boundary. This exercises
   separate localStorage contexts, not a live Supabase project. */

import { launch, openApp, goTo, standalone, reporter } from './harness.mjs';
import { singleElimination } from '../../lib/bracket.js';

const EVENT_ID = '20000000-0000-4000-8000-000000000002';
const ORG_ID = '10000000-0000-4000-8000-000000000001';
const HOST_ID = '10000000-0000-4000-8000-000000000002';
const PLAYER_A = '10000000-0000-4000-8000-000000000003';
const PLAYER_B = '10000000-0000-4000-8000-000000000004';
const ENTRY_A = '30000000-0000-4000-8000-000000000001';
const ENTRY_B = '30000000-0000-4000-8000-000000000002';
const STATION_ID = '40000000-0000-4000-8000-000000000001';
const POLL_LIMIT_MS = 9500;
const copy = (value) => structuredClone(value);
const now = new Date().toISOString();
const entries = [
  { id: ENTRY_A, eventId: EVENT_ID, playerId: PLAYER_A, seed: 1, registeredAt: now, checkedInAt: now },
  { id: ENTRY_B, eventId: EVENT_ID, playerId: PLAYER_B, seed: 2, registeredAt: now, checkedInAt: now },
];
const matchBracket = {
  ...singleElimination(entries.map((entry) => ({ id: entry.id, seed: entry.seed }))),
  eventId: EVENT_ID,
};
let serverBundle = {
  event: {
    id: EVENT_ID, orgId: ORG_ID, ownerId: HOST_ID, name: 'Refresh acceptance',
    gameId: 'ssbu', format: 'single', venueType: 'offline', venue: 'Mock venue',
    platforms: ['switch'], startsAt: now, status: 'running', revision: 1,
    presetId: 'ssbu-standard', overrides: {}, documents: [], capacity: 2,
    inviteCode: 'MOCKREFRESH1',
  },
  revision: 1,
  orgs: [{ id: ORG_ID, name: 'Mock venue', ownerId: HOST_ID }],
  players: [
    { id: PLAYER_A, tag: 'Player One', orgId: ORG_ID },
    { id: PLAYER_B, tag: 'Player Two', orgId: ORG_ID },
  ],
  entries,
  stations: [{ id: STATION_ID, eventId: EVENT_ID, number: 1, label: 'Station 1', matchId: null }],
  brackets: [matchBracket],
  results: [],
};

const reads = new Map();
const activeReads = new Map();
const maxConcurrentReads = new Map();
const report = reporter('live-refresh');
const { base, close } = await standalone();
const browser = await launch();

async function openConnected(clientId, hash, width = 1280) {
  const pageErrors = [];
  const { ctx, page } = await openApp(browser, { base, width, height: 900, errors: pageErrors });
  await page.exposeFunction('__mockReadRemoteEvent', async (eventId) => {
    if (eventId !== EVENT_ID) throw new Error('Unexpected event read: ' + eventId);
    reads.set(clientId, (reads.get(clientId) || 0) + 1);
    const active = (activeReads.get(clientId) || 0) + 1;
    activeReads.set(clientId, active);
    maxConcurrentReads.set(clientId, Math.max(maxConcurrentReads.get(clientId) || 0, active));
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return copy(serverBundle);
    } finally {
      activeReads.set(clientId, activeReads.get(clientId) - 1);
    }
  });
  await page.exposeFunction('__mockSaveRemoteEvent', async (eventId, expectedRevision, snapshot) => {
    if (eventId !== EVENT_ID) throw new Error('Unexpected event save: ' + eventId);
    if (expectedRevision !== serverBundle.revision) throw new Error('Mock server rejected a stale event revision.');
    const revision = serverBundle.revision + 1;
    serverBundle = {
      ...serverBundle,
      event: { ...snapshot.event, revision },
      revision,
      entries: copy(snapshot.entries),
      players: copy(snapshot.players),
      stations: copy(snapshot.stations),
      brackets: snapshot.bracket ? [copy(snapshot.bracket)] : [],
      results: copy(snapshot.results),
    };
    return { revision };
  });
  await page.evaluate(async ({ clientId, eventBundle }) => {
    const store = await import('./lib/store.js');
    const backend = {
      identity: async () => ({ id: '10000000-0000-4000-8000-000000000099', tag: 'Mock reader' }),
      listEvents: async () => ({ events: [eventBundle.event], orgs: eventBundle.orgs, players: eventBundle.players }),
      readEvent: async (eventId) => window.__mockReadRemoteEvent(eventId),
      saveEventState: async (eventId, revision, snapshot) =>
        window.__mockSaveRemoteEvent(eventId, revision, snapshot),
    };
    await store.attachBackend(backend, {
      projectUrl: 'https://mock-backend.example.test',
      accountId: clientId,
    });
    store.cacheRemote({ ...eventBundle, events: [eventBundle.event] }, { silent: true });
  }, { clientId, eventBundle: copy(serverBundle) });
  await goTo(page, base, hash);
  return { ctx, page, pageErrors };
}

const host = await openConnected('host-device', '#/e/' + EVENT_ID + '/admin/run');
const phone = await openConnected('phone-device', '#/e/' + EVENT_ID + '/bracket', 390);
const tv = await openConnected('tv-device', '#/e/' + EVENT_ID + '/tv');

try {
  await host.page.waitForSelector('[data-act="call-next"][data-station="' + STATION_ID + '"]', { timeout: 5000 });
  await phone.page.waitForSelector('.bracket-scroll');
  await tv.page.waitForSelector('.tv-station-state');
  await phone.page.evaluate(async () => {
    const store = await import('./lib/store.js');
    store.apply('players', '10000000-0000-4000-8000-000000000003', { pronouns: 'they/them' }, { queueIt: false });
  });

  const scopes = await Promise.all([host.page, phone.page, tv.page].map((page) => page.evaluate(async () => {
    const store = await import('./lib/store.js');
    return store.storageScope().accountId;
  })));
  report.ok('host, phone, and TV have isolated browser storage scopes',
    new Set(scopes).size === 3, scopes.join(', '));

  await tv.page.evaluate(() => {
    localStorage.setItem('battydev.brackets.tv', JSON.stringify({ screen: 'cycle', showing: 'queue' }));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await tv.page.waitForSelector('.tv-progress');
  const tvCycleInitially = await tv.page.evaluate(() =>
    JSON.parse(localStorage.getItem('battydev.brackets.tv') || '{}').screen === 'cycle'
      && Boolean(document.querySelector('.tv-progress')));
  report.ok('TV remains in its existing rotation mode', tvCycleInitially);

  await host.page.locator('[data-act="call-next"][data-station="' + STATION_ID + '"]').click();
  const hostSavedCall = await host.page.waitForFunction(async () => {
    const store = await import('./lib/store.js');
    return store.syncState().pending === 0
      && store.get().stations['40000000-0000-4000-8000-000000000001']?.matchId;
  }, null, { timeout: 5000 }).then(() => true).catch(() => false);
  report.ok('host station call was acknowledged by the mocked backend',
    hostSavedCall && serverBundle.revision >= 2);

  const phoneSawCall = await phone.page.waitForFunction(async () => {
    const store = await import('./lib/store.js');
    return store.get().stations['40000000-0000-4000-8000-000000000001']?.matchId === 'W1-1'
      && store.getEvent('20000000-0000-4000-8000-000000000002')?.revision === 2;
  }, null, { timeout: POLL_LIMIT_MS }).then(() => true).catch(() => false);
  const tvSawCall = await tv.page.waitForFunction(() =>
    [...document.querySelectorAll('.tv-station .tv-player')].some((node) => node.textContent.trim() === 'Player One')
      && [...document.querySelectorAll('.tv-station-state')].some((node) => node.textContent.trim() === 'Now playing'),
  null, { timeout: POLL_LIMIT_MS }).then(() => true).catch(() => false);
  report.ok('untouched phone read the host station call within 10 seconds', phoneSawCall);
  report.ok('untouched TV displayed the host station call within 10 seconds', tvSawCall);
  const tvCycleAfterRefresh = await tv.page.evaluate(() =>
    JSON.parse(localStorage.getItem('battydev.brackets.tv') || '{}').screen === 'cycle'
      && Boolean(document.querySelector('.tv-progress')));
  report.ok('TV rotation remained mounted after the remote refresh', tvCycleAfterRefresh);

  await phone.page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const offlineNotice = await phone.page.waitForFunction(() =>
    document.querySelector('[role="status"]')?.textContent.includes('Offline'),
  null, { timeout: 1500 }).then(() => true).catch(() => false);
  report.ok('phone labels its cached event data offline', offlineNotice);

  await host.page.locator('[data-act="report-open"]').first().click();
  await host.page.locator('dialog.m3 [data-score-side="a"]').last().click();
  await host.page.locator('dialog.m3 .dialog-actions button').filter({ hasText: 'Save' }).click();
  const hostSavedResult = await host.page.waitForFunction(async () => {
    const store = await import('./lib/store.js');
    return store.syncState().pending === 0
      && Object.values(store.get().results).some((result) => result.matchId === 'W1-1');
  }, null, { timeout: 5000 }).then(() => true).catch(() => false);
  report.ok('host result was acknowledged by the mocked backend',
    hostSavedResult && serverBundle.revision >= 3);

  const heldWhileOffline = await phone.page.evaluate(async () => {
    const store = await import('./lib/store.js');
    return Object.values(store.get().results).every((result) => result.matchId !== 'W1-1');
  });
  report.ok('offline phone did not see an unsynced local copy of the host result', heldWhileOffline);

  await phone.page.evaluate(() => window.dispatchEvent(new Event('online')));
  const phoneSawResult = await phone.page.waitForFunction(async () => {
    const store = await import('./lib/store.js');
    return Object.values(store.get().results).some((result) => result.matchId === 'W1-1');
  }, null, { timeout: 3000 }).then(() => true).catch(() => false);
  const tvSawResult = await tv.page.waitForFunction(async () => {
    const store = await import('./lib/store.js');
    return Object.values(store.get().results).some((result) => result.matchId === 'W1-1')
      && store.get().brackets['20000000-0000-4000-8000-000000000002']?.matches
        .find((match) => match.id === 'W1-1')?.state === 'complete';
  },
  null, { timeout: POLL_LIMIT_MS }).then(() => true).catch(() => false);
  report.ok('reconnected phone immediately read the host result', phoneSawResult);
  report.ok('independent TV displayed the completed result', tvSawResult);

  await goTo(phone.page, base, '#/');
  const phoneReadsAfterLeaving = reads.get('phone-device') || 0;
  await phone.page.waitForTimeout(6200);
  report.ok('leaving the event stops phone event polling',
    (reads.get('phone-device') || 0) === phoneReadsAfterLeaving,
    phoneReadsAfterLeaving + ' reads before leaving, ' + (reads.get('phone-device') || 0) + ' after');
  report.ok('the independent phone used the mocked backend', (reads.get('phone-device') || 0) >= 2,
    String(reads.get('phone-device') || 0) + ' reads');
  report.ok('the independent TV used the mocked backend', (reads.get('tv-device') || 0) >= 2);
  report.ok('polling did not overlap event reads in a browser context',
    [...maxConcurrentReads.values()].every((active) => active <= 1),
    [...maxConcurrentReads.entries()].map(([client, active]) => client + ': ' + active).join(', '));
  report.noErrors([...host.pageErrors, ...phone.pageErrors, ...tv.pageErrors]);
} finally {
  await host.ctx.close();
  await phone.ctx.close();
  await tv.ctx.close();
  await browser.close();
  await close();
}

report.done();
