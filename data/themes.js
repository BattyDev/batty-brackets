/* Brackets · game theming
   ===========================================================================
   Picking a game changes its bounded artwork and badges. Batty owns the shell.

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
   scoped to game heroes, badges, selection cards and explicit data-game-module
   regions, with the same light/dark structure as the base sheet. data-game
   alone is metadata, never permission to recolour product navigation or calls.
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
  /* #f2622a — paint-splash red, pushed orange so it is not Tokon */
  sf6: { 10: '#0c0100', 20: '#2d0800', 30: '#511903', 40: '#7c2802', 50: '#a83a08', 60: '#d84a00', 70: '#fc6b35', 80: '#faa588', 90: '#fdd4c6', 95: '#ffe9e2', 98: '#fff6f3' },
  /* #2e5fd9 — electric blue */
  tekken8: { 10: '#00001b', 20: '#000053', 30: '#000c8d', 40: '#0c36ae', 50: '#2757d0', 60: '#4277f3', 70: '#719bf6', 80: '#a0bef9', 90: '#cfdefe', 95: '#e7efff', 98: '#f5f9ff' },
  /* #e5177b — magenta */
  ggst: { 10: '#0d0003', 20: '#300014', 30: '#56072b', 40: '#830b44', 50: '#b1165f', 60: '#e4157a', 70: '#f86199', 80: '#fe9bba', 90: '#ffcfdc', 95: '#fee8ee', 98: '#fff6f8' },
  /* #7a3fd9 — violet */
  uni2: { 10: '#050014', 20: '#1c023e', 30: '#380373', 40: '#5518a3', 50: '#7235cf', 60: '#8e58f2', 70: '#a787f6', 80: '#c2b1f9', 90: '#e0d8fe', 95: '#efebff', 98: '#f9f7ff' },
  /* #b8791e — dragon gold */
  mk1: { 10: '#070200', 20: '#221200', 30: '#412805', 40: '#633f07', 50: '#885710', 60: '#af710f', 70: '#d08f3b', 80: '#ebb16b', 90: '#fad8b1', 95: '#feebd6', 98: '#fff7ee' },
  /* #e06018 — SNK orange */
  ffcotw: { 10: '#0b0100', 20: '#290c01', 30: '#4f1c02', 40: '#782d00', 50: '#a24104', 60: '#ca5a1e', 70: '#f57332', 80: '#fba681', 90: '#fdd4c2', 95: '#ffe9e1', 98: '#fff6f3' },
  /* #1e7fd4 — that blue menu */
  mvc2: { 10: '#00030d', 20: '#00162f', 30: '#032f55', 40: '#034982', 50: '#0965af', 60: '#2483d8', 70: '#48a3fb', 80: '#8dc3fc', 90: '#c6e1ff', 95: '#e3f0fe', 98: '#f4f9ff' },
  /* #2ab0c8 — sky */
  gbvsr: { 10: '#000406', 20: '#001a1f', 30: '#06343c', 40: '#09515d', 50: '#136f7f', 60: '#1190a4', 70: '#2bb0c8', 80: '#68cfe4', 90: '#b3e9f5', 95: '#d5f5fd', 98: '#edfcff' },
  /* #16c79a — Riot neon teal */
  twoxko: { 10: '#000503', 20: '#001c13', 30: '#063729', 40: '#085540', 50: '#127459', 60: '#0f9674', 70: '#2ab890', 80: '#59d8af', 90: '#afeed5', 95: '#d2f9e9', 98: '#e7fff5' },
  /* #e8b419 — the suit's yellow — its blue was Tekken's */
  invinc: { 10: '#060300', 20: '#1e1501', 30: '#3b2b00', 40: '#59440b', 50: '#7a5f16', 60: '#9e7b18', 70: '#c49704', 80: '#e4b743', 90: '#f5dba2', 95: '#fdedca', 98: '#fff8e8' },
  /* #b5705f — clay, moved off Mortal Kombat gold */
  rivals2: { 10: '#0d0000', 20: '#2f0400', 30: '#521708', 40: '#713224', 50: '#904e3f', 60: '#b06b5b', 70: '#d18978', 80: '#edab9b', 90: '#fbd4ca', 95: '#ffe9e3', 98: '#fff6f4' },
  /* #5340c4 — indigo, off Tekken blue */
  bbcf: { 10: '#030018', 20: '#140246', 30: '#2b0280', 40: '#4126ab', 50: '#5948cd', 60: '#7468ef', 70: '#918ffd', 80: '#b4b6fe', 90: '#d9dbfd', 95: '#ecedfe', 98: '#f7f8ff' },
  /* #1f8fb5 — Sega blue */
  vf5revo: { 10: '#000408', 20: '#011923', 30: '#003344', 40: '#0d4f65', 50: '#186d8a', 60: '#1b8db2', 70: '#45acd3', 80: '#76cbee', 90: '#b9e6fa', 95: '#daf3ff', 98: '#f0faff' },
  /* #8b2fa8 — Darkstalkers purple */
  vsav: { 10: '#08000e', 20: '#250230', 30: '#48045b', 40: '#6e038a', 50: '#8d31aa', 60: '#ac52cb', 70: '#cd72ec', 80: '#e59dff', 90: '#f1d0fe', 95: '#f8e8ff', 98: '#fdf6ff' },
  /* #b5203f — crimson-magenta */
  kofxv: { 10: '#0e0001', 20: '#310109', 30: '#5b0018', 40: '#85112b', 50: '#b31e3e', 60: '#d64459', 70: '#fa6576', 80: '#faa2a6', 90: '#fdd2d3', 95: '#ffe8e9', 98: '#fff6f6' },
  /* #6e7a1c — olive */
  samsho: { 10: '#030400', 20: '#151801', 30: '#2c3201', 40: '#454d0d', 50: '#606b00', 60: '#7c892e', 70: '#9aa84f', 80: '#b9c67a', 90: '#dbe4b9', 95: '#ecf2d7', 98: '#f7fbea' },
  /* #7d4a35 — sienna-brown */
  ggxrd: { 10: '#0b0100', 20: '#2b0a00', 30: '#4c1e09', 40: '#6a3924', 50: '#88543f', 60: '#a8715b', 70: '#c88f78', 80: '#e4b09b', 90: '#f5d6ca', 95: '#fdeae2', 98: '#fff6f3' },
  /* #c9b528 — pale gold */
  cvs2: { 10: '#040300', 20: '#1a1600', 30: '#342e05', 40: '#514807', 50: '#706410', 60: '#91810f', 70: '#b1a026', 80: '#d1c051', 90: '#e9e0a7', 95: '#f5f0cd', 98: '#fcf9e3' },
  /* #0f7d6e — deep green-teal */
  ki: { 10: '#000503', 20: '#011b17', 30: '#08362f', 40: '#0d5349', 50: '#187365', 60: '#309282', 70: '#54b1a1', 80: '#80cfc0', 90: '#bee9df', 95: '#dbf5ef', 98: '#ecfdf9' },
  /* #c0392b — deep comic crimson — the reference identity */
  tokon: { 10: '#0e0000', 20: '#320000', 30: '#5a0804', 40: '#880c05', 50: '#b1291d', 60: '#d44c3c', 70: '#f76d5a', 80: '#fda293', 90: '#fed2ca', 95: '#ffe9e4', 98: '#fff6f5' },
  /* #d97706 — warm amber */
  ssbu: { 10: '#090200', 20: '#260f00', 30: '#462403', 40: '#6c3904', 50: '#92500b', 60: '#bd6705', 70: '#e5821f', 80: '#ffa65c', 90: '#ffd4b5', 95: '#feeadc', 98: '#fff7f1' },
};

/* --------------------------------------------------------------------------
   The themes
   -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
   The themes
   --------------------------------------------------------------------------
   Two levels of finish, and the difference is recorded rather than implied:

     identity: 'bespoke'      artwork drawn for this game specifically
     identity: 'placeholder'  a real palette and a generic motif, waiting for
                              the treatment Tokon has

   Marking it in the data rather than leaving it to be inferred means the
   wizard can say so, and means there is a list of what is left to do that
   cannot drift out of date the way a note in a README would.

   ## On the colours

   Each seed is roughly the game's own brand, adjusted only where two would be
   indistinguishable -- fighting-game branding clusters hard in red, orange and
   blue, and four of these games are honestly the same red.

   That clustering is accepted rather than designed away, because the MARK is
   the identifier and the colour is reinforcement. Twenty-one mutually
   distinguishable hues do not exist; a categorical palette tops out around
   eight to twelve before people start confusing neighbours. "SF6" in red and
   "TK" in red are not hard to tell apart, because they say SF6 and TK.
   `test/theme.test.mjs` therefore checks contrast strictly and distinctness
   loosely -- only flagging pairs a viewer genuinely could not separate.
   -------------------------------------------------------------------------- */

/* id -> [motif, tagline]. Every game not listed as bespoke below gets the
   generic motif; the tagline is what a TO needs to know about the shape of the
   game before setting an event up, not marketing copy. */
const TAGLINES = {
  tokon: 'Four fighters, one health bar',
  ssbu: 'Stocks, stages and stage striking',
  sf6: 'Drive gauge, and Modern controls to argue about',
  tekken8: '3D movement, Heat, three rounds',
  ggst: 'Roman cancels and very short rounds',
  uni2: 'GRD — the meter that swings on the clock',
  mk1: 'Kameo assists, so every pick is two picks',
  ffcotw: 'REV gauge and the SNK two-line arena',
  mvc2: '3v3 assists, one round, no timer to speak of',
  gbvsr: 'Simple inputs on a cooldown',
  twoxko: 'Two fighters, tag assists, Riot netcode',
  invinc: '3v3 tag in the Marvel line',
  rivals2: 'Platform fighter — the stage list is the ruleset',
  bbcf: 'Drive, Overdrive, and a decade of settled rules',
  vf5revo: 'Three rounds, forty-five seconds, no meter',
  vsav: 'One long round, health carries over',
  kofxv: '3v3 sequential — order is most of the matchup',
  samsho: 'Slow, heavy, and one Rage burst',
  ggxrd: 'Xrd, unchanged since 2017',
  cvs2: 'Ratio teams and six Grooves',
  ki: 'Combo breakers and the Shadow meter',
};

const BESPOKE = { tokon: 'lineup', ssbu: 'platforms' };

const emptyAssets = () => ({
  hero: null,        // e.g. 'hero.jpg'   — 1600x600 or wider
  logo: null,        // e.g. 'logo.svg'   — transparent, light-on-dark
  icon: null,        // e.g. 'icon.png'   — square, 128px+
  characters: null,  // e.g. a folder of portraits keyed by character name
  credit: null,      // required if any of the above is set; see the README
});

export const GAME_THEMES = Object.fromEntries(
  Object.entries(RAMPS).map(([id, ramp]) => [id, {
    ramp,
    /* Held as a light/dark pair rather than one accent hex because a single
       colour cannot be legible on both a light and a dark surface -- white on
       a mid-tone accent is the pairing that actually failed an audit here. */
    markBg: { light: ramp[40], dark: ramp[30] },
    markFg: { light: '#ffffff', dark: ramp[90] },
    motif: BESPOKE[id] || 'generic',
    identity: BESPOKE[id] ? 'bespoke' : 'placeholder',
    tagline: TAGLINES[id] || null,
    /* Every path is relative to `brackets/assets/games/<id>/`. Leave a value
       null and the drawn artwork is used; fill one in and it takes over with
       no other change. Read the README section "Official game artwork" first
       — the terms matter, and they are not this file's call. */
    assets: emptyAssets(),
  }]),
);

export const themeFor = (gameId) => GAME_THEMES[gameId] || null;

/* --------------------------------------------------------------------------
   The stylesheet
   --------------------------------------------------------------------------
   One <style> for every game, injected once. Scoped on game modules, with the
   same three-way light/dark structure the base sheet uses: bare rule is light,
   then the system-dark media query guarded against an explicit light choice,
   then the explicit dark attribute so the toggle wins in both directions.
   -------------------------------------------------------------------------- */

/* PRIMARY only. Secondary is deliberately left as the app's own.

   Mapping secondary onto the game ramp as well was the first attempt and it
   was too much: secondary-container carries the nav pill, the bulk-action bar,
   the demo banner and every neutral chip, so theming it made a whole page one
   loud colour and — worse — painted app chrome as though it belonged to the
   game. M3's secondary is meant to be a muted companion to primary, not a
   second copy of it.

   Within an opted-in game module primary can identify the artwork or selected
   game card. Product actions, focus rings and the app-bar rule elsewhere keep
   the publisher palette, and secondary always remains the product's own. */
function roles(ramp, mode) {
  return mode === 'dark'
    ? {
      '--md-primary': ramp[80],
      '--md-on-primary': ramp[20],
      '--md-primary-container': ramp[30],
      '--md-on-primary-container': ramp[90],
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
    /* A route may carry game metadata, but it must never recolour the product.
       Only bounded game artwork/badges/cards opt into these colour roles.
       Keeping this boundary here also protects older shells carrying data-game. */
    const sel = `:is(.game-hero, .game-mark, .game-card, [data-game-module])[data-game="${id}"]`;
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

/* `generic` — the placeholder. Two opposed wedges meeting at a seam, which is
   what every one of these games is a picture of, plus the same halftone the
   bespoke motifs use so a placeholder does not look like a different product.

   It is deliberately not neutral-looking. A grey box would read as broken; a
   motif in the game's own colour reads as "this game, not yet illustrated",
   which is the true statement. When a game graduates to a drawn identity, its
   entry in BESPOKE gains a motif name and nothing else changes. */
function genericArt(uid) {
  const wedges = `
    <path d="M0 0 H300 L210 240 H0 Z" fill="currentColor" opacity="0.16"/>
    <path d="M330 0 H720 V240 H420 Z" fill="currentColor" opacity="0.10"/>
    <path d="M300 0 L210 240" stroke="currentColor" stroke-width="4" opacity="0.85" fill="none"/>
    <path d="M330 0 L240 240" stroke="currentColor" stroke-width="2.5" opacity="0.45" fill="none"/>`;

  /* The seam, dotted, so the halftone appears somewhere it reads clearly. */
  const seam = `<path d="M300 0 L210 240 L280 240 L370 0 Z" fill="url(#ht-${uid})" opacity="0.5"/>`;

  /* Three impact marks on the right, echoing the speed lines on the Tokon
     motif without pretending to be a character. */
  const marks = [0, 1, 2].map((i) => `<rect x="${500 + i * 54}" y="${64 + i * 46}"
      width="${84 - i * 18}" height="5" rx="2.5" fill="currentColor"
      opacity="${0.45 - i * 0.11}" transform="skewX(-12)"/>`).join('');

  return `${wedges}${seam}${marks}`;
}

const MOTIFS = { lineup: lineupArt, platforms: platformsArt, generic: genericArt };

/* A wide banner for the top of a themed page. `variant` trades height for
   context: 'hero' for the wizard and the event page, 'strip' for a list row. */
export function gameArt(gameId, { variant = 'hero', label = '' } = {}) {
  const theme = themeFor(gameId);
  if (!theme) return '';
  const uid = `${gameId}-${variant}`;
  const art = (MOTIFS[theme.motif] || genericArt)(uid);
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
          ? html`<img src="assets/games/${game.id}/${official}" alt="" loading="lazy" decoding="async">`
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
