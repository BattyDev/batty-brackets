import fs from 'node:fs';
import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { launch, standalone, reporter, REPO_ROOT } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('platform-admin');
const errors = [];

async function signInAndVerify(page, expectedHeading = 'Overview') {
  await page.getByLabel('Email address').fill('admin@example.test');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Authenticator code').fill('123456');
  await page.getByRole('button', { name: /verify/i }).click();
  await page.getByRole('heading', { name: expectedHeading, exact: true }).waitFor();
}

try {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'platform-admin.js'), 'utf8');
  report.ok('admin auth uses a separate persisted session namespace',
    /storageKey:\s*['"]batty-brackets-platform-admin['"]/.test(script));
  report.ok('no privileged server credential is embedded in the admin client',
    !/service[_-]?role|sb_secret_/i.test(script));
  report.ok('admin data is gated behind the AAL2 access RPC',
    /beginSecurityFlow[\s\S]*getAuthenticatorAssuranceLevel[\s\S]*authorizeAdmin/.test(script));
  report.ok('stale AAL2 tokens are rejected after factor removal',
    /currentLevel === 'aal2'\s*&&\s*aal\.nextLevel === 'aal2'/.test(script));
  report.ok('production admin password sign-in carries the configured CAPTCHA token',
    /captcha\.token\(form\)[\s\S]*signInWithPassword\(\{ email, password, options: \{ captchaToken \} \}\)/.test(script));

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}platform-admin.html?platform-admin-test=1`);

  report.ok('signed-out admin page exposes only the dedicated login',
    await page.getByRole('heading', { name: 'Platform Admin', exact: true }).count() === 1
      && await page.getByRole('button', { name: 'Sign in', exact: true }).count() === 1
      && await page.getByText('Events', { exact: true }).count() === 0);
  const loginA11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  report.ok('dedicated admin login has no automated accessibility violations', loginA11y.violations.length === 0,
    loginA11y.violations.map((item) => `${item.id}: ${item.help}`).join('\n'));

  await signInAndVerify(page);
  report.ok('MFA verification advances deterministically into the authorized console',
    /12/.test(await page.locator('.metric-card').filter({ hasText: 'Events' }).first().innerText()));
  report.ok('moderators receive the moderation workspaces',
    await page.getByRole('button', { name: /moderation queue/i }).count() >= 1
      && await page.getByRole('button', { name: /content/i }).count() >= 1
      && await page.getByRole('button', { name: /audit/i }).count() >= 1);
  report.ok('the MFA and access RPCs ran before metrics', await page.evaluate(() => {
    const names = (window.__PLATFORM_ADMIN_TEST_CALLS__ || []).map((call) => call.name);
    return names[0] === 'bkt_admin_access' && names.includes('bkt_admin_metrics');
  }));
  await page.locator('[data-view="content"]').first().click();
  await page.getByRole('heading', { name: 'Content search', exact: true }).waitFor();
  report.ok('event documents are included in the admin content feed',
    await page.getByText('documents', { exact: true }).count() >= 1);
  await page.locator('[data-act="moderate"][data-action="hide"]').first().click();
  await page.getByRole('button', { name: 'Apply Hide', exact: true }).click();
  await page.waitForTimeout(100);
  report.ok('a moderation reason is required before submission', await page.locator('dialog[open]').count() === 1
    && await page.evaluate(() => !(window.__PLATFORM_ADMIN_TEST_CALLS__ || []).some((item) => item.name === 'bkt_admin_moderate')));
  await page.getByLabel('Reason', { exact: true }).fill('Browser moderation regression');
  await page.getByRole('button', { name: 'Apply Hide', exact: true }).click();
  await page.locator('dialog').waitFor({ state: 'detached' });
  report.ok('moderation decisions use the audited RPC payload', await page.evaluate(() => {
    const call = (window.__PLATFORM_ADMIN_TEST_CALLS__ || []).find((item) => item.name === 'bkt_admin_moderate');
    return call?.args?.p_action === 'hide' && call.args.p_reason === 'Browser moderation regression';
  }));
  const consoleA11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  report.ok('authorized admin console has no automated accessibility violations', consoleA11y.violations.length === 0,
    consoleA11y.violations.map((item) => `${item.id}: ${item.help}`).join('\n'));

  await page.getByLabel('Search content').fill('overrides');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText('overrides', { exact: true }).waitFor();
  report.ok('event overrides are searchable as structured public content', await page.evaluate(() =>
    (window.__PLATFORM_ADMIN_TEST_CALLS__ || []).some((call) => call.name === 'bkt_admin_content' && call.args.p_search === 'overrides')));

  await page.getByLabel('Search content').fill('bracket');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('cell', { name: 'Bracket', exact: true }).first().waitFor();
  report.ok('content search is sent to the server with its text filter', await page.evaluate(() =>
    (window.__PLATFORM_ADMIN_TEST_CALLS__ || []).some((call) => call.name === 'bkt_admin_content' && call.args.p_search === 'bracket')));
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await page.getByText('losers', { exact: false }).waitFor();
  report.ok('content search remains active when loading the next server page', await page.evaluate(() => {
    const calls = (window.__PLATFORM_ADMIN_TEST_CALLS__ || []).filter((call) => call.name === 'bkt_admin_content');
    return calls.at(-1)?.args?.p_search === 'bracket' && calls.at(-1)?.args?.p_cursor?.offset === 2;
  }));
  await page.locator('[data-act="moderate"][data-action="replace"]').first().click();
  report.ok('bracket moderation opens an explicit JSON editor',
    await page.getByLabel('Replacement JSON').count() === 1
      && await page.locator('dialog[open] textarea[name="replacement"]').count() === 1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();

  await page.locator('[data-view="queue"]').first().click();
  await page.getByRole('heading', { name: 'Moderation queue', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await page.getByText('Malformed progression').waitFor();
  report.ok('moderation queue requests the next cursor and appends the server page', await page.evaluate(() => {
    const calls = (window.__PLATFORM_ADMIN_TEST_CALLS__ || []).filter((call) => call.name === 'bkt_admin_queue');
    return calls.length >= 2 && calls.at(-1).args.p_cursor?.offset === 2;
  }));

  await page.locator('[data-view="audit"]').first().click();
  await page.getByRole('heading', { name: 'Audit log', exact: true }).waitFor();
  await page.getByLabel('Search audit log').fill('review');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  report.ok('audit search is server-backed', await page.evaluate(() =>
    (window.__PLATFORM_ADMIN_TEST_CALLS__ || []).some((call) => call.name === 'bkt_admin_audit' && call.args.p_search === 'review')));

  await page.locator('[data-view="reports"]').first().click();
  await page.getByRole('heading', { name: 'User reports', exact: true }).waitFor();
  await page.getByText('The conduct document contains an outdated policy.').waitFor();
  await page.getByRole('button', { name: 'Update review', exact: true }).click();
  await page.getByLabel('Review status').selectOption('resolved');
  await page.getByLabel('Staff note').fill('Updated after review');
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await page.getByRole('table').getByText('Resolved', { exact: true }).waitFor();
  report.ok('staff can triage a user report through the review RPC', await page.evaluate(() => {
    const calls = window.__PLATFORM_ADMIN_TEST_CALLS__ || [];
    const list = calls.find((call) => call.name === 'bkt_admin_reports');
    const update = calls.find((call) => call.name === 'bkt_admin_review_report');
    return Boolean(list) && update?.args?.p_status === 'resolved' && update.args.p_note === 'Updated after review';
  }));
  await ctx.close();

  const analystCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const analyst = await analystCtx.newPage();
  analyst.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  analyst.on('pageerror', (error) => errors.push(error.message));
  await analyst.goto(`${base}platform-admin.html?platform-admin-test=1&role=analyst#metrics`);
  await signInAndVerify(analyst, 'Metrics');
  report.ok('analysts are metrics-only in the navigation',
    await analyst.getByRole('button', { name: /metrics/i }).count() >= 1
      && await analyst.getByRole('button', { name: /moderation queue/i }).count() === 0
      && await analyst.getByRole('button', { name: /content/i }).count() === 0
      && await analyst.getByRole('button', { name: /audit/i }).count() === 0
      && await analyst.getByRole('button', { name: /user reports/i }).count() === 0);
  report.ok('analyst startup never calls a moderation data RPC', await analyst.evaluate(() => {
    const names = (window.__PLATFORM_ADMIN_TEST_CALLS__ || []).map((call) => call.name);
    return !names.some((name) => ['bkt_admin_queue', 'bkt_admin_content', 'bkt_admin_audit', 'bkt_admin_reports', 'bkt_admin_review_report', 'bkt_admin_moderate'].includes(name));
  }));
  await analystCtx.close();

  report.noErrors(errors);
} finally {
  await browser.close();
  await close();
}

report.done();
