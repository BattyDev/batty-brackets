/* Public reporting entry points and the device-only fail-closed path. */

import { launch, openApp, openDemo, goTo, standalone, reporter, DEMO_EVENT, DEMO_PLAYER } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('reporting');
const errors = [];

{
  const { ctx, page } = await openDemo(browser, { base, width: 390, height: 844, errors });
  await goTo(page, base, `#/e/${DEMO_EVENT}/entrants`);

  report.ok('event view exposes an accessible report entry point',
    await page.getByRole('button', { name: 'Report content' }).count() === 1);
  const beforeEvent = await page.evaluate(async () => JSON.stringify((await import('./lib/store.js')).get()));
  await page.getByRole('button', { name: 'Report content' }).click();
  report.ok('device-only event report opens a native dialog',
    await page.locator('dialog.m3[open]').count() === 1);
  report.ok('device-only event report clearly says nothing is sent or stored',
    await page.locator('dialog.m3').innerText().then((text) => /no server is connected/i.test(text) && /cannot send or save a report/i.test(text)));
  report.ok('device-only event report does not offer a reason field',
    await page.locator('dialog.m3 textarea#report-reason').count() === 0);
  await page.keyboard.press('Escape');
  report.ok('closing the device-only report dialog does not write local report state',
    await page.evaluate(async () => JSON.stringify((await import('./lib/store.js')).get())) === beforeEvent);

  await goTo(page, base, `#/p/${DEMO_PLAYER}`);
  report.ok('player profile exposes an accessible report entry point',
    await page.getByRole('button', { name: 'Report content' }).count() === 1);
  await page.getByRole('button', { name: 'Report content' }).click();
  report.ok('player report is equally honest in device-only mode',
    await page.locator('dialog.m3').innerText().then((text) => /no server is connected/i.test(text) && /cannot send or save a report/i.test(text)));
  await page.keyboard.press('Escape');

  const targets = await page.evaluate(async () => {
    const store = await import('./lib/store.js');
    const reporting = await import('./views/report.js');
    const eventId = '11111111-1111-4111-8111-111111111111';
    const playerId = '22222222-2222-4222-8222-222222222222';
    const entryId = '33333333-3333-4333-8333-333333333333';
    const stationId = '44444444-4444-4444-8444-444444444444';
    const resultId = '55555555-5555-4555-8555-555555555555';
    store.apply('events', eventId, {
      name: 'Report Contract Event', gameId: 'tokon', format: 'single', venue: 'Arcade',
      overrides: { bestOf: 3 }, documents: [{ id: 'doc-1', title: 'Rules' }],
      seedingReport: { collisions: [] },
    }, { queueIt: false });
    store.apply('players', playerId, {
      tag: 'PublicTag', email: 'private@example.test', connections: { discord: 'private-handle' },
    }, { queueIt: false });
    store.apply('entries', entryId, {
      eventId, playerId, group: 'Public crew', seed: 1, waitlisted: false, checkedInAt: null, contact: 'private phone',
    }, { queueIt: false });
    store.apply('stations', stationId, {
      eventId, number: 1, label: 'Station 1', platform: 'PC', matchId: 'match-1',
    }, { queueIt: false });
    store.apply('results', resultId, {
      eventId, winnerPlayerId: playerId, loserPlayerId: '66666666-6666-4666-8666-666666666666', roundName: 'Final',
    }, { queueIt: false });
    store.apply('players', '66666666-6666-4666-8666-666666666666', { tag: 'Opponent' }, { queueIt: false });
    store.apply('brackets', eventId, { eventId, matches: [{ id: 'match-1' }] }, { queueIt: false });
    return reporting.eventTargets(eventId).map(({ kind, id, field, label }) => ({ kind, id, field, label }));
  });
  const targetFields = targets.map(({ kind, field }) => `${kind}/${field}`);
  const allowedFields = new Set([
    'player/tag', 'org/name', 'event/name', 'event/game_id', 'event/format', 'event/venue_type',
    'event/venue', 'event/platforms', 'event/starts_at', 'event/preset_id', 'event/documents',
    'event/overrides', 'event/seeding_report', 'entry/crew', 'station/label', 'station/platform',
    'station/match_id', 'bracket/record', 'result/record',
  ]);
  report.ok('event dialog candidates use the final server report allowlist',
    targetFields.includes('event/documents') && targetFields.includes('event/overrides')
      && targetFields.includes('event/seeding_report') && targetFields.includes('player/tag')
      && targetFields.includes('entry/crew') && targetFields.includes('station/match_id')
      && targetFields.includes('bracket/record') && targetFields.includes('result/record')
      && targetFields.every((target) => allowedFields.has(target)),
    targetFields.join(', '));
  report.ok('public report candidates never include private contact values',
    targets.every(({ label }) => !/private@example|private-handle|private phone/i.test(label)));

  await ctx.close();
}

{
  const { ctx, page } = await openApp(browser, { base, width: 390, height: 844, errors });
  const remoteEventId = '77777777-7777-4777-8777-777777777777';
  await page.evaluate(async (eventId) => {
    const store = await import('./lib/store.js');
    const auth = await import('./lib/auth.js');
    const reporterId = '88888888-8888-4888-8888-888888888888';
    const targetPlayerId = '99999999-9999-4999-8999-999999999999';
    const targetEntryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const reportResultId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const reportStationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const reportUserId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    store.useConnectedScope('https://reporting.test.supabase.co', 'anonymous');
    window.__reportCalls = [];
    await auth.initAuth({
      auth: {
        getSession: async () => ({
          data: { session: { user: {
            id: reportUserId, identities: [{ provider: 'email' }], user_metadata: { name: 'Reporter' },
            app_metadata: { providers: ['email'] }, email: 'reporter@example.test', created_at: '2026-01-01T00:00:00Z',
          } } }, error: null,
        }),
        onAuthStateChange: () => {},
      },
    }, { connectedBackend: {
      identity: async () => ({ id: reporterId, tag: 'Reporter' }),
      submitReport: async (input) => {
        window.__reportCalls.push(structuredClone(input));
        return { accepted: true, duplicate: false };
      },
    } });
    store.apply('events', eventId, {
      name: 'Connected Report Event', gameId: 'tokon', format: 'single', venue: 'Arcade',
      capacity: 8, status: 'registration', documents: [{ id: 'doc-1', title: 'Rules' }],
    }, { queueIt: false });
    store.apply('players', targetPlayerId, { tag: 'Entrant' }, { queueIt: false });
    store.apply('entries', targetEntryId, {
      eventId, playerId: targetPlayerId, seed: 1, waitlisted: false, checkedInAt: null,
    }, { queueIt: false });
    store.apply('stations', reportStationId, { eventId, number: 1, label: 'Station 1' }, { queueIt: false });
    store.apply('results', reportResultId, {
      eventId, winnerPlayerId: targetPlayerId, loserPlayerId: reporterId, roundName: 'Final',
    }, { queueIt: false });
    store.apply('brackets', eventId, { eventId, matches: [{ id: 'match-1' }] }, { queueIt: false });
  }, remoteEventId);

  await page.evaluate((eventId) => { location.hash = `#/e/${eventId}/entrants`; }, remoteEventId);
  await page.getByRole('button', { name: 'Report content' }).waitFor();
  const connectedState = await page.evaluate(async (eventId) => {
    const store = await import('./lib/store.js');
    const auth = await import('./lib/auth.js');
    return {
      event: Boolean(store.getEvent(eventId)),
      session: auth.currentSession(),
      text: document.querySelector('main')?.innerText?.slice(0, 120),
    };
  }, remoteEventId);
  report.ok('connected test event remains available to the public event view', connectedState.event,
    JSON.stringify(connectedState));
  const reportButtonCount = await page.getByRole('button', { name: 'Report content' }).count();
  report.ok('connected test event retains its report button', reportButtonCount === 1);
  if (!reportButtonCount) throw new Error('Connected test event did not render its report button.');
  await page.getByRole('button', { name: 'Report content' }).click();
  report.ok('connected report dialog selects content type, record, and field',
    await page.locator('#report-kind').count() === 1
      && await page.locator('#report-id').count() === 1
      && await page.locator('#report-field').count() === 1);
  await page.locator('#report-kind').selectOption('event');
  await page.locator('#report-field').selectOption('documents');
  await page.locator('#report-reason').fill('The event document contains a private phone number.');
  await page.getByRole('button', { name: 'Send report' }).click();
  await page.waitForFunction(() => document.querySelector('.snackbar')
    || document.querySelector('#report-note')?.textContent.trim(), null, { timeout: 8000 });
  const { submitted, toast, note } = await page.evaluate(() => ({
    submitted: window.__reportCalls,
    toast: document.querySelector('.snackbar')?.textContent || '',
    note: document.querySelector('#report-note')?.textContent || '',
  }));
  report.ok('report submits only the chosen server target and required reason',
    /Report sent/.test(toast) && submitted.length === 1 && submitted[0].targetKind === 'event'
      && submitted[0].targetId === remoteEventId && submitted[0].targetField === 'documents'
      && submitted[0].reason === 'The event document contains a private phone number.',
    JSON.stringify({ submitted, toast, note }));
  report.noErrors(errors);
  await ctx.close();
}

await browser.close();
await close();
report.done();
