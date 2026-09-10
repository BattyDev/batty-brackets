/* Brackets · composable ruleset groups
   ===========================================================================
   Every game in `games.js` is assembled from the builders here.

   ## Why this exists

   The registry started with two games, each with its settings written out by
   hand. That is fine at two. At twenty-one it is a disaster: "set format" is
   the same four fields in every fighting game ever made, and copying them
   twenty-one times means twenty-one places to fix when somebody points out
   that the grand-finals reset explanation is wrong.

   So the shared parts are functions, and a game supplies only what is
   genuinely its own. Street Fighter 6 is eleven lines. Tokon is longer,
   because a 4v4 tag game with a shared health bar really does have more to
   say — and that is the point: the length of a game's entry should track how
   unusual it is, not how patient whoever added it was feeling.

   ## What is shared and what is not

   Shared, because they mean the same thing everywhere:
     setFormatGroup   FT2 pools / FT3 cut, grand-finals reset
     conductGroup     DQ timer, pausing, coaching, code of conduct
     controlsGroup    leverless legality, SOCD, BYOC, controller failure
     onlineGroup      crossplay, region, how players connect, disconnects

   Parameterised, because the shape differs but the questions rhyme:
     matchGroup       rounds and timer for a round-based fighter
     teamGroup        assist tag vs sequential tag, and how many
     stocksGroup      stocks and time for a platform fighter
     stagesGroup      starters, counterpicks, striking, DSR

   Nothing here knows a game's name. A builder that special-cased one title
   would be the same mistake as writing them all out by hand, one indirection
   further away.
   =========================================================================== */

'use strict';

/* Set lengths. Shared across every game because "first to 3" means the same
   thing everywhere, and because the bracket engine reads `bestOf` off the
   event to decide how many games a set needs before it can be reported. */
export const SET_LENGTHS = [
  { value: 'ft1', label: 'FT1', help: 'Single game. Only for very large pools with no time.', games: 1 },
  { value: 'ft2', label: 'FT2', help: 'First to 2 — best of 3. The pools default.', games: 3 },
  { value: 'ft3', label: 'FT3', help: 'First to 3 — best of 5. Top cut and finals.', games: 5 },
  { value: 'ft4', label: 'FT4', help: 'First to 4 — best of 7. Rare outside grand finals.', games: 7 },
];

export const setLength = (value) => SET_LENGTHS.find((s) => s.value === value) || SET_LENGTHS[1];

const lengthOptions = (n = 4) => SET_LENGTHS.slice(0, n)
  .map((s) => ({ value: s.value, label: s.label, help: s.help }));

/* --------------------------------------------------------------------------
   Set format
   -------------------------------------------------------------------------- */

export function setFormatGroup({ pools = 'ft2', topCut = 'ft3', finals = 'ft3' } = {}) {
  return {
    id: 'set',
    title: 'Set format',
    icon: 'trophy',
    fields: [
      {
        key: 'setLengthPools', type: 'choice', label: 'Pools set length',
        options: lengthOptions(), default: pools,
        help: 'How long a set runs in pools. FT2 is the near-universal default; go FT1 only if you are badly over capacity.',
      },
      {
        key: 'setLengthTopCut', type: 'choice', label: 'Top cut set length',
        options: lengthOptions(), default: topCut,
        help: 'Bracket sets after pools. Almost always one step longer than pools.',
      },
      {
        key: 'setLengthFinals', type: 'choice', label: 'Finals set length',
        options: lengthOptions(), default: finals,
        help: 'Winners final, losers final and grand finals.',
      },
      {
        key: 'grandFinalsReset', type: 'toggle', label: 'Grand finals bracket reset', default: true,
        help: 'The winners-side player starts with a one-set lead; the losers-side player must win two sets. Standard in double elimination — turn it off only for a timed exhibition.',
      },
    ],
  };
}

/* --------------------------------------------------------------------------
   Match settings — round-based fighters
   -------------------------------------------------------------------------- */

export function matchGroup({
  rounds = 2, roundsMax = 5, timer = '99', timers = ['60', '99', 'infinite'],
  stages = null, roundsHelp = '',
} = {}) {
  const fields = [
    {
      key: 'roundsPerGame', type: 'number', label: 'Rounds per game',
      default: rounds, min: 1, max: roundsMax, unit: 'rounds won',
      help: roundsHelp || 'In-game round count. Two is standard; three makes every set roughly half again as long, which is a scheduling decision as much as a competitive one.',
    },
    {
      key: 'timer', type: 'choice', label: 'Round timer',
      options: timers.map((t) => ({ value: t, label: t === 'infinite' ? 'Infinite' : t })),
      default: timer,
      help: 'Seconds. Infinite is for exhibition only — it makes a pool impossible to schedule.',
    },
  ];

  if (stages) {
    fields.push({
      key: 'stageSelect', type: 'choice', label: 'Stage select',
      options: [
        { value: 'random', label: 'Random', help: 'Let the game pick. Fastest, and removes a negotiation.' },
        { value: 'agreement', label: 'By agreement', help: 'Players agree; if they cannot, it is random.' },
        { value: 'fixed', label: 'Fixed stage', help: 'One stage all event. Use when a stage causes a technical problem.' },
      ],
      default: stages.default || 'random',
      help: stages.help || 'In most round-based fighters the stage is cosmetic, so random is fine — unlike in a platform fighter, where the stage list IS the ruleset.',
    });
    fields.push({
      key: 'fixedStage', type: 'text', label: 'Which stage', default: '',
      showWhen: { stageSelect: 'fixed' },
      help: 'Named on the rules sheet so a station can set it without asking.',
    });
  }

  fields.push({
    key: 'gameVersion', type: 'text', label: 'Game version / patch', default: '',
    placeholder: 'e.g. 1.04',
    help: 'Write it down. When a patch lands mid-season, the version an event ran on is the only way to make sense of its results later — and it is the first thing anyone asks in a dispute.',
  });

  return { id: 'match', title: 'Match settings', icon: 'tune', fields };
}

/* --------------------------------------------------------------------------
   Teams
   --------------------------------------------------------------------------
   Two shapes, and the difference is not cosmetic.

   `sequential` — KOF, Samurai Shodown teams: characters fight one at a time,
   each with their own health, and the next one comes in when the last dies.
   The only real question is how many and whether the order may change.

   `assist` — the Marvel line, 2XKO, Invincible VS, Tokon: your team is on
   screen together or a tap away, and each member is set to an assist. That
   splits "may the loser change their team" into three separable questions —
   the members, their ORDER, and their ASSISTS — because a scene can and does
   land on different answers for each. Collapsing them into one toggle is the
   modelling mistake that makes a bracket site feel like it was not built for
   your game.
   -------------------------------------------------------------------------- */

export function teamGroup({
  style = 'assist', size = 3, sizeMax = 4, characters = [],
  sizeHelp = '', teamChangeDefault = 'loser-only',
} = {}) {
  const fields = [
    {
      key: 'teamSize', type: 'number', label: 'Team size',
      default: size, min: 1, max: sizeMax, unit: 'characters',
      help: sizeHelp || `Teams of ${size} are the default. Lower it only for a novelty side bracket.`,
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
      default: teamChangeDefault,
      help: 'The single most argued-about rule in a team fighter. Whatever you pick, it appears on the rules sheet the players see at the station.',
    },
    {
      key: 'orderChangeRule', type: 'choice', label: 'Changing team ORDER between games',
      options: [
        { value: 'follows-team', label: 'Same rule as the team', help: 'Whoever may change members may also reorder them.' },
        { value: 'always', label: 'Always allowed', help: 'Even a locked winner may reorder the same characters.' },
        { value: 'never', label: 'Never', help: 'Order is declared once and held all set.' },
      ],
      default: 'follows-team',
      help: style === 'assist'
        ? 'Order decides who starts point and which members are held back, so it is nearly a second character-select. Worth answering explicitly rather than leaving it to the station.'
        : 'Order decides who fights first and who anchors, which in a sequential team game is most of the matchup.',
    },
  ];

  if (style === 'assist') {
    fields.push({
      key: 'assistChangeRule', type: 'choice', label: 'Changing assist selection',
      options: [
        { value: 'follows-team', label: 'Same rule as the team' },
        { value: 'always', label: 'Always allowed' },
        { value: 'never', label: 'Never' },
      ],
      default: 'follows-team',
      help: 'Assists are set per team slot. If you allow assist changes but lock the team, a locked winner can still adapt.',
    });
  }

  if (characters.length) {
    fields.push({
      key: 'bannedCharacters', type: 'multi', label: 'Banned characters',
      options: characters.map((c) => ({ value: c, label: c })), default: [],
      help: 'Almost always empty. Present because a game occasionally ships something that has to go, and a TO should not have to wait for us to add the field.',
    });
  }

  return { id: 'team', title: 'Teams and assists', icon: 'group', fields };
}

/* --------------------------------------------------------------------------
   Platform fighters
   -------------------------------------------------------------------------- */

export function stocksGroup({ stocks = 3, timeLimit = 7 } = {}) {
  return {
    id: 'match',
    title: 'Match settings',
    icon: 'tune',
    fields: [
      { key: 'stocks', type: 'number', label: 'Stocks', default: stocks, min: 1, max: 5, unit: 'stocks' },
      { key: 'timeLimit', type: 'duration', label: 'Time limit', default: timeLimit, min: 3, max: 15, unit: 'minutes' },
      {
        key: 'items', type: 'choice', label: 'Items',
        options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }], default: 'off',
      },
      {
        key: 'stageHazards', type: 'choice', label: 'Stage hazards',
        options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }], default: 'off',
      },
      {
        key: 'gameVersion', type: 'text', label: 'Game version / patch', default: '',
        placeholder: 'e.g. 13.0.1',
        help: 'The version an event ran on is the first thing anyone asks in a dispute.',
      },
    ],
  };
}

export function stagesGroup({ starters = [], counterpicks = [], strikeOrder = '1-2-1' } = {}) {
  return {
    id: 'stages',
    title: 'Stages',
    icon: 'map',
    fields: [
      {
        key: 'starterStages', type: 'multi', label: 'Starter stages',
        options: starters.map((s) => ({ value: s, label: s })),
        default: starters.slice(0, 5),
        help: 'Game one is played on a starter, chosen by striking.',
      },
      {
        key: 'counterpickStages', type: 'multi', label: 'Counterpick stages',
        options: counterpicks.map((s) => ({ value: s, label: s })),
        default: counterpicks.slice(0, 3),
        help: 'Available to the loser of the previous game, in addition to the starters.',
      },
      {
        key: 'strikeOrder', type: 'choice', label: 'Game one strike order',
        options: [
          { value: '1-2-1', label: '1-2-1', help: 'Five starters. The standard.' },
          { value: '1-2-2-1', label: '1-2-2-1', help: 'Seven or nine starters.' },
        ],
        default: strikeOrder,
      },
      {
        key: 'dsr', type: 'choice', label: 'Stage repetition',
        options: [
          { value: 'mdsr', label: 'Modified DSR', help: 'You may not return to a stage you already WON on this set.' },
          { value: 'dsr', label: "Dave's Stupid Rule", help: 'No stage may be repeated at all in a set.' },
          { value: 'none', label: 'No restriction' },
        ],
        default: 'mdsr',
      },
    ],
  };
}

/* --------------------------------------------------------------------------
   Controllers
   -------------------------------------------------------------------------- */

export function controlsGroup({ simplified = null } = {}) {
  const fields = [];

  /* Only games that actually ship a simplified scheme get the question. Asking
     it about Virtua Fighter 5 would be noise, and a setting that does not
     apply is worse than a missing one -- somebody will answer it and then
     believe it means something. */
  if (simplified) {
    fields.push({
      key: 'simplifiedControls', type: 'choice',
      label: simplified.label || 'Simplified control scheme',
      options: [
        { value: 'legal', label: 'Legal', help: 'Any control scheme the game ships. The modern default.' },
        { value: 'banned', label: 'Banned', help: 'Classic inputs only.' },
      ],
      default: simplified.default || 'legal',
      help: simplified.help
        || 'This game ships a simplified input scheme, and whether it is tournament-legal is a live argument in every scene that has one. Answer it here so nobody has to ask at the station.',
    });
  }

  fields.push(
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
  );

  return { id: 'controls', title: 'Controllers and inputs', icon: 'sports_esports', fields };
}

/* --------------------------------------------------------------------------
   Conduct
   -------------------------------------------------------------------------- */

export function conductGroup({ dqTimer = 5 } = {}) {
  return {
    id: 'conduct',
    title: 'Conduct and timing',
    icon: 'gavel',
    fields: [
      {
        key: 'dqTimer', type: 'duration', label: 'DQ timer',
        default: dqTimer, min: 1, max: 30, unit: 'minutes',
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
  };
}

/* --------------------------------------------------------------------------
   Online
   -------------------------------------------------------------------------- */

export function onlineGroup({ crossplay = null, disconnectHelp = '' } = {}) {
  const fields = [];

  if (crossplay) {
    fields.push({
      key: 'crossplay', type: 'toggle', label: 'Crossplay required', default: true,
      help: crossplay.help || 'Entrants must have crossplay enabled, or half your bracket cannot find the other half.',
    });
  }

  fields.push(
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
        { value: 'loss-if-losing', label: 'Loss if they were behind' },
        { value: 'to-discretion', label: 'TO discretion' },
      ],
      default: 'replay',
      help: disconnectHelp || 'Replaying is the fair default, and the one that gets abused. Loss-if-losing needs both players to agree on who was ahead, which is easier in some games than others.',
    },
  );

  return { id: 'online', title: 'Online play', icon: 'wifi', showWhen: { venueType: 'online' }, fields };
}

/* --------------------------------------------------------------------------
   Assembly
   --------------------------------------------------------------------------
   The common case: a round-based 1v1 fighter. Everything a game does not
   specify falls back to the shared default, so adding a title is a handful of
   lines rather than a wall of copied fields.
   -------------------------------------------------------------------------- */

export function standardFightingGame({
  set, match, team, controls, conduct, online, stages, stocks,
} = {}) {
  const groups = [setFormatGroup(set)];

  if (stocks) groups.push(stocksGroup(stocks));
  else groups.push(matchGroup(match));

  if (team) groups.push(teamGroup(team));
  if (stages) groups.push(stagesGroup(stages));

  groups.push(controlsGroup(controls));
  groups.push(conductGroup(conduct));
  groups.push(onlineGroup(online));

  return groups;
}
