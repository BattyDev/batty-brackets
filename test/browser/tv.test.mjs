/* The venue display: both screens, the rotation, and the columns having data.
   ===========================================================================
   The TV view is the one nobody is standing in front of with a keyboard, so
   it fails quietly. It already did, twice:

     · **Eight perfectly sized empty columns.** Rounds were chosen by width
       alone -- four matches or fewer, so names draw big -- and mid-event the
       deepest round anybody has reached is usually the WIDE one. The filter
       kept only rounds nobody had got to yet. Every column was correct and
       every column was blank.
     · **Readable columns shrunk to eleven pixels.** The first fix scaled all
       columns to fit the widest, so one round of eight dragged a two-match
       semi-final down with it.

   So the assertion that matters here is not "the bracket screen rendered" --
   it did, both times. It is **at least one visible column has names in it**,
   and **no column is scaled below the readable floor**.

   The suite plays the demo forward first, because every one of these bugs
   only exists mid-event. An untouched bracket and a finished one both look
   fine.
   =========================================================================== */

import { launch, openApp, goTo, generateBracket, playSets, standalone, reporter, DEMO_EVENT } from './harness.mjs';

const CYCLE_SECONDS = 15;   // must match views/tv.js
const MIN_SCALE = 0.45;     // ditto -- the floor below which a name is unreadable

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('tv');
const errors = [];

/* A television, not a laptop. */
const { ctx, page } = await openApp(browser, { base, width: 1920, height: 1080, errors });

await goTo(page, base, `#/e/${DEMO_EVENT}/tv`);
report.ok('pre-bracket TV shows the check-in count',
  await page.locator('.tv-empty-lead').innerText().then((text) => /24 of 28 checked in/i.test(text)));
report.ok('pre-bracket TV calls out people still to arrive',
  await page.locator('.tv-empty-supporting').allTextContents().then((texts) => texts.some((text) => /4 entrants are still to arrive/i.test(text))));

await generateBracket(page, base);
const played = await playSets(page, 14);
report.ok('the demo played far enough to have a mid-event bracket', played >= 8, `${played} sets`);

await goTo(page, base, `#/e/${DEMO_EVENT}/tv`);

/* ---- it is a display, not the app with bigger text ---------------------- */
report.ok('the app chrome is hidden', await page.evaluate(() => !document.querySelector('.top-bar') && !document.querySelector('nav.tabs')));

/* ---- the queue screen names people -------------------------------------- */
const queue = await page.evaluate(() => ({
  stations: [...document.querySelectorAll('.tv-station')].map((s) => s.innerText.replace(/\s+/g, ' ').trim()),
  next: [...document.querySelectorAll('.tv-queue-row')].map((s) => s.innerText.replace(/\s+/g, ' ').trim()),
}));
const busy = queue.stations.filter((s) => /\bVS\b/i.test(s));
report.ok('the queue screen shows sets in progress', busy.length > 0, JSON.stringify(queue.stations).slice(0, 200));
report.ok('the queue screen shows who is up next', queue.next.length > 0, JSON.stringify(queue.next).slice(0, 200));

/* ---- the bracket screen has DATA in it, at EVERY depth ------------------
   The first version of this check played the demo forward once, looked at
   the bracket screen, and passed. Then the original bug was reintroduced on
   purpose to see whether the test would catch it -- and it did not. One depth
   is not a test of this, because the failure is depth-dependent by nature:
   whether the readable rounds happen to be the populated ones depends
   entirely on how far the event has got.

   So sweep it. A fresh store per depth, play that many sets, and assert the
   same invariant at each: **at every point in an event's life, the bracket
   screen shows somebody.** That is the promise the screen makes, and it is
   the one that was broken.

   A fresh browser context per depth because the store is localStorage, and
   localStorage is per-context. */
const DEPTHS = [0, 4, 8, 14, 22];

async function readColumns(page) {
  await page.evaluate(() => document.querySelector('.tv')?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
  await page.waitForTimeout(150);
  await page.click('[data-act="tv-screen"][data-screen="bracket"]');
  await page.waitForTimeout(500);
  return page.evaluate(() => [...document.querySelectorAll('.tv-round-col')].map((col) => ({
    title: col.querySelector('h3')?.innerText.trim() || '',
    scale: parseFloat(getComputedStyle(col).getPropertyValue('--tv-scale')) || 1,
    filled: [...col.querySelectorAll('.tv-side-name')].filter((n) => {
      const t = n.innerText.trim();
      return t && t !== '—' && !/^tbd$/i.test(t);
    }).length,
    slots: col.querySelectorAll('.tv-side-name').length,
  })));
}

for (const depth of DEPTHS) {
  const depthErrors = [];
  const d = await openApp(browser, { base, width: 1920, height: 1080, errors: depthErrors });
  await generateBracket(d.page, base);
  if (depth) await playSets(d.page, depth);
  await goTo(d.page, base, `#/e/${DEMO_EVENT}/tv`);
  const cols = await readColumns(d.page);
  const shape = cols.map((c) => `${c.title} ${c.filled}/${c.slots} @${c.scale}`).join(' | ') || '(no columns)';

  report.ok(`${depth} sets in: the bracket screen draws columns`, cols.length > 0, shape);
  /* THE bug: every column correctly sized and completely empty. */
  report.ok(`${depth} sets in: at least one column has entrants in it`, cols.some((c) => c.filled > 0), shape);
  /* The fix for it must not have re-broken legibility. */
  report.ok(`${depth} sets in: no column is scaled below the readable floor`,
    cols.every((c) => c.scale >= MIN_SCALE - 0.001), shape);
  report.ok(`${depth} sets in: a narrow column is not shrunk by a wide one`,
    cols.filter((c) => c.slots <= 8).every((c) => c.scale === 1), shape);
  report.ok(`${depth} sets in: nothing overflows the bottom of the screen`,
    await d.page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight) <= 2, shape);
  report.noErrors(depthErrors);
  await d.ctx.close();
}

/* Recent results are what fill the screen usefully before anybody has been
   knocked out, so they are only expected once there ARE results. */
await goTo(page, base, `#/e/${DEMO_EVENT}/tv`);
await readColumns(page);
report.ok('recent results fill the space the trimmed rounds left',
  await page.evaluate(() => Boolean(document.querySelector('.tv-recent'))));

/* ---- venue-sized layout, long tags, and the end of the night ------------ */
const compactErrors = [];
const compact = await openApp(browser, { base, width: 1280, height: 720, errors: compactErrors });
await generateBracket(compact.page, base);
await compact.page.evaluate(async () => {
  const store = await import('./lib/store.js');
  const players = Object.values(store.get().players);
  players.forEach((player, i) => store.apply('players', player.id, {
    tag: `Very Long Local Tag ${i + 1} With Sponsor Prefix`,
  }, { queueIt: false }));
});
await goTo(compact.page, base, `#/e/${DEMO_EVENT}/tv`);
report.ok('1280×720 keeps the TV on one viewport',
  await compact.page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight <= 2));
report.ok('station cards label their state for a quick glance',
  await compact.page.locator('.tv-station-state').count() > 0
  && (await compact.page.locator('.tv-station-state').allTextContents()).every((text) => /^(Open|Now playing)$/i.test(text.trim())));
report.ok('long player tags do not widen the TV queue',
  await compact.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 2));
report.noErrors(compactErrors);
await compact.ctx.close();

/* Drive real engine brackets to their finals. The old fixture marked every
   match complete by hand, which could make the view display a winner from a
   mutually exclusive GF state and never exercised GF-1 versus GF-2. */
async function driveEngineBracket(page, format, finalMode = 'single') {
  return page.evaluate(async ({ eventId, format, finalMode }) => {
    const store = await import('./lib/store.js');
    const engine = await import('./lib/bracket.js');
    const entries = Object.values(store.get().entries)
      .filter((entry) => entry.eventId === eventId).slice(0, 4);
    const roster = entries.map((entry, i) => ({ id: entry.id, seed: i + 1 }));
    const bracket = format === 'single'
      ? engine.singleElimination(roster)
      : engine.doubleElimination(roster);
    let matches = bracket.matches;
    let guard = 0;
    const reportFirst = (match) => {
      matches = engine.reportResult(matches, match.id, {
        winnerId: match.slots[0].entrantId, scoreA: 2, scoreB: 0,
      });
    };

    if (format === 'single') {
      while (engine.readyMatches(matches).filter((match) => !match.cancelled).length && guard++ < 100) {
        reportFirst(engine.readyMatches(matches).find((match) => !match.cancelled));
      }
    } else {
      while (!engine.readyMatches(matches).some((match) => match.id === 'GF-1') && guard++ < 100) {
        reportFirst(engine.readyMatches(matches).find((match) => !match.cancelled));
      }
      const gf1 = matches.find((match) => match.id === 'GF-1');
      const gf1Winner = finalMode === 'gf1-winner' ? gf1.slots[0].entrantId : gf1.slots[1].entrantId;
      matches = engine.reportResult(matches, 'GF-1', { winnerId: gf1Winner, scoreA: 2, scoreB: 0 });
      while (engine.readyMatches(matches).filter((match) => !match.cancelled).length && guard++ < 100) {
        const next = engine.readyMatches(matches).find((match) => !match.cancelled);
        reportFirst(next);
      }
    }

    store.apply('brackets', eventId, { ...bracket, matches }, { queueIt: false });
    const final = matches.filter((match) => match.bracket === 'GF' && !match.cancelled && match.state === 'complete')
      .sort((a, b) => b.round - a.round)[0]
      || matches.filter((match) => match.bracket === 'W' && match.state === 'complete')
        .sort((a, b) => b.round - a.round)[0];
    const tagOf = (entrantId) => {
      const entry = store.get().entries[entrantId];
      return store.getPlayer(entry?.playerId)?.tag || '';
    };
    return {
      champion: tagOf(final?.winnerId), runnerUp: tagOf(final?.loserId),
      round: final?.name || '', score: '2–0',
      unplayed: matches.filter((match) => !match.cancelled && !match.state).map((match) => match.id),
    };
  }, { eventId: DEMO_EVENT, format, finalMode });
}

async function assertEngineCompletion(label, format, finalMode) {
  const errors = [];
  const finished = await openApp(browser, { base, width: 1280, height: 720, errors });
  const expected = await driveEngineBracket(finished.page, format, finalMode);
  await goTo(finished.page, base, `#/e/${DEMO_EVENT}/tv`);
  report.ok(`${label} drains every playable match`, expected.unplayed.length === 0, expected.unplayed.join(', '));
  report.ok(`${label} names the exact champion`,
    await finished.page.locator('.tv-complete h2').innerText() === expected.champion);
  const finalText = await finished.page.locator('.tv-complete-final').innerText();
  report.ok(`${label} names the exact final result`,
    finalText.includes(`${expected.round} · ${expected.score}`) && finalText.includes(`over ${expected.runnerUp}`), finalText);
  report.ok(`${label} fits at 1280×720`,
    await finished.page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight <= 2));
  report.noErrors(errors);
  await finished.ctx.close();
}

await assertEngineCompletion('single-elimination completion', 'single');
await assertEngineCompletion('double-elimination GF1 completion', 'double', 'gf1-winner');
await assertEngineCompletion('double-elimination GF2 reset completion', 'double', 'gf2-winner');

const emptyErrors = [];
const empty = await openApp(browser, { base, width: 1280, height: 720, errors: emptyErrors });
await empty.page.evaluate(async () => {
  const store = await import('./lib/store.js');
  store.apply('brackets', 'evt_demo_tokon', { matches: [] }, { queueIt: false });
});
await goTo(empty.page, base, `#/e/${DEMO_EVENT}/tv`);
const emptyText = await empty.page.locator('.tv').innerText();
report.ok('empty bracket does not announce a phantom champion',
  !/Tournament complete|Champion decided|Champion\s*$/i.test(emptyText), emptyText);
report.noErrors(emptyErrors);
await empty.ctx.close();

/* ---- cycle rotates, and stops when you leave ---------------------------- */
await page.evaluate(() => document.querySelector('.tv')?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
await page.waitForTimeout(200);
await page.click('[data-act="tv-screen"][data-screen="cycle"]');
await page.waitForTimeout(500);
const first = await page.evaluate(() => document.querySelector('.tv-section')?.innerText);
report.ok('cycle shows a progress bar so a viewer knows how long they have',
  await page.evaluate(() => Boolean(document.querySelector('.tv-progress'))));
await page.waitForTimeout((CYCLE_SECONDS + 1.5) * 1000);
const second = await page.evaluate(() => document.querySelector('.tv-section')?.innerText);
report.ok(`cycle rotates after ${CYCLE_SECONDS}s`, Boolean(first) && first !== second, `${first} -> ${second}`);

/* Leaving the route must cancel the timer. A stray interval redrawing a view
   that is no longer mounted is how the flicker bug next door started. */
await goTo(page, base, '#/');
await page.waitForTimeout((CYCLE_SECONDS + 1.5) * 1000);
report.ok('leaving the TV route does not leave a timer redrawing behind it',
  await page.evaluate(() => location.hash === '#/' && !document.querySelector('.tv')));

report.noErrors(errors);
await ctx.close();
await browser.close();
await close();
report.done();
