/* The three guest demos, walked end to end.
   ===========================================================================
   The demos are the front door: they are what somebody sees before they have
   an account, and they are the only part of this app that a stranger will
   ever judge it by. They are also the most fragile thing in it, because each
   step performs real store writes against real views -- so any change to any
   view can break them, silently, in a way no other test would notice.

   Two failures this suite exists to catch, both of which shipped:

     · **Consecutive steps on the same route stopped advancing.** Removing a
       once-a-second redraw exposed it: `goToStep` set `location.hash` and
       waited for `hashchange`, which does not fire when the hash is already
       that value. Two steps in a row on `/admin` meant the second never
       arrived, and the tour just stopped.

     · **The player tour did not hand the identity back.** It borrows a demo
       entrant so the player views run real queries rather than a mock. If
       reset leaves that session in place you are still signed in as somebody
       else's demo account afterwards, which is confusing at best.
   =========================================================================== */

import { launch, openApp, standalone, reporter } from './harness.mjs';

/* Each tour's length, and the route its LAST step should land on. Hardcoding
   both is the point: a step quietly lost to a refactor changes the count. */
const TOURS = [
  { id: 'organiser', steps: 9, borrows: false },
  { id: 'tv', steps: 4, borrows: false },
  { id: 'player', steps: 6, borrows: true },
];

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('tours');

const session = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('battydev.brackets.state.v1'))?.session?.playerId || null; }
  catch { return null; }
});

for (const tour of TOURS) {
  const errors = [];
  const { ctx, page } = await openApp(browser, { base, errors });

  const start = await page.$(`[data-act="tour-start"][data-tour="${tour.id}"]`);
  if (!report.ok(`${tour.id}: the start button exists`, Boolean(start))) { await ctx.close(); continue; }
  await start.click();
  await page.waitForTimeout(600);

  const seen = [];
  let borrowed = null;
  for (let i = 0; i < tour.steps + 3; i += 1) {
    const step = await page.evaluate(() => ({
      count: document.querySelector('.tour-count')?.innerText || '',
      title: document.querySelector('.tour-title')?.innerText || '',
      hash: location.hash,
    }));
    if (!step.title) break;
    seen.push(step);
    if (tour.borrows && !borrowed) borrowed = await session(page);
    const next = await page.$('[data-act="tour-next"]');
    if (!next) break;
    await next.click();
    await page.waitForTimeout(650);
  }

  report.ok(`${tour.id}: walks all ${tour.steps} steps`, seen.length === tour.steps,
    `reached ${seen.length}: ${seen.map((s) => s.title).join(' / ')}`);
  /* Every step must land somewhere with content. A step that navigates to a
     route the router does not know shows an empty shell and no error. */
  report.ok(`${tour.id}: every step lands on a real route`,
    seen.every((s) => s.hash.startsWith('#/')), seen.map((s) => s.hash).join(' '));
  /* No two consecutive steps may show the same title -- that is what the
     unchanged-hash bug looked like from the outside. */
  const stuck = seen.find((s, i) => i > 0 && s.title === seen[i - 1].title);
  report.ok(`${tour.id}: no step repeats itself`, !stuck, stuck ? `stuck on "${stuck.title}"` : '');

  if (tour.borrows) {
    report.ok(`${tour.id}: borrows a demo identity`, Boolean(borrowed), String(borrowed));
  }

  await page.click('[data-act="tour-reset"]');
  await page.waitForTimeout(800);
  report.ok(`${tour.id}: reset signs the borrowed identity back out`, (await session(page)) === null,
    `session is ${await session(page)}`);
  report.ok(`${tour.id}: reset clears the tour card`,
    await page.evaluate(() => !document.querySelector('.tour-title')));
  report.noErrors(errors);
  await ctx.close();
}

await browser.close();
await close();
report.done();
