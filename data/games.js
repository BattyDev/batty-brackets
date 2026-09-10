/* Brackets · the game registry
   ---------------------------------------------------------------------------
   A game here is DATA, not code. Everything the setup wizard renders -- every
   field, every default, every validation -- comes out of the objects below, and
   `views/setup.js` never mentions a game by name. Adding a third game is a new
   file in this directory and one line in GAMES; it is not a change to the
   wizard, the admin console, or the bracket engine.

   That constraint is the whole point. start.gg's per-game handling is a special
   case bolted on per title, which is why a new game shows up there as "Melee
   with the words changed" for a year. Marvel Tokon is three months old at the
   time of writing and its rules are going to move under us, so the thing that
   has to be cheap is not "add a game" -- it is "change a game's rules on a
   Tuesday because the community argued about it on the weekend".

   ## Rulesets are versioned and forkable, never hardcoded

   Each game ships one or more PRESETS. A preset is a named, dated, immutable
   bundle of setting values with a `version` and a `source` -- who says so. An
   event does not "use the standard ruleset"; it takes a COPY of a preset at
   creation and stores it on the event. A preset that changes later therefore
   cannot silently rewrite the rules of an event that is already running, which
   is a real failure mode when the rules are the thing people are arguing about
   at 11pm in a venue.

   A TO can fork any preset, override any field, and publish the result under
   their own name. The fork records what it came from, so "Batty Weekly rules =
   Community Standard v0.3, except DQ timer is 10 minutes" is a diff a player
   can actually read -- rather than the wall of prose in a Discord pin that
   nobody has re-read since March.

   ## On the accuracy of the Tokon ruleset below

   MARVEL Tokon: Fighting Souls is a 4v4 tag fighter from Arc System Works with
   a shared team health bar, "Assemble" assists, and crossplay between PS5 and
   PC. Those mechanics are documented. What is NOT documented -- because the
   scene has not settled it yet -- is the competitive convention layered on top:
   whether the loser of a game may change their team order, whether simplified
   controls are legal, how long the DQ timer runs.

   So the preset below is marked `provisional: true` and its `source` says so
   in as many words. It is seeded from what neighbouring tag fighters (the MvC
   line, DBFZ) settled on, because that is what a local TO will reach for by
   default -- not because anyone has ratified it. The UI surfaces that
   provisional flag to the TO at setup time and to the player on the rules
   sheet. Presenting a guess as a standard is how a bracket site ends up
   accidentally writing a scene's rules, and we should not do that by accident.
   We should do it on purpose, in the open, with a version number on it. */

'use strict';

/* --------------------------------------------------------------------------
   Field types the wizard knows how to render.

   Deliberately small. Every new type is a new branch in the renderer and a new
   thing that can be wrong on a phone, so a setting that could be a `choice`
   should be a `choice`.

     text     · single-line string
     longtext · textarea, used for prose rules
     number   · integer with min/max/step and a unit label
     choice   · one of `options`, rendered as M3 segmented buttons or a select
                depending on count
     multi    · any of `options`, rendered as filter chips
     toggle   · boolean, rendered as an M3 switch
     duration · minutes, rendered with a unit and quick presets
   -------------------------------------------------------------------------- */

/* Set lengths. Shared across games because "first to 3" means the same thing
   everywhere, and because the bracket engine reads `bestOf` off the event to
   decide how many games a set needs before it can be reported. */
export const SET_LENGTHS = [
  { value: 'ft1', label: 'FT1', help: 'Single game. Only for very large pools with no time.', games: 1 },
  { value: 'ft2', label: 'FT2', help: 'First to 2 — best of 3. The pools default.', games: 3 },
  { value: 'ft3', label: 'FT3', help: 'First to 3 — best of 5. Top cut and finals.', games: 5 },
  { value: 'ft4', label: 'FT4', help: 'First to 4 — best of 7. Rare outside grand finals.', games: 7 },
];

export const setLength = (value) => SET_LENGTHS.find((s) => s.value === value) || SET_LENGTHS[1];

/* --------------------------------------------------------------------------
   MARVEL TOKON: FIGHTING SOULS
   -------------------------------------------------------------------------- */

/* The roster is used for two things: the "mains" a player lists on their
   passport, and a TO's optional character-restriction setting (a beginner
   bracket that bans nobody still wants the picker to work). It is intentionally
   a flat list of names with no move data -- this is a bracket site, not a
   frame-data site, and a stale frame table is worse than no frame table.

   Kept in `characters` on the game rather than in a separate file so that the
   passport, the restriction setting and the match-report character picker all
   read one source. */
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
  /* Two-letter mark used in the bracket grid and the station cards, where a
     full title does not fit and an icon would need a licensed asset. */
  mark: 'TK',
  accent: '#c0392b',
  releaseYear: 2026,
  characters: TOKON_CHARACTERS,

  /* Platform pool. Matters more than usual here: Tokon has crossplay between
     PS5 and PC and it is ON by default, but an offline event runs on hardware
     the venue owns, and "we have six PS5s and two PCs" changes what a station
     can host. The run view uses this to stop a TO from calling a PC-only
     entrant to a console-only station. */
  platforms: [
    { value: 'ps5', label: 'PlayStation 5' },
    { value: 'pc', label: 'PC (Steam)' },
  ],

  /* ------------------------------------------------------------------------
     The setting schema.

     Grouped, because a TO setting up an event on a phone at work should be
     able to collapse everything except the group they care about, and because
     the rules sheet a player reads is generated from these same groups. Every
     field carries `help` -- not as decoration, but because the number one
     reason a local's rules are wrong is that the TO did not know what the
     setting meant and left the default.
     ---------------------------------------------------------------------- */
  settingGroups: [
    {
      id: 'set',
      title: 'Set format',
      icon: 'trophy',
      fields: [
        {
          key: 'setLengthPools', type: 'choice', label: 'Pools set length',
          options: SET_LENGTHS.map((s) => ({ value: s.value, label: s.label, help: s.help })),
          default: 'ft2',
          help: 'How long a set runs in pools. FT2 is the near-universal default; go FT1 only if you are badly over capacity.',
        },
        {
          key: 'setLengthTopCut', type: 'choice', label: 'Top cut set length',
          options: SET_LENGTHS.map((s) => ({ value: s.value, label: s.label, help: s.help })),
          default: 'ft3',
          help: 'Bracket sets after pools. Almost always one step longer than pools.',
        },
        {
          key: 'setLengthFinals', type: 'choice', label: 'Finals set length',
          options: SET_LENGTHS.map((s) => ({ value: s.value, label: s.label, help: s.help })),
          default: 'ft3',
          help: 'Winners final, losers final and grand finals.',
        },
        {
          key: 'grandFinalsReset', type: 'toggle', label: 'Grand finals bracket reset',
          default: true,
          help: 'The winners-side player starts with a one-set lead; the losers-side player must win two sets. Standard in double elimination — turn it off only for a timed exhibition.',
        },
      ],
    },

    {
      id: 'team',
      title: 'Teams and assists',
      icon: 'group',
      /* This group is the reason Tokon needs its own schema rather than
         inheriting a generic fighting-game one. In a 1v1 game "can the loser
         change character" is one setting. In a 4v4 tag game with a shared
         health bar there are three separable questions -- the four members,
         the ORDER they are in (which decides who is point and who is on the
         back half of the team), and the assist each one is set to -- and a
         scene can and will land on different answers for each. Collapsing them
         into one toggle is exactly the modelling mistake that makes an
         existing site feel like it was not built for your game. */
      fields: [
        {
          key: 'teamSize', type: 'number', label: 'Team size', default: 4, min: 1, max: 4, unit: 'characters',
          help: 'Tokon is 4v4 by default. Lower it only for a novelty side bracket.',
        },
        {
          key: 'duplicateCharacters', type: 'choice', label: 'Duplicate characters',
          options: [
            { value: 'banned', label: 'Banned', help: 'No character may appear twice on the same team.' },
            { value: 'allowed', label: 'Allowed', help: 'Anything the game permits.' },
          ],
          default: 'banned',
          help: 'Only relevant if the game itself allows a duplicate. Default matches how the character select behaves.',
        },
        {
          key: 'teamChangeRule', type: 'choice', label: 'Changing team between games',
          options: [
            {
              value: 'loser-only', label: 'Loser may change, winner locked',
              help: 'The Marvel convention. The player who lost the game may change members, order and assists; the winner is locked to what won.',
            },
            {
              value: 'both', label: 'Both may change',
              help: 'More permissive, faster, and removes an argument at the station. Increasingly common at locals.',
            },
            {
              value: 'locked', label: 'Locked for the whole set',
              help: 'Both players declare a team before game 1 and keep it. Rare — it punishes blind matchups hard.',
            },
          ],
          default: 'loser-only',
          help: 'The single most argued-about rule in a tag fighter. Whatever you pick, it appears on the rules sheet the players see at the station.',
        },
        {
          key: 'orderChangeRule', type: 'choice', label: 'Changing team ORDER between games',
          options: [
            { value: 'follows-team', label: 'Same rule as the team', help: 'Whoever may change members may also reorder them.' },
            { value: 'always', label: 'Always allowed', help: 'Even a locked winner may reorder the same four characters.' },
            { value: 'never', label: 'Never', help: 'Order is declared once and held all set.' },
          ],
          default: 'follows-team',
          help: 'Order decides who starts point and which two members are held back, so in Tokon this is nearly a second character-select. Worth answering explicitly rather than leaving it to the station.',
        },
        {
          key: 'assistChangeRule', type: 'choice', label: 'Changing assist selection',
          options: [
            { value: 'follows-team', label: 'Same rule as the team' },
            { value: 'always', label: 'Always allowed' },
            { value: 'never', label: 'Never' },
          ],
          default: 'follows-team',
          help: 'Assemble assists are set per team slot. If you allow assist changes but lock the team, a locked winner can still adapt.',
        },
        {
          key: 'bannedCharacters', type: 'multi', label: 'Banned characters',
          options: TOKON_CHARACTERS.map((c) => ({ value: c, label: c })),
          default: [],
          help: 'Almost always empty. Present because a brand-new game occasionally ships something that has to go, and a TO should not have to wait for us to add the field.',
        },
      ],
    },

    {
      id: 'match',
      title: 'Match settings',
      icon: 'tune',
      fields: [
        {
          key: 'roundsPerGame', type: 'number', label: 'Rounds per game', default: 2, min: 1, max: 5, unit: 'rounds won',
          help: 'In-game round count. Tokon rounds also gate when your third and fourth members become available, so changing this changes the game, not just its length.',
        },
        {
          key: 'timer', type: 'choice', label: 'Round timer',
          options: [
            { value: '60', label: '60' }, { value: '99', label: '99' }, { value: 'infinite', label: 'Infinite' },
          ],
          default: '99',
          help: 'Seconds. Infinite is for exhibition only — it makes a pool impossible to schedule.',
        },
        {
          key: 'stageSelect', type: 'choice', label: 'Stage select',
          options: [
            { value: 'random', label: 'Random', help: 'Let the game pick. Fastest, and removes a negotiation.' },
            { value: 'agreement', label: 'By agreement', help: 'Players agree; if they cannot, it is random.' },
            { value: 'fixed', label: 'Fixed stage', help: 'One stage all event. Use when a stage causes a technical problem.' },
          ],
          default: 'random',
          help: 'Tokon stages have transitions rather than competitive hazards, so random is usually fine — unlike in a platform fighter, where the stage list IS the ruleset.',
        },
        {
          key: 'fixedStage', type: 'text', label: 'Which stage', default: '',
          showWhen: { stageSelect: 'fixed' },
          help: 'Named on the rules sheet so a station can set it without asking.',
        },
        {
          key: 'gameVersion', type: 'text', label: 'Game version / patch', default: '',
          placeholder: 'e.g. 1.04',
          help: 'Write it down. When a patch lands mid-season, the version an event ran on is the only way to make sense of its results later — and it is the first thing anyone asks in a dispute.',
        },
      ],
    },

    {
      id: 'controls',
      title: 'Controllers and inputs',
      icon: 'sports_esports',
      fields: [
        {
          key: 'simplifiedControls', type: 'choice', label: 'Simplified control scheme',
          options: [
            { value: 'legal', label: 'Legal', help: 'Any control scheme the game ships. The modern default.' },
            { value: 'banned', label: 'Banned', help: 'Classic inputs only.' },
          ],
          default: 'legal',
          help: 'Modern fighting games ship a simplified input scheme, and whether it is tournament-legal is a live argument in every scene that has one. Answer it here so nobody has to ask at the station.',
        },
        {
          key: 'leverless', type: 'choice', label: 'Leverless / hitbox controllers',
          options: [
            { value: 'legal', label: 'Legal' },
            { value: 'legal-no-socd', label: 'Legal, SOCD cleaning required' },
            { value: 'banned', label: 'Banned' },
          ],
          default: 'legal-no-socd',
          help: 'SOCD is what a controller does when you hold left and right at once. Requiring cleaning is the usual middle ground; banning leverless outright will cost you entrants.',
        },
        {
          key: 'byoc', type: 'toggle', label: 'Bring your own controller', default: true,
          help: 'Turn off only if the venue supplies pads and you do not want adapters plugged into its hardware.',
        },
        {
          key: 'controllerFailure', type: 'choice', label: 'If a controller fails mid-game',
          options: [
            { value: 'loss', label: 'Game is a loss', help: 'Strict. Puts the burden on the player to bring working hardware.' },
            { value: 'replay-once', label: 'Replay the game, once per set', help: 'Humane, and the common local rule.' },
            { value: 'to-discretion', label: 'TO discretion' },
          ],
          default: 'replay-once',
          help: 'Decide this before it happens, not while two people are standing over a dead pad.',
        },
      ],
    },

    {
      id: 'conduct',
      title: 'Conduct and timing',
      icon: 'gavel',
      fields: [
        {
          key: 'dqTimer', type: 'duration', label: 'DQ timer', default: 5, min: 1, max: 30, unit: 'minutes',
          help: 'How long after being called a player has before they can be disqualified. Five minutes is standard; the run view starts this clock for you when a set is called, so the number here is the one it counts down.',
        },
        {
          key: 'pauseRule', type: 'choice', label: 'Pausing',
          options: [
            { value: 'banned', label: 'Banned — pausing forfeits the round' },
            { value: 'allowed-emergency', label: 'Allowed for genuine emergencies only' },
            { value: 'allowed', label: 'Allowed' },
          ],
          default: 'allowed-emergency',
          help: 'Fighting-game standard is that an unintentional pause costs you the round.',
        },
        {
          key: 'coaching', type: 'choice', label: 'Coaching',
          options: [
            { value: 'between-games', label: 'Between games only' },
            { value: 'banned', label: 'Banned' },
            { value: 'allowed', label: 'Allowed at any time' },
          ],
          default: 'between-games',
          help: 'Between-games coaching is the usual compromise; it keeps a set moving while letting a teammate help.',
        },
        {
          key: 'codeOfConduct', type: 'longtext', label: 'Code of conduct', default: '',
          help: 'Shown to every entrant at registration, and — if you attach it as a signed document — recorded against their name with a timestamp.',
        },
      ],
    },

    {
      id: 'online',
      title: 'Online play',
      icon: 'wifi',
      showWhen: { venueType: 'online' },
      /* Only rendered for online events. Tokon's crossplay setting lives in an
         in-game menu that people genuinely cannot find (Battle > Casual or
         Ranked > "Match Platform" > All), so the help text says where it is.
         Every minute a TO does not spend explaining that in Discord is the
         product working. */
      fields: [
        {
          key: 'crossplay', type: 'toggle', label: 'Crossplay required', default: true,
          help: 'Tokon matches PS5 and PC in one pool. Entrants must set Match Platform to "All" — it is under Battle > Casual/Ranked, fourth row. Turn this off only if you are running a platform-locked bracket.',
        },
        {
          key: 'regionLock', type: 'choice', label: 'Region',
          options: [
            { value: 'na-east', label: 'NA East' }, { value: 'na-west', label: 'NA West' },
            { value: 'na', label: 'NA (any)' }, { value: 'eu', label: 'Europe' },
            { value: 'apac', label: 'Asia-Pacific' }, { value: 'open', label: 'Open' },
          ],
          default: 'na',
          help: 'Used to warn at seeding time when a bracket would pair a west-coast and a European entrant in round one.',
        },
        {
          key: 'lobbyMethod', type: 'choice', label: 'How players connect',
          options: [
            { value: 'direct', label: 'Direct — player ID search' },
            { value: 'room', label: 'Custom room code' },
          ],
          default: 'direct',
          help: 'Direct requires each entrant to have a platform ID on their profile. The site checks that at check-in and tells you who is missing one, rather than letting you find out when a set stalls.',
        },
        {
          key: 'disconnectRule', type: 'choice', label: 'If a player disconnects',
          options: [
            { value: 'replay', label: 'Replay the game' },
            { value: 'loss-if-losing', label: 'Loss if they were behind on health' },
            { value: 'to-discretion', label: 'TO discretion' },
          ],
          default: 'replay',
          help: 'Tokon uses a shared team health bar, so "who was ahead" is a single number both players can see — which makes the loss-if-losing rule unusually enforceable here.',
        },
      ],
    },
  ],

  /* ------------------------------------------------------------------------
     Presets. `values` only needs to carry what differs from the field
     defaults; `resolveRuleset` fills in the rest.
     ---------------------------------------------------------------------- */
  presets: [
    {
      id: 'tokon-standard-0-3',
      name: 'Community Standard',
      version: '0.3',
      updated: '2026-08-14',
      provisional: true,
      source: 'Assembled by BattyDev from what the Tokon Discords are running as of August 2026. NOT ratified by anyone. Read it before you use it.',
      summary: 'FT2 pools, FT3 top cut, loser may change team, simplified controls legal.',
      values: {},
    },
    {
      id: 'tokon-locals-fast',
      name: 'Fast Local',
      version: '1.0',
      updated: '2026-08-14',
      provisional: true,
      source: 'For a weekly that has to be out of the venue by 11.',
      summary: 'FT2 throughout, both players may change team, 3-minute DQ timer.',
      values: {
        setLengthTopCut: 'ft2', setLengthFinals: 'ft3',
        teamChangeRule: 'both', dqTimer: 3, stageSelect: 'random',
      },
    },
    {
      id: 'tokon-major',
      name: 'Major',
      version: '1.0',
      updated: '2026-08-14',
      provisional: true,
      source: 'Stricter defaults for an event with a stream and a prize pot.',
      summary: 'FT2 pools / FT3 cut, winner locked, coaching between games, 10-minute DQ.',
      values: {
        teamChangeRule: 'loser-only', orderChangeRule: 'follows-team',
        dqTimer: 10, coaching: 'between-games', pauseRule: 'banned',
        leverless: 'legal-no-socd',
      },
    },
  ],
};

/* --------------------------------------------------------------------------
   SUPER SMASH BROS. ULTIMATE
   --------------------------------------------------------------------------
   Deliberately thin, per the brief -- but thin in the right place. The stage
   list is not optional detail in a platform fighter; it IS the ruleset, in the
   way the team rules are the ruleset in Tokon. So SSBU gets a real stage
   model and skips almost everything else, which is a better "barebones" than
   an even sprinkle of half-fields across every group.

   It also exists to prove the registry claim above: this file adds a game
   with a completely different shape -- stage striking, stocks, no teams -- and
   the wizard, the admin console and the bracket engine did not change. */
const SSBU = {
  id: 'ssbu',
  name: 'Super Smash Bros. Ultimate',
  short: 'Smash Ultimate',
  mark: 'SSB',
  accent: '#e4572e',
  releaseYear: 2018,
  characters: [],
  platforms: [{ value: 'switch', label: 'Nintendo Switch' }],

  settingGroups: [
    {
      id: 'set',
      title: 'Set format',
      icon: 'trophy',
      fields: [
        {
          key: 'setLengthPools', type: 'choice', label: 'Pools set length',
          options: SET_LENGTHS.slice(0, 3).map((s) => ({ value: s.value, label: s.label, help: s.help })),
          default: 'ft2', help: 'Best of 3 in pools is near-universal.',
        },
        {
          key: 'setLengthTopCut', type: 'choice', label: 'Top cut set length',
          options: SET_LENGTHS.slice(0, 4).map((s) => ({ value: s.value, label: s.label, help: s.help })),
          default: 'ft3', help: 'Best of 5 from top 8 onward is the usual step-up.',
        },
        {
          key: 'setLengthFinals', type: 'choice', label: 'Finals set length',
          options: SET_LENGTHS.slice(0, 4).map((s) => ({ value: s.value, label: s.label, help: s.help })),
          default: 'ft3', help: 'Winners final, losers final, grand finals.',
        },
        { key: 'grandFinalsReset', type: 'toggle', label: 'Grand finals bracket reset', default: true },
      ],
    },
    {
      id: 'match',
      title: 'Match settings',
      icon: 'tune',
      fields: [
        { key: 'stocks', type: 'number', label: 'Stocks', default: 3, min: 1, max: 5, unit: 'stocks' },
        { key: 'timeLimit', type: 'duration', label: 'Time limit', default: 7, min: 3, max: 15, unit: 'minutes' },
        {
          key: 'items', type: 'choice', label: 'Items',
          options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }],
          default: 'off',
        },
        {
          key: 'stageHazards', type: 'choice', label: 'Stage hazards',
          options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }],
          default: 'off',
        },
      ],
    },
    {
      id: 'stages',
      title: 'Stages',
      icon: 'map',
      fields: [
        {
          key: 'starterStages', type: 'multi', label: 'Starter stages',
          options: [
            'Battlefield', 'Small Battlefield', 'Final Destination', 'Pokémon Stadium 2',
            'Smashville', 'Town and City', 'Hollow Bastion', 'Yoshi\'s Story',
          ].map((s) => ({ value: s, label: s })),
          default: ['Battlefield', 'Small Battlefield', 'Final Destination', 'Pokémon Stadium 2', 'Smashville'],
          help: 'Game one is played on a starter, chosen by striking.',
        },
        {
          key: 'counterpickStages', type: 'multi', label: 'Counterpick stages',
          options: [
            'Town and City', 'Kalos Pokémon League', 'Hollow Bastion', 'Yoshi\'s Story',
            'Northern Cave', 'Yoshi\'s Island (Brawl)',
          ].map((s) => ({ value: s, label: s })),
          default: ['Town and City', 'Kalos Pokémon League', 'Hollow Bastion'],
          help: 'Available to the loser of the previous game, in addition to the starters.',
        },
        {
          key: 'strikeOrder', type: 'choice', label: 'Game one strike order',
          options: [
            { value: '1-2-1', label: '1-2-1', help: 'Five starters. The standard.' },
            { value: '1-2-2-1', label: '1-2-2-1', help: 'Seven or nine starters.' },
          ],
          default: '1-2-1',
        },
        {
          key: 'dsr', type: 'choice', label: 'Stage repetition',
          options: [
            { value: 'mdsr', label: 'Modified DSR', help: 'You may not return to a stage you already WON on this set.' },
            { value: 'dsr', label: 'Dave\'s Stupid Rule', help: 'No stage may be repeated at all in a set.' },
            { value: 'none', label: 'No restriction' },
          ],
          default: 'mdsr',
        },
      ],
    },
    {
      id: 'conduct',
      title: 'Conduct and timing',
      icon: 'gavel',
      fields: [
        { key: 'dqTimer', type: 'duration', label: 'DQ timer', default: 5, min: 1, max: 30, unit: 'minutes' },
        {
          key: 'coaching', type: 'choice', label: 'Coaching',
          options: [
            { value: 'between-games', label: 'Between games only' },
            { value: 'banned', label: 'Banned' },
            { value: 'allowed', label: 'Allowed at any time' },
          ],
          default: 'between-games',
        },
        { key: 'codeOfConduct', type: 'longtext', label: 'Code of conduct', default: '' },
      ],
    },
  ],

  presets: [
    {
      id: 'ssbu-standard',
      name: 'Standard Singles',
      version: '1.0',
      updated: '2026-08-14',
      provisional: false,
      source: 'The ruleset almost every SSBU local has run for years: 3 stocks, 7 minutes, 5 starters, modified DSR.',
      summary: '3 stocks, 7 minutes, 1-2-1 striking, modified DSR.',
      values: {},
    },
  ],
};

export const GAMES = [TOKON, SSBU];

export const gameById = (id) => GAMES.find((g) => g.id === id) || null;

/* Every field in a game, flattened. Used by the ruleset resolver and by the
   rules-sheet renderer, both of which want fields without caring about groups. */
export function allFields(game) {
  return (game.settingGroups || []).flatMap((group) =>
    group.fields.map((field) => ({ ...field, group: group.id, groupTitle: group.title })));
}

/* Resolve a preset (plus any TO overrides) into a complete, flat settings
   object. Missing keys take the field default, so a preset written before a
   field existed still resolves -- which is what lets us add a setting without
   invalidating every stored ruleset. */
export function resolveRuleset(game, presetId, overrides = {}) {
  const preset = (game.presets || []).find((p) => p.id === presetId) || game.presets?.[0];
  const values = {};
  for (const field of allFields(game)) {
    values[field.key] = field.type === 'multi' ? [...(field.default || [])] : field.default;
  }
  Object.assign(values, preset?.values || {}, overrides);
  return {
    gameId: game.id,
    presetId: preset?.id || null,
    presetName: preset?.name || 'Custom',
    presetVersion: preset?.version || null,
    provisional: Boolean(preset?.provisional),
    /* The overrides are stored SEPARATELY from the resolved values, not merged
       away, so the rules sheet can show "Community Standard v0.3, except…" --
       the diff is the readable part. */
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

/* A field can depend on another field's value (`showWhen`), which is how the
   online-only group stays out of the way of an offline event and how "which
   stage" only appears once you have said the stage is fixed. Evaluated against
   the merged settings + event context so a group can key off `venueType`,
   which lives on the event rather than in the ruleset. */
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
