/* Brackets · home
   ===========================================================================
   Three audiences on one route, because they arrive at the same URL:

     * a stranger following a link from Discord — gets the pitch, and a way
       into the event they were actually sent
     * a player — gets what they are entered in and what is next for them
     * an organiser — gets their events and a way to make another

   No separate marketing page. A landing page that a signed-in user never sees
   again is a page nobody maintains, and the pitch is more honest when it sits
   next to the working thing.
   =========================================================================== */

'use strict';

import { html, raw, list, icon, esc, avatar, formatDateTime, relativeTime, snack } from '../lib/ui.js';
import { on } from '../lib/ui.js';
import * as store from '../lib/store.js';
import * as auth from '../lib/auth.js';
import { gameById, GAMES } from '../data/games.js';
import { formatMoney } from '../lib/guidance.js';

const STATUS = {
  draft: { label: 'Draft', chip: '' },
  registration: { label: 'Registration open', chip: 'chip-info' },
  checkin: { label: 'Check-in', chip: 'chip-warn' },
  seeding: { label: 'Seeding', chip: 'chip-warn' },
  running: { label: 'Running now', chip: 'chip-ok' },
  complete: { label: 'Finished', chip: '' },
};

export function view(ctx) {
  const { me, params } = ctx;

  if (ctx.route === 'join') return joinView(ctx, params.code);

  return {
    title: 'Batty Brackets',
    subtitle: me ? `Signed in as ${me.tag}` : 'Tournaments for fighting games',
    body: me ? dashboard(ctx) : landing(ctx),
  };
}

/* --------------------------------------------------------------------------
   Signed out
   -------------------------------------------------------------------------- */

/* The publication identity belongs to BattyDev, not to whichever game is
   featured. Keep this page neutral; the game mark is a clearly labelled
   sidebar rather than a theme applied to the entire product. */
function landing(ctx) {
  const live = store.listEvents().filter((e) => ['registration', 'checkin', 'seeding', 'running'].includes(e.status));
  const demo = store.getEvent('evt_demo_tokon')?.demo;
  return html`
    <div class="pane publication">
      <header class="publication-masthead">
        <div class="publication-edition"><span>The fighting game local</span><span>Independent tools · By BattyDev</span></div>
        <h2 class="publication-wordmark">Batty Brackets<span>.</span></h2>
        <nav class="publication-nav" aria-label="Get started">
          <a href="#/new">Run a tournament ${raw(icon('plus'))}</a>
          <a href="#/join">Join with a code ${raw(icon('key'))}</a>
          <button data-act="sign-in">Sign in ${raw(icon('person'))}</button>
        </nav>
      </header>
      <section class="publication-lead" aria-labelledby="local-title">
        <div class="publication-story">
          <p class="publication-kicker">From the first check-in to grand finals</p>
          <h3 id="local-title">Good games.<br>Better locals.</h3>
          <p class="publication-deck">Tournament tools with a place in your scene.
            Clear seeding, quick results, and a screen the whole room can follow.</p>
          <div class="local-actions">
            <a class="btn btn-filled btn-lg" href="#/new">${raw(icon('plus'))} Set up an event</a>
            ${demo ? html`<button class="btn btn-outlined btn-lg" data-act="tour-start" data-tour="organiser">${raw(icon('play'))} Try the Tōkon demo</button>` : ''}
          </div>
          <p class="publication-note">${store.syncState().configured
            ? 'Explore the setup before signing in.'
            : 'Runs on this device. Online registration and sharing are not connected yet.'}</p>
        </div>
        <aside class="publication-feature" aria-labelledby="featured-game-title">
          <p class="publication-kicker">In the spotlight</p>
          <div class="publication-four" aria-hidden="true">04<span>Fighters.<br>One team.</span></div>
          <h3 id="featured-game-title">Marvel Tōkon:<br>Fighting Souls</h3>
          <dl class="publication-facts"><div><dt>Built for</dt><dd>Your local</dd></div>
            <div><dt>Rules</dt><dd>Organiser-reviewed presets</dd></div></dl>
          ${demo ? html`<button class="btn btn-text" data-act="tour-start" data-tour="tv">${raw(icon('station'))} See the venue display</button>` : ''}
          <p class="publication-note">Community tournament tools. Not an official game service.</p>
        </aside>
      </section>
      ${live.length ? html`<section class="publication-events">
        <div class="publication-section-heading"><h3>On the local circuit</h3><span>${store.syncState().configured ? 'Upcoming & running' : 'On this device'}</span></div>
        <div class="stack-sm">${list(live.slice(0, 5).map((e) => eventCard(e, ctx)))}</div>
      </section>` : ''}
      <section class="publication-tools" aria-label="Tournament tools">
        ${list([
          ['01', 'Keep the room moving', 'Check in arrivals, call sets to stations, and show who is up next on the venue TV.'],
          ['02', 'Make the seed make sense', 'Preview matchups and proposed teammate separation before committing the bracket.'],
          ['03', 'Keep a copy you control', 'Import your roster, preview edits, and download a backup before the first set.'],
        ].map(([number, title, body]) => html`<article><span class="publication-kicker">${number} / The toolkit</span><h3>${title}</h3><p>${body}</p></article>`))}
      </section>
      <div class="publication-start"><p>Make room for your next local.</p><button class="btn btn-outlined" data-act="go" data-path="/new">${raw(icon('plus'))} Set up an event</button></div>
      <footer class="publication-footer"><a href="../index.html">A project by BattyDev.</a><span>Built around the people on both sides of the setup.</span></footer>
    </div>`;
}

/* --------------------------------------------------------------------------
   Signed in
   -------------------------------------------------------------------------- */

function dashboard(ctx) {
  const { me } = ctx;
  const myEntries = Object.values(ctx.state.entries).filter((e) => e.playerId === me.id);
  const entered = new Set(myEntries.map((e) => e.eventId));

  /* Your own dashboard shows your unlisted events. Hiding an event from the
     person running it, or from somebody already entered in it, is not privacy
     -- it is just losing it. Everyone else sees only what is listed. */
  const mine = (e) => e.ownerId === me.id || e.orgId === me.defaultOrgId || entered.has(e.id);
  const events = store.listEvents({ all: true }).filter((e) => e.visibility !== 'unlisted' || mine(e));

  const running = events.filter((e) => ['checkin', 'seeding', 'running'].includes(e.status));
  const upcoming = events.filter((e) => e.status === 'registration' || e.status === 'draft');
  const past = events.filter((e) => e.status === 'complete');

  return html`
    <div class="pane">
      ${ctx.session?.needsPasswordFallback ? html`
        <div class="banner banner-warn" style="margin-bottom:16px">
          ${raw(icon('key'))}
          <div class="spacer">
            <b>Add a password to your account</b>
            <div class="body-small">You sign in with Discord only. If Discord is down you could not get into your own bracket. Same account, ten seconds.</div>
            <div class="row" style="margin-top:8px">
              <button class="btn btn-filled btn-sm" data-act="set-password">Set a password</button>
            </div>
          </div>
        </div>` : ''}

      ${running.length ? html`
        <section style="margin-bottom:24px">
          <h2 class="title-large" style="margin-bottom:12px">Live</h2>
          <div class="stack-sm">${list(running.map((e) => eventCard(e, ctx, entered.has(e.id))))}</div>
        </section>` : ''}

      <section style="margin-bottom:24px">
        <div class="row" style="margin-bottom:12px">
          <h2 class="title-large spacer">Upcoming</h2>
          <button class="btn btn-text btn-sm" data-act="go" data-path="/join">${raw(icon('key'))} Join with a code</button>
        </div>
        ${upcoming.length
          ? html`<div class="stack-sm">${list(upcoming.map((e) => eventCard(e, ctx, entered.has(e.id))))}</div>`
          : html`<div class="empty">${raw(icon('calendar'))}<p class="body-medium">Nothing coming up.</p></div>`}
      </section>

      ${past.length ? html`
        <section>
          <h2 class="title-large" style="margin-bottom:12px">Finished</h2>
          <div class="stack-sm">${list(past.slice(0, 6).map((e) => eventCard(e, ctx, entered.has(e.id))))}</div>
        </section>` : ''}
    </div>

    <button class="fab" data-act="go" data-path="/new">${raw(icon('plus'))} New event</button>`;
}

function eventCard(event, ctx, isEntered = false) {
  const game = gameById(event.gameId);
  const status = STATUS[event.status] || STATUS.draft;
  const entries = store.entriesFor(event.id);
  const org = store.getOrg(event.orgId);
  /* Anyone can open an event; only its organiser gets the admin route. In
     local-only mode there is no ownership to check, so whoever is holding the
     device is the organiser -- which is exactly right for a TO running a
     weekly off one phone. */
  const canAdmin = !ctx.session || !event.ownerId || event.ownerId === ctx.me?.id;

  return html`
    <a class="card card-outlined" href="#/e/${event.id}">
      <div class="row" style="gap:12px;flex-wrap:nowrap;align-items:flex-start">
        <span class="avatar game-mark" data-game="${event.gameId}">${game?.mark || '?'}</span>
        <div class="spacer" style="min-width:0">
          <div class="row-tight" style="gap:8px">
            <b class="title-medium">${event.name}</b>
            ${event.demo ? html`<span class="body-small dim">Demo</span>` : ''}
            <span class="chip chip-static chip-sm ${raw(status.chip)}" style="min-height:22px;padding:0 8px;font:var(--label-small)">${status.label}</span>
            ${isEntered ? html`<span class="chip chip-static chip-info" style="min-height:22px;padding:0 8px;font:var(--label-small)">Entered</span>` : ''}
          </div>
          <div class="body-small dim" style="margin-top:2px">
            ${game?.short || event.gameId} · ${entries.length} entrant${entries.length === 1 ? '' : 's'}
            ${event.entryFee ? ` · ${formatMoney(event.entryFee, event.currency)}` : ''}
            ${org ? ` · ${org.name}` : ''}
          </div>
          <div class="body-small dim">${formatDateTime(event.startsAt)} · ${relativeTime(event.startsAt)}</div>
        </div>
        ${canAdmin ? html`
          <button class="btn btn-icon" data-act="go" data-path="/e/${event.id}/admin" aria-label="Organiser tools for ${event.name}">
            ${raw(icon('settings'))}
          </button>` : ''}
      </div>
    </a>`;
}

/* --------------------------------------------------------------------------
   Join by code
   --------------------------------------------------------------------------
   A short code read out over a PA or written on a whiteboard is still the
   fastest way to get forty people into the right bracket. It beats a QR code
   (which needs a camera app and good light) and a link (which needs typing a
   URL). Both are supported; this is the one that always works.
   -------------------------------------------------------------------------- */

function joinView(ctx, code) {
  const event = code ? store.eventByInvite(code) : null;
  const game = event ? gameById(event.gameId) : null;
  const entries = event ? store.entriesFor(event.id) : [];
  const already = event && ctx.me ? store.entryFor(event.id, ctx.me.id) : null;
  const full = event?.capacity && entries.length >= event.capacity;

  return {
    title: 'Join an event',
    back: '/',
    body: html`
      <div class="pane" style="max-width:560px">
        <form class="stack" data-act-submit="join-lookup">
          <label class="field">
            <span class="field-label">Invite code</span>
            <input type="text" name="code" value="${code || ''}" autocapitalize="characters"
                   spellcheck="false" placeholder="TKN14B"
                   style="font-family:var(--font-mono);letter-spacing:.2em;text-transform:uppercase">
          </label>
          <button class="btn btn-filled btn-block" type="submit">Find it</button>
        </form>

        ${code && !event ? html`
          <div class="banner banner-error" style="margin-top:16px">${raw(icon('alert'))}
            <div>No event with the code <b>${code}</b>. Codes never use 0, O, 1 or I — check for a mistyped letter.</div>
          </div>` : ''}

        ${event ? html`
          <div class="card card-elevated" style="margin-top:20px">
            <div class="row" style="flex-wrap:nowrap;align-items:flex-start">
              <span class="avatar game-mark" data-game="${event.gameId}">${game?.mark}</span>
              <div class="spacer">
                <h2 class="title-large">${event.name}</h2>
                <div class="body-small dim">${game?.name} · ${formatDateTime(event.startsAt)}</div>
                ${event.venue ? html`<div class="body-small dim">${event.venue}</div>` : ''}
              </div>
            </div>

            <div class="row" style="margin-top:16px;gap:8px">
              <span class="chip chip-static chip-assist">${entries.length}${event.capacity ? `/${event.capacity}` : ''} entrants</span>
              ${event.entryFee ? html`<span class="chip chip-static chip-assist">${formatMoney(event.entryFee, event.currency)} entry</span>` : ''}
              <span class="chip chip-static ${raw((STATUS[event.status] || {}).chip || '')}">${(STATUS[event.status] || {}).label}</span>
            </div>

            ${already ? html`
              <div class="banner banner-info" style="margin-top:16px">${raw(icon('check'))}
                <div>You are already entered — seed ${already.seed ?? 'not set'}.</div>
              </div>
              <a class="btn btn-tonal btn-block" href="#/e/${event.id}" style="margin-top:12px">Open the event</a>`
            : full ? html`
              <div class="banner banner-warn" style="margin-top:16px">${raw(icon('alert'))}
                <div>This event is full at ${event.capacity}. Join anyway to go on the waitlist — organisers usually get a few drop-outs.</div>
              </div>
              <button class="btn btn-outlined btn-block" data-act="join-event" data-event="${event.id}" style="margin-top:12px">Join the waitlist</button>`
            : html`
              <button class="btn btn-filled btn-block" data-act="join-event" data-event="${event.id}" style="margin-top:16px">
                ${ctx.me ? 'Enter this event' : 'Sign in and enter'}
              </button>`}
          </div>` : ''}
      </div>`,
  };
}

/* --------------------------------------------------------------------------
   Actions
   -------------------------------------------------------------------------- */

on('join-lookup', (data, form) => {
  const code = new FormData(form).get('code');
  window.location.hash = `#/join/${String(code || '').trim().toUpperCase()}`;
});

on('join-event', async ({ event: eventId }) => {
  const { openSignIn } = await import('./auth.js');
  if (!auth.isSignedIn()) { openSignIn(() => window.dispatchEvent(new HashChangeEvent('hashchange'))); return; }

  const me = auth.currentPlayer();
  if (store.entryFor(eventId, me.id)) { snack('You are already entered.'); return; }

  const event = store.getEvent(eventId);
  const entries = store.entriesFor(eventId);
  const id = store.uid('ent');

  store.apply('entries', id, {
    id, eventId, playerId: me.id,
    /* Seeded last until the organiser seeds properly. Explicitly NOT random:
       a random seed looks like a real one and hides the fact that nobody has
       seeded yet, which is how the two best players meet in round one. */
    seed: entries.length + 1,
    group: me.homeVenue || null,
    registeredAt: new Date().toISOString(),
    source: 'self',
    signedDocuments: [],
    waitlisted: Boolean(event?.capacity && entries.length >= event.capacity),
  });

  snack(event?.capacity && entries.length >= event.capacity ? 'On the waitlist.' : `Entered ${event?.name || 'the event'}.`);
  window.location.hash = `#/e/${eventId}`;
});

on('set-password', async () => {
  const { openSetPassword } = await import('./auth.js');
  openSetPassword();
});
