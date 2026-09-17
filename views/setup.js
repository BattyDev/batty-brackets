/* Brackets · event setup
   ===========================================================================
   Five steps: game, shape, rules, registration, publish.

   ## Why a wizard and not one long form

   A long form is faster for someone who already knows every answer, and every
   TO setting up their first Tokon event does not. The steps exist so that the
   rules step can be SKIPPED — pick a preset, move on — which is the path
   almost everyone should take. Presets are the default and hand-tuning is the
   exception, rather than a wall of forty selects that implies all forty are
   decisions you need to make today.

   ## The rules step renders itself

   It is generated from `data/games.js`. Nothing in this file knows what a
   team-change rule is or that Smash has stages. That is what makes adding a
   third game a data change: see the note at the top of the game registry.
   =========================================================================== */

'use strict';

import { html, raw, list, icon, on, snack, dialog, joinUrl } from '../lib/ui.js';
import * as store from '../lib/store.js';
import * as auth from '../lib/auth.js';
import { GAMES, gameById, resolveRuleset, allFields, fieldVisible, evoLabel } from '../data/games.js';
import { gameArt, gameHero, gameMark, themeFor } from '../data/themes.js';

/* Wizard state.
   --------------------------------------------------------------------------
   Not a store row: a half-finished event is not an event, and writing draft
   rows for every abandoned setup would litter the database with them.

   It IS persisted to localStorage, though, which it was not at first. The
   reason is the sign-in gate at the end: signing in with Discord leaves the
   page entirely and comes back through an OAuth redirect, and a draft held
   only in a module variable does not survive that. Somebody who has picked a
   game, named the event, tuned four rules and set up sign-ups would come back
   to an empty first step -- which is a good way to make sure they never sign
   in again.

   So the lifetime is "until you publish it or discard it", across reloads and
   redirects, on this device. Still nothing on a server. */
const DRAFT_KEY = 'battydev.brackets.draft';
let draft = null;
let publishing = false;

function saveDraft() {
  try {
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* private mode: the draft is still fine in memory */ }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    /* Merge over a fresh draft rather than trusting the stored shape. A draft
       saved before a field existed would otherwise arrive with it undefined
       and take a view down with it. */
    return { ...freshDraft(), ...JSON.parse(raw) };
  } catch { return null; }
}

function discardDraft() {
  draft = null;
  saveDraft();
}

function freshDraft() {
  return {
    step: 0,
    gameId: null,
    name: '',
    format: 'double',
    venueType: 'offline',
    venue: '',
    platforms: [],
    startsAt: defaultStart(),
    capacity: '',
    stationCount: '',
    entryFee: '',
    currency: 'USD',
    presetId: null,
    overrides: {},
    documents: [{ id: 'doc_coc', title: 'Code of conduct', required: true, version: 1 }],
    visibility: 'public',
    provisionalRulesReviewed: false,
    gameSearch: '',
  };
}

/* Next Tuesday at 7pm, because that is what a weekly is. A default that is
   nearly right beats an empty field a TO has to think about. */
function defaultStart() {
  const d = new Date();
  d.setDate(d.getDate() + ((2 - d.getDay() + 7) % 7 || 7));
  d.setHours(19, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STEPS = ['Game', 'Shape', 'Rules', 'Sign-ups', 'Publish'];

export function view(ctx) {
  if (!draft) draft = loadDraft() || freshDraft();
  const game = draft.gameId ? gameById(draft.gameId) : null;

  return {
    title: 'New event',
    subtitle: STEPS[draft.step],
    back: draft.step === 0 ? '/host' : null,
    gameId: draft.gameId,
    body: html`
      <div class="pane setup-workspace" style="max-width:760px">
        <header class="setup-heading"><p class="eyebrow">CREATE AN EVENT · STEP ${draft.step + 1} OF ${STEPS.length}</p><h2>${STEPS[draft.step]}</h2></header>
        <div class="row" style="margin-bottom:20px;gap:6px">
          ${list(STEPS.map((label, i) => html`
            <button class="chip ${raw(i === draft.step ? 'selected' : '')}"
                    data-act="wizard-step" data-step="${i}"
                    ${raw(i > draft.step && !draft.gameId ? 'disabled' : '')}
                    aria-pressed="${i === draft.step}">
              ${i < draft.step ? raw(icon('check', 'icon-sm')) : ''}${label}
            </button>`))}
        </div>

        ${raw([stepGame, stepShape, stepRules, stepSignups, stepPublish][draft.step](ctx, game))}
      </div>`,
  };
}

/* --------------------------------------------------------------------------
   1 — game
   -------------------------------------------------------------------------- */

function stepGame() {
  return html`
    <h2 class="headline-small" style="margin-bottom:4px">What are you running?</h2>
    <p class="body-medium dim" style="margin-bottom:16px">
      The game decides which settings exist. You can change everything later, including after the bracket is made.
    </p>
    <div class="row" style="gap:8px;margin-bottom:16px">
      <label class="field spacer" style="max-width:320px">
        <input type="search" placeholder="Search ${GAMES.length} games" value="${draft.gameSearch || ''}"
               data-act-input="wizard-game-search" data-focus-key="game-search"
               style="min-height:44px;padding:10px 12px" aria-label="Search games">
      </label>
    </div>

    <div class="grid-cards">
      ${list(visibleGames().map((game) => html`
        <button class="card card-outlined game-card" data-act="wizard-game" data-game="${game.id}"
                aria-pressed="${draft.gameId === game.id}">
          <span class="game-card-art">${raw(gameArt(game.id, { variant: 'hero' }))}</span>
          <div class="row" style="flex-wrap:nowrap">
            ${raw(gameMark(game))}
            <div class="spacer">
              <b class="title-medium">${game.short}</b>
              <!-- Only when it says something the short name did not. Half these
                   games are known by their full title, and printing
                   "Tekken 8 / Tekken 8" reads as a bug. -->
              ${game.name !== game.short ? html`<div class="body-small dim">${game.name}</div>` : ''}
              ${themeFor(game.id)?.tagline ? html`<div class="body-small" style="color:var(--md-primary)">${themeFor(game.id).tagline}</div>` : ''}
            </div>
          </div>
          ${evoLabel(game) ? html`
            <p class="body-small" style="margin:10px 0 0;color:var(--md-primary)">
              ${raw(icon('trophy', 'icon-sm'))} ${evoLabel(game)}
            </p>` : ''}
          <p class="body-small dim" style="margin:8px 0 0">
            ${allFields(game).length} settings · ${game.platforms.map((p) => p.label).join(', ')}
          </p>
          ${game.presets.some((p) => p.provisional) ? html`
            <p class="body-small" style="margin:8px 0 0;color:var(--md-tertiary)">
              ${raw(icon('alert', 'icon-sm'))} Ruleset is provisional — the scene has not settled it yet.
            </p>` : ''}
        </button>`))}
    </div>
    ${visibleGames().length === 0 ? html`
      <div class="empty">${raw(icon('search'))}
        <p class="body-medium">Nothing matches “${draft.gameSearch}”.</p>
      </div>` : ''}

    <div class="card card-filled" style="margin-top:20px">
      <b class="title-small">Not here?</b>
      <p class="body-small dim" style="margin:4px 0 0">
        This is every title from Evo 2025 and Evo 2026, plus Tokon and Smash Ultimate.
        A game is data — a few lines naming its platforms and which ruleset shape it uses,
        with the shared settings assembled from <span class="code">data/rulesets.js</span>.
        Adding one touches neither the bracket engine nor the organiser tools.
      </p>
    </div>`;
}

/* Search over name, short name and mark, so "kof", "King of Fighters" and
   "KOF XV" all find the same thing. With twenty-one games the list is past
   the point where scanning it is pleasant. */
function visibleGames() {
  const q = (draft.gameSearch || '').trim().toLowerCase();
  if (!q) return GAMES;
  return GAMES.filter((g) => `${g.name} ${g.short} ${g.mark}`.toLowerCase().includes(q));
}

/* --------------------------------------------------------------------------
   2 — shape
   -------------------------------------------------------------------------- */

function stepShape(ctx, game) {
  return html`
    ${raw(gameHero(game, { title: 'The basics', subtitle: 'Everything here stays editable later.' }))}
    <h2 class="sr-only">The basics</h2>

    <div class="stack">
      <label class="field">
        <span class="field-label">Event name</span>
        <input type="text" data-act-input="wizard-field" data-field="name"
               value="${draft.name}" placeholder="${game?.short || 'Game'} Tuesdays #1">
      </label>

      <div>
        <p class="label-large" style="margin-bottom:8px">Bracket format</p>
        <div class="segmented segmented-block">
          ${list([
            ['double', 'Double elim'],
            ['single', 'Single elim'],
          ].map(([value, label]) => html`
            <button type="button" data-act="wizard-set" data-field="format" data-value="${value}"
                    aria-pressed="${draft.format === value}">${label}</button>`))}
        </div>
        <p class="field-help">
          ${draft.format === 'double'
            ? 'Everyone gets a second chance. Roughly twice as many sets — budget about 8 minutes a set per station.'
            : 'Half the sets, but one bad match ends someone\'s night. Fine when you are short on time or stations.'}
        </p>
      </div>

      <div>
        <p class="label-large" style="margin-bottom:8px">Where</p>
        <div class="segmented segmented-block">
          ${list([['offline', 'At a venue'], ['online', 'Online']].map(([value, label]) => html`
            <button type="button" data-act="wizard-set" data-field="venueType" data-value="${value}"
                    aria-pressed="${draft.venueType === value}">${label}</button>`))}
        </div>
      </div>

      ${draft.venueType === 'offline' ? html`
        <label class="field">
          <span class="field-label">Venue</span>
          <input type="text" data-act-input="wizard-field" data-field="venue"
                 value="${draft.venue}" placeholder="Batty Mac Arcade, back room">
        </label>` : ''}

      ${game?.platforms?.length > 1 || draft.venueType === 'online' ? html`
        <div>
          <p class="label-large" style="margin-bottom:8px">Platforms</p>
          <div class="row" style="gap:8px">
            ${list((game?.platforms || []).map((p) => html`
              <button class="chip" data-act="wizard-platform" data-value="${p.value}"
                      aria-pressed="${draft.platforms.includes(p.value)}">
                ${draft.platforms.includes(p.value) ? raw(icon('check', 'icon-sm')) : ''}${p.label}
              </button>`))}
          </div>
          <p class="field-help">
            ${draft.venueType === 'online'
              ? 'Checked at sign-up: an entrant with no ID for a platform you run on is flagged before the set is called, not after.'
              : 'What the venue actually has. The run view will not send a PC-only entrant to a console station.'}
          </p>
        </div>` : ''}

      <label class="field">
        <span class="field-label">Starts</span>
        <input type="datetime-local" data-act-input="wizard-field" data-field="startsAt" value="${draft.startsAt}">
      </label>

      <div class="row" style="gap:16px;align-items:flex-start">
        <label class="field spacer" style="min-width:140px">
          <span class="field-label">Entrant capacity (optional)</span>
          <input type="number" min="2" data-act-input="wizard-field" data-field="capacity"
                 value="${draft.capacity}" placeholder="No limit"
                 aria-describedby="capacity-help">
        </label>
        ${draft.venueType === 'offline' ? html`
          <label class="field spacer" style="min-width:140px">
            <span class="field-label">Stations available</span>
            <input type="number" min="1" max="64" data-act-input="wizard-field" data-field="stationCount"
                   value="${draft.stationCount}" placeholder="Enter actual count"
                   aria-describedby="station-help">
          </label>` : ''}
        <label class="field spacer" style="min-width:140px">
          <span class="field-label">Entry fee</span>
          <input type="number" min="0" data-act-input="wizard-field" data-field="entryFee"
                 value="${draft.entryFee}" placeholder="0">
        </label>
      </div>
      <div class="field-help" style="margin-top:-8px">
        <p id="capacity-help" style="margin:0 0 4px">Over the capacity goes on a waitlist rather than being turned away — locals always get drop-outs.</p>
        ${draft.venueType === 'offline' ? html`<p id="station-help" style="margin:0">Enter the number of stations you can actually run. Labels and platforms can be adjusted after creation.</p>` : ''}
      </div>
    </div>`;
}

/* --------------------------------------------------------------------------
   3 — rules
   -------------------------------------------------------------------------- */

function stepRules(ctx, game) {
  if (!game) return html`<p>Pick a game first.</p>`;
  const presetId = draft.presetId || game.presets[0].id;
  const preset = game.presets.find((p) => p.id === presetId);
  const ruleset = resolveRuleset(game, presetId, draft.overrides);
  const changed = Object.keys(draft.overrides).length;

  return html`
    ${raw(gameHero(game, { title: 'Rules', subtitle: 'Pick a preset and move on — everything below is optional.' }))}
    <h2 class="sr-only">Rules</h2>

    <div class="stack" style="margin-bottom:24px">
      ${list(game.presets.map((p) => html`
        <button class="card card-outlined" data-act="wizard-preset" data-preset="${p.id}"
                style="${raw(p.id === presetId ? 'box-shadow:inset 0 0 0 2px var(--md-primary)' : '')}">
          <div class="row" style="flex-wrap:nowrap;align-items:flex-start">
            <div class="spacer">
              <div class="row-tight">
                <b class="title-medium">${p.name}</b>
                <span class="chip chip-static chip-assist" style="min-height:22px;padding:0 8px;font:var(--label-small)">v${p.version}</span>
                ${p.provisional ? html`<span class="chip chip-static chip-warn" style="min-height:22px;padding:0 8px;font:var(--label-small)">Provisional</span>` : ''}
              </div>
              <p class="body-medium" style="margin:6px 0 0">${p.summary}</p>
              <p class="body-small dim" style="margin:6px 0 0">${p.source}</p>
            </div>
            ${p.id === presetId ? raw(icon('check')) : ''}
          </div>
        </button>`))}
    </div>

    ${preset?.provisional ? html`
      <div class="banner banner-warn" style="margin-bottom:20px">
        ${raw(icon('alert'))}
        <div>
          <b>This ruleset is a starting point, not a standard.</b>
          <div class="body-small" style="margin-top:4px">
            ${game.short} is new enough that nobody has ratified a competitive ruleset. This one is
            assembled from what neighbouring tag fighters settled on. Read it, change what you disagree
            with, and know that your players will see it marked provisional too — so an argument at the
            station is about the rule, not about who decided it.
          </div>
        </div>
      </div>` : ''}

    <details ${raw(changed ? 'open' : '')}>
      <summary class="title-medium" style="cursor:pointer;padding:12px 0">
        Change individual settings${changed ? ` · ${changed} changed` : ''}
      </summary>

      ${list(game.settingGroups
        .filter((group) => fieldVisible(group, { ...ruleset.values, venueType: draft.venueType }))
        .map((group) => html`
          <section class="card card-outlined" style="margin-bottom:12px">
            <div class="row-tight" style="margin-bottom:12px;color:var(--md-primary)">
              ${raw(icon(group.icon || 'tune'))}<b class="title-medium">${group.title}</b>
            </div>
            <div class="stack">
              ${list(group.fields
                .filter((field) => fieldVisible(field, { ...ruleset.values, venueType: draft.venueType }))
                .map((field) => settingControl(field, ruleset.values[field.key], game)))}
            </div>
          </section>`))}
    </details>`;
}

/* One control per field type. This is the only place that knows how a `choice`
   differs from a `multi`, which is what keeps games as data. */
function settingControl(field, value, game) {
  const overridden = field.key in draft.overrides;
  const help = html`${field.help ? html`<p class="field-help">${field.help}</p>` : ''}`;

  const labelRow = html`
    <div class="row-tight" style="margin-bottom:6px">
      <span class="label-large">${field.label}</span>
      ${overridden ? html`
        <button class="chip chip-warn" style="min-height:22px;padding:0 8px;font:var(--label-small)"
                data-act="wizard-reset-field" data-field="${field.key}">changed · reset</button>` : ''}
    </div>`;

  if (field.type === 'toggle') {
    return html`
      <div>
        <label class="switch">
          <input type="checkbox" ${raw(value ? 'checked' : '')}
                 data-act-change="wizard-setting" data-field="${field.key}" data-type="toggle">
          <span class="track"><span class="thumb"></span></span>
          <span class="label-large spacer">${field.label}</span>
          ${overridden ? html`<span class="chip chip-warn chip-static" style="min-height:22px;padding:0 8px;font:var(--label-small)">changed</span>` : ''}
        </label>
        ${help}
      </div>`;
  }

  if (field.type === 'choice') {
    /* Up to three options get segmented buttons — one tap, no menu, and they
       are legible on a phone. More than that becomes a select, because five
       segments at 360px wide is unreadable. */
    if (field.options.length <= 3) {
      return html`
        <div>
          ${labelRow}
          <div class="segmented segmented-block">
            ${list(field.options.map((opt) => html`
              <button type="button" data-act="wizard-setting" data-field="${field.key}"
                      data-type="choice" data-value="${opt.value}" aria-pressed="${value === opt.value}"
                      title="${opt.help || ''}">${opt.label}</button>`))}
          </div>
          ${raw(optionHelp(field, value))}
          ${help}
        </div>`;
    }
    return html`
      <div>
        ${labelRow}
        <label class="field">
          <select data-act-change="wizard-setting" data-field="${field.key}" data-type="choice">
            ${list(field.options.map((opt) => html`
              <option value="${opt.value}" ${raw(opt.value === value ? 'selected' : '')}>${opt.label}</option>`))}
          </select>
          ${raw(icon('chevronDown', 'select-arrow'))}
        </label>
        ${raw(optionHelp(field, value))}
        ${help}
      </div>`;
  }

  if (field.type === 'multi') {
    const selected = Array.isArray(value) ? value : [];
    const options = field.key === 'bannedCharacters' ? (game.characters || []).map((c) => ({ value: c, label: c })) : field.options;
    return html`
      <div>
        ${labelRow}
        <div class="row" style="gap:6px">
          ${list(options.map((opt) => html`
            <button class="chip" data-act="wizard-setting" data-field="${field.key}"
                    data-type="multi" data-value="${opt.value}" aria-pressed="${selected.includes(opt.value)}">
              ${selected.includes(opt.value) ? raw(icon('check', 'icon-sm')) : ''}${opt.label}
            </button>`))}
        </div>
        ${help}
      </div>`;
  }

  if (field.type === 'longtext') {
    return html`
      <div>
        <label class="field">
          <span class="field-label">${field.label}</span>
          <textarea data-act-change="wizard-setting" data-field="${field.key}" data-type="text"
                    rows="4">${value || ''}</textarea>
        </label>
        ${help}
      </div>`;
  }

  const isNumber = field.type === 'number' || field.type === 'duration';
  return html`
    <div>
      <label class="field">
        <span class="field-label">${field.label}${field.unit ? ` (${field.unit})` : ''}</span>
        <input type="${raw(isNumber ? 'number' : 'text')}"
               ${raw(field.min !== undefined ? `min="${field.min}"` : '')}
               ${raw(field.max !== undefined ? `max="${field.max}"` : '')}
               placeholder="${field.placeholder || ''}"
               value="${value ?? ''}"
               data-act-change="wizard-setting" data-field="${field.key}"
               data-type="${raw(isNumber ? 'number' : 'text')}">
      </label>
      ${help}
    </div>`;
}

/* The chosen option's own help text, under the control. A TO reading "Loser
   may change, winner locked" still needs to know what that MEANS in a 4v4 tag
   game, and putting it behind a hover tooltip means nobody on a phone ever
   sees it. */
function optionHelp(field, value) {
  const opt = (field.options || []).find((o) => o.value === value);
  return opt?.help ? html`<p class="field-help">${opt.help}</p>` : '';
}

/* --------------------------------------------------------------------------
   4 — sign-ups
   -------------------------------------------------------------------------- */

function stepSignups() {
  return html`
    <h2 class="headline-small" style="margin-bottom:20px">Sign-ups</h2>

    <div class="card card-outlined" style="margin-bottom:16px">
      <div class="row-tight" style="margin-bottom:12px;color:var(--md-primary)">
        ${raw(icon('doc'))}<b class="title-medium">Things people sign</b>
      </div>
      <div class="stack-sm">
        ${list(draft.documents.map((doc, i) => html`
          <div class="row" style="gap:8px;flex-wrap:nowrap">
            <input class="spacer" type="text" value="${doc.title}"
                   data-act-input="wizard-doc-title" data-index="${i}"
                   style="padding:8px;border:1px solid var(--md-outline-variant);border-radius:var(--shape-xs);background:transparent;color:inherit;font:var(--body-medium)">
            <button class="chip ${raw(doc.required ? 'selected' : '')}" data-act="wizard-doc-required"
                    data-index="${i}" aria-pressed="${doc.required}">Required</button>
            <button class="btn btn-icon" data-act="wizard-doc-remove" data-index="${i}" aria-label="Remove">${raw(icon('trash'))}</button>
          </div>`))}
        <button class="btn btn-text" data-act="wizard-doc-add">${raw(icon('plus'))} Add a document</button>
      </div>
      <p class="field-help" style="padding-left:0">
        Acceptance is recorded per entrant with a timestamp and the document version, so
        “they agreed to the code of conduct” is a fact with a date on it rather than a memory.
        A required document blocks check-in until it is signed.
      </p>
      <div class="banner banner-warn" style="margin-top:12px">
        ${raw(icon('alert'))}
        <div class="body-small">
          <b>If under-18s can enter, this is not enough on its own.</b>
          A minor cannot give consent, so a waiver needs a guardian — and that is a real legal
          question for your venue, not a checkbox. This records agreement; it does not make it valid.
        </div>
      </div>
    </div>

    ${auth.isRemote() ? html`
      <div class="card card-outlined">
        <div class="row-tight" style="margin-bottom:8px;color:var(--md-primary)">
          ${raw(icon('key'))}<b class="title-medium">How people find it</b>
        </div>
        <p class="body-medium dim" style="margin:0 0 16px">
          Publishing generates a short invite code and a link. The code is readable over a PA
          and has no 0, O, 1 or I in it. Anyone can enter with either; you can also add people
          yourself, in bulk, from a spreadsheet.
        </p>

        <p class="label-large" style="margin-bottom:8px">Who can find it</p>
        <div class="segmented segmented-block">
          ${list([['public', 'Listed'], ['unlisted', 'Unlisted']].map(([value, label]) => html`
            <button type="button" data-act="wizard-set" data-field="visibility" data-value="${value}"
                    aria-pressed="${(draft.visibility || 'public') === value}">${label}</button>`))}
        </div>
        <p class="field-help" style="padding-left:0">
          ${(draft.visibility || 'public') === 'unlisted'
            ? 'Reachable only with the code or the link — it will not appear on the events list. Right for an invitational, a private house session, or an event you are still filling before you announce it.'
            : 'Appears on the events list for anyone browsing the site. Right for a weekly you want people to turn up to.'}
          You can change this at any time from the event\'s settings, including after it has started.
        </p>
        ${(draft.visibility || 'public') === 'unlisted' ? html`
          <div class="banner banner-warn" style="margin-top:12px">
            ${raw(icon('alert'))}
            <div class="body-small">
              <b>Unlisted is not secret.</b> Anyone who has the link or the code can open it and see
              the entrant list, and anyone they pass it to can too. It hides the event from browsing;
              it does not lock it.
            </div>
          </div>` : ''}
      </div>` : html`
      <div class="banner banner-info local-device-note">
        ${raw(icon('station'))}
        <div>
          <b>Device-only sign-ups</b>
          <p class="body-small" style="margin:4px 0 0">
            This event and its entrant list stay on this device until a backend is connected.
            There is no working invite code or join link for another phone. Add people here,
            then connect this computer to the venue TV if you want a room display.
          </p>
        </div>
      </div>`}`;
}

/* --------------------------------------------------------------------------
   5 — publish
   -------------------------------------------------------------------------- */

function stepPublish(ctx, game) {
  const presetId = draft.presetId || game?.presets[0].id;
  const ruleset = game ? resolveRuleset(game, presetId, draft.overrides) : null;
  const preset = game?.presets.find((p) => p.id === presetId);
  const remote = auth.isRemote();
  const problems = validate(game);

  return html`
    ${raw(gameHero(game, { title: 'Ready?' }))}
    <h2 class="sr-only">Ready to publish</h2>

    <div class="card card-elevated" style="margin-bottom:16px">
      <h3 class="title-large">${draft.name || `${game?.short} event`}</h3>
      <div class="body-medium dim">${game?.name}</div>
      <hr class="divider" style="margin:12px 0">
      <dl style="margin:0">
        ${raw(summaryRow('Format', draft.format === 'double' ? 'Double elimination' : 'Single elimination'))}
        ${raw(summaryRow('Where', draft.venueType === 'online' ? 'Online' : draft.venue || 'A venue'))}
        ${raw(summaryRow('Starts', draft.startsAt.replace('T', ' ')))}
        ${raw(summaryRow('Entry', draft.entryFee ? `$${draft.entryFee}` : 'Free'))}
        ${raw(summaryRow('Entrant capacity', draft.capacity ? `${draft.capacity} then waitlist` : 'No limit'))}
        ${draft.venueType === 'offline' ? raw(summaryRow('Stations', draft.stationCount || '—')) : ''}
        ${raw(summaryRow('Ruleset', ruleset ? `${ruleset.presetName} v${ruleset.presetVersion}${Object.keys(draft.overrides).length ? ` · ${Object.keys(draft.overrides).length} changed` : ''}` : '—'))}
        ${raw(summaryRow('Signing', draft.documents.filter((d) => d.required).map((d) => d.title).join(', ') || 'Nothing required'))}
        ${remote ? raw(summaryRow('Visible', draft.visibility === 'unlisted' ? 'Unlisted — code or link only' : 'Listed publicly')) : ''}
      </dl>
    </div>

    ${preset?.provisional ? html`
      <section class="card card-outlined" style="margin-bottom:16px">
        <div class="row-tight" style="margin-bottom:8px;color:var(--md-tertiary)">
          ${raw(icon('alert'))}<b class="title-medium">Organizer review required</b>
        </div>
        <p class="body-medium" style="margin:0 0 12px">
          This ${game.short} preset is provisional: the scene has not ratified these competitive
          conventions. Open the Rules step, read the selected values and any changes, then confirm
          what you will enforce. Players will see that the rules are provisional too.
        </p>
        <label class="row" style="gap:10px;align-items:flex-start">
          <input type="checkbox" data-act-change="wizard-provisional-review"
                 ${raw(draft.provisionalRulesReviewed ? 'checked' : '')}>
          <span class="body-medium">I reviewed the provisional rules for this event and accept them as the organizer.</span>
        </label>
      </section>` : ''}

    ${problems.length ? html`
      <div class="banner banner-error" style="margin-bottom:16px">
        ${raw(icon('alert'))}
        <div><b>Fix these first</b><ul style="margin:6px 0 0;padding-left:20px">
          ${list(problems.map((p) => html`<li class="body-small">${p}</li>`))}
        </ul></div>
      </div>` : ''}

    ${auth.isSignedIn() ? '' : html`
      <div class="banner banner-info" style="margin-bottom:16px">
        ${raw(icon('person'))}
        <div>
          <b>You will be asked to sign in</b>
          <p class="body-small" style="margin:4px 0 0">Everything above is saved on this device, so signing in will not lose any of it. An event has other people's names on it — it needs an organiser attached to it.</p>
        </div>
      </div>`}

    ${remote ? html`
      <div class="banner banner-info" style="margin-bottom:16px">
        ${raw(icon('check'))}
        <div><b>This event will be published online.</b>
          <p class="body-small" style="margin:4px 0 0">You will get a shareable invite code and link after the server confirms creation. The draft stays on this device if publishing fails.</p>
        </div>
      </div>` : ''}

    <button class="btn btn-filled btn-lg btn-block" data-act="wizard-publish"
            ${raw(problems.length || publishing ? 'disabled' : '')}>
      ${raw(icon('check'))} ${publishing ? 'Creating…' : (auth.isSignedIn() ? 'Create the event' : 'Sign in and create the event')}
    </button>
    <p class="body-small dim" style="text-align:center;margin-top:12px">
      Nothing here is final — every setting stays editable while the event is running.
    </p>`;
}

function summaryRow(label, value) {
  return html`<div class="rules-row"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function validate(game) {
  const out = [];
  if (!game) out.push('Pick a game.');
  if (!draft.name.trim()) out.push('Give the event a name.');
  if (draft.venueType === 'offline' && !draft.venue.trim()) out.push('Say where it is.');
  if (draft.venueType === 'online' && !draft.platforms.length) out.push('Pick at least one platform — an online event needs to know what people are playing on.');
  if (draft.capacity !== '' && (!Number.isInteger(Number(draft.capacity)) || Number(draft.capacity) < 2)) {
    out.push('Entrant capacity must be a whole number of at least 2.');
  }
  if (draft.capacity !== '' && Number(draft.capacity) > 256) {
    out.push('Entrant capacity cannot exceed 256.');
  }
  if (auth.isRemote() && draft.capacity === '') {
    out.push('Connected events need an entrant capacity (2–256).');
  }
  if (auth.isRemote() && draft.entryFee && Number(draft.entryFee) !== 0) {
    out.push('Connected pilot events are free while payments are being built.');
  }
  if (draft.venueType === 'offline' && (!Number.isInteger(Number(draft.stationCount))
    || Number(draft.stationCount) < 1 || Number(draft.stationCount) > 64)) {
    out.push('Enter the actual number of stations you will run (1–64).');
  }
  const preset = game?.presets.find((p) => p.id === (draft.presetId || game.presets[0].id));
  if (preset?.provisional && !draft.provisionalRulesReviewed) {
    out.push('Review and confirm the provisional rules before creating the event.');
  }
  return out;
}

/* --------------------------------------------------------------------------
   Actions
   -------------------------------------------------------------------------- */

/* Every mutation goes through one of these two, so persistence is a single
   line in each rather than a line at forty call sites waiting to be
   forgotten. */
const rerender = () => { saveDraft(); window.dispatchEvent(new HashChangeEvent('hashchange')); };

on('wizard-step', ({ step }) => { draft.step = Number(step); rerender(); });

on('wizard-game', ({ game }) => {
  const g = gameById(game);
  draft.gameId = game;
  draft.presetId = g.presets[0].id;
  draft.overrides = {};
  draft.provisionalRulesReviewed = false;
  draft.platforms = g.platforms.length === 1 ? [g.platforms[0].value] : [];
  if (!draft.name) draft.name = `${g.short} Tuesdays #1`;
  draft.step = 1;
  rerender();
});

on('wizard-field', ({ field }, el) => { draft[field] = el.value; saveDraft(); });

on('wizard-game-search', (d, el) => { draft.gameSearch = el.value; rerender(); });

on('wizard-set', ({ field, value }) => { draft[field] = value; rerender(); });

on('wizard-platform', ({ value }) => {
  const at = draft.platforms.indexOf(value);
  if (at >= 0) draft.platforms.splice(at, 1);
  else draft.platforms.push(value);
  rerender();
});

on('wizard-preset', ({ preset }) => {
  draft.presetId = preset;
  /* Switching preset drops overrides. The alternative -- carrying them across
     -- produces a ruleset that is neither preset and that the TO cannot
     reason about, and it is the sort of thing you only notice at the venue. */
  draft.overrides = {};
  draft.provisionalRulesReviewed = false;
  rerender();
});

on('wizard-setting', ({ field, type, value }, el) => {
  const game = gameById(draft.gameId);
  const base = resolveRuleset(game, draft.presetId || game.presets[0].id, {});
  let next;

  if (type === 'toggle') next = el.checked;
  else if (type === 'number') next = Number(el.value);
  else if (type === 'text') next = el.value;
  else if (type === 'multi') {
    const current = draft.overrides[field] ?? base.values[field] ?? [];
    const set = new Set(current);
    if (set.has(value)) set.delete(value); else set.add(value);
    next = [...set];
  } else next = value;

  /* Setting a field back to what the preset already says removes the override
     rather than storing an identical value, so the "3 changed" count is a
     count of real differences. */
  if (JSON.stringify(next) === JSON.stringify(base.values[field])) delete draft.overrides[field];
  else draft.overrides[field] = next;

  /* A provisional review is about the complete final rules. Any edit after
     confirming it invalidates that confirmation; otherwise a TO could change
     a rule and still publish under the old acknowledgement. */
  draft.provisionalRulesReviewed = false;

  rerender();
});

on('wizard-provisional-review', (d, el) => {
  draft.provisionalRulesReviewed = Boolean(el.checked);
  rerender();
});

on('wizard-reset-field', ({ field }) => { delete draft.overrides[field]; rerender(); });

on('wizard-doc-add', () => {
  draft.documents.push({ id: store.uid('doc'), title: 'New document', required: false, version: 1 });
  rerender();
});
on('wizard-doc-remove', ({ index }) => { draft.documents.splice(Number(index), 1); rerender(); });
on('wizard-doc-required', ({ index }) => {
  const doc = draft.documents[Number(index)];
  doc.required = !doc.required;
  rerender();
});
on('wizard-doc-title', ({ index }, el) => { draft.documents[Number(index)].title = el.value; saveDraft(); });

/* --------------------------------------------------------------------------
   The sign-in gate
   --------------------------------------------------------------------------
   You can walk this entire wizard as a guest. You cannot finish it as one.

   That split is deliberate and it is the opposite of what most sites do,
   which is to demand an account on the first screen before you know whether
   the thing is any good. Nobody should have to sign up to find out what the
   Tokon ruleset form looks like. But an event is a public artefact with other
   people's names on it, and the moment it exists somebody has to be
   accountable for it -- there is no way to ban a bad actor who is not anybody.

   The important half is that the gate does not cost you anything: the draft
   is on disk, so signing in mid-publish (including the Discord round trip,
   which leaves the page entirely) comes back to a filled-in wizard and
   carries straight on to the event that was about to be created.

   With no backend configured the gate is a formality -- "signing in" mints a
   profile on the device and nothing leaves it -- and it is deliberately not
   skipped in that case. Same code path, so it is the path that actually gets
   exercised, and a TO who later connects a backend meets no new step.
   -------------------------------------------------------------------------- */

on('wizard-publish', async () => {
  const game = gameById(draft.gameId);
  if (validate(game).length) return;

  if (!auth.currentPlayer()) {
    /* Mark the draft so a sign-in that leaves the page can find its way back.
       The in-dialog paths (email, device account) come back through the
       callback below and never need this; Discord's OAuth redirect reloads
       the app, and `resumePendingPublish` picks it up on boot. */
    draft.pendingPublish = true;
    saveDraft();
    const authView = await import('./auth.js');
    authView.openSignIn(() => {
      if (!auth.currentPlayer()) return;
      delete draft.pendingPublish;
      publish();
    }, {
      title: 'Sign in to create it',
      why: 'Your event stays exactly as you have set it up — this is saved on your device. An event has other people\'s names on it, so it needs somebody accountable for it.',
    });
    return;
  }

  publish();
});

/* Called once on boot. Somebody who signed in with Discord from the publish
   gate comes back on a fresh page load, at whatever route the OAuth redirect
   named -- so without this they land on the events list with no idea their
   draft survived.

   It returns them to the wizard with everything filled in and does NOT create
   the event for them. Creating a public artefact as a side effect of a page
   load is the kind of thing that produces two events when somebody refreshes,
   and the last press of that button should be a deliberate one. */
export function resumePendingPublish() {
  const pending = loadDraft();
  if (!pending?.pendingPublish) return false;
  delete pending.pendingPublish;
  draft = pending;
  saveDraft();
  if (!auth.currentPlayer()) return false;   /* sign-in was abandoned; draft keeps */
  draft.step = STEPS.length - 1;
  saveDraft();
  snack('Signed in — your event is still here. Create it when you are ready.');
  window.location.hash = '#/new';
  return true;
}

async function publish() {
  const game = gameById(draft.gameId);
  if (!game || validate(game).length || publishing) return;

  const me = auth.currentPlayer();
  const remote = auth.isRemote();
  const id = remote ? (draft.pendingEventId || store.serverUid()) : store.uid('evt');
  let code = null;

  if (remote) {
    draft.pendingEventId = id;
    saveDraft();
    publishing = true;
    rerender();
    try {
      const stations = draft.venueType === 'offline'
        ? Array.from({ length: Number(draft.stationCount) }, (_, i) => ({
          label: `Station ${i + 1}`, platform: draft.platforms[0] || null,
        }))
        : [{ label: 'Online lobby', platform: draft.platforms[0] || null }];
      const result = await store.createRemoteEvent(id, {
        orgName: `${me.tag}'s events`,
        name: draft.name.trim(), gameId: draft.gameId, format: draft.format,
        venueType: draft.venueType, venue: draft.venue.trim(), platforms: draft.platforms,
        startsAt: new Date(draft.startsAt).toISOString(),
        capacity: draft.capacity ? Number(draft.capacity) : null,
        entryFee: 0, currency: draft.currency,
        visibility: draft.visibility === 'unlisted' ? 'unlisted' : 'public',
        presetId: draft.presetId || game.presets[0].id,
        overrides: draft.overrides, documents: draft.documents, stations,
      });
      code = result.inviteCode;
    } catch (err) {
      publishing = false;
      rerender();
      snack(`Could not create the event: ${String(err?.message || err)}`);
      return;
    }
    publishing = false;
  }

  /* An org is created on first publish rather than being a separate onboarding
     step. A TO running their first weekly does not want to fill in a "create
     your organisation" form; they want a bracket. The org exists so the second
     event has somewhere to belong, and so staff can be added later. */
  let orgId = me?.defaultOrgId;
  if (!remote && !orgId) {
    orgId = store.uid('org');
    store.apply('orgs', orgId, {
      id: orgId,
      name: me ? `${me.tag}'s events` : 'My events',
      ownerId: me?.id || null,
      createdAt: new Date().toISOString(),
    });
    if (me) store.apply('players', me.id, { defaultOrgId: orgId });
  }

  if (!remote) store.apply('events', id, {
    id, orgId,
    ownerId: me?.id || null,
    name: draft.name.trim(),
    gameId: draft.gameId,
    format: draft.format,
    venueType: draft.venueType,
    venue: draft.venue.trim(),
    platforms: draft.platforms,
    startsAt: new Date(draft.startsAt).toISOString(),
    capacity: draft.capacity ? Number(draft.capacity) : null,
    entryFee: draft.entryFee ? Number(draft.entryFee) : 0,
    currency: draft.currency,
    status: 'registration',
    visibility: draft.visibility === 'unlisted' ? 'unlisted' : 'public',
    inviteCode: null,
    presetId: draft.presetId || game.presets[0].id,
    overrides: draft.overrides,
    documents: draft.documents,
    createdAt: new Date().toISOString(),
  });

  /* The station count is deliberately entered by the TO. A hard-coded four
     looked convenient in a demo but created the wrong queue for a real room,
     which is worse than asking for the one fact only the organiser knows. */
  if (!remote && draft.venueType === 'offline') {
    for (let i = 1; i <= Number(draft.stationCount); i += 1) {
      const stationId = store.uid('stn');
      store.apply('stations', stationId, {
        id: stationId, eventId: id, number: i, label: `Station ${i}`,
        platform: draft.platforms[0] || null,
      });
    }
  }

  const name = draft.name.trim();
  discardDraft();

  dialog({
    title: 'Event created',
    body: html`
      ${remote ? html`
        <p class="body-medium">${name} is live. Share this code with entrants who open the site.</p>
        <div class="card card-filled" style="text-align:center;margin:16px 0">
          <div class="invite-code">${code}</div>
          <div class="body-small dim" style="margin-top:4px">${joinUrl(code)}</div>
        </div>` : html`
        <div class="banner banner-info local-device-note">
          ${raw(icon('station'))}
          <div class="body-medium"><b>${name} is ready on this device.</b>
            <p class="body-small" style="margin:4px 0 0">Add entrants from this computer and connect it to the venue TV for the room display. Other devices cannot join this event yet.</p>
          </div>
        </div>`}
      <p class="body-small dim">Next: add entrants — one at a time, or paste a spreadsheet of them.</p>`,
    actions: [
      ...(remote ? [{ label: 'Copy the link', kind: 'text', onClick: async () => {
        const { copy } = await import('../lib/ui.js');
        await copy(joinUrl(code));
        snack('Link copied');
        return false;
      } }] : []),
      { label: 'Add entrants', kind: 'filled', onClick: () => { window.location.hash = `#/e/${id}/admin/entrants`; } },
    ],
  });

  window.location.hash = `#/e/${id}/admin`;
}
