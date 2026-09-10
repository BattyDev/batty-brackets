/* Brackets · the player passport
   ===========================================================================
   A profile that is not owned by any event.

   ## Why this is the interesting half of the product

   On every existing bracket site, a player is a row in a tournament. Their
   history is a list of tournaments they appear in, assembled by searching for
   their name. Change your tag and the trail breaks. Enter under a sponsor
   prefix one week and without it the next and you are two people.

   Here the PLAYER is the durable record and an entry is a join row that points
   at it. That inversion is what makes all of the following possible at all:

     * a head-to-head record against anyone you have ever played, across
       venues, across games, across years
     * one identity that runs events at your own store AND enters the one down
       the road, with no separate "organiser account"
     * a walk-up entrant a TO typed in at the door who can later claim that
       record rather than starting from zero
     * platform IDs entered once instead of once per event

   The thing that makes it real rather than a schema decision is that a result
   row stores PLAYER ids, not entry ids. Profile queries never join through a
   tournament, so they still work when the tournament is deleted, and they work
   offline against a partial cache. See lib/store.js.

   ## What is deliberately not here

   No rating. No leaderboard. A number next to someone's name changes how a
   scene behaves -- people dodge sets to protect it -- and a rating designed in
   an afternoon by someone who is not going to be at the venue when it goes
   wrong is not a good trade. Seeding uses sets won here, which is a number a
   TO can explain to the person who got the seed. That is the bar.
   =========================================================================== */

'use strict';

import {
  html, raw, list, icon, esc, on, snack, dialog, avatar,
  formatDateTime, relativeTime,
} from '../lib/ui.js';
import * as store from '../lib/store.js';
import * as auth from '../lib/auth.js';
import { CONNECTIONS, setConnection } from '../lib/auth.js';
import { gameById, GAMES } from '../data/games.js';

export function view(ctx) {
  const isMe = ctx.route === 'me';
  const playerId = isMe ? ctx.me?.id : ctx.params.playerId;
  const player = playerId ? store.getPlayer(playerId) : null;

  if (isMe && !player) return signedOut();
  if (!player) {
    return {
      title: 'Player', back: '/',
      body: html`<div class="pane"><div class="empty">${raw(icon('person'))}
        <p>No player with that id on this device.</p></div></div>`,
    };
  }

  /* A tombstoned placeholder that has been claimed points at the real profile.
     Redirecting rather than 404-ing keeps every bracket link ever shared in a
     Discord working after someone claims their entry. */
  if (player.mergedInto) {
    const real = store.getPlayer(player.mergedInto);
    if (real) {
      return {
        title: real.tag, back: '/',
        body: html`<div class="pane"><div class="banner banner-info">${raw(icon('info'))}
          <div>This entry was claimed. <a href="#/p/${real.id}">Open ${real.tag}'s profile</a>.</div></div></div>`,
      };
    }
  }

  return {
    title: player.tag,
    subtitle: isMe ? 'Your passport' : (player.homeVenue || 'Player'),
    back: '/',
    body: profile(player, ctx, isMe),
  };
}

function signedOut() {
  return {
    title: 'Profile', back: '/',
    body: html`
      <div class="pane">
        <div class="empty">
          ${raw(icon('person'))}
          <p class="body-large">Sign in to see your record.</p>
          <p class="body-medium">Every set you play at any event on this site lands on one profile.</p>
          <button class="btn btn-filled" data-act="sign-in">Sign in</button>
        </div>
      </div>`,
  };
}

/* --------------------------------------------------------------------------
   Profile
   -------------------------------------------------------------------------- */

function profile(player, ctx, isMe) {
  const history = store.historyFor(player.id);
  const wins = history.filter((r) => r.winnerPlayerId === player.id).length;
  const losses = history.length - wins;
  const rate = history.length ? Math.round((wins / history.length) * 100) : 0;

  const entries = Object.values(ctx.state.entries).filter((e) => e.playerId === player.id);
  const upcoming = entries
    .map((e) => ({ entry: e, event: store.getEvent(e.eventId) }))
    .filter((x) => x.event && x.event.status !== 'complete')
    .sort((a, b) => (a.event.startsAt || '').localeCompare(b.event.startsAt || ''));

  /* Everyone this player has faced, best-record-first. The "rivals" list is
     the thing players actually open a profile for. */
  const rivals = buildRivals(player.id, history);

  return html`
    <div class="pane" style="max-width:900px">
      <header class="card card-elevated" style="margin-bottom:16px">
        <div class="row" style="flex-wrap:nowrap;align-items:flex-start">
          ${raw(avatar(player, 'avatar-lg'))}
          <div class="spacer" style="min-width:0">
            <h2 class="headline-small">${player.tag}</h2>
            <div class="body-medium dim">
              ${[player.pronouns, player.homeVenue, player.region].filter(Boolean).join(' · ') || 'No details yet'}
            </div>
            ${player.claimable ? html`
              <div class="chip chip-static chip-warn" style="margin-top:8px">
                ${raw(icon('key', 'icon-sm'))} Unclaimed — added by an organiser
              </div>` : ''}
          </div>
          ${isMe ? html`<button class="btn btn-icon" data-act="profile-edit" aria-label="Edit profile">${raw(icon('edit'))}</button>` : ''}
        </div>

        <div class="row" style="margin-top:16px;gap:8px">
          <span class="chip chip-static chip-assist"><b>${wins}</b>&nbsp;won</span>
          <span class="chip chip-static chip-assist"><b>${losses}</b>&nbsp;lost</span>
          ${history.length ? html`<span class="chip chip-static chip-assist"><b>${rate}%</b></span>` : ''}
          <span class="chip chip-static chip-assist">${new Set(history.map((r) => r.eventId)).size} events</span>
        </div>

        ${isMe && ctx.session?.needsPasswordFallback ? html`
          <div class="banner banner-warn" style="margin-top:16px">
            ${raw(icon('key'))}
            <div class="spacer">
              <b>No password on this account</b>
              <div class="body-small">Discord is your only way in. If it is down at the venue, so are you.</div>
              <button class="btn btn-filled btn-sm" data-act="set-password" style="margin-top:8px">Set one</button>
            </div>
          </div>` : ''}
      </header>

      ${player.mains && Object.keys(player.mains).length ? html`
        <section class="card card-outlined" style="margin-bottom:16px">
          <b class="title-medium">Plays</b>
          <div class="stack-sm" style="margin-top:8px">
            ${list(Object.entries(player.mains).map(([gameId, chars]) => html`
              <div class="row-tight">
                <span class="chip chip-static chip-assist">${gameById(gameId)?.short || gameId}</span>
                <span class="body-medium">${chars.join(', ')}</span>
              </div>`))}
          </div>
        </section>` : ''}

      ${upcoming.length ? html`
        <section style="margin-bottom:16px">
          <h2 class="title-large" style="margin-bottom:8px">${isMe ? 'You are entered in' : 'Entered in'}</h2>
          <div class="stack-sm">
            ${list(upcoming.map(({ entry, event }) => html`
              <a class="card card-outlined row" href="#/e/${event.id}" style="flex-wrap:nowrap">
                <div class="spacer">
                  <b class="title-small">${event.name}</b>
                  <div class="body-small dim">${formatDateTime(event.startsAt)} · seed ${entry.seed ?? '—'}
                    ${entry.checkedInAt ? ' · checked in' : ''}</div>
                </div>
                ${raw(icon('chevron'))}
              </a>`))}
          </div>
        </section>` : ''}

      ${isMe ? raw(connectionsSection(player)) : ''}

      ${rivals.length ? html`
        <section style="margin-bottom:16px">
          <h2 class="title-large" style="margin-bottom:4px">Head to head</h2>
          <p class="body-small dim" style="margin-bottom:12px">
            Everyone ${isMe ? 'you have' : `${player.tag} has`} played, at any event on this site.
          </p>
          <div class="stack-sm">
            ${list(rivals.slice(0, 12).map((r) => html`
              <a class="card card-outlined row" href="#/p/${r.id}" style="flex-wrap:nowrap;gap:12px">
                ${raw(avatar(r.player, 'avatar-sm'))}
                <span class="spacer"><b class="body-large">${r.player?.tag || 'Unknown'}</b></span>
                <span class="title-medium" style="font-variant-numeric:tabular-nums">
                  <span style="color:${raw(r.wins >= r.losses ? 'var(--ok)' : 'var(--md-on-surface-variant)')}">${r.wins}</span>
                  <span class="dim">–</span>
                  <span style="color:${raw(r.losses > r.wins ? 'var(--md-error)' : 'var(--md-on-surface-variant)')}">${r.losses}</span>
                </span>
              </a>`))}
          </div>
        </section>` : ''}

      <section>
        <h2 class="title-large" style="margin-bottom:12px">Recent sets</h2>
        ${history.length ? html`
          <div class="stack-sm">
            ${list(history.slice(0, 25).map((result) => {
              const won = result.winnerPlayerId === player.id;
              const opponentId = won ? result.loserPlayerId : result.winnerPlayerId;
              const opponent = store.getPlayer(opponentId);
              const event = store.getEvent(result.eventId);
              return html`
                <div class="card card-outlined row" style="flex-wrap:nowrap;gap:12px">
                  <span class="chip chip-static ${raw(won ? 'chip-ok' : 'chip-error')}"
                        style="min-width:32px;justify-content:center">${won ? 'W' : 'L'}</span>
                  <div class="spacer" style="min-width:0">
                    <div class="body-large">
                      <a href="#/p/${opponentId}">${opponent?.tag || 'Unknown'}</a>
                      <span class="dim"> · ${result.scoreWinner}–${result.scoreLoser}</span>
                      ${result.byDq ? html`<span class="dim"> (DQ)</span>` : ''}
                    </div>
                    <div class="body-small dim">
                      ${event?.name || 'Event'} · ${result.roundName || ''} · ${relativeTime(result.reportedAt)}
                    </div>
                  </div>
                </div>`;
            }))}
          </div>`
        : html`<div class="empty">${raw(icon('trophy'))}
            <p class="body-medium">No sets yet.</p>
            ${isMe ? html`<p class="body-small">Played elsewhere? Connect start.gg to bring your record with you — see the README for where that stands.</p>` : ''}
          </div>`}
      </section>
    </div>`;
}

function buildRivals(playerId, history) {
  const map = new Map();
  for (const result of history) {
    const won = result.winnerPlayerId === playerId;
    const opponentId = won ? result.loserPlayerId : result.winnerPlayerId;
    if (!opponentId) continue;
    const row = map.get(opponentId) || { id: opponentId, wins: 0, losses: 0, player: store.getPlayer(opponentId) };
    if (won) row.wins += 1; else row.losses += 1;
    map.set(opponentId, row);
  }
  return [...map.values()].sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses));
}

/* --------------------------------------------------------------------------
   Connected accounts
   -------------------------------------------------------------------------- */

function connectionsSection(player) {
  const connections = player.connections || {};
  const groups = [
    ['platform', 'Platform IDs', 'How an opponent finds you for an online set. Enter them once here rather than once per event.'],
    ['import', 'Bring your history', 'The only reason a new bracket site is worth switching to is if your record comes with you.'],
    ['media', 'VODs', 'Sets you played on a linked stream get attached to your profile.'],
    ['social', 'Social', 'Shown on your profile so people can find you.'],
  ];

  return html`
    <section class="card card-outlined" style="margin-bottom:16px">
      <b class="title-medium">Connected accounts</b>
      ${list(groups.map(([kind, title, blurb]) => html`
        <div style="margin-top:16px">
          <div class="label-large">${title}</div>
          <p class="body-small dim" style="margin:2px 0 8px">${blurb}</p>
          <div class="stack-sm">
            ${list(CONNECTIONS.filter((c) => c.kind === kind).map((c) => html`
              <div class="row" style="flex-wrap:nowrap;gap:8px">
                <span class="body-medium" style="flex:0 0 130px">${c.label}</span>
                <input type="text" class="spacer" value="${connections[c.id] || ''}"
                       placeholder="${c.id === 'startgg' ? 'not wired up yet' : 'not set'}"
                       ${raw(c.id === 'startgg' ? 'disabled' : '')}
                       data-act-change="set-connection" data-connection="${c.id}"
                       style="min-width:120px;padding:8px;border:1px solid var(--md-outline-variant);border-radius:var(--shape-xs);background:transparent;color:inherit;font:var(--body-medium)">
              </div>`))}
          </div>
        </div>`))}
      <p class="field-help" style="padding-left:0;margin-top:12px">
        ${raw(icon('info', 'icon-sm'))}
        start.gg import is listed because it is the single biggest reason someone would or would not
        switch — and it is not built. Saying so beats a button that does nothing.
      </p>
    </section>`;
}

/* --------------------------------------------------------------------------
   Actions
   -------------------------------------------------------------------------- */

const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

on('set-connection', ({ connection }, el) => {
  const me = auth.currentPlayer();
  if (!me) return;
  setConnection(me.id, connection, el.value.trim());
});

on('profile-edit', () => {
  const me = auth.currentPlayer();
  if (!me) return;

  dialog({
    title: 'Edit your passport',
    body: html`
      <div class="stack">
        <label class="field"><span class="field-label">Tag</span>
          <input type="text" id="tag" value="${me.tag || ''}"></label>
        <label class="field"><span class="field-label">Pronouns</span>
          <input type="text" id="pronouns" value="${me.pronouns || ''}" placeholder="they/them"></label>
        <label class="field"><span class="field-label">Home venue</span>
          <input type="text" id="homeVenue" value="${me.homeVenue || ''}" placeholder="Batty Mac Arcade"></label>
        <p class="field-help" style="padding-left:0;margin-top:-8px">
          Used by seeding to keep people from the same venue apart in the early rounds.
        </p>
        <label class="field"><span class="field-label">Region</span>
          <input type="text" id="region" value="${me.region || ''}" placeholder="NA East"></label>
        ${list(GAMES.map((game) => html`
          <label class="field"><span class="field-label">${game.short} mains</span>
            <input type="text" data-mains="${game.id}" value="${(me.mains?.[game.id] || []).join(', ')}"
                   placeholder="Comma separated"></label>`))}
      </div>
      <div class="banner" style="margin-top:16px">
        ${raw(icon('eye'))}
        <div class="body-small">
          Your tag, results and head-to-head records are public — that is what makes a scene's record
          useful. Your email is never shown. There is no per-field privacy control yet, and for some
          people that matters; it is on the list in the README.
        </div>
      </div>`,
    actions: [
      { label: 'Cancel', kind: 'text' },
      { label: 'Save', kind: 'filled', onClick: (dlg) => {
        const mains = {};
        for (const input of dlg.querySelectorAll('[data-mains]')) {
          const chars = input.value.split(',').map((s) => s.trim()).filter(Boolean);
          if (chars.length) mains[input.dataset.mains] = chars;
        }
        store.apply('players', me.id, {
          tag: dlg.querySelector('#tag').value.trim() || me.tag,
          pronouns: dlg.querySelector('#pronouns').value.trim() || null,
          homeVenue: dlg.querySelector('#homeVenue').value.trim() || null,
          region: dlg.querySelector('#region').value.trim() || null,
          mains,
        });
        snack('Saved');
        rerender();
      } },
    ],
  });
});
