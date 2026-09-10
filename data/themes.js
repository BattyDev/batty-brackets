/* Brackets · game theming
   ===========================================================================
   Picking a game should visibly change the app, not just change a label.

   ## What is here, and what is deliberately not

   There is no official Marvel Tōkon fan kit or press kit. Marvel Games and
   PlayStation Studios publish screenshots and trailers through their own
   channels, but neither ships a downloadable asset pack with usage terms
   attached, and the community sites that index the game are explicit that they
   host no official artwork either.

   That matters, because Marvel character art is Disney IP. A third-party
   tournament site redistributing it is a licensing question — not a fair-use
   one you can reason your way into, and not a decision this file should make on
   the site owner's behalf. So there is no Marvel artwork in this repository.

   What IS here is a full theming system built from things nobody owns:

     * a per-game tonal palette, generated properly (see "Colour" below) and
       applied through Material 3's own colour roles, so every button, chip,
       tab and focus ring inside a themed region picks the game up for free
     * original artwork, drawn here, that evokes the SHAPE of each game — a
       four-slot tag lineup for Tōkon, floating platforms for Smash
     * comic-printing texture (halftone dots, speed lines) for Tōkon, which is
       a printing technique from the 1890s and belongs to no one

   And an asset slot, so the real thing can be dropped in later without a code
   change. See `assets` on each theme and the README section "Official game
   artwork". If the site owner licenses art, or an official kit appears with
   terms that permit this use, filling in those paths is the whole job.

   ## Colour

   Each palette is a real M3 tonal ramp, generated from a seed by converting to
   OKLCH, stepping lightness evenly, and tapering chroma at the extremes so the
   light and dark tones stay inside sRGB. Even lightness steps are the point:
   the naive approach — darkening a hex by percentages — produces ramps whose
   perceived contrast jumps around, so a tone that passes for one hue fails for
   another.

   Every pairing the app actually renders was then checked against WCAG. The
   lowest of them is 9.3:1. There is a note against each ramp saying so, and
   `test/theme.test.mjs` re-checks them, because a palette nobody re-measures
   is a palette that drifts.

   ## How it is applied

   `themeStylesheet()` emits one <style> block covering every game, with rules
   scoped to `[data-game="<id>"]` and the same light/dark structure as the base
   sheet. Putting a `data-game` attribute on any container re-themes everything
   inside it — which is why the wizard, the event header and the admin console
   all pick up the game with no per-component work.
   =========================================================================== */

'use strict';

import { html, raw, esc } from '../lib/ui.js';

/* --------------------------------------------------------------------------
   The palettes
   --------------------------------------------------------------------------
   Generated from the seed named in each comment. Do not hand-edit a single
   tone -- regenerate the ramp, or the even-lightness property that makes the
   contrast predictable is lost.
   -------------------------------------------------------------------------- */

const RAMPS = {
  /* Seed #c0392b — a deep comic crimson. Lowest checked pairing 9.48:1. */
  tokon: {
    10: '#0e0000', 20: '#320000', 30: '#5a0804', 40: '#880c05', 50: '#b1291d',
    60: '#d44c3c', 70: '#f76d5a', 80: '#fda293', 90: '#fed2ca', 95: '#ffe9e4', 98: '#fff6f5',
  },
  /* Seed #d97706 — warm amber. Chosen over the obvious red-orange because
     Tōkon is already crimson and two red games are indistinguishable at
     thumbnail size in an events list, which is where the mark does its work.
     Lowest checked pairing 9.31:1. */
  ssbu: {
    10: '#0b0500', 20: '#251400', 30: '#432500', 40: '#6c3904', 50: '#8f4f06',
    60: '#b46708', 70: '#d9820f', 80: '#ffa65c', 90: '#ffdcb8', 95: '#ffeeda', 98: '#fff8f1',
  },
};

/* --------------------------------------------------------------------------
   The themes
   -------------------------------------------------------------------------- */

export const GAME_THEMES = {
  tokon: {
    ramp: RAMPS.tokon,
    /* The two-letter mark, and the colours it is drawn in. Held here rather
       than as one accent hex because the mark has to work on both a light and
       a dark surface, and a single colour cannot. */
    markBg: { light: RAMPS.tokon[40], dark: RAMPS.tokon[30] },
    markFg: { light: '#ffffff', dark: RAMPS.tokon[90] },
    motif: 'lineup',
    /* Shown under the game name. Not marketing copy -- it is what a TO needs
       to know about the shape of the game before they set an event up. */
    tagline: 'Four fighters, one health bar',

    /* ---- the asset slot ------------------------------------------------
       Every path is relative to `brackets/assets/games/tokon/`. Leave a value
       null and the drawn artwork below is used instead; fill one in and it
       takes over with no other change.

       Before filling any of these in, read the README section "Official game
       artwork" — the terms matter, and they are not this file's call. */
    assets: {
      hero: null,        // e.g. 'hero.jpg'   — 1600x600 or wider
      logo: null,        // e.g. 'logo.svg'   — transparent, light-on-dark
      icon: null,        // e.g. 'icon.png'   — square, 128px+
      characters: null,  // e.g. a folder of portraits keyed by character name
      credit: null,      // required if any of the above is set; see below
    },
  },

  ssbu: {
    ramp: RAMPS.ssbu,
    markBg: { light: RAMPS.ssbu[40], dark: RAMPS.ssbu[30] },
    markFg: { light: '#ffffff', dark: RAMPS.ssbu[90] },
    motif: 'platforms',
    tagline: 'Stocks, stages and stage striking',
    assets: { hero: null, logo: null, icon: null, characters: null, credit: null },
  },
};

export const themeFor = (gameId) => GAME_THEMES[gameId] || null;

/* --------------------------------------------------------------------------
   The stylesheet
   --------------------------------------------------------------------------
   One <style> for every game, injected once. Scoped on [data-game], with the
   same three-way light/dark structure the base sheet uses: bare rule is light,
   then the system-dark media query guarded against an explicit light choice,
   then the explicit dark attribute so the toggle wins in both directions.
   -------------------------------------------------------------------------- */

function roles(ramp, mode) {
  return mode === 'dark'
    ? {
      '--md-primary': ramp[80],
      '--md-on-primary': ramp[20],
      '--md-primary-container': ramp[30],
      '--md-on-primary-container': ramp[90],
      '--md-secondary-container': ramp[30],
      '--md-on-secondary-container': ramp[90],
      '--md-inverse-primary': ramp[40],
      '--game-accent': ramp[80],
      '--game-ink': ramp[95],
      '--game-deep': ramp[10],
    }
    : {
      '--md-primary': ramp[40],
      '--md-on-primary': '#ffffff',
      '--md-primary-container': ramp[90],
      '--md-on-primary-container': ramp[10],
      '--md-secondary-container': ramp[90],
      '--md-on-secondary-container': ramp[10],
      '--md-inverse-primary': ramp[80],
      '--game-accent': ramp[40],
      '--game-ink': ramp[20],
      '--game-deep': ramp[95],
    };
}

const block = (selector, vars) => `${selector}{${Object.entries(vars)
  .map(([k, v]) => `${k}:${v}`).join(';')}}`;

export function themeStylesheet() {
  const out = [];
  for (const [id, theme] of Object.entries(GAME_THEMES)) {
    const sel = `[data-game="${id}"]`;
    out.push(block(sel, roles(theme.ramp, 'light')));
    out.push(`@media (prefers-color-scheme: dark){${
      block(`:root:not([data-theme="light"]) ${sel}`, roles(theme.ramp, 'dark'))}}`);
    out.push(block(`:root[data-theme="dark"] ${sel}`, roles(theme.ramp, 'dark')));
  }
  return out.join('\n');
}

/* Injected once at boot. A <style> node rather than inline attributes because
   inline styles cannot answer a media query, and the theme has to follow the
   light/dark switch like everything else. */
export function installThemes() {
  if (document.getElementById('game-themes')) return;
  const style = document.createElement('style');
  style.id = 'game-themes';
  style.textContent = themeStylesheet();
  document.head.appendChild(style);
}

/* --------------------------------------------------------------------------
   Artwork
   --------------------------------------------------------------------------
   Two motifs, both drawn from the shape of the game rather than its
   characters.

   `lineup` — four slanted slots in a row, the front one lit. That is what a
   Tōkon team IS: an ordered squad of four where only the point fighter is
   active, and the others come in behind. It reads as a character-select strip
   without borrowing one.

   `platforms` — a main stage with two floating platforms above it, the
   silhouette every platform fighter shares.

   Both are inline SVG with `currentColor` and the theme variables, so they
   recolour with the theme and cost no request.
   -------------------------------------------------------------------------- */

function halftone(id, opacity = 0.5) {
  /* Ben-Day dots. A commercial printing technique from the 1890s, long out of
     any copyright, and the single strongest visual cue for "comic book" that
     does not involve anybody's character. */
  return `<pattern id="${id}" width="10" height="10" patternUnits="userSpaceOnUse">
    <circle cx="3" cy="3" r="2.1" fill="currentColor" opacity="${opacity}"/>
    <circle cx="8" cy="8" r="2.1" fill="currentColor" opacity="${opacity}"/>
  </pattern>`;
}

function lineupArt(uid) {
  /* Four slots. The first is the point fighter -- filled and forward -- and
     the three behind it step back and fade, which is the tag order. */
  const slots = [0, 1, 2, 3].map((i) => {
    const x = 40 + i * 132;
    const lit = i === 0;
    return `<g transform="translate(${x} ${28 + i * 10}) skewX(-9)">
      <rect width="104" height="${188 - i * 18}" rx="6"
            fill="${lit ? 'currentColor' : 'none'}"
            fill-opacity="${lit ? 0.9 : 0}"
            stroke="currentColor" stroke-width="3.5"
            stroke-opacity="${lit ? 1 : 0.8 - i * 0.15}"/>
      ${lit ? `<rect width="104" height="188" rx="6" fill="url(#ht-${uid})" opacity="0.28"/>` : ''}
      <rect x="16" y="${(188 - i * 18) - 26}" width="${52 - i * 8}" height="6" rx="3"
            fill="currentColor" fill-opacity="${lit ? 0.55 : 0.4 - i * 0.08}"/>
    </g>`;
  }).join('');

  /* Speed lines, raked to match the slot skew. */
  const speed = [0, 1, 2, 3, 4, 5].map((i) => {
    const y = 24 + i * 42;
    const w = 90 - (i % 3) * 26;
    return `<rect x="${560 + (i % 2) * 30}" y="${y}" width="${w}" height="5" rx="2.5"
             fill="currentColor" opacity="${0.5 - (i % 3) * 0.1}" transform="skewX(-9)"/>`;
  }).join('');

  return `${slots}${speed}`;
}

function platformsArt(uid) {
  return `
    <rect x="150" y="176" width="340" height="18" rx="9" fill="currentColor" opacity="0.92"/>
    <rect x="150" y="194" width="340" height="26" rx="6" fill="currentColor" opacity="0.34"/>
    <rect x="192" y="104" width="118" height="12" rx="6" fill="currentColor" opacity="0.72"/>
    <rect x="336" y="104" width="118" height="12" rx="6" fill="currentColor" opacity="0.72"/>
    <rect x="264" y="46" width="118" height="12" rx="6" fill="currentColor" opacity="0.5"/>
    <circle cx="322" cy="150" r="86" fill="url(#ht-${uid})" opacity="0.22"/>
    ${[0, 1, 2].map((i) => `<circle cx="${560 + i * 46}" cy="${70 + i * 54}" r="${16 - i * 3}"
        fill="none" stroke="currentColor" stroke-width="3" opacity="${0.4 - i * 0.1}"/>`).join('')}`;
}

/* A wide banner for the top of a themed page. `variant` trades height for
   context: 'hero' for the wizard and the event page, 'strip' for a list row. */
export function gameArt(gameId, { variant = 'hero', label = '' } = {}) {
  const theme = themeFor(gameId);
  if (!theme) return '';
  const uid = `${gameId}-${variant}`;
  const art = theme.motif === 'platforms' ? platformsArt(uid) : lineupArt(uid);
  const height = variant === 'strip' ? 84 : 240;

  return `<svg class="game-art game-art-${variant}" viewBox="0 0 720 240"
       preserveAspectRatio="xMidYMid slice" role="img"
       ${label ? `aria-label="${esc(label)}"` : 'aria-hidden="true"'}
       style="height:${height}px">
    <defs>${halftone(`ht-${uid}`, 0.55)}</defs>
    ${art}
  </svg>`;
}

/* --------------------------------------------------------------------------
   Components
   -------------------------------------------------------------------------- */

/* The square two-letter mark. Uses the theme's own foreground pair rather than
   white-on-accent, because white on a mid-tone accent is the exact pairing
   that fails contrast -- and it failed here before this existed. */
export function gameMark(game, { size = '' } = {}) {
  if (!game) return html`<span class="avatar ${raw(size)}" aria-hidden="true">?</span>`;
  return html`<span class="avatar game-mark ${raw(size)}" data-game="${game.id}" aria-hidden="true">${game.mark}</span>`;
}

/* The banner. Official art takes over the moment `assets.hero` is filled in;
   until then the drawn motif is used. Both go behind the same scrim and the
   same text, so swapping one for the other changes nothing else. */
export function gameHero(game, { title, subtitle, compact = false } = {}) {
  if (!game) return '';
  const theme = themeFor(game.id);
  const official = theme?.assets?.hero;

  return html`
    <div class="game-hero ${raw(compact ? 'compact' : '')}" data-game="${game.id}">
      <div class="game-hero-art" aria-hidden="true">
        ${official
          ? html`<img src="../assets/games/${game.id}/${official}" alt="" loading="lazy" decoding="async">`
          : raw(gameArt(game.id, { variant: compact ? 'strip' : 'hero' }))}
      </div>
      <div class="game-hero-body">
        <p class="game-hero-eyebrow">${game.name}</p>
        <h2 class="game-hero-title">${title || game.short}</h2>
        <!-- One supporting line, not two. The tagline is a fallback for when
             the caller has nothing more specific to say, not an extra. -->
        ${subtitle
          ? html`<p class="game-hero-sub">${subtitle}</p>`
          : (!official && theme?.tagline ? html`<p class="game-hero-sub">${theme.tagline}</p>` : '')}
      </div>
      ${theme?.assets?.credit
        ? html`<p class="game-hero-credit">${theme.assets.credit}</p>`
        : ''}
    </div>`;
}
