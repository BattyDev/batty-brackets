/* Selected suites run with concise output; use --verbose for live diagnostics.
   No filters runs all suites. Browser dependencies remain optional locally. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const unknown = args.filter((arg) => arg.startsWith('-') && arg !== '--verbose');
if (unknown.length) {
  console.error(`Unknown option: ${unknown.join(', ')}. Use --verbose or suite names.`);
  process.exit(1);
}
const filters = args.filter((arg) => arg !== '--verbose');
const wanted = (name) => !filters.length || filters.some((f) => name.includes(f));
const discover = (dir) => fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs') && wanted(f)).sort();
const nodeSuites = discover(HERE);
const browserSuites = discover(path.join(HERE, 'browser'));
if (!nodeSuites.length && !browserSuites.length) {
  console.error(`Nothing matched ${filters.join(', ')}.`);
  process.exit(1);
}

function run(file, env = {}) {
  return new Promise((resolve) => {
    // Keep bounded failure diagnostics; successful assertion logs stay out of
    // agent context. Verbose mode streams the complete output when necessary.
    let output = '';
    let truncated = false;
    const collect = (chunk) => {
      output += chunk;
      if (output.length > 65536) { output = output.slice(-65536); truncated = true; }
    };
    const child = spawn(process.execPath, [file], {
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    if (!verbose) {
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', collect);
      }
    }
    let spawnError;
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code, signal) => {
      const status = spawnError ? 1 : (code ?? 1);
      if (status && !verbose && output) {
        if (truncated) console.error('[Earlier output omitted; rerun with --verbose for full diagnostics.]');
        console.error(output.trimEnd());
      }
      if (spawnError) console.error(spawnError.message);
      if (signal) console.error(`Suite terminated by ${signal}`);
      resolve(status);
    });
  });
}

const results = [];
async function runSuite(label, file, env) {
  if (verbose) console.log(`\nRunning ${label}`);
  const code = await run(file, env);
  results.push([label, code]);
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${label}`);
}
for (const suite of nodeSuites) await runSuite(suite, path.join(HERE, suite));

let skipped = 0;
if (browserSuites.length) {
  let havePlaywright = true;
  try { await import('playwright'); } catch { havePlaywright = false; }
  if (!havePlaywright) {
    skipped = browserSuites.length;
    console.log(`SKIP  ${skipped} selected browser suites — Playwright is not installed: ${browserSuites.join(', ')}`);
    console.log('  cd test && npm install && npx playwright install chromium');
  } else {
    const { serve } = await import('./browser/harness.mjs');
    const server = await serve();
    try {
      for (const suite of browserSuites) {
        await runSuite(`browser/${suite}`, path.join(HERE, 'browser', suite), { BRACKETS_TEST_BASE: server.base });
      }
    } finally {
      await server.close();
    }
  }
}
const failed = results.filter(([, code]) => code !== 0);
console.log(`${results.length - failed.length}/${results.length} executed suites passed; ${skipped} skipped`);
// Preserve failure when a browser-only request could not execute any suite.
process.exit(failed.length || !results.length ? 1 : 0);
