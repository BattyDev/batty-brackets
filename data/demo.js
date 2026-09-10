/* Brackets · demo data
   ===========================================================================
   Seeded once, on a device that has never held a real event, so that opening
   the page shows a working tournament rather than an empty state with a tour.

   The data is chosen to exercise the parts that are hard, not the parts that
   look good in a screenshot:

     * 27 entrants, so the bracket is 32 with five byes -- an awkward number,
       which is the normal number
     * four entrants not checked in, so the no-show guidance has something to
       say the moment you open the run view
     * two players from the same venue seeded next to each other, so the
       separation pass has real work to do
     * one duplicate (the same person pre-registered and typed in at the door)
       for the duplicate detector
     * one entrant with no PSN ID on an event that has an online qualifier
     * a season of past results, so head-to-head records are not empty

   Names are invented. Any resemblance to a real player's tag is coincidence
   and not an endorsement of their neutral game.
   =========================================================================== */

'use strict';

const TAGS = [
  ['Kira', 'Batty Mac', 'she/her', 'Spider-Man'],
  ['Dominic', 'Batty Mac', 'he/him', 'Doctor Doom'],
  ['Rae', 'Northside', 'they/them', 'Storm'],
  ['Volt', 'Northside', 'he/him', 'Iron Man'],
  ['Marisol', 'Batty Mac', 'she/her', 'Scarlet Witch'],
  ['Tenner', 'Cross Counter', 'he/him', 'Wolverine'],
  ['Sable', 'Northside', 'she/her', 'Psylocke'],
  ['Gus', 'Cross Counter', 'he/him', 'Hulk'],
  ['Nine', 'Batty Mac', 'they/them', 'Magneto'],
  ['Priya', 'Uptown', 'she/her', 'Ms. Marvel'],
  ['Okafor', 'Uptown', 'he/him', 'Black Panther'],
  ['Zeke', 'Cross Counter', 'he/him', 'Ghost Rider'],
  ['Lumen', 'Northside', 'she/her', 'Doctor Strange'],
  ['Brick', 'Uptown', 'he/him', 'Thor'],
  ['Ash', 'Batty Mac', 'they/them', 'Venom'],
  ['Fen', 'Cross Counter', 'she/her', 'Gamora'],
  ['Halcyon', 'Uptown', 'he/him', 'Captain America'],
  ['Juno', 'Northside', 'she/her', 'Star-Lord'],
  ['Kestrel', 'Batty Mac', 'they/them', 'Blade'],
  ['Mook', 'Cross Counter', 'he/him', 'Rocket Raccoon'],
  ['Nova', 'Uptown', 'she/her', 'Storm'],
  ['Pell', 'Northside', 'he/him', 'Iron Man'],
  ['Quill', 'Batty Mac', 'they/them', 'Spider-Man'],
  ['Rook', 'Cross Counter', 'he/him', 'Doctor Doom'],
  ['Sev', 'Uptown', 'she/her', 'Wolverine'],
  ['Tobi', 'Northside', 'he/him', 'Magneto'],
];

const ago = (days, hours = 0) => new Date(Date.now() - days * 864e5 - hours * 36e5).toISOString();
const ahead = (mins) => new Date(Date.now() + mins * 60000).toISOString();

export function seedDemoData({ apply, uid, inviteCode }) {
  const orgId = 'org_battymac';
  apply('orgs', orgId, {
    id: orgId,
    name: 'Batty Mac Arcade',
    blurb: 'Weekly fighting games in the back room. Tuesdays, 7pm, $5.',
    region: 'NA East',
    createdAt: ago(400),
  }, { queueIt: false });

  /* ---- players ---- */
  const players = TAGS.map(([tag, group, pronouns, main], i) => {
    const id = `plr_demo${String(i + 1).padStart(2, '0')}`;
    apply('players', id, {
      id, tag, pronouns, region: 'NA East',
      homeVenue: group,
      mains: { tokon: [main] },
      connections: {
        discord: `${tag.toLowerCase().replace(/\s+/g, '')}`,
        /* One player deliberately has no platform ID -- the online-readiness
           check needs something to find. */
        ...(tag === 'Brick' ? {} : { psn: `${tag.replace(/\s+/g, '')}_PSN` }),
        ...(i % 3 === 0 ? { twitch: tag.toLowerCase() } : {}),
      },
      claimable: false,
      createdAt: ago(300 - i * 4),
      demo: true,
    }, { queueIt: false });
    return { id, tag, group };
  });

  /* One walk-up entrant with no account: created at the door, claimable. */
  const walkUp = 'plr_demo_walkup';
  apply('players', walkUp, {
    id: walkUp, tag: 'Sm0ke', claimable: true, claimCode: 'QRTX7HMN',
    claimOrgId: orgId, homeVenue: 'Batty Mac', region: 'NA East',
    connections: {}, createdAt: ago(0, 2), demo: true,
  }, { queueIt: false });

  /* And the duplicate: the same human, pre-registered under a sponsor prefix
     and typed in again at the desk without it. */
  const dupe = 'plr_demo_dupe';
  apply('players', dupe, {
    id: dupe, tag: 'BTY | Kira', claimable: true, claimCode: 'WPLM4KDS',
    claimOrgId: orgId, homeVenue: 'Batty Mac', connections: {},
    createdAt: ago(0, 1), demo: true,
  }, { queueIt: false });

  /* ---- the live event ---- */
  const eventId = 'evt_demo_tokon';
  apply('events', eventId, {
    id: eventId, orgId,
    name: 'Tokon Tuesdays #14',
    gameId: 'tokon',
    format: 'double',
    venueType: 'offline',
    venue: 'Batty Mac Arcade, back room',
    platforms: ['ps5'],
    startsAt: ago(0, 1),
    checkInOpensAt: ago(0, 2),
    checkInClosesAt: ahead(6),
    status: 'checkin',
    entryFee: 5,
    currency: 'USD',
    capacity: 48,
    inviteCode: 'TKN14B',
    presetId: 'tokon-standard-0-3',
    overrides: { dqTimer: 5 },
    documents: [
      { id: 'doc_coc', title: 'Code of conduct', required: true, version: 2 },
      { id: 'doc_media', title: 'Stream and photo release', required: false, version: 1 },
    ],
    createdAt: ago(14),
    demo: true,
  }, { queueIt: false });

  /* ---- entries ---- */
  const roster = [...players, { id: walkUp, tag: 'Sm0ke', group: 'Batty Mac' }, { id: dupe, tag: 'BTY | Kira', group: 'Batty Mac' }];
  roster.forEach((player, i) => {
    const id = `ent_demo${String(i + 1).padStart(2, '0')}`;
    /* Four no-shows, spread through the seeds rather than all at the bottom,
       because that is what actually happens and it is what makes re-seeding a
       real decision rather than an obvious one. */
    const noShow = [3, 11, 18, 24].includes(i);
    apply('entries', id, {
      id, eventId, playerId: player.id,
      seed: i + 1,
      group: player.group,
      checkedInAt: noShow ? null : ago(0, 1),
      paidAt: noShow || i % 7 === 0 ? null : ago(0, 1),
      signedDocuments: i % 5 === 0 ? [] : ['doc_coc'],
      registeredAt: ago(i < 20 ? 5 : 0, i < 20 ? 0 : 2),
      source: i < 20 ? 'online' : 'door',
      demo: true,
    }, { queueIt: false });
  });

  /* ---- an upcoming Smash event, to show the game registry is not
         Tokon-shaped ---- */
  const ssbuId = 'evt_demo_ssbu';
  apply('events', ssbuId, {
    id: ssbuId, orgId,
    name: 'Ultimate Thursdays #63',
    gameId: 'ssbu',
    format: 'double',
    venueType: 'offline',
    venue: 'Batty Mac Arcade, front room',
    platforms: ['switch'],
    startsAt: ahead(60 * 26),
    status: 'registration',
    entryFee: 5,
    currency: 'USD',
    capacity: 64,
    inviteCode: 'SSB63',
    presetId: 'ssbu-standard',
    overrides: {},
    documents: [{ id: 'doc_coc', title: 'Code of conduct', required: true, version: 2 }],
    createdAt: ago(6),
    demo: true,
  }, { queueIt: false });

  players.slice(0, 9).forEach((player, i) => {
    apply('entries', `ent_ssbu${i}`, {
      id: `ent_ssbu${i}`, eventId: ssbuId, playerId: player.id,
      seed: i + 1, group: player.group,
      registeredAt: ago(4 - i * 0.2), source: 'online',
      signedDocuments: ['doc_coc'], demo: true,
    }, { queueIt: false });
  });

  /* ---- stations ---- */
  ['1', '2', '3', '4', 'Stream'].forEach((label, i) => {
    apply('stations', `stn_demo${i}`, {
      id: `stn_demo${i}`, eventId, number: i + 1, label: label === 'Stream' ? 'Stream station' : `Station ${label}`,
      stream: label === 'Stream', platform: 'ps5', demo: true,
    }, { queueIt: false });
  });

  /* ---- history, so profiles are not empty ----
     Thirteen past weeklies. Deterministic rather than random: a demo that
     shuffles on every reload makes it impossible to tell a rendering bug from
     the data changing under you. */
  let n = 0;
  for (let week = 13; week >= 1; week -= 1) {
    const pastEventId = `evt_demo_past${week}`;
    apply('events', pastEventId, {
      id: pastEventId, orgId, name: `Tokon Tuesdays #${14 - week}`,
      gameId: 'tokon', format: 'double', venueType: 'offline',
      startsAt: ago(week * 7), status: 'complete',
      presetId: 'tokon-standard-0-3', overrides: {}, demo: true,
    }, { queueIt: false });

    for (let i = 0; i < 10; i += 1) {
      n += 1;
      /* A stable pseudo-pairing that still produces a plausible spread of
         upsets: better seeds win most of the time, not all of it. */
      const a = players[(week * 3 + i) % players.length];
      const b = players[(week * 5 + i * 2 + 1) % players.length];
      if (a.id === b.id) continue;
      const upset = n % 4 === 0;
      const winner = upset ? b : a;
      const loser = winner === a ? b : a;

      apply('results', `res_demo${n}`, {
        id: `res_demo${n}`,
        eventId: pastEventId, gameId: 'tokon',
        matchId: `W${(i % 3) + 1}-${i + 1}`,
        roundName: ['Winners Round 1', 'Losers Round 2', 'Winners Semi-Final'][i % 3],
        winnerPlayerId: winner.id, loserPlayerId: loser.id,
        scoreWinner: 2, scoreLoser: n % 3 === 0 ? 1 : 0,
        reportedAt: ago(week * 7, 3 - (i % 3)),
        demo: true,
      }, { queueIt: false });
    }
  }

  /* Nobody is signed in yet -- the landing page is the first thing you should
     see, because it is the thing a stranger following a link sees. */
  apply('session', 'session', null, { queueIt: false });

  return { orgId, eventId, ssbuId, inviteCode: inviteCode() };
}
