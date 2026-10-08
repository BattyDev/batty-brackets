/* Brackets · Options
   ===========================================================================
   The things a person changes about their OWN view: their ink, the paper, and
   which account they are using. None of it belongs to an event, and none of it
   sits between a player and their next set -- it is one button in the
   masthead and nothing on the event pages.

   Changes preview live on the page behind the dialog and are only kept on
   Save. Closing any other way puts back exactly what was saved.
   =========================================================================== */

'use strict';

import { html, raw, list, icon, dialog, snack } from '../lib/ui.js';
import * as auth from '../lib/auth.js';
import * as appearance from '../lib/appearance.js';

const PAPER = [
  { id: '', label: 'Match device' },
  { id: 'light', label: 'Paper' },
  { id: 'dark', label: 'Night' },
];

export function openOptions({ storedTheme, previewTheme, commitTheme, signIn, signOut }) {
  const start = appearance.saved();
  const startTheme = storedTheme();
  const draft = { ...start };
  let theme = startTheme;
  let kept = false;
  let cleared = false;

  const me = auth.currentPlayer();
  const isPreset = (color) => appearance.PRESETS.some((preset) => preset.color === color);

  const el = dialog({
    title: 'Options',
    body: html`
      <section class="options-section" aria-labelledby="options-ink">
        <h3 id="options-ink">Your ink</h3>
        <p>The bright color used across the site. The paper takes a faint matching tint.</p>
        <div class="ink-choices" role="group" aria-label="Ink color">
          ${list(appearance.PRESETS.map((preset) => html`
            <button type="button" class="ink-choice" data-ink="${preset.color}" style="--swatch:${raw(preset.color)}">
              <span class="ink-swatch" aria-hidden="true"></span>${preset.label}</button>`))}
        </div>
        <div class="ink-custom">
          <button type="button" class="ink-choice ink-custom-choice" data-ink="custom">
            <span class="ink-swatch" aria-hidden="true" data-custom-swatch></span>Your color</button>
          <label class="field-label" for="ink-custom-input" style="margin:0">Favorite color</label>
          <input type="color" id="ink-custom-input" value="${start.color}">
          <output for="ink-custom-input" data-ink-output>${start.color.toUpperCase()}</output>
        </div>
        <div class="ink-preview" aria-hidden="true">
          <span class="ink-preview-slab">Your ink</span>
          <span class="btn btn-filled btn-sm">Button</span>
          <a>Link text</a>
          <span class="chip chip-static chip-ok">Checked in</span>
          <span class="chip chip-static chip-error">Error</span>
        </div>
      </section>

      <section class="options-section" aria-labelledby="options-lettering">
        <h3 id="options-lettering">Lettering</h3>
        <p>Choose your poster lettering. Phones use a matching heavy condensed face when these fonts aren't available.</p>
        <div class="segmented segmented-block" role="group" aria-label="Poster lettering">
          ${list(appearance.LETTERING.map((face) => html`
            <button type="button" data-lettering="${face.id}">${face.label}</button>`))}
        </div>
      </section>

      <section class="options-section" aria-labelledby="options-paper">
        <h3 id="options-paper">Paper</h3>
        <p>Light paper, or the night print for a dark venue.</p>
        <div class="segmented segmented-block" role="group" aria-label="Light or dark">
          ${list(PAPER.map((option) => html`
            <button type="button" data-paper="${option.id}">${option.label}</button>`))}
        </div>
      </section>

      <section class="options-section" aria-labelledby="options-account">
        <h3 id="options-account">Account</h3>
        <p>${me
          ? `Ink is saved on this device for ${me.tag}. Someone else signing in here keeps their own.`
          : 'Ink is saved on this device for signed-out browsing. Sign in and your choice is kept under your own name.'}</p>
        <div class="options-account">
          ${me
            ? html`<span class="spacer">Signed in as <b>${me.tag}</b></span>
                <button type="button" class="btn btn-outlined btn-sm" data-options-account="sign-out">${raw(icon('logout', 'icon-sm'))} Sign out</button>`
            : html`<span class="spacer">Not signed in</span>
                <button type="button" class="btn btn-outlined btn-sm" data-options-account="sign-in">${raw(icon('person', 'icon-sm'))} Sign in</button>`}
        </div>
      </section>`,
    actions: [
      { label: 'Reset to default', kind: 'text', onClick: () => {
        draft.color = appearance.DEFAULT_COLOR;
        draft.lettering = appearance.DEFAULT_LETTERING;
        cleared = true;
        paint();
        return false;
      } },
      { label: 'Cancel', kind: 'text' },
      { label: 'Save', kind: 'filled', onClick: () => {
        kept = true;
        const untouchedDefault = cleared && draft.color === appearance.DEFAULT_COLOR
          && draft.lettering === appearance.DEFAULT_LETTERING;
        const stored = untouchedDefault ? appearance.reset() : appearance.save(draft);
        commitTheme(theme);
        snack(stored ? 'Options saved' : 'Saved for this visit — this browser is not keeping settings');
      } },
    ],
    onClose: () => {
      if (kept) return;
      appearance.apply(start);
      previewTheme(startTheme);
    },
  });

  function paint() {
    appearance.apply(draft);
    previewTheme(theme);
    const custom = !isPreset(draft.color);
    for (const button of el.querySelectorAll('[data-ink]')) {
      const pressed = button.dataset.ink === 'custom' ? custom : button.dataset.ink === draft.color;
      button.setAttribute('aria-pressed', String(pressed));
    }
    el.querySelector('[data-custom-swatch]').style.background = draft.color;
    el.querySelector('#ink-custom-input').value = draft.color;
    el.querySelector('[data-ink-output]').textContent = draft.color.toUpperCase();
    for (const button of el.querySelectorAll('[data-lettering]')) {
      button.setAttribute('aria-pressed', String(button.dataset.lettering === draft.lettering));
    }
    for (const button of el.querySelectorAll('[data-paper]')) {
      button.setAttribute('aria-pressed', String(button.dataset.paper === theme));
    }
  }

  el.addEventListener('click', (event) => {
    const ink = event.target.closest('[data-ink]');
    if (ink) {
      if (ink.dataset.ink === 'custom') el.querySelector('#ink-custom-input').click();
      else { draft.color = ink.dataset.ink; paint(); }
      return;
    }
    const lettering = event.target.closest('[data-lettering]');
    if (lettering) { draft.lettering = lettering.dataset.lettering; paint(); return; }
    const paper = event.target.closest('[data-paper]');
    if (paper) { theme = paper.dataset.paper; paint(); return; }
    const account = event.target.closest('[data-options-account]');
    if (account) {
      /* Restore the discarded preview before changing identity. close() queues
         its event; signing out first would let onClose repaint the old ink. */
      el.addEventListener('close', () => {
        if (account.dataset.optionsAccount === 'sign-in') signIn(); else signOut();
      }, { once: true });
      el.close();
    }
  });
  el.addEventListener('input', (event) => {
    if (event.target.id !== 'ink-custom-input') return;
    draft.color = event.target.value.toLowerCase();
    paint();
  });

  paint();
  return el;
}
