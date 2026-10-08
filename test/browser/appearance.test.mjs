/* Personal ink must survive reloads without leaking between people, and
   arbitrary colour choices must keep the real settings controls readable. */
import { AxeBuilder } from '@axe-core/playwright';
import { launch, openApp, standalone, reporter } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('appearance');
const errors = [];
const ink = page => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'));
const options = page => page.getByRole('button', { name: 'Options', exact: true }).click();
const choose = (page, name) => page.locator('dialog').getByRole('button', { name, exact: true }).click();

try {
  const { ctx, page } = await openApp(browser, { base, scheme: 'light', errors });
  await options(page);
  await choose(page, 'Purple');
  report.ok('purple previews on the underlying page', await ink(page) === '#8c46d6');
  await choose(page, 'Cancel');
  await page.waitForSelector('dialog', { state: 'detached' });
  report.ok('cancel restores the previous ink', await ink(page) === '#d6294e');
  await options(page);
  await choose(page, 'Purple');
  await choose(page, 'Save');
  await page.reload();
  await page.waitForSelector('[data-act="options"]');
  report.ok('saved ink survives reload', await ink(page) === '#8c46d6');

  await page.evaluate(async () => (await import('./lib/auth.js')).signInLocal({ tag: 'Ink host' }));
  report.ok('new identity starts with its own default', await ink(page) === '#d6294e');
  await options(page);
  await page.getByLabel('Favorite color', { exact: true }).fill('#237344');
  await choose(page, 'Save');
  await options(page);
  await choose(page, 'Sign out');
  await page.waitForSelector('dialog', { state: 'detached' });
  report.ok('sign out restores signed-out ink', await ink(page) === '#8c46d6');
  await page.evaluate(async () => (await import('./lib/auth.js')).signInLocal({ tag: 'Ink guest' }));
  report.ok('another person does not inherit the host ink', await ink(page) === '#d6294e');
  await page.evaluate(async () => (await import('./lib/auth.js')).signInLocal({ tag: 'Ink host' }));
  report.ok('returning identity recovers its own custom ink', await ink(page) === '#237344');
  await options(page);
  await choose(page, 'Reset to default');
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog', { state: 'detached' });
  report.ok('Escape cancels a reset preview', await ink(page) === '#237344');

  await page.setViewportSize({ width: 320, height: 800 });
  await options(page);
  for (const paper of ['Paper', 'Night']) {
    await choose(page, paper);
    for (const color of ['#000000', '#ffffff', '#ffff00', '#0000ff', '#d6294e', '#8c46d6']) {
      await page.getByLabel('Favorite color', { exact: true }).fill(color);
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      report.ok(`${paper}/${color}: settings remain accessible`, result.violations.length === 0,
        JSON.stringify(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))));
      report.ok(`${paper}/${color}: phone has no page overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await choose(page, 'Save');
      await page.waitForSelector('dialog', { state: 'detached' });
      const home = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      report.ok(`${paper}/${color}: page remains accessible`, home.violations.length === 0,
        JSON.stringify(home.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))));
      await options(page);
    }
  }
  await choose(page, 'Reset to default');
  await choose(page, 'Save');
  await page.reload();
  await page.waitForSelector('[data-act="options"]');
  report.ok('saved reset survives reload', await ink(page) === '#d6294e');
  report.noErrors(errors);
  await ctx.close();
} finally {
  await browser.close();
  await close();
}
report.done();
