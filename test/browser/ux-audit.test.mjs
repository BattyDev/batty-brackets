/* Focused October UX coverage. Fixtures are isolated device-local demo data. */
import fs from 'node:fs';
import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { launch, openApp, openDemo, goTo, standalone, reporter, DEMO_EVENT } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('ux-audit');
const errors = [];
const shots = process.env.BRACKETS_SCREENSHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const capture = async (page, name) => { if (shots) { await page.locator('.snackbar').waitFor({ state:'detached',timeout:6500 }); await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: false }); } };
const fits = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

try {
  const { ctx, page } = await openDemo(browser, { base, width: 1440, height: 900, scheme: 'light', errors });
  await page.evaluate(async eventId => {
    const store = await import('./lib/store.js');
    store.apply('events', eventId, { status: 'checkin', documents: [], entryFee: 10,
      capacity: store.entriesFor(eventId).filter(e => !e.waitlisted).length + 1 }, { queueIt: false });
  }, DEMO_EVENT);
  await page.setViewportSize({width:390,height:844});
  await goTo(page,base,'#/join/TKN14B');
  report.ok('resolved invite skips the code form', await page.locator('.join-lookup').count()===0 && await page.getByRole('link',{name:'Use a different code',exact:true}).count()===1);
  report.ok('resolved invite shows its entry action on the first phone screen', (await page.locator('.guest-entry-form button[type="submit"]').boundingBox()).y < 700);
  await capture(page,'invite-390');
  await page.setViewportSize({width:1440,height:900});
  await goTo(page, base, `#/e/${DEMO_EVENT}/admin/entrants`);
  async function add(tag) {
    await page.locator('[data-act="entrant-add"]').first().click();
    await page.getByRole('dialog').getByLabel('Tag', { exact: true }).fill(tag);
    await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
    await page.waitForSelector('dialog', { state: 'detached' });
  }
  await add('October desk entrant');
  await add('October waitlisted');
  await page.reload();
  await page.waitForSelector('table.roster-table');
  const created = await page.evaluate(async eventId => {
    const store = await import('./lib/store.js');
    return store.entriesFor(eventId).filter(e => store.getPlayer(e.playerId)?.tag.startsWith('October'));
  }, DEMO_EVENT);
  report.ok('check-in walk-up retains persisted door source and capacity after reload',
    created.length === 2 && created.every(e => e.source === 'door') && created.filter(e => e.waitlisted).length === 1);
  await page.getByRole('button', { name: /^Walk-ups/ }).click();
  report.ok('walk-up filter finds both door entries', /October desk entrant/.test(await page.locator('tbody').innerText()) && /October waitlisted/.test(await page.locator('tbody').innerText()));
  await capture(page, 'host-door-desktop');

  const admitted = created.find(e => !e.waitlisted);
  await page.evaluate(async id => {
    const store = await import('./lib/store.js');
    store.apply('entries', id, { amountDue: 10, amountPaid: 4, paymentNote: 'UX bookkeeping only' }, { queueIt: false });
  }, admitted.id);
  await page.locator(`[data-act="toggle-paid"][data-id="${admitted.id}"]`).click();
  await page.getByRole('button', { name: /^Mark paid in full/ }).click();
  report.ok('full payment fills a cumulative total before confirmation', await page.getByLabel('Total amount received (USD)', { exact: true }).inputValue() === '10');
  await page.getByRole('button', { name: 'Save payment', exact: true }).click();
  await page.waitForSelector('dialog', { state: 'detached' });
  const payment = await page.evaluate(async id => (await import('./lib/store.js')).get().entries[id], admitted.id);
  report.ok('full payment preserves the charge and note', payment.amountDue === 10 && payment.amountPaid === 10 && payment.paymentNote === 'UX bookkeeping only');
  await page.setViewportSize({ width: 390, height: 844 });
  await goTo(page, base, `#/e/${DEMO_EVENT}/admin/entrants`);
  await page.evaluate(() => window.scrollTo(0, 0));
  report.ok('mobile host navigation stays one row', await page.locator('.host-tabs').evaluate(el => el.getBoundingClientRect().height <= 60));
  report.ok('phone roster keeps secondary fields in entrant details', await page.locator('tbody tr').first().locator('td').nth(1).isHidden());
  report.ok('phone host has no page overflow', await fits(page), JSON.stringify(await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, wide: [...document.querySelectorAll('main *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(el => [el.tagName, el.className, el.getBoundingClientRect().width]) }))));
  await capture(page, 'host-door-390');

  await page.evaluate(async ({ eventId, entryId }) => {
    const store = await import('./lib/store.js'); const auth = await import('./lib/auth.js');
    const me = store.get().entries[entryId];
    const other = store.entriesFor(eventId).find(e => e.id !== entryId && !e.waitlisted);
    const station = store.stationsFor(eventId)[0];
    auth.adoptLocalSession({ playerId: me.playerId, local: true });
    store.apply('events', eventId, { status: 'running' }, { queueIt: false });
    store.apply('brackets', eventId, { id: eventId, eventId, type: 'double', matches: [{
      id: 'UX-called', name: 'Winners semifinal', bracket: 'W', round: 1, state: null,
      calledAt: new Date().toISOString(), stationId: station.id,
      slots: [{ entrantId: me.id }, { entrantId: other.id }],
    }] }, { queueIt: false });
  }, { eventId: DEMO_EVENT, entryId: admitted.id });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 700 : 844 });
    await goTo(page, base, `#/e/${DEMO_EVENT}`);
    const station = await page.locator('#current-set-heading').boundingBox();
    report.ok(`${width}px: station and opponent are on the first screen`, station.y < 400 && await page.locator('.next-set .title-medium').isVisible());
    report.ok(`${width}px: settled payment starts collapsed after the task`, !await page.locator('.player-payment').evaluate(el => el.open));
    report.ok(`${width}px: player screen reflows`, await fits(page));
    await capture(page, 'player-called-' + width);
  }

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await goTo(page, base, '#/about');
    report.ok(`${width}px: installed help reflows`, await fits(page));
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    report.ok(`${width}px: installed help passes axe`, axe.violations.length === 0, JSON.stringify(axe.violations.map(v => v.id)));
    await capture(page, 'about-' + width);
    await goTo(page, base, '#/about/walkup');
    report.ok(`${width}px: contextual help opens the right question`, await page.locator('#walkup').evaluate(el => el.open));
  }

  await page.getByRole('button', { name: 'Options', exact: true }).click();
  const layout = await page.locator('dialog').evaluate(el => ({
    overflow: el.scrollWidth - el.clientWidth,
    outerScroll: el.scrollHeight > el.clientHeight + 1,
    bodyScroll: el.querySelector('.dialog-body').scrollHeight > el.querySelector('.dialog-body').clientHeight,
    choices: el.querySelectorAll('.ink-choices [data-ink]').length,
  }));
  report.ok('Options has one scrolling body and no horizontal overflow', layout.overflow <= 1 && !layout.outerScroll && layout.bodyScroll, JSON.stringify(layout));
  report.ok('Options retains nine presets', layout.choices === 9);
  await capture(page, 'options-320');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  report.ok('account actions are reachable separately', await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // Check the selected hover pair itself, across every preset and both papers.
  await page.evaluate(() => { const chip=document.createElement('button'); chip.id='hover-chip'; chip.className='chip selected'; chip.textContent='Selected'; chip.setAttribute('aria-pressed','true'); document.querySelector('main').prepend(chip); });
  const presetColors = await page.evaluate(async () => (await import('./lib/appearance.js')).PRESETS.map(preset => preset.color));
  for (const paper of ['light', 'dark']) {
    for (const color of presetColors) {
      await page.evaluate(async ({paper,color}) => { document.documentElement.dataset.theme=paper; (await import('./lib/appearance.js')).apply({ color, lettering:'anton' }); }, {paper,color});
      await page.locator('#hover-chip').hover();
      const ratio=await page.locator('#hover-chip').evaluate(el => {
        const style=getComputedStyle(el);
        const lum=color => { const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v => { const n=v/255; return n<=.04045 ? n/12.92 : ((n+.055)/1.055)**2.4; }); return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722; };
        const a=lum(style.color),b=lum(style.backgroundColor); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      });
      report.ok(`${paper}/${color}: selected hover meets text contrast`, ratio >= 4.5, String(ratio));
    }
  }
  const invalid = await openApp(browser, { base, width:390, height:844 });
  await invalid.page.evaluate(async () => {
    const store=await import('./lib/store.js'); const auth=await import('./lib/auth.js');
    window.__codeAttempts=0;
    const backend={ identity:async()=>({id:'00000000-0000-4000-8000-000000000001',tag:'Mock player'}),
      redeemCode:async()=>{window.__codeAttempts++;throw new Error('invalid_code');}, listEvents:async()=>[] };
    await store.attachBackend(backend,{projectUrl:'https://mock.example.test',accountId:'mock-account'});
    await auth.initAuth({ auth:{getSession:async()=>({data:{session:{user:{id:'mock-account',identities:[],app_metadata:{providers:['email']},user_metadata:{}}}}}),onAuthStateChange(){} } }, {connectedBackend:backend});
    location.hash='#/join/ABCDEFGH2345';
  });
  await invalid.page.getByText('We couldn’t find that invitation.',{exact:true}).waitFor();
  for (let i=0;i<3;i++) await invalid.page.evaluate(()=>window.dispatchEvent(new HashChangeEvent('hashchange')));
  report.ok('invalid connected code stays failed through redraws', await invalid.page.evaluate(()=>window.__codeAttempts)===1);
  await invalid.page.getByRole('button',{name:'Retry lookup',exact:true}).click();
  await invalid.page.waitForFunction(()=>window.__codeAttempts===2);
  report.ok('explicit retry makes one new code attempt', await invalid.page.evaluate(()=>window.__codeAttempts)===2);
  await invalid.ctx.close();
  report.noErrors(errors);
  await ctx.close();
} finally { await browser.close(); await close(); }
report.done();
