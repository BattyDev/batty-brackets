/* Exercise organiser actions in Chromium. Fixtures establish tournament depth;
   the operations under test always use the real controls and delegated handlers.
   Run against the original admin.js first: scope, history, calls, DQ and Finish
   assertions must fail, rather than merely checking that a new button exists. */
import { launch, openApp, goTo, standalone, reporter } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('operations');
const errors = [];
const { ctx, page } = await openApp(browser, { base, errors });
let serial = 0;
let id;
async function fixture({ played = 0, checked = 4, bracket = true, call = false, format = 'single' } = {}) {
  id = `evt_operations_${++serial}`;
  await page.evaluate(async ({ id, played, checked, bracket, call, format }) => {
    const s = await import('./lib/store.js');
    const b = await import('./lib/bracket.js');
    s.apply('events', id, { id, name: 'Operations weekly', gameId: 'tokon', format,
      status: bracket ? 'running' : 'registration', venueType: 'offline', documents: [],
      startsAt: new Date().toISOString(), overrides: {} }, { queueIt: false });
    const entrants = Array.from({ length: 5 }, (_, i) => ({ id: `${id}_e${i}`, name: `Player ${i + 1}` }));
    for (const [i, e] of entrants.entries()) {
      s.apply('players', `${e.id}_p`, { id: `${e.id}_p`, tag: e.name }, { queueIt: false });
      s.apply('entries', e.id, { id: e.id, eventId: id, playerId: `${e.id}_p`, seed: i + 1,
        waitlisted: i === 4, checkedInAt: i < checked ? new Date().toISOString() : null }, { queueIt: false });
    }
    if (bracket) {
      const built = format === 'double' ? b.doubleElimination(entrants.slice(0, 4)) : b.singleElimination(entrants.slice(0, 4));
      for (let i = 0; i < played; i++) {
        const m = b.readyMatches(built.matches)[0];
        if (!m) break;
        built.matches = b.reportResult(built.matches, m.id, { winnerId: m.slots[0].entrantId, scoreA: 3, scoreB: 0 });
        const rid = `${id}_r${i}`;
        s.apply('results', rid, { id: rid, eventId: id, matchId: m.id,
          winnerPlayerId: `${m.slots[0].entrantId}_p`, loserPlayerId: `${m.slots[1].entrantId}_p`,
          scoreWinner: 3, scoreLoser: 0, reportedAt: new Date().toISOString() }, { queueIt: false });
      }
      const next = call ? b.readyMatches(built.matches)[0] : null;
      if (next) { next.calledAt = new Date().toISOString(); next.stationId = `${id}_s`; }
      s.apply('brackets', id, { ...built, id, eventId: id }, { queueIt: false });
      s.apply('stations', `${id}_s`, { id: `${id}_s`, eventId: id, number: 1, label: 'Station 1', matchId: next?.id || null }, { queueIt: false });
    }
  }, { id, played, checked, bracket, call, format });
  await goTo(page, base, `#/e/${id}/admin`);
}
const snapshot = () => page.evaluate(async id => {
  const s = await import('./lib/store.js');
  return { event: s.getEvent(id), bracket: s.get().brackets[id], stations: s.stationsFor(id),
    results: Object.values(s.get().results).filter(r => r.eventId === id) };
}, id);
async function confirmIf(label) {
  const button = page.getByRole('dialog').getByRole('button', { name: label, exact: true });
  if (await button.count()) await button.click();
}
async function openMatch(matchId) {
  await goTo(page, base, `#/e/${id}/admin/run`);
  await page.locator(`[data-act="report-open"][data-match="${matchId}"]`).first().click();
}
try {
  await fixture({ bracket: false, checked: 2 });
  await goTo(page, base, `#/e/${id}/admin/seeding`);
  const preview = await page.locator('.seed-row').count();
  await page.locator('[data-act="generate-bracket"]').click();
  let state = await snapshot();
  report.ok('registration preview and generation include the same field',
    new Set(state.bracket.matches.flatMap(m => m.slots).map(s => s.entrantId).filter(Boolean)).size === preview);

  for (const checked of [0, 2, 4]) {
    await fixture({ bracket: false, checked });
    await goTo(page, base, `#/e/${id}/admin/seeding`);
    const scope = page.locator('[data-act="seed-scope"][data-scope="checked"]');
    report.ok(`explicit checked-in scope exists (${checked} present)`, await scope.count() === 1);
    if (await scope.count()) {
      await scope.click();
      report.ok(`checked-in preview includes exactly ${checked}`, await page.locator('.seed-row').count() === checked);
      report.ok(`generation prerequisite reflects ${checked} present`, await page.locator('[data-act="generate-bracket"]').isDisabled() === (checked < 2));
    }
  }

  await fixture({ played: 3 });
  state = await snapshot();
  const first = state.bracket.matches[0].id;
  const unaffected = state.results.find(r => r.matchId !== first && r.matchId !== state.bracket.matches.at(-1).id).id;
  await openMatch(first);
  await page.locator('#unreport').click();
  await confirmIf('Confirm correction');
  state = await snapshot();
  report.ok('unreport supersedes selected and downstream history', state.results.filter(r => r.superseded).length === 2);
  report.ok('unreport preserves the independent semifinal', !state.results.find(r => r.id === unaffected).superseded);

  await fixture({ played: 2, call: true });
  const called = (await snapshot()).stations[0].matchId;
  await openMatch((await snapshot()).bracket.matches[0].id);
  await page.locator('#unreport').click();
  await confirmIf('Confirm correction');
  state = await snapshot();
  report.ok('correction frees downstream station and clears its DQ clock',
    !state.stations[0].matchId && !state.bracket.matches.find(m => m.id === called).calledAt);

  await fixture({ played: 3 });
  await openMatch((await snapshot()).bracket.matches[0].id);
  await page.locator('[data-score-side="b"]').last().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await confirmIf('Confirm correction');
  state = await snapshot();
  report.ok('re-report replaces history and invalidates played descendants',
    state.results.filter(r => !r.superseded).length === 2 && !state.bracket.matches.at(-1).state);

  await fixture({ played: 2, call: true });
  await goTo(page, base, `#/e/${id}/admin/seeding`);
  await page.locator('[data-act="generate-bracket"]').click();
  await confirmIf('Regenerate');
  state = await snapshot();
  report.ok('regeneration supersedes prior history and releases stations',
    state.results.every(r => r.superseded) && state.stations.every(s => !s.matchId));

  await fixture({ played: 2, call: true });
  state = await snapshot();
  const final = state.bracket.matches.find(m => m.id === state.stations[0].matchId);
  await goTo(page, base, `#/e/${id}/admin/entrants`);
  await page.locator(`[data-act="entrant-menu"][data-id="${final.slots[0].entrantId}"]`).click();
  await page.locator('[data-act="entrant-dq"]').click();
  state = await snapshot();
  report.ok('roster DQ records a finals-length result and frees station',
    state.results.some(r => r.matchId === final.id && r.byDq && r.scoreWinner === 3) && !state.stations[0].matchId);
  await page.evaluate(() => document.querySelector('dialog[open]')?.close());

  await fixture();
  const finish = page.locator('[data-act="event-status"][data-status="complete"]');
  if (!(await finish.isDisabled())) await finish.click();
  report.ok('unfinished bracket cannot be marked Finished', (await snapshot()).event.status === 'running');
  await fixture({ played: 3 });
  await page.locator('[data-act="event-status"][data-status="complete"]').click();
  await confirmIf('Finish event');
  state = await snapshot();
  report.ok('phase Finish records completedAt', state.event.status === 'complete' && Boolean(state.event.completedAt));
  report.noErrors(errors);
} finally {
  await ctx.close();
  await browser.close();
  await close();
}
report.done();
