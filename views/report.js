/* Public content reporting. The candidate list is built from the same public
   event and player records the page displays; private contact fields never
   enter this module. */

'use strict';

import { html, list, on, dialog, snack } from '../lib/ui.js';
import * as store from '../lib/store.js';
import * as auth from '../lib/auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const KINDS = {
  player: 'Player',
  org: 'Organization',
  event: 'Event',
  entry: 'Entrant',
  station: 'Station',
  bracket: 'Bracket',
  result: 'Result',
};

const FIELDS = {
  player: { tag: 'Player tag' },
  org: { name: 'Organization name' },
  event: {
    name: 'Event name', game_id: 'Game', format: 'Format', venue_type: 'Venue type',
    venue: 'Venue', platforms: 'Platforms', starts_at: 'Start time', preset_id: 'Rules preset',
    overrides: 'Custom rules', documents: 'Event documents', seeding_report: 'Seeding report',
  },
  entry: { crew: 'Team or venue' },
  station: { label: 'Station label', platform: 'Platform', match_id: 'Assigned match' },
  bracket: { record: 'Bracket' },
  result: { record: 'Match result' },
};

const fieldName = (kind, field) => FIELDS[kind]?.[field] || field;

function addTarget(targets, kind, id, field, label) {
  if (typeof id !== 'string' || !UUID.test(id)) return;
  if (!Object.hasOwn(FIELDS[kind] || {}, field)) return;
  targets.push({ kind, id, field, label: `${KINDS[kind]} · ${label}` });
}

export function eventTargets(eventId) {
  const event = store.getEvent(eventId);
  if (!event) return [];
  const targets = [];
  const title = event.name || 'Event';

  for (const field of ['name', 'game_id', 'format', 'venue_type', 'venue', 'platforms', 'starts_at', 'preset_id']) {
    addTarget(targets, 'event', event.id, field, title);
  }
  if (Object.keys(event.overrides || {}).length) addTarget(targets, 'event', event.id, 'overrides', title);
  if ((event.documents || []).length) addTarget(targets, 'event', event.id, 'documents', title);
  if (event.seedingReport) addTarget(targets, 'event', event.id, 'seeding_report', title);

  for (const entry of store.entriesFor(event.id)) {
    const player = store.getPlayer(entry.playerId);
    if (player) addTarget(targets, 'player', player.id, 'tag', player.tag || 'Player');
    const entrant = player?.tag || 'Entrant';
    if (entry.crew !== undefined || entry.group !== undefined) {
      addTarget(targets, 'entry', entry.id, 'crew', `${entrant} · ${entry.crew ?? entry.group}`);
    }
  }

  for (const station of store.stationsFor(event.id)) {
    addTarget(targets, 'station', station.id, 'label', station.label || `Station ${station.number || ''}`);
    if (station.platform !== undefined) addTarget(targets, 'station', station.id, 'platform', station.label || `Station ${station.number || ''}`);
    if (station.matchId !== undefined) addTarget(targets, 'station', station.id, 'match_id', station.label || `Station ${station.number || ''}`);
  }

  if (store.get().brackets[event.id]) addTarget(targets, 'bracket', event.id, 'record', title);
  for (const result of Object.values(store.get().results).filter((row) => row.eventId === event.id && !row.superseded)) {
    const winner = store.getPlayer(result.winnerPlayerId)?.tag || 'Winner';
    const loser = store.getPlayer(result.loserPlayerId)?.tag || 'Opponent';
    addTarget(targets, 'result', result.id, 'record', `${result.roundName || 'Match'} · ${winner} vs. ${loser}`);
  }
  return targets;
}

export function playerTargets(playerId) {
  const player = store.getPlayer(playerId);
  if (!player) return [];
  const targets = [];
  addTarget(targets, 'player', player.id, 'tag', player.tag || 'Player');
  for (const result of store.historyFor(player.id).slice(0, 25)) {
    const won = result.winnerPlayerId === player.id;
    const opponent = store.getPlayer(won ? result.loserPlayerId : result.winnerPlayerId)?.tag || 'Opponent';
    const event = store.getEvent(result.eventId);
    addTarget(targets, 'result', result.id, 'record', `${event?.name || 'Event'} · ${result.roundName || 'Match'} vs. ${opponent}`);
  }
  return targets;
}

export function reportButton(scope, id) {
  return html`<button class="btn btn-text btn-sm" data-act="report-content" data-report-scope="${scope}" data-report-id="${id}">Report content</button>`;
}

function orderedOptions(targets, keyOf, labelOf) {
  return [...new Map(targets.map((target) => [keyOf(target), target])).values()]
    .map((target) => ({ value: keyOf(target), label: labelOf(target) }));
}

function selectionBody(targets) {
  const kinds = [...new Set(targets.map((target) => target.kind))];
  const firstKind = kinds[0];
  const ids = orderedOptions(targets.filter((target) => target.kind === firstKind),
    (target) => target.id, (target) => target.label.replace(`${KINDS[firstKind]} · `, ''));
  const firstId = ids[0]?.value;
  const fields = orderedOptions(targets.filter((target) => target.kind === firstKind && target.id === firstId),
    (target) => target.field, (target) => fieldName(firstKind, target.field));

  return html`
    <div class="stack">
      <label class="field"><span class="field-label">Content type</span>
        <select id="report-kind" aria-label="Content type">
          ${list(kinds.map((kind) => html`<option value="${kind}">${KINDS[kind]}</option>`))}
        </select>
      </label>
      <label class="field"><span class="field-label">Content</span>
        <select id="report-id" aria-label="Content">
          ${list(ids.map((option) => html`<option value="${option.value}">${option.label}</option>`))}
        </select>
      </label>
      <label class="field"><span class="field-label">Field</span>
        <select id="report-field" aria-label="Field">
          ${list(fields.map((option) => html`<option value="${option.value}">${option.label}</option>`))}
        </select>
      </label>
      <label class="field"><span class="field-label">Reason</span>
        <textarea id="report-reason" rows="4" minlength="10" maxlength="1200" required
          aria-describedby="report-guidance report-note"></textarea>
      </label>
      <p id="report-guidance" class="field-help">Use 10 to 1200 characters. Reports are private and reviewed by the moderation team. Do not include contact details.</p>
      <p id="report-note" class="body-small" role="status" aria-live="polite"></p>
    </div>`;
}

function updateSelection(dlg, targets) {
  const kind = dlg.querySelector('#report-kind')?.value;
  const idSelect = dlg.querySelector('#report-id');
  const fieldSelect = dlg.querySelector('#report-field');
  const ids = orderedOptions(targets.filter((target) => target.kind === kind),
    (target) => target.id, (target) => target.label.replace(`${KINDS[kind]} · `, ''));
  idSelect.innerHTML = html`${list(ids.map((option) => html`<option value="${option.value}">${option.label}</option>`))}`;
  const id = idSelect.value;
  const fields = orderedOptions(targets.filter((target) => target.kind === kind && target.id === id),
    (target) => target.field, (target) => fieldName(kind, target.field));
  fieldSelect.innerHTML = html`${list(fields.map((option) => html`<option value="${option.value}">${option.label}</option>`))}`;
}

function accessMessage() {
  if (!auth.isRemote()) {
    return 'No server is connected. This copy is stored on this device, so it cannot send or save a report.';
  }
  const session = auth.currentSession();
  if (session?.temporary) return 'Reports require a saved account. Save this guest profile before sending a report.';
  if (!auth.isSignedIn()) return 'Sign in to a saved account before sending a report.';
  return null;
}

function reportContent(scope, id) {
  const unavailable = accessMessage();
  const targets = scope === 'event' ? eventTargets(id) : playerTargets(id);
  if (unavailable) {
    const needsSignIn = auth.isRemote() && !auth.isSignedIn();
    const needsUpgrade = auth.isRemote() && Boolean(auth.currentSession()?.temporary);
    dialog({
      title: 'Report content',
      body: html`<p class="body-medium">${unavailable}</p>`,
      actions: [
        { label: 'Close', kind: 'text' },
        ...(needsSignIn || needsUpgrade ? [{
          label: needsSignIn ? 'Sign in' : 'Save account', kind: 'filled', onClick: async (dlg) => {
            dlg.close();
            const authView = await import('./auth.js');
            if (needsUpgrade) authView.openGuestUpgrade(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
            else authView.openSignIn(() => window.dispatchEvent(new HashChangeEvent('hashchange')),
              'A saved account is required to send a content report.');
            return true;
          },
        }] : []),
      ],
    });
    return;
  }

  if (!targets.length) {
    dialog({
      title: 'Report content',
      body: html`<p class="body-medium">This content has no reportable server record. Device-only and demo content cannot be sent to moderation.</p>`,
      actions: [{ label: 'Close', kind: 'text' }],
    });
    return;
  }

  const dlg = dialog({
    title: 'Report content',
    body: selectionBody(targets),
    actions: [
      { label: 'Cancel', kind: 'text' },
      { label: 'Send report', kind: 'filled', onClick: async (el) => {
        const reason = el.querySelector('#report-reason').value.trim();
        const note = el.querySelector('#report-note');
        if (reason.length < 10 || reason.length > 1200) {
          note.textContent = 'Enter a reason between 10 and 1200 characters.';
          note.setAttribute('role', 'alert');
          return false;
        }
        const targetKind = el.querySelector('#report-kind').value;
        const targetIdValue = el.querySelector('#report-id').value;
        const targetField = el.querySelector('#report-field').value;
        try {
          const result = await auth.submitReport({ targetKind, targetId: targetIdValue, targetField, reason });
          snack(result.duplicate
            ? 'You already reported this content recently.'
            : 'Report sent to the moderation team.');
          return true;
        } catch (error) {
          note.textContent = error?.message || 'The report could not be sent. Try again when you are connected.';
          note.setAttribute('role', 'alert');
          return false;
        }
      } },
    ],
  });
  dlg.querySelector('#report-kind').addEventListener('change', () => updateSelection(dlg, targets));
  dlg.querySelector('#report-id').addEventListener('change', () => {
    const kind = dlg.querySelector('#report-kind').value;
    const idSelect = dlg.querySelector('#report-id');
    const fieldSelect = dlg.querySelector('#report-field');
    const fields = orderedOptions(targets.filter((target) => target.kind === kind && target.id === idSelect.value),
      (target) => target.field, (target) => fieldName(kind, target.field));
    fieldSelect.innerHTML = html`${list(fields.map((option) => html`<option value="${option.value}">${option.label}</option>`))}`;
  });
}

on('report-content', ({ reportScope, reportId }) => reportContent(reportScope, reportId));
