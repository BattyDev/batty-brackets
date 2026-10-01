import { launch, openApp, standalone, reporter } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('auth');
const errors = [];

try {
  const { ctx, page } = await openApp(browser, { base, errors });

  /* A server-backed dialog must stay mounted until its Promise settles. This
     is the regression for password errors disappearing with the modal. */
  await page.evaluate(async () => {
    const { dialog } = await import('./lib/ui.js');
    dialog({
      title: 'Async probe',
      body: '<p>Waiting for a server.</p>',
      actions: [{
        label: 'Save',
        kind: 'filled',
        onClick: () => new Promise((resolve) => { window.__resolveDialogProbe = resolve; }),
      }],
    });
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  report.ok('async dialog remains open while its action is pending',
    await page.locator('dialog.m3[open][aria-busy="true"]').count() === 1);
  report.ok('async dialog disables its action while pending',
    await page.getByRole('button', { name: 'Save', exact: true }).isDisabled());
  await page.evaluate(() => window.__resolveDialogProbe(false));
  await page.waitForFunction(() => document.querySelector('dialog.m3')?.getAttribute('aria-busy') !== 'true');
  report.ok('a rejected form result stays visible for correction',
    await page.locator('dialog.m3[open]').count() === 1);

  await page.evaluate(async () => (await import('./views/auth.js')).openSetPassword());
  report.ok('password fallback asks for confirmation',
    await page.getByLabel('Confirm password', { exact: true }).count() === 1);
  await page.getByLabel('New password', { exact: true }).fill('long-enough-one');
  await page.getByLabel('Confirm password', { exact: true }).fill('long-enough-two');
  await page.getByRole('button', { name: 'Set password', exact: true }).click();
  report.ok('mismatched passwords stay visible with a useful error',
    await page.locator('#note').innerText().then((text) => /do not match/i.test(text))
      && await page.locator('dialog.m3[open]').count() === 1);

  await page.getByLabel('Confirm password', { exact: true }).fill('long-enough-one');
  await page.getByRole('button', { name: 'Set password', exact: true }).click();
  await page.waitForSelector('dialog.m3', { state: 'detached' });
  report.ok('successful password fallback closes only after completion', true);

  // hCaptcha places its interactive challenge beside the dialog in body. It
  // must remain clickable while the underlying application remains inert.
  await page.evaluate(async () => {
    const { dialog } = await import('./lib/ui.js');
    dialog({ title: 'CAPTCHA probe', body: '<div data-hcaptcha-widget></div>',
      actions: [{ label: 'Cancel' }] });
    const portal = document.createElement('button');
    portal.id = 'captcha-portal-probe';
    portal.textContent = 'Provider challenge probe';
    portal.style.cssText = 'position:fixed;inset:40px auto auto 40px;z-index:2147483647';
    portal.onclick = () => { portal.dataset.clicked = 'true'; };
    document.body.append(portal);
  });
  await page.getByRole('button', { name: 'Provider challenge probe', exact: true }).click();
  report.ok('provider challenge outside the form is interactive',
    await page.locator('#captcha-portal-probe').getAttribute('data-clicked') === 'true');
  report.ok('application remains inert while CAPTCHA form is open',
    await page.locator('.app').evaluate(el => el.inert));
  await page.evaluate(async () => {
    document.querySelector('#captcha-portal-probe').remove();
    (await import('./lib/ui.js')).dialog({ title: 'Replacement probe', body: '<p>Next form</p>',
      actions: [{ label: 'Cancel' }] });
  });
  report.ok('replacing a CAPTCHA dialog removes its scrim and restores app state',
    await page.locator('.dialog-scrim').count() === 0
      && !(await page.locator('.app').evaluate(el => el.inert)));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  report.noErrors(errors);
  await ctx.close();
} finally {
  await browser.close();
  await close();
}

report.done();
