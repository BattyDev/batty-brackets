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
import { gameMark } from '../data/themes.js';
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
    title: 'Brackets',
    subtitle: me ? `Signed in as ${me.tag}` : 'Tournaments for fighting games',
    body: me ? dashboard(ctx) : landing(ctx),
  };
}

/* --------------------------------------------------------------------------
   Signed out
   -------------------------------------------------------------------------- */

function landing(ctx) {
  const live = store.listEvents().filter((e) => ['registration', 'checkin', 'seeding', 'running'].includes(e.status));

  return html`
    <div class="pane">
      <section style="padding:24px 0 32px">
        <p class="label-large" style="color:var(--md-primary);margin:0 0 8px">BattyDev</p>
        <h2 class="display-medium" style="margin-bottom:16px">Brackets that work<br>at the venue.</h2>
        <p class="body-large dim" style="max-width:56ch">
          Built for locals: the whole event lives on your phone, so reporting a set
          does not wait on the wifi. Bulk import and edit anything. Seeding you can
          see before you commit to it. And when eight people do not show, the app
          tells you what your options are.
        </p>
        <div class="row" style="margin-top:24px">
          <button class="btn btn-filled btn-lg" data-act="sign-in">${raw(icon('discord'))} Sign in with Discord</button>
          <button class="btn btn-outlined btn-lg" data-act="go" data-path="/join">${raw(icon('key'))} Join with a code</button>
        </div>
        <p class="body-small dim" style="margin-top:12px">
          Email and password works too — and is worth adding either way, so a Discord outage never locks you out of your own event.
        </p>
      </section>

      <section style="margin-bottom:32px">
        <h2 class="title-large" style="margin-bottom:12px">What is different</h2>
        <div class="grid-cards">
          ${list([
            ['station', 'It runs offline', 'Every screen is drawn from data already on your device. Report a set with no signal; it syncs when there is some. The chip in the corner always says how many writes are waiting.'],
            ['upload', 'Import, then re-import', 'Paste a spreadsheet — any columns, any size, no 50-row cap. Re-paste it after you fix a name and it updates those rows instead of making duplicates. Preview the diff before anything is written, and undo it after.'],
            ['sort', 'Seeding you can check', 'See who meets whom in every round before you commit. Keep teammates apart automatically, and read exactly which swaps it made and why.'],
            ['sparkle', 'It tells you what to do next', 'Eight no-shows at check-in? It works out what re-seeding would change and offers both options. DQ timers run themselves. Idle stations get noticed.'],
            ['person', 'Your record follows you', 'One profile across every event and every venue. Head-to-head against anyone you have played. Run events at your store and enter the one down the road on the same account.'],
            ['esports', 'It knows the game', 'Marvel Tokon knows what a 4v4 tag team is — whether the loser may reorder, whether simplified controls are legal. Not a generic bracket with the words swapped.'],
          ].map(([ic, title, body]) => html`
            <div class="card card-outlined">
              <div class="row-tight" style="color:var(--md-primary);margin-bottom:8px">
                ${raw(icon(ic))}<b class="title-medium">${title}</b>
              </div>
              <p class="body-medium dim" style="margin:0">${body}</p>
            </div>`))}
        </div>
      </section>

      ${live.length ? html`
        <section>
          <h2 class="title-large" style="margin-bottom:12px">Happening now</h2>
          <div class="stack-sm">${list(live.slice(0, 5).map((e) => eventCard(e, ctx)))}</div>
        </section>` : ''}

      <section style="margin-top:32px">
        <div class="card card-filled">
          <h3 class="title-medium" style="margin-bottom:8px">Running something?</h3>
          <p class="body-medium dim">You do not need an account to try it. Everything below works on this device alone — sign in when you want it to sync or to let players see it.</p>
          <button class="btn btn-tonal" data-act="go" data-path="/new" style="margin-top:8px">${raw(icon('plus'))} Set up an event</button>
        </div>
      </section>
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
