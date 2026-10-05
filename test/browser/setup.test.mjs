/* The setup wizard must describe the event that can actually be created on
   this build. In local-only mode that means one device, an organiser-entered
   station count, and no join affordances. Tōkon also needs an explicit review
   because its presets are provisional rather than ratified conventions. */
import { launch, openApp, goTo, standalone, reporter } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('setup');
const errors = [];

try {
  const { ctx, page } = await openApp(browser, { base, errors });
  await goTo(page, base, '#/new');
  await page.locator('[data-act="wizard-game"][data-game="tokon"]').click();

  report.ok('the local shape step exposes entrant capacity and station count',
    await page.locator('[data-field="capacity"]').count() === 1
    && await page.locator('[data-field="stationCount"]').count() === 1);
  report.ok('the shape step does not expose the inert pool-count option',
    await page.locator('[data-field="poolCount"]').count() === 0
    && await page.locator('[data-field="poolsEnabled"]').count() === 0);

  await page.locator('[data-act-input="wizard-field"][data-field="name"]').fill('Tōkon setup rehearsal');
  await page.locator('[data-act-input="wizard-field"][data-field="venue"]').fill('Rehearsal venue');
  await page.locator('[data-act-input="wizard-field"][data-field="capacity"]').fill('24');
  await page.locator('[data-act-input="wizard-field"][data-field="entryFee"]').fill('10.50');
  await page.locator('[data-act-input="wizard-field"][data-field="stationCount"]').fill('65');
  await page.locator('[data-act="wizard-step"][data-step="4"]').click();
  report.ok('publish rejects a station count above the supported limit',
    await page.locator('[data-act="wizard-publish"]').isDisabled()
    && /1–64/i.test(await page.locator('main').innerText()));
  await page.locator('[data-act="wizard-step"][data-step="1"]').click();
  await page.locator('[data-act-input="wizard-field"][data-field="stationCount"]').fill('6');

  await page.getByRole('button', { name: 'Next: Rules', exact: true }).click();
  await page.getByRole('button', { name: 'Next: Registration', exact: true }).click();
  report.ok('local sign-ups explain the device boundary',
    await page.locator('.local-device-note').innerText().then((t) =>
      t.includes('stay on this device') && t.includes('another phone')));
  report.ok('local sign-ups hide unusable visibility and invite controls',
    await page.locator('[data-act="wizard-set"][data-field="visibility"]').count() === 0
    && !/How people find it/i.test(await page.locator('main').innerText()));

  await page.getByRole('button', { name: 'Add a document', exact: true }).click();
  await page.getByRole('button', { name: 'Next: Review', exact: true }).click();
  report.ok('empty document text blocks publication', await page.locator('[data-act="wizard-publish"]').isDisabled()
    && /Every document needs a title/i.test(await page.locator('main').innerText()));
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByLabel('Document title', { exact: true }).fill('Venue agreement');
  await page.getByLabel('Document text shown to players', { exact: true }).fill('Respect players and follow station calls.');
  await page.getByLabel('Required', { exact: true }).check();
  await page.getByRole('button', { name: 'Preview document', exact: true }).click();
  report.ok('document preview shows the actual text', /Respect players/.test(await page.getByRole('dialog').innerText()));
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  report.ok('Tōkon makes the provisional status visible in Rules',
    /Provisional|not a standard/i.test(await page.locator('main').innerText()));
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  report.ok('bottom navigation preserves the entered event name',
    await page.locator('[data-field="name"]').inputValue() === 'Tōkon setup rehearsal');
  await page.getByRole('button', { name: 'Next: Rules', exact: true }).click();
  await page.getByRole('button', { name: 'Next: Registration', exact: true }).click();
  await page.getByRole('button', { name: 'Next: Review', exact: true }).click();

  const create = page.getByRole('button', { name: 'Sign in and create the event', exact: true });
  report.ok('publish is blocked until the organizer reviews provisional rules',
    await page.locator('[data-act-change="wizard-provisional-review"]').count() === 1
    && await create.isDisabled()
    && /Review and confirm the provisional rules/i.test(await page.locator('main').innerText()));

  await page.locator('[data-act-change="wizard-provisional-review"]').check();
  await page.waitForFunction(() => !document.querySelector('[data-act="wizard-publish"]')?.disabled);
  await page.getByRole('button', { name: 'Sign in and create the event', exact: true }).click();
  await page.getByRole('button', { name: 'Continue on this device', exact: true }).click();
  await page.locator('dialog input#tag').fill('Setup Tester');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForSelector('dialog');

  const created = await page.evaluate(async () => {
    const store = await import('./lib/store.js');
    const event = Object.values(store.get().events).find((row) => row.name === 'Tōkon setup rehearsal');
    return {
      event,
      stations: event ? store.stationsFor(event.id).length : 0,
      copyLink: [...document.querySelectorAll('dialog button')].some((b) => b.textContent.trim() === 'Copy the link'),
      localCopy: document.querySelector('dialog')?.innerText || '',
    };
  });
  report.ok('creation preserves the entered capacity and station count',
    created.event?.capacity === 24
    && created.stations === 6);
  report.ok('creation preserves fees and readable required documents', created.event?.entryFee === 10.50
    && created.event.documents[0].body === 'Respect players and follow station calls.' && created.event.documents[0].required);
  report.ok('the local created dialog does not offer a cross-device link',
    created.copyLink === false && /Other devices cannot join/i.test(created.localCopy));

  report.noErrors(errors);
  await ctx.close();
} finally {
  await browser.close();
  await close();
}
report.done();
