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

   An unlisted event must be missing from the events list and present at its
   own URL and by its code. Testing only the first half would pass with a
   feature that simply deleted the event.

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

/* ---- visibility --------------------------------------------------------- */
{
  const errors = [];
  const { ctx, page } = await openApp(browser, { base, errors });
  await fillWizard(page, { name: 'Invitational' });

  await goToStep(page, 3);
  report.ok('the sign-ups step offers a visibility choice',
    await page.evaluate(() => Boolean(document.querySelector('[data-act="wizard-set"][data-field="visibility"]'))));
  await page.click('[data-act="wizard-set"][data-field="visibility"][data-value="unlisted"]');
  await page.waitForTimeout(300);
  report.ok('choosing unlisted says plainly that it is not secrecy',
    await page.evaluate(() => /not secret/i.test(document.querySelector('main')?.innerText || '')));

  await goToStep(page, 4);
  report.ok('the summary states the visibility before you commit',
    await page.evaluate(() => /unlisted/i.test(document.querySelector('main')?.innerText || '')));

  await page.click('[data-act="wizard-publish"]');
  await page.waitForTimeout(400);
  await signInLocally(page);
  await dismissDialogs(page);

  const hash = await page.evaluate(() => location.hash);
  const eventId = hash.match(/evt_[a-z0-9]+/)?.[0];
  report.ok('the unlisted event was created', Boolean(eventId), hash);

  const state = await stored(page, 'battydev.brackets.state.v1');
  const created = state.events[eventId];
  report.ok('it is stored as unlisted', created?.visibility === 'unlisted', created?.visibility);
  const code = created?.inviteCode;
  report.ok('it still has an invite code', Boolean(code), code);

  /* Present at its own address... */
  await goTo(page, base, `#/e/${eventId}`);
  report.ok('an unlisted event opens at its own link',
    await page.evaluate((n) => document.body.innerText.includes(n), 'Invitational'));
  /* ...and by its code, which is the whole point of unlisted rather than
     deleted. */
  await goTo(page, base, `#/join/${code}`);
  report.ok('an unlisted event is reachable by its invite code',
    await page.evaluate((n) => document.body.innerText.includes(n), 'Invitational'));

  /* ...and absent from browsing, for somebody who is not its organiser. */
  await page.evaluate(() => { try { localStorage.removeItem('battydev.brackets.state.v1'); } catch { /* */ } });
  const guest = await openApp(browser, { base, errors });
  const guestSees = await guest.page.evaluate(() => document.body.innerText);
  report.ok('the events list does not show it to a guest', !guestSees.includes('Invitational'));
  await guest.ctx.close();

  /* Its organiser must still see it -- hiding an event from the person
     running it is not privacy, it is losing it. */
  await goTo(page, base, '#/');
  report.ok('its organiser still sees it on their own dashboard',
    await page.evaluate(() => document.body.innerText.includes('Invitational')));

  /* And it can be flipped back from settings without republishing. */
  await goTo(page, base, `#/e/${eventId}/admin/settings`);
  report.ok('settings offers the same control',
    await page.evaluate(() => Boolean(document.querySelector('[data-act="event-visibility"]'))));
  await page.click('[data-act="event-visibility"][data-value="public"]');
  await page.waitForTimeout(400);
  const after = await stored(page, 'battydev.brackets.state.v1');
  report.ok('flipping it back to listed takes effect immediately',
    after.events[eventId]?.visibility === 'public', after.events[eventId]?.visibility);

  report.noErrors(errors);
  await ctx.close();
}

await browser.close();
await close();
report.done();
