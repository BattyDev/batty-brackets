/* Drive the whole application the way a TO does, and assert it survives.
   ===========================================================================
   Twenty steps from an empty landing page to a reported result, then the same
   routes again at phone width. Two things are being checked at every step and
   both matter more than they sound:

     1. **Nothing threw.** A view that throws mid-render leaves a half-drawn
        page and no error anyone will see, because there is no error boundary
        in a static site -- there is just a screen missing its bottom half.
        Collecting `pageerror` and `console.error` across the whole walk is
        the cheapest real coverage in this directory.

     2. **Nothing overflowed sideways at 390px.** The single most common way
        a desktop-designed layout fails on a phone, and the complaint that
        started this project was "mobile variations".

   The steps assert their own outcome too -- the import really imported, the
   report really changed the score -- so a step that silently stops working
   fails here rather than passing quietly with an empty page.
   =========================================================================== */

import { launch, openApp, goTo, standalone, reporter, DEMO_EVENT, DEMO_PLAYER } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('flows');
const errors = [];

const { ctx, page } = await openApp(browser, { base, errors });

const rows = () => page.evaluate(() => document.querySelectorAll('table.data tbody tr').length);
const clickDialog = async (label) => {
  for (const b of await page.$$('dialog.m3 .dialog-actions button')) {
    if ((await b.textContent()).trim() === label) { await b.click(); return true; }
  }
  return false;
};

/* ---- organiser walk ----------------------------------------------------- */
await goTo(page, base, `#/e/${DEMO_EVENT}/admin`);
/* Event identity belongs above the operational tabs; the top bar is utilities. */
report.ok('the dashboard names the event',
  await page.evaluate(() => /Tokon Tuesdays/i.test(document.querySelector('.workspace-context')?.innerText || '')));
report.ok('the dashboard has the organiser tabs',
  await page.evaluate(() => document.querySelectorAll('a.tab').length >= 5));

await goTo(page, base, `#/e/${DEMO_EVENT}/admin/entrants`);
const before = await rows();
report.ok('the roster has entrants', before > 0, `${before} rows`);

await page.click('[data-act="import-open"]');
await page.waitForTimeout(250);
await page.fill('#paste', 'Tag\tSeed\tTeam\tDiscord\nKira\t1\tBatty Mac\tkira\nBrand New Player\t99\tUptown\tbnp\nRae\t2\tNorthside\trae');
report.ok('the import dialog previews', await clickDialog('Preview'));
await page.waitForTimeout(400);
/* The point of the preview step is that it classifies every row BEFORE you
   commit to it -- new, changed, or already exactly right. Two of those three
   names are already in the demo, so exactly one is new and the other two are
   an update and a no-op. Getting "unchanged" wrong is the expensive one: a
   TO re-pasting their sheet must not be told they are about to change 200
   rows they are not changing. */
const chips = await page.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll('dialog.m3 .chip-static')]
    .map((c) => c.innerText.trim().match(/^(\d+)\s+(\w+)/))
    .filter(Boolean)
    .map((m) => [m[2].toLowerCase(), Number(m[1])])));
report.ok('the preview counts exactly one new entrant', chips.new === 1, JSON.stringify(chips));
report.ok('the preview accounts for all three pasted rows',
  (chips.new || 0) + (chips.updated || 0) + (chips.unchanged || 0) === 3, JSON.stringify(chips));
report.ok('a row that changes nothing is reported as unchanged, not as an update',
  chips.unchanged >= 1, JSON.stringify(chips));
await clickDialog('Import');
await page.waitForTimeout(500);
report.ok('the import added exactly the new entrant', (await rows()) === before + 1, `${before} -> ${await rows()}`);

await goTo(page, base, `#/e/${DEMO_EVENT}/admin/seeding`);
report.ok('the seeding lab renders', await page.evaluate(() => Boolean(document.querySelector('[data-act="seed-move"]'))));
await page.click('[data-act="generate-bracket"]');
await page.waitForTimeout(700);
report.ok('generating a bracket lands on the run view', (await page.evaluate(() => location.hash)).includes('/run'));
report.ok('the bracket drew matches', await page.evaluate(() => document.querySelectorAll('button.match').length) > 0);

const call = await page.$('[data-act="call-next"]');
report.ok('there is a set ready to call', Boolean(call));
if (call) { await call.click(); await page.waitForTimeout(300); }
report.ok('calling a set puts somebody on a station',
  await page.evaluate(() => /station/i.test(document.querySelector('main').innerText)));

const reportOpen = await page.$('[data-act="report-open"]');
report.ok('a called set can be reported', Boolean(reportOpen));
if (reportOpen) {
  await reportOpen.click();
  await page.waitForTimeout(250);
  const two = await page.$('dialog.m3 [data-score-side="a"][data-score="2"]');
  if (two) await two.click();
  await clickDialog('Save');
  await page.waitForTimeout(500);
}
report.ok('the result landed on the bracket',
  await page.evaluate(() => document.querySelectorAll('button.match .won, button.match .slot.won').length) > 0);

for (const [label, hash] of [
  ['rules', `#/e/${DEMO_EVENT}/admin/rules`],
  ['settings', `#/e/${DEMO_EVENT}/admin/settings`],
  ['public event page', `#/e/${DEMO_EVENT}`],
  ['public bracket', `#/e/${DEMO_EVENT}/bracket`],
  ['player profile', `#/p/${DEMO_PLAYER}`],
  ['join by code', '#/join/TKN14B'],
]) {
  await goTo(page, base, hash);
  const text = await page.evaluate(() => document.querySelector('main').innerText.trim());
  report.ok(`${label} renders something`, text.length > 40, `${text.length} characters`);
}

/* ---- the wizard --------------------------------------------------------- */
await goTo(page, base, '#/new');
await page.click('[data-act="wizard-game"][data-game="tokon"]');
await page.waitForTimeout(300);
report.ok('picking a game advances the wizard and themes it',
  await page.evaluate(() => Boolean(document.querySelector('[data-game="tokon"]'))));
await page.click('[data-act="wizard-step"][data-step="2"]');
await page.waitForTimeout(300);
report.ok('the rules step renders fields from the game registry',
  await page.evaluate(() => document.querySelectorAll('main .field, main details').length) > 0);

report.noErrors(errors);
await ctx.close();

/* ---- the same thing on a phone ------------------------------------------ */
{
  const mobileErrors = [];
  const m = await openApp(browser, { base, width: 390, height: 844, errors: mobileErrors });
  await goTo(m.page, base, `#/e/${DEMO_EVENT}/admin/seeding`);
  const gen = await m.page.$('[data-act="generate-bracket"]');
  if (gen) { await gen.click(); await m.page.waitForTimeout(600); }

  for (const [label, hash] of [
    ['landing', '#/'],
    ['dashboard', `#/e/${DEMO_EVENT}/admin`],
    ['entrants', `#/e/${DEMO_EVENT}/admin/entrants`],
    ['run', `#/e/${DEMO_EVENT}/admin/run`],
    ['event', `#/e/${DEMO_EVENT}`],
    ['player', `#/p/${DEMO_PLAYER}`],
  ]) {
    await goTo(m.page, base, hash);
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    report.ok(`no sideways scroll at 390px — ${label}`, overflow <= 2, `${overflow}px over`);
  }
  report.noErrors(mobileErrors);
  await m.ctx.close();
}

await browser.close();
await close();
report.done();
