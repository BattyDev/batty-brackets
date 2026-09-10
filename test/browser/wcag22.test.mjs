/* The WCAG 2.2 additions axe does not fully cover.
   ===========================================================================
   axe checks a lot of 2.2, but three of the new criteria are either partly or
   wholly outside what a static rule engine can decide, so they get checked
   here by measuring the rendered page:

     2.5.8 Target Size (Minimum) -- 24x24 CSS px, or adequately spaced.
     2.4.11 Focus Not Obscured   -- the focused thing must not be entirely
                                    hidden behind sticky chrome.
     2.5.7 Dragging Movements    -- nothing may be drag-only.

   2.5.7 earns its place: the seeding lab shipped with a drag handle wired to
   an empty function. It was inaccessible AND it did not work, and the second
   half is why nobody noticed the first. It has explicit move-up/move-down
   buttons now, and this suite fails if a `draggable` attribute reappears
   without them.
   =========================================================================== */

import { launch, openApp, goTo, generateBracket, standalone, reporter, DEMO_EVENT, DEMO_PLAYER } from './harness.mjs';

const ROUTES = ['#/', `#/e/${DEMO_EVENT}/admin`, `#/e/${DEMO_EVENT}/admin/entrants`,
  `#/e/${DEMO_EVENT}/admin/seeding`, `#/e/${DEMO_EVENT}/admin/run`, `#/e/${DEMO_EVENT}`,
  `#/p/${DEMO_PLAYER}`, '#/new', `#/e/${DEMO_EVENT}/tv`];

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('wcag22');

/* ---- 2.5.8 target size, at desktop and phone ---------------------------- */
for (const width of [1280, 390]) {
  const { ctx, page } = await openApp(browser, { base, width, height: 900 });
  await generateBracket(page, base);
  const small = [];
  for (const route of ROUTES) {
    await goTo(page, base, route);
    const bad = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;            // not rendered
        if (el.closest('[aria-hidden="true"]')) continue;          // not exposed
        /* 2.5.8 exempts a link inside a block of text -- the target is the
           sentence, and enlarging it would break the line box. */
        if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue;
        if (r.width < 24 || r.height < 24) {
          out.push(`${el.tagName}.${(el.className || '').toString().slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      return out;
    });
    for (const b of bad) small.push(`${route}: ${b}`);
  }
  report.ok(`2.5.8 every target is at least 24x24 at ${width}px`, small.length === 0, small.slice(0, 8).join('\n'));
  await ctx.close();
}

/* ---- 2.4.11 focus not obscured ------------------------------------------
   Focus each control in turn and ask the document what is actually on top at
   that point. A sticky header or a docked bulk-action bar covering the thing
   you just tabbed to is the failure mode, and it is invisible until somebody
   without a mouse tries to use the page. */
{
  const { ctx, page } = await openApp(browser, { base });
  await goTo(page, base, `#/e/${DEMO_EVENT}/admin/entrants`);
  const obscured = await page.evaluate(() => {
    const out = [];
    const focusables = [...document.querySelectorAll('a[href], button:not([disabled]), input, select, textarea')]
      .filter((el) => el.getBoundingClientRect().height > 0);
    for (const el of focusables.slice(0, 120)) {
      el.focus();
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue;  // scrolled away, not covered
      const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
      const top = document.elementFromPoint(cx, cy);
      if (!top || top === el || el.contains(top) || top.contains(el)) continue;
      out.push(`${el.tagName}.${(el.className || '').toString().slice(0, 20)} covered by ${top.tagName}.${(top.className || '').toString().slice(0, 20)}`);
    }
    return out;
  });
  report.ok('2.4.11 no focused control is fully obscured', obscured.length === 0, obscured.slice(0, 5).join('\n'));
  await ctx.close();
}

/* ---- 2.5.7 no drag-only interaction ------------------------------------- */
{
  const { ctx, page } = await openApp(browser, { base });
  await goTo(page, base, `#/e/${DEMO_EVENT}/admin/seeding`);
  const { draggable, moves } = await page.evaluate(() => ({
    draggable: document.querySelectorAll('[draggable="true"]').length,
    moves: document.querySelectorAll('[data-act="seed-move"]').length,
  }));
  report.ok('2.5.7 nothing is drag-only', draggable === 0, `${draggable} draggable elements`);
  report.ok('seed order is reorderable by button', moves > 0, `${moves} move buttons`);
  await ctx.close();
}

await browser.close();
await close();
report.done();
