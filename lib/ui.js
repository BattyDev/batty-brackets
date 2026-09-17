/* Brackets · rendering helpers
   ===========================================================================
   Strings in, innerHTML out, plus event delegation. There is no virtual DOM
   and no framework.

   That is a real position, not laziness. The heaviest screen in this app is a
   256-entrant double-elimination bracket, which is about 500 nodes. Building
   that as a string and assigning it once is a single parse and a single layout
   -- comfortably under a frame on a cheap Android phone. The framework version
   of the same screen ships a runtime, builds a tree, diffs it, and then does
   the same DOM write anyway.

   The cost of this choice is real and worth naming: no automatic escaping
   unless you use `html`, and no component state unless you put it somewhere.
   Both are handled below -- `html` escapes every interpolation by default, and
   scroll/focus preservation is explicit in `render`.

   ## Escaping

   `html` is a tagged template that escapes every `${}`. To interpolate markup
   you have already built, wrap it in `raw()`. That inversion -- safe by
   default, unsafe only when you say so -- is the entire reason to have it,
   because entrant tags are user input and they arrive from a CSV paste.
   =========================================================================== */

'use strict';

const RAW = Symbol('raw');

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/* Mark a string you built yourself as safe to interpolate. Idempotent, so
   raw(html`...`) is harmless. */
export const raw = (value) => {
  if (value && typeof value === 'object' && RAW in value) return value;
  const s = String(value ?? '');
  return { [RAW]: s, toString: () => s };
};

/* Returns a RAW-marked object, not a bare string.

   This is the detail that makes nesting work. Views are built as templates
   inside templates -- a card inside a list inside a pane -- and if `html`
   returned a plain string, the outer template would treat the inner one as
   untrusted text and escape its markup, so the page would render its own
   source. Marking the result means "this has already been through the
   escaper", so composition is safe and interpolating a raw string still is
   not.

   It carries a toString, so `el.innerHTML = html`...`` works unchanged. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += serialise(values[i]) + strings[i + 1];
  }
  return { [RAW]: out, toString: () => out };
}

function serialise(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value && typeof value === 'object' && RAW in value) return value[RAW];
  if (Array.isArray(value)) return value.map(serialise).join('');
  return esc(value);
}

/* Join an array of already-built html strings. `${list.map(...)}` works too --
   this exists so the intent reads at the call site. */
export const list = (items) => raw(items.join(''));

/* Build share links from the page that is actually serving the app. This keeps
   the canonical battybrackets.com deployment and the temporary legacy
   /brackets/ deployment usable during the cutover. */
export function joinUrl(code, location = globalThis.location) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('join', String(code || '').trim().toUpperCase());
  return url.href;
}

/* --------------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------------
   Replacing innerHTML throws away scroll position and focus, which on a
   bracket that re-renders after every reported set is the difference between
   usable and infuriating -- the TO scrolls to losers round 4, reports a set,
   and gets thrown back to the top.

   So `render` preserves both: it remembers the scroll offsets of anything
   marked `data-keep-scroll` and restores focus to the element with the same
   `data-focus-key`. Explicit rather than automatic, because guessing is how
   you end up stealing focus from a field the user just tabbed into.
   -------------------------------------------------------------------------- */

export function render(root, markup) {
  const scrolls = new Map();
  for (const node of root.querySelectorAll('[data-keep-scroll]')) {
    scrolls.set(node.dataset.keepScroll, { top: node.scrollTop, left: node.scrollLeft });
  }
  const focusKey = document.activeElement?.dataset?.focusKey || null;
  const selection = focusKey && 'selectionStart' in document.activeElement
    ? document.activeElement.selectionStart : null;

  root.innerHTML = String(markup);

  for (const node of root.querySelectorAll('[data-keep-scroll]')) {
    const saved = scrolls.get(node.dataset.keepScroll);
    if (saved) { node.scrollTop = saved.top; node.scrollLeft = saved.left; }
  }
  if (focusKey) {
    const target = root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (target) {
      target.focus();
      if (selection !== null && 'setSelectionRange' in target) {
        try { target.setSelectionRange(selection, selection); } catch { /* not a text input */ }
      }
    }
  }
}

/* --------------------------------------------------------------------------
   Event delegation
   --------------------------------------------------------------------------
   One listener per event type on the app root, dispatching on `data-act`.
   Re-rendering never has to rebind anything, and there is no listener leak
   because there is nothing to leak.
   -------------------------------------------------------------------------- */

const handlers = new Map();

export function on(action, fn) {
  handlers.set(action, fn);
}

export function bindDelegation(root) {
  const dispatch = (event, suffix = '') => {
    const target = event.target.closest(`[data-act${suffix ? `-${suffix}` : ''}]`);
    if (!target || !root.contains(target)) return;
    const action = suffix ? target.dataset[`act${suffix[0].toUpperCase()}${suffix.slice(1)}`] : target.dataset.act;
    const fn = handlers.get(action);
    if (!fn) return;
    /* Only prevent default for real activations of things that would navigate
       or submit; a checkbox toggling must keep its own behaviour. */
    if (event.type === 'click' && target.tagName !== 'INPUT' && target.tagName !== 'LABEL') {
      event.preventDefault();
    }
    fn(target.dataset, target, event);
  };

  root.addEventListener('click', (e) => dispatch(e));
  root.addEventListener('change', (e) => dispatch(e, 'change'));
  root.addEventListener('input', (e) => dispatch(e, 'input'));
  root.addEventListener('submit', (e) => { e.preventDefault(); dispatch(e, 'submit'); });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-act-enter]')) dispatch(e, 'enter');
  });
}

/* --------------------------------------------------------------------------
   Icons
   --------------------------------------------------------------------------
   Inline SVG paths rather than an icon font. A variable icon font is 200kB+
   and blocks first paint on a slow connection; these are about 3kB in total
   and are part of the JS bundle that has to load anyway.

   Stroke-based, 24x24, sharing the `.icon` class for sizing and currentColor.
   -------------------------------------------------------------------------- */

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V21H3z"/><path d="M9 21v-7h6v7"/>',
  trophy: '<path d="M8 21h8M12 17v4M6 4h12v5a6 6 0 0 1-12 0z"/><path d="M6 6H4a2 2 0 0 0 0 4h2M18 6h2a2 2 0 0 1 0 4h-2"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  group: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.5a3.2 3.2 0 0 1 0 6"/><path d="M17.5 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  tune: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  gavel: '<path d="m14 3 7 7-3 3-7-7z"/><path d="m9.5 7.5 7 7"/><path d="m3 21 6-6"/><path d="M4 21h8"/>',
  wifi: '<path d="M2 8.5a16 16 0 0 1 20 0"/><path d="M5 12a12 12 0 0 1 14 0"/><path d="M8.5 15.5a7 7 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>',
  wifiOff: '<path d="M2 8.5a16 16 0 0 1 6-3.6"/><path d="M14 5.2a16 16 0 0 1 8 3.3"/><path d="M19 12a12 12 0 0 0-3-1.9"/><path d="M5 12a12 12 0 0 1 3-1.9"/><circle cx="12" cy="19" r="1"/><path d="M3 3l18 18"/>',
  esports: '<path d="M7 12h4M9 10v4M15 11h.01M17.5 13h.01"/><rect x="2.5" y="7" width="19" height="10" rx="4"/>',
  map: '<path d="m9 4 6 2 6-2v14l-6 2-6-2-6 2V6z"/><path d="M9 4v14M15 6v14"/>',
  alert: '<path d="M12 8v5M12 16.5h.01"/><circle cx="12" cy="12" r="9"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  link: '<path d="M10 13a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6L11.5 6"/><path d="M14 11a4 4 0 0 0-5.6 0l-3 3A4 4 0 0 0 11 19.6L12.5 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>',
  station: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  shuffle: '<path d="M16 4h5v5"/><path d="M4 20 21 4"/><path d="M16 20h5v-5"/><path d="m4 4 6 6"/><path d="m14 14 7 7"/>',
  sort: '<path d="M7 4v16M7 20l-3-3M7 20l3-3"/><path d="M13 6h8M13 12h6M13 18h4"/>',
  edit: '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
  logout: '<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"/><path d="M15 8l4 4-4 4M19 12H9"/>',
  discord: '<path d="M8.5 8.5a11 11 0 0 1 7 0"/><path d="M8 16.5a11 11 0 0 0 8 0"/><path d="M8.5 8.5C6.5 9.5 5 12 5 15c0 1.5 1.5 3 3 3l1-2"/><path d="M15.5 8.5c2 1 3.5 3.5 3.5 6.5 0 1.5-1.5 3-3 3l-1-2"/><circle cx="9.5" cy="13" r="1"/><circle cx="14.5" cy="13" r="1"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="m11 11 8-8 2 2-2 2 2 2-2 2-2-2-2 2z"/>',
  bell: '<path d="M18 16v-5a6 6 0 0 0-12 0v5l-2 3h16z"/><path d="M10 22h4"/>',
  doc: '<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 17h4"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  bracket: '<path d="M3 5h4v6h4M3 19h4v-6"/><path d="M13 11h4V7h4M13 13h4v4h4"/>',
  undo: '<path d="M4 9h11a5 5 0 0 1 0 10h-6"/><path d="m4 9 4-4M4 9l4 4"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>',
  theme: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5"/>',
};

/* Returns a RAW-marked value, so `${icon('check')}` and `${raw(icon('check'))}`
   both work. A bare interpolation of a plain string would have rendered the
   SVG source as visible text, which is a mistake that looks like a rendering
   bug rather than an escaping one. */
export function icon(name, className = '') {
  const path = ICONS[name] || ICONS.info;
  return raw(`<svg class="icon ${esc(className)}" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`);
}

export const iconSprite = () => Object.keys(ICONS);

/* --------------------------------------------------------------------------
   Snackbar
   --------------------------------------------------------------------------
   One at a time, replacing rather than stacking. A stack of toasts on a phone
   covers the thing you just did.
   -------------------------------------------------------------------------- */

let snackTimer = null;

export function snack(message, { action, onAction, duration = 4500 } = {}) {
  document.querySelector('.snackbar')?.remove();
  clearTimeout(snackTimer);

  const bar = document.createElement('div');
  bar.className = 'snackbar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = html`<span class="spacer">${message}</span>`;

  if (action) {
    const button = document.createElement('button');
    button.textContent = action;
    button.addEventListener('click', () => { bar.remove(); onAction?.(); });
    bar.appendChild(button);
  }

  document.body.appendChild(bar);
  snackTimer = setTimeout(() => bar.remove(), duration);
}

/* --------------------------------------------------------------------------
   Dialogs
   --------------------------------------------------------------------------
   Native <dialog>. showModal gives focus trapping, Escape and inert background
   for free -- all things a hand-rolled modal gets wrong.
   -------------------------------------------------------------------------- */

export function dialog({ title, body, actions = [], full = false, onClose }) {
  document.querySelector('dialog.m3')?.remove();

  const el = document.createElement('dialog');
  el.className = `m3${full ? ' full' : ''}`;
  el.innerHTML = html`
    <form method="dialog" style="display:flex;flex-direction:column;max-height:inherit;margin:0">
      <div class="dialog-head"><h2>${title}</h2></div>
      <div class="dialog-body">${raw(body)}</div>
      <div class="dialog-actions">
        ${list(actions.map((a, i) => html`
          <button type="button" class="btn ${raw(a.kind === 'filled' ? 'btn-filled' : a.kind === 'danger' ? 'btn-danger' : a.kind === 'tonal' ? 'btn-tonal' : 'btn-text')}"
                  data-dialog-index="${i}">${a.label}</button>`))}
      </div>
    </form>`;

  document.body.appendChild(el);

  el.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-dialog-index]');
    if (!button) return;
    if (el.getAttribute('aria-busy') === 'true') return;
    const action = actions[Number(button.dataset.dialogIndex)];
    try {
      const pending = action.onClick?.(el);
      if (pending && typeof pending.then === 'function') {
        /* Do not close an async form before the server has answered. The old
           click handler compared the Promise itself with false, closed the
           dialog immediately, and then wrote any error into a detached note
           nobody could see. Keep the form in place and prevent double posts. */
        el.setAttribute('aria-busy', 'true');
        for (const control of el.querySelectorAll('.dialog-actions button')) control.disabled = true;
        const result = await pending;
        if (!el.isConnected) return;
        if (result !== false) { el.close(); return; }
        el.removeAttribute('aria-busy');
        for (const control of el.querySelectorAll('.dialog-actions button')) control.disabled = false;
        return;
      }
      /* An action returning false keeps the dialog open -- used by forms that
         failed validation and want to show an error in place. */
      if (pending !== false) el.close();
    } catch (error) {
      if (el.isConnected) {
        el.removeAttribute('aria-busy');
        for (const control of el.querySelectorAll('.dialog-actions button')) control.disabled = false;
      }
      console.error('[dialog] action failed', error);
    }
  });

  el.addEventListener('close', () => { onClose?.(); el.remove(); });
  el.showModal();
  el.querySelector('input, select, textarea, button')?.focus();
  return el;
}

export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false, onConfirm }) {
  return dialog({
    title,
    body: `<p class="body-medium">${esc(body)}</p>`,
    actions: [
      { label: 'Cancel', kind: 'text' },
      { label: confirmLabel, kind: danger ? 'danger' : 'filled', onClick: () => onConfirm?.() },
    ],
  });
}

/* --------------------------------------------------------------------------
   Formatting
   -------------------------------------------------------------------------- */

export function relativeTime(iso) {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  const mins = Math.round(diff / 60000);
  const abs = Math.abs(mins);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return rtf.format(mins, 'minute');
  if (abs < 60 * 24) return rtf.format(Math.round(mins / 60), 'hour');
  if (abs < 60 * 24 * 30) return rtf.format(Math.round(mins / 1440), 'day');
  return rtf.format(Math.round(mins / 43200), 'month');
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

/* How long a set has been out, as "9m 04s". Counts UP from when it was
   called, because that is the number a TO is watching against the DQ window. */
export function elapsed(iso) {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

/* --------------------------------------------------------------------------
   Live clocks without re-rendering
   --------------------------------------------------------------------------
   The run view has timers that have to tick every second. Redrawing the whole
   page to move them was the original approach and it was a bad one: it threw
   away scroll and focus, and -- the symptom that made it obvious -- it
   destroyed and recreated the guided-tour card once a second, so its slide-in
   animation replayed continuously and the panel appeared to flicker in and out.

   A clock is text. Updating the text is enough, and it costs a handful of
   property writes rather than rebuilding several hundred nodes. Anything
   carrying `data-live-since` gets its content refreshed in place; a threshold
   in `data-live-over` (minutes) toggles a class when it is passed, which is
   what turns a DQ timer red without a redraw.
   -------------------------------------------------------------------------- */
export function tickLiveClocks(root = document) {
  for (const node of root.querySelectorAll('[data-live-since]')) {
    const since = node.dataset.liveSince;
    node.textContent = elapsed(since);
    const limit = Number(node.dataset.liveOver || 0);
    if (!limit) continue;
    const past = (Date.now() - new Date(since).getTime()) / 60000 >= limit;
    node.closest('[data-live-scope]')?.classList.toggle('over', past);
    node.classList.toggle('over', past);
  }
}

export function countdown(iso) {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* Initials for an avatar. Handles a sponsor prefix ("BTY | Kira" -> K) so the
   circle shows who the person is rather than who sponsors them. */
export function initials(tag) {
  const name = String(tag || '?').replace(/^[^|]{1,12}\s*\|\s*/, '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase() || '?';
}

export function avatar(player, size = '') {
  if (!player) return html`<span class="avatar ${raw(size)}">?</span>`;
  if (player.avatarUrl) {
    return html`<span class="avatar ${raw(size)}"><img src="${player.avatarUrl}" alt="" loading="lazy"></span>`;
  }
  return html`<span class="avatar ${raw(size)}">${initials(player.tag)}</span>`;
}

/* Copy to clipboard with a fallback for insecure origins, where
   navigator.clipboard is undefined. Invite codes get copied constantly, so
   this failing silently on a http:// preview would be a real annoyance. */
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}
