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
import { brandMark } from '../lib/brand.js';
import { gameMark } from '../data/themes.js';

const STATUS = {
  draft: { label: 'Draft', chip: '' },
  registration: { label: 'Registration open', chip: 'chip-info' },
  checkin: { label: 'Check-in', chip: 'chip-warn' },
  seeding: { label: 'Seeding', chip: 'chip-warn' },
  running: { label: 'Running now', chip: 'chip-ok' },
  complete: { label: 'Finished', chip: '' },
};

const ROLE_PREFERENCE_KEY = 'battydev.brackets.experience';
const GUEST_TAG_MAX = 32;

let codeLookup = { code: null, status: 'idle', error: null };
const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

function rememberPlayerExperience() {
  try { localStorage.setItem(ROLE_PREFERENCE_KEY, 'player'); } catch { /* private mode */ }
}

async function temporarySession(tag) {
  if (typeof auth.createTemporaryPlayer === 'function') return auth.createTemporaryPlayer({ tag });
  const session = auth.signInLocal({ tag, via: 'guest' });
  if (session) { session.temporary = true; store.setSession(session); }
  return session;
}

const shownGuestOffers = new Set();
async function offerGuestUpgrade(event) {
  const me = auth.currentPlayer();
  if (!me || !auth.currentSession()?.temporary) return;
  const key = `${event.id}:${me.id}`;
  if (shownGuestOffers.has(key)) return;
  shownGuestOffers.add(key);
  const { dialog } = await import('../lib/ui.js');
  const { openGuestUpgrade } = await import('./auth.js');
  dialog({
    title: 'You’re in — save your record',
    body: html`<p class="body-large">You joined <b>${event.name}</b> as <b>${me.tag}</b>.</p>
      <p class="body-medium">Create an account later to keep this fight record on another phone and customise your player profile. You can keep playing as a guest for now.</p>
      ${!auth.isRemote() ? html`<p class="body-small dim">This guest profile is saved on this device until you choose to upgrade it.</p>` : ''}`,
    actions: [
      { label: 'Maybe later', kind: 'text' },
      { label: 'Customize profile', kind: 'tonal', onClick: () => { window.location.hash = '#/me'; } },
      { label: 'Create account', kind: 'filled', onClick: () => openGuestUpgrade(() => rerender()) },
    ],
  });
}

function ensureRemoteLookup(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized || !auth.isRemote() || !auth.isSignedIn()) return;
  if (codeLookup.code === normalized && ['loading', 'done'].includes(codeLookup.status)) return;
  codeLookup = { code: normalized, status: 'loading', error: null };
  Promise.resolve().then(async () => {
    try {
      await store.redeemRemoteCode(normalized);
      codeLookup = { code: normalized, status: 'done', error: null };
    } catch (err) {
      codeLookup = { code: normalized, status: 'error', error: String(err?.message || err) };
    }
    rerender();
  });
}

export function view(ctx) {
  const { me, params } = ctx;

  if (ctx.route === 'join') return joinView(ctx, params.code);
  if (ctx.route === 'host') return { title: 'Host workspace', subtitle: 'Your events. Your room.', body: hostHome(ctx) };

  if (ctx.route === 'home' && ctx.compact && !me && !ctx.rolePreference) {
    return { title: 'Choose your experience', subtitle: 'Batty Brackets', body: roleChoice() };
  }

  return {
    title: 'Batty Brackets',
    subtitle: me ? `Signed in as ${me.tag}` : 'Tournaments for fighting games',
    body: me ? dashboard(ctx) : landing(ctx),
  };
}

function roleChoice() {
  return html`<div class="pane role-choice" aria-labelledby="role-choice-heading">
    <section class="role-choice-card card card-elevated">
      <p class="eyebrow">WELCOME TO BATTY BRACKETS</p><h1 id="role-choice-heading" class="headline-large">I'm a…</h1>
      <p class="body-large role-choice-intro">Start with the view that fits tonight. You can switch any time — this remembers your preferred layout, never what you’re allowed to do.</p>
      <div class="role-choice-options">
        <button class="role-choice-option role-choice-player" type="button" data-act="choose-role" data-role="player"><span class="role-choice-icon">${raw(icon('esports'))}</span><span class="role-choice-copy"><b>Player</b><span>Join a tournament, check in, and find your next set.</span></span><span class="role-choice-arrow">${raw(icon('chevron'))}</span></button>
        <button class="role-choice-option role-choice-host" type="button" data-act="choose-role" data-role="host"><span class="role-choice-icon">${raw(icon('tune'))}</span><span class="role-choice-copy"><b>Host</b><span>Run your bracket, manage arrivals, and keep the room moving.</span></span><span class="role-choice-arrow">${raw(icon('chevron'))}</span></button>
      </div>
      <p class="role-choice-footnote">Have a tournament code? <a href="#/join">Join directly</a> — you won’t need to choose a role first.</p>
    </section></div>`;
}

/* --------------------------------------------------------------------------
   Signed out
   -------------------------------------------------------------------------- */

/* A first visit starts with the actual event list. The two doors explain the
   task before sign-in, and demo actions borrow the existing real walkthroughs. */
function landing(ctx) {
  const live = store.listEvents().filter(e => ['registration', 'checkin', 'seeding', 'running'].includes(e.status));
  const demo = store.getEvent('evt_demo_tokon')?.demo;
  return html`
    <div class="pane lobby publication">
      <header class="lobby-heading">
        <div><p class="eyebrow publication-edition">LOCAL SCENE. BIG SETS. · By BattyDev</p>
          <h1 class="publication-wordmark">${raw(brandMark())}Batty Brackets<span>.</span></h1>
          <p class="lobby-deck">Find your local. Get your games in.</p></div>
        <a class="btn btn-filled" href="#/join">${raw(icon('key'))} Join with a code</a>
      </header>
      <div class="lobby-grid">
        <section class="event-directory" aria-labelledby="events-heading">
          <div class="section-heading"><div><p class="eyebrow">THE LINEUP</p><h2 id="events-heading">On the card</h2></div>
            <span class="chip chip-static">${live.length} active</span></div>
          <div class="stack">${live.length ? list(live.map(e => eventCard(e, ctx))) : html`<div class="empty"><p>No active events on this device.</p><a class="btn btn-tonal" href="#/join">Find an event by code</a></div>`}</div>
          <p class="local-device-note">${store.syncState().configured ? 'Browse events or enter the code from your host.' : 'These events are saved on this device. Online registration and sharing are not connected yet.'}</p>
        </section>
        <aside class="lobby-aside">
          <section class="player-door">
            <span class="door-icon">${raw(icon('esports'))}</span>
            <p class="eyebrow">FOR PLAYERS</p>
            <h3>Your next challenger awaits.</h3><p>Check in, find your opponent, and know which station to head to.</p>
            ${demo ? html`<button class="btn btn-filled btn-block" data-act="tour-start" data-tour="player">${raw(icon('play'))} Take the player seat</button>` : html`<a class="btn btn-filled" href="#/me">Open my profile</a>`}
          </section>
          <section class="host-door publication-story">
            <span class="door-icon host-door-icon">${raw(icon('tune'))}</span>
            <p class="eyebrow">FOR HOSTS</p><h3>You run the room.</h3>
            <p>Your roster, seeding, stations, and results in one workspace.</p>
            <a class="btn btn-outlined btn-block" href="#/host">Open host workspace ${raw(icon('chevron'))}</a>
            <a class="btn btn-text btn-block" href="#/new">Create an event</a>
          </section>
        </aside>
      </div>
      <footer class="lobby-footer"><span>Good games. Same time next week. · By BattyDev.</span>${demo ? html`<button class="btn btn-text" data-act="tour-start" data-tour="tv">${raw(icon('station'))} Try the venue display</button>` : ''}</footer>
    </div>`;
}

function hostHome(ctx) {
  // Match existing local ownership semantics; a mode switch does not grant
  // connected users access to somebody else's event or expose unlisted rows.
  const events = store.listEvents({ all: true }).filter((e) => {
    if (!ctx.session) return true;
    const org = store.getOrg(e.orgId);
    return e.ownerId ? e.ownerId === ctx.me?.id : org?.ownerId === ctx.me?.id;
  });
  const active = events.filter(e => e.status !== 'complete');
  const past = events.filter(e => e.status === 'complete');
  const demo = store.getEvent('evt_demo_tokon')?.demo;
  return html`<div class="pane host-home">
    <header class="workspace-heading"><div><p class="eyebrow">HOST WORKSPACE</p><h2>Put on a good local.</h2><p>Pick an event to manage arrivals, seed the bracket, and run the room.</p></div>
      <a class="btn btn-filled" href="#/new">${raw(icon('plus'))} Create event</a></header>
    <div class="host-summary"><div><b>${active.length}</b><span>Active events</span></div><div><b>${active.reduce((n,e) => n + store.entriesFor(e.id).length, 0)}</b><span>Registered entries</span></div><div><b>${past.length}</b><span>Completed events</span></div></div>
    <div class="section-heading"><h3>Your events</h3>${demo ? html`<button class="btn btn-text" data-act="tour-start" data-tour="organiser">${raw(icon('play'))} Walk through hosting</button>` : ''}</div>
    <div class="stack">${active.length ? list(active.map(e => eventCard(e, ctx))) : html`<div class="empty"><p>Your next local starts here.</p><a class="btn btn-tonal" href="#/new">Create your first event</a></div>`}</div>
    ${past.length ? html`<details class="past-events"><summary>Completed events (${past.length})</summary><div class="stack">${list(past.map(e => eventCard(e, ctx)))}</div></details>` : ''}
    <div class="workspace-help"><div>${raw(icon('station'))}<b>Taking it to the venue?</b><p>Open an event for station controls and its venue display.</p></div><div>${raw(icon('undo'))}<b>Keep your night backed up.</b><p>Download a device backup before play starts.</p><a href="#/recovery">Backup and recovery</a></div></div>
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

  const yours = events.filter(e => entered.has(e.id) && e.status !== 'complete');
  const running = events.filter((e) => ['checkin', 'seeding', 'running'].includes(e.status));
  const upcoming = events.filter((e) => e.status === 'registration' || e.status === 'draft');
  const past = events.filter((e) => e.status === 'complete');

  return html`
    <div class="pane player-dashboard">
      <header class="workspace-heading"><div><p class="eyebrow">PLAYER LOUNGE</p><h2>Ready, ${me.tag}?</h2><p>Your events, your next set, your results.</p></div><a class="btn btn-filled" href="#/join">Join with a code</a></header>
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

      ${yours.length ? html`<section class="your-events"><h2 class="title-large">Your next events</h2><div class="stack">${list(yours.map(e => eventCard(e, ctx, true)))}</div></section>` : ''}
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
`;
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
  const canAdmin = !ctx.session || (event.ownerId
    ? event.ownerId === ctx.me?.id
    : org?.ownerId === ctx.me?.id);

  return html`
    <article class="card card-outlined event-card">
      <a class="event-card-main" href="#/e/${event.id}${ctx.route === 'host' && canAdmin ? '/admin' : ''}">
      <div class="row" style="gap:12px;flex-wrap:nowrap;align-items:flex-start">
        ${raw(gameMark(game))}
        <div class="spacer" style="min-width:0">
          <div class="row-tight" style="gap:8px">
            <b class="title-medium">${event.name}</b>
            ${event.demo ? html`<span class="body-small dim">Demo</span>` : ''}
            <span class="chip chip-static chip-sm ${raw(status.chip)}" style="min-height:22px;padding:0 8px;font:var(--label-small)">${status.label}</span>
            ${isEntered ? html`<span class="chip chip-static chip-info" style="min-height:22px;padding:0 8px;font:var(--label-small)">Entered</span>` : ''}
          </div>
          ${org ? html`<p class="event-attribution">Organized by ${org.name}</p>` : ''}
          <div class="body-small dim" style="margin-top:2px">
            ${game?.short || event.gameId} · ${entries.length} entrant${entries.length === 1 ? '' : 's'}
            ${event.entryFee ? ` · ${formatMoney(event.entryFee, event.currency)}` : ''}
          </div>
          <div class="body-small dim">${formatDateTime(event.startsAt)} · ${relativeTime(event.startsAt)}</div>
        </div>
        ${raw(icon('chevron'))}
      </div></a>
      <div class="event-card-footer"><span>${event.venue || 'Venue to be announced'}</span>
        <a href="#/e/${event.id}${ctx.route === 'host' && canAdmin ? '/admin' : ''}">${ctx.route === 'host' && canAdmin ? 'Manage event' : 'View event'} ${raw(icon('chevron', 'icon-sm'))}</a>
      </div>
    </article>`;
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
  const normalizedCode = String(code || '').trim().toUpperCase();
  const event = code ? store.eventByInvite(code) : null;
  if (!event) ensureRemoteLookup(normalizedCode);
  const game = event ? gameById(event.gameId) : null;
  const org = event ? store.getOrg(event.orgId) : null;
  const entries = event ? store.entriesFor(event.id) : [];
  const already = event && ctx.me ? store.entryFor(event.id, ctx.me.id) : null;
  const admitted = entries.filter((entry) => !entry.waitlisted).length;
  const full = event?.capacity && admitted >= event.capacity;

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

        ${normalizedCode && !event && auth.isRemote() && !auth.isSignedIn() ? html`
          <div class="banner banner-info" style="margin-top:16px">${raw(icon('person'))}
            <div><b>Sign in to use this invitation.</b><p class="body-small" style="margin:4px 0 0">Your code stays in the address while you sign in.</p>
              <button class="btn btn-filled btn-sm" data-act="sign-in" style="margin-top:10px">Sign in</button></div>
          </div>` : ''}
        ${normalizedCode && !event && auth.isRemote() && auth.isSignedIn() && codeLookup.code === normalizedCode && codeLookup.status === 'loading' ? html`
          <div class="banner banner-info" style="margin-top:16px">${raw(icon('clock'))}<div>Finding your event…</div></div>` : ''}
        ${normalizedCode && !event && (!auth.isRemote() || (codeLookup.code === normalizedCode && codeLookup.status === 'error')) ? html`
          <div class="banner banner-error" style="margin-top:16px">${raw(icon('alert'))}
            <div>${auth.isRemote() ? codeLookup.error : `No event with the code <b>${normalizedCode}</b>. Codes never use 0, O, 1 or I — check for a mistyped letter.`}</div>
          </div>` : ''}

        ${event ? html`
          <div class="card card-elevated" style="margin-top:20px">
            <div class="row" style="flex-wrap:nowrap;align-items:flex-start">
              ${raw(gameMark(game))}
              <div class="spacer">
                <h2 class="title-large">${event.name}</h2>
                ${org ? html`<p class="event-attribution">Organized by ${org.name}</p>` : ''}
                <div class="body-small dim">${game?.name} · ${formatDateTime(event.startsAt)}</div>
                ${event.venue ? html`<div class="body-small dim">${event.venue}</div>` : ''}
              </div>
            </div>

            <div class="row" style="margin-top:16px;gap:8px">
              <span class="chip chip-static chip-assist">${admitted}${event.capacity ? `/${event.capacity}` : ''} admitted</span>
              ${event.entryFee ? html`<span class="chip chip-static chip-assist">${formatMoney(event.entryFee, event.currency)} entry</span>` : ''}
              <span class="chip chip-static ${raw((STATUS[event.status] || {}).chip || '')}">${(STATUS[event.status] || {}).label}</span>
            </div>

            ${already ? html`
              <div class="banner banner-info" style="margin-top:16px">${raw(icon('check'))}
                <div>You are already entered — seed ${already.seed ?? 'not set'}.</div>
              </div>
              <a class="btn btn-tonal btn-block" href="#/e/${event.id}" style="margin-top:12px">Open the event</a>`
            : event.status !== 'registration' ? html`
              <div class="banner banner-warn" style="margin-top:16px"><div>Registration is closed. Check with the organiser.</div></div>`
            : full ? html`
              <div class="banner banner-warn" style="margin-top:16px">${raw(icon('alert'))}
                <div>This event is full at ${event.capacity}. Join anyway to go on the waitlist — organisers usually get a few drop-outs.</div>
              </div>
              <button class="btn btn-outlined btn-block" data-act="join-event" data-event="${event.id}" style="margin-top:12px">Join the waitlist</button>`
            : html`
              <button class="btn btn-filled btn-block" data-act="join-event" data-event="${event.id}" style="margin-top:16px">
                ${ctx.me ? 'Enter this event' : 'Sign in to continue'}
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
  // Recheck current state at the action boundary: an old button can outlive
  // registration. Signing in only redraws this route; entry needs a new click.
  const event = store.getEvent(eventId);
  if (!event || event.status !== 'registration') { snack('Registration is closed. Check with the organiser.'); return; }
  if (!auth.isSignedIn()) { openSignIn(() => window.dispatchEvent(new HashChangeEvent('hashchange'))); return; }

  const me = auth.currentPlayer();
  if (store.entryFor(eventId, me.id)) { snack('You are already entered.'); return; }

  if (auth.isRemote()) {
    try {
      const entry = await store.joinRemoteEvent(eventId);
      snack(entry.waitlisted ? 'On the waitlist.' : `Entered ${event.name}.`);
      window.location.hash = `#/e/${eventId}`;
    } catch (err) {
      snack(`Could not join: ${String(err?.message || err)}`);
    }
    return;
  }

  const entries = store.entriesFor(eventId);
  const full = Boolean(event.capacity && entries.filter((entry) => !entry.waitlisted).length >= event.capacity);
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
    waitlisted: full,
  });

  snack(full ? 'On the waitlist.' : `Entered ${event.name}.`);
  window.location.hash = `#/e/${eventId}`;
});

on('set-password', async () => {
  const { openSetPassword } = await import('./auth.js');
  openSetPassword();
});
