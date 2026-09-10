/* Brackets · the game registry
   ===========================================================================
   A game here is DATA, not code. Everything the setup wizard renders -- every
   field, every default, every validation -- comes out of the objects below,
   and `views/setup.js` never mentions a game by name. Adding a title is an
   entry in this file; it is not a change to the wizard, the admin console, or
   the bracket engine.

   The settings themselves are assembled from the builders in `rulesets.js`,
   because "set format" is the same four fields in every fighting game ever
   made and writing them out twenty-one times means twenty-one places to fix
   when one of them turns out to be wrong.

   A game's entry should be as long as the game is unusual, and no longer.
   Street Fighter 6 is about a dozen lines. Tokon is the longest thing here
   because a 4v4 tag game with a shared health bar genuinely has more to say.

   ## Which games, and why these

   The lineup is every title from Evo 2025 and Evo 2026 -- both years, main
   stage and extended -- plus Smash Ultimate and MARVEL Tokon.

   Evo is the right list to seed from because it is the closest thing the
   scene has to a canon: if a game is on that stage, somebody is running a
   local for it. Each entry records where it appeared in `evo`, which the
   wizard shows, so a TO picking a game can see they are not alone in running
   it.

   Note that Tokon itself is on neither lineup -- it launched after Evo 2026 --
   and Smash Ultimate is on neither either. Both are here because people run
   them anyway, which is rather the point.

   ## Rulesets are versioned and forkable, never hardcoded

   Each game ships one or more PRESETS: a named, dated bundle of setting values
   with a `version` and a `source` -- who says so. An event does not "use the
   standard ruleset"; it takes a COPY of a preset at creation. A preset that
   changes later therefore cannot silently rewrite the rules of an event that
   is already running, which is a real failure mode when the rules are the
   thing people are arguing about at 11pm in a venue.

   ## On the accuracy of what is below

   The mechanical facts -- platforms, team sizes, whether a game ships a
   simplified control scheme -- are checkable and were checked.

   The competitive CONVENTIONS are a different matter. For most of these games
   a settled ruleset exists and the preset reflects it. For the new ones it
   does not, and those presets are marked `provisional: true` with a `source`
   that says so in as many words. That flag is surfaced to the TO at setup and
   to the player on the rules sheet. Presenting a guess as a standard is how a
   bracket site accidentally writes a scene's rules; if we are going to do
   that, it should be on purpose, in the open, with a version number on it.
   =========================================================================== */

'use strict';

import {
  standardFightingGame, setFormatGroup, matchGroup, teamGroup,
  controlsGroup, conductGroup, onlineGroup, stagesGroup, stocksGroup,
  SET_LENGTHS, setLength,
} from './rulesets.js';

export { SET_LENGTHS, setLength };

/* --------------------------------------------------------------------------
   Platforms
   -------------------------------------------------------------------------- */

const PLATFORM = {
  ps5: { value: 'ps5', label: 'PlayStation 5' },
  ps4: { value: 'ps4', label: 'PlayStation 4' },
  pc: { value: 'pc', label: 'PC (Steam)' },
  xbox: { value: 'xbox', label: 'Xbox' },
  switch: { value: 'switch', label: 'Nintendo Switch' },
};
const plats = (...ids) => ids.map((id) => PLATFORM[id]);

/* --------------------------------------------------------------------------
   A compact preset helper
   --------------------------------------------------------------------------
   Most games need one preset that says "the settings the scene already runs",
   which is exactly the field defaults. Spelling that out per game would be
   nineteen near-identical objects.
   -------------------------------------------------------------------------- */

const preset = ({ id, name, version = '1.0', summary, source, provisional = false, values = {} }) => ({
  id, name, version, updated: '2026-09-10', provisional, summary, source, values,
});

const settledPreset = (id, summary, source) => preset({
  id: `${id}-standard`, name: 'Standard', summary,
  source: source || 'The settings this game has been run on for years. Change what your venue does differently.',
});

const provisionalPreset = (id, summary, source) => preset({
  id: `${id}-standard`, name: 'Community Standard', version: '0.1', provisional: true,
  summary, source,
});

/* ==========================================================================
   MARVEL TOKON: FIGHTING SOULS
   --------------------------------------------------------------------------
   The reference identity, and the most detailed entry here on purpose.

   Tokon is a 4v4 tag fighter from Arc System Works with a SHARED team health
   bar, "Assemble" assists, third and fourth members that unlock during a
   match, and crossplay between PS5 and PC. Those mechanics are documented.

   What is not documented is the competitive convention layered on top,
   because the scene has not settled it -- the game launched after Evo 2026,
   so it has not had a major yet.
   ========================================================================== */

const TOKON_CHARACTERS = [
  'Captain America', 'Iron Man', 'Spider-Man', 'Doctor Doom', 'Storm',
  'Wolverine', 'Magneto', 'Ghost Rider', 'Star-Lord', 'Gamora',
  'Doctor Strange', 'Thor', 'Hulk', 'Rocket Raccoon', 'Venom',
  'Scarlet Witch', 'Black Panther', 'Psylocke', 'Ms. Marvel', 'Blade',
];

const TOKON = {
  id: 'tokon',
  name: 'MARVEL Tokon: Fighting Souls',
  short: 'Tokon',
  mark: 'TK',
  releaseYear: 2026,
  evo: null,
  characters: TOKON_CHARACTERS,
  platforms: plats('ps5', 'pc'),

  settingGroups: [
    setFormatGroup(),
    matchGroup({
      rounds: 2,
      roundsHelp: 'In-game round count. Tokon rounds also gate when your third and fourth members become available, so changing this changes the game, not just its length.',
      stages: {
        help: 'Tokon stages have transitions rather than competitive hazards, so random is usually fine — unlike in a platform fighter, where the stage list IS the ruleset.',
      },
    }),
    teamGroup({
      style: 'assist', size: 4, sizeMax: 4, characters: TOKON_CHARACTERS,
      sizeHelp: 'Tokon is 4v4 by default. Lower it only for a novelty side bracket.',
    }),
    controlsGroup({ simplified: { label: 'Simplified control scheme' } }),
    conductGroup(),
    onlineGroup({
      crossplay: {
        help: 'Tokon matches PS5 and PC in one pool. Entrants must set Match Platform to "All" — it is under Battle > Casual/Ranked, fourth row. Turn this off only if you are running a platform-locked bracket.',
      },
      disconnectHelp: 'Tokon uses a shared team health bar, so "who was ahead" is a single number both players can see — which makes the loss-if-losing rule unusually enforceable here.',
    }),
  ],

  presets: [
    preset({
      id: 'tokon-standard-0-3', name: 'Community Standard', version: '0.3', provisional: true,
      summary: 'FT2 pools, FT3 top cut, loser may change team, simplified controls legal.',
      source: 'Assembled by BattyDev from what the Tokon Discords are running as of August 2026. NOT ratified by anyone. Read it before you use it.',
    }),
    preset({
      id: 'tokon-locals-fast', name: 'Fast Local', provisional: true,
      summary: 'FT2 throughout, both players may change team, 3-minute DQ timer.',
      source: 'For a weekly that has to be out of the venue by 11.',
      values: { setLengthTopCut: 'ft2', setLengthFinals: 'ft3', teamChangeRule: 'both', dqTimer: 3 },
    }),
    preset({
      id: 'tokon-major', name: 'Major', provisional: true,
      summary: 'FT2 pools / FT3 cut, winner locked, coaching between games, 10-minute DQ.',
      source: 'Stricter defaults for an event with a stream and a prize pot.',
      values: { teamChangeRule: 'loser-only', dqTimer: 10, pauseRule: 'banned' },
    }),
  ],
};

/* ==========================================================================
   SUPER SMASH BROS. ULTIMATE
   --------------------------------------------------------------------------
   Thin, but thin in the right place: the stage list IS the ruleset in a
   platform fighter, so it gets a real stage model and skips almost everything
   a round-based fighter needs.
   ========================================================================== */

const SSBU = {
  id: 'ssbu',
  name: 'Super Smash Bros. Ultimate',
  short: 'Smash Ultimate',
  mark: 'SSB',
  releaseYear: 2018,
  evo: null,
  characters: [],
  platforms: plats('switch'),

  settingGroups: [
    setFormatGroup(),
    stocksGroup({ stocks: 3, timeLimit: 7 }),
    stagesGroup({
      starters: ['Battlefield', 'Small Battlefield', 'Final Destination', 'Pokémon Stadium 2',
        'Smashville', 'Town and City', 'Hollow Bastion', "Yoshi's Story"],
      counterpicks: ['Town and City', 'Kalos Pokémon League', 'Hollow Bastion', "Yoshi's Story",
        'Northern Cave', "Yoshi's Island (Brawl)"],
    }),
    controlsGroup(),
    conductGroup(),
    onlineGroup(),
  ],

  presets: [
    settledPreset('ssbu', '3 stocks, 7 minutes, 1-2-1 striking, modified DSR.',
      'The ruleset almost every Smash Ultimate local has run for years.'),
  ],
};

/* ==========================================================================
   THE EVO LINEUP
   --------------------------------------------------------------------------
   Everything from Evo 2025 and Evo 2026. Each entry is the game's own facts
   plus whichever ruleset shape fits it; the shared settings come from the
   builders.

   `evo` records where it appeared. `identity: 'placeholder'` in themes.js
   marks the ones still waiting for the artwork treatment Tokon has.
   ========================================================================== */

const EVO_GAMES = [
  {
    id: 'sf6', name: 'Street Fighter 6', short: 'Street Fighter 6', mark: 'SF6',
    releaseYear: 2023, platforms: plats('ps5', 'pc', 'xbox'),
    evo: { 2025: 'main', 2026: 'main' },
    rules: {
      match: { rounds: 2, timer: '99' },
      controls: {
        simplified: {
          label: 'Modern controls',
          help: 'Street Fighter 6 ships Modern controls alongside Classic. Legal at every major that has run the game, and the argument about it is mostly settled — but say so explicitly rather than leaving a newcomer to guess.',
        },
      },
      online: { crossplay: { help: 'Street Fighter 6 is crossplay across PlayStation, PC and Xbox. Leave this on unless you are running a platform-locked bracket.' } },
    },
    preset: ['FT2 pools, FT3 top cut, 2 rounds, 99 seconds, Modern controls legal.',
      'The settings every Street Fighter 6 major runs, including Evo.'],
  },
  {
    id: 'tekken8', name: 'Tekken 8', short: 'Tekken 8', mark: 'T8',
    releaseYear: 2024, platforms: plats('ps5', 'pc', 'xbox'),
    evo: { 2025: 'main', 2026: 'main' },
    rules: {
      match: { rounds: 3, timer: '60', timers: ['60', '99', 'infinite'] },
      controls: { simplified: { label: 'Special Style', help: 'Tekken 8 ships Special Style, a one-button scheme. Legal by default; some locals ban it.' } },
      online: { crossplay: {} },
    },
    preset: ['FT2 pools, FT3 top cut, 3 rounds, 60 seconds.',
      'Tekken has run 3 rounds at 60 seconds for as long as anyone can remember.'],
  },
  {
    id: 'ggst', name: 'Guilty Gear -Strive-', short: 'GG Strive', mark: 'GGS',
    releaseYear: 2021, platforms: plats('ps5', 'ps4', 'pc', 'xbox'),
    evo: { 2025: 'main', 2026: 'main' },
    rules: { match: { rounds: 2, timer: '99' }, online: { crossplay: {} } },
    preset: ['FT2 pools, FT3 top cut, 2 rounds, 99 seconds.', 'The settled Strive ruleset.'],
  },
  {
    id: 'uni2', name: 'Under Night In-Birth II Sys:Celes', short: 'UNI2', mark: 'UNI',
    releaseYear: 2024, platforms: plats('ps5', 'ps4', 'pc', 'switch'),
    evo: { 2025: 'main', 2026: 'main' },
    rules: { match: { rounds: 2, timer: '99' } },
    preset: ['FT2 pools, FT3 top cut, 2 rounds, 99 seconds.', 'The settled UNI ruleset.'],
  },
  {
    id: 'mk1', name: 'Mortal Kombat 1', short: 'Mortal Kombat 1', mark: 'MK1',
    releaseYear: 2023, platforms: plats('ps5', 'pc', 'xbox', 'switch'),
    evo: { 2025: 'main' },
    rules: {
      match: { rounds: 2, timer: '90', timers: ['90', '99', 'infinite'] },
      /* Kameos are a second character, but they are not a team in the sense
         teamGroup means -- there is no order and no tag. One choice field
         rather than the whole team group, which would ask four questions that
         do not apply. */
      match2: null,
      online: { crossplay: {} },
    },
    extraFields: [{
      group: 'match',
      field: {
        key: 'kameoChangeRule', type: 'choice', label: 'Changing Kameo between games',
        options: [
          { value: 'follows-character', label: 'Same rule as the character', help: 'Whoever may change character may change Kameo.' },
          { value: 'always', label: 'Always allowed', help: 'Even a locked winner may change Kameo.' },
          { value: 'never', label: 'Never' },
        ],
        default: 'follows-character',
        help: 'A Kameo is a second pick, so "may the loser counterpick" has two answers in Mortal Kombat 1 rather than one.',
      },
    }],
    preset: ['FT2 pools, FT3 top cut, 2 rounds, 90 seconds.', 'The settled Mortal Kombat 1 ruleset.'],
  },
  {
    id: 'ffcotw', name: 'Fatal Fury: City of the Wolves', short: 'Fatal Fury CotW', mark: 'FF',
    releaseYear: 2025, platforms: plats('ps5', 'ps4', 'pc', 'xbox'),
    evo: { 2025: 'main', 2026: 'main' },
    rules: { match: { rounds: 2, timer: '99' }, online: { crossplay: {} } },
    preset: ['FT2 pools, FT3 top cut, 2 rounds, 99 seconds.',
      'What the game has been run on since it launched into the Evo 2025 lineup.'],
  },
  {
    id: 'mvc2', name: 'Marvel vs. Capcom 2', short: 'MvC2', mark: 'MV2',
    releaseYear: 2000, platforms: plats('ps5', 'ps4', 'pc', 'xbox', 'switch'),
    evo: { 2025: 'main' },
    rules: {
      match: { rounds: 1, roundsMax: 3, timer: '99' },
      team: { style: 'assist', size: 3, sizeMax: 3, sizeHelp: 'MvC2 is 3v3. The size field exists for side brackets that are not.' },
    },
    preset: ['FT2 pools, FT3 top cut, 3v3, single round, 99 seconds.',
      'MvC2 has been played the same way since 2000, which is most of why it came back to the Evo 2025 main stage.'],
  },
  {
    id: 'gbvsr', name: 'Granblue Fantasy Versus: Rising', short: 'GBVS Rising', mark: 'GBV',
    releaseYear: 2023, platforms: plats('ps5', 'ps4', 'pc'),
    evo: { 2025: 'main', 2026: 'main' },
    rules: {
      match: { rounds: 2, timer: '99' },
      controls: { simplified: { label: 'Simple inputs', help: 'Granblue ships a simplified input scheme with a longer cooldown on specials. Legal by default.' } },
      online: { crossplay: {} },
    },
    preset: ['FT2 pools, FT3 top cut, 2 rounds, 99 seconds, simple inputs legal.',
      'The settled Granblue ruleset.'],
  },
  {
    id: 'twoxko', name: '2XKO', short: '2XKO', mark: '2XK',
    releaseYear: 2025, platforms: plats('pc', 'ps5', 'xbox'),
    evo: { 2026: 'main' },
    rules: {
      match: { rounds: 2, timer: '99' },
      team: {
        style: 'assist', size: 2, sizeMax: 2,
        sizeHelp: '2XKO is 2v2 — a duo with assists, which is why the assist question below is separate from the team question.',
      },
      online: { crossplay: {} },
    },
    provisional: true,
    preset: ['FT2 pools, FT3 top cut, 2v2, loser may change team.',
      'Assembled from what the 2XKO scene ran through its beta and first Evo. Not ratified — read it before you use it.'],
  },
  {
    id: 'invinc', name: 'Invincible VS', short: 'Invincible VS', mark: 'INV',
    releaseYear: 2026, platforms: plats('ps5', 'pc', 'xbox'),
    evo: { 2026: 'main' },
    rules: {
      match: { rounds: 2, timer: '99' },
      team: { style: 'assist', size: 3, sizeMax: 3, sizeHelp: 'Invincible VS is a 3v3 tag game in the Marvel line.' },
      online: { crossplay: {} },
    },
    provisional: true,
    preset: ['FT2 pools, FT3 top cut, 3v3, loser may change team.',
      'A starting point taken from the tag-fighter convention. The game is new enough that nobody has ratified anything.'],
  },
  {
    id: 'rivals2', name: 'Rivals of Aether II', short: 'Rivals II', mark: 'RA2',
    releaseYear: 2024, platforms: plats('pc', 'ps5', 'xbox', 'switch'),
    evo: { 2025: 'extended', 2026: 'main' },
    rules: {
      stocks: { stocks: 3, timeLimit: 8 },
      stages: {
        starters: ['Aethereal Gates', 'Julesvale', 'Godai Delta', 'Hodojo', 'Air Armada',
          'Fire Capital', 'Merchant Port', 'Rock Wall'],
        counterpicks: ['Air Armada', 'Fire Capital', 'Merchant Port', 'Tempest Peak', 'Rock Wall'],
      },
    },
    preset: ['3 stocks, 8 minutes, 1-2-1 striking, modified DSR.',
      'The Rivals II ruleset the scene runs — a platform fighter, so the stage list does most of the work.'],
  },
  {
    id: 'bbcf', name: 'BlazBlue: Central Fiction', short: 'BlazBlue CF', mark: 'BBC',
    releaseYear: 2015, platforms: plats('ps4', 'pc', 'switch'),
    evo: { 2025: 'extended', 2026: 'main' },
    rules: { match: { rounds: 2, timer: '99' } },
    preset: ['FT2 pools, FT3 top cut, 2 rounds, 99 seconds.',
      'A decade-old game with a decade-old ruleset. It came back to the Evo 2026 main stage on the strength of it.'],
  },
  {
    id: 'vf5revo', name: 'Virtua Fighter 5 R.E.V.O.', short: 'Virtua Fighter 5', mark: 'VF5',
    releaseYear: 2024, platforms: plats('pc', 'ps5'),
    evo: { 2025: 'extended', 2026: 'main' },
    rules: { match: { rounds: 3, timer: '45', timers: ['30', '45', '60'] } },
    preset: ['FT2 pools, FT3 top cut, 3 rounds, 45 seconds.',
      'Virtua Fighter has run 3 rounds at 45 seconds since the arcade.'],
  },
  {
    id: 'vsav', name: 'Vampire Savior', short: 'Vampire Savior', mark: 'VSV',
    releaseYear: 1997, platforms: plats('pc', 'ps4', 'switch', 'xbox'),
    evo: { 2026: 'main' },
    rules: { match: { rounds: 1, roundsMax: 3, timer: '99' } },
    preset: ['FT2 pools, FT3 top cut, single round, 99 seconds.',
      'Vampire Savior uses a single long round with carry-over health, which is why the round count is 1 and not a mistake.'],
  },
  {
    id: 'kofxv', name: 'The King of Fighters XV', short: 'KOF XV', mark: 'KOF',
    releaseYear: 2022, platforms: plats('ps5', 'ps4', 'pc', 'xbox'),
    evo: { 2025: 'extended' },
    rules: {
      match: { rounds: 1, roundsMax: 3, timer: '60' },
      team: {
        style: 'sequential', size: 3, sizeMax: 3,
        sizeHelp: 'KOF is 3v3 sequential — one character at a time, each with their own health, next one in when the last falls.',
      },
      online: { crossplay: {} },
    },
    preset: ['FT2 pools, FT3 top cut, 3v3 sequential, 60 seconds a round.',
      'The settled KOF XV ruleset.'],
  },
  {
    id: 'samsho', name: 'Samurai Shodown', short: 'Samurai Shodown', mark: 'SS',
    releaseYear: 2019, platforms: plats('ps4', 'pc', 'xbox', 'switch'),
    evo: { 2025: 'extended' },
    rules: { match: { rounds: 2, timer: '60' } },
    preset: ['FT2 pools, FT3 top cut, 2 rounds, 60 seconds.', 'The settled Samurai Shodown ruleset.'],
  },
  {
    id: 'ggxrd', name: 'Guilty Gear Xrd REV 2', short: 'GG Xrd REV 2', mark: 'XRD',
    releaseYear: 2017, platforms: plats('pc', 'ps4'),
    evo: { 2025: 'extended' },
    rules: { match: { rounds: 2, timer: '99' } },
    preset: ['FT2 pools, FT3 top cut, 2 rounds, 99 seconds.',
      'Xrd has not changed since 2017 and neither has the way it is run.'],
  },
  {
    id: 'cvs2', name: 'Capcom vs. SNK 2', short: 'CvS2', mark: 'CVS',
    releaseYear: 2001, platforms: plats('ps5', 'ps4', 'pc', 'xbox', 'switch'),
    evo: { 2025: 'extended' },
    rules: {
      match: { rounds: 2, timer: '99' },
      team: {
        style: 'sequential', size: 3, sizeMax: 4,
        sizeHelp: 'CvS2 uses a ratio system — four points spread across one to three characters — so "team size" is a maximum rather than a fixed number.',
      },
    },
    extraFields: [{
      group: 'team',
      field: {
        key: 'grooveChangeRule', type: 'choice', label: 'Changing Groove between games',
        options: [
          { value: 'follows-team', label: 'Same rule as the team' },
          { value: 'always', label: 'Always allowed' },
          { value: 'never', label: 'Never' },
        ],
        default: 'follows-team',
        help: 'Groove is a third axis alongside characters and ratio, and locking or freeing it changes the game more than either.',
      },
    }],
    preset: ['FT2 pools, FT3 top cut, ratio teams, 2 rounds, 99 seconds.',
      'CvS2 has been run the same way for twenty years.'],
  },
  {
    id: 'ki', name: 'Killer Instinct', short: 'Killer Instinct', mark: 'KI',
    releaseYear: 2013, platforms: plats('pc', 'xbox'),
    evo: { 2025: 'extended' },
    rules: { match: { rounds: 2, timer: '99' }, online: { crossplay: {} } },
    preset: ['FT2 pools, FT3 top cut, 2 rounds, 99 seconds.', 'The settled Killer Instinct ruleset.'],
  },
];

/* Turn a compact entry into a full game object. */
function buildGame(entry) {
  const groups = standardFightingGame(entry.rules || {});

  /* A handful of games have one field nobody else needs -- Mortal Kombat's
     Kameo, CvS2's Groove. Splicing them into an existing group beats inventing
     a group of one, which would read as more important than it is. */
  for (const extra of entry.extraFields || []) {
    const group = groups.find((g) => g.id === extra.group);
    if (group) group.fields.push(extra.field);
  }

  const [summary, source] = entry.preset;
  return {
    id: entry.id,
    name: entry.name,
    short: entry.short,
    mark: entry.mark,
    releaseYear: entry.releaseYear,
    evo: entry.evo || null,
    characters: entry.characters || [],
    platforms: entry.platforms,
    settingGroups: groups,
    presets: [entry.provisional
      ? provisionalPreset(entry.id, summary, source)
      : settledPreset(entry.id, summary, source)],
  };
}

/* --------------------------------------------------------------------------
   The registry
   --------------------------------------------------------------------------
   Tokon first because it is the one with a finished identity; Smash second;
   then the Evo lineup, most recent stage first so the list opens on what
   people are actually running.
   -------------------------------------------------------------------------- */

const evoRank = (game) => {
  if (game.evo?.[2026] === 'main') return 0;
  if (game.evo?.[2025] === 'main') return 1;
  if (game.evo?.[2026]) return 2;
  return 3;
};

export const GAMES = [
  TOKON,
  SSBU,
  ...EVO_GAMES.map(buildGame).sort((a, b) => evoRank(a) - evoRank(b) || a.short.localeCompare(b.short)),
];

export const gameById = (id) => GAMES.find((g) => g.id === id) || null;

/* Human-readable "where has this been played". Shown on the game-select card,
   because a TO choosing a game wants to know they are not alone in running it. */
export function evoLabel(game) {
  if (!game?.evo) return null;
  const years = Object.entries(game.evo)
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([year, stage]) => `Evo ${year}${stage === 'extended' ? ' (extended)' : ''}`);
  return years.join(' · ');
}

/* --------------------------------------------------------------------------
   Reading a ruleset
   -------------------------------------------------------------------------- */

/* Every field in a game, flattened. Used by the ruleset resolver and by the
   rules-sheet renderer, both of which want fields without caring about
   groups. */
export function allFields(game) {
  return (game.settingGroups || []).flatMap((group) =>
    group.fields.map((field) => ({ ...field, group: group.id, groupTitle: group.title })));
}

/* Resolve a preset (plus any TO overrides) into a complete, flat settings
   object. Missing keys take the field default, so a preset written before a
   field existed still resolves -- which is what lets us add a setting without
   invalidating every stored ruleset. */
export function resolveRuleset(game, presetId, overrides = {}) {
  const found = (game.presets || []).find((p) => p.id === presetId) || game.presets?.[0];
  const values = {};
  for (const field of allFields(game)) {
    values[field.key] = field.type === 'multi' ? [...(field.default || [])] : field.default;
  }
  Object.assign(values, found?.values || {}, overrides);
  return {
    gameId: game.id,
    presetId: found?.id || null,
    presetName: found?.name || 'Custom',
    presetVersion: found?.version || null,
    provisional: Boolean(found?.provisional),
    /* Overrides are stored SEPARATELY from the resolved values, not merged
       away, so the rules sheet can show "Standard v1.0, except…" -- the diff
       is the readable part. */
    overrides: { ...overrides },
    values,
  };
}

/* Which fields a TO changed away from their preset. Drives the "except…" line
   on the rules sheet and the diff shown when forking. */
export function rulesetDiff(game, ruleset) {
  const base = resolveRuleset(game, ruleset.presetId, {});
  const out = [];
  for (const field of allFields(game)) {
    const a = base.values[field.key];
    const b = ruleset.values[field.key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    out.push({ field, from: a, to: b });
  }
  return out;
}

/* A field or group can depend on another value (`showWhen`) -- which is how
   the online-only group stays out of the way of an offline event and how
   "which stage" only appears once you have said the stage is fixed. */
export function fieldVisible(node, context) {
  if (!node.showWhen) return true;
  return Object.entries(node.showWhen).every(([key, want]) => {
    const have = context[key];
    return Array.isArray(want) ? want.includes(have) : have === want;
  });
}

/* Render a setting value the way a human reads it. The rules sheet, the
   station card and the ruleset diff all need this, and none of them should be
   doing their own `value === 'loser-only' ? …` mapping. */
export function formatValue(field, value) {
  if (field.type === 'toggle') return value ? 'Yes' : 'No';
  if (field.type === 'multi') {
    const list = Array.isArray(value) ? value : [];
    return list.length ? list.join(', ') : 'None';
  }
  if (field.type === 'duration') return `${value} ${field.unit || 'minutes'}`;
  if (field.type === 'number') return field.unit ? `${value} ${field.unit}` : String(value);
  const opt = (field.options || []).find((o) => o.value === value);
  return opt ? opt.label : String(value ?? '—');
}
