/* Brackets · the organiser console
   ===========================================================================
   Six tabs, all of them usable on a phone. That last part is the whole point:
   the reason a TO ends up chained to a laptop at the desk is that the
   organiser tools on every existing site are desktop-shaped, so the person
   who most needs to be walking around the room is the one who cannot leave it.

     Overview  what to do next, and the event's state
     Entrants  the roster — bulk edit, import, export, check-in, payment
     Seeding   the seeding lab, with a preview of who meets whom
     Run       stations, the queue, the bracket, reporting
     Rules     the rules sheet as players see it
     Settings  everything else

   Nothing here writes to the network directly. Every change goes through the
   store, lands locally, and syncs later — so all of this works with the wifi
   off, which at a venue is not a hypothetical.
   =========================================================================== */

'use strict';

import {
  html, raw, list, icon, esc, on, snack, dialog, confirmDialog,
  avatar, formatDateTime, relativeTime, countdown, initials, elapsed,
} from '../lib/ui.js';
import * as store from '../lib/store.js';
import * as auth from '../lib/auth.js';
import { gameById, resolveRuleset, allFields, fieldVisible, formatValue, setLength } from '../data/games.js';
import {
  singleElimination, doubleElimination, reportResult, clearResult,
  readyMatches, separate, projectedMeetings, standings, bracketSize, snakeSeed,
} from '../lib/bracket.js';
import { suggestionsFor, guidanceSummary, formatMoney, normaliseTag } from '../lib/guidance.js';
import * as csv from '../lib/csv.js';

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'sparkle' },
  { id: 'entrants', label: 'Entrants', icon: 'group' },
  { id: 'seeding', label: 'Seeding', icon: 'sort' },
  { id: 'run', label: 'Run', icon: 'play' },
  { id: 'rules', label: 'Rules', icon: 'gavel' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/* View-local state. Not in the store: a row selection and a dismissed
   suggestion are properties of this person looking at this screen right now,
   not of the tournament. */
const ui = {
  selected: new Set(),
  dismissed: new Set(),
  search: '',
  /* Sort and filter are view state, not tournament state: two staff looking at
     the same roster want their own sort, and neither wants the other's to
     arrive over the network mid-scroll. */
  sortBy: 'seed',
  sortDir: 'asc',
  filters: new Set(),
  importPlan: null,
};

/* --------------------------------------------------------------------------
   Sorting and filtering the roster
   --------------------------------------------------------------------------
   Every column sorts, because which one matters depends entirely on what the
   TO is doing at that moment: seed while seeding, tag while looking somebody
   up at the desk, team while checking a crew all arrived, paid while counting
   the cash box.

   Each column declares how to extract its value rather than being special-
   cased in a comparator, so adding a column is one entry here and one <th>.
   -------------------------------------------------------------------------- */
const COLUMNS = [
  { key: 'seed', label: 'Seed', get: (r) => r.entry.seed ?? Infinity, numeric: true },
  { key: 'tag', label: 'Tag', get: (r) => (r.player?.tag || '').toLowerCase() },
  { key: 'group', label: 'Team / venue', get: (r) => (r.entry.group || '~').toLowerCase() },
  { key: 'checkedIn', label: 'In', get: (r) => (r.entry.checkedInAt ? 0 : 1), numeric: true },
  { key: 'paid', label: 'Paid', get: (r) => (r.entry.paidAt ? 0 : 1), numeric: true, needsFee: true },
  { key: 'signed', label: 'Signed', get: (r, event) => missingDocs(r.entry, event).length, numeric: true },
  { key: 'contact', label: 'Contact', get: (r) => (r.player?.connections?.discord || r.player?.email || '~').toLowerCase() },
];

const missingDocs = (entry, event) => {
  const required = (event.documents || []).filter((d) => d.required);
  const signed = new Set(entry.signedDocuments || []);
  return required.filter((d) => !signed.has(d.id));
};

/* Filters are named predicates rather than a query language. A TO wants the
   four or five questions they actually ask -- "who is not here", "who owes me
   money" -- as one tap, not an expression builder. */
const FILTERS = [
  { key: 'not-in', label: 'Not checked in', test: (r) => !r.entry.checkedInAt },
  { key: 'in', label: 'Checked in', test: (r) => Boolean(r.entry.checkedInAt) },
  { key: 'unpaid', label: 'Owes', needsFee: true, test: (r) => !r.entry.paidAt },
  { key: 'unsigned', label: 'Not signed', test: (r, event) => missingDocs(r.entry, event).length > 0 },
  { key: 'waitlist', label: 'Waitlist', test: (r) => Boolean(r.entry.waitlisted) },
  { key: 'walkup', label: 'Walk-ups', test: (r) => Boolean(r.player?.claimable) },
  { key: 'unseeded', label: 'No seed', test: (r) => r.entry.seed == null },
];

function applyView(rows, event) {
  const search = ui.search.trim().toLowerCase();
  let out = rows.filter(({ player, entry }) => !search
    || (player?.tag || '').toLowerCase().includes(search)
    || (player?.realName || '').toLowerCase().includes(search)
    || (entry.group || '').toLowerCase().includes(search));

  /* Multiple filters are AND, which is what "checked in" + "owes" has to mean
     to be useful at the door. */
  for (const key of ui.filters) {
    const filter = FILTERS.find((f) => f.key === key);
    if (filter) out = out.filter((r) => filter.test(r, event));
  }

  const column = COLUMNS.find((c) => c.key === ui.sortBy) || COLUMNS[0];
  const dir = ui.sortDir === 'desc' ? -1 : 1;
  return [...out].sort((a, b) => {
    const av = column.get(a, event);
    const bv = column.get(b, event);
    if (av === bv) {
      /* Stable secondary key so equal values do not shuffle between renders,
         which is disorienting in a table somebody is reading down. */
      return (a.entry.seed ?? Infinity) - (b.entry.seed ?? Infinity);
    }
    return (column.numeric ? av - bv : String(av).localeCompare(String(bv))) * dir;
  });
}

const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

/* --------------------------------------------------------------------------
   Context assembly
   -------------------------------------------------------------------------- */

function contextFor(eventId) {
  const event = store.getEvent(eventId);
  if (!event) return null;

  const game = gameById(event.gameId);
  const ruleset = game ? resolveRuleset(game, event.presetId, event.overrides || {}) : null;
  const entries = store.entriesFor(eventId);
  const players = new Map(entries.map((e) => [e.playerId, store.getPlayer(e.playerId)]));
  const bracket = store.get().brackets[eventId] || null;
  const stations = store.stationsFor(eventId);

  return {
    event, game, ruleset, entries, players, bracket, stations,
    rows: entries.map((entry) => ({ entry, player: players.get(entry.playerId) })),
  };
}

/* Tab id -> renderer. A lookup rather than a switch so an unknown tab in the
   URL falls back to the overview instead of rendering nothing -- a stale link
   from Discord should land somewhere useful. */
const TAB_VIEWS = {
  overview: (data, suggestions, ctx) => overviewTab(data, suggestions, ctx),
  entrants: (data) => entrantsTab(data),
  seeding: (data) => seedingTab(data),
  run: (data) => runTab(data),
  rules: (data) => rulesTab(data),
  settings: (data) => settingsTab(data),
};

export function view(ctx) {
  const eventId = ctx.params.eventId;
  const tab = ctx.params.tab || 'overview';
  const data = contextFor(eventId);

  if (!data) {
    return {
      title: 'Not found', back: '/',
      body: html`<div class="pane"><div class="empty">${raw(icon('alert'))}
        <p>No event with that id on this device.</p>
        <a class="btn btn-tonal" href="#/">Back to events</a></div></div>`,
    };
  }

  const suggestions = suggestionsFor({
    event: data.event,
    entries: data.entries,
    players: data.players,
    bracket: data.bracket,
    matchState: data.bracket?.matches || [],
    stations: data.stations,
    ruleset: data.ruleset,
    session: ctx.session,
    seedingReport: data.event.seedingReport,
  }, ui.dismissed);

  const summary = guidanceSummary(suggestions);

  const body = html`
    <!-- Navigation, not a tab widget. These change the URL and each one is a
         real, linkable page -- so they are anchors in a <nav> with
         aria-current, not role="tab". The ARIA tab pattern promises a
         tabpanel, arrow-key roving focus and no page change; promising that
         and not delivering it is worse for a screen-reader user than plain
         links, which they already know how to use. -->
    <nav class="tabs" aria-label="Organiser sections">
      ${list(TABS.map((t) => html`
        <a class="tab" href="#/e/${eventId}/admin/${t.id}"
           ${raw(t.id === tab ? 'aria-current="page"' : '')}>
          ${raw(icon(t.icon, 'icon-sm'))}${t.label}
          ${t.id === 'overview' && summary.level !== 'ok'
            ? html`<span class="chip chip-static ${raw(summary.level === 'urgent' ? 'chip-error' : 'chip-warn')}"
                        style="min-height:20px;padding:0 6px;font:var(--label-small)">
                     ${suggestions.length}<span class="sr-only"> item${suggestions.length === 1 ? '' : 's'} need attention</span>
                   </span>`
            : ''}
        </a>`))}
    </nav>
    ${raw((TAB_VIEWS[tab] || TAB_VIEWS.overview)(data, suggestions, ctx))}`;

  return {
    title: data.event.name,
    subtitle: `${data.game?.short || ''} · ${data.entries.length} entrants`,
    back: `/e/${eventId}`,
    gameId: data.event.gameId,
    body,
  };
}

/* --------------------------------------------------------------------------
   Overview
   -------------------------------------------------------------------------- */

const FLOW = ['registration', 'checkin', 'seeding', 'running', 'complete'];
const FLOW_LABEL = {
  draft: 'Draft', registration: 'Registration', checkin: 'Check-in',
  seeding: 'Seeding', running: 'Running', complete: 'Finished',
};

function overviewTab(data, suggestions, ctx) {
  const { event, entries, bracket } = data;
  const checkedIn = entries.filter((e) => e.checkedInAt).length;
  const paid = entries.filter((e) => e.paidAt).length;
  const played = (bracket?.matches || []).filter((m) => m.state).length;
  const total = (bracket?.matches || []).filter((m) => !m.cancelled).length;
  const at = FLOW.indexOf(event.status);

  return html`
    <div class="pane">
      <section class="card card-outlined" style="margin-bottom:16px">
        <div class="row" style="margin-bottom:12px">
          <b class="title-medium spacer">${FLOW_LABEL[event.status]}</b>
          <span class="code">${event.inviteCode}</span>
          <button class="btn btn-icon" data-act="copy-text" data-text="https://battydev.com/brackets/?join=${event.inviteCode}" aria-label="Copy join link">${raw(icon('copy'))}</button>
        </div>
        <div class="row" style="gap:4px;margin-bottom:12px">
          ${list(FLOW.map((s, i) => html`
            <div class="progress spacer" title="${FLOW_LABEL[s]}">
              <i style="width:${i <= at ? 100 : 0}%"></i>
            </div>`))}
        </div>
        <div class="row" style="gap:8px">
          ${at > 0 ? html`<button class="btn btn-text btn-sm" data-act="event-status" data-status="${FLOW[at - 1]}">${raw(icon('back', 'icon-sm'))} Back to ${FLOW_LABEL[FLOW[at - 1]]}</button>` : ''}
          <span class="spacer"></span>
          ${at < FLOW.length - 1 ? html`<button class="btn btn-filled btn-sm" data-act="event-status" data-status="${FLOW[at + 1]}">Move to ${FLOW_LABEL[FLOW[at + 1]]} ${raw(icon('chevron', 'icon-sm'))}</button>` : ''}
        </div>
      </section>

      <section style="margin-bottom:20px">
        <div class="row" style="gap:8px;margin-bottom:12px">
          <h2 class="title-large spacer">Next steps</h2>
          ${store.canUndo() ? html`<button class="btn btn-text btn-sm" data-act="undo">${raw(icon('undo', 'icon-sm'))} Undo ${store.undoLabel()}</button>` : ''}
        </div>
        ${suggestions.length ? html`
          <div class="guide-list">
            ${list(suggestions.map((s) => html`
              <div class="guide ${raw(s.level)}">
                ${raw(icon(s.level === 'urgent' ? 'alert' : s.level === 'attention' ? 'bell' : 'info'))}
                <div class="guide-body">
                  <div class="guide-title">${s.title}</div>
                  <div class="guide-why">${s.why}</div>
                  <div class="guide-actions">
                    ${list(s.actions.map((a) => html`
                      <button class="btn btn-sm ${raw(a.kind === 'filled' ? 'btn-filled' : a.kind === 'danger' ? 'btn-danger' : a.kind === 'tonal' ? 'btn-tonal' : 'btn-text')}"
                              data-act="guide-action" data-suggestion="${s.id}" data-action-id="${a.id}"
                              data-payload="${JSON.stringify(a.payload || {})}">${a.label}</button>`))}
                  </div>
                </div>
              </div>`))}
          </div>`
        : html`<div class="card card-filled"><div class="row-tight">${raw(icon('check'))}
            <span class="body-medium">Nothing needs you right now.</span></div></div>`}
      </section>

      <section>
        <h2 class="title-large" style="margin-bottom:12px">Where things stand</h2>
        <div class="grid-cards">
          ${raw(statCard('Entrants', entries.length, event.capacity ? `of ${event.capacity} cap` : 'no cap', 'group'))}
          ${raw(statCard('Checked in', checkedIn, `${entries.length - checkedIn} still out`, 'check'))}
          ${event.entryFee ? raw(statCard('Collected', formatMoney(paid * event.entryFee, event.currency), `${entries.length - paid} unpaid`, 'money')) : ''}
          ${bracket ? raw(statCard('Sets played', `${played}/${total}`, total - played ? `${total - played} to go` : 'all done', 'bracket')) : ''}
        </div>
      </section>
    </div>`;
}

function statCard(label, value, sub, ic) {
  return html`
    <div class="card card-filled">
      <div class="row-tight dim" style="margin-bottom:4px">${raw(icon(ic, 'icon-sm'))}<span class="label-large">${label}</span></div>
      <div class="headline-medium">${value}</div>
      <div class="body-small dim">${sub}</div>
    </div>`;
}

/* --------------------------------------------------------------------------
   Entrants
   --------------------------------------------------------------------------
   A table with checkboxes and a bulk bar. Deliberately mundane -- this is the
   screen that exists on every other site as an add-only list with a pencil
   icon per row, and the fix is not cleverness, it is having the operations at
   all: select many, change one thing about all of them, undo it.
   -------------------------------------------------------------------------- */

function entrantsTab(data) {
  const { event, rows } = data;
  const visible = applyView(rows, event);
  const selected = visible.filter((r) => ui.selected.has(r.entry.id));
  const filters = FILTERS.filter((f) => !f.needsFee || event.entryFee);
  const columns = COLUMNS.filter((c) => !c.needsFee || event.entryFee);
  const narrowed = ui.filters.size || ui.search.trim();

  return html`
    <div class="pane">
      <div class="row" style="margin-bottom:12px;gap:8px">
        <label class="field spacer" style="min-width:180px;max-width:340px">
          <input type="search" placeholder="Search entrants" value="${ui.search}"
                 data-act-input="entrant-search" data-focus-key="entrant-search"
                 style="min-height:44px;padding:10px 12px" aria-label="Search entrants">
        </label>
        <button class="btn btn-tonal btn-sm" data-act="import-open">${raw(icon('upload', 'icon-sm'))} Import</button>
        <button class="btn btn-outlined btn-sm" data-act="export-entrants">${raw(icon('download', 'icon-sm'))} Export</button>
        <button class="btn btn-filled btn-sm" data-act="entrant-add">${raw(icon('plus', 'icon-sm'))} Add</button>
      </div>

      <div class="row" style="margin-bottom:12px;gap:6px" role="group" aria-label="Filter entrants">
        ${list(filters.map((f) => {
          const on = ui.filters.has(f.key);
          const count = rows.filter((r) => f.test(r, event)).length;
          return html`
            <button class="chip" data-act="entrant-filter" data-filter="${f.key}"
                    aria-pressed="${on}">
              ${on ? raw(icon('check', 'icon-sm')) : ''}${f.label}
              <span class="dim" style="font-variant-numeric:tabular-nums">${count}</span>
            </button>`;
        }))}
        ${narrowed ? html`
          <button class="btn btn-text btn-sm" data-act="entrant-filter-clear">
            ${raw(icon('close', 'icon-sm'))} Clear
          </button>` : ''}
      </div>

      ${narrowed ? html`
        <p class="body-small dim" style="margin:-4px 0 12px" role="status">
          Showing ${visible.length} of ${rows.length}.
          ${selected.length ? html`Bulk actions apply to the ${selected.length} selected, not the whole roster.` : ''}
        </p>` : ''}

      ${selected.length ? html`
        <div class="bulk-bar" style="margin-bottom:12px">
          <b class="title-small">${selected.length} selected</b>
          <span class="spacer"></span>
          <button class="btn btn-text btn-sm" data-act="bulk" data-op="checkin">Check in</button>
          <button class="btn btn-text btn-sm" data-act="bulk" data-op="uncheckin">Un-check in</button>
          ${event.entryFee ? html`<button class="btn btn-text btn-sm" data-act="bulk" data-op="paid">Mark paid</button>` : ''}
          <button class="btn btn-text btn-sm" data-act="bulk" data-op="group">Set team</button>
          <button class="btn btn-text btn-sm" data-act="bulk" data-op="seed-sequential">Re-seed 1..n</button>
          <button class="btn btn-danger-text btn-sm" data-act="bulk" data-op="remove">Remove</button>
        </div>` : ''}

      ${rows.length ? html`
        <div class="table-wrap" data-keep-scroll="entrants">
          <table class="data">
            <caption class="sr-only">
              Entrants — ${visible.length} shown. Seed, tag and team are editable in place.
            </caption>
            <thead>
              <tr>
                <th class="check" scope="col">
                  <input type="checkbox" id="select-all" data-act-change="select-all"
                         ${raw(selected.length === visible.length && visible.length ? 'checked' : '')}>
                  <label class="sr-only" for="select-all">Select all entrants</label>
                </th>
                <!-- aria-sort on the header, not just an arrow glyph: it is
                     what tells a screen-reader user which column the table is
                     ordered by and in which direction. -->
                ${list(columns.map((c) => html`
                  <th scope="col" aria-sort="${raw(ui.sortBy === c.key
                    ? (ui.sortDir === 'asc' ? 'ascending' : 'descending') : 'none')}">
                    <button class="th-sort" data-act="entrant-sort" data-col="${c.key}">
                      ${c.label}
                      <span class="th-arrow" aria-hidden="true">${raw(ui.sortBy === c.key
                        ? icon(ui.sortDir === 'asc' ? 'chevronDown' : 'chevronDown',
                          ui.sortDir === 'asc' ? 'icon-sm flip' : 'icon-sm')
                        : icon('sort', 'icon-sm'))}</span>
                      <span class="sr-only">${ui.sortBy === c.key
                        ? `sorted ${ui.sortDir === 'asc' ? 'ascending' : 'descending'}, activate to reverse`
                        : 'activate to sort by this column'}</span>
                    </button>
                  </th>`))}
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              ${list(visible.map(({ entry, player }) => {
                const required = (event.documents || []).filter((d) => d.required);
                const signed = new Set(entry.signedDocuments || []);
                const missing = required.filter((d) => !signed.has(d.id));
                return html`
                <tr class="${raw(ui.selected.has(entry.id) ? 'selected' : '')}">
                  <td class="check">
                    <input type="checkbox" id="sel-${entry.id}" data-act-change="select-row" data-id="${entry.id}"
                           ${raw(ui.selected.has(entry.id) ? 'checked' : '')}>
                    <label class="sr-only" for="sel-${entry.id}">Select ${player?.tag || 'entrant'}</label>
                  </td>
                  <td class="num" style="width:64px">
                    <input type="number" value="${entry.seed ?? ''}" data-act-change="entry-seed" data-id="${entry.id}"
                           data-focus-key="seed-${entry.id}" aria-label="Seed for ${player?.tag}">
                  </td>
                  <td>
                    <div class="row-tight" style="flex-wrap:nowrap">
                      ${raw(avatar(player, 'avatar-sm'))}
                      <input type="text" value="${player?.tag || ''}" data-act-change="player-tag" data-id="${entry.playerId}"
                             data-focus-key="tag-${entry.id}" style="min-width:120px"
                             aria-label="Tag for ${player?.tag || 'entrant'}">
                      ${player?.claimable ? html`<span class="chip chip-static chip-warn" style="min-height:20px;padding:0 6px;font:var(--label-small)" title="Added by an organiser — not claimed by an account yet">walk-up</span>` : ''}
                      ${entry.waitlisted ? html`<span class="chip chip-static chip-assist" style="min-height:20px;padding:0 6px;font:var(--label-small)">waitlist</span>` : ''}
                    </div>
                  </td>
                  <td><input type="text" value="${entry.group || ''}" data-act-change="entry-group" data-id="${entry.id}"
                             data-focus-key="group-${entry.id}" style="min-width:100px"
                             aria-label="Team or venue for ${player?.tag || 'entrant'}"></td>
                  <td><button class="chip ${raw(entry.checkedInAt ? 'chip-ok' : '')}" data-act="toggle-checkin" data-id="${entry.id}"
                      style="min-height:26px;padding:0 10px" aria-pressed="${Boolean(entry.checkedInAt)}"
                      aria-label="${player?.tag || 'Entrant'} is ${entry.checkedInAt ? 'checked in' : 'not checked in'} — activate to change"
                      >${entry.checkedInAt ? 'In' : 'Out'}</button></td>
                  ${event.entryFee ? html`
                    <td><button class="chip ${raw(entry.paidAt ? 'chip-ok' : 'chip-warn')}" data-act="toggle-paid" data-id="${entry.id}"
                        style="min-height:26px;padding:0 10px" aria-pressed="${Boolean(entry.paidAt)}"
                        aria-label="${player?.tag || 'Entrant'} has ${entry.paidAt ? 'paid' : 'not paid'} — activate to change"
                        >${entry.paidAt ? 'Paid' : 'Owes'}</button></td>` : ''}
                  <td>${missing.length
                    ? html`<span class="chip chip-static chip-error" style="min-height:22px;padding:0 8px;font:var(--label-small)" title="${missing.map((d) => d.title).join(', ')}">${missing.length} missing</span>`
                    : html`<span class="chip chip-static chip-ok" style="min-height:22px;padding:0 8px;font:var(--label-small)">ok</span>`}</td>
                  <td class="dim body-small">${player?.connections?.discord || player?.email || '—'}</td>
                  <td><button class="btn btn-icon" data-act="entrant-menu" data-id="${entry.id}" aria-label="More for ${player?.tag}">${raw(icon('chevronDown'))}</button></td>
                </tr>`;
              }))}
            </tbody>
          </table>
        </div>`
      : narrowed ? html`
        <div class="empty">
          ${raw(icon('search'))}
          <p class="body-large">No entrants match.</p>
          <p class="body-medium">${rows.length} on the roster, none of them fitting these filters.</p>
          <button class="btn btn-tonal" data-act="entrant-filter-clear">Clear filters</button>
        </div>`
      : html`
        <div class="empty">
          ${raw(icon('group'))}
          <p class="body-large">Nobody yet.</p>
          <p class="body-medium">Share the code <b>${event.inviteCode}</b>, or paste your sign-up sheet.</p>
          <div class="row" style="justify-content:center">
            <button class="btn btn-filled" data-act="import-open">${raw(icon('upload'))} Paste a spreadsheet</button>
            <button class="btn btn-outlined" data-act="entrant-add">${raw(icon('plus'))} Add one</button>
          </div>
        </div>`}
    </div>`;
}

/* --------------------------------------------------------------------------
   Seeding
   -------------------------------------------------------------------------- */

function seedingTab(data) {
  const { event, entries, players, bracket } = data;
  const pool = entries.filter((e) => !e.waitlisted && (event.status === 'registration' || e.checkedInAt || !anyCheckedIn(entries)));
  const seeded = [...pool].sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999));

  const withNames = seeded.map((entry) => ({
    id: entry.id, entryId: entry.id, playerId: entry.playerId,
    name: players.get(entry.playerId)?.tag || '—',
    group: entry.group || players.get(entry.playerId)?.homeVenue || null,
    seed: entry.seed,
  }));

  /* `separate()` here is a PROPOSAL, not the order in effect. It is run so the
     lab can offer its swaps and report the collisions that would remain --
     applying it is a separate, explicit action.

     Everything the lab DISPLAYS is the stored order. That distinction was got
     wrong at first, and the bug it caused is instructive: the list showed the
     post-separation preview while the move buttons edited the stored order, so
     nudging somebody up re-ran separation over the new order and the row
     appeared not to move at all. A view that previews one thing while editing
     another is unusable no matter how good either half is. */
  const report = withNames.length >= 2 ? separate(withNames, { tolerance: 2 }) : null;
  const projection = withNames.length >= 2 ? projectedMeetings(withNames) : [];

  return html`
    <div class="pane">
      ${bracket ? html`
        <div class="banner banner-warn" style="margin-bottom:16px">${raw(icon('alert'))}
          <div><b>The bracket is already generated.</b>
          <div class="body-small">Re-seeding now regenerates it and discards any reported sets. Everyone who has looked at their first-round opponent will see it change.</div></div>
        </div>` : ''}

      <div class="row" style="margin-bottom:16px;gap:8px">
        <button class="btn btn-tonal btn-sm" data-act="autoseed" data-mode="history">${raw(icon('sort', 'icon-sm'))} Seed from results here</button>
        <button class="btn btn-tonal btn-sm" data-act="autoseed" data-mode="random">${raw(icon('shuffle', 'icon-sm'))} Randomise</button>
        ${report?.moves.length ? html`<button class="btn btn-filled btn-sm" data-act="apply-separation">${raw(icon('check', 'icon-sm'))} Apply ${report.moves.length} separation swap${report.moves.length === 1 ? '' : 's'}</button>` : ''}
      </div>

      ${report?.moves.length ? html`
        <section class="card card-outlined" style="margin-bottom:16px">
          <b class="title-medium">Separation would make ${report.moves.length} swap${report.moves.length === 1 ? '' : 's'}</b>
          <p class="body-small dim" style="margin:4px 0 12px">
            Nobody moves more than two seed positions, so this does not change who anyone is expected to play — it only stops teammates meeting in the first round or two.
          </p>
          <div class="stack-sm">
            ${list(report.moves.map((m) => html`
              <div class="body-small">
                ${raw(icon('shuffle', 'icon-sm'))}
                Swap <b>${m.a.name}</b> (seed ${m.fromSeed}) with <b>${m.b.name}</b> (seed ${m.toSeed})${m.group ? html` — both ${m.group}` : ''}
              </div>`))}
          </div>
        </section>` : ''}

      ${report?.collisions.length ? html`
        <div class="banner ${raw(report.collisions.some((c) => c.round === 1) ? 'banner-warn' : '')}" style="margin-bottom:16px">
          ${raw(icon('info'))}
          <div>
            <b>${report.collisions.length} early meeting${report.collisions.length === 1 ? '' : 's'} between the same team or venue</b>
            <div class="body-small" style="margin-top:4px">
              ${list(report.collisions.slice(0, 5).map((c) => html`
                <div>${c.a.name} v ${c.b.name} — round ${c.round}, both ${c.group}</div>`))}
              ${report.collisions.length > 5 ? html`<div>…and ${report.collisions.length - 5} more</div>` : ''}
            </div>
            <div class="body-small" style="margin-top:6px;opacity:.85">
              These are what is left after separation. With this many entrants from one venue, some of them have to play each other early — the alternative is moving people so far that the seeding stops meaning anything.
            </div>
          </div>
        </div>` : ''}

      <div class="row" style="align-items:flex-start;gap:24px">
        <section class="spacer" style="min-width:280px">
          <h2 class="title-large" style="margin-bottom:8px">Seed order</h2>
          <p class="body-small dim" style="margin-bottom:12px">
            Move anyone up or down, or type a seed directly in the entrants tab.
          </p>
          <!-- Explicit move buttons rather than drag-and-drop.
               Three reasons, in order of how much they matter. It WORKS: the
               previous version set draggable="true" and advertised "drag to
               reorder" against a handler that did nothing at all. It is
               reachable from a keyboard, which a drag gesture is not. And it
               does not depend on a sustained pointer path, so it is usable
               one-handed on a phone at a venue -- which is where seeding
               actually gets adjusted. -->
          <ol class="stack-sm" style="list-style:none;margin:0;padding:0">
            ${list(withNames.map((entrant, i, arr) => {
              /* Highlighted because separation PROPOSES moving them, not because
                 anything has moved yet. */
              const proposed = report?.moves.some((m) => m.a.id === entrant.id || m.b.id === entrant.id);
              return html`
                <li class="seed-row ${raw(proposed ? 'moved' : '')}">
                  <span class="rank" aria-hidden="true">${i + 1}</span>
                  <span class="spacer">
                    <b class="body-medium">${entrant.name}</b>
                    ${entrant.group ? html`<div class="body-small dim">${entrant.group}</div>` : ''}
                  </span>
                  ${proposed ? html`<span class="chip chip-static" style="min-height:22px;padding:0 8px;font:var(--label-small)"
                        title="Separation would move this entrant">would move</span>` : ''}
                  <span class="seed-move">
                    <button class="btn btn-icon" data-act="seed-move" data-id="${entrant.entryId}" data-dir="-1"
                            ${raw(i === 0 ? 'disabled' : '')}
                            aria-label="Move ${entrant.name} up to seed ${i}">${raw(icon('chevronDown', 'icon-sm flip'))}</button>
                    <button class="btn btn-icon" data-act="seed-move" data-id="${entrant.entryId}" data-dir="1"
                            ${raw(i === arr.length - 1 ? 'disabled' : '')}
                            aria-label="Move ${entrant.name} down to seed ${i + 2}">${raw(icon('chevronDown', 'icon-sm'))}</button>
                  </span>
                </li>`;
            }))}
          </ol>
        </section>

        <section class="spacer" style="min-width:280px">
          <h2 class="title-large" style="margin-bottom:8px">If nobody upsets</h2>
          <p class="body-small dim" style="margin-bottom:12px">
            Built from the seed order on the left, so this is what you get if you generate now.
            The single most useful check before committing: does it match what you know about the room?
          </p>
          ${list(projection.map((round) => html`
            <div class="card card-outlined" style="margin-bottom:8px">
              <b class="label-large dim">${round.name}</b>
              <div class="stack-sm" style="margin-top:8px">
                ${list(round.pairs.slice(0, 8).map((p) => html`
                  <div class="body-medium">
                    ${p.bye
                      ? html`<span class="dim">${(p.a || p.b)?.name} — bye</span>`
                      : html`${p.a?.name} <span class="dim">v</span> ${p.b?.name}`}
                  </div>`))}
                ${round.pairs.length > 8 ? html`<div class="body-small dim">…and ${round.pairs.length - 8} more</div>` : ''}
              </div>
            </div>`))}
        </section>
      </div>

      <div class="row" style="margin-top:24px">
        <button class="btn btn-filled btn-lg" data-act="generate-bracket">
          ${raw(icon('bracket'))} ${bracket ? 'Regenerate the bracket' : 'Generate the bracket'}
        </button>
      </div>
    </div>`;
}

const anyCheckedIn = (entries) => entries.some((e) => e.checkedInAt);

/* --------------------------------------------------------------------------
   Run
   -------------------------------------------------------------------------- */

function runTab(data) {
  const { event, bracket, stations, players, entries } = data;

  if (!bracket) {
    return html`<div class="pane"><div class="empty">${raw(icon('bracket'))}
      <p class="body-large">No bracket yet.</p>
      <p class="body-medium">Seed the entrants, then generate it.</p>
      <a class="btn btn-filled" href="#/e/${event.id}/admin/seeding">Go to seeding</a></div></div>`;
  }

  const byEntry = new Map(entries.map((e) => [e.id, e]));
  const nameOf = (entrantId) => {
    const entry = byEntry.get(entrantId);
    return players.get(entry?.playerId)?.tag || '—';
  };

  const called = new Set(bracket.matches.filter((m) => m.calledAt && !m.state).map((m) => m.id));
  const queue = readyMatches(bracket.matches).filter((m) => !called.has(m.id));
  const live = bracket.matches.filter((m) => m.calledAt && !m.state);
  const dq = Number(data.ruleset?.values?.dqTimer || 5);

  const rounds = groupRounds(bracket);

  return html`
    <div class="pane">
      <div class="row" style="margin-bottom:16px;gap:8px">
        <a class="btn btn-tonal btn-sm" href="#/e/${event.id}/tv" target="_blank" rel="noopener">
          ${raw(icon('station', 'icon-sm'))} Open the venue display
        </a>
        <span class="body-small dim">Opens in a new tab — put it on the TV.</span>
      </div>

      <section style="margin-bottom:20px">
        <h2 class="title-large" style="margin-bottom:12px">Stations</h2>
        <div class="stations">
          ${list(stations.map((station) => {
            const match = live.find((m) => m.id === station.matchId);
            const over = match ? Date.now() - new Date(match.calledAt).getTime() > dq * 60000 : false;
            return html`
              <div class="station ${raw(match ? 'busy' : 'open')}">
                <div class="station-head">
                  ${raw(icon('station', 'icon-sm'))}
                  <span class="spacer">${station.label}</span>
                  ${station.stream ? html`<span class="chip chip-static chip-info" style="min-height:20px;padding:0 6px;font:var(--label-small)">stream</span>` : ''}
                </div>
                ${match ? html`
                  <div class="body-medium"><b>${nameOf(match.slots[0].entrantId)}</b> v <b>${nameOf(match.slots[1].entrantId)}</b></div>
                  <div class="body-small dim">${match.name}</div>
                  <div class="row" style="margin-top:8px;gap:6px" data-live-scope>
                    <span class="timer ${raw(over ? 'over' : '')}">${raw(icon('clock', 'icon-sm'))}
                      <span data-live-since="${match.calledAt}" data-live-over="${dq}">${elapsed(match.calledAt)}</span>
                    </span>
                    <span class="spacer"></span>
                    <button class="btn btn-filled btn-sm" data-act="report-open" data-match="${match.id}">Report</button>
                  </div>
                  ${over ? html`<div class="body-small" style="color:var(--md-error);margin-top:6px">DQ window (${dq} min) has passed</div>` : ''}`
                : html`
                  <div class="body-small dim">Free</div>
                  ${queue.length ? html`
                    <button class="btn btn-tonal btn-sm btn-block" style="margin-top:8px"
                            data-act="call-next" data-station="${station.id}">Call the next set</button>` : ''}`}
              </div>`;
          }))}
          <button class="station" data-act="station-add" style="border:1px dashed var(--md-outline);background:none;cursor:pointer;color:var(--md-on-surface-variant)">
            ${raw(icon('plus'))} Add a station
          </button>
        </div>
      </section>

      <section style="margin-bottom:20px">
        <div class="row" style="margin-bottom:12px">
          <h2 class="title-large spacer">Queue</h2>
          <span class="body-small dim">${queue.length} ready</span>
        </div>
        ${queue.length ? html`
          <div class="stack-sm">
            ${list(queue.slice(0, 10).map((match) => html`
              <div class="card card-outlined row" style="flex-wrap:nowrap;gap:12px">
                <div class="spacer" style="min-width:0">
                  <div class="body-medium"><b>${nameOf(match.slots[0].entrantId)}</b> <span class="dim">v</span> <b>${nameOf(match.slots[1].entrantId)}</b></div>
                  <div class="body-small dim">${match.name}</div>
                </div>
                <button class="btn btn-tonal btn-sm" data-act="report-open" data-match="${match.id}">Report</button>
              </div>`))}
          </div>`
        : html`<div class="card card-filled body-medium dim">Nothing is waiting — every playable set is out.</div>`}
      </section>

      <section>
        <div class="row" style="margin-bottom:8px">
          <h2 class="title-large spacer">Bracket</h2>
          <span class="body-small dim">Tap a set to report it</span>
        </div>
        <!-- tabindex + role so the pane can be scrolled with the arrow keys.
             A scroll container that only responds to a mouse wheel or a swipe
             is unreachable for anyone driving the page from a keyboard, and a
             bracket is the widest thing on the site. -->
        <div class="bracket-scroll" data-keep-scroll="bracket"
             tabindex="0" role="region" aria-label="Bracket — scroll sideways for later rounds">
          <div class="bracket">
            ${list(rounds.map((round) => html`
              <div class="bracket-round" role="group" aria-label="${round.name}">
                <h3>${round.name}</h3>
                <div class="round-body">
                  ${list(round.matches.map((match) => matchCard(match, nameOf, called)))}
                </div>
              </div>`))}
          </div>
        </div>
      </section>
    </div>`;
}

/* Group the flat match list back into columns for display. Winners rounds,
   then losers rounds, then grand finals -- read left to right. */
function groupRounds(bracket) {
  const out = [];
  const brackets = bracket.type === 'double' ? ['W', 'L', 'GF'] : ['W'];
  for (const side of brackets) {
    const rounds = [...new Set(bracket.matches.filter((m) => m.bracket === side).map((m) => m.round))].sort((a, b) => a - b);
    for (const round of rounds) {
      const matches = bracket.matches.filter((m) => m.bracket === side && m.round === round && !m.cancelled);
      if (matches.length) out.push({ name: matches[0].name, matches });
    }
  }
  return out;
}

function matchCard(match, nameOf, called) {
  const [a, b] = match.slots;
  const done = match.state === 'complete';
  const bye = match.state === 'bye';
  const live = called.has(match.id);
  const ready = a.entrantId && b.entrantId && !match.state;

  const side = (slot, other) => {
    if (!slot.entrantId) {
      return html`<span class="match-side tbd"><span class="seed"></span><span class="who">${slot.kind === 'from' ? 'waiting' : 'bye'}</span></span>`;
    }
    const won = done && match.winnerId === slot.entrantId;
    const lost = done && match.winnerId !== slot.entrantId;
    const score = done ? (match.winnerId === slot.entrantId
      ? Math.max(match.score?.a ?? 0, match.score?.b ?? 0)
      : Math.min(match.score?.a ?? 0, match.score?.b ?? 0)) : '';
    return html`
      <span class="match-side ${raw(won ? 'won' : lost ? 'lost' : '')}">
        <span class="seed">${slot.seed ?? ''}</span>
        <span class="who">${nameOf(slot.entrantId)}</span>
        <span class="score">${score}</span>
      </span>`;
  };

  /* The whole card is one control, so its accessible name has to carry
     everything the sighted reader gets from position and colour: which round,
     who is in it, what the score was, and what activating it will do. */
  const nameFor = (slot) => (slot.entrantId ? nameOf(slot.entrantId) : 'not decided yet');
  const label = bye
    ? `${match.name}: ${nameFor(a.entrantId ? a : b)} advances on a bye`
    : done
      ? `${match.name}: ${nameOf(match.winnerId)} beat ${nameOf(match.loserId)} `
        + `${Math.max(match.score?.a ?? 0, match.score?.b ?? 0)} to ${Math.min(match.score?.a ?? 0, match.score?.b ?? 0)}. `
        + 'Activate to correct the result.'
      : ready
        ? `${match.name}: ${nameFor(a)} versus ${nameFor(b)}, not yet reported. Activate to report it.`
        : `${match.name}: waiting for ${nameFor(a)} versus ${nameFor(b)}`;

  return html`
    <button class="match ${raw(bye ? 'bye' : done ? 'done' : live ? 'live' : ready ? 'ready' : '')}"
            data-act="${raw(ready || done ? 'report-open' : 'noop')}" data-match="${match.id}"
            ${raw(ready || done ? '' : 'aria-disabled="true"')}
            aria-label="${label}">
      <span aria-hidden="true">
        ${raw(side(a, b))}
        ${raw(side(b, a))}
        ${bye ? html`<span class="match-meta">bye</span>` : ''}
        ${live ? html`<span class="match-meta">${raw(icon('clock', 'icon-sm'))} out
          <span data-live-since="${match.calledAt}">${elapsed(match.calledAt)}</span></span>` : ''}
      </span>
    </button>`;
}

/* --------------------------------------------------------------------------
   Rules
   -------------------------------------------------------------------------- */

function rulesTab(data) {
  const { event, game, ruleset } = data;
  if (!game || !ruleset) return html`<div class="pane"><p>No game.</p></div>`;

  const context = { ...ruleset.values, venueType: event.venueType };
  const overridden = new Set(Object.keys(event.overrides || {}));

  return html`
    <div class="pane" style="max-width:840px">
      <div class="card card-elevated" style="margin-bottom:20px">
        <div class="row-tight">
          <h2 class="title-large spacer" style="margin:0">${ruleset.presetName}</h2>
          <span class="chip chip-static chip-assist">v${ruleset.presetVersion}</span>
        </div>
        ${overridden.size ? html`
          <p class="body-medium" style="margin:8px 0 0">
            …with ${overridden.size} setting${overridden.size === 1 ? '' : 's'} changed by this event's organiser. Changed rows are marked below.
          </p>` : ''}
        ${ruleset.provisional ? html`
          <div class="banner banner-warn" style="margin-top:12px">${raw(icon('alert'))}
            <div class="body-small">This ruleset is <b>provisional</b>. ${game.short} has no ratified competitive standard yet — this is a starting point the organiser can and should argue with.</div>
          </div>` : ''}
        <div class="row" style="margin-top:12px">
          <button class="btn btn-outlined btn-sm" data-act="go" data-path="/e/${event.id}/admin/settings">Change the rules</button>
          <button class="btn btn-text btn-sm" data-act="copy-rules">${raw(icon('copy', 'icon-sm'))} Copy as text</button>
        </div>
      </div>

      ${list(game.settingGroups
        .filter((group) => fieldVisible(group, context))
        .map((group) => html`
          <section class="rules-group">
            <h3>${group.title}</h3>
            <dl style="margin:0">
              ${list(group.fields
                .filter((field) => fieldVisible(field, context))
                .filter((field) => field.type !== 'longtext' || ruleset.values[field.key])
                .map((field) => html`
                  <div class="rules-row ${raw(overridden.has(field.key) ? 'overridden' : '')}">
                    <dt>${field.label}</dt>
                    <dd>${formatValue(field, ruleset.values[field.key])}</dd>
                  </div>`))}
            </dl>
          </section>`))}
    </div>`;
}

/* --------------------------------------------------------------------------
   Settings
   -------------------------------------------------------------------------- */

function settingsTab(data) {
  const { event, game, ruleset } = data;
  const context = { ...ruleset.values, venueType: event.venueType };

  return html`
    <div class="pane" style="max-width:760px">
      <section class="card card-outlined" style="margin-bottom:16px">
        <b class="title-medium">Event</b>
        <div class="stack" style="margin-top:12px">
          <label class="field">
            <span class="field-label">Name</span>
            <input type="text" value="${event.name}" data-act-change="event-field" data-field="name">
          </label>
          <label class="field">
            <span class="field-label">Venue</span>
            <input type="text" value="${event.venue || ''}" data-act-change="event-field" data-field="venue">
          </label>
          <div class="row" style="gap:12px">
            <label class="field spacer" style="min-width:130px">
              <span class="field-label">Cap</span>
              <input type="number" value="${event.capacity ?? ''}" data-act-change="event-field" data-field="capacity" data-type="number">
            </label>
            <label class="field spacer" style="min-width:130px">
              <span class="field-label">Entry fee</span>
              <input type="number" value="${event.entryFee ?? 0}" data-act-change="event-field" data-field="entryFee" data-type="number">
            </label>
          </div>
        </div>
      </section>

      <section style="margin-bottom:16px">
        <div class="row" style="margin-bottom:8px">
          <b class="title-medium spacer">Rules</b>
          <span class="body-small dim">Changes apply immediately, mid-event included</span>
        </div>
        ${list(game.settingGroups
          .filter((group) => fieldVisible(group, context))
          .map((group) => html`
            <details class="card card-outlined" style="margin-bottom:8px">
              <summary class="row-tight" style="cursor:pointer">
                ${raw(icon(group.icon || 'tune', 'icon-sm'))}<b class="title-small">${group.title}</b>
              </summary>
              <div class="stack" style="margin-top:12px">
                ${list(group.fields
                  .filter((field) => fieldVisible(field, context))
                  .map((field) => liveSetting(field, ruleset.values[field.key], event, game)))}
              </div>
            </details>`))}
      </section>

      <section class="card card-outlined" style="margin-bottom:16px">
        <b class="title-medium">Data</b>
        <p class="body-small dim" style="margin:4px 0 12px">
          Your event, in a format you can read. There is no lock-in here on purpose —
          the reason nobody moves between bracket sites is that their history is trapped,
          and a new site that recreates that deserves to lose for the same reason.
        </p>
        <div class="row">
          <button class="btn btn-tonal btn-sm" data-act="export-entrants">${raw(icon('download', 'icon-sm'))} Entrants CSV</button>
          <button class="btn btn-tonal btn-sm" data-act="export-json">${raw(icon('download', 'icon-sm'))} Everything as JSON</button>
        </div>
      </section>

      <section class="card card-outlined">
        <b class="title-medium" style="color:var(--md-error)">Danger</b>
        <div class="row" style="margin-top:12px">
          <button class="btn btn-danger-text btn-sm" data-act="clear-bracket">Clear the bracket</button>
          <button class="btn btn-danger-text btn-sm" data-act="delete-event">Delete the event</button>
        </div>
      </section>
    </div>`;
}

/* A setting control that writes straight through to the event, for changing
   rules mid-flight. Same field types as the wizard, different write target --
   the wizard edits a draft, this edits a live event. */
function liveSetting(field, value, event, game) {
  if (field.type === 'toggle') {
    return html`
      <label class="switch">
        <input type="checkbox" ${raw(value ? 'checked' : '')}
               data-act-change="live-setting" data-field="${field.key}" data-type="toggle">
        <span class="track"><span class="thumb"></span></span>
        <span class="label-large">${field.label}</span>
      </label>`;
  }
  if (field.type === 'choice') {
    return html`
      <div>
        <p class="label-large" style="margin-bottom:6px">${field.label}</p>
        <label class="field">
          <select data-act-change="live-setting" data-field="${field.key}" data-type="choice">
            ${list(field.options.map((opt) => html`
              <option value="${opt.value}" ${raw(opt.value === value ? 'selected' : '')}>${opt.label}</option>`))}
          </select>
          ${raw(icon('chevronDown', 'select-arrow'))}
        </label>
        ${field.help ? html`<p class="field-help">${field.help}</p>` : ''}
      </div>`;
  }
  if (field.type === 'multi') return '';
  if (field.type === 'longtext') {
    return html`
      <label class="field">
        <span class="field-label">${field.label}</span>
        <textarea rows="4" data-act-change="live-setting" data-field="${field.key}" data-type="text">${value || ''}</textarea>
      </label>`;
  }
  const isNumber = field.type === 'number' || field.type === 'duration';
  return html`
    <label class="field">
      <span class="field-label">${field.label}${field.unit ? ` (${field.unit})` : ''}</span>
      <input type="${raw(isNumber ? 'number' : 'text')}" value="${value ?? ''}"
             data-act-change="live-setting" data-field="${field.key}" data-type="${raw(isNumber ? 'number' : 'text')}">
    </label>`;
}

/* ==========================================================================
   ACTIONS
   ========================================================================== */

const currentEventId = () => (window.location.hash.match(/\/e\/([^/]+)/) || [])[1];

/* ---- entrant editing ---- */

on('entrant-search', (d, el) => { ui.search = el.value; rerender(); });

on('entrant-sort', ({ col }) => {
  /* Same column toggles direction; a new column starts ascending, because
     that is what "sort by this" means for every column here except the two
     boolean ones, where ascending puts the thing needing attention first. */
  if (ui.sortBy === col) ui.sortDir = ui.sortDir === 'asc' ? 'desc' : 'asc';
  else { ui.sortBy = col; ui.sortDir = 'asc'; }
  rerender();
});

on('entrant-filter', ({ filter }) => {
  if (ui.filters.has(filter)) ui.filters.delete(filter);
  else {
    /* "Checked in" and "Not checked in" together match nobody, which reads as
       a bug rather than a filter. Selecting one clears its opposite. */
    const opposites = { in: 'not-in', 'not-in': 'in' };
    if (opposites[filter]) ui.filters.delete(opposites[filter]);
    ui.filters.add(filter);
  }
  /* A selection made under one filter should not silently carry into a bulk
     action taken under another -- the rows are no longer the ones that were
     ticked. */
  ui.selected.clear();
  rerender();
});

on('entrant-filter-clear', () => {
  ui.filters.clear();
  ui.search = '';
  ui.selected.clear();
  rerender();
});

on('select-row', ({ id }, el) => {
  if (el.checked) ui.selected.add(id); else ui.selected.delete(id);
  rerender();
});

on('select-all', (d, el) => {
  /* Selects what is ON SCREEN, not the whole roster. With filters applied
     those are different sets, and "select all" meaning "including the 180 rows
     you have filtered out" is how a bulk action goes badly wrong. */
  const data = contextFor(currentEventId());
  const visible = applyView(data.rows, data.event);
  if (el.checked) for (const row of visible) ui.selected.add(row.entry.id);
  else ui.selected.clear();
  rerender();
});

on('entry-seed', ({ id }, el) => {
  const seed = el.value === '' ? null : Number(el.value);
  store.checkpoint('seed change', [{ collection: 'entries', id }]);
  store.apply('entries', id, { seed });
});

on('entry-group', ({ id }, el) => {
  store.checkpoint('team change', [{ collection: 'entries', id }]);
  store.apply('entries', id, { group: el.value.trim() || null });
});

on('player-tag', ({ id }, el) => {
  store.checkpoint('tag change', [{ collection: 'players', id }]);
  store.apply('players', id, { tag: el.value.trim() });
});

on('toggle-checkin', ({ id }) => {
  const entry = store.get().entries[id];
  store.apply('entries', id, { checkedInAt: entry.checkedInAt ? null : new Date().toISOString() });
});

on('toggle-paid', ({ id }) => {
  const entry = store.get().entries[id];
  store.apply('entries', id, { paidAt: entry.paidAt ? null : new Date().toISOString() });
});

on('bulk', ({ op }) => {
  const ids = [...ui.selected];
  if (!ids.length) return;
  const now = new Date().toISOString();

  store.checkpoint(`${op} on ${ids.length}`, ids.map((id) => ({ collection: 'entries', id })));

  if (op === 'checkin' || op === 'uncheckin') {
    store.applyMany(ids.map((id) => ({ collection: 'entries', id, patch: { checkedInAt: op === 'checkin' ? now : null } })));
    snack(`${ids.length} ${op === 'checkin' ? 'checked in' : 'un-checked in'}`, { action: 'Undo', onAction: () => { store.undo(); rerender(); } });
  } else if (op === 'paid') {
    store.applyMany(ids.map((id) => ({ collection: 'entries', id, patch: { paidAt: now } })));
    snack(`${ids.length} marked paid`, { action: 'Undo', onAction: () => { store.undo(); rerender(); } });
  } else if (op === 'seed-sequential') {
    /* Re-seed the SELECTION in their current relative order, starting at the
       lowest seed in the selection. Used to close gaps after removing people
       without disturbing everyone else. */
    const entries = ids.map((id) => store.get().entries[id]).sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999));
    const start = Math.min(...entries.map((e) => e.seed ?? 9999));
    store.applyMany(entries.map((e, i) => ({ collection: 'entries', id: e.id, patch: { seed: start + i } })));
    snack(`Re-seeded ${ids.length} from ${start}`, { action: 'Undo', onAction: () => { store.undo(); rerender(); } });
  } else if (op === 'group') {
    dialog({
      title: `Set team for ${ids.length}`,
      body: html`<label class="field"><span class="field-label">Team or venue</span>
        <input type="text" id="group" placeholder="Batty Mac"></label>
        <p class="field-help">Used by seeding to keep them apart in the early rounds.</p>`,
      actions: [
        { label: 'Cancel', kind: 'text' },
        { label: 'Set', kind: 'filled', onClick: (dlg) => {
          const group = dlg.querySelector('#group').value.trim() || null;
          store.applyMany(ids.map((id) => ({ collection: 'entries', id, patch: { group } })));
          snack(`Team set on ${ids.length}`, { action: 'Undo', onAction: () => { store.undo(); rerender(); } });
          rerender();
        } },
      ],
    });
    return;
  } else if (op === 'remove') {
    confirmDialog({
      title: `Remove ${ids.length} entrant${ids.length === 1 ? '' : 's'}?`,
      body: 'They come off this event. Their profile and their results from other events are untouched.',
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => {
        store.applyMany(ids.map((id) => ({ collection: 'entries', id, patch: null })));
        ui.selected.clear();
        snack(`Removed ${ids.length}`, { action: 'Undo', onAction: () => { store.undo(); rerender(); } });
        rerender();
      },
    });
    return;
  }

  ui.selected.clear();
  rerender();
});

on('entrant-add', () => {
  const eventId = currentEventId();
  dialog({
    title: 'Add an entrant',
    body: html`
      <label class="field"><span class="field-label">Tag</span>
        <input type="text" id="tag" placeholder="What people call them"></label>
      <label class="field" style="margin-top:16px"><span class="field-label">Team / venue (optional)</span>
        <input type="text" id="group"></label>
      <p class="field-help">
        This creates a real profile with a claim code. If they make an account later, claiming it
        moves every set they play tonight onto it — so a walk-up entrant is not a ghost in the record.
      </p>`,
    actions: [
      { label: 'Cancel', kind: 'text' },
      { label: 'Add', kind: 'filled', onClick: (dlg) => {
        const tag = dlg.querySelector('#tag').value.trim();
        if (!tag) return false;
        addWalkUp(eventId, tag, dlg.querySelector('#group').value.trim());
        rerender();
        return true;
      } },
    ],
  });
});

function addWalkUp(eventId, tag, group) {
  const event = store.getEvent(eventId);
  const { id: playerId, code } = auth.createClaimablePlayer({
    tag, orgId: event.orgId, createdBy: auth.currentPlayer()?.id,
  });
  const entryId = store.uid('ent');
  const entries = store.entriesFor(eventId);
  store.apply('entries', entryId, {
    id: entryId, eventId, playerId,
    seed: entries.length + 1,
    group: group || null,
    registeredAt: new Date().toISOString(),
    checkedInAt: new Date().toISOString(),
    source: 'door',
    signedDocuments: [],
  });
  snack(`${tag} added — claim code ${code}`, { action: 'Copy', onAction: async () => {
    const { copy } = await import('../lib/ui.js');
    await copy(code);
  } });
  return { playerId, code };
}

on('entrant-menu', ({ id }) => {
  const entry = store.get().entries[id];
  const player = store.getPlayer(entry.playerId);
  dialog({
    title: player?.tag || 'Entrant',
    body: html`
      <div class="list">
        <a class="list-item" href="#/p/${entry.playerId}">${raw(icon('person'))}<span class="headline">Open their profile</span></a>
        ${player?.claimable ? html`
          <button class="list-item" data-act="copy-text" data-text="${player.claimCode}">
            ${raw(icon('key'))}
            <span class="spacer"><span class="headline">Claim code</span>
            <span class="supporting">${player.claimCode} — read this out so they can take over the entry</span></span>
          </button>` : ''}
        <button class="list-item" data-act="entrant-dq" data-id="${id}">
          ${raw(icon('close'))}<span class="spacer"><span class="headline">Disqualify</span>
          <span class="supporting">Advances their opponent in every open set</span></span>
        </button>
      </div>`,
    actions: [{ label: 'Close', kind: 'text' }],
  });
});

/* ---- import / export ---- */

on('import-open', () => {
  dialog({
    full: true,
    title: 'Import entrants',
    body: html`
      <p class="body-medium dim">
        Paste from a spreadsheet, a Google Form export, or a plain list of tags — any columns,
        in any order, no row limit. Re-pasting a sheet you have already imported updates those
        entrants instead of duplicating them.
      </p>
      <label class="field" style="margin-top:16px">
        <span class="field-label">Paste here</span>
        <textarea id="paste" rows="10" spellcheck="false"
          style="font-family:var(--font-mono);font-size:.8rem"
          placeholder="Tag&#9;Seed&#9;Discord&#9;Team&#10;Kira&#9;1&#9;kira&#9;Batty Mac"></textarea>
      </label>
      <div id="preview"></div>`,
    actions: [
      { label: 'Cancel', kind: 'text' },
      { label: 'Preview', kind: 'tonal', onClick: (dlg) => { showPreview(dlg); return false; } },
      { label: 'Import', kind: 'filled', onClick: (dlg) => {
        if (!ui.importPlan) { showPreview(dlg); return false; }
        runImport();
        return true;
      } },
    ],
    onClose: () => { ui.importPlan = null; },
  });
});

function showPreview(dlg) {
  const text = dlg.querySelector('#paste').value;
  const target = dlg.querySelector('#preview');
  if (!text.trim()) { target.innerHTML = ''; ui.importPlan = null; return; }

  const rows = csv.parse(text);
  const hasHeader = csv.looksLikeHeader(rows[0]);
  const mapping = hasHeader
    ? csv.mapColumns(rows[0])
    /* No header row: assume the first column is the tag, which is what a
       pasted list of names is. Anything else would be guessing. */
    : rows[0].map((_, i) => (i === 0 ? 'tag' : null));
  const records = csv.toRecords(hasHeader ? rows.slice(1) : rows, mapping);

  const data = contextFor(currentEventId());
  const plan = csv.dryRun(records, { entries: data.entries, players: data.players, eventId: data.event.id });
  ui.importPlan = plan;

  const { summary } = plan;
  target.innerHTML = html`
    <hr class="divider" style="margin:16px 0">
    <div class="row" style="gap:8px;margin-bottom:12px">
      <span class="chip chip-static chip-ok">${summary.create} new</span>
      <span class="chip chip-static chip-info">${summary.update} updated</span>
      <span class="chip chip-static chip-assist">${summary.unchanged} unchanged</span>
      ${summary.duplicate ? html`<span class="chip chip-static chip-warn">${summary.duplicate} duplicate in file</span>` : ''}
    </div>
    ${hasHeader ? html`
      <p class="body-small dim">Columns read as: ${mapping.map((m, i) => (m ? `${rows[0][i]} → ${m}` : null)).filter(Boolean).join(', ') || 'none recognised'}</p>`
      : html`<p class="body-small dim">No header row found — treating the first column as tags.</p>`}
    <div class="table-wrap" style="max-height:40dvh;margin-top:12px">
      <table class="data">
        <thead><tr><th>Row</th><th>Tag</th><th>Action</th><th>What changes</th></tr></thead>
        <tbody>
          ${list(plan.plan.slice(0, 200).map((p) => html`
            <tr>
              <td class="num dim">${p.record._row}</td>
              <td>${p.record.tag}</td>
              <td>
                <span class="chip chip-static ${raw({
                  create: 'chip-ok', update: 'chip-info', unchanged: 'chip-assist', 'duplicate-in-file': 'chip-warn',
                }[p.action])}" style="min-height:22px;padding:0 8px;font:var(--label-small)">${p.action.replace(/-/g, ' ')}</span>
              </td>
              <td class="body-small dim">
                ${p.action === 'update'
                  ? p.changes.map((c) => `${c.field}: ${c.from ?? '—'} → ${c.to}`).join(', ')
                  : p.action === 'duplicate-in-file' ? esc(p.note)
                  : p.action === 'update' ? '' : ''}
              </td>
            </tr>`))}
        </tbody>
      </table>
    </div>
    ${plan.plan.length > 200 ? html`<p class="body-small dim">Showing the first 200 of ${plan.plan.length}.</p>` : ''}`;
}

function runImport() {
  const plan = ui.importPlan;
  if (!plan) return;
  const eventId = plan.eventId;
  const event = store.getEvent(eventId);
  const writes = [];
  const touched = [];
  let seedCursor = store.entriesFor(eventId).length;

  for (const item of plan.plan) {
    if (item.action === 'unchanged' || item.action === 'duplicate-in-file') continue;
    const r = item.record;

    if (item.action === 'create') {
      const { id: playerId } = auth.createClaimablePlayer({
        tag: r.tag, orgId: event.orgId, createdBy: auth.currentPlayer()?.id,
        extra: {
          realName: r.realName || null,
          email: r.email || null,
          pronouns: r.pronouns || null,
          region: r.region || null,
          connections: {
            ...(r.discord ? { discord: r.discord } : {}),
            ...(r.psn ? { psn: r.psn } : {}),
            ...(r.steam ? { steam: r.steam } : {}),
            ...(r.nintendo ? { nintendo: r.nintendo } : {}),
          },
        },
      });
      const entryId = store.uid('ent');
      seedCursor += 1;
      writes.push({ collection: 'entries', id: entryId, patch: {
        id: entryId, eventId, playerId,
        seed: r.seed ?? seedCursor,
        group: r.group || null,
        notes: r.notes || null,
        checkedInAt: r.checkedIn ? new Date().toISOString() : null,
        paidAt: r.paid ? new Date().toISOString() : null,
        registeredAt: new Date().toISOString(),
        source: 'import',
        signedDocuments: [],
      } });
      touched.push({ collection: 'entries', id: entryId });
      touched.push({ collection: 'players', id: playerId });
      continue;
    }

    /* update */
    const entryPatch = {};
    const playerPatch = {};
    const connections = { ...(store.getPlayer(item.playerId)?.connections || {}) };

    for (const change of item.changes) {
      if (change.field === 'seed') entryPatch.seed = change.to;
      else if (change.field === 'group') entryPatch.group = change.to;
      else if (change.field === 'notes') entryPatch.notes = change.to;
      else if (change.field === 'paid') entryPatch.paidAt = new Date().toISOString();
      else if (change.field === 'checkedIn') entryPatch.checkedInAt = new Date().toISOString();
      else if (['discord', 'psn', 'steam', 'nintendo'].includes(change.field)) connections[change.field] = change.to;
      else playerPatch[change.field] = change.to;
    }
    if (Object.keys(connections).length) playerPatch.connections = connections;

    if (Object.keys(entryPatch).length) {
      writes.push({ collection: 'entries', id: item.entryId, patch: entryPatch });
      touched.push({ collection: 'entries', id: item.entryId });
    }
    if (Object.keys(playerPatch).length) {
      writes.push({ collection: 'players', id: item.playerId, patch: playerPatch });
      touched.push({ collection: 'players', id: item.playerId });
    }
  }

  store.checkpoint(`import of ${plan.summary.create + plan.summary.update} rows`, touched);
  store.applyMany(writes);
  ui.importPlan = null;

  snack(`Imported — ${plan.summary.create} new, ${plan.summary.update} updated`,
    { action: 'Undo', onAction: () => { store.undo(); rerender(); }, duration: 9000 });
  rerender();
}

on('export-entrants', () => {
  const data = contextFor(currentEventId());
  const text = csv.toCsv(data.rows, csv.ENTRANT_COLUMNS);
  csv.download(`${slug(data.event.name)}-entrants.csv`, text);
  snack('Exported. Edit it and paste it back to update these entrants.');
});

on('export-json', () => {
  csv.download('brackets-export.json', store.exportAll(), 'application/json');
});

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---- seeding ---- */

on('autoseed', ({ mode }) => {
  const data = contextFor(currentEventId());
  const pool = data.entries.filter((e) => !e.waitlisted);
  let ordered;

  if (mode === 'random') {
    ordered = [...pool].sort(() => Math.random() - 0.5);
  } else {
    /* Seed by what this site actually knows: sets won here, then win rate,
       then most recent activity. Deliberately NOT a hidden rating -- a TO has
       to be able to explain a seed to the person who got it, and "you have won
       14 of 20 sets here" is explainable in a way that "1487 elo" is not. */
    const score = (entry) => {
      const history = store.historyFor(entry.playerId);
      const wins = history.filter((r) => r.winnerPlayerId === entry.playerId).length;
      const rate = history.length ? wins / history.length : 0;
      return wins * 2 + rate * 10;
    };
    ordered = [...pool].sort((a, b) => score(b) - score(a));
  }

  store.checkpoint('auto-seed', ordered.map((e) => ({ collection: 'entries', id: e.id })));
  store.applyMany(ordered.map((entry, i) => ({ collection: 'entries', id: entry.id, patch: { seed: i + 1 } })));
  snack(mode === 'random' ? 'Randomised' : 'Seeded by results on this site',
    { action: 'Undo', onAction: () => { store.undo(); rerender(); } });
  rerender();
});

on('apply-separation', () => {
  const data = contextFor(currentEventId());
  const seeded = [...data.entries].filter((e) => !e.waitlisted).sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999));
  const withNames = seeded.map((entry) => ({
    id: entry.id, entryId: entry.id, playerId: entry.playerId,
    name: data.players.get(entry.playerId)?.tag || '—',
    group: entry.group || data.players.get(entry.playerId)?.homeVenue || null,
  }));
  const report = separate(withNames, { tolerance: 2 });

  store.checkpoint('separation swaps', report.seeds.map((s) => ({ collection: 'entries', id: s.entryId })));
  store.applyMany(report.seeds.map((s, i) => ({ collection: 'entries', id: s.entryId, patch: { seed: i + 1 } })));
  store.apply('events', data.event.id, {
    seedingReport: {
      collisions: report.collisions.map((c) => ({ a: { name: c.a.name }, b: { name: c.b.name }, round: c.round, group: c.group })),
      moves: report.moves.length,
      at: new Date().toISOString(),
    },
  });
  snack(`Applied ${report.moves.length} swap${report.moves.length === 1 ? '' : 's'}`,
    { action: 'Undo', onAction: () => { store.undo(); rerender(); } });
  rerender();
});

/* Swap an entrant with their neighbour. One checkpoint per move, so a run of
   adjustments can be undone one at a time rather than all at once -- which is
   how somebody nudging a seed order actually wants to back out of it. */
on('seed-move', ({ id, dir }) => {
  const data = contextFor(currentEventId());
  const ordered = data.entries
    .filter((e) => !e.waitlisted)
    .sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999));

  const at = ordered.findIndex((e) => e.id === id);
  const to = at + Number(dir);
  if (at < 0 || to < 0 || to >= ordered.length) return;

  [ordered[at], ordered[to]] = [ordered[to], ordered[at]];

  const moverName = data.players.get(ordered[to].playerId)?.tag || 'entrant';
  store.checkpoint(`moved ${moverName}`, ordered.map((e) => ({ collection: 'entries', id: e.id })));
  store.applyMany(ordered.map((entry, i) => ({ collection: 'entries', id: entry.id, patch: { seed: i + 1 } })));

  /* Announce the new position: after a re-render the button that was
     activated has moved, so a screen-reader user needs to be told where the
     person ended up rather than being left to hunt for them. */
  const name = data.players.get(ordered[at].playerId)?.tag || 'Entrant';
  snack(`${name} is now seed ${at + 1}`, { action: 'Undo', onAction: () => { store.undo(); rerender(); } });
  rerender();
});

/* ---- bracket ---- */

on('generate-bracket', () => {
  const data = contextFor(currentEventId());
  const eventId = data.event.id;
  const existing = store.get().brackets[eventId];

  const build = () => {
    /* Only people who are actually here. Before check-in opens, that is
       everyone; after it, it is the ones who showed up. */
    const pool = data.entries
      .filter((e) => !e.waitlisted)
      .filter((e) => (anyCheckedIn(data.entries) ? e.checkedInAt : true))
      .sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999));

    if (pool.length < 2) { snack('Need at least two checked-in entrants.'); return; }

    const seeds = pool.map((entry) => ({ id: entry.id, name: data.players.get(entry.playerId)?.tag }));
    const built = data.event.format === 'single'
      ? singleElimination(seeds)
      : doubleElimination(seeds, { grandFinalsReset: data.ruleset?.values?.grandFinalsReset !== false });

    store.apply('brackets', eventId, {
      id: eventId, eventId,
      type: built.type, size: built.size, rounds: built.rounds,
      matches: built.matches,
      generatedAt: new Date().toISOString(),
    });
    store.apply('events', eventId, { status: 'running' });
    snack(`Bracket made — ${pool.length} entrants, ${built.size} slots`);
    window.location.hash = `#/e/${eventId}/admin/run`;
  };

  if (existing) {
    confirmDialog({
      title: 'Regenerate the bracket?',
      body: 'Every reported set is discarded and the bracket is rebuilt from the current seeds.',
      confirmLabel: 'Regenerate',
      danger: true,
      onConfirm: build,
    });
  } else build();
});

on('clear-bracket', () => {
  const eventId = currentEventId();
  confirmDialog({
    title: 'Clear the bracket?',
    body: 'The bracket and every result in it are removed. Entrants and seeds stay.',
    confirmLabel: 'Clear',
    danger: true,
    onConfirm: () => {
      store.apply('brackets', eventId, null);
      store.apply('events', eventId, { status: 'seeding' });
      snack('Bracket cleared');
      rerender();
    },
  });
});

on('call-next', ({ station: stationId }) => {
  const data = contextFor(currentEventId());
  const called = new Set(data.bracket.matches.filter((m) => m.calledAt && !m.state).map((m) => m.id));
  const next = readyMatches(data.bracket.matches).find((m) => !called.has(m.id));
  if (!next) { snack('Nothing ready to call.'); return; }

  const matches = data.bracket.matches.map((m) => (m.id === next.id
    ? { ...m, calledAt: new Date().toISOString(), stationId } : m));
  store.apply('brackets', data.event.id, { matches });
  store.apply('stations', stationId, { matchId: next.id });

  const nameOf = (entrantId) => {
    const entry = data.entries.find((e) => e.id === entrantId);
    return data.players.get(entry?.playerId)?.tag || '—';
  };
  snack(`${nameOf(next.slots[0].entrantId)} v ${nameOf(next.slots[1].entrantId)} → ${store.get().stations[stationId].label}`);
  rerender();
});

on('station-add', () => {
  const eventId = currentEventId();
  const stations = store.stationsFor(eventId);
  const id = store.uid('stn');
  store.apply('stations', id, {
    id, eventId, number: stations.length + 1, label: `Station ${stations.length + 1}`,
  });
  rerender();
});

/* ---- reporting ---- */

on('report-open', ({ match: matchId }) => {
  const data = contextFor(currentEventId());
  const match = data.bracket.matches.find((m) => m.id === matchId);
  if (!match) return;

  const [a, b] = match.slots;
  const nameOf = (entrantId) => {
    const entry = data.entries.find((e) => e.id === entrantId);
    return data.players.get(entry?.playerId)?.tag || '—';
  };

  const isFinals = match.bracket === 'GF' || (match.bracket === 'W' && match.round === data.bracket.rounds);
  const length = setLength(isFinals
    ? data.ruleset?.values?.setLengthFinals
    : data.ruleset?.values?.setLengthPools);
  const target = Math.ceil(length.games / 2);

  dialog({
    title: match.name,
    body: html`
      <p class="body-medium dim">First to ${target} — best of ${length.games}. Tap the winner's score.</p>
      <div class="stack" style="margin:16px 0">
        ${list([[a, 'a'], [b, 'b']].map(([slot, side]) => html`
          <div class="card card-outlined">
            <div class="row" style="flex-wrap:nowrap">
              <b class="title-medium spacer">${nameOf(slot.entrantId)}</b>
              <div class="segmented">
                ${list(Array.from({ length: target + 1 }, (_, n) => html`
                  <button type="button" data-score-side="${side}" data-score="${n}"
                          aria-pressed="false" style="min-width:44px">${n}</button>`))}
              </div>
            </div>
          </div>`))}
      </div>
      <button class="btn btn-danger-text btn-block" id="dq-a">Disqualify ${nameOf(a.entrantId)}</button>
      <button class="btn btn-danger-text btn-block" id="dq-b">Disqualify ${nameOf(b.entrantId)}</button>
      ${match.state === 'complete' ? html`
        <hr class="divider" style="margin:16px 0">
        <button class="btn btn-outlined btn-block" id="unreport">${raw(icon('undo'))} Un-report this set</button>
        <p class="field-help">Clears this result and everything downstream of it. The old result is kept in the log.</p>` : ''}`,
    actions: [
      { label: 'Cancel', kind: 'text' },
      { label: 'Save', kind: 'filled', onClick: (dlg) => {
        const scoreA = Number(dlg.querySelector('[data-score-side="a"][aria-pressed="true"]')?.dataset.score ?? -1);
        const scoreB = Number(dlg.querySelector('[data-score-side="b"][aria-pressed="true"]')?.dataset.score ?? -1);
        if (scoreA < 0 || scoreB < 0) { snack('Pick both scores.'); return false; }
        if (scoreA === scoreB) { snack('A set cannot be a draw.'); return false; }
        saveResult(matchId, scoreA > scoreB ? a.entrantId : b.entrantId, scoreA, scoreB);
        return true;
      } },
    ],
  });

  const dlg = document.querySelector('dialog.m3');
  dlg.addEventListener('click', (e) => {
    const button = e.target.closest('[data-score-side]');
    if (button) {
      for (const other of dlg.querySelectorAll(`[data-score-side="${button.dataset.scoreSide}"]`)) {
        other.setAttribute('aria-pressed', 'false');
      }
      button.setAttribute('aria-pressed', 'true');
      /* Picking a winning score auto-fills the other side's default, because
         the overwhelmingly common report is 2-0 or 2-1 and making someone tap
         a zero is a tap too many at a station with a queue behind it. */
      const other = button.dataset.scoreSide === 'a' ? 'b' : 'a';
      if (Number(button.dataset.score) === target
        && !dlg.querySelector(`[data-score-side="${other}"][aria-pressed="true"]`)) {
        dlg.querySelector(`[data-score-side="${other}"][data-score="0"]`)?.setAttribute('aria-pressed', 'true');
      }
    }
  });
  dlg.querySelector('#dq-a')?.addEventListener('click', () => { saveResult(matchId, b.entrantId, 0, target, true); dlg.close(); });
  dlg.querySelector('#dq-b')?.addEventListener('click', () => { saveResult(matchId, a.entrantId, target, 0, true); dlg.close(); });
  dlg.querySelector('#unreport')?.addEventListener('click', () => { unreport(matchId); dlg.close(); });
});

function saveResult(matchId, winnerEntrantId, scoreA, scoreB, byDq = false) {
  const data = contextFor(currentEventId());
  const eventId = data.event.id;
  const match = data.bracket.matches.find((m) => m.id === matchId);

  const next = reportResult(data.bracket.matches, matchId, { winnerId: winnerEntrantId, scoreA, scoreB })
    .map((m) => (m.id === matchId ? { ...m, byDq, calledAt: m.calledAt } : m));

  store.apply('brackets', eventId, { matches: next });

  /* Free the station this set was on. */
  const station = data.stations.find((s) => s.matchId === matchId);
  if (station) store.apply('stations', station.id, { matchId: null });

  /* And write the durable result row. This is the record that outlives the
     event: it carries PLAYER ids, not entry ids, so a profile query never has
     to join through a tournament that may have been deleted. */
  const done = next.find((m) => m.id === matchId);
  const entryOf = (id) => data.entries.find((e) => e.id === id);
  const winnerPlayerId = entryOf(done.winnerId)?.playerId;
  const loserPlayerId = entryOf(done.loserId)?.playerId;

  if (winnerPlayerId && loserPlayerId) {
    const resultId = store.uid('res');
    store.apply('results', resultId, {
      id: resultId, eventId, gameId: data.event.gameId,
      matchId, roundName: match.name,
      winnerPlayerId, loserPlayerId,
      scoreWinner: Math.max(scoreA, scoreB),
      scoreLoser: Math.min(scoreA, scoreB),
      byDq,
      reportedAt: new Date().toISOString(),
      reportedBy: auth.currentPlayer()?.id || null,
    });
  }

  snack(byDq ? 'Recorded as a disqualification' : 'Reported');
  rerender();
}

function unreport(matchId) {
  const data = contextFor(currentEventId());
  const next = clearResult(data.bracket.matches, matchId);
  store.apply('brackets', data.event.id, { matches: next });

  /* Supersede rather than delete the result row -- if two people reported
     different scores from two phones, both are in the log with timestamps, and
     that is what makes the disagreement settleable. */
  for (const result of Object.values(store.get().results)) {
    if (result.matchId === matchId && result.eventId === data.event.id && !result.superseded) {
      store.apply('results', result.id, { superseded: true, supersededAt: new Date().toISOString() });
    }
  }
  snack('Un-reported');
  rerender();
}

/* ---- event settings ---- */

on('event-status', ({ status }) => {
  const eventId = currentEventId();
  const patch = { status };
  if (status === 'checkin') {
    patch.checkInOpensAt = new Date().toISOString();
    patch.checkInClosesAt = new Date(Date.now() + 30 * 60000).toISOString();
  }
  store.apply('events', eventId, patch);
  snack(`Moved to ${FLOW_LABEL[status]}`);
  rerender();
});

on('event-field', ({ field, type }, el) => {
  const value = type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
  store.apply('events', currentEventId(), { [field]: value });
});

on('live-setting', ({ field, type }, el) => {
  const eventId = currentEventId();
  const data = contextFor(eventId);
  const base = resolveRuleset(data.game, data.event.presetId, {});
  let next;
  if (type === 'toggle') next = el.checked;
  else if (type === 'number') next = Number(el.value);
  else next = el.value;

  const overrides = { ...(data.event.overrides || {}) };
  if (JSON.stringify(next) === JSON.stringify(base.values[field])) delete overrides[field];
  else overrides[field] = next;

  store.apply('events', eventId, { overrides });
  snack('Rule changed — players see it on the rules sheet immediately');
});

on('copy-rules', async () => {
  const data = contextFor(currentEventId());
  const context = { ...data.ruleset.values, venueType: data.event.venueType };
  const lines = [`${data.event.name} — ${data.game.name}`,
    `${data.ruleset.presetName} v${data.ruleset.presetVersion}${data.ruleset.provisional ? ' (provisional)' : ''}`, ''];
  for (const group of data.game.settingGroups.filter((g) => fieldVisible(g, context))) {
    lines.push(`## ${group.title}`);
    for (const field of group.fields.filter((f) => fieldVisible(f, context))) {
      lines.push(`- ${field.label}: ${formatValue(field, data.ruleset.values[field.key])}`);
    }
    lines.push('');
  }
  const { copy } = await import('../lib/ui.js');
  await copy(lines.join('\n'));
  snack('Rules copied — paste them into your Discord');
});

on('delete-event', () => {
  const eventId = currentEventId();
  confirmDialog({
    title: 'Delete this event?',
    body: 'The event, its entrants and its bracket go. Results already played stay on players\' profiles.',
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: () => {
      for (const entry of store.entriesFor(eventId)) store.apply('entries', entry.id, null);
      store.apply('brackets', eventId, null);
      store.apply('events', eventId, null);
      snack('Deleted');
      window.location.hash = '#/';
    },
  });
});

on('entrant-dq', ({ id }) => {
  const data = contextFor(currentEventId());
  if (!data.bracket) { snack('No bracket yet — remove them from the entrants list instead.'); return; }

  let matches = data.bracket.matches;
  let count = 0;
  for (const match of readyMatches(matches)) {
    const slot = match.slots.findIndex((s) => s.entrantId === id);
    if (slot < 0) continue;
    const winner = match.slots[1 - slot].entrantId;
    matches = reportResult(matches, match.id, { winnerId: winner, scoreA: slot === 0 ? 0 : 2, scoreB: slot === 0 ? 2 : 0 });
    count += 1;
  }
  store.apply('brackets', data.event.id, { matches });
  snack(count ? `Disqualified — ${count} set${count === 1 ? '' : 's'} advanced` : 'They have no open sets.');
  rerender();
});

/* ---- guidance actions ---- */

on('guide-action', ({ suggestion, actionId, payload }) => {
  const data = contextFor(currentEventId());
  const args = JSON.parse(payload || '{}');
  const eventId = data.event.id;

  switch (actionId) {
    case 'dismiss':
      ui.dismissed.add(suggestion);
      break;

    case 'dq-missing': {
      const missing = data.entries.filter((e) => !e.checkedInAt);
      confirmDialog({
        title: `Remove ${missing.length} who did not check in?`,
        body: 'They come off the event. You can add them back if someone turns up late.',
        confirmLabel: 'Remove them',
        danger: true,
        onConfirm: () => {
          store.checkpoint(`removed ${missing.length} no-shows`, missing.map((e) => ({ collection: 'entries', id: e.id })));
          store.applyMany(missing.map((e) => ({ collection: 'entries', id: e.id, patch: null })));
          snack(`Removed ${missing.length}`, { action: 'Undo', onAction: () => { store.undo(); rerender(); } });
          rerender();
        },
      });
      return;
    }

    case 'extend-checkin':
      store.apply('events', eventId, {
        checkInClosesAt: new Date(Date.now() + (args.minutes || 10) * 60000).toISOString(),
      });
      snack(`Check-in extended by ${args.minutes || 10} minutes`);
      break;

    case 'reseed-present': {
      const present = data.entries.filter((e) => e.checkedInAt).sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999));
      store.checkpoint('re-seeded to who is here', present.map((e) => ({ collection: 'entries', id: e.id })));
      store.applyMany(present.map((e, i) => ({ collection: 'entries', id: e.id, patch: { seed: i + 1 } })));
      snack(`Re-seeded ${present.length}`, { action: 'Undo', onAction: () => { store.undo(); rerender(); } });
      break;
    }

    case 'autoseed-history':
      document.querySelector('[data-act="autoseed"][data-mode="history"]')?.click();
      window.location.hash = `#/e/${eventId}/admin/seeding`;
      return;

    case 'autoseed-random':
      window.location.hash = `#/e/${eventId}/admin/seeding`;
      return;

    case 'open-seeding':
    case 'preview-bracket':
      window.location.hash = `#/e/${eventId}/admin/seeding`;
      return;

    case 'generate-bracket':
      window.location.hash = `#/e/${eventId}/admin/seeding`;
      snack('Check the seeding, then generate.');
      return;

    case 'open-run':
    case 'assign-queue':
      if (actionId === 'assign-queue') {
        for (const station of data.stations.filter((s) => !s.matchId)) {
          document.querySelector(`[data-act="call-next"][data-station="${station.id}"]`);
        }
        assignQueue(data);
        return;
      }
      window.location.hash = `#/e/${eventId}/admin/run`;
      return;

    case 'find-set':
      window.location.hash = `#/e/${eventId}/admin/run`;
      return;

    case 'dq-player':
      window.location.hash = `#/e/${eventId}/admin/run`;
      snack('Open the set and use Disqualify.');
      return;

    case 'extend-dq': {
      const matches = data.bracket.matches.map((m) => (m.id === args.matchId
        ? { ...m, calledAt: new Date(Date.now() - 0).toISOString() } : m));
      store.apply('brackets', eventId, { matches });
      snack('DQ clock restarted');
      break;
    }

    case 'review-duplicates':
    case 'review-missing':
    case 'view-missing':
    case 'view-missing-ids':
    case 'view-unsigned':
      window.location.hash = `#/e/${eventId}/admin/entrants`;
      return;

    case 'open-payments':
      window.location.hash = `#/e/${eventId}/admin/entrants`;
      return;

    case 'mark-all-paid': {
      const unpaid = data.entries.filter((e) => e.checkedInAt && !e.paidAt);
      store.checkpoint(`marked ${unpaid.length} paid`, unpaid.map((e) => ({ collection: 'entries', id: e.id })));
      store.applyMany(unpaid.map((e) => ({ collection: 'entries', id: e.id, patch: { paidAt: new Date().toISOString() } })));
      snack(`${unpaid.length} marked paid`, { action: 'Undo', onAction: () => { store.undo(); rerender(); } });
      break;
    }

    case 'publish-results':
      store.apply('events', eventId, { status: 'complete', completedAt: new Date().toISOString() });
      snack('Published — results are on every entrant\'s profile');
      break;

    case 'review-standings':
      window.location.hash = `#/e/${eventId}`;
      return;

    case 'add-password':
      import('./auth.js').then((m) => m.openSetPassword());
      return;

    case 'ping-missing':
    case 'ping-players':
    case 'chase-signatures':
    case 'request-ids':
      /* Not wired to a bot yet. Saying so is better than a button that looks
         like it did something -- see the README on what is and is not built. */
      snack('Notifications need the Discord bot, which is not built yet. See the README.');
      return;

    case 'raise-tolerance':
      window.location.hash = `#/e/${eventId}/admin/seeding`;
      return;

    case 'run-with-byes':
      ui.dismissed.add(suggestion);
      break;

    default:
      break;
  }
  rerender();
});

function assignQueue(data) {
  const called = new Set(data.bracket.matches.filter((m) => m.calledAt && !m.state).map((m) => m.id));
  const queue = readyMatches(data.bracket.matches).filter((m) => !called.has(m.id));
  const free = data.stations.filter((s) => !s.matchId && !s.closed);
  let matches = data.bracket.matches;
  let n = 0;

  for (const station of free) {
    const match = queue[n];
    if (!match) break;
    matches = matches.map((m) => (m.id === match.id
      ? { ...m, calledAt: new Date().toISOString(), stationId: station.id } : m));
    store.apply('stations', station.id, { matchId: match.id });
    n += 1;
  }

  store.apply('brackets', data.event.id, { matches });
  snack(n ? `Called ${n} set${n === 1 ? '' : 's'}` : 'No free stations.');
  rerender();
}
