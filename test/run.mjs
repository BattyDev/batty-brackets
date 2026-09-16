/* Run everything: the pure-function tests and the browser suites.
   ===========================================================================
     node test/run.mjs             # all of it
     node test/run.mjs tv roster   # only suites whose name matches

   The Node tests need nothing. The browser suites need Playwright and axe:

     cd test && npm install && npx playwright install chromium

   If Playwright is not installed the browser suites are SKIPPED with a note
   rather than failing, so `run.mjs` stays useful on a machine that only wants
   the fast half. They are not skipped if it IS installed and something goes
   wrong -- that is a failure.

   One server is started here and handed to every suite through
   BRACKETS_TEST_BASE, because starting nine of them takes longer than the
   tests do.
   =========================================================================== */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);
const wanted = (name) => !filters.length || filters.some((f) => name.includes(f));

const NODE_SUITES = fs.readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort();
const BROWSER_SUITES = fs.readdirSync(path.join(HERE, 'browser')).filter((f) => f.endsWith('.test.mjs')).sort();

function run(file, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const results = [];
let ran = 0;

for (const suite of NODE_SUITES) {
  if (!wanted(suite)) continue;
  console.log(`\n──── ${suite} ────`);
  ran += 1;
  results.push([suite, await run(path.join(HERE, suite))]);
}

/* Playwright is a 300MB dependency and the reason it is optional. Probe for
   it once rather than letting eight suites each fail with the same import
   error. */
let havePlaywright = true;
try { await import('playwright'); } catch { havePlaywright = false; }

if (!havePlaywright) {
  console.log(`\nSkipping ${BROWSER_SUITES.length} browser suites — Playwright is not installed.`);
  console.log('  cd test && npm install && npx playwright install chromium');
} else {
  // The harness imports Playwright. Load it only after the optional dependency
  // check, otherwise even the dependency-free bracket filter fails at startup.
  const { serve } = await import('./browser/harness.mjs');
  const server = await serve();
  for (const suite of BROWSER_SUITES) {
    if (!wanted(suite)) continue;
    console.log(`\n──── browser/${suite} ────`);
    ran += 1;
    results.push([`browser/${suite}`, await run(path.join(HERE, 'browser', suite), { BRACKETS_TEST_BASE: server.base })]);
  }
  await server.close();
}

if (!ran) {
  console.log(`\nNothing matched ${filters.join(', ')}.`);
  process.exit(1);
}

const failed = results.filter(([, code]) => code !== 0);
console.log(`\n${'='.repeat(60)}`);
for (const [name, code] of results) console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`${results.length - failed.length}/${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
