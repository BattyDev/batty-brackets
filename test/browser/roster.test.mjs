/* Sorting and filtering the entrant roster.
   ===========================================================================
   A roster table is where a TO spends the twenty minutes before doors, and
   the two things they do with it are "sort by this" and "show me only the
   ones who have not paid". Both are easy to get subtly wrong:

     · a sort that reorders the DISPLAY while the buttons edit the STORED
       order -- which is exactly what the seeding lab did, so a move looked
       like it did nothing
     · a select-all that selects rows the filter is hiding, which is how you
       accidentally check in the whole event instead of the four people in
       front of you

   Both are asserted here. The second is the dangerous one.
   =========================================================================== */

import { launch, openApp, goTo, standalone, reporter, DEMO_EVENT } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('roster');
const errors = [];

const { ctx, page } = await openApp(browser, { base, width: 1400, height: 1000, errors });
await goTo(page, base, `#/e/${DEMO_EVENT}/admin/entrants`);

/* Read one column out of the table. Cells may hold an input (the grid is
   editable in place) so prefer its value over the text. */
const column = (n) => page.evaluate((i) => [...document.querySelectorAll(`table.data tbody tr td:nth-child(${i})`)]
  .map((td) => td.querySelector('input')?.value ?? td.innerText.trim()), n);
const rowCount = () => page.evaluate(() => document.querySelectorAll('table.data tbody tr').length);

const TAG_COL = 3;
const all = await rowCount();
report.ok('the roster has rows to sort', all > 4, `${all} rows`);

/* ---- sorting ------------------------------------------------------------ */
await page.click('th button[data-col="tag"]');
await page.waitForTimeout(300);
const asc = await column(TAG_COL);
const sortedAsc = [...asc].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
report.ok('sorting by tag ascending really sorts', asc.join('|') === sortedAsc.join('|'), asc.slice(0, 8).join(', '));

await page.click('th button[data-col="tag"]');
await page.waitForTimeout(300);
const desc = await column(TAG_COL);
report.ok('clicking the same header again reverses it', desc.join('|') === [...sortedAsc].reverse().join('|'),
  desc.slice(0, 8).join(', '));

/* aria-sort is how a screen reader user knows the click did anything at all.
   Exactly one column may claim it. */
const sortStates = await page.evaluate(() => [...document.querySelectorAll('th[aria-sort]')]
  .map((th) => th.getAttribute('aria-sort')).filter((s) => s !== 'none'));
report.ok('exactly one column advertises aria-sort', sortStates.length === 1, sortStates.join(', '));

await page.click('th button[data-col="seed"]');
await page.waitForTimeout(300);
const seeds = (await column(2)).map(Number).filter((n) => !Number.isNaN(n));
report.ok('sorting by seed is numeric, not lexical',
  seeds.every((n, i) => i === 0 || seeds[i - 1] <= n), seeds.slice(0, 12).join(', '));

/* ---- filtering ---------------------------------------------------------- */
await page.click('[data-act="entrant-filter"][data-filter="not-in"]');
await page.waitForTimeout(300);
const notIn = await rowCount();
report.ok('a filter actually removes rows', notIn > 0 && notIn < all, `${all} -> ${notIn}`);

/* Filters within one group are alternatives, not additions: "checked in" must
   replace "not checked in" rather than intersecting with it to nothing. */
await page.click('[data-act="entrant-filter"][data-filter="in"]');
await page.waitForTimeout(300);
const checkedIn = await rowCount();
report.ok('an opposite filter replaces rather than intersects', checkedIn > 0, `${checkedIn} rows`);
report.ok('the replaced filter is no longer pressed',
  await page.evaluate(() => document.querySelector('[data-act="entrant-filter"][data-filter="not-in"]')?.getAttribute('aria-pressed')) !== 'true');
report.ok('checked-in and not-checked-in account for every row', checkedIn + notIn === all,
  `${checkedIn} + ${notIn} != ${all}`);

/* Filters from different groups DO combine. */
await page.click('[data-act="entrant-filter"][data-filter="unpaid"]');
await page.waitForTimeout(300);
const both = await rowCount();
report.ok('filters from different groups combine', both <= checkedIn, `${both} <= ${checkedIn}`);

/* ---- select-all is scoped to what you can see --------------------------- */
await page.click('#select-all');
await page.waitForTimeout(300);
const selected = await page.evaluate(() => {
  const m = document.querySelector('.bulk-bar')?.innerText.match(/(\d+)/);
  return m ? Number(m[1]) : null;
});
report.ok('select-all selects only the filtered rows, not the whole roster', selected === both,
  `selected ${selected}, showing ${both}, roster ${all}`);

await page.click('[data-act="entrant-filter-clear"]');
await page.waitForTimeout(300);
report.ok('clearing filters restores every row', (await rowCount()) === all);
/* Clearing has to drop the selection too. Leaving 4 rows selected while
   showing 28 is a bulk action pointed at something you can no longer see. */
report.ok('clearing filters also clears the selection',
  await page.evaluate(() => !document.querySelector('.bulk-bar')));

report.noErrors(errors);
await ctx.close();
await browser.close();
await close();
report.done();
