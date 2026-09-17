/* Brackets · shell and router
   ===========================================================================
   Boots the store, attaches Supabase if it is configured, wires the hash
   router, and draws the chrome that every view sits inside.

   ## Routing on the hash

   `#/e/evt_123/admin/entrants` rather than a real path, because this is
   GitHub Pages: there is no server to rewrite unknown paths back to
   index.html, so a real path would 404 on a hard refresh. The same constraint
   /fcevents ran into. The cost is that a link cannot be given a per-event
   preview card by a crawler -- Discord's unfurler does not run JavaScript and
   never sees the hash. That is a genuine limitation and it is called out in
   the README rather than pretended away, because "share your bracket in
   Discord" is a core workflow and it currently unfurls as the site, not the
   event.
   =========================================================================== */

'use strict';

import * as store from './lib/store.js';
import * as auth from './lib/auth.js';
import { createBackend, isUuid } from './lib/backend.js';
import { brandMark, brandSignature } from './lib/brand.js';
import { installThemes, themeFor, gameMark } from './data/themes.js';
import * as tour from './lib/tour.js';
import { render, bindDelegation, on, html, raw, list, icon, snack, esc, tickLiveClocks } from './lib/ui.js';

import * as home from './views/home.js';
import * as setup from './views/setup.js';
import * as admin from './views/admin.js';
import * as player from './views/player.js';
import * as publicEvent from './views/event.js';
import * as tv from './views/tv.js';
import * as authView from './views/auth.js';
import * as recovery from './views/recovery.js';

/* --------------------------------------------------------------------------
   Supabase
   --------------------------------------------------------------------------
   Loaded from a CDN only when config.js actually names a project. With no
   config the import never happens, which means the local-only mode costs
   nothing at all -- no request, no parse, no 200kB of client sitting unused in
   a page whose entire pitch is that it loads fast on venue wifi.
   -------------------------------------------------------------------------- */

async function connect() {
  const cfg = window.BRACKETS_CONFIG || {};
  if (!cfg.url || !cfg.key) return null;
  try {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    const client = createClient(cfg.url, cfg.key);
    return {
      client,
      backend: createBackend({ rpc: (name, args) => client.rpc(name, args) }),
    };
  } catch (err) {
    /* A CDN that is blocked or slow must not stop the app: everything works
       locally, it just will not sync. Saying so beats a blank page. */
    console.warn('[brackets] could not load Supabase, running local-only', err);
    snack('Could not reach the server — running on this device only.');
    return null;
  }
}

/* --------------------------------------------------------------------------
   Router
   -------------------------------------------------------------------------- */

const ROUTES = [
  { pattern: /^\/?$/, view: home, name: 'home' },
  { pattern: /^\/host$/, view: home, name: 'host' },
  { pattern: /^\/new$/, view: setup, name: 'new' },
  { pattern: /^\/recovery$/, view: recovery, name: 'recovery' },
  { pattern: /^\/join(?:\/([A-Z0-9]+))?$/i, view: home, name: 'join', keys: ['code'] },
  { pattern: /^\/e\/([^/]+)\/admin(?:\/([^/]+))?$/, view: admin, name: 'admin', keys: ['eventId', 'tab'] },
  /* Before the generic event route, which would otherwise match /tv as a tab
     and render the event page with an unknown tab. */
  { pattern: /^\/e\/([^/]+)\/tv$/, view: tv, name: 'tv', keys: ['eventId'] },
  { pattern: /^\/e\/([^/]+)(?:\/([^/]+))?$/, view: publicEvent, name: 'event', keys: ['eventId', 'tab'] },
  { pattern: /^\/me(?:\/([^/]+))?$/, view: player, name: 'me', keys: ['tab'] },
  { pattern: /^\/p\/([^/]+)$/, view: player, name: 'player', keys: ['playerId'] },
];

function parseRoute() {
  const path = decodeURIComponent(window.location.hash.replace(/^#/, '')) || '/';
  for (const route of ROUTES) {
    const match = path.match(route.pattern);
    if (!match) continue;
    const params = {};
    (route.keys || []).forEach((key, i) => { if (match[i + 1]) params[key] = match[i + 1]; });
    return { ...route, params, path };
  }
  return { ...ROUTES[0], params: {}, path };
}

export function go(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (window.location.hash === target) { draw(); return; }
  if (replace) window.location.replace(target);
  else window.location.hash = target;
}

/* --------------------------------------------------------------------------
   Announcing navigation
   --------------------------------------------------------------------------
   In a single-page app the URL changes and the whole main region is replaced,
   but nothing tells a screen reader that anything happened -- so a user who
   activates "Seeding" hears silence and is left with focus on a link that no
   longer exists.

   Two things fix it, and both are needed: move focus to the top of the new
   content, and announce the page name in a live region. Focus alone is not
   enough (the heading is read, but the user does not know a navigation
   occurred); the announcement alone is not enough (focus stays behind in the
   old, now-detached DOM).
   -------------------------------------------------------------------------- */
let lastAnnounced = null;

function announceRoute(title) {
  const region = document.getElementById('route-announcer');
  if (!region || title === lastAnnounced) return;
  lastAnnounced = title;
  region.textContent = title;
}

/* Focus is moved only on a real navigation, never on the re-renders caused by
   a store change or the one-second timer -- stealing focus from a field
   somebody is typing in would be far worse than the problem being solved.

   `lastPath` starts undefined and is seeded by the FIRST draw without moving
   focus. That is not a micro-optimisation, it is a fix for a real bug: moving
   focus to <main> on initial load puts the skip link behind the focus
   position, so the first Tab lands inside the content and the skip link can
   never be reached at all -- which breaks the one feature that exists purely
   for keyboard users. On a fresh page load the browser's own starting point
   (the top of the document) is already the right one. */
let lastPath;

function focusMainIfNavigated(path) {
  const first = lastPath === undefined;
  if (path === lastPath) return;
  lastPath = path;
  if (first) return;
  const main = document.getElementById('main');
  if (main) main.focus({ preventScroll: true });
  restoreScroll();
}

/* --------------------------------------------------------------------------
   Scroll position
   --------------------------------------------------------------------------
   `focus({ preventScroll: true })` above is right -- moving focus must not
   yank the page around -- but on its own it meant navigation did not move the
   page at all. Scroll halfway down the events list, click "Start a new
   event", and you land in the middle of the wizard with its first question
   above you. Reported exactly that way.

   The naive fix is `scrollTo(0, 0)` on every draw, which is wrong twice over:
   a store change redraws too (check somebody in from the bottom of a 28-row
   roster and you get thrown back to the top), and Back should return you to
   where you were, not to the top of a list you have already scrolled.

   So position is remembered per HISTORY ENTRY, not per path. A path is not
   enough -- visiting the same event twice from two different places should
   not inherit the first visit's scroll -- and the browser gives every history
   entry a slot for exactly this. New entry: top. Returning to one we have
   seen: back where you were.

   `scrollRestoration = 'manual'` stops the browser doing its own version of
   this a frame later and fighting us. Chrome and Safari disagree about
   whether hash navigation restores scroll at all, so doing it ourselves is
   also the only way to get one behaviour on both. */
if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';

let nextNavKey = 1;
const scrollMemory = new Map();

function navKey() {
  /* An entry created by a plain <a href="#/..."> has null state, so stamp one
     on first sight. replaceState keeps the entry -- pushing here would double
     every Back press. */
  if (window.history.state?.brkNav == null) {
    const key = nextNavKey;
    nextNavKey += 1;
    try { window.history.replaceState({ ...window.history.state, brkNav: key }, ''); }
    catch { return null; }  /* file:// in some browsers */
    return key;
  }
  return window.history.state.brkNav;
}

/* Record continuously rather than on the way out. Most navigation in this app
   is a plain link the router never sees before the hash has already changed,
   so there is no reliable "about to leave" moment to hook. */
let scrollTicking = false;
window.addEventListener('scroll', () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    scrollTicking = false;
    const key = window.history.state?.brkNav;
    if (key != null) scrollMemory.set(key, window.scrollY);
  });
}, { passive: true });

function restoreScroll() {
  const key = navKey();
  const remembered = key == null ? 0 : scrollMemory.get(key);
  /* A new entry has nothing remembered, and the top is where a new page
     starts. `instant` because this is a page change, not a nudge -- smooth
     scrolling a whole viewport on every navigation is motion nobody asked
     for, and it would race the next render. */
  window.scrollTo({ top: remembered || 0, left: 0, behavior: 'instant' });
}

/* --------------------------------------------------------------------------
   Chrome
   -------------------------------------------------------------------------- */

function syncChip() {
  const s = store.syncState();
  const local = s.storage || {};
  if (local.error) {
    return html`<button type="button" class="sync offline" data-act="recovery-open"
      aria-label="Backup and recovery: local save failed" title="${local.error}"
      style="border:0;cursor:pointer;font:var(--label-medium)">
      ${raw(icon('alert', 'icon-sm'))} Local save failed</button>`;
  }
  if (!s.configured) {
    return html`<button type="button" class="sync" data-act="recovery-open"
      aria-label="Backup and recovery: saved on this device"
      title="No backend configured — everything is saved on this device only."
      style="border:0;cursor:pointer;font:var(--label-medium)">
      ${raw(icon('station', 'icon-sm'))} Saved on this device</button>`;
  }
  if (s.connected && s.localOnlyWrites) {
    return html`<button type="button" class="sync pending" data-act="recovery-open"
      aria-label="Connected RPC mode: ${s.localOnlyWrites} local-only controls"
      title="This connected slice syncs identity, events and joins through explicit commands. Other host controls remain local-only until their server commands exist."
      style="border:0;cursor:pointer;font:var(--label-medium)">${raw(icon('alert', 'icon-sm'))}
      Connected · ${s.localOnlyWrites} local-only control${s.localOnlyWrites === 1 ? '' : 's'}</button>`;
  }
  if (s.connected) {
    return html`<button type="button" class="sync" data-act="recovery-open"
      aria-label="Connected through explicit server commands"
      title="Identity, event setup, event lookup and joining use the connected RPC boundary."
      style="border:0;cursor:pointer;font:var(--label-medium)">${raw(icon('check', 'icon-sm'))}
      Connected · RPC mode</button>`;
  }
  if (!s.online) {
    return html`<button type="button" class="sync offline" data-act="recovery-open"
      aria-label="Backup and recovery: saved locally, offline"
      style="border:0;cursor:pointer;font:var(--label-medium)">${raw(icon('wifiOff', 'icon-sm'))}
      Saved locally · Offline${s.pending ? html` · ${s.pending} waiting` : ''}</button>`;
  }
  if (s.failed) {
    return html`<button type="button" class="sync offline" data-act="recovery-open"
      aria-label="Backup and recovery: ${s.failed} server writes failed"
      title="${s.lastServerError || 'Some server writes need attention.'}"
      style="border:0;cursor:pointer;font:var(--label-medium)">
      ${raw(icon('alert', 'icon-sm'))} Saved locally · ${s.failed} sync failed</button>`;
  }
  if (s.pending) {
    return html`<button type="button" class="sync pending" data-act="recovery-open"
      aria-label="Backup and recovery: saved locally, syncing ${s.pending} writes"
      style="border:0;cursor:pointer;font:var(--label-medium)"><span class="dot"></span> Saved locally · Syncing ${s.pending}</button>`;
  }
  return html`<button type="button" class="sync" data-act="recovery-open"
    aria-label="Backup and recovery: saved locally, server synced"
    title="The local copy is saved; the last server sync returned without an error."
    style="border:0;cursor:pointer;font:var(--label-medium)">
    ${raw(icon('check', 'icon-sm'))} Saved locally · Server synced</button>`;
}

/* A display fills the screen: no app bar, no navigation rail, no skip link to
   a nav that is not there. It still gets the route announcement and the
   focusable main, because somebody may still be driving it from a keyboard
   while setting it up. */
function chromelessShell(inner, gameId) {
  return html`<main id="main" tabindex="-1">${raw(inner)}</main>`;
}

function shell(inner, { title, subtitle, back, actions = '', gameId = null }) {
  const route = parseRoute();
  const me = auth.currentPlayer();
  // Mode is navigation, never authorization. Keep deep links and back/forward
  // deterministic; visiting a player page must not leave host tools selected.
  const host = ['host', 'admin', 'new', 'recovery'].includes(route.name);
  const event = route.params.eventId && store.getEvent(route.params.eventId);
  const eventOrg = event && store.getOrg(event.orgId);
  const canHost = !event || !auth.currentSession() || (event.ownerId
    ? event.ownerId === me?.id
    : eventOrg?.ownerId === me?.id);
  const navigation = host ? [
    { label: 'My events', icon: 'trophy', path: '/host', current: ['host', 'admin'].includes(route.name) },
    { label: 'Create event', icon: 'plus', path: '/new', current: route.name === 'new' },
    { label: 'Backups', icon: 'undo', path: '/recovery', current: route.name === 'recovery' },
  ] : [
    { label: 'Events', icon: 'trophy', path: '/', current: ['home', 'event'].includes(route.name) },
    { label: 'Join event', icon: 'key', path: '/join', current: route.name === 'join' },
    { label: 'My profile', icon: 'person', path: '/me', current: route.name === 'me' },
  ];
  /* Batty owns the navigation and working tools. Game accents belong to
     explicitly bounded marks, cards and artwork, never the whole shell. */

  return html`
    <a class="skip-link" href="#main">Skip to main content</a>
    <div class="app ${raw(host ? 'experience-host' : 'experience-player')} ${raw(route.name === 'home' && !me ? 'app-publication' : '')}">
      <header class="top-bar">
        ${back ? html`<button class="btn btn-icon" data-act="go" data-path="${back}" aria-label="Back">${raw(icon('back'))}</button>` : ''}
        <a class="top-bar-brand" href="#/" aria-label="Home">${raw(brandSignature())}</a>
        <nav class="experience-switch" aria-label="Experience">
          <a href="#${event ? `/e/${event.id}` : '/'}" ${raw(!host ? 'aria-current="true"' : '')}>Player</a>
          ${canHost ? html`<a href="#${event ? `/e/${event.id}/admin` : '/host'}" ${raw(host ? 'aria-current="true"' : '')}>Host</a>` : ''}
        </nav>
        ${raw(actions)}
        ${raw(syncChip())}
        <!-- The label names the destination, not the control. "Switch theme"
             tells a screen reader user nothing about which way it goes; the
             sighted cue is the icon and they do not have it. -->
        <button class="btn btn-icon" data-act="theme"
                aria-label="Switch to ${raw(resolvedTheme() === 'dark' ? 'light' : 'dark')} theme">${raw(icon('theme'))}</button>
      </header>

      <nav class="nav" aria-label="Sections">
        <div class="rail-identity"><div class="rail-logo">${raw(brandMark())}</div><span>${host ? 'HOST WORKSPACE' : 'PLAYER LOUNGE'}</span></div>
        <!-- aria-current only where it is true. It previously marked "Events"
             on every route that was not the profile, which tells a screen
             reader the user is on a page they are not on. -->
        ${list(navigation.map((item) => html`
          <a class="nav-item" href="#${item.path}"
             ${raw(item.current ? 'aria-current="page"' : '')}>
            <span class="pill">${raw(icon(item.icon))}</span>
            <span>${item.label}</span>
          </a>`))}
        ${!me ? html`<button class="nav-item" data-act="sign-in"><span class="pill">${raw(icon('person'))}</span><span>Sign in</span></button>` : ''}
      </nav>

      <!-- tabindex="-1" so the skip link and the post-navigation focus move
           below can put focus here; it is not in the tab order itself. -->
      <main class="scaffold" id="main" tabindex="-1">
        <!-- Keep route identification for screen readers without duplicating
             the visible page branding in the utility bar. -->
        ${route.name === 'home' ? '' : html`<h1 class="sr-only">${title}</h1>`}
        ${raw(inner)}
        ${raw(tour.demoBanner())}
      </main>
    </div>`;
}

/* --------------------------------------------------------------------------
   Draw
   -------------------------------------------------------------------------- */

const root = document.getElementById('app');
let drawing = false;
const routeHydration = new Map();

function hydrateRemoteRoute(eventId) {
  if (routeHydration.get(eventId)?.status === 'loading') return;
  routeHydration.set(eventId, { status: 'loading', error: null });
  store.readRemoteEvent(eventId).then(() => {
    routeHydration.set(eventId, { status: 'done', error: null });
    draw();
  }).catch((error) => {
    routeHydration.set(eventId, { status: 'error', error: String(error?.message || error) });
    draw();
  });
}

export function draw() {
  /* Guard against re-entrancy: a view's render can call store.apply (for
     example, lazily creating a bracket), which notifies, which would draw
     again mid-draw. */
  if (drawing) return;
  drawing = true;
  try {
    const route = parseRoute();
    const missingRemoteEvent = route.params.eventId && store.syncState().connected
      && isUuid(route.params.eventId) && !store.getEvent(route.params.eventId);
    if (missingRemoteEvent) {
      const hydration = routeHydration.get(route.params.eventId);
      if (!hydration) Promise.resolve().then(() => hydrateRemoteRoute(route.params.eventId));
      render(root, shell(html`<div class="pane"><div class="banner ${raw(hydration?.status === 'error' ? 'banner-error' : 'banner-info')}">
        ${raw(icon(hydration?.status === 'error' ? 'alert' : 'clock'))}
        <div><b>${hydration?.status === 'error' ? 'This event is unavailable.' : 'Loading the event…'}</b>
        ${hydration?.error ? html`<p class="body-small" style="margin:4px 0 0">${hydration.error}</p>` : ''}</div>
      </div><p><a class="btn btn-tonal" href="#/">Back to events</a></p></div>`, {
        title: 'Event', back: '/',
      }));
      drawChrome();
      announceRoute('Event');
      focusMainIfNavigated(route.path);
      return;
    }
    const ctx = {
      state: store.get(),
      session: auth.currentSession(),
      me: auth.currentPlayer(),
      params: route.params,
      route: route.name,
      go,
      draw,
    };
    const out = route.view.view(ctx);
    render(root, out.chromeless
      ? chromelessShell(out.body, out.gameId)
      : shell(out.body, out));
    drawChrome();
    announceRoute(out.title);
    focusMainIfNavigated(route.path);
  } catch (err) {
    /* A view that throws must not leave a blank page with no way out -- at a
       venue that is indistinguishable from the site being down. */
    console.error('[brackets] view failed', err);
    render(root, shell(html`
      <div class="pane">
        <div class="banner banner-error">${raw(icon('alert'))}
          <div><b>Something went wrong drawing this page.</b>
          <div class="body-small">${String(err?.message || err)}</div></div>
        </div>
        <p><a class="btn btn-tonal" href="#/">Back to events</a></p>
      </div>`, { title: 'Brackets' }));
  } finally {
    drawing = false;
  }
}

/* The docked tour card, kept out of the routed render so it is not destroyed
   and rebuilt underneath the person reading it. Only rewritten when its
   content actually changes, which is once per tour step rather than once per
   draw. */
const chromeRoot = document.getElementById('chrome');
let lastChrome = null;

function drawChrome() {
  const markup = String(tour.tourCard());
  if (markup === lastChrome) return;
  lastChrome = markup;
  chromeRoot.innerHTML = markup;
}

/* --------------------------------------------------------------------------
   Global actions
   -------------------------------------------------------------------------- */

on('go', ({ path }) => go(path));
on('noop', () => {});
on('recovery-open', () => go('/recovery'));

/* The theme button toggles against what you can SEE, not against what is
   stored.
   --------------------------------------------------------------------------
   This shipped as a three-way cycle -- dark, light, follow-system -- and it
   was reported as "I have to click twice to switch to light mode". It was:

     stored     rendered (system dark)   click sets   rendered
     (none)     dark                     dark         dark      <- nothing happens
     dark       dark                     light        light

   With no preference stored the page follows the system, so on a system-dark
   machine the FIRST click stored "dark" -- which the page already looked
   like. A control that does nothing visible is a broken control, no matter
   how defensible the state machine behind it is.

   So it is a two-state switch on the RESOLVED appearance now: whatever you
   are looking at, one click gives you the other one. Following the system is
   still the default until you touch it, and still reachable -- but as an
   offer in the snackbar rather than as a third of the cycle, because
   "returns you to automatic" is a rare intention and does not deserve to sit
   between the two common ones. */
function resolvedTheme() {
  const stored = document.documentElement.dataset.theme;
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function setTheme(next) {
  if (next) document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  try {
    if (next) localStorage.setItem('battydev.brackets.theme', next);
    else localStorage.removeItem('battydev.brackets.theme');
  } catch { /* private mode */ }
  draw();
}

on('theme', () => {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  snack(`${next[0].toUpperCase()}${next.slice(1)} theme`, {
    action: 'Use system',
    onAction: () => { setTheme(''); snack('Following your system theme'); },
  });
});

on('sign-in', () => authView.openSignIn(draw));
on('sign-out', async () => { await auth.signOut(); go('/'); snack('Signed out'); });

on('copy-text', async ({ text }) => {
  const { copy } = await import('./lib/ui.js');
  snack(await copy(text) ? 'Copied' : 'Could not copy — select it and copy by hand');
});

/* ---- the guided demo ----
   All of these are plain store writes plus a route change, so the tour cannot
   get the app into a state you could not reach by clicking. */
on('tour-start', ({ tour: id }) => { tour.start(id || 'organiser'); });
on('tour-next', () => { tour.next(); });
on('tour-prev', () => { tour.previous(); });
on('tour-stop', () => { tour.stop(); draw(); snack('Tour ended — everything still works. Reset when you are done.'); });
on('tour-dismiss', () => { tour.dismiss(); draw(); });
on('tour-reset', () => {
  const restored = tour.reset();
  snack(restored ? 'Demo reset to how it started.' : 'Nothing to reset.');
  window.location.hash = `#/e/${tour.DEMO_EVENT}`;
  draw();
});

on('undo', () => {
  const label = store.undo();
  snack(label ? `Undid: ${label}` : 'Nothing to undo');
  draw();
});

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

(async function boot() {
  try {
    const saved = localStorage.getItem('battydev.brackets.theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch { /* private mode */ }

  bindDelegation(root);
  bindDelegation(chromeRoot);
  /* One <style> covering every game's colour roles, injected once. See
     data/themes.js -- putting data-game on any container re-themes everything
     inside it. */
  installThemes();

  /* ---- who gets the demo ----------------------------------------------
     A guest does. That is the whole point of it: somebody following a link
     with no account should land on a working tournament rather than an empty
     state, and be able to walk through every screen without signing up.

     The rule is therefore about the VISITOR, not about the deployment:

       * no backend at all  -> demo (the local-only mode, and how this runs
         today)
       * backend, signed out -> demo, seeded locally only
       * backend, signed in  -> no demo. A real account must look empty when it
         is empty; seeding fiction into somebody's own event list would be
         indefensible.

     Seeding it for a signed-out visitor of a live deployment is safe because
     every write in data/demo.js passes `queueIt: false`, so not one demo row
     can reach the server. It exists in that browser and nowhere else.

     Signing in later does not wipe it — the demo and the account's real events
     simply coexist locally, and the demo rows are the ones carrying `demo:
     true`, which is also what scopes the reset. */
  const cfg = window.BRACKETS_CONFIG || {};
  const configured = Boolean(cfg.url && cfg.key);

  store.boot({
    demo: !configured,
    scope: configured ? { projectUrl: cfg.url, accountId: 'anonymous' } : null,
  });

  const connection = await connect();
  if (connection) {
    const { client, backend } = connection;
    /* The production boot path crosses the connected boundary exactly once:
       an explicit RPC adapter. It never attaches the legacy generic outbox
       and never performs a table pull. */
    store.attachBackend(backend, { projectUrl: cfg.url, accountId: 'anonymous' });
    await auth.initAuth(client, { connectedBackend: backend });
    /* Pull only the public/account-visible list through bkt_list_events. A
       signed-out connected visitor gets no local demo seed. */
    await store.pull();
  } else {
    await auth.initAuth(null);
  }

  /* Capture the pristine demo before anything can touch it, so reset always
     has something correct to restore. No-op once captured, and a no-op
     entirely when the data is not the demo. */
  tour.snapshot();

  store.subscribe(() => draw());
  auth.onAuth(() => {
    draw();
    if (auth.isRemote()) store.pull().then(draw);
  });
  window.addEventListener('brackets-recovery-change', draw);
  window.addEventListener('hashchange', draw);

  /* Live clocks: DQ timers and how long a set has been out.
     ------------------------------------------------------------------------
     This used to call draw() once a second on the admin routes, and that was
     wrong in a way worth recording. Redrawing the page to move a clock throws
     away scroll position and focus, and it destroyed and rebuilt the docked
     tour card every second -- replaying its slide-in animation, so the panel
     appeared to close and reopen continuously while somebody was trying to
     read it.

     A clock is text. `tickLiveClocks` rewrites the text of anything carrying
     `data-live-since` and toggles the over-time class, which is a handful of
     property writes against several hundred rebuilt nodes.

     The guidance panel still needs periodic re-evaluation, because a
     suggestion can fire purely because time passed -- but at 20 seconds, and
     only when its content has actually changed, which `draw` already
     guards against by comparing rendered output. */
  setInterval(() => tickLiveClocks(), 1000);

  setInterval(() => {
    if (parseRoute().name === 'admin' && parseRoute().params.tab === 'overview') draw();
  }, 20000);

  /* Stamp the entry the page loaded on before anything scrolls. Without this
     the FIRST page you look at is the one page whose position is never
     recorded, so Back to it lands at the top -- which is the most likely Back
     in the app. */
  navKey();

  draw();

  /* Somebody who hit the wizard's sign-in gate and chose Discord left the page
     entirely and has just come back on a fresh load. Their draft is on disk;
     this puts them back in front of it. */
  const setup = await import('./views/setup.js');
  setup.resumePendingPublish();

  /* Sets up the "join" search param -> invite code shortcut, so a QR code
     on a flyer can be battybrackets.com/?join=TKN14B and land straight on
     the join screen. Query params survive Discord's link handling better than
     a hash does. */
  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get('join');
  if (joinCode) go(`/join/${joinCode.toUpperCase()}`, { replace: true });
}());

export { store, auth };
