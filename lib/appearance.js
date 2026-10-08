/* Brackets · personal ink
   ===========================================================================
   One bright ink per person. The paper, the soft tints and the readable
   variants of the ink are all derived from that single colour, so a favourite
   colour can never leave somebody with unreadable buttons.

   ## Whose preference this is

   It belongs to the PERSON, not the event and not the browser. On a shared
   desk laptop the host and a walk-up player each get their own ink, so the
   saved value is keyed by the signed-in player id, with one separate slot for
   whoever is using the site signed out. Nothing here is written to an event,
   and nothing is sent to the server: this is device storage scoped to an
   identity, not cross-device sync.

   ## What is derived, and where

   The paper tints are `color-mix()` in brackets.css, straight from `--accent`.
   Only the values that need a contrast decision are computed here:

     --accent           the chosen colour, used for slabs, stamps and fills
     --accent-ink       text on top of the chosen colour
     --accent-art-paper a lighter art ground when the chosen ink is too dark
     --accent-on-paper  the colour pulled toward black until it reads on paper
     --accent-on-ink    the colour pulled toward cream until it reads on black

   Status colours (warning, error, success) are not derived from any of this.
   =========================================================================== */

'use strict';

import * as auth from './auth.js';

export const PRESETS = [
  { id: 'red', label: 'Red', color: '#d6294e' },
  { id: 'purple', label: 'Purple', color: '#8c46d6' },
];
export const DEFAULT_COLOR = PRESETS[0].color;

/* The heavy lettering is not a personal requirement; the three faces stay
   selectable so the shortlist can be compared in the real app. */
export const LETTERING = [
  { id: 'impact', label: 'Impact' },
  { id: 'tall', label: 'Haettenschweiler' },
  { id: 'franklin', label: 'Franklin Condensed' },
];
export const DEFAULT_LETTERING = LETTERING[0].id;

const STORAGE_KEY = 'battydev.brackets.appearance.v1';
const INK = '#151614';
const CREAM = '#fff7eb';
/* Worst-case grounds the readable variants have to clear: the darkest light
   tint and the lightest dark tint a label can sit on. */
const LIGHT_SOFT = '#e0dbd0';
const DARK_SOFT = '#2c2b27';

const isHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex(channels) {
  return `#${channels.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
}

/* `amount` of `a` laid into `b`, the same reading as CSS color-mix(a amount, b). */
export function mix(a, b, amount) {
  const [x, y] = [rgb(a), rgb(b)];
  return hex(x.map((c, i) => c * amount + y[i] * (1 - amount)));
}

function luminance(color) {
  const [r, g, b] = rgb(color).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* Walk the colour toward `target` until it clears 4.5:1 on `ground`. Stepping
   keeps as much of the chosen hue as the ground allows, instead of jumping
   straight to black the moment a pale yellow fails. */
function readable(color, ground, target) {
  for (let step = 0; step <= 25; step += 1) {
    const candidate = mix(target, color, step / 25);
    if (contrast(candidate, ground) >= 4.5) return candidate;
  }
  return target;
}

export function palette(color) {
  const accent = isHex(color) ? color.toLowerCase() : DEFAULT_COLOR;
  const accentInk = [INK, CREAM, '#ffffff']
    .sort((a, b) => contrast(b, accent) - contrast(a, accent))[0];
  return {
    accent,
    accentInk,
    /* The bat stays black ink. Dark favourites lighten its paper instead. */
    accentArtPaper: contrast(INK, accent) >= 3 ? accent : mix(accent, CREAM, 0.32),
    accentOnPaper: readable(accent, mix(accent, LIGHT_SOFT, 0.14), INK),
    accentOnInk: readable(accent, mix(accent, DARK_SOFT, 0.14), CREAM),
  };
}

/* --------------------------------------------------------------------------
   Storage, keyed by identity
   -------------------------------------------------------------------------- */

function readAll() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return parsed && typeof parsed === 'object' && parsed.byIdentity && typeof parsed.byIdentity === 'object'
      ? parsed : { byIdentity: {} };
  } catch { return { byIdentity: {} }; }
}

function writeAll(all) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); return true; }
  catch { return false; }  /* private mode: the choice lasts for this page */
}

export function identityKey() {
  const me = auth.currentPlayer();
  return me?.id ? `player:${me.id}` : 'signed-out';
}

function clean(value) {
  return {
    color: isHex(value?.color) ? value.color.toLowerCase() : DEFAULT_COLOR,
    lettering: LETTERING.some((face) => face.id === value?.lettering) ? value.lettering : DEFAULT_LETTERING,
  };
}

export function saved() {
  return clean(readAll().byIdentity[identityKey()]);
}

export function hasSaved() {
  return Boolean(readAll().byIdentity[identityKey()]);
}

export function save(value) {
  const all = readAll();
  all.byIdentity[identityKey()] = clean(value);
  /* Remembered separately so the next page load can paint this ink before the
     session has been restored, instead of flashing the default first. */
  all.lastApplied = all.byIdentity[identityKey()];
  const stored = writeAll(all);
  apply(value);
  return stored;
}

export function reset() {
  const all = readAll();
  delete all.byIdentity[identityKey()];
  delete all.lastApplied;
  const stored = writeAll(all);
  apply(clean(null));
  return stored;
}

/* --------------------------------------------------------------------------
   Applying
   -------------------------------------------------------------------------- */

/* Paints a value without saving it, which is also what the live preview in
   Options uses. */
export function apply(value = saved()) {
  const { color, lettering } = clean(value);
  const tones = palette(color);
  const root = document.documentElement;
  root.style.setProperty('--accent', tones.accent);
  root.style.setProperty('--accent-ink', tones.accentInk);
  root.style.setProperty('--accent-art-paper', tones.accentArtPaper);
  root.style.setProperty('--accent-on-paper', tones.accentOnPaper);
  root.style.setProperty('--accent-on-ink', tones.accentOnInk);
  if (lettering === DEFAULT_LETTERING) delete root.dataset.lettering;
  else root.dataset.lettering = lettering;
}

/* Before the session exists. Uses the last ink painted on this device, then
   `apply()` corrects it once the real identity is known. */
export function applyEarly() {
  const last = readAll().lastApplied;
  apply(last ? clean(last) : clean(null));
}

/* After sign-in, sign-out or a session restore: switch to that person's ink. */
export function syncIdentity() {
  const value = saved();
  const all = readAll();
  if (hasSaved()) all.lastApplied = value; else delete all.lastApplied;
  writeAll(all);
  apply(value);
}
