/* The separate demo entry, all three working views, and their guided tours. */

import { launch, openApp, goTo, standalone, reporter, DEMO_EVENT, DEMO_PLAYER } from './harness.mjs';

const TOURS = [
  { id: 'organiser', role: 'host', steps: 9, borrows: false },
  { id: 'tv', role: 'tv', steps: 4, borrows: false },
  { id: 'player', role: 'player', steps: 6, borrows: true },
];

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('tours');
const errors = [];
const { ctx, page } = await openApp(browser, { base, errors });

const session = (demo = false) => page.evaluate((isolated) => {
  const key = isolated ? 'battydev.brackets.state.v1.demo' : 'battydev.brackets.state.v1';
  try { return JSON.parse(localStorage.getItem(key))?.session || null; }
  catch { return null; }
}, demo);

const realStorageSnapshot = () => page.evaluate(() => {
  const parse = (key) => {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  };
  const state = parse('battydev.brackets.state.v1');
  return {
    state,
    queue: parse('battydev.brackets.queue.v1'),
    snapshotState: parse('battydev.brackets.snapshot.v2')?.state || null,
  };
});

const pageState = () => page.evaluate(async () => {
  const store = await import('./lib/store.js');
  return {
    event: store.getEvent('evt_demo_tokon') || null,
    realEvent: store.getEvent('evt_real_preserved') || null,
    demoPlayer: store.getPlayer('plr_old_demo') || null,
    oldBracket: store.get().brackets.evt_old_demo || null,
    session: store.getSession(),
    connected: store.syncState().connected,
  };
});

/* Normal entry stays empty and does not render old tour progress. Simulate the
   shared-cache version once so boot's compatibility cleanup is exercised. */
report.ok('ordinary app does not seed a sample or show a tour',
  !(await pageState()).event
    && await page.evaluate(() => !document.querySelector('.demo-bar, .tour'))
    && await page.locator('a[href="./demo.html"]').count() > 0);
await page.evaluate(async () => {
  const store = await import('./lib/store.js');
  const auth = await import('./lib/auth.js');
  store.apply('players', 'plr_real_preserved', { id: 'plr_real_preserved', tag: 'Real player' }, { queueIt: false });
  store.apply('events', 'evt_real_preserved', { id: 'evt_real_preserved', name: 'Real event', status: 'registration' }, { queueIt: false });
  store.apply('players', 'plr_old_demo', { id: 'plr_old_demo', tag: 'Old demo', demo: true }, { queueIt: false });
  store.apply('events', 'evt_old_demo', { id: 'evt_old_demo', name: 'Old sample', status: 'registration', demo: true }, { queueIt: false });
  store.apply('entries', 'ent_old_demo', { id: 'ent_old_demo', eventId: 'evt_old_demo', playerId: 'plr_old_demo', demo: true }, { queueIt: false });
  store.apply('brackets', 'evt_old_demo', {
    id: 'evt_old_demo', eventId: 'evt_old_demo', type: 'single', size: 2, rounds: 1,
    matches: [{ id: 'old_match', bracket: 'W', round: 1, index: 0, name: 'Final',
      slots: [{ kind: 'seed', seed: 1, entrantId: 'ent_old_demo' }, { kind: 'seed', seed: 2, entrantId: null }],
      winnerTo: null, loserTo: null }],
  }, { queueIt: false });
  auth.adoptLocalSession({ playerId: 'plr_real_preserved', local: true, methods: ['local'] });
  localStorage.setItem('battydev.brackets.tour.step', JSON.stringify(0));
});
const prepared = await page.evaluate(async () => {
  const store = await import('./lib/store.js');
  return {
    event: store.getEvent('evt_real_preserved')?.name,
    player: store.getSession()?.playerId,
    persisted: Boolean(JSON.parse(localStorage.getItem('battydev.brackets.state.v1') || '{}')?.events?.evt_real_preserved),
  };
});
report.ok('legacy-cache migration fixture contains real data before reload',
  prepared.event === 'Real event' && prepared.player === 'plr_real_preserved' && prepared.persisted,
  JSON.stringify(prepared));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(document.querySelector('main')?.textContent?.trim()));
let migrated = await pageState();
report.ok('legacy sample rows and generated bracket are removed while real data and sign-in survive',
  !migrated.demoPlayer && !migrated.oldBracket && migrated.realEvent?.name === 'Real event'
    && migrated.session?.playerId === 'plr_real_preserved', JSON.stringify(migrated));
report.ok('legacy tour progress does not interrupt real event work',
  await page.evaluate(() => !document.querySelector('.demo-bar, .tour')));

/* A prior borrowed sample identity is removed without deleting the real event. */
await page.evaluate(async () => {
  const store = await import('./lib/store.js');
  store.setSession({ playerId: 'plr_old_demo', local: true, demo: true });
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(document.querySelector('main')?.textContent?.trim()));
migrated = await pageState();
report.ok('legacy borrowed identity is cleared without removing real events',
  migrated.session === null && migrated.realEvent?.name === 'Real event', JSON.stringify(migrated));
await page.evaluate(async () => {
  const auth = await import('./lib/auth.js');
  auth.adoptLocalSession({ playerId: 'plr_real_preserved', local: true, methods: ['local'] });
});

const realStorageBefore = await realStorageSnapshot();
let backendModuleRequests = 0;
await page.route('**/config.js', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: 'window.BRACKETS_CONFIG = { url: "https://demo-only.invalid", key: "public-placeholder" };',
}));
await page.route('https://cdn.jsdelivr.net/**', async (route) => {
  backendModuleRequests += 1;
  await route.abort();
});

for (const tour of TOURS) {
  await page.goto(`${base}demo.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.demoReady === 'true');

  report.ok(`${tour.role}: entry page offers Host, Player, and TV choices`,
    await page.locator('[data-demo-role]').count() === 3);
  report.ok(`${tour.role}: entry page links back to the real app`,
    await page.locator('a[href="./index.html"]').count() > 0);

  await page.locator(`[data-demo-role="${tour.role}"]`).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('demo') === '1'
    && Boolean(document.querySelector('main')?.textContent?.trim()));
  const roleView = await page.evaluate((role) => ({
    hash: location.hash,
    content: document.querySelector('main')?.innerText || '',
    isHost: Boolean(document.querySelector('.workspace-context')),
    isTv: Boolean(document.querySelector('.tv-title')),
    title: document.querySelector('.tv-title')?.textContent || '',
  }), tour.role);
  const rightView = tour.role === 'host' ? roleView.isHost && roleView.content.includes('Tokon Tuesdays')
    : tour.role === 'player' ? roleView.hash.includes(`/p/${DEMO_PLAYER}`) && roleView.content.includes('Kira')
      : roleView.isTv && roleView.title.includes('Tokon Tuesdays');
  report.ok(`${tour.role}: choice opens its working demo view`, rightView, JSON.stringify(roleView));

  const boundary = await page.evaluate(async () => {
    const store = await import('./lib/store.js');
    const auth = await import('./lib/auth.js');
    return {
      event: store.getEvent('evt_demo_tokon'),
      connected: store.syncState().connected,
      remoteWrites: store.syncState().remoteWrites,
      authRemote: auth.isRemote(),
    };
  });
  report.ok(`${tour.role}: uses the local demo store without remote writes or real auth`,
    boundary.event?.demo === true && boundary.connected === false && boundary.remoteWrites === false
      && boundary.authRemote === false);

  await goTo(page, base, '#/');
  await page.click(`[data-act="tour-start"][data-tour="${tour.id}"]`);
  await page.waitForTimeout(250);

  const seen = [];
  let borrowed = null;
  for (let i = 0; i < tour.steps + 3; i += 1) {
    const step = await page.evaluate(() => ({
      title: document.querySelector('.tour-title')?.innerText || '',
      hash: location.hash,
    }));
    if (!step.title) break;
    seen.push(step);
    if (tour.borrows && !borrowed) borrowed = await session(true);
    const next = await page.$('[data-act="tour-next"]');
    if (!next) break;
    await next.click();
    await page.waitForTimeout(250);
  }

  report.ok(`${tour.id}: walks all ${tour.steps} steps`, seen.length === tour.steps,
    `reached ${seen.length}: ${seen.map((s) => s.title).join(' / ')}`);
  report.ok(`${tour.id}: every step lands on a real route`,
    seen.every((s) => s.hash.startsWith('#/')), seen.map((s) => s.hash).join(' '));
  const stuck = seen.find((s, i) => i > 0 && s.title === seen[i - 1].title);
  report.ok(`${tour.id}: no step repeats itself`, !stuck, stuck ? `stuck on "${stuck.title}"` : '');

  if (tour.borrows) {
    report.ok(`${tour.id}: borrows a sample identity only in demo storage`,
      borrowed?.playerId === DEMO_PLAYER && borrowed?.demo === true
        && (await session())?.playerId === 'plr_real_preserved', JSON.stringify(borrowed));
  }

  await page.click('[data-act="tour-reset"]');
  await page.waitForTimeout(250);
  const resetState = await page.evaluate(async () => {
    const store = await import('./lib/store.js');
    return { session: store.getSession(), event: store.getEvent('evt_demo_tokon'), bracket: store.get().brackets.evt_demo_tokon };
  });
  report.ok(`${tour.id}: reset hands back the borrowed demo identity`, resetState.session === null);
  report.ok(`${tour.id}: reset restores the sample tournament`,
    resetState.event?.status === 'checkin' && !resetState.bracket);
  report.ok(`${tour.id}: reset clears the tour card`,
    await page.evaluate(() => !document.querySelector('.tour-title')));
  report.ok(`${tour.id}: reset keeps the real session`,
    (await session())?.playerId === 'plr_real_preserved');
}

/* Alter the demo namespace, then use its launcher reset. The regular event,
   session, outbox, and snapshots must remain byte-for-byte unchanged. */
await page.goto(`${base}demo.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.dataset.demoReady === 'true');
await page.evaluate(async () => {
  const store = await import('./lib/store.js');
  store.apply('events', 'evt_demo_tokon', { name: 'Changed only in the demo' }, { queueIt: false });
  store.setSession({ playerId: 'plr_demo01', local: true, demo: true });
  localStorage.setItem('battydev.brackets.tour.step.demo', JSON.stringify(3));
  localStorage.setItem('battydev.brackets.tv.demo', JSON.stringify({ screen: 'bracket' }));
});
await page.getByRole('button', { name: 'Reset sample data' }).click();
await page.waitForFunction(() => document.querySelector('#demo-reset-status')?.textContent.includes('reset'));
const resetDemo = await page.evaluate(async () => {
  const store = await import('./lib/store.js');
  return {
    event: store.getEvent('evt_demo_tokon'),
    session: store.getSession(),
    tourStep: localStorage.getItem('battydev.brackets.tour.step.demo'),
    tv: localStorage.getItem('battydev.brackets.tv.demo'),
  };
});
const realStorageAfter = await realStorageSnapshot();
report.ok('entry reset restores the sample and clears its borrowed session and tour/display state',
  resetDemo.event?.name === 'Tokon Tuesdays #14' && resetDemo.session === null
    && resetDemo.tourStep === null && resetDemo.tv === null);
report.ok('entry reset leaves real event, session, queue, and snapshots untouched',
  JSON.stringify(realStorageAfter) === JSON.stringify(realStorageBefore));

await page.unroute('**/config.js');
await page.unroute('https://cdn.jsdelivr.net/**');
report.ok('configured demo mode never requests the backend client', backendModuleRequests === 0,
  `${backendModuleRequests} backend module request(s)`);
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(document.querySelector('main')?.textContent?.trim()));
const backToReal = await pageState();
report.ok('returning to the real app keeps its event and signed-in player',
  backToReal.realEvent?.name === 'Real event' && backToReal.session?.playerId === 'plr_real_preserved'
    && !backToReal.event && !backToReal.connected);
report.noErrors(errors);

await ctx.close();
await browser.close();
await close();
report.done();
