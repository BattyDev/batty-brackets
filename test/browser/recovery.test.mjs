/* Persistence and recovery are browser behaviours: the store is synchronous
   in memory, but only a real page lifecycle can prove the data reached the
   device before a reload and only a real file input can prove the restore
   guard is usable. */

import { launch, openApp, goTo, standalone, reporter } from './harness.mjs';

const { base, close } = await standalone();
const browser = await launch();
const report = reporter('recovery');

function freshId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

try {
  /* ---- a write is durable before the page can be reloaded ------------- */
  {
    const errors = [];
    const { ctx, page } = await openApp(browser, { base, errors });
    const id = freshId('evt_persist');
    await page.evaluate(async (eventId) => {
      const store = await import('./lib/store.js');
      store.apply('events', eventId, {
        name: 'Immediate local save', status: 'registration', startsAt: new Date().toISOString(),
      }, { queueIt: false });
    }, id);

    report.ok('the state mirror is written before apply returns',
      await page.evaluate((eventId) => JSON.parse(localStorage.getItem('battydev.brackets.state.v1'))?.events?.[eventId]?.name,
        id) === 'Immediate local save');
    report.ok('the combined snapshot is written before apply returns',
      await page.evaluate((eventId) => JSON.parse(localStorage.getItem('battydev.brackets.snapshot.v2'))?.state?.events?.[eventId]?.name,
        id) === 'Immediate local save');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.querySelector('main')?.textContent?.trim()));
    report.ok('a just-completed write survives an immediate reload',
      await page.evaluate(async (eventId) => (await import('./lib/store.js')).getEvent(eventId)?.name, id)
      === 'Immediate local save');
    report.noErrors(errors);
    await ctx.close();
  }

  /* A compatibility mirror can be missing while the authoritative snapshot
     is still intact. The snapshot must win; deleting one old key is not a
     supported way to clear a device anymore. */
  {
    const errors = [];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`CONSOLE ${m.text()}`); });
    const state = {
      players: {}, orgs: {},
      events: { evt_snapshot_precedence: { id: 'evt_snapshot_precedence', name: 'Snapshot survives mirror loss', status: 'registration' } },
      entries: {}, brackets: {}, results: {}, stations: {}, signatures: {},
      session: null, device: { theme: 'auto', lastEvent: null },
    };
    const snapshot = { version: 2, savedAt: new Date().toISOString(), state, queue: [] };
    await ctx.addInitScript((data) => {
      localStorage.removeItem('battydev.brackets.state.v1');
      localStorage.setItem('battydev.brackets.queue.v1', JSON.stringify(data.queue));
      localStorage.setItem('battydev.brackets.snapshot.v2', JSON.stringify(data));
    }, snapshot);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.querySelector('main')?.textContent?.trim()));
    const recovered = await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      return { name: store.getEvent('evt_snapshot_precedence')?.name, source: store.syncState().storage.source };
    });
    report.ok('a valid snapshot survives a missing legacy state mirror',
      recovered.name === 'Snapshot survives mirror loss' && recovered.source === 'snapshot', JSON.stringify(recovered));
    report.noErrors(errors);
    await ctx.close();
  }

  /* ---- exports protect the session, and restore replaces data --------- */
  {
    const errors = [];
    const { ctx, page } = await openApp(browser, { base, errors });
    const keepId = freshId('evt_keep');
    const replaceId = freshId('evt_replace');
    await page.evaluate(async ({ keepId, replaceId }) => {
      const store = await import('./lib/store.js');
      store.setSession({ playerId: 'local_private', email: 'private@example.test', accessToken: 'must-not-export' });
      store.apply('events', keepId, { name: 'Keep from backup', status: 'registration' }, { queueIt: false });
      store.apply('events', replaceId, { name: 'Replace before restore', status: 'registration' }, { queueIt: false });
    }, { keepId, replaceId });

    const backup = await page.evaluate(async () => (await import('./lib/store.js')).exportAll());
    const exported = JSON.parse(backup);
    report.ok('backup has an explicit portable shape', exported.backup === 'battydev.brackets' && exported.version === 2);
    report.ok('backup excludes the signed-in session and private token',
      exported.state.session === null && !backup.includes('must-not-export'));
    const legacyV1 = await page.evaluate(async (state) =>
      (await import('./lib/store.js')).inspectBackup(JSON.stringify({ ...state, version: 1 })), exported.state);
    report.ok('legitimate flat v1 backups remain importable', legacyV1.ok === true, JSON.stringify(legacyV1));

    const queueLeak = await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      store.apply('events', 'evt_queue_secret', {
        name: 'Queued portable row', accessToken: 'must-not-export-queued', refreshToken: 'must-not-export-refresh',
      });
      const text = store.exportAll();
      const copy = JSON.parse(text);
      copy.state.events.evt_queue_secret.accessToken = 'foreign-secret';
      return {
        exported: !text.includes('must-not-export-queued') && !text.includes('must-not-export-refresh'),
        inspectRejects: !store.inspectBackup(JSON.stringify(copy)).ok,
      };
    });
    report.ok('backup state and queued patches exclude credential-like fields',
      queueLeak.exported && queueLeak.inspectRejects, JSON.stringify(queueLeak));

    const invalid = await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      const before = Object.keys(store.get().events).length;
      const checked = store.inspectBackup(JSON.stringify({ state: { events: [] } }));
      let threw = false;
      try { store.restoreBackup(JSON.stringify({ state: { events: [] } })); } catch { threw = true; }
      return { before, after: Object.keys(store.get().events).length, checked: checked.ok, threw };
    });
    report.ok('malformed data is rejected before replacement',
      invalid.before === invalid.after && invalid.checked === false && invalid.threw === true);

    const malformedRows = await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      const valid = JSON.parse(store.exportAll());
      valid.state.events = { broken: null };
      const checked = store.inspectBackup(JSON.stringify(valid));
      valid.state.events = { broken: [] };
      const arrayRejected = !store.inspectBackup(JSON.stringify(valid)).ok;
      valid.state.events = {};
      valid.state.players = { broken: 7 };
      const primitiveRejected = !store.inspectBackup(JSON.stringify(valid)).ok;
      const before = store.getEvent('evt_keep')?.name;
      let threw = false;
      valid.state.events = { broken: null };
      try { store.restoreBackup(JSON.stringify(valid)); } catch { threw = true; }
      return {
        checked: checked.ok, arrayRejected, primitiveRejected, threw,
        after: store.getEvent('evt_keep')?.name, before,
      };
    });
    report.ok('malformed rows are rejected without changing existing data',
      !malformedRows.checked && malformedRows.arrayRejected && malformedRows.primitiveRejected
        && malformedRows.threw && malformedRows.before === malformedRows.after,
      JSON.stringify(malformedRows));

    const malformedBracket = await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      const valid = JSON.parse(store.exportAll());
      valid.state.brackets = {
        broken_bracket: {
          id: 'broken_bracket', eventId: 'evt_keep', type: 'single', size: 8, rounds: 3,
          matches: [{ id: 'W1-1', bracket: 'W', round: 1, index: 0, name: 'Broken', slots: [] }],
        },
      };
      return !store.inspectBackup(JSON.stringify(valid)).ok;
    });
    report.ok('invalid bracket structures are rejected before replacement', malformedBracket);

    await page.evaluate(async ({ replaceId }) => {
      const store = await import('./lib/store.js');
      store.checkpoint('old dataset edit', [{ collection: 'events', id: replaceId }]);
      store.apply('events', replaceId, { name: 'Changed after checkpoint' }, { queueIt: false });
    }, { replaceId });

    await page.evaluate(async (text) => {
      const store = await import('./lib/store.js');
      store.apply('events', 'evt_only_after_backup', { name: 'Not in backup', status: 'registration' }, { queueIt: false });
      store.restoreBackup(text);
    }, backup);
    report.ok('restore replaces local event data',
      await page.evaluate(async ({ keepId, replaceId }) => {
        const store = await import('./lib/store.js');
        return store.getEvent(keepId)?.name === 'Keep from backup'
          && store.getEvent(replaceId)?.name === 'Replace before restore'
          && !store.getEvent('evt_only_after_backup');
      }, { keepId, replaceId }));
    report.ok('restore keeps the current session in this browser',
      await page.evaluate(async () => (await import('./lib/store.js')).getSession()?.playerId === 'local_private'));
    const undoAfterRestore = await page.evaluate(async ({ replaceId }) => {
      const store = await import('./lib/store.js');
      const restoredName = store.getEvent(replaceId)?.name;
      return { restoredName, canUndo: store.canUndo(), undo: store.undo(), afterUndo: store.getEvent(replaceId)?.name };
    }, { replaceId });
    report.ok('restore clears undo history from the replaced dataset',
      undoAfterRestore.restoredName === 'Replace before restore'
        && undoAfterRestore.canUndo === false && undoAfterRestore.undo === null
        && undoAfterRestore.afterUndo === 'Replace before restore', JSON.stringify(undoAfterRestore));

    await goTo(page, base, '#/recovery');
    report.ok('the recovery route exposes a download and restore workflow',
      await page.getByRole('button', { name: 'Download backup JSON' }).count() === 1
      && await page.getByLabel('Choose a Brackets backup JSON file').count() === 1);
    await page.setInputFiles('#recovery-file', {
      name: 'invalid.json', mime: 'application/json',
      buffer: Buffer.from(JSON.stringify({ state: { events: [] } })),
    });
    await page.waitForTimeout(100);
    report.ok('the file picker rejects malformed data before showing restore',
      await page.locator('[role="alert"]').allTextContents().then((texts) => texts.some((text) => /valid Brackets data|format is not supported/i.test(text))));
    await page.setInputFiles('#recovery-file', {
      name: 'valid-backup.json', mime: 'application/json', buffer: Buffer.from(backup),
    });
    await page.waitForSelector('text=Ready to restore valid-backup.json');
    report.ok('a valid backup is previewed before replacement',
      await page.getByRole('button', { name: 'Restore and replace local data' }).count() === 1);
    await page.getByRole('button', { name: 'Restore and replace local data' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Restore and replace', exact: true }).click();
    await page.waitForTimeout(150);
    report.ok('restore requires confirmation and then completes',
      await page.locator('main').innerText().then((text) => text.includes('Download a backup'))
      && await page.evaluate(async ({ keepId }) => (await import('./lib/store.js')).getEvent(keepId)?.name, { keepId }) === 'Keep from backup');
    report.noErrors(errors);
    await ctx.close();
  }

  /* ---- a corrupt primary falls back to the recovery copy -------------- */
  {
    const errors = [];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`CONSOLE ${m.text()}`); });
    const state = {
      players: {}, orgs: {},
      events: { evt_corrupt_recovery: { id: 'evt_corrupt_recovery', name: 'Recovered event', status: 'registration' } },
      entries: {}, brackets: {}, results: {}, stations: {}, signatures: {},
      session: null, device: { theme: 'auto', lastEvent: null },
    };
    const backup = { version: 2, savedAt: new Date().toISOString(), state, queue: [] };
    await ctx.addInitScript((data) => {
      localStorage.setItem('battydev.brackets.state.v1', '{broken');
      localStorage.setItem('battydev.brackets.queue.v1', '[]');
      localStorage.setItem('battydev.brackets.snapshot.v2', '{broken');
      localStorage.setItem('battydev.brackets.snapshot.backup.v2', JSON.stringify(data));
    }, backup);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.querySelector('main')?.textContent?.trim()));
    const recovered = await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      const sync = store.syncState();
      return { name: store.getEvent('evt_corrupt_recovery')?.name, warning: sync.storage.warning };
    });
    report.ok('corrupt local data opens from the last good recovery copy',
      recovered.name === 'Recovered event' && /recovery copy/i.test(recovered.warning || ''), JSON.stringify(recovered));
    report.noErrors(errors);
    await ctx.close();
  }

  /* ---- quota failure is visible while memory remains usable ------------ */
  {
    const errors = [];
    const { ctx, page } = await openApp(browser, { base, errors });
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'battydev.brackets.snapshot.v2') {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        return original.call(this, key, value);
      };
    });
    await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      store.apply('events', 'evt_quota_memory', { name: 'Memory copy', status: 'registration' }, { queueIt: false });
    });
    const quota = await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      return {
        memory: store.getEvent('evt_quota_memory')?.name,
        error: store.syncState().storage.error,
      };
    });
    report.ok('quota failure keeps the in-memory write but reports failed durability',
      quota.memory === 'Memory copy' && /storage limit|could not save/i.test(quota.error || ''), JSON.stringify(quota));
    await goTo(page, base, '#/recovery');
    report.ok('the recovery screen repeats the local-save failure honestly',
      await page.locator('main').innerText().then((text) => /Local save needs attention/i.test(text)));
    report.noErrors(errors);
    await ctx.close();
  }

  /* ---- failed sync remains recoverable and local data remains ---------- */
  {
    const errors = [];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`CONSOLE ${m.text()}`); });
    const state = {
      players: {}, orgs: {},
      events: { evt_failed_sync: { id: 'evt_failed_sync', name: 'Still local', status: 'registration' } },
      entries: {}, brackets: {}, results: {}, stations: {}, signatures: {},
      session: null, device: { theme: 'auto', lastEvent: null },
    };
    const queue = [{
      op: 'op_failed_sync', collection: 'events', id: 'evt_failed_sync',
      patch: { name: 'Still local', status: 'registration' },
      at: new Date().toISOString(), device: 'test-device', tries: 10, blocked: false,
    }];
    const snapshot = { version: 2, savedAt: new Date().toISOString(), state, queue };
    await ctx.addInitScript((data) => {
      localStorage.setItem('battydev.brackets.snapshot.v2', JSON.stringify(data));
      localStorage.setItem('battydev.brackets.state.v1', JSON.stringify(data.state));
      localStorage.setItem('battydev.brackets.queue.v1', JSON.stringify(data.queue));
    }, snapshot);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.querySelector('main')?.textContent?.trim()));
    await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      window.__serverCalls = 0;
      store.attach({ from: () => {
        window.__serverCalls += 1;
        return {
        upsert: async () => ({ error: { message: 'server rejected this write' } }),
        delete: () => ({ eq: async () => ({ error: { message: 'server rejected this write' } }) }),
        };
      } });
    });
    await page.waitForFunction(async () => (await import('./lib/store.js')).syncState().failed === 1);
    const failed = await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      const op = JSON.parse(localStorage.getItem('battydev.brackets.queue.v1'))[0];
      return { state: store.getEvent('evt_failed_sync')?.name, op };
    });
    report.ok('a repeatedly rejected write stays in the queue',
      failed.op.blocked === true && failed.op.tries === 11 && /rejected/.test(failed.op.lastError), JSON.stringify(failed));
    report.ok('the rejected write remains recoverable in a backup',
      await page.evaluate(async () => JSON.parse((await import('./lib/store.js')).exportAll()).queue[0].blocked === true),
      await page.evaluate(async () => JSON.stringify((await import('./lib/store.js')).syncState())));

    const discarded = await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      const count = store.discardFailed();
      return { count, local: store.getEvent('evt_failed_sync')?.name, queue: store.syncState().pending };
    });
    report.ok('discarding a failed server attempt keeps local data',
      discarded.count === 1 && discarded.local === 'Still local' && discarded.queue === 0, JSON.stringify(discarded));

    const restoredPending = await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      const backup = JSON.parse(store.exportAll());
      backup.queue = [{
        op: 'op_foreign_restore', collection: 'events', id: 'evt_failed_sync',
        patch: { name: 'Restored but not yet approved' }, at: new Date().toISOString(),
        tries: 0, blocked: false,
      }];
      const before = window.__serverCalls;
      store.restoreBackup(JSON.stringify(backup));
      return {
        before,
        after: window.__serverCalls,
        review: store.syncState().review,
        pending: store.syncState().pending,
      };
    });
    report.ok('restored server writes wait for deliberate approval',
      restoredPending.before === restoredPending.after
        && restoredPending.review === 1 && restoredPending.pending === 1,
      JSON.stringify(restoredPending));
    await goTo(page, base, '#/recovery');
    report.ok('the recovery screen exposes explicit approval for restored writes',
      await page.getByRole('button', { name: 'Approve restored writes' }).count() === 1);

    const resetUndo = await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      store.checkpoint('before supported reset', [{ collection: 'events', id: 'evt_failed_sync' }]);
      store.reset();
      return { canUndo: store.canUndo(), event: store.getEvent('evt_failed_sync') };
    });
    report.ok('reset clears undo history as well as local data',
      resetUndo.canUndo === false && resetUndo.event === null, JSON.stringify(resetUndo));
    report.noErrors(errors);
    await ctx.close();
  }
} finally {
  await browser.close();
  await close();
}

report.done();
