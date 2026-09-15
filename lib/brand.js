/* One publisher signature across the publication, working shell and broadcast.
   A bat silhouette sits inside square brackets: the name reads at icon size.
   Use the same geometry in the rail, wordmark and favicon so identity stays
   consistent; the solid wings and ears survive small sizes without fine detail.
   Keep it decorative: the adjacent product name supplies the accessible name. */
import { html, raw } from './ui.js';

export const brandMark = () => html`<svg class="brand-mark" viewBox="0 0 40 32" aria-hidden="true" focusable="false"><path d="M7 5H2v22h5M33 5h5v22h-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="square"/><path d="M8 10 16 14 17 8 20 11 23 8 24 14 32 10C31 16 29 19 27 22Q24 18 22 24L20 22 18 24Q16 18 13 22C11 19 9 16 8 10Z" fill="currentColor"/></svg>`;

export const brandSignature = () => html`${raw(brandMark())}<span>Batty Brackets<span class="brand-credit">By BattyDev</span></span>`;
