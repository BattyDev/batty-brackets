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
const editorial = page => page.locator('.publication-wordmark').evaluate(el => { const s = getComputedStyle(el); return parseInt(s.fontWeight, 10) <= 700 && !s.fontFamily.includes('Impact') && parseFloat(s.letterSpacing) >= 0; });
// Measure actual painted roles, not the presence of a class. Reintroducing
// the former broad selector below must make the same invariant fail.
const palette = page => page.locator('.top-bar').evaluate(el => {
  const s = getComputedStyle(el);
  return [s.getPropertyValue('--md-primary').trim(), s.backgroundColor, s.color];
});
try {
  for (const scheme of ['light', 'dark']) {
    const { ctx, page } = await openApp(browser, { base, scheme, errors });
    report.ok(`${scheme}: publisher masthead is present`, (await page.locator('.publication-wordmark').textContent()).trim() === 'Batty Brackets.');
    report.ok(`${scheme}: creator is credited`, (await page.locator('.publication-edition').textContent()).includes('By BattyDev'));
    report.ok(`${scheme}: readable masthead typography is applied`, await editorial(page));
    await page.locator('.publication-wordmark').evaluate(el => { el.style.fontWeight = '800'; el.style.fontFamily = 'Impact'; });
    report.ok('type assertion rejects the former heavy condensed presentation', !(await editorial(page)));
    await page.locator('.publication-wordmark').evaluate(el => { el.style.removeProperty('font-weight'); el.style.removeProperty('font-family'); });
    report.ok('restored tournament type passes', await editorial(page));
    report.ok(`${scheme}: local boundary stays explicit`, (await page.locator('.event-directory').innerText()).includes('sharing are not connected'));
    await capture(page, `home-${scheme}`);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      report.ok(`${scheme}: home fits ${width}px`, await fits(page));
    }
    await capture(page, `home-${scheme}-mobile`);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.experience-switch a[href="#/host"]').click();
    await page.waitForSelector('.host-home');
    report.ok('host door opens a dedicated workspace', await page.locator('.host-home').count() === 1);
    report.ok('host events lead to controls', (await page.locator('.event-card-main').first().getAttribute('href')).endsWith('/admin'));
    await page.locator('.event-card-main').first().click();
    const eventHash = new URL(page.url()).hash.replace(/\/admin$/, '');
    await page.locator('.experience-switch a').first().click();
    report.ok('player switch preserves the selected event', new URL(page.url()).hash === eventHash);
    await page.waitForSelector('nav[aria-label="Event sections"]');
    report.ok('player navigation has no host operations', await page.locator('.tabs a[href*="/admin"]').count() === 0);
    await goTo(page, base, '#/');
    await page.locator('.publication-story a[href="#/new"]').click();
    await page.waitForSelector('[data-act="wizard-game"]');
    report.ok('primary action opens real setup', await page.locator('[data-act="wizard-game"]').count() > 0);
    report.ok('utility bar omits repeated branding', await page.locator('.top-bar .brand-signature').count() === 0);
    report.ok('setup retains an accessible page title', (await page.locator('main h1').textContent()).trim().length > 0);
    const product = await palette(page);
    for (const game of ['tokon', 'tekken8', 'ssbu']) {
      await page.locator('.top-bar').evaluate((el, id) => { el.dataset.game = id; }, game);
      report.ok(`${scheme}: ${game} cannot recolour product chrome`, JSON.stringify(await palette(page)) === JSON.stringify(product));
    }
    const leak = await page.addStyleTag({ content: '[data-game="ssbu"] { --md-primary: hotpink; }' });
    report.ok('palette assertion detects the former broad theme leak', JSON.stringify(await palette(page)) !== JSON.stringify(product));
    await leak.evaluate(el => el.remove());
    report.ok('product palette restored after negative probe', JSON.stringify(await palette(page)) === JSON.stringify(product));
    const accents = await page.locator('.game-card').evaluateAll(els => els.map(el => getComputedStyle(el).getPropertyValue('--md-primary').trim()));
    report.ok('bounded game cards retain distinct accents', new Set(accents).size > 1);
    await generateBracket(page, base);
    await playSets(page, 0, { leaveLive: 3 });
    await goTo(page, base, `#/e/${DEMO_EVENT}/tv`);
    report.ok('TV has publisher and creator identity', (await page.locator('.tv-brand').textContent()).includes('By BattyDev'));
    report.ok('TV keeps the actual venue event name', (await page.locator('.tv-title').innerText()).includes('Tokon Tuesdays'));
    report.ok('TV attributes organizer separately from publisher', (await page.locator('.tv-eyebrow').textContent()).includes('Organized by Batty Mac Arcade'));
    report.ok('TV uses product primary', await page.locator('.tv').evaluate((el, primary) => getComputedStyle(el).getPropertyValue('--md-primary').trim() === primary, product[0]));
    report.ok('TV uses square broadcast station rows', await page.locator('.tv-station').first().evaluate(el => getComputedStyle(el).borderRadius === '0px'));
    report.ok('TV has real station calls', await page.locator('.tv-station.busy').count() > 0);
    await page.mouse.move(1279, 899);
    await capture(page, `tv-${scheme}`);
    await page.locator('.tv-brand').evaluate(el => { el.hidden = true; });
    report.ok('missing creator assertion fails when branding is removed', !(await page.locator('.tv-brand').isVisible()));
    await page.locator('.tv-brand').evaluate(el => { el.hidden = false; });
    await ctx.close();
  }
  // Isolated browser storage: exercise admission without touching a real local.
  {
    const { ctx, page } = await openApp(browser, { base, scheme: 'light', errors });
    const code = await page.evaluate(async (id) => {
      const store = await import('./lib/store.js');
      const event = store.getEvent(id);
      store.apply('events', id, { ...event, status: 'registration', capacity: 1 });
      for (const entry of store.entriesFor(id)) store.apply('entries', entry.id, { ...entry, waitlisted: true });
      return event.inviteCode;
    }, DEMO_EVENT);
    await goTo(page, base, `#/join/${code}`);
    report.ok('waitlisted entrants do not consume admitted capacity', (await page.locator('[data-act="join-event"]').textContent()).includes('Sign in to continue'));
    await page.locator('[data-act="join-event"]').click();
    await page.locator('#sign-local').click();
    await page.locator('#tag').fill('Brand join probe');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const entryState = () => page.evaluate(async (id) => {
      const store = await import('./lib/store.js');
      const auth = await import('./lib/auth.js');
      return store.entryFor(id, auth.currentPlayer().id);
    }, DEMO_EVENT);
    report.ok('sign-in preserves join route and requires confirmation', page.url().endsWith(`#/join/${code}`) && !(await entryState()));
    await page.locator('[data-act="join-event"]').click();
    await page.waitForURL(`**/#/e/${DEMO_EVENT}`);
    report.ok('explicit confirmation admits into available capacity', (await entryState())?.waitlisted === false);
    // A second person encounters a genuinely full event.
    await page.evaluate(async () => { const auth = await import('./lib/auth.js'); auth.signInLocal({ tag: 'Brand waitlist probe' }); });
    await goTo(page, base, `#/join/${code}`);
    report.ok('admitted entrant fills capacity', (await page.locator('[data-act="join-event"]').textContent()).includes('Join the waitlist'));
    // Keep the old button alive while advancing the event, reproducing the
    // stale-action bug. The handler must refuse even before a route redraw.
    await page.evaluate(async (id) => {
      const store = await import('./lib/store.js');
      store.getEvent(id).status = 'running';
    }, DEMO_EVENT);
    await page.locator('[data-act="join-event"]').click();
    await page.waitForTimeout(100);
    report.ok('stale join action cannot enter a closed event', !(await entryState()));
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    report.ok('closed join view explains registration and removes entry action', (await page.locator('main').textContent()).includes('Registration is closed') && await page.locator('[data-act="join-event"]').count() === 0);
    await ctx.close();
  }
  report.noErrors(errors);
} finally {
  await browser.close();
  await close();
}
report.done();
