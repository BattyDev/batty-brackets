/* Where the page ends up, and what the theme button does.
   ===========================================================================
   Two shell-level behaviours, both reported by a user, both invisible to
   every other suite because both are about the frame rather than the content.

   ## Scroll position

   "Clicking start a new event leaves you in the middle of the screen." It
   did. The router focuses `<main>` with `preventScroll: true` -- correct in
   itself, because moving focus must not yank the page around -- and nothing
   else moved the page, so a navigation from halfway down a list dropped you
   halfway down the next screen.

   The naive fix is wrong in two directions at once, and both are asserted
   here: scrolling to the top on every DRAW throws a TO back to the top of the
   roster every time they check somebody in, and scrolling to the top on Back
   loses the position in the list they came from.

   ## The theme button

   "I have to click dark mode twice to switch to light mode." With no
   preference stored the page follows the system, so on a system-dark machine
   the first click stored "dark" -- which the page already looked like. The
   test is deliberately phrased as **the first click must visibly change the
   background**, because that is the user-visible promise; any state machine
   that keeps it is fine.
   =========================================================================== */

import { launch, openApp, goTo, standalone, reporter, DEMO_EVENT } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('navigation');
const errors = [];

const { ctx, page } = await openApp(browser, { base, width: 1280, height: 600, errors });
const scrollY = () => page.evaluate(() => window.scrollY);

/* ---- forward navigation starts at the top ------------------------------- */
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(150);
const landingY = await scrollY();
report.ok('the landing page is long enough for this test to mean anything', landingY > 200, `${landingY}px`);

/* Whichever control the landing page is showing -- the signed-out card's
   button or the dashboard's floating action button. Scrolled halfway down and
   clicking it is not a contrived case: the FAB is fixed to the viewport, so
   that is the only way it is ever clicked from down a long list. */
const newEvent = await page.$('.host-door a[href="#/new"]');
report.ok('the landing page has the new-event button', Boolean(newEvent));
// Invoke the real link without Playwright scrolling it into view first;
// this assertion is about router scroll restoration, not locator auto-scroll.
await newEvent.evaluate(el => el.click());
await page.waitForTimeout(400);
report.ok('it went to the wizard', (await page.evaluate(() => location.hash)) === '#/new');
report.ok('navigating to a new page starts at the top', (await scrollY()) === 0, `${await scrollY()}px`);

/* ---- Back returns to where you were ------------------------------------- */
await page.goBack();
await page.waitForTimeout(500);
report.ok('Back restores the position you left from', Math.abs((await scrollY()) - landingY) < 5,
  `${await scrollY()} vs ${landingY}`);

/* ---- a store change must not move the page ------------------------------
   This is the half a `scrollTo(0,0)` on every draw would break, and it is the
   more annoying of the two: checking somebody in from the bottom of a 28-row
   roster and being thrown back to the top happens once per entrant. */
await goTo(page, base, `#/e/${DEMO_EVENT}/admin/entrants`);
await page.evaluate(() => window.scrollTo(0, 600));
await page.waitForTimeout(200);
const checkbox = await page.$('table.data tbody tr:nth-child(20) input[type="checkbox"]');
// Establish the viewport after exposing the target, so locator auto-scroll
// is not mistaken for application scroll movement after an edit.
if (checkbox) await checkbox.scrollIntoViewIfNeeded();
await page.waitForTimeout(150);
const before = await scrollY();
report.ok('the roster is long enough to scroll', before > 100, `${before}px`);
if (checkbox) await checkbox.click();
await page.waitForTimeout(400);
report.ok('editing a row does not move the page', (await scrollY()) === before, `${before} -> ${await scrollY()}`);

/* Nor does the once-a-second clock tick. */
await page.waitForTimeout(1800);
report.ok('the live clock tick does not move the page', (await scrollY()) === before, `${before} -> ${await scrollY()}`);

report.noErrors(errors);
await ctx.close();

/* ---- the theme button, from both system defaults ------------------------ */
for (const scheme of ['dark', 'light']) {
  const themeErrors = [];
  const t = await openApp(browser, { base, scheme, errors: themeErrors });
  const background = () => t.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const label = () => t.page.evaluate(() => document.querySelector('[data-act="theme"]')?.getAttribute('aria-label'));

  const start = await background();
  const startLabel = await label();
  report.ok(`system ${scheme}: the button says where it will take you`,
    new RegExp(`Switch to ${scheme === 'dark' ? 'light' : 'dark'} theme`, 'i').test(startLabel || ''), startLabel);

  await t.page.click('[data-act="theme"]');
  await t.page.waitForTimeout(300);
  const after = await background();
  /* THE bug. One click, one visible change, from either system default. */
  report.ok(`system ${scheme}: one click visibly changes the theme`, after !== start, `${start} -> ${after}`);
  report.ok(`system ${scheme}: the label flips with it`, (await label()) !== startLabel, await label());

  /* Following the system is still reachable, just not as a third of a cycle. */
  const useSystem = await t.page.$('.snackbar button');
  report.ok(`system ${scheme}: returning to the system theme is still offered`, Boolean(useSystem),
    await t.page.evaluate(() => document.querySelector('.snackbar')?.innerText));
  if (useSystem) {
    await useSystem.click();
    await t.page.waitForTimeout(300);
    report.ok(`system ${scheme}: "Use system" goes back to following the system`, (await background()) === start,
      `${await background()} vs ${start}`);
    report.ok(`system ${scheme}: and stores no preference`,
      await t.page.evaluate(() => { try { return !localStorage.getItem('battydev.brackets.theme'); } catch { return true; } }));
  }

  /* A stored choice has to survive a reload -- a theme that resets on refresh
     is the same complaint in slower form. */
  await t.page.click('[data-act="theme"]');
  await t.page.waitForTimeout(250);
  const chosen = await background();
  await t.page.reload({ waitUntil: 'domcontentloaded' });
  await t.page.waitForFunction(() => Boolean(document.querySelector('main')?.textContent?.trim()));
  report.ok(`system ${scheme}: the choice survives a reload`, (await background()) === chosen,
    `${await background()} vs ${chosen}`);
  report.noErrors(themeErrors);
  await t.ctx.close();
}

await browser.close();
await close();
report.done();
