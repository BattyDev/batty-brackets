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
import { render, bindDelegation, on, html, raw, list, icon, snack, esc } from './lib/ui.js';

import * as home from './views/home.js';
import * as setup from './views/setup.js';
import * as admin from './views/admin.js';
import * as player from './views/player.js';
import * as publicEvent from './views/event.js';
import * as authView from './views/auth.js';

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
    return createClient(cfg.url, cfg.key);
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
  { pattern: /^\/new$/, view: setup, name: 'new' },
  { pattern: /^\/join(?:\/([A-Z0-9]+))?$/i, view: home, name: 'join', keys: ['code'] },
  { pattern: /^\/e\/([^/]+)\/admin(?:\/([^/]+))?$/, view: admin, name: 'admin', keys: ['eventId', 'tab'] },
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
   Chrome
   -------------------------------------------------------------------------- */

const NAV = [
  { id: 'home', label: 'Events', icon: 'trophy', path: '/' },
  { id: 'me', label: 'Profile', icon: 'person', path: '/me' },
];

function syncChip() {
  const s = store.syncState();
  if (!s.configured) {
    return html`<span class="sync" title="No backend configured — everything is saved on this device only.">
      ${raw(icon('station', 'icon-sm'))} On this device</span>`;
  }
  if (!s.online) {
    return html`<span class="sync offline">${raw(icon('wifiOff', 'icon-sm'))}
      Offline${s.pending ? html` · ${s.pending} waiting` : ''}</span>`;
  }
  if (s.pending) {
    return html`<span class="sync pending"><span class="dot"></span> Saving ${s.pending}</span>`;
  }
  return html`<span class="sync">${raw(icon('check', 'icon-sm'))} Saved</span>`;
}

function shell(inner, { title, subtitle, back, actions = '' }) {
  const route = parseRoute();
  const me = auth.currentPlayer();

  return html`
    <div class="app">
      <header class="top-bar">
        ${back
          ? html`<button class="btn btn-icon" data-act="go" data-path="${back}" aria-label="Back">${raw(icon('back'))}</button>`
          : html`<a class="btn btn-icon" href="../index.html" aria-label="BattyDev home">${raw(icon('home'))}</a>`}
        <h1>${title}${subtitle ? html`<span class="sub">${subtitle}</span>` : ''}</h1>
        ${raw(actions)}
        ${raw(syncChip())}
        <button class="btn btn-icon" data-act="theme" aria-label="Switch theme">${raw(icon('theme'))}</button>
      </header>

      <nav class="nav" aria-label="Sections">
        ${list(NAV.map((item) => html`
          <a class="nav-item" href="#${item.path}"
             ${raw(route.name === item.id || (item.id === 'home' && route.name !== 'me') ? 'aria-current="page"' : '')}>
            <span class="pill">${raw(icon(item.icon))}</span>
            <span>${item.label}</span>
          </a>`))}
        ${me
          ? html`<a class="nav-item" href="#/me"><span class="pill">${raw(icon('person'))}</span><span>${me.tag}</span></a>`
          : html`<button class="nav-item" data-act="sign-in"><span class="pill">${raw(icon('key'))}</span><span>Sign in</span></button>`}
      </nav>

      <main class="scaffold">${raw(inner)}</main>
    </div>`;
}

/* --------------------------------------------------------------------------
   Draw
   -------------------------------------------------------------------------- */

const root = document.getElementById('app');
let drawing = false;

export function draw() {
  /* Guard against re-entrancy: a view's render can call store.apply (for
     example, lazily creating a bracket), which notifies, which would draw
     again mid-draw. */
  if (drawing) return;
  drawing = true;
  try {
    const route = parseRoute();
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
    render(root, shell(out.body, out));
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

/* --------------------------------------------------------------------------
   Global actions
   -------------------------------------------------------------------------- */

on('go', ({ path }) => go(path));
on('noop', () => {});

on('theme', () => {
  const current = document.documentElement.dataset.theme;
  const next = current === 'dark' ? 'light' : current === 'light' ? '' : 'dark';
  if (next) document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('battydev.brackets.theme', next); } catch { /* private mode */ }
  snack(next ? `${next[0].toUpperCase()}${next.slice(1)} theme` : 'Following your system theme');
});

on('sign-in', () => authView.openSignIn(draw));
on('sign-out', async () => { await auth.signOut(); go('/'); snack('Signed out'); });

on('copy-text', async ({ text }) => {
  const { copy } = await import('./lib/ui.js');
  snack(await copy(text) ? 'Copied' : 'Could not copy — select it and copy by hand');
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

  /* Demo data only when there is no backend. With a project configured, an
     empty account should look empty -- seeding fiction into a real deployment
     would be indefensible. */
  const cfg = window.BRACKETS_CONFIG || {};
  store.boot({ demo: !cfg.url || !cfg.key });

  const client = await connect();
  if (client) {
    store.attach(client);
    await auth.initAuth(client);
    store.pull().then(draw);
  } else {
    await auth.initAuth(null);
  }

  store.subscribe(() => draw());
  auth.onAuth(() => draw());
  window.addEventListener('hashchange', draw);

  /* The run view has live countdowns (DQ timers, how long a set has been out).
     One shared tick rather than a timer per card, and only while a view that
     needs it is on screen -- a 1Hz repaint of an idle page is exactly the kind
     of thing that flattens a phone battery over a six-hour event. */
  setInterval(() => {
    if (parseRoute().name === 'admin') draw();
  }, 1000);

  draw();

  /* Sets up the "brackets" search param -> invite code shortcut, so a QR code
     on a flyer can be battydev.com/brackets/?join=TKN14B and land straight on
     the join screen. Query params survive Discord's link handling better than
     a hash does. */
  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get('join');
  if (joinCode) go(`/join/${joinCode.toUpperCase()}`, { replace: true });
}());

export { store, auth };
