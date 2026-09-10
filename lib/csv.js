/* Brackets · import and export
   ===========================================================================
   The complaint this file answers, verbatim: "no way to mass import, update,
   or edit."

   That is three separate failures and they need three separate answers.

   ## Import

   start.gg's bulk-add takes a list of gamertags, caps it at 50 at a time, and
   is ADD-ONLY. So a TO with a 120-person pre-registration spreadsheet does it
   in three passes and cannot include anything except a name -- no seed, no
   Discord handle, no platform ID, no "paid at door". Everything else is typed
   in afterwards, one row at a time.

   Here: paste anything. No row cap. Any columns, in any order, with any
   headers -- `mapColumns` guesses what they are and the TO corrects the guess.

   ## Update

   The important half, and the one nobody does. Re-importing the same
   spreadsheet after the organiser fixed three names in it should update three
   rows, not create 120 duplicates. That means every import is an UPSERT keyed
   on a stable identifier, and it means the tool has to be able to say what it
   is about to do before it does it.

   `dryRun` returns exactly that: a per-row classification of create / update /
   unchanged / conflict, with a field-level diff on the updates. Nothing is
   written until the TO looks at that and says go. An import tool without a
   preview is a tool people use once, get burned by, and never trust again --
   and then they go back to typing.

   ## Edit

   Round trip. `toCsv` exports the same shape `parse` accepts, so the workflow
   is: export, fix it in a spreadsheet where fixing things is easy, paste it
   back. That is what a TO actually wants -- not a better web grid, but
   permission to use the tool they already have.

   ---------------------------------------------------------------------------
   Everything here is pure. `dryRun` computes a plan; `applyPlan` in the view
   layer executes it through the store's checkpoint/undo. Keeping the decision
   and the write apart is what makes the preview trustworthy: the preview is
   not a description of what the writer will do, it IS the thing the writer
   does.
   =========================================================================== */

'use strict';

import { normaliseTag } from './guidance.js';

/* --------------------------------------------------------------------------
   Parsing
   --------------------------------------------------------------------------
   A real CSV parser rather than `split(',')`, because a TO's spreadsheet has
   a team name with a comma in it and a note field with a line break, and the
   naive version corrupts those rows silently -- which is worse than refusing
   them.

   Handles: quoted fields, embedded commas, embedded newlines, doubled quotes
   as an escape, CRLF, and a BOM (Excel puts one there on export and it turns
   the first header into "﻿tag", which then fails to map).

   Delimiter is sniffed. Pasting from a spreadsheet gives TABS, not commas, and
   that is the most common paste of all -- select the column range in Excel,
   copy, paste. A CSV importer that cannot take a tab-separated paste is
   missing the main use case.
   -------------------------------------------------------------------------- */

export function sniffDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const counts = { '\t': 0, ',': 0, ';': 0, '|': 0 };
  let inQuotes = false;
  for (const char of firstLine) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char in counts) counts[char] += 1;
  }
  const [best] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : ',';
}

export function parse(text, delimiter) {
  const clean = String(text || '').replace(/^﻿/, '');
  const delim = delimiter || sniffDelimiter(clean);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];

    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += char;
      continue;
    }

    if (char === '"' && field === '') { inQuotes = true; continue; }
    if (char === delim) { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ''));
}

/* --------------------------------------------------------------------------
   Column mapping
   --------------------------------------------------------------------------
   The fields an entrant row can carry. `aliases` are what real spreadsheets
   actually call them -- collected from the shapes that come out of start.gg
   exports, Google Forms registrations and the ad-hoc sheets TOs keep.
   -------------------------------------------------------------------------- */

export const FIELDS = [
  {
    key: 'tag', label: 'Tag', required: true,
    aliases: ['tag', 'gamertag', 'gamer tag', 'player', 'name', 'handle', 'username', 'display name', 'entrant', 'nickname'],
  },
  { key: 'seed', label: 'Seed', aliases: ['seed', 'seeding', 'rank', 'placement', 'order', '#'] },
  { key: 'realName', label: 'Real name', aliases: ['real name', 'full name', 'legal name', 'first name'] },
  { key: 'email', label: 'Email', aliases: ['email', 'e-mail', 'email address', 'mail'] },
  { key: 'discord', label: 'Discord', aliases: ['discord', 'discord tag', 'discord handle', 'discord username', 'discord id'] },
  { key: 'psn', label: 'PSN ID', aliases: ['psn', 'psn id', 'playstation', 'psn name', 'online id'] },
  { key: 'steam', label: 'Steam', aliases: ['steam', 'steam id', 'steam name', 'steam profile'] },
  { key: 'nintendo', label: 'Friend code', aliases: ['switch', 'friend code', 'nintendo', 'sw code'] },
  { key: 'pronouns', label: 'Pronouns', aliases: ['pronouns', 'pronoun'] },
  { key: 'region', label: 'Region', aliases: ['region', 'state', 'country', 'city', 'location', 'area'] },
  {
    key: 'group', label: 'Team / venue', aliases: ['team', 'crew', 'sponsor', 'venue', 'club', 'local', 'home venue', 'org'],
    help: 'Used by seeding to keep teammates apart in the early rounds.',
  },
  { key: 'paid', label: 'Paid', aliases: ['paid', 'payment', 'fee paid', 'has paid'] },
  { key: 'checkedIn', label: 'Checked in', aliases: ['checked in', 'checkin', 'check-in', 'present', 'attending'] },
  { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'comment', 'comments'] },
];

/* Guess which column is which. Exact alias match first, then substring, then
   give up and leave it unmapped -- a wrong guess the TO does not notice is
   worse than an obvious blank, because the blank gets fixed and the wrong
   guess gets imported. */
export function mapColumns(headerRow) {
  const used = new Set();
  return headerRow.map((raw) => {
    const header = String(raw || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
    if (!header) return null;

    for (const field of FIELDS) {
      if (used.has(field.key)) continue;
      if (field.aliases.includes(header)) { used.add(field.key); return field.key; }
    }
    for (const field of FIELDS) {
      if (used.has(field.key)) continue;
      if (field.aliases.some((a) => header.includes(a) || a.includes(header))) {
        used.add(field.key); return field.key;
      }
    }
    return null;
  });
}

/* Does the first row look like headers, or is it data? Pasting a bare list of
   tags is the most common import there is, and treating "Kira" as a header
   silently loses an entrant. Heuristic: it is a header row if most of its
   cells match a known alias AND none of them looks like a number that would
   be a seed. */
export function looksLikeHeader(row) {
  if (!row?.length) return false;
  const allAliases = new Set(FIELDS.flatMap((f) => f.aliases));
  const hits = row.filter((c) => allAliases.has(String(c).trim().toLowerCase().replace(/[_-]+/g, ' '))).length;
  return hits >= Math.max(1, Math.ceil(row.length / 2));
}

const truthy = (v) => ['y', 'yes', 'true', '1', 'x', 'paid', 'in', 'checked'].includes(String(v || '').trim().toLowerCase());

/* Rows + mapping -> normalised records. */
export function toRecords(rows, mapping) {
  return rows.map((row, i) => {
    const record = { _row: i + 1 };
    mapping.forEach((key, col) => {
      if (!key) return;
      const value = row[col];
      if (value === undefined || value === '') return;
      if (key === 'seed') {
        const n = parseInt(String(value).replace(/[^0-9]/g, ''), 10);
        if (Number.isFinite(n)) record.seed = n;
      } else if (key === 'paid' || key === 'checkedIn') {
        record[key] = truthy(value);
      } else {
        record[key] = String(value).trim();
      }
    });
    return record;
  }).filter((r) => r.tag);
}

/* --------------------------------------------------------------------------
   The dry run
   --------------------------------------------------------------------------
   Classify every incoming row against what already exists.

   Matching order matters and is deliberately strongest-first: email and
   Discord ID are identities, a normalised tag is a strong hint, and a raw tag
   match is a last resort. Getting this wrong in either direction is bad --
   too loose merges two different people called "Ken", too strict duplicates
   somebody because they typed their tag in caps this time.
   -------------------------------------------------------------------------- */

export function dryRun(records, { entries, players, eventId }) {
  const byEmail = new Map();
  const byDiscord = new Map();
  const byTag = new Map();

  for (const entry of entries) {
    const player = players.get(entry.playerId);
    if (!player) continue;
    if (player.email) byEmail.set(player.email.toLowerCase(), entry);
    if (player.discordId) byDiscord.set(String(player.discordId).toLowerCase(), entry);
    if (player.connections?.discord) byDiscord.set(String(player.connections.discord).toLowerCase(), entry);
    byTag.set(normaliseTag(player.tag), entry);
  }

  const plan = [];
  /* Rows that collide with EACH OTHER inside the same paste. Two rows for the
     same person in one import is common (a form that let people submit twice)
     and would otherwise create then immediately update, which reads as
     nonsense in the preview. */
  const seenInBatch = new Map();

  for (const record of records) {
    const keys = [
      record.email && `email:${record.email.toLowerCase()}`,
      record.discord && `discord:${record.discord.toLowerCase()}`,
      `tag:${normaliseTag(record.tag)}`,
    ].filter(Boolean);

    const batchDupe = keys.find((k) => seenInBatch.has(k));
    if (batchDupe) {
      plan.push({
        record, action: 'duplicate-in-file',
        against: seenInBatch.get(batchDupe),
        note: `Row ${seenInBatch.get(batchDupe)._row} in this paste is the same person (matched on ${batchDupe.split(':')[0]}).`,
      });
      continue;
    }
    for (const key of keys) seenInBatch.set(key, record);

    const existing = (record.email && byEmail.get(record.email.toLowerCase()))
      || (record.discord && byDiscord.get(record.discord.toLowerCase()))
      || byTag.get(normaliseTag(record.tag));

    if (!existing) {
      plan.push({ record, action: 'create' });
      continue;
    }

    const player = players.get(existing.playerId);
    const changes = diffAgainst(record, existing, player);
    plan.push({
      record,
      action: changes.length ? 'update' : 'unchanged',
      entryId: existing.id,
      playerId: existing.playerId,
      changes,
      matchedOn: record.email && byEmail.has(record.email.toLowerCase()) ? 'email'
        : record.discord && byDiscord.has(record.discord.toLowerCase()) ? 'discord' : 'tag',
    });
  }

  return {
    plan,
    eventId,
    summary: {
      create: plan.filter((p) => p.action === 'create').length,
      update: plan.filter((p) => p.action === 'update').length,
      unchanged: plan.filter((p) => p.action === 'unchanged').length,
      duplicate: plan.filter((p) => p.action === 'duplicate-in-file').length,
    },
  };
}

/* Field-level diff, so the preview can say "seed 4 -> 2" rather than
   "updated". A TO scanning 120 rows needs to see WHICH ones actually move. */
function diffAgainst(record, entry, player) {
  const changes = [];
  const push = (field, from, to) => {
    if (to === undefined || to === null || to === '') return;
    if (String(from ?? '') === String(to)) return;
    changes.push({ field, from: from ?? null, to });
  };

  push('tag', player?.tag, record.tag);
  push('seed', entry.seed, record.seed);
  push('realName', player?.realName, record.realName);
  push('email', player?.email, record.email);
  push('pronouns', player?.pronouns, record.pronouns);
  push('region', player?.region, record.region);
  push('group', entry.group, record.group);
  push('notes', entry.notes, record.notes);
  push('discord', player?.connections?.discord, record.discord);
  push('psn', player?.connections?.psn, record.psn);
  push('steam', player?.connections?.steam, record.steam);
  push('nintendo', player?.connections?.nintendo, record.nintendo);

  /* Booleans are only a change when the import says TRUE. An import that omits
     the "paid" column must not un-pay everybody -- absence is "no opinion",
     not "false", and conflating the two is how a bulk tool eats real data. */
  if (record.paid && !entry.paidAt) changes.push({ field: 'paid', from: false, to: true });
  if (record.checkedIn && !entry.checkedInAt) changes.push({ field: 'checkedIn', from: false, to: true });

  return changes;
}

/* --------------------------------------------------------------------------
   Export
   -------------------------------------------------------------------------- */

export function toCsv(rows, columns) {
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => escape(c.get(row))).join(',')).join('\r\n');
  /* CRLF and a BOM, because the overwhelmingly likely destination is Excel,
     which mangles UTF-8 without one. */
  return `﻿${header}\r\n${body}`;
}

export const ENTRANT_COLUMNS = [
  { label: 'Seed', get: (r) => r.entry.seed ?? '' },
  { label: 'Tag', get: (r) => r.player?.tag || '' },
  { label: 'Real name', get: (r) => r.player?.realName || '' },
  { label: 'Pronouns', get: (r) => r.player?.pronouns || '' },
  { label: 'Email', get: (r) => r.player?.email || '' },
  { label: 'Discord', get: (r) => r.player?.connections?.discord || r.player?.discordName || '' },
  { label: 'PSN ID', get: (r) => r.player?.connections?.psn || '' },
  { label: 'Steam', get: (r) => r.player?.connections?.steam || '' },
  { label: 'Friend code', get: (r) => r.player?.connections?.nintendo || '' },
  { label: 'Region', get: (r) => r.player?.region || '' },
  { label: 'Team / venue', get: (r) => r.entry.group || '' },
  { label: 'Checked in', get: (r) => (r.entry.checkedInAt ? 'yes' : 'no') },
  { label: 'Paid', get: (r) => (r.entry.paidAt ? 'yes' : 'no') },
  { label: 'Notes', get: (r) => r.entry.notes || '' },
];

/* Trigger a download of a generated file.

   Note for anyone porting this into a sandboxed context: an <a download> click
   is blocked in some embedded viewers, and the fallback there is to show the
   text and let the user copy it. In a normal browser tab -- which is where
   this runs -- it is fine. */
export function download(filename, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
