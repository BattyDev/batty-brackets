/* Brackets · device recovery
   ===========================================================================
   A local-first app needs a way out when the browser is full, a tab crashes,
   or a server write has been rejected for a reason the client cannot fix.
   This screen deals in the two truths separately: the local copy can be
   durable while the server queue is still waiting, and a file restore can be
   valid without being safe to apply until the organiser confirms replacement.

   Backups intentionally contain event data and recoverable queue operations,
   never the current auth session or the device identity. Restoring keeps the
   current session and device preferences, so a file cannot sign somebody in
   or move a private browser credential to another machine.
   =========================================================================== */

'use strict';

import { html, raw, icon, on, snack, dialog, formatDateTime } from '../lib/ui.js';
import * as store from '../lib/store.js';
import * as csv from '../lib/csv.js';

let pending = null;
let fileError = null;

function refresh() {
  window.dispatchEvent(new Event('brackets-recovery-change'));
}

export function view() {
  const sync = store.syncState();
  const local = sync.storage;
  const failed = sync.failed;
  const review = sync.review;

  return {
    title: 'Backup & recovery',
    back: '/',
    body: html`
      <div class="pane" style="max-width:840px">
        <section class="stack" aria-labelledby="recovery-title">
          <div>
            <h2 id="recovery-title" class="headline-medium">Your local copy</h2>
            <p class="body-medium dim" style="margin-top:4px">
              Brackets saves the working tournament on this device before it
              tries the server. A server connection is optional for a
              single-organiser local.
            </p>
          </div>

          ${local.error ? html`
            <div class="banner banner-error" role="alert">
              ${raw(icon('alert'))}
              <div><b>Local save needs attention</b><div class="body-small" style="margin-top:4px">${local.error}</div></div>
            </div>` : ''}
          ${local.warning ? html`
            <div class="banner banner-warn" role="status">
              ${raw(icon('info'))}
              <div><b>Recovery notice</b><div class="body-small" style="margin-top:4px">${local.warning}</div></div>
            </div>` : ''}

          <div class="card card-outlined">
            <div class="row-tight">
              ${raw(icon(local.error ? 'alert' : 'check'))}
              <b class="title-medium">${local.error ? 'Not confirmed saved' : 'Saved on this device'}</b>
            </div>
            <p class="body-small dim" style="margin:8px 0 0">
              ${local.lastSavedAt
                ? `Last local save: ${formatDateTime(local.lastSavedAt)}.`
                : 'No local save has completed yet.'}
              ${sync.configured
                ? (sync.lastServerSyncAt
                  ? ` Server accepted the last sync at ${formatDateTime(sync.lastServerSyncAt)}.`
                  : ' The server has not accepted a sync in this session.')
                : ' No backend is configured, so nothing is being sent anywhere.'}
            </p>
          </div>

          <div class="card card-filled">
            <div class="row-tight">
              ${raw(icon('download'))}
              <div><b class="title-medium">Download a backup</b>
                <div class="body-small dim" style="margin-top:4px">
                  Includes events, entrant data, results, and pending server writes.
                  It never includes your sign-in session or device id.
                </div>
              </div>
            </div>
            <button class="btn btn-tonal" data-act="recovery-export" style="margin-top:12px">
              ${raw(icon('download', 'icon-sm'))} Download backup JSON
            </button>
          </div>

          <div class="card card-outlined">
            <div class="row-tight">
              ${raw(icon('upload'))}
              <div><b class="title-medium">Restore a backup</b>
                <div class="body-small dim" style="margin-top:4px">
                  The file is checked before anything changes. Restore replaces
                  all local tournament data, keeps this browser signed in, and
                  requires a second confirmation.
                </div>
              </div>
            </div>
            <div class="row" style="margin-top:12px">
              <label class="btn btn-outlined" for="recovery-file">${raw(icon('upload', 'icon-sm'))} Choose backup file</label>
              <input id="recovery-file" class="sr-only" type="file" accept=".json,application/json"
                     data-act-change="recovery-file" aria-label="Choose a Brackets backup JSON file">
              ${fileError ? html`<span class="body-small" role="alert" style="color:var(--md-error)">${fileError}</span>` : ''}
            </div>
            ${pending ? html`
              <div class="banner banner-info" style="margin-top:16px">
                ${raw(icon('info'))}
                <div class="spacer">
                  <b>Ready to restore ${pending.fileName}</b>
                  <div class="body-small" style="margin-top:4px">
                    ${pending.summary.events} event${pending.summary.events === 1 ? '' : 's'},
                    ${pending.summary.players} player${pending.summary.players === 1 ? '' : 's'},
                    ${pending.summary.pending} queued write${pending.summary.pending === 1 ? '' : 's'}.
                    ${pending.summary.failed ? `${pending.summary.failed} queued write${pending.summary.failed === 1 ? '' : 's'} will remain blocked.` : ''}
                  </div>
                  <button class="btn btn-filled btn-sm" data-act="recovery-restore" style="margin-top:10px">
                    Restore and replace local data
                  </button>
                </div>
              </div>` : ''}
          </div>

          <div class="card card-outlined">
            <div class="row-tight">
              ${raw(icon('wifiOff'))}
              <div><b class="title-medium">Server sync queue</b>
                <div class="body-small dim" style="margin-top:4px">
                  ${sync.pending
                    ? `${sync.pending} operation${sync.pending === 1 ? '' : 's'} remain on this device.`
                    : 'No server operations are waiting.'}
                  ${!sync.configured ? ' With no backend configured, local work stays here.' : ''}
                </div>
              </div>
            </div>
            ${review && sync.configured ? html`
              <div class="banner banner-info" style="margin-top:12px">
                ${raw(icon('info'))}
                <div class="spacer">
                  <b>${review} restored write${review === 1 ? '' : 's'} await approval</b>
                  <div class="body-small" style="margin-top:4px">
                    These operations came from a backup. They will not be sent
                    to the configured server until you explicitly approve them.
                  </div>
                  <button class="btn btn-filled btn-sm" data-act="recovery-approve-restored" style="margin-top:10px">
                    Approve restored writes
                  </button>
                </div>
              </div>` : ''}
            ${failed ? html`
              <div class="banner banner-error" style="margin-top:12px">
                ${raw(icon('alert'))}
                <div class="spacer">
                  <b>${failed} server write${failed === 1 ? '' : 's'} blocked after repeated failure</b>
                  <div class="body-small" style="margin-top:4px">
                    The local records are still present. Retry after fixing the
                    connection, or discard only these server attempts.
                  </div>
                  <div class="row" style="margin-top:10px">
                    <button class="btn btn-tonal btn-sm" data-act="recovery-retry-failed">Retry failed writes</button>
                    <button class="btn btn-danger-text btn-sm" data-act="recovery-discard-failed">Discard failed writes</button>
                  </div>
                </div>
              </div>` : ''}
          </div>
        </section>
      </div>`,
  };
}

on('recovery-export', () => {
  csv.download('brackets-backup.json', store.exportAll(), 'application/json');
  snack('Backup downloaded. Keep it somewhere other than this device.');
});

on('recovery-file', async (_data, input) => {
  const file = input.files?.[0];
  if (!file) return;
  fileError = null;
  try {
    const checked = store.inspectBackup(await file.text());
    if (!checked.ok) {
      pending = null;
      fileError = checked.error;
    } else {
      pending = { ...checked, fileName: file.name || 'backup.json' };
    }
  } catch (error) {
    pending = null;
    fileError = `Could not read that file: ${error?.message || error}`;
  }
  input.value = '';
  refresh();
});

on('recovery-restore', () => {
  if (!pending) return;
  dialog({
    title: 'Replace local tournament data?',
    body: html`<p class="body-medium">
      This replaces every event, entrant, result, bracket, and queued server
      operation on this device with <b>${pending.fileName}</b>. Your current
      sign-in session and device settings stay here. This cannot be undone
      except by restoring another backup.
    </p>`,
    actions: [
      { label: 'Cancel', kind: 'text' },
      { label: 'Restore and replace', kind: 'danger', onClick: () => {
        const selected = pending;
        pending = null;
        try {
          const result = store.restoreBackup(selected);
          fileError = null;
          snack(result.durable
            ? `Restored ${result.events} event${result.events === 1 ? '' : 's'} on this device.`
            : 'Restore loaded, but the browser did not confirm a local save. Download a backup now.');
        } catch (error) {
          pending = selected;
          fileError = error?.message || String(error);
          snack('Restore was not applied.');
        }
        refresh();
      } },
    ],
  });
});

on('recovery-retry-failed', () => {
  const count = store.retryFailed();
  snack(count ? `Retrying ${count} failed write${count === 1 ? '' : 's'}.` : 'Nothing is blocked.');
  refresh();
});

on('recovery-approve-restored', () => {
  const count = store.syncState().review;
  if (!count) return;
  dialog({
    title: 'Send restored writes to the server?',
    body: `This allows ${count} restored server operation${count === 1 ? '' : 's'} to sync to the backend configured for this browser. Local data is not changed.`,
    actions: [
      { label: 'Keep local for now', kind: 'text' },
      { label: 'Approve and sync', kind: 'filled', onClick: () => {
        const approved = store.approveRestoredWrites();
        snack(approved ? `Approved ${approved} restored write${approved === 1 ? '' : 's'} for sync.` : 'Nothing is waiting for approval.');
        refresh();
      } },
    ],
  });
});

on('recovery-discard-failed', () => {
  const count = store.syncState().failed;
  if (!count) return;
  dialog({
    title: 'Discard failed server writes?',
    body: `This removes ${count} failed server attempt${count === 1 ? '' : 's'} from the queue. The local records stay on this device, but they will not be sent again unless you restore a backup containing them.`,
    actions: [
      { label: 'Keep them', kind: 'text' },
      { label: 'Discard attempts', kind: 'danger', onClick: () => {
        const removed = store.discardFailed();
        snack(`Discarded ${removed} failed server attempt${removed === 1 ? '' : 's'}; local data was kept.`);
        refresh();
      } },
    ],
  });
});
