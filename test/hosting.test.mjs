import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinUrl } from '../lib/ui.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const index = read('index.html');
assert.match(index, /<link rel="canonical" href="https:\/\/battybrackets\.com\/">/);
assert.match(index, /<meta property="og:url" content="https:\/\/battybrackets\.com\/">/);

assert.equal(
  joinUrl(' tkn14b ', new URL('https://battybrackets.com/#/host')),
  'https://battybrackets.com/?join=TKN14B',
);
assert.equal(
  joinUrl('abc123', new URL('https://battydev.com/brackets/?old=1#/host')),
  'https://battydev.com/brackets/?join=ABC123',
);

const workflow = read('.github/workflows/ci.yml');
assert.match(workflow, /needs: test/);
assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
assert.match(workflow, /pages: write/);
assert.match(workflow, /id-token: write/);
assert.match(workflow, /environment:\s+name: github-pages/);
assert.match(workflow, /actions\/configure-pages@v5/);
assert.match(workflow, /actions\/upload-pages-artifact@v4/);
assert.match(workflow, /actions\/deploy-pages@v4/);
assert.equal(fs.existsSync(path.join(root, '.github/workflows/publish.yml')), false);

for (const name of ['index.html', 'app.js', 'views/admin.js', 'views/setup.js']) {
  assert.doesNotMatch(read(name), /battydev\.com\/brackets/);
}
assert.match(read('data/themes.js'), /src="assets\/games\//);
assert.doesNotMatch(read('data/themes.js'), /src="\.\.\/assets\/games\//);

console.log('PASS hosting: canonical domain, portable share links, root assets, and gated Pages deployment');
