/* The tour card must not move under the pointer.
   ===========================================================================
   This is a regression test for one specific reported bug, and it is the
   clearest argument in this directory for browser tests existing at all.

   The report was "the pop up for the demo keeps jumping when trying to use
   it, almost like it's closing and reopening over and over again". It was.
   The admin overview shows live "on station for 4m 12s" clocks, and keeping
   them honest was done the obvious way:

       setInterval(() => { if (route === 'admin') draw(); }, 1000);

   A full redraw once a second, which destroyed and rebuilt the tour card,
   replayed its entrance animation, and reset the pointer's idea of what it
   was hovering. Every second. You could not click Next.

   The fix separated the two: the card lives in a persistent `#chrome` node
   that is only rewritten when its markup actually changes, and the clocks
   update their own text in place. So this suite asserts BOTH halves --

     1. the card is the same DOM node six seconds later, and never moved
     2. the clock is still ticking

   -- because a fix that stopped the flicker by stopping the clock would pass
   half a test and fail a user.
   =========================================================================== */

import { launch, openApp, standalone, reporter } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('stability');
const errors = [];

const { ctx, page } = await openApp(browser, { base, errors });

/* Walk the organiser tour to the step on the run view -- the route where the
   live clocks are, which is where the redraw was. */
await page.click('[data-act="tour-start"][data-tour="organiser"]');
await page.waitForTimeout(600);
for (let i = 0; i < 5; i += 1) {
  const next = await page.$('[data-act="tour-next"]');
  if (!next) break;
  await next.click();
  await page.waitForTimeout(600);
}
report.ok('reached a tour step on a live-clock route',
  await page.evaluate(() => Boolean(document.querySelector('.tour-title'))));
report.ok('the page has a live clock on it',
  await page.evaluate(() => Boolean(document.querySelector('[data-live-since]'))));

const watched = await page.evaluate(() => new Promise((resolve) => {
  const first = document.querySelector('.tour');
  if (!first) return resolve({ error: 'no tour card' });
  let recreated = 0;
  let moved = 0;
  let lastTop = first.getBoundingClientRect().top;
  const obs = new MutationObserver(() => {
    const now = document.querySelector('.tour');
    if (now && now !== first) recreated += 1;
  });
  obs.observe(document.body, { childList: true, subtree: true });
  const iv = setInterval(() => {
    const now = document.querySelector('.tour');
    if (!now) return;
    const top = now.getBoundingClientRect().top;
    if (Math.abs(top - lastTop) > 1) moved += 1;
    lastTop = top;
  }, 100);
  setTimeout(() => {
    obs.disconnect();
    clearInterval(iv);
    resolve({ recreated, moved, sameNode: document.querySelector('.tour') === first });
  }, 6000);
}));

report.ok('the tour card is never rebuilt while it sits there', watched.recreated === 0, JSON.stringify(watched));
report.ok('the tour card never moves', watched.moved === 0, JSON.stringify(watched));
report.ok('it is still literally the same element six seconds later', watched.sameNode === true, JSON.stringify(watched));

/* ---- and the clock the redraw existed for still works ------------------- */
const t1 = await page.evaluate(() => document.querySelector('[data-live-since]')?.textContent);
await page.waitForTimeout(2500);
const t2 = await page.evaluate(() => document.querySelector('[data-live-since]')?.textContent);
report.ok('the live clock is still ticking', Boolean(t1) && t1 !== t2, `${t1} -> ${t2}`);

report.noErrors(errors);
await ctx.close();
await browser.close();
await close();
report.done();
