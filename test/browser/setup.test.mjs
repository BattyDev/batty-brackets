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
  await page.locator('[data-act-input="wizard-field"][data-field="stationCount"]').fill('65');
  await page.locator('[data-act="wizard-step"][data-step="4"]').click();
  report.ok('publish rejects a station count above the supported limit',
    await page.locator('[data-act="wizard-publish"]').isDisabled()
    && /1–64/i.test(await page.locator('main').innerText()));
  await page.locator('[data-act="wizard-step"][data-step="1"]').click();
  await page.locator('[data-act-input="wizard-field"][data-field="stationCount"]').fill('6');

  await page.locator('[data-act="wizard-step"][data-step="3"]').click();
  report.ok('local sign-ups explain the device boundary',
    await page.locator('.local-device-note').innerText().then((t) =>
      t.includes('stay on this device') && t.includes('another phone')));
  report.ok('local sign-ups hide unusable visibility and invite controls',
    await page.locator('[data-act="wizard-set"][data-field="visibility"]').count() === 0
    && !/How people find it/i.test(await page.locator('main').innerText()));

  await page.locator('[data-act="wizard-step"][data-step="2"]').click();
  report.ok('Tōkon makes the provisional status visible in Rules',
    /Provisional|not a standard/i.test(await page.locator('main').innerText()));
  await page.locator('[data-act="wizard-step"][data-step="4"]').click();

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
  report.ok('the local created dialog does not offer a cross-device link',
    created.copyLink === false && /Other devices cannot join/i.test(created.localCopy));

  report.noErrors(errors);
  await ctx.close();
} finally {
  await browser.close();
  await close();
}
report.done();
