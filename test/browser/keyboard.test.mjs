/* The half of accessibility axe cannot see: can you actually drive it?
   ===========================================================================
   axe reads the DOM. It cannot tell you that the skip link goes nowhere, that
   Tab walks out the back of a dialog into the page behind it, or that the
   bracket only scrolls with a mouse. Those need a keyboard, so this suite
   presses keys.

   The bracket-pane check is here because it was a real failure: the bracket
   scrolled horizontally with a wheel or a trackpad and was completely
   unreachable without one. It needed `tabindex="0"` and a focus style, which
   is two lines, and nothing except trying it would have found it.
   =========================================================================== */

import { launch, openApp, goTo, generateBracket, standalone, reporter, DEMO_EVENT } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('keyboard');
const errors = [];

const { ctx, page } = await openApp(browser, { base, errors });
const active = () => page.evaluate(() => {
  const el = document.activeElement;
  if (!el) return null;
  return {
    tag: el.tagName,
    cls: (el.className || '').toString().slice(0, 40),
    id: el.id,
    text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 50),
  };
});

/* ---- the skip link is the first stop, and it works ----------------------
   It shipped broken once in the other direction: focusing <main> on the first
   draw meant the very first Tab landed PAST the skip link, so the one control
   that exists for keyboard users was the one control they could not reach. */
await page.keyboard.press('Tab');
let a = await active();
report.ok('first Tab reaches the skip link', a?.cls?.includes('skip-link'), JSON.stringify(a));
await page.waitForTimeout(350);  // it reveals on a 150ms transition; measure after
const box = await page.evaluate(() => {
  const r = document.querySelector('.skip-link').getBoundingClientRect();
  return { top: r.top, height: r.height };
});
report.ok('the skip link is visible once focused', box.top >= 0 && box.top < 200 && box.height > 0, JSON.stringify(box));
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
report.ok('activating it moves focus to main', (await active())?.id === 'main');

/* ---- the primary action is reachable without a mouse -------------------- */
await goTo(page, base, '#/');
let reached = false;
for (let i = 0; i < 40 && !reached; i += 1) {
  await page.keyboard.press('Tab');
  const el = await active();
  if (/Discord|Sign in/.test(el?.text || '')) reached = true;
}
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
report.ok('sign-in is reachable by Tab from the landing page', reached);

/* ---- dialogs trap focus and close on Escape ----------------------------- */
await goTo(page, base, `#/e/${DEMO_EVENT}/admin/entrants`);
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
await page.click('[data-act="import-open"]');
await page.waitForTimeout(300);
report.ok('the import dialog opens', await page.evaluate(() => Boolean(document.querySelector('dialog.m3[open]'))));
report.ok('focus moves into the dialog',
  await page.evaluate(() => document.querySelector('dialog.m3')?.contains(document.activeElement)));

/* A modal legitimately lets focus out to BROWSER chrome -- that is how you
   reach the URL bar, and trapping it there would be the bug. The requirement
   is narrower: it must never land on the page behind the dialog. */
let leak = null;
for (let i = 0; i < 25 && !leak; i += 1) {
  await page.keyboard.press('Tab');
  const where = await page.evaluate(() => {
    const el = document.activeElement;
    const dlg = document.querySelector('dialog.m3');
    if (!el || el === document.body) return 'chrome';
    if (dlg?.contains(el)) return 'dialog';
    return `LEAK ${el.tagName}.${(el.className || '').toString().slice(0, 30)}`;
  });
  if (where.startsWith('LEAK')) leak = where;
}
report.ok('focus never reaches the page behind the dialog', !leak, leak || '');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
report.ok('Escape closes it', !(await page.evaluate(() => Boolean(document.querySelector('dialog.m3[open]')))));

/* ---- the bracket pane is keyboard scrollable ---------------------------- */
await generateBracket(page, base);
await goTo(page, base, `#/e/${DEMO_EVENT}/admin/run`);
const scroll = await page.evaluate(() => {
  const pane = document.querySelector('.bracket-scroll');
  if (!pane) return 'missing';
  pane.focus();
  const before = pane.scrollLeft;
  pane.scrollLeft += 200;
  return pane.scrollLeft > before ? 'scrolls' : 'stuck';
});
report.ok('the bracket pane scrolls', scroll === 'scrolls', scroll);
report.ok('the bracket pane is in the tab order',
  await page.evaluate(() => document.querySelector('.bracket-scroll')?.getAttribute('tabindex')) === '0');

/* ---- every match button says who is in it ------------------------------- */
const unnamed = await page.evaluate(() => [...document.querySelectorAll('button.match')]
  .filter((b) => !(b.getAttribute('aria-label') || b.innerText.trim()))
  .map((b) => b.outerHTML.slice(0, 80)));
report.ok('every match button has an accessible name', unnamed.length === 0, unnamed.join('\n'));
report.noErrors(errors);
await ctx.close();

/* ---- 200% zoom must not force sideways scrolling ------------------------
   1.4.10 Reflow. Halving the viewport is the same thing as doubling the zoom
   as far as CSS is concerned, and it is easier to measure. */
for (const route of ['#/', `#/e/${DEMO_EVENT}/admin`, `#/e/${DEMO_EVENT}/admin/entrants`]) {
  const z = await openApp(browser, { base, width: 640, height: 900 });
  await goTo(z.page, base, route);
  const overflow = await z.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  report.ok(`1.4.10 no horizontal scroll at 200% zoom — ${route}`, overflow <= 2, `${overflow}px over`);
  await z.ctx.close();
}

/* ---- reduced motion is honoured ----------------------------------------- */
{
  const r = await openApp(browser, { base, reducedMotion: 'reduce' });
  /* Chromium reports the 0.01ms override as "1e-05s", so parse it rather than
     matching the string. */
  const duration = await r.page.evaluate(() => getComputedStyle(document.querySelector('.btn')).transitionDuration);
  report.ok('2.3.3 transitions are suppressed under prefers-reduced-motion', parseFloat(duration) < 0.005, duration);
  await r.ctx.close();
}

await browser.close();
await close();
report.done();
