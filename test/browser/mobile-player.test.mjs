/* The player path is a sequence, not a collection of responsive screenshots.
   ===========================================================================
   A phone arrives through an invite, signs in, decides whether to enter, gets
   ready, and eventually has to answer one urgent question in a noisy room:
   where do I go? This suite walks that same state machine at the two widths
   most likely to expose false "mobile" layouts.

   The setup remains device-local on purpose. Until a backend has passed its
   own permission and cross-device rehearsal, this test must not imply that a
   second phone can see the organiser's event. It proves the local experience
   and the copy around that boundary.
   =========================================================================== */

import { launch, openApp, goTo, standalone, reporter, DEMO_EVENT } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('mobile-player');

const fits = page => page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  body: document.body.scrollWidth - document.documentElement.clientWidth,
}));

const entryForMe = page => page.evaluate(async (eventId) => {
  const store = await import('./lib/store.js');
  const auth = await import('./lib/auth.js');
  const me = auth.currentPlayer();
  return me ? store.entryFor(eventId, me.id) : null;
}, DEMO_EVENT);

async function clickDialog(page, label) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForTimeout(120);
}

async function exercise(width) {
  const errors = [];
  const { ctx, page } = await openApp(browser, {
    base, width, height: 844, reducedMotion: 'reduce', errors,
  });

  /* The demo is normally in check-in. Put this isolated browser copy back in
     registration so the invitation path can be exercised without creating a
     fake connected event or touching another suite's context. */
  await page.evaluate(async (eventId) => {
    const store = await import('./lib/store.js');
    store.apply('events', eventId, { status: 'registration' }, { queueIt: false });
  }, DEMO_EVENT);
  await goTo(page, base, '#/join/TKN14B');

  report.ok(`${width}px: invite resolves to the intended event`,
    (await page.locator('main').innerText()).includes('Tokon Tuesdays #14'));
  report.ok(`${width}px: invite screen fits`, (await fits(page)).overflow <= 2,
    JSON.stringify(await fits(page)));

  await page.locator('[data-act="join-event"]').click();
  await page.waitForSelector('dialog.m3[open]');
  const authCopy = await page.locator('dialog.m3').innerText();
  report.ok(`${width}px: sign-in names the pending join`,
    /sign in to join this event/i.test(authCopy) && /confirm your entry/i.test(authCopy), authCopy.slice(0, 240));
  report.ok(`${width}px: local boundary is explicit`,
    /no server is connected|does not sync anywhere|another phone/i.test(authCopy), authCopy.slice(0, 240));
  report.ok(`${width}px: local mode does not offer fake email auth`,
    await page.locator('#sign-email').isDisabled());

  await page.locator('#sign-local').click();
  await page.locator('#tag').fill(`Phone ${width}`);
  await clickDialog(page, 'Continue');
  await page.waitForFunction(() => location.hash === '#/join/TKN14B');
  report.ok(`${width}px: sign-in preserves the invite route`, page.url().endsWith('#/join/TKN14B'));
  report.ok(`${width}px: sign-in alone creates no entry`, !(await entryForMe(page)));
  report.ok(`${width}px: entry still requires explicit confirmation`,
    /Enter this event/i.test(await page.locator('[data-act="join-event"]').innerText()));

  await page.locator('[data-act="join-event"]').click();
  await page.waitForURL(`**/#/e/${DEMO_EVENT}`);
  report.ok(`${width}px: confirmation creates the entrant`, Boolean(await entryForMe(page)));

  const deskText = await page.locator('.player-now').innerText();
  report.ok(`${width}px: entrant status and next task are immediate`,
    /Entered/i.test(deskText) && /NEXT TASK/i.test(deskText) && /Sign Code of conduct/i.test(deskText), deskText.slice(0, 300));
  report.ok(`${width}px: event information follows the action desk`, await page.evaluate(() => {
    const desk = document.querySelector('.player-now');
    const secondary = document.querySelector('.player-secondary');
    return Boolean(desk && secondary && (desk.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING));
  }));
  report.ok(`${width}px: ordering guard rejects the old navigation-first layout`, await page.evaluate(() => {
    const desk = document.querySelector('.player-now');
    const secondary = document.querySelector('.player-secondary');
    if (!desk || !secondary) return false;
    desk.before(secondary);
    const rejects = !(desk.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING);
    desk.after(secondary);
    return rejects;
  }));

  await page.locator('[data-act="sign-doc"]').first().click();
  await page.locator('#signature').fill(`Phone ${width}`);
  await clickDialog(page, 'Agree and sign');
  report.ok(`${width}px: signing advances rather than checking in silently`,
    /Check-in has not opened/i.test(await page.locator('#next-task-heading').innerText())
      && !(await entryForMe(page)).checkedInAt);

  await page.evaluate(async (eventId) => {
    const store = await import('./lib/store.js');
    store.apply('events', eventId, { status: 'checkin' }, { queueIt: false });
  }, DEMO_EVENT);
  await goTo(page, base, `#/e/${DEMO_EVENT}`);
  report.ok(`${width}px: check-in becomes the next explicit task`,
    /Check in now/i.test(await page.locator('#next-task-heading').innerText()));
  await page.locator('[data-act="self-checkin"]').first().click();
  await page.waitForFunction(async (eventId) => {
    const store = await import('./lib/store.js');
    const auth = await import('./lib/auth.js');
    return Boolean(store.entryFor(eventId, auth.currentPlayer().id)?.checkedInAt);
  }, DEMO_EVENT);
  report.ok(`${width}px: check-in updates entrant status`,
    /Checked in/i.test(await page.locator('.player-greeting').innerText()));

  /* A minimal called match isolates the player presentation from organiser
     controls. The player view only needs the same persisted fields a real
     call action writes: entrants, call time and station id. */
  const call = await page.evaluate(async ({ eventId, width: viewportWidth }) => {
    const store = await import('./lib/store.js');
    const auth = await import('./lib/auth.js');
    const mine = store.entryFor(eventId, auth.currentPlayer().id);
    const opponent = store.entriesFor(eventId).find((entry) => entry.id !== mine.id && !entry.waitlisted);
    const station = Object.values(store.get().stations).find((row) => row.eventId === eventId);
    const bracket = {
      id: eventId, eventId, type: 'double', createdAt: new Date().toISOString(),
      matches: [{
        id: `mt_mobile_${viewportWidth}`, bracket: 'W', round: 1, name: 'Winners Round 1',
        state: null, cancelled: false, calledAt: new Date().toISOString(), stationId: station.id,
        slots: [
          { entrantId: mine.id, seed: mine.seed },
          { entrantId: opponent.id, seed: opponent.seed },
        ],
      }],
    };
    store.apply('brackets', eventId, bracket, { queueIt: false });
    return { station: station.label, opponent: store.getPlayer(opponent.playerId).tag };
  }, { eventId: DEMO_EVENT, width });
  await goTo(page, base, `#/e/${DEMO_EVENT}`);
  const current = await page.locator('[aria-labelledby="current-set-heading"]').innerText();
  report.ok(`${width}px: current call leads with station and opponent`,
    current.includes('GO NOW') && current.includes(call.station) && current.includes(call.opponent), current);

  await goTo(page, base, '#/me');
  const profile = await page.locator('.player-passport').innerText();
  report.ok(`${width}px: passport repeats the urgent station call`,
    profile.includes('Called now') && profile.includes(call.station), profile.slice(0, 350));

  for (const [label, hash] of [
    ['event desk', `#/e/${DEMO_EVENT}`],
    ['bracket', `#/e/${DEMO_EVENT}/bracket`],
    ['rules', `#/e/${DEMO_EVENT}/rules`],
    ['passport', '#/me'],
  ]) {
    await goTo(page, base, hash);
    const overflow = await fits(page);
    report.ok(`${width}px: ${label} has no sideways page scroll`, overflow.overflow <= 2, JSON.stringify(overflow));
  }

  report.noErrors(errors);
  await ctx.close();
}

try {
  for (const width of [390, 320]) await exercise(width);
} finally {
  await browser.close();
  await close();
}
report.done();
