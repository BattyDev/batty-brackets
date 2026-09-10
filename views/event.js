/* Brackets · the event page, as a player sees it
   ===========================================================================
   What a player needs, in the order they need it, on a phone, in a loud room:

     1. Am I in? Am I checked in? Have I signed what I need to sign?
     2. Who am I playing, and where do I go?
     3. What are the rules, exactly, so the argument at the station is short?
     4. Where does my path go if I keep winning — and if I lose?

   Everything else is secondary. In particular the full bracket is NOT the
   first thing on the page, even though it is the thing bracket sites lead
   with: a 128-entrant bracket on a 390px screen is a maze, and the player's
   actual question is "what do I do now".
   =========================================================================== */

'use strict';

import {
  html, raw, list, icon, esc, on, snack, dialog, avatar,
  formatDateTime, relativeTime,
} from '../lib/ui.js';
import * as store from '../lib/store.js';
import * as auth from '../lib/auth.js';
import { gameById, resolveRuleset, fieldVisible, formatValue } from '../data/games.js';
import { gameHero, gameMark } from '../data/themes.js';
import { standings, readyMatches } from '../lib/bracket.js';
import { formatMoney } from '../lib/guidance.js';
import { readinessFor } from '../lib/auth.js';

export function view(ctx) {
  const event = store.getEvent(ctx.params.eventId);
  if (!event) {
    return {
      title: 'Event', back: '/',
      body: html`<div class="pane"><div class="empty">${raw(icon('alert'))}
        <p class="body-large">No event with that id on this device.</p>
        <p class="body-medium">If someone shared this link, it may only exist on their phone — an event has to be published to a server before it is visible to anyone else.</p>
        <a class="btn btn-tonal" href="#/">Back to events</a></div></div>`,
    };
  }

  const game = gameById(event.gameId);
  const ruleset = game ? resolveRuleset(game, event.presetId, event.overrides || {}) : null;
  const entries = store.entriesFor(event.id);
  const players = new Map(entries.map((e) => [e.playerId, store.getPlayer(e.playerId)]));
  const bracket = store.get().brackets[event.id] || null;
  const me = ctx.me;
  const myEntry = me ? entries.find((e) => e.playerId === me.id) : null;
  const isOrganiser = !ctx.session || !event.ownerId || event.ownerId === me?.id;

  const tab = ctx.params.tab || 'now';

  return {
    title: event.name,
    subtitle: `${game?.short || ''} · ${formatDateTime(event.startsAt)}`,
    back: '/',
    gameId: event.gameId,
    body: html`
      <!-- Links in a <nav>, not an ARIA tab widget. See the note in admin.js. -->
      <nav class="tabs" aria-label="Event sections">
        ${list([
          ['now', 'You', 'person'],
          ['bracket', 'Bracket', 'bracket'],
          ['entrants', 'Entrants', 'group'],
          ['rules', 'Rules', 'gavel'],
        ].map(([id, label, ic]) => html`
          <a class="tab" href="#/e/${event.id}/${id}"
             ${raw(id === tab ? 'aria-current="page"' : '')}>
            ${raw(icon(ic, 'icon-sm'))}${label}
          </a>`))}
        ${isOrganiser ? html`
          <a class="tab" href="#/e/${event.id}/admin">
            ${raw(icon('settings', 'icon-sm'))}Organise
          </a>` : ''}
      </nav>

      ${raw({
        now: () => youTab({ event, game, ruleset, entries, players, bracket, me, myEntry }),
        bracket: () => bracketTab({ event, entries, players, bracket }),
        entrants: () => entrantsTab({ event, entries, players }),
        rules: () => rulesTab({ event, game, ruleset }),
      }[tab]?.() || '')}`,
  };
}

/* --------------------------------------------------------------------------
   "You"
   -------------------------------------------------------------------------- */

function youTab({ event, game, ruleset, entries, players, bracket, me, myEntry }) {
  if (!me) {
    return html`
      <div class="pane">
        ${raw(eventHeader(event, game, entries))}
        <div class="card card-elevated" style="margin-top:16px;text-align:center">
          <p class="body-large">Sign in to enter, or to see where you are in the bracket.</p>
          <button class="btn btn-filled btn-lg" data-act="sign-in" style="margin-top:8px">Sign in</button>
        </div>
      </div>`;
  }

  if (!myEntry) {
    const full = event.capacity && entries.length >= event.capacity;
    return html`
      <div class="pane">
        ${raw(eventHeader(event, game, entries))}
        <div class="card card-elevated" style="margin-top:16px">
          <b class="title-large">You are not entered</b>
          <p class="body-medium dim" style="margin:4px 0 12px">
            ${full ? `This event is full at ${event.capacity}, but waitlists at locals move.` : 'Registration is open.'}
          </p>
          <button class="btn btn-filled btn-block" data-act="join-event" data-event="${event.id}">
            ${full ? 'Join the waitlist' : 'Enter this event'}
          </button>
        </div>
      </div>`;
  }

  /* Their next set, if the bracket exists. */
  const myMatches = bracket
    ? bracket.matches.filter((m) => !m.cancelled && m.slots.some((s) => s.entrantId === myEntry.id))
    : [];
  const next = myMatches.find((m) => !m.state && m.slots[0].entrantId && m.slots[1].entrantId);
  const waiting = myMatches.find((m) => !m.state && !m.slots.every((s) => s.entrantId));
  const played = myMatches.filter((m) => m.state === 'complete');
  const losses = played.filter((m) => m.winnerId && m.winnerId !== myEntry.id).length;
  const out = bracket && losses >= (bracket.type === 'double' ? 2 : 1);

  const required = (event.documents || []).filter((d) => d.required);
  const signed = new Set(myEntry.signedDocuments || []);
  const unsigned = required.filter((d) => !signed.has(d.id));
  const readiness = readinessFor(players.get(me.id) || me, event);

  const nameOf = (entrantId) => {
    const entry = entries.find((e) => e.id === entrantId);
    return players.get(entry?.playerId)?.tag || '—';
  };
  const station = next?.stationId ? store.get().stations[next.stationId] : null;

  return html`
    <div class="pane" style="max-width:720px">
      ${next ? html`
        <div class="card card-elevated" style="margin-bottom:16px;border-left:6px solid var(--md-primary)">
          <div class="label-large" style="color:var(--md-primary)">${next.calledAt ? 'You are up now' : 'Your next set'}</div>
          <h2 class="headline-small" style="margin:6px 0">
            v ${nameOf(next.slots.find((s) => s.entrantId !== myEntry.id)?.entrantId)}
          </h2>
          <div class="body-medium dim">${next.name}</div>
          ${station ? html`
            <div class="row-tight" style="margin-top:12px;color:var(--md-primary)">
              ${raw(icon('station'))}<b class="title-medium">${station.label}</b>
            </div>` : ''}
          ${next.calledAt ? html`
            <div class="banner banner-warn" style="margin-top:12px">${raw(icon('clock'))}
              <div class="body-small">Called ${relativeTime(next.calledAt)}. The DQ window is
              ${ruleset?.values?.dqTimer || 5} minutes from when it was called.</div>
            </div>` : ''}
          ${raw(headToHeadLine(me.id, entries, players, next, myEntry))}
        </div>` : ''}

      ${!next && waiting ? html`
        <div class="card card-elevated" style="margin-bottom:16px">
          <div class="label-large dim">Waiting</div>
          <h2 class="title-large" style="margin:6px 0">${waiting.name}</h2>
          <p class="body-medium dim">Your opponent has not been decided yet. You will be called when they are.</p>
        </div>` : ''}

      ${out ? html`
        <div class="card card-filled" style="margin-bottom:16px">
          <b class="title-medium">You are out</b>
          <p class="body-medium dim" style="margin:4px 0 0">
            ${played.length} set${played.length === 1 ? '' : 's'} played.
            Your results are already on <a href="#/me">your profile</a>.
          </p>
        </div>` : ''}

      <section class="card card-outlined" style="margin-bottom:16px">
        <b class="title-medium">Your entry</b>
        <div class="stack-sm" style="margin-top:12px">
          ${raw(checkRow('Seed', myEntry.seed ? `#${myEntry.seed}` : 'not seeded yet', true))}
          ${raw(checkRow('Checked in', myEntry.checkedInAt ? 'yes' : 'not yet', Boolean(myEntry.checkedInAt)))}
          ${event.entryFee ? raw(checkRow('Entry fee', myEntry.paidAt ? 'paid' : `${formatMoney(event.entryFee, event.currency)} owing`, Boolean(myEntry.paidAt))) : ''}
          ${list(required.map((doc) => raw(checkRow(doc.title, signed.has(doc.id) ? 'signed' : 'not signed', signed.has(doc.id)))))}
        </div>

        ${!myEntry.checkedInAt && ['checkin', 'seeding'].includes(event.status) ? html`
          <button class="btn btn-filled btn-block" data-act="self-checkin" data-entry="${myEntry.id}" style="margin-top:16px">
            ${raw(icon('check'))} Check in
          </button>` : ''}

        ${unsigned.length ? html`
          <div class="stack-sm" style="margin-top:12px">
            ${list(unsigned.map((doc) => html`
              <button class="btn btn-tonal btn-block" data-act="sign-doc" data-entry="${myEntry.id}" data-doc="${doc.id}">
                ${raw(icon('doc'))} Read and sign: ${doc.title}
              </button>`))}
          </div>` : ''}
      </section>

      ${readiness.length ? html`
        <div class="banner ${raw(readiness.some((p) => p.level === 'error') ? 'banner-error' : 'banner-warn')}" style="margin-bottom:16px">
          ${raw(icon('alert'))}
          <div>
            <b>Before your first set</b>
            <ul style="margin:6px 0 0;padding-left:20px">
              ${list(readiness.map((p) => html`<li class="body-small">${p.text}</li>`))}
            </ul>
            <a class="btn btn-tonal btn-sm" href="#/me" style="margin-top:8px">Fix it on your profile</a>
          </div>
        </div>` : ''}

      ${raw(eventHeader(event, game, entries))}
    </div>`;
}

function checkRow(label, value, ok) {
  return html`
    <div class="row" style="flex-wrap:nowrap">
      ${raw(icon(ok ? 'check' : 'close', 'icon-sm'))}
      <span class="body-medium spacer">${label}</span>
      <span class="body-medium ${raw(ok ? '' : 'dim')}">${value}</span>
    </div>`;
}

/* "You have played them twice and lost both" is exactly what a player wants
   before a set and no bracket site tells them. It is one lookup because
   results are keyed on players. */
function headToHeadLine(myPlayerId, entries, players, match, myEntry) {
  const opponentEntryId = match.slots.find((s) => s.entrantId !== myEntry.id)?.entrantId;
  const opponentPlayerId = entries.find((e) => e.id === opponentEntryId)?.playerId;
  if (!opponentPlayerId) return '';

  const h2h = store.headToHead(myPlayerId, opponentPlayerId);
  if (!h2h.sets.length) {
    return html`<p class="body-small dim" style="margin:12px 0 0">You have not played them before.</p>`;
  }
  const last = h2h.sets[0];
  const wonLast = last.winnerPlayerId === myPlayerId;
  return html`
    <p class="body-small dim" style="margin:12px 0 0">
      Head to head: <b>${h2h.wins}–${h2h.losses}</b>.
      Last time you ${wonLast ? 'won' : 'lost'} ${last.scoreWinner}–${last.scoreLoser}, ${relativeTime(last.reportedAt)}.
    </p>`;
}

function eventHeader(event, game, entries) {
  return html`
    ${raw(gameHero(game, {
      title: event.name,
      subtitle: [formatDateTime(event.startsAt), event.venue].filter(Boolean).join(' · '),
    }))}
    <div class="card card-outlined" style="margin-top:12px">
      <div class="row" style="margin-top:12px;gap:8px">
        <span class="chip chip-static chip-assist">${entries.length}${event.capacity ? `/${event.capacity}` : ''} entrants</span>
        <span class="chip chip-static chip-assist">${event.format === 'single' ? 'Single' : 'Double'} elim</span>
        ${event.entryFee ? html`<span class="chip chip-static chip-assist">${formatMoney(event.entryFee, event.currency)}</span>` : ''}
      </div>
    </div>`;
}

/* --------------------------------------------------------------------------
   Bracket
   -------------------------------------------------------------------------- */

function bracketTab({ event, entries, players, bracket }) {
  if (!bracket) {
    return html`<div class="pane"><div class="empty">${raw(icon('bracket'))}
      <p class="body-large">The bracket has not been made yet.</p>
      <p class="body-medium">It appears here as soon as the organiser generates it.</p></div></div>`;
  }

  const nameOf = (entrantId) => {
    const entry = entries.find((e) => e.id === entrantId);
    return players.get(entry?.playerId)?.tag || '—';
  };

  const table = standings(bracket, new Map(entries.map((e) => [e.id, {
    ...e, tag: players.get(e.playerId)?.tag, playerId: e.playerId,
  }])));

  const rounds = [];
  for (const side of bracket.type === 'double' ? ['W', 'L', 'GF'] : ['W']) {
    const nums = [...new Set(bracket.matches.filter((m) => m.bracket === side).map((m) => m.round))].sort((a, b) => a - b);
    for (const num of nums) {
      const matches = bracket.matches.filter((m) => m.bracket === side && m.round === num && !m.cancelled);
      if (matches.length) rounds.push({ name: matches[0].name, matches });
    }
  }

  return html`
    <div class="pane">
      ${event.status === 'complete' && table.length ? html`
        <section class="card card-elevated" style="margin-bottom:16px">
          <b class="title-large">Final standings</b>
          <div class="list" style="margin-top:8px">
            ${list(table.slice(0, 8).map((row) => html`
              <a class="list-item" href="#/p/${row.entrant.playerId}">
                <span class="avatar avatar-sm">${row.place}</span>
                <span class="headline spacer">${row.entrant.tag}</span>
              </a>`))}
          </div>
        </section>` : ''}

      <h2 class="title-large" style="margin-bottom:8px">Bracket</h2>
      <!-- tabindex + role so the pane can be scrolled with the arrow keys. A
           scroll container that only answers a wheel or a swipe is unreachable
           from a keyboard, and the bracket is the widest thing on the site. -->
      <div class="bracket-scroll" data-keep-scroll="public-bracket"
           tabindex="0" role="region" aria-label="Bracket — scroll sideways for later rounds">
        <div class="bracket">
          ${list(rounds.map((round) => html`
            <div class="bracket-round" role="group" aria-label="${round.name}">
              <h3>${round.name}</h3>
              <div class="round-body">
              ${list(round.matches.map((match) => {
                const done = match.state === 'complete';
                const bye = match.state === 'bye';
                /* A bracket is a genuinely visual artefact -- position on
                   screen IS the information -- so the fix is not to describe
                   the picture but to have each match state its own content as
                   a sentence, with the visual rows hidden from the reader. */
                const nameFor = (slot) => (slot.entrantId ? nameOf(slot.entrantId) : 'not decided yet');
                const loserId = match.slots.find((sl) => sl.entrantId && sl.entrantId !== match.winnerId)?.entrantId;
                const summary = bye
                  ? `${nameFor(match.slots.find((sl) => sl.entrantId) || match.slots[0])} advances on a bye`
                  : done
                    ? `${nameOf(match.winnerId)} beat ${loserId ? nameOf(loserId) : 'their opponent'} `
                      + `${Math.max(match.score?.a ?? 0, match.score?.b ?? 0)} to ${Math.min(match.score?.a ?? 0, match.score?.b ?? 0)}`
                    : `${nameFor(match.slots[0])} versus ${nameFor(match.slots[1])}, not yet played`;
                return html`
                  <div class="match ${raw(bye ? 'bye' : done ? 'done' : match.calledAt ? 'live' : '')}">
                    <span class="sr-only">${summary}</span>
                    <span aria-hidden="true">
                    ${list(match.slots.map((slot) => {
                      if (!slot.entrantId) {
                        return html`<span class="match-side tbd"><span class="seed"></span><span class="who">waiting</span></span>`;
                      }
                      const won = done && match.winnerId === slot.entrantId;
                      const score = done ? (won
                        ? Math.max(match.score?.a ?? 0, match.score?.b ?? 0)
                        : Math.min(match.score?.a ?? 0, match.score?.b ?? 0)) : '';
                      return html`
                        <span class="match-side ${raw(won ? 'won' : done ? 'lost' : '')}">
                          <span class="seed">${slot.seed ?? ''}</span>
                          <span class="who">${nameOf(slot.entrantId)}</span>
                          <span class="score">${score}</span>
                        </span>`;
                    }))}
                    ${bye ? html`<span class="match-meta">bye</span>` : ''}
                    </span>
                  </div>`;
              }))}
              </div>
            </div>`))}
        </div>
      </div>
      <p class="body-small dim" style="margin-top:8px">Scroll sideways for later rounds.</p>
    </div>`;
}

/* --------------------------------------------------------------------------
   Entrants
   -------------------------------------------------------------------------- */

function entrantsTab({ event, entries, players }) {
  return html`
    <div class="pane" style="max-width:720px">
      <p class="body-medium dim" style="margin-bottom:12px">
        ${entries.length} entered${event.capacity ? ` of ${event.capacity}` : ''}.
      </p>
      <div class="list card card-outlined" style="padding:0">
        ${list(entries.map((entry) => {
          const player = players.get(entry.playerId);
          return html`
            <a class="list-item" href="#/p/${entry.playerId}">
              <span class="avatar avatar-sm">${entry.seed ?? '—'}</span>
              ${raw(avatar(player, 'avatar-sm'))}
              <span class="spacer">
                <span class="headline">${player?.tag || '—'}</span>
                ${entry.group ? html`<span class="supporting">${entry.group}</span>` : ''}
              </span>
              ${entry.checkedInAt ? html`<span class="chip chip-static chip-ok" style="min-height:22px;padding:0 8px;font:var(--label-small)">in</span>` : ''}
              ${entry.waitlisted ? html`<span class="chip chip-static chip-assist" style="min-height:22px;padding:0 8px;font:var(--label-small)">waitlist</span>` : ''}
            </a>`;
        }))}
      </div>
    </div>`;
}

/* --------------------------------------------------------------------------
   Rules
   -------------------------------------------------------------------------- */

function rulesTab({ event, game, ruleset }) {
  if (!game || !ruleset) return html`<div class="pane"><p>No rules.</p></div>`;
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
            …with ${overridden.size} setting${overridden.size === 1 ? '' : 's'} changed for this event. Those rows are marked.
          </p>` : ''}
        ${ruleset.provisional ? html`
          <div class="banner banner-warn" style="margin-top:12px">${raw(icon('alert'))}
            <div class="body-small">
              <b>Provisional.</b> ${game.short} has no ratified competitive ruleset yet —
              this is what your organiser is running, not what the scene has agreed.
            </div>
          </div>` : ''}
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
   Actions
   -------------------------------------------------------------------------- */

const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

on('self-checkin', ({ entry: entryId }) => {
  const entry = store.get().entries[entryId];
  const event = store.getEvent(entry.eventId);
  const required = (event.documents || []).filter((d) => d.required);
  const signed = new Set(entry.signedDocuments || []);
  const unsigned = required.filter((d) => !signed.has(d.id));

  if (unsigned.length) {
    snack(`Sign ${unsigned[0].title} first.`);
    return;
  }
  store.apply('entries', entryId, { checkedInAt: new Date().toISOString() });
  snack('Checked in');
  rerender();
});

/* Signing. Deliberately a real acceptance -- the person's name typed, the
   document version, and a timestamp -- rather than a checkbox, because the
   whole reason to record it is to be able to say later WHAT was agreed and
   WHEN. A checkbox against an unversioned document proves nothing. */
on('sign-doc', ({ entry: entryId, doc: docId }) => {
  const entry = store.get().entries[entryId];
  const event = store.getEvent(entry.eventId);
  const doc = (event.documents || []).find((d) => d.id === docId);
  const me = auth.currentPlayer();
  const game = gameById(event.gameId);
  const ruleset = game ? resolveRuleset(game, event.presetId, event.overrides || {}) : null;

  /* The code of conduct lives in the ruleset, so it is versioned with it. */
  const text = docId === 'doc_coc'
    ? (ruleset?.values?.codeOfConduct
      || 'The organiser has not written a code of conduct for this event. Sign only if you are happy to be bound by whatever they tell you on the day.')
    : `${doc?.title}. The organiser has not attached text to this document yet.`;

  dialog({
    title: doc?.title || 'Document',
    body: html`
      <div class="card card-filled body-medium" style="max-height:40dvh;overflow:auto;white-space:pre-wrap">${text}</div>
      <label class="field" style="margin-top:16px">
        <span class="field-label">Type your name to agree</span>
        <input type="text" id="signature" placeholder="${me?.tag || ''}">
      </label>
      <p class="field-help">
        Recorded with the time and the document version (v${doc?.version ?? 1}).
        If you are under 18 this is not a valid waiver on its own — talk to the organiser.
      </p>`,
    actions: [
      { label: 'Cancel', kind: 'text' },
      { label: 'Agree and sign', kind: 'filled', onClick: (dlg) => {
        const name = dlg.querySelector('#signature').value.trim();
        if (!name) return false;
        const sigId = store.uid('sig');
        store.apply('signatures', sigId, {
          id: sigId, entryId, eventId: entry.eventId, playerId: entry.playerId,
          documentId: docId, documentVersion: doc?.version ?? 1,
          typedName: name, signedAt: new Date().toISOString(),
        });
        store.apply('entries', entryId, {
          signedDocuments: [...new Set([...(entry.signedDocuments || []), docId])],
        });
        snack('Signed');
        rerender();
      } },
    ],
  });
});
