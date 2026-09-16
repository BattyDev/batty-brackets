/* Brackets · browser test harness
   ===========================================================================
   Everything the browser suites share: a static server, a browser, a way to
   say "this passed", and the two or three setup dances every suite needs
   before it can assert anything.

   ## Why these tests exist at all

   The Node tests next door (`bracket.test.mjs`, `theme.test.mjs`) cover pure
   functions, which is the easy half. Every bug this project has actually
   shipped lived in the other half:

     · a tour card that destroyed and rebuilt itself once a second, so it
       jumped away from the pointer
     · `opacity` dimming text below contrast, twice, in two different views
     · a bracket pane you could not scroll without a mouse
     · a session written one level too deep, so a reload signed you out
     · a TV screen that drew eight perfectly sized empty columns

   Not one of those is visible to a unit test. They are all visible in about
   four lines of Playwright. That is the case for this directory.

   ## The rule these suites follow

   **Assert, do not print.** An earlier version of these scripts logged what
   it found and left a human to notice something was wrong, which is not a
   test — it is a screenshot with extra steps. Every check here ends in `ok()`
   and the process exits non-zero if any of them failed, so CI can run it and
   so can you, without reading anything.

   ## Running them

     node test/run.mjs            # everything, node + browser
     node test/browser/a11y.test.mjs   # one suite

   The runner starts its own server on a free port. If a suite is run
   directly it starts one too, so there is nothing to remember.
   =========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../..');
const PARENT_ROOT = path.dirname(APP_ROOT);
const IS_SITE_CHECKOUT = path.basename(APP_ROOT) === 'brackets'
  && fs.existsSync(path.join(PARENT_ROOT, 'index.html'));
export const REPO_ROOT = IS_SITE_CHECKOUT ? PARENT_ROOT : APP_ROOT;
export const APP_BASE_PATH = IS_SITE_CHECKOUT ? '/brackets/' : '/';

/* --------------------------------------------------------------------------
   Static server
   --------------------------------------------------------------------------
   The site has no build step, so serving the repo directory IS the app. Node's
   own http module rather than a dependency: one fewer thing to install, and
   the whole implementation is shorter than the argument for the alternative.

   Port 0 asks the OS for a free one. Suites used to hardcode 8765 and would
   fail against a stale server left running from a previous session -- worse,
   fail by testing the OLD code and passing.
   -------------------------------------------------------------------------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export function serve(root = REPO_ROOT) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(root, url);
    /* Refuse to serve outside the root even though this only ever listens on
       localhost. A test server that can read your home directory is still a
       thing you should not write. */
    if (!file.startsWith(root)) { res.writeHead(403).end('no'); return; }
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch { /* falls through to the 404 below */ }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}${APP_BASE_PATH}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/* --------------------------------------------------------------------------
   Finding a browser
   --------------------------------------------------------------------------
   `chromium.launch()` with no arguments is the right answer on a machine
   where `npx playwright install chromium` has been run, and it is tried
   first. It is NOT the right answer everywhere: a container that ships a
   browser build older than the installed Playwright expects will fail on the
   revision number alone, even though the browser sitting next to it works
   perfectly.

   So: honour an explicit override, then try the normal path, then go looking.
   The error at the end names all three, because "Executable doesn't exist"
   with a path you have never heard of is a bad afternoon.
   -------------------------------------------------------------------------- */

function findChromium() {
  if (process.env.BRACKETS_CHROMIUM) return process.env.BRACKETS_CHROMIUM;
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!dir || !fs.existsSync(dir)) return null;
  const candidates = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith('chromium')) continue;
    if (entry.includes('headless_shell')) continue; // no --headed, and axe wants a real one
    for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe', '']) {
      const full = rel ? path.join(dir, entry, rel) : path.join(dir, entry);
      try { if (fs.statSync(full).isFile()) candidates.push(full); } catch { /* next */ }
    }
  }
  /* Highest build number wins when a container has several. */
  return candidates.sort().pop() || null;
}

export async function launch() {
  if (!process.env.BRACKETS_CHROMIUM) {
    try { return await chromium.launch(); } catch { /* fall through and go looking */ }
  }
  const executablePath = findChromium();
  if (executablePath) return chromium.launch({ executablePath });
  throw new Error(
    'No Chromium found. Either run `npx playwright install chromium`, '
    + 'or set BRACKETS_CHROMIUM to a browser binary.',
  );
}

/* --------------------------------------------------------------------------
   Assertions
   -------------------------------------------------------------------------- */

export function reporter(name) {
  let failed = 0;
  let passed = 0;
  return {
    ok(label, condition, detail = '') {
      if (condition) { passed += 1; console.log(`  ok   ${label}`); return true; }
      failed += 1;
      console.log(`  FAIL ${label}${detail ? `\n         ${String(detail).replace(/\n/g, '\n         ')}` : ''}`);
      return false;
    },
    /* Suites that open pages collect console errors as they go; a page that
       throws while rendering is a failure even when every explicit assertion
       passed. This is how the "session stored one level too deep" bug would
       have been caught. */
    noErrors(errors) {
      return this.ok(`no page errors (${errors.length})`, errors.length === 0, errors.slice(0, 5).join('\n'));
    },
    done() {
      console.log(`\n${name}: ${passed} passed, ${failed} failed`);
      process.exitCode = failed ? 1 : 0;
      return failed;
    },
  };
}

/* --------------------------------------------------------------------------
   Page setup
   --------------------------------------------------------------------------
   `openApp` waits for the demo seed rather than a fixed timeout. Boot is
   async -- it imports the store, seeds the demo event and draws -- and a
   `waitForTimeout(800)` scattered through eight suites is both slower than it
   needs to be and flaky on a loaded machine. Waiting for the thing you
   actually need is faster AND more reliable, which is a rare combination.
   -------------------------------------------------------------------------- */

export const DEMO_EVENT = 'evt_demo_tokon';
export const DEMO_PLAYER = 'plr_demo01';

export async function openApp(browser, { base, width = 1280, height = 900, scheme = 'dark', reducedMotion, errors } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    ...(reducedMotion ? { reducedMotion } : {}),
  });
  const page = await ctx.newPage();
  if (errors) {
    page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`CONSOLE ${m.text()}`); });
  }
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.textContent?.trim()), null, { timeout: 15000 });
  return { ctx, page };
}

/* Navigate and wait for the view to have drawn. The router is synchronous
   after the hash changes, but view modules are dynamically imported, so the
   first visit to a route has a real await in it. */
export async function goTo(page, base, hash) {
  await page.goto(base + hash);
  await page.waitForFunction(() => Boolean(document.querySelector('main')?.textContent?.trim()));
  await page.waitForTimeout(120); // one frame for layout to settle
}

/* Several suites need a bracket that exists. Generating one through the UI
   rather than writing store rows directly is deliberate: it means the setup
   itself is under test, and a change that breaks generation fails eight
   suites loudly instead of leaving them quietly asserting nothing. */
export async function generateBracket(page, base, event = DEMO_EVENT) {
  await goTo(page, base, `#/e/${event}/admin/seeding`);
  const button = await page.$('[data-act="generate-bracket"]');
  if (button) {
    await button.click();
    await page.waitForFunction(() => location.hash.includes('/run') || document.querySelector('.bracket-scroll'));
    await page.waitForTimeout(200);
  }
}

/* Play the event forward: call whatever is ready, report it, repeat. Used by
   the TV suite, which is meaningless against an untouched bracket.

   `leaveLive` is not a detail. Reporting every set you call leaves the venue
   with a deep bracket and FIVE EMPTY STATIONS, which is a state a real event
   is never in and which makes the queue screen -- the whole point of the TV
   view -- assert nothing. So the last few are called and left running, the
   same shape the demo tour sets up. */
export async function playSets(page, count, { leaveLive = 3 } = {}) {
  let played = 0;
  for (let i = 0; i < count; i += 1) {
    const call = await page.$('[data-act="call-next"]');
    if (call) { await call.click(); await page.waitForTimeout(150); }
    const report = await page.$('[data-act="report-open"]');
    if (!report) break;
    await report.click();
    await page.waitForTimeout(180);
    const two = await page.$('dialog.m3 [data-score-side="a"][data-score="2"]');
    if (two) await two.click();
    const buttons = await page.$$('dialog.m3 .dialog-actions button');
    for (const b of buttons) if ((await b.textContent()).trim() === 'Save') await b.click();
    await page.waitForTimeout(180);
    played += 1;
  }
  for (let i = 0; i < leaveLive; i += 1) {
    const call = await page.$('[data-act="call-next"]');
    if (!call) break;
    await call.click();
    await page.waitForTimeout(150);
  }
  return played;
}

/* Suites run standalone as often as through the runner. This lets each one
   say `const { base, close } = await standalone()` and not care which. */
export async function standalone() {
  if (process.env.BRACKETS_TEST_BASE) return { base: process.env.BRACKETS_TEST_BASE, close: async () => {} };
  return serve();
}
