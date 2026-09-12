/* Creating an event: the sign-in gate, the draft that survives it, and who
   can find the result.
   ===========================================================================
   ## The gate

   You can walk the whole wizard as a guest and you cannot finish it as one.
   That split is the opposite of what most sites do -- demand an account on
   the first screen, before you know whether the thing is any good -- and it
   only works if the gate is genuinely free: the draft has to survive signing
   in, including the Discord round trip that leaves the page entirely.

   So the assertions are in two halves, and the second is the one that matters:
   the gate stops the publish, AND nothing you typed is lost.

   ## Visibility

   An unlisted event must be missing from a non-organiser's events list while
   remaining present at its own URL and in the organiser's same-device list.
   Testing only the first half would pass with a feature that simply deleted
   the event.

   ## The Discord button

   It used to silently mint a local profile called "Local TO" and return as
   though OAuth had worked, which is why it was reported as broken -- it was
   not erroring, it was pretending. With no server there is no Discord, and
   the UI has to say that rather than fake it.
   =========================================================================== */

import { launch, openApp, goTo, standalone, reporter } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('events');

const stored = (page, key) => page.evaluate((k) => {
  try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
}, key);
const eventCount = async (page) => Object.keys((await stored(page, 'battydev.brackets.state.v1'))?.events || {}).length;

/* Fill the wizard in far enough that publishing is legal. */
async function fillWizard(page, { name = 'Gate Test Weekly' } = {}) {
  await goTo(page, base, '#/new');
  await page.click('[data-act="wizard-game"][data-game="tokon"]');
  await page.waitForTimeout(250);
  await page.fill('input[data-field="name"]', name);
  await page.click('[data-act="wizard-step"][data-step="1"]');
  await page.waitForTimeout(250);
  await page.fill('input[data-field="venue"]', 'Batty Mac Arcade');
  await page.fill('input[data-field="stationCount"]', '4');
  await page.waitForTimeout(200);
}

const goToStep = async (page, step) => {
  await page.click(`[data-act="wizard-step"][data-step="${step}"]`);
  await page.waitForTimeout(300);
};

/* Publishing leaves the "Event created" dialog open over the organiser view
   on purpose -- it holds the invite code and a shortcut to adding entrants --
   so anything that clicks afterwards has to dismiss it first. */
const dismissDialogs = async (page) => {
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await page.waitForTimeout(150);
};

/* Sign in with a device account, which is what "sign in" means with no
   backend configured. */
async function signInLocally(page, tag = 'Cody') {
  await page.click('#sign-local');
  await page.waitForTimeout(300);
  await page.fill('#tag', tag);
  for (const b of await page.$$('dialog.m3 .dialog-actions button')) {
    if ((await b.textContent()).trim() === 'Continue') await b.click();
  }
  await page.waitForTimeout(800);
}

/* ---- the gate --------------------------------------------------------- */
{
  const errors = [];
  const { ctx, page } = await openApp(browser, { base, errors });
  await fillWizard(page);

  /* The draft has to outlive a reload before it can be claimed to outlive an
     OAuth redirect, which is the same thing plus a detour. */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.textContent?.trim()));
  await goTo(page, base, '#/new');
  report.ok('the draft survives a reload',
    (await page.evaluate(() => document.querySelector('input[data-field="name"]')?.value)) === 'Gate Test Weekly');

  await goToStep(page, 4);
  const label = await page.evaluate(() => document.querySelector('[data-act="wizard-publish"]')?.innerText.trim());
  report.ok('the button says the gate is coming before you hit it', /sign in/i.test(label || ''), label);
  report.ok('and so does a banner',
    await page.evaluate(() => /asked to sign in/i.test(document.querySelector('main')?.innerText || '')));

  /* Tōkon's presets are provisional. A guest can still reach the gate, but
     the organiser must explicitly acknowledge the final rules first. */
  await page.check('[data-act-change="wizard-provisional-review"]');

  const before = await eventCount(page);
  await page.click('[data-act="wizard-publish"]');
  await page.waitForTimeout(500);

  report.ok('publishing as a guest opens sign-in instead',
    await page.evaluate(() => Boolean(document.querySelector('dialog.m3[open]'))));
  report.ok('the dialog says why it appeared rather than showing a generic prompt',
    await page.evaluate(() => /accountable|sign in to create/i.test(document.querySelector('dialog.m3')?.innerText || '')),
    await page.evaluate(() => document.querySelector('dialog.m3')?.innerText.replace(/\s+/g, ' ').slice(0, 120)));
  report.ok('it promises the draft is safe',
    await page.evaluate(() => /saved on your device|stays exactly/i.test(document.querySelector('dialog.m3')?.innerText || '')));
  report.ok('no event was created', (await eventCount(page)) === before, `${before} -> ${await eventCount(page)}`);

  /* ---- the Discord button is honest about having no server ---- */
  report.ok('with no server, Discord sign-in is offered as unavailable rather than faked',
    await page.evaluate(() => document.querySelector('#sign-discord')?.disabled === true));
  report.ok('and the dialog explains why',
    await page.evaluate(() => /no server is connected/i.test(document.querySelector('dialog.m3')?.innerText || '')));
  report.ok('a device account is offered in its place',
    await page.evaluate(() => Boolean(document.querySelector('#sign-local'))));

  /* ---- signing in resumes the publish ---- */
  await signInLocally(page);

  report.ok('signing in creates the event that was waiting', (await eventCount(page)) === before + 1,
    `${before} -> ${await eventCount(page)}`);
  report.ok('and lands on its organiser view',
    /#\/e\/evt_[a-z0-9]+\/admin/.test(await page.evaluate(() => location.hash)),
    await page.evaluate(() => location.hash));
  /* A draft left on disk would reopen the wizard pre-filled with an event
     that already exists, and the next publish would make a second copy. */
  report.ok('the draft is cleared once it becomes an event',
    await page.evaluate(() => { try { return !localStorage.getItem('battydev.brackets.draft'); } catch { return true; } }));
  report.noErrors(errors);
  await ctx.close();
}

/* ---- local-only setup options ------------------------------------------- */
{
  const errors = [];
  const { ctx, page } = await openApp(browser, { base, errors });
  await fillWizard(page, { name: 'Invitational' });

  await goToStep(page, 3);
  report.ok('local sign-ups hide the visibility choice that needs a backend',
    await page.evaluate(() => !document.querySelector('[data-act="wizard-set"][data-field="visibility"]')));
  report.ok('local sign-ups explain how to add people and use the TV',
    await page.evaluate(() => /stay on this device|venue TV/i.test(document.querySelector('main')?.innerText || '')));

  await goToStep(page, 4);
  await page.check('[data-act-change="wizard-provisional-review"]');

  await page.click('[data-act="wizard-publish"]');
  await page.waitForTimeout(400);
  await signInLocally(page);
  await dismissDialogs(page);

  const hash = await page.evaluate(() => location.hash);
  const eventId = hash.match(/evt_[a-z0-9]+/)?.[0];
  report.ok('the local event was created', Boolean(eventId), hash);

  const state = await stored(page, 'battydev.brackets.state.v1');
  const created = state.events[eventId];
  report.ok('local creation has no cross-device invite code', created?.inviteCode === null, created?.inviteCode);
  report.ok('local creation keeps the requested station count',
    Object.values(state.stations).filter((station) => station.eventId === eventId).length === 4);

  /* Visibility remains an event setting for an organiser, even though the
     local setup wizard hides it because local invite/listing controls do not
     work across devices. Keep this coverage in the same state that contains
     the event; a fresh context would silently pass against an empty list. */
  await page.evaluate(async (id) => {
    const store = await import('./lib/store.js');
    store.apply('events', id, { visibility: 'unlisted' }, { queueIt: false });
  }, eventId);
  await goTo(page, base, `#/e/${eventId}`);
  report.ok('an unlisted local event still opens at its own address',
    await page.evaluate((name) => document.body.innerText.includes(name), 'Invitational'));
  await goTo(page, base, '#/');
  report.ok('the organiser still sees the unlisted event in the same device list',
    await page.evaluate((name) => document.body.innerText.includes(name), 'Invitational'));

  await page.evaluate(async () => {
    const auth = await import('./lib/auth.js');
    auth.signInLocal({ tag: 'Visitor' });
  });
  await goTo(page, base, '#/');
  report.ok('a different local account does not see the unlisted event',
    await page.evaluate((name) => !document.body.innerText.includes(name), 'Invitational'));

  await page.evaluate(async () => {
    const auth = await import('./lib/auth.js');
    auth.signInLocal({ tag: 'Cody' });
  });
  await goTo(page, base, `#/e/${eventId}/admin/settings`);
  report.ok('the organiser can still change visibility from settings',
    await page.locator('[data-act="event-visibility"]').count() === 2);
  await page.locator('[data-act="event-visibility"][data-value="public"]').click();
  await page.waitForTimeout(400);
  const after = await stored(page, 'battydev.brackets.state.v1');
  report.ok('flipping it back to listed takes effect immediately',
    after.events[eventId]?.visibility === 'public', after.events[eventId]?.visibility);

  await page.evaluate(async () => {
    const auth = await import('./lib/auth.js');
    auth.signInLocal({ tag: 'Visitor' });
  });
  await goTo(page, base, '#/');
  report.ok('a listed event becomes visible to the other local account',
    await page.evaluate((name) => document.body.innerText.includes(name), 'Invitational'));

  report.noErrors(errors);
  await ctx.close();
}

await browser.close();
await close();
report.done();
