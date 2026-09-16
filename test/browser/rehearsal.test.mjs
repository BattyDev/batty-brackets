/* A pilot rehearsal must start with an event created by the organiser, not
   demo fixtures whose missing fields could hide a setup/integration defect.
   All writes go through the UI in an isolated browser context. Store reads
   assert the durable outcome rather than just the confirmation toast. */
import { launch, openApp, goTo, standalone, reporter, generateBracket } from './harness.mjs';
import fs from 'node:fs/promises';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('rehearsal');
const errors = [];
try {
  const { ctx, page } = await openApp(browser, { base, errors });
  await goTo(page, base, '#/new');
  await page.locator('[data-act="wizard-game"][data-game="tokon"]').click();
  for (const [field, value] of Object.entries({ name: 'Pilot rehearsal', venue: 'Test venue', capacity: '8', stationCount: '2' })) {
    await page.locator(`[data-act-input="wizard-field"][data-field="${field}"]`).fill(value);
  }
  await page.locator('[data-act="wizard-step"][data-step="4"]').click();
  await page.locator('[data-act-change="wizard-provisional-review"]').check();
  await page.locator('[data-act="wizard-publish"]').click();
  await page.getByRole('button', { name: 'Continue on this device', exact: true }).click();
  await page.locator('dialog #tag').fill('Rehearsal TO');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForFunction(() => /\/e\/evt_.*\/admin/.test(location.hash));
  const id = await page.evaluate(() => location.hash.split('/')[2]);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
  const snapshot = () => page.evaluate(async id => {
    const s = await import('./lib/store.js');
    return { event: s.getEvent(id), entries: s.entriesFor(id), stations: s.stationsFor(id), bracket: s.get().brackets[id], results: Object.values(s.get().results).filter(r => r.eventId === id) };
  }, id);
  report.ok('new non-demo event has two real stations', !(await snapshot()).event.demo && (await snapshot()).stations.length === 2);
  await goTo(page, base, `#/e/${id}/admin/entrants`);
  const sheet = 'Tag\tSeed\tChecked in\n' + Array.from({ length: 9 }, (_, i) => `Pilot ${i + 1}\t${i + 1}\ttrue`).join('\n') + '\nPilot 1\t1\ttrue';
  const importSheet = async () => {
    await page.locator('[data-act="import-open"]').first().click();
    await page.locator('#paste').fill(sheet);
    await page.getByRole('dialog').getByRole('button', { name: 'Preview', exact: true }).click();
  };
  await importSheet();
  report.ok('duplicate is identified before import', /1 duplicate in file/.test(await page.locator('#preview').innerText()));
  report.ok('capacity consequences are previewed before import', /1 new entrant will be waitlisted/.test(await page.locator('#preview').innerText()));
  await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();
  report.ok('duplicate does not create an extra entrant', (await snapshot()).entries.length === 9);
  report.ok('import respects the cap and waitlists overflow', (await snapshot()).entries.filter(e => e.waitlisted).length === 1);
  await importSheet();
  await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();
  report.ok('re-import is idempotent', (await snapshot()).entries.length === 9);
  await page.locator('[data-act="entrant-add"]').first().click();
  await page.locator('dialog #tag').fill('Pilot walk-up');
  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
  report.ok('full-capacity walk-up is waitlisted', (await snapshot()).entries.filter(e => e.waitlisted).length === 2);
  await generateBracket(page, base, id);
  const initial = await snapshot();
  const admitted = new Set(initial.entries.filter(e => !e.waitlisted).map(e => e.id));
  report.ok('bracket contains only the eight admitted entrants', admitted.size === 8 && initial.bracket.matches.flatMap(m => m.slots).filter(s => s.entrantId).every(s => admitted.has(s.entrantId)));
  await goTo(page, base, `#/e/${id}/admin/run`);
  await page.locator('[data-act="call-next"]').first().click();
  let operationState = await snapshot();
  const occupied = operationState.stations.find(s => s.matchId);
  const first = occupied?.matchId;
  const calledMatch = operationState.bracket.matches.find(m => m.id === first);
  report.ok('calling a set records the same assignment on station and bracket',
    Boolean(first) && calledMatch?.stationId === occupied.id && Boolean(calledMatch.calledAt));
  await page.locator(`[data-act="report-open"][data-match="${first}"]`).first().click();
  await page.locator('dialog [data-score-side="a"]').last().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  operationState = await snapshot();
  const reportedMatch = operationState.bracket.matches.find(m => m.id === first);
  report.ok('reported set frees both halves of its station assignment',
    !operationState.stations.some(s => s.matchId === first) && !reportedMatch.calledAt && !reportedMatch.stationId);
  await goTo(page, base, `#/e/${id}/admin/run`);
  await page.locator(`[data-act="report-open"][data-match="${first}"]`).first().click();
  await page.locator('dialog #unreport').click();
  report.ok('score correction preserves superseded result history', (await snapshot()).results.some(r => r.matchId === first && r.superseded));
  await goTo(page, base, `#/e/${id}/admin/run`);
  await page.locator('[data-act="call-next"]').first().click();
  const called = (await snapshot()).stations.find(s => s.matchId)?.matchId;
  await page.locator(`[data-act="report-open"][data-match="${called}"]`).first().click();
  await page.locator('dialog #dq-b').click();
  operationState = await snapshot();
  const dqMatch = operationState.bracket.matches.find(m => m.id === called);
  report.ok('DQ advances the opponent, records the reason and releases the call',
    operationState.results.some(r => r.matchId === called && r.byDq && !r.superseded)
      && !operationState.stations.some(s => s.matchId === called) && !dqMatch.calledAt && !dqMatch.stationId);
  await goTo(page, base, '#/recovery');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-act="recovery-export"]').click();
  const download = await downloadPromise;
  const backup = await fs.readFile(await download.path());
  const exported = JSON.parse(backup.toString());
  report.ok('actual downloaded backup includes the new tournament', exported.state.events[id].name === 'Pilot rehearsal');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-act="recovery-export"]');
  report.ok('reload preserves the played event', (await snapshot()).results.some(r => r.byDq));
  await page.setInputFiles('#recovery-file', { name: 'rehearsal.json', mimeType: 'application/json', buffer: backup });
  await page.locator('[data-act="recovery-restore"]').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore and replace', exact: true }).click();
  report.ok('downloaded backup can restore the real event', (await snapshot()).entries.length === 10 && (await snapshot()).results.some(r => r.byDq));
  await goTo(page, base, `#/e/${id}/tv`);
  report.ok('restored venue display names the rehearsal event', await page.locator('.tv-title').innerText() === 'Pilot rehearsal');
  report.noErrors(errors);
  await ctx.close();
} finally {
  await browser.close();
  await close();
}
report.done();
