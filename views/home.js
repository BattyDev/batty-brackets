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
import * as captcha from '../lib/captcha.js';
import { gameById, GAMES } from '../data/games.js';
import { formatMoney } from '../lib/guidance.js';
import { brandMark } from '../lib/brand.js';
import { gameMark } from '../data/themes.js';
import { isDemoMode } from '../lib/demo-mode.js';

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

async function temporarySession(tag, captchaToken) {
  if (typeof auth.createTemporaryPlayer === 'function') return auth.createTemporaryPlayer({ tag, captchaToken });
  const session = auth.signInLocal({ tag, via: 'guest' });
  if (session) { session.temporary = true; store.setSession(session); }
  return session;
}

function ensureRemoteLookup(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized || !auth.isRemote() || !auth.isSignedIn()) return;
  if (codeLookup.code === normalized && ['loading', 'done', 'error'].includes(codeLookup.status)) return;
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
    <section class="role-choice-card">
      <p class="stamp-label">Welcome to Batty Brackets</p><h1 id="role-choice-heading" style="margin-top:14px">I'm a…</h1>
      <p class="body-large role-choice-intro">Start with the view that fits tonight. You can switch any time — this remembers your preferred layout, never what you’re allowed to do.</p>
      <div class="role-choice-options">
        <button class="role-choice-option role-choice-player" type="button" data-act="choose-role" data-role="player"><span class="role-choice-icon">${raw(icon('controller', 'icon-lg'))}</span><span class="role-choice-copy"><b>Player</b><span>Join a tournament, check in, and find your next set.</span></span><span class="role-choice-arrow">${raw(icon('chevron'))}</span></button>
        <button class="role-choice-option role-choice-host" type="button" data-act="choose-role" data-role="host"><span class="role-choice-icon">${raw(icon('cabinet', 'icon-lg'))}</span><span class="role-choice-copy"><b>Host</b><span>Run your bracket, manage arrivals, and keep the room moving.</span></span><span class="role-choice-arrow">${raw(icon('chevron'))}</span></button>
      </div>
      <p class="role-choice-footnote">Have a tournament code? <a href="#/join">Join directly</a> — you won’t need to choose a role first. <a href="./demo.html">Explore the sample demo</a>.</p>
    </section></div>`;
}

/* --------------------------------------------------------------------------
   Signed out
   -------------------------------------------------------------------------- */

/* The noticeboard. A first visit gets the poster, then straight into the two
   things a stranger can actually do: read what is on, or type the code they
   were given -- the code box is on this page, not a click away. */
function landing(ctx) {
  const live = store.listEvents().filter(e => ['registration', 'checkin', 'seeding', 'running'].includes(e.status));
  const demo = isDemoMode() && store.getEvent('evt_demo_tokon')?.demo;
  return html`
    <div class="pane lobby publication">
      <section class="press-hero" aria-labelledby="press-headline">
        <div class="press-copy">
          <p class="stamp-label publication-edition">Batty Brackets / Local fighting games / By BattyDev</p>
          <h1 class="press-headline" id="press-headline">Local<br><span>legends.</span></h1>
          <p class="press-deck">Good players. Bad venue chairs.<br>One more set before last call.</p>
          <p class="body-medium">Register players, manage check-in, and run local tournament brackets and stations.</p>
          <div class="press-actions">
            <a class="btn btn-lg btn-lead" href="#/join">Got a code? Get in ${raw(icon('arrowOut'))}</a>
            ${demo ? html`<button class="btn btn-text" data-act="tour-start" data-tour="player">${raw(icon('play', 'icon-sm'))} Take the player seat</button>` : html`<a class="btn btn-text" href="./demo.html">Explore the sample demo</a>`}
          </div>
        </div>
        <div class="press-visual" aria-hidden="true">
          <span class="press-bat"></span>
          <span class="press-stamp">Everyone<br>plays.<small>Bring your pad</small></span>
        </div>
      </section>
      <p class="ticker" aria-label="Community motto"><span>Pass the pad</span><span>Run it back</span><span>Support your local</span></p>
      <div class="lobby-grid">
        <section class="event-directory" aria-labelledby="events-heading">
          <div class="section-heading"><h2 id="events-heading">${raw(icon('controller', 'icon-xl'))}On the bill.</h2>
            <span class="section-note">${live.length} active</span></div>
          ${live.length ? html`<div class="bill">${list(live.map(e => eventCard(e, ctx)))}</div>` : html`<div class="empty"><p>${store.syncState().configured ? 'No listed active events right now.' : 'No active events on this device.'}</p><a class="btn btn-tonal" href="#/join">Find an event by code</a></div>`}
          <p class="local-device-note">${store.syncState().configured ? 'Browse events or enter the code from your host.' : 'These events are saved on this device. Online registration and sharing are not connected yet.'}</p>
        </section>
        <aside class="lobby-aside">
          ${raw(joinSlip())}
          <section class="host-note host-door publication-story">
            ${raw(icon('cabinet'))}
            <p class="eyebrow">Running the room?</p><h3>Your room.<br>Your rules.</h3>
            <p>Arrivals, seeding, station calls and results. All in one host desk.</p>
            <div class="host-note-links">
              <a class="btn btn-outlined" href="#/host">Open the host desk ${raw(icon('arrowOut', 'icon-sm'))}</a>
              <a class="btn btn-text" href="#/new">Create an event</a>
            </div>
          </section>
        </aside>
      </div>
      <footer class="lobby-footer"><span>No VIPs. Just good sets.</span><a href="#/about">About & help</a><span>Batty Brackets / By BattyDev</span>${demo ? html`<button class="btn btn-text" data-act="tour-start" data-tour="tv">${raw(icon('station', 'icon-sm'))} Try the venue display</button>` : ''}</footer>
    </div>`;
}

/* The code box, usable where it stands. Submitting goes to the same join
   route a typed URL or a flyer QR code lands on. */
function joinSlip() {
  return html`<section class="join-slip player-door" aria-labelledby="join-slip-heading">
    ${raw(icon('ticket'))}
    <p class="eyebrow">Your invite to the local</p>
    <h3 id="join-slip-heading">Got the code?<br>Get in.</h3>
    <p>Enter the code your host shared. No account needed.</p>
    <form data-act-submit="join-lookup">
      <label for="join-slip-code">Event code</label>
      <div class="join-row">
        <input id="join-slip-code" name="code" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="12" placeholder="${auth.isRemote() ? 'ABCD2345EFGH' : 'TKN14B'}">
        <button class="btn btn-filled" type="submit">Join ${raw(icon('arrowOut', 'icon-sm'))}</button>
      </div>
    </form>
  </section>`;
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
  const demo = isDemoMode() && store.getEvent('evt_demo_tokon')?.demo;
  return html`<div class="pane host-home">
    <header class="workspace-heading"><div><p class="stamp-label">Host desk</p><h2 style="margin-top:12px">Run the room.</h2><p>Pick an event to manage arrivals, seed the bracket, and call sets.</p></div>
      <a class="btn btn-filled btn-lg" href="#/new">${raw(icon('plus'))} Create event</a></header>
    <div class="host-summary"><div><b>${active.length}</b><span>Active events</span></div><div><b>${active.reduce((n,e) => n + store.entriesFor(e.id).length, 0)}</b><span>Registered entries</span></div><div><b>${past.length}</b><span>Completed events</span></div></div>
    <div class="section-heading"><h3>${raw(icon('cabinet', 'icon-xl'))}Your events</h3>${demo ? html`<button class="btn btn-text" data-act="tour-start" data-tour="organiser">${raw(icon('play', 'icon-sm'))} Walk through hosting</button>` : ''}</div>
    ${active.length ? html`<div class="bill">${list(active.map(e => eventCard(e, ctx)))}</div>` : html`<div class="empty"><p>Your next local starts here.</p><a class="btn btn-tonal" href="#/new">Create your first event</a></div>`}
    ${past.length ? html`<details class="past-events"><summary>Completed events (${past.length})</summary><div class="bill">${list(past.map(e => eventCard(e, ctx)))}</div></details>` : ''}
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

  /* Each event appears once, under the heading that says why it is here. An
     event you are in is "yours" first; it is not repeated under On now. */
  const yours = events.filter(e => entered.has(e.id) && e.status !== 'complete');
  const shown = new Set(yours.map((e) => e.id));
  const running = events.filter((e) => ['checkin', 'seeding', 'running'].includes(e.status) && !shown.has(e.id));
  const upcoming = events.filter((e) => (e.status === 'registration' || e.status === 'draft') && !shown.has(e.id));
  const past = events.filter((e) => e.status === 'complete');
  const group = (title, rows, note = '') => html`
    <section style="margin-bottom:32px">
      <div class="section-heading"><h2>${title}</h2>${note ? html`<span class="section-note">${note}</span>` : ''}</div>
      <div class="bill">${list(rows.map((e) => eventCard(e, ctx, entered.has(e.id))))}</div>
    </section>`;

  return html`
    <div class="pane player-dashboard">
      <header class="workspace-heading"><div><p class="stamp-label">The local</p><h2 style="margin-top:12px">Ready, <span class="player-name">${me.tag}</span>?</h2><p>Your events, your next set, your results.</p></div><a class="btn btn-filled btn-lg" href="#/join">Got a code? ${raw(icon('arrowOut'))}</a></header>
      ${ctx.session?.needsPasswordFallback ? html`
        <div class="banner banner-warn" style="margin-bottom:24px">
          ${raw(icon('key'))}
          <div class="spacer">
            <b>Add a password to your account</b>
            <div class="body-small">You sign in with Discord only. If Discord is down you could not get into your own bracket. Same account, ten seconds.</div>
            <div class="row" style="margin-top:8px">
              <button class="btn btn-filled btn-sm" data-act="set-password">Set a password</button>
            </div>
          </div>
        </div>` : ''}

      ${yours.length ? html`<div class="your-events">${raw(group('You’re in', yours, 'Open one for your next set'))}</div>` : ''}
      ${running.length ? raw(group('On now', running)) : ''}
      ${upcoming.length ? raw(group('Coming up', upcoming)) : ''}
      ${!yours.length && !running.length && !upcoming.length ? html`
        <div class="empty" style="margin-bottom:32px">${raw(icon('ticket'))}<p class="body-large">Nothing on the bill yet.</p>
          <a class="btn btn-tonal" href="#/join">Join with a code</a></div>` : ''}
      ${past.length ? raw(group('Finished', past.slice(0, 6))) : ''}
    </div>
`;
}

/* One row of the bill: a date stamp, the event, and one target. The whole row
   is the link, so there is no second "View event" control to aim at. */
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
  const manage = ctx.route === 'host' && canAdmin;
  const when = event.startsAt ? new Date(event.startsAt) : null;
  const stamp = when && !Number.isNaN(when.getTime()) ? {
    day: new Intl.DateTimeFormat(undefined, { day: '2-digit' }).format(when),
    weekday: new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(when),
  } : { day: '—', weekday: 'TBA' };

  return html`
    <article class="event-card">
      <a class="event-card-main bill-row" href="#/e/${event.id}${manage ? '/admin' : ''}">
        <span class="bill-date" aria-hidden="true"><b>${stamp.day}</b><span>${stamp.weekday}</span></span>
        <span class="bill-body">
          <b class="bill-title">${event.name}</b>
          <span class="bill-sub">${game?.short || event.gameId} / ${event.venue || 'Venue to be announced'}${org ? ` · Organized by ${org.name}` : ''}</span>
          <span class="bill-meta">
            <span>${formatDateTime(event.startsAt)} · ${relativeTime(event.startsAt)}</span>
            <span>${entries.length} entrant${entries.length === 1 ? '' : 's'}${event.entryFee ? ` · ${formatMoney(event.entryFee, event.currency)}` : ''}</span>
            <span class="chip chip-static ${raw(status.chip)}">${status.label}</span>
            ${isEntered ? html`<span class="chip chip-static chip-ok">Entered</span>` : ''}
            ${event.demo ? html`<span class="chip chip-static">Demo</span>` : ''}
          </span>
        </span>
        <span class="bill-go" aria-hidden="true">${raw(icon(manage ? 'tune' : 'arrowOut'))}</span>
        <span class="sr-only">${manage ? 'Manage event' : 'View event'}</span>
      </a>
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
      <div class="pane join-page">
        ${!event ? html`<header class="workspace-heading"><div><p class="stamp-label">Your invite to the local</p>
          <h2 style="margin-top:12px">Got the code?<br>Get in.</h2>
          <p>Enter the code your host shared, or scan the flyer.</p></div></header>
        <form class="stack join-lookup" data-act-submit="join-lookup">
          <label class="field">
            <span class="field-label">Event code</span>
            <input type="text" name="code" value="${code || ''}" autocapitalize="characters"
                   autocomplete="off" spellcheck="false" placeholder="${auth.isRemote() ? 'ABCD2345EFGH' : 'TKN14B'}">
          </label>
          <button class="btn btn-filled btn-lg btn-block" type="submit">Find it</button>
        </form>` : ''}

        ${normalizedCode && !event && auth.isRemote() && !auth.isSignedIn() ? guestForm(null, false, normalizedCode) : ''}
        ${normalizedCode && !event && auth.isRemote() && auth.isSignedIn() && codeLookup.code === normalizedCode && codeLookup.status === 'loading' ? html`
          <div class="banner banner-info" style="margin-top:16px">${raw(icon('clock'))}<div>Finding your event…</div></div>` : ''}
        ${normalizedCode && !event && (!auth.isRemote() || (codeLookup.code === normalizedCode && codeLookup.status === 'error')) ? html`
          <div class="banner banner-error" style="margin-top:16px">${raw(icon('alert'))}
            <div><b>We couldn’t find that invitation.</b><p class="body-small">Check the code with your host, or reconnect and retry.</p>${auth.isRemote() ? html`<button class="btn btn-outlined btn-sm" data-act="join-retry" data-code="${normalizedCode}">Retry lookup</button>` : ''}<a href="#/about/code">Code help</a></div>
          </div>` : ''}

        ${event ? html`
          <div class="card card-elevated">
            <div class="row" style="flex-wrap:nowrap;align-items:flex-start">
              ${raw(gameMark(game))}
              <div class="spacer" style="min-width:0">
                <h2 class="headline-small">${event.name}</h2>
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
            : !['registration', 'checkin'].includes(event.status) ? html`
              <div class="banner banner-warn" style="margin-top:16px"><div>Registration is closed. Check with the organiser.</div></div>`
            : !ctx.me ? guestForm(event, full, normalizedCode)
            : full ? html`
              <div class="banner banner-warn" style="margin-top:16px">${raw(icon('alert'))}
                <div>This event is full at ${event.capacity}. Join anyway to go on the waitlist — organisers usually get a few drop-outs.</div>
              </div>
              <button class="btn btn-outlined btn-block" data-act="join-event" data-event="${event.id}" style="margin-top:12px">Join the waitlist</button>`
            : html`
              <button class="btn btn-filled btn-block" data-act="join-event" data-event="${event.id}" style="margin-top:16px">
                Enter this event
              </button>`}
          </div><a class="btn btn-text" href="#/join" style="margin-top:12px">Use a different code</a>` : ''}
      </div>`,
  };
}

on('join-retry', ({ code }) => {
  codeLookup = { code: null, status: 'idle', error: null };
  ensureRemoteLookup(code);
  rerender();
});

export function guestForm(event, waitlisted = false, code = '') {
  const hasDocuments = Boolean(event?.documents?.some((doc) => doc.required));
  const label = waitlisted ? 'Join the waitlist'
    : event?.status !== 'checkin' ? 'Join the event'
    : hasDocuments ? 'Join and review documents' : 'Join and check in';
  return html`<form class="guest-entry-form card card-outlined" data-act-submit="guest-join" style="margin-top:16px">
    ${event ? html`<input type="hidden" name="event" value="${event.id}">` : ''}
    <input type="hidden" name="code" value="${code}">
    <p class="stamp-label" style="margin-bottom:14px">Play as a guest</p>
    <label class="field"><span class="field-label">Player nickname</span>
      <input name="tag" maxlength="${GUEST_TAG_MAX}" autocomplete="nickname" required placeholder="What should the bracket call you?">
    </label>
    <p class="field-help body-small dim">No login needed. You can save your record and customise your profile after you’re in.</p>
    ${captcha.enabled() ? html`
      <div class="captcha-slot" data-hcaptcha-widget><span class="body-small dim">Loading anti-bot check…</span></div>
      <p class="field-help body-small dim">Complete this quick check before joining.</p>` : ''}
    <button class="btn btn-filled btn-block" type="submit">${label}</button>
  </form>`;
}

/* --------------------------------------------------------------------------
   Actions
   -------------------------------------------------------------------------- */

on('join-lookup', (data, form) => {
  /* Codes are letters and digits only; anything else typed around one (a
     space, a dash from a flyer) is dropped rather than failing the route. */
  const code = String(new FormData(form).get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) { snack('Enter the code your host shared.'); form.elements.code?.focus(); return; }
  window.location.hash = `#/join/${code}`;
});

on('guest-join', async (_data, form) => {
  const values = new FormData(form);
  const tag = String(values.get('tag') || '').trim();
  const code = String(values.get('code') || '').trim().toUpperCase();
  let eventId = String(values.get('event') || '');
  if (!tag || tag.length > GUEST_TAG_MAX) { snack(`Enter a nickname up to ${GUEST_TAG_MAX} characters.`); return; }
  const captchaToken = captcha.token(form);
  if (captcha.enabled() && !captchaToken) { snack('Complete the anti-bot checkbox before joining.'); return; }

  // Claim the lookup while auth redraws so the same code is not redeemed twice.
  if (code) codeLookup = { code, status: 'loading', error: null };
  try {
    await temporarySession(tag, captchaToken);
    let event = eventId ? store.getEvent(eventId) : null;
    if (!event && code && auth.isRemote()) {
      const result = await store.redeemRemoteCode(code);
      event = result.event;
      eventId = event?.id || '';
      codeLookup = { code, status: 'done', error: null };
    } else if (!event && code) {
      event = store.eventByInvite(code);
      eventId = event?.id || '';
    }
    if (!event || !['registration', 'checkin'].includes(event.status)) throw new Error('Registration is closed or the event is unavailable.');

    let entry;
    if (auth.isRemote()) {
      entry = await store.joinRemoteEvent(eventId);
      if (event.status === 'checkin' && !entry.waitlisted && !(event.documents || []).some((doc) => doc.required)) {
        entry = await store.selfCheckInRemote(eventId);
      }
    } else {
      const me = auth.currentPlayer();
      entry = store.entryFor(eventId, me.id);
      if (!entry) {
        const entries = store.entriesFor(eventId);
        const full = Boolean(event.capacity && entries.filter((item) => !item.waitlisted).length >= event.capacity);
        const id = store.uid('ent');
        entry = {
          id, eventId, playerId: me.id, seed: entries.length + 1,
          group: me.homeVenue || null, registeredAt: new Date().toISOString(),
          checkedInAt: event.status === 'checkin' && !full && !(event.documents || []).some((doc) => doc.required) ? new Date().toISOString() : null,
          source: 'guest', temporary: true, signedDocuments: [], waitlisted: full,
        };
        store.apply('entries', id, entry);
      }
    }
    rememberPlayerExperience();
    snack(entry.waitlisted ? 'On the waitlist.' : entry.checkedInAt ? 'Joined and checked in.' : `Entered ${event.name}.`);
    window.location.hash = `#/e/${eventId}`;
  } catch (err) {
    captcha.reset(form);
    codeLookup = { code, status: 'error', error: String(err?.message || err) };
    snack(`Could not join: ${codeLookup.error}`);
    rerender();
  }
});

on('join-event', async ({ event: eventId }) => {
  const { openSignIn } = await import('./auth.js');
  // Recheck current state at the action boundary: an old button can outlive
  // registration. Signing in only redraws this route; entry needs a new click.
  const event = store.getEvent(eventId);
  if (!event || !['registration', 'checkin'].includes(event.status)) { snack('Registration is closed. Check with the organiser.'); return; }
  if (!auth.isSignedIn()) { openSignIn(() => window.dispatchEvent(new HashChangeEvent('hashchange'))); return; }

  const me = auth.currentPlayer();
  if (store.entryFor(eventId, me.id)) { snack('You are already entered.'); return; }

  if (auth.isRemote()) {
    try {
      let entry = await store.joinRemoteEvent(eventId);
      if (event.status === 'checkin' && !entry.waitlisted && !(event.documents || []).some((doc) => doc.required)) {
        entry = await store.selfCheckInRemote(eventId);
      }
      snack(entry.waitlisted ? 'On the waitlist.' : entry.checkedInAt ? 'Joined and checked in.' : `Entered ${event.name}.`);
      window.location.hash = `#/e/${eventId}`;
      rerender();
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
    checkedInAt: event.status === 'checkin' && !full && !(event.documents || []).some((doc) => doc.required) ? new Date().toISOString() : null,
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
