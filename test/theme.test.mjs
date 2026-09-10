/* Brackets · theme contrast proof
   ---------------------------------------------------------------------------
   Run: node brackets/test/theme.test.mjs

   The game palettes in data/themes.js are generated, not hand-picked, and the
   comments there claim specific contrast ratios. This re-measures them, so the
   claim cannot quietly stop being true — a palette nobody re-checks is a
   palette that drifts the first time someone nudges a tone "just a little
   darker".

   It checks every pairing the app ACTUALLY paints, in both schemes, against
   WCAG 2.1: 4.5:1 for body text, 3:1 for large text and for the non-text
   contrast of a component boundary.

   axe-core already checks the rendered page (see the audit in the README), and
   this is not a duplicate of that: axe can only see the combinations that
   happen to be on screen when it runs. This checks the palette itself, so a
   pairing that only appears on a rarely-visited screen still cannot regress.
   --------------------------------------------------------------------------- */

import { GAME_THEMES } from '../data/themes.js';

let passed = 0;
let failed = 0;

const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => srgbToLin(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function check(label, fg, bg, min) {
  const ratio = contrast(fg, bg);
  if (ratio >= min) { passed += 1; return; }
  failed += 1;
  console.error(`  FAIL  ${label}\n        ${fg} on ${bg} = ${ratio.toFixed(2)}:1, needs ${min}:1`);
}

/* The base surfaces a themed region sits on, from brackets.css. */
const SURFACE = { light: '#f8fafa', dark: '#101416' };
const SURFACE_LOW = { light: '#f2f4f5', dark: '#191c1d' };

for (const [id, theme] of Object.entries(GAME_THEMES)) {
  console.log(`\n${id}`);
  const r = theme.ramp;

  /* ---- light scheme ---- */
  /* primary=40, on-primary=#fff, primary-container=90, on-…-container=10 */
  check('light: on-primary on primary (button label)', '#ffffff', r[40], 4.5);
  check('light: primary as text on surface (links, eyebrow)', r[40], SURFACE.light, 4.5);
  check('light: primary as text on a low container', r[40], SURFACE_LOW.light, 4.5);
  check('light: on-primary-container on primary-container (chips)', r[10], r[90], 4.5);
  /* The hero: ink=20 on deep=95 */
  check('light: hero text on hero ground', r[20], r[95], 4.5);
  /* Component boundary — the 2px ring on a selected card. */
  check('light: primary outline against surface', r[40], SURFACE.light, 3);

  /* ---- dark scheme ---- */
  check('dark: on-primary on primary (button label)', r[20], r[80], 4.5);
  check('dark: primary as text on surface', r[80], SURFACE.dark, 4.5);
  check('dark: primary as text on a low container', r[80], SURFACE_LOW.dark, 4.5);
  check('dark: on-primary-container on primary-container', r[90], r[30], 4.5);
  check('dark: hero text on hero ground', r[95], r[10], 4.5);
  check('dark: primary outline against surface', r[80], SURFACE.dark, 3);

  /* The two-letter mark, which is what actually failed an audit before the
     theme system existed: white on a mid-tone accent. */
  check('light: mark', theme.markFg.light, theme.markBg.light, 4.5);
  check('dark: mark', theme.markFg.dark, theme.markBg.dark, 4.5);
}

/* The marks also have to be distinguishable from EACH OTHER, or two games look
   the same in an events list — which is the one place the mark does real work.
   Not a WCAG rule; a design one, checked here because it is measurable.

   Measured as a distance in OKLab, NOT as a contrast ratio. Contrast is the
   wrong tool for this and using it here was a real mistake worth recording:
   Tōkon's crimson and Smash's amber sit at almost identical luminance, so
   their contrast ratio against each other is ~1.1 and a contrast-based check
   calls them identical — when in fact they are obviously different colours
   that differ almost entirely in hue. WCAG contrast answers "can I read text
   on this"; it says nothing about "can I tell these two swatches apart".
   Perceptual distance answers the question actually being asked. */
function oklab(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => srgbToLin(parseInt(h.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

const deltaE = (a, b) => {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

console.log('\ndistinctness');
const ids = Object.keys(GAME_THEMES);
/* 0.05 in OKLab is comfortably past "just noticeable" (~0.02) and is about
   where two swatches stop being mistakeable for one another at the 32px the
   mark is actually rendered at. */
const MIN_DISTANCE = 0.05;
for (let i = 0; i < ids.length; i += 1) {
  for (let j = i + 1; j < ids.length; j += 1) {
    for (const tone of [40, 80]) {
      const a = GAME_THEMES[ids[i]].ramp[tone];
      const b = GAME_THEMES[ids[j]].ramp[tone];
      const d = deltaE(a, b);
      if (d >= MIN_DISTANCE) { passed += 1; continue; }
      failed += 1;
      console.error(`  FAIL  ${ids[i]} and ${ids[j]} tone ${tone} are too close:`
        + ` ${a} vs ${b}, distance ${d.toFixed(3)} (need ${MIN_DISTANCE})`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
