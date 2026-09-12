/* Local event links must not promise cross-device registration. A demo uses
   exactly the same view as a real event, so test both: hiding a code only for
   demo rows would leave the organiser's first actual weekly misleading. */
import { launch, openApp, goTo, standalone, reporter, DEMO_EVENT } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('local');
const errors = [];
try {
  const { ctx, page } = await openApp(browser, { base, errors });
  for (const demo of [true, false]) {
    await page.evaluate(async ({ id, demo }) => {
      const store = await import('./lib/store.js');
      store.apply('events', id, { demo }, { queueIt: false });
    }, { id: DEMO_EVENT, demo });
    await goTo(page, base, `#/e/${DEMO_EVENT}/admin`);
    report.ok(`${demo ? 'demo' : 'local'} organiser does not advertise a public join link`,
      await page.getByRole('button', { name: 'Copy join link', exact: true }).count() === 0);
    report.ok('organiser explains the TV connection and device boundary',
      await page.locator('.local-device-note').innerText().then(t => t.includes('connect this computer to the TV') && t.includes('other devices')));
    await page.getByRole('link', { name: 'Venue display', exact: true }).click();
    await page.waitForSelector('.tv');
    report.ok(`${demo ? 'demo' : 'local'} TV directs arrivals to the organiser`,
      await page.locator('.tv-empty-code').innerText().then(t => t.includes('Check in with the organiser')));
    report.ok('TV does not advertise an unusable join code',
      !/Join:|Join with/.test(await page.locator('.tv').innerText()));
  }
  report.noErrors(errors);
  await ctx.close();
} finally {
  await browser.close();
  await close();
}
report.done();
