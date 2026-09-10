/* axe-core across every route, both colour schemes, desktop and phone.
   ===========================================================================
   axe finds about a third of accessibility problems. That is not a criticism
   -- the other two thirds are judgement calls a machine cannot make -- but it
   does mean a clean run here is a floor and not a ceiling. The keyboard suite
   next door covers some of the rest.

   Every violation this has ever caught in this project was a real bug and not
   a technicality:

     · `opacity: .62` on secondary text, which reads as "dimmed" to a designer
       and as "fails contrast" to everyone who needs the contrast. Twice, in
       two different views, which is why it is worth having a machine watch.
     · `role="tablist"` on what was really site navigation, so a screen reader
       announced "tab 3 of 6" for links that changed the page.
     · a heading order that skipped from h1 to h3 because the h2 was styled
       rather than semantic.
     · a `<th>` left empty above a checkbox column.

   `best-practice` is included on purpose. It is noisier than the WCAG tags
   and it is where several of the above came from.
   =========================================================================== */

import { AxeBuilder } from '@axe-core/playwright';
import { launch, openApp, goTo, generateBracket, standalone, reporter, DEMO_EVENT, DEMO_PLAYER } from './harness.mjs';

const ROUTES = [
  ['landing', '#/'],
  ['dashboard', `#/e/${DEMO_EVENT}/admin`],
  ['entrants', `#/e/${DEMO_EVENT}/admin/entrants`],
  ['seeding', `#/e/${DEMO_EVENT}/admin/seeding`],
  ['run', `#/e/${DEMO_EVENT}/admin/run`],
  ['rules', `#/e/${DEMO_EVENT}/admin/rules`],
  ['settings', `#/e/${DEMO_EVENT}/admin/settings`],
  ['event', `#/e/${DEMO_EVENT}`],
  ['bracket', `#/e/${DEMO_EVENT}/bracket`],
  ['event-entrants', `#/e/${DEMO_EVENT}/entrants`],
  ['event-rules', `#/e/${DEMO_EVENT}/rules`],
  ['player', `#/p/${DEMO_PLAYER}`],
  ['tv', `#/e/${DEMO_EVENT}/tv`],
  ['wizard', '#/new'],
  ['join', '#/join/TKN14B'],
];

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('a11y');
const found = new Map();

async function sweep(label, opts, routes) {
  const { ctx, page } = await openApp(browser, { base, ...opts });
  await generateBracket(page, base); // so run/bracket/tv have something to draw
  for (const [name, hash] of routes) {
    await goTo(page, base, hash);
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    for (const v of violations) {
      if (!found.has(v.id)) found.set(v.id, { impact: v.impact, help: v.help, where: new Set(), nodes: [] });
      const row = found.get(v.id);
      row.where.add(`${label}/${name}`);
      for (const n of v.nodes.slice(0, 2)) if (row.nodes.length < 4) row.nodes.push(n.html.replace(/\s+/g, ' ').slice(0, 140));
    }
  }
  await ctx.close();
}

await sweep('dark', { scheme: 'dark' }, ROUTES);
await sweep('light', { scheme: 'light' }, ROUTES);
/* The phone pass is narrower on purpose: it is the same DOM at a different
   width, so it can only surface layout-dependent findings -- contrast against
   a different background, a control that collapses to nothing. Three routes
   covers the layouts that actually change. */
await sweep('phone', { width: 390, height: 844 }, ROUTES.slice(0, 3));

for (const [id, row] of found) {
  report.ok(`${id} — ${row.help}`, false,
    `[${(row.impact || '?').toUpperCase()}] on ${[...row.where].join(', ')}\n${row.nodes.map((n) => `· ${n}`).join('\n')}`);
}
report.ok(`no axe violations across ${ROUTES.length} routes in dark, light and phone`, found.size === 0,
  `${found.size} distinct violation types`);

await browser.close();
await close();
report.done();
