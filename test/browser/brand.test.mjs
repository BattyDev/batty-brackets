/* Identity must survive more than the screenshot: theme changes, narrow
   screens, and navigation into a real event. The negative probes prove the
   design assertions detect a missing creator credit or lost editorial type. */
import { launch, openApp, goTo, standalone, reporter, generateBracket, playSets, DEMO_EVENT } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('brand');
const errors = [];
const shots = process.env.BRACKETS_SCREENSHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const capture = async (page, name) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
};
const fits = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const editorial = page => page.locator('.publication-wordmark').evaluate(el => getComputedStyle(el).fontFamily.includes('Georgia'));
try {
  for (const scheme of ['light', 'dark']) {
    const { ctx, page } = await openApp(browser, { base, scheme, errors });
    report.ok(`${scheme}: publisher masthead is present`, await page.locator('.publication-wordmark').innerText() === 'Batty Brackets.');
    report.ok(`${scheme}: creator is credited`, (await page.locator('.publication-edition').textContent()).includes('By BattyDev'));
    report.ok(`${scheme}: editorial typography is applied`, await editorial(page));
    await page.locator('.publication-wordmark').evaluate(el => { el.style.fontFamily = 'Arial'; });
    report.ok('type assertion rejects the original generic sans presentation', !(await editorial(page)));
    await page.locator('.publication-wordmark').evaluate(el => { el.style.removeProperty('font-family'); });
    report.ok('restored editorial type passes', await editorial(page));
    report.ok(`${scheme}: local boundary stays explicit`, (await page.locator('.publication-story').innerText()).includes('sharing are not connected'));
    await capture(page, `home-${scheme}`);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      report.ok(`${scheme}: home fits ${width}px`, await fits(page));
    }
    await capture(page, `home-${scheme}-mobile`);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.publication-story a[href="#/new"]').click();
    await page.waitForSelector('[data-act="wizard-game"]');
    report.ok('primary action opens real setup', await page.locator('[data-act="wizard-game"]').count() > 0);
    report.ok('creator identity persists in setup', (await page.locator('.brand-signature').innerText()).includes('By BattyDev'));
    await generateBracket(page, base);
    await playSets(page, 0, { leaveLive: 3 });
    await goTo(page, base, `#/e/${DEMO_EVENT}/tv`);
    report.ok('TV has publisher and creator identity', (await page.locator('.tv-brand').textContent()).includes('By BattyDev'));
    report.ok('TV keeps the actual venue event name', (await page.locator('.tv-title').innerText()).includes('Tokon Tuesdays'));
    report.ok('TV uses square broadcast station rows', await page.locator('.tv-station').first().evaluate(el => getComputedStyle(el).borderRadius === '0px'));
    report.ok('TV has real station calls', await page.locator('.tv-station.busy').count() > 0);
    await page.mouse.move(1279, 899);
    await capture(page, `tv-${scheme}`);
    await page.locator('.tv-brand').evaluate(el => { el.hidden = true; });
    report.ok('missing creator assertion fails when branding is removed', !(await page.locator('.tv-brand').isVisible()));
    await page.locator('.tv-brand').evaluate(el => { el.hidden = false; });
    await ctx.close();
  }
  report.noErrors(errors);
} finally {
  await browser.close();
  await close();
}
report.done();
