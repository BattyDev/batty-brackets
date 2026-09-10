/* Brackets · seeding and bracket generation
   ---------------------------------------------------------------------------
   Pure functions. No DOM, no network, no store. Everything here takes plain
   objects and returns plain objects, which is what lets `test/bracket.test.mjs`
   run the whole thing under node with no browser and no fixtures.

   That is not tidiness for its own sake. The complaint that started this
   project was "seeding is very annoying to implement", and the reason it is
   annoying everywhere else is that seeding is usually smeared across a form, a
   drag handler and a server endpoint, so nobody can see what it actually does.
   Here it is one file you can read top to bottom, and a preview the TO can see
   BEFORE committing -- which is the actual fix. The algorithm matters less than
   the fact that its output is inspectable.

   ## The model

   A bracket is a flat list of MATCHES. A match has two SLOTS. A slot is filled
   either by a seed (round one) or by the winner/loser of another match. Nothing
   is nested, nothing is a tree, and every match knows where its winner and
   loser go next:

       { id, bracket: 'W'|'L'|'GF', round, index,
         slots: [Slot, Slot],
         winnerTo: {match, slot} | null,
         loserTo:  {match, slot} | null }

   Flat-with-pointers rather than a tree because a double-elimination bracket is
   not a tree -- the losers bracket makes it a DAG, and every implementation
   that starts with a tree ends up bolting the losers side on sideways. It also
   means progression is a single pass over an array, so recomputing the whole
   bracket after a report is cheap enough to do on every keystroke on a phone.
   -------------------------------------------------------------------------- */

'use strict';

/* --------------------------------------------------------------------------
   Seed ordering
   -------------------------------------------------------------------------- */

/* The classic bracket order: 1 plays the lowest seed, and the top two seeds
   cannot meet before the final. Built by repeated reflection -- at each
   doubling, every existing seed s gains a partner (size + 1 - s).

   standardSeedOrder(8) -> [1, 8, 5, 4, 3, 6, 7, 2]

   Read as pairs: 1v8, 5v4, 3v6, 7v2. Seed 1 and seed 2 are at opposite ends,
   1 and 4 meet in the semi, 1 and 8 in the quarter. This is the ordering every
   sport uses and the one players expect; deviating from it is how you get "why
   is 2 in 1's half" posted in your Discord at 9am. */
export function standardSeedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const round = order.length * 2;
    const next = [];
    for (const seed of order) {
      next.push(seed, round + 1 - seed);
    }
    order = next;
  }
  return order;
}

/* Round a count up to the next power of two. A 12-entrant bracket is a 16
   bracket with 4 byes. */
export const bracketSize = (n) => (n <= 1 ? 1 : 2 ** Math.ceil(Math.log2(n)));

/* --------------------------------------------------------------------------
   Snake seeding into pools
   --------------------------------------------------------------------------
   Serpentine: seeds run 1..P across the pools, then P..1 back, and so on. It
   is the standard because it balances total seed strength across pools; the
   naive alternative (1-4 in pool A, 5-8 in pool B) stacks pool A with everyone
   good.

   Returns an array of pools, each an array of entrants in seed order. */
export function snakeSeed(entrants, poolCount) {
  const pools = Array.from({ length: poolCount }, () => []);
  entrants.forEach((entrant, i) => {
    const row = Math.floor(i / poolCount);
    const col = i % poolCount;
    /* Odd rows run right-to-left. That is the snake. */
    const pool = row % 2 === 0 ? col : poolCount - 1 - col;
    pools[pool].push(entrant);
  });
  return pools;
}

/* --------------------------------------------------------------------------
   Separation
   --------------------------------------------------------------------------
   Two entrants who travelled together, practise together, or are literally the
   same local should not meet in round one -- that is the whole reason a scene
   seeds at all. Every site exposes a seed ORDER; almost none of them will
   actually enforce a separation constraint, so TOs do it by hand and it is the
   part of the job they hate.

   The approach here is deliberately not clever. A clever optimiser that a TO
   cannot predict is worse than a simple one they can, because when it does
   something surprising at 7pm they have to be able to see why. So:

     1. Start from the seed order as given. It is authoritative; the TO's
        judgement about who is good outranks anything here.
     2. Score the placement by how early same-group entrants would meet.
     3. Improve it with pairwise swaps, but ONLY between entrants within
        `tolerance` seeds of each other, so nobody moves far enough to change
        who they are expected to play.
     4. Stop at the first pass with no improvement, and report every swap made.

   The last point is the feature. `separate()` returns a `moves` log, and the
   seeding lab shows it as "swapped Kira (seed 6) with Dominic (seed 7) so Kira
   does not meet Rae until the quarter-final". A TO who disagrees can undo one
   swap without abandoning the whole thing. */

/* How many rounds until the entrants at bracket positions a and b would meet,
   in a single-elimination bracket of the given size. Positions that meet in
   round one return 1. This is the primitive the whole separation score is
   built on: two positions meet in round r when they first land in the same
   block of 2^r. */
export function meetingRound(posA, posB, size) {
  const rounds = Math.log2(size);
  for (let r = 1; r <= rounds; r += 1) {
    const block = 2 ** r;
    if (Math.floor(posA / block) === Math.floor(posB / block)) return r;
  }
  return rounds;
}

/* Penalty for a placement. Meeting in round one is much worse than meeting in
   round three, so the cost falls off geometrically rather than linearly -- a
   linear cost will happily trade one round-one collision for two round-three
   ones, which is not the trade a TO wants. */
function separationCost(placement, size, groupOf) {
  let cost = 0;
  for (let i = 0; i < placement.length; i += 1) {
    for (let j = i + 1; j < placement.length; j += 1) {
      const a = placement[i];
      const b = placement[j];
      if (!a || !b) continue;
      const ga = groupOf(a);
      const gb = groupOf(b);
      if (!ga || !gb || ga !== gb) continue;
      const round = meetingRound(i, j, size);
      cost += 2 ** (Math.log2(size) - round);
    }
  }
  return cost;
}

/* entrants: in seed order, index 0 = seed 1.
   groupOf:  entrant -> string | null. Same non-null string = should be kept
             apart. Usually the club/venue, sometimes the region for an online
             event where ping matters.
   tolerance: how many seed positions an entrant may move. */
export function separate(entrants, { groupOf = (e) => e.group || null, tolerance = 2, maxPasses = 8 } = {}) {
  const size = bracketSize(entrants.length);
  const order = standardSeedOrder(size);

  /* Bracket position -> entrant. `order[pos]` is the seed number that sits at
     that position, so this is the placement the seeds imply. */
  const place = (seedList) => order.map((seed) => seedList[seed - 1] || null);

  const seeds = [...entrants];
  let cost = separationCost(place(seeds), size, groupOf);
  const moves = [];

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improved = false;
    for (let i = 0; i < seeds.length; i += 1) {
      for (let j = i + 1; j <= Math.min(i + tolerance, seeds.length - 1); j += 1) {
        const swapped = [...seeds];
        [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
        const next = separationCost(place(swapped), size, groupOf);
        if (next < cost) {
          moves.push({
            a: seeds[i], b: seeds[j], fromSeed: i + 1, toSeed: j + 1,
            gain: cost - next, group: groupOf(seeds[i]) || groupOf(seeds[j]),
          });
          seeds[i] = swapped[i];
          seeds[j] = swapped[j];
          cost = next;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  return { seeds, moves, cost, collisions: collisionsIn(place(seeds), size, groupOf) };
}

/* Same-group pairs that still meet, and when. Shown in the seeding lab as the
   honest residual: with 9 of 16 entrants from one venue, some of them are
   going to play each other in round one and no algorithm changes that. Saying
   so is better than quietly pretending it is solved. */
export function collisionsIn(placement, size, groupOf) {
  const out = [];
  for (let i = 0; i < placement.length; i += 1) {
    for (let j = i + 1; j < placement.length; j += 1) {
      const a = placement[i];
      const b = placement[j];
      if (!a || !b) continue;
      const ga = groupOf(a);
      if (!ga || ga !== groupOf(b)) continue;
      const round = meetingRound(i, j, size);
      if (round <= 2) out.push({ a, b, round, group: ga });
    }
  }
  return out.sort((x, y) => x.round - y.round);
}

/* Who plays whom, per round, if nobody upsets. The seeding preview -- and the
   single most useful thing a TO can be shown before they commit a bracket,
   because "seed 3 meets seed 6 in the quarters" is a sentence they can check
   against what they know about the room. */
export function projectedMeetings(entrants) {
  const size = bracketSize(entrants.length);
  const order = standardSeedOrder(size);
  const placement = order.map((seed) => entrants[seed - 1] || null);
  const rounds = [];
  let alive = placement.map((entrant, pos) => ({ entrant, pos, seed: order[pos] }));

  for (let r = 1; alive.length > 1; r += 1) {
    const pairs = [];
    const next = [];
    for (let i = 0; i < alive.length; i += 2) {
      const a = alive[i];
      const b = alive[i + 1];
      pairs.push({ a: a?.entrant || null, b: b?.entrant || null, bye: !a?.entrant || !b?.entrant });
      /* Projection assumes the better seed wins, which is the definition of
         "if nobody upsets" -- and also how a bye resolves. */
      const better = !b?.entrant ? a : !a?.entrant ? b : (a.seed <= b.seed ? a : b);
      next.push(better);
    }
    rounds.push({ round: r, name: roundName(r, Math.log2(size), 'W'), pairs });
    alive = next;
  }
  return rounds;
}

/* --------------------------------------------------------------------------
   Round naming
   --------------------------------------------------------------------------
   "Winners Round 2" is what the software calls it; "Quarter-Final" is what the
   room calls it. Announcing the wrong one over a PA loses people, so the last
   three rounds get their real names. */
export function roundName(round, totalRounds, bracket) {
  if (bracket === 'GF') return round === 2 ? 'Grand Final (reset)' : 'Grand Final';
  const fromEnd = totalRounds - round;
  const side = bracket === 'L' ? 'Losers' : 'Winners';
  if (bracket === 'W') {
    if (fromEnd === 0) return 'Winners Final';
    if (fromEnd === 1) return 'Winners Semi-Final';
    if (fromEnd === 2) return 'Winners Quarter-Final';
  } else {
    if (fromEnd === 0) return 'Losers Final';
    if (fromEnd === 1) return 'Losers Semi-Final';
    if (fromEnd === 2) return 'Losers Quarter-Final';
  }
  return `${side} Round ${round}`;
}

/* --------------------------------------------------------------------------
   Bracket generation
   -------------------------------------------------------------------------- */

const slotSeed = (seed, entrant) => ({ kind: 'seed', seed, entrantId: entrant?.id || null, bye: !entrant });
const slotFrom = (matchId, take) => ({ kind: 'from', from: matchId, take, entrantId: null, bye: false });

/* Single elimination. `entrants` is in FINAL seed order -- whatever the seeding
   lab produced. Byes are handed to the top seeds, which falls out of the
   standard order automatically because the empty slots land opposite seeds 1,
   2, 3… */
export function singleElimination(entrants) {
  const size = bracketSize(entrants.length);
  const rounds = Math.log2(size);
  const order = standardSeedOrder(size);
  const matches = [];

  /* Round one, straight from the seed order. */
  for (let i = 0; i < size / 2; i += 1) {
    const seedA = order[i * 2];
    const seedB = order[i * 2 + 1];
    matches.push({
      id: `W1-${i + 1}`, bracket: 'W', round: 1, index: i,
      name: roundName(1, rounds, 'W'),
      slots: [slotSeed(seedA, entrants[seedA - 1]), slotSeed(seedB, entrants[seedB - 1])],
      winnerTo: null, loserTo: null,
    });
  }

  /* Every later round is fed by the round before it. */
  for (let r = 2; r <= rounds; r += 1) {
    const count = size / 2 ** r;
    for (let i = 0; i < count; i += 1) {
      matches.push({
        id: `W${r}-${i + 1}`, bracket: 'W', round: r, index: i,
        name: roundName(r, rounds, 'W'),
        slots: [slotFrom(`W${r - 1}-${i * 2 + 1}`, 'winner'), slotFrom(`W${r - 1}-${i * 2 + 2}`, 'winner')],
        winnerTo: null, loserTo: null,
      });
    }
  }

  linkForward(matches);
  return { type: 'single', size, rounds, matches: resolveByes(matches) };
}

/* Double elimination.

   The losers bracket alternates two kinds of round:

     MINOR — players who just lost in winners drop in and play the survivors
             of the previous losers round.
     MAJOR — losers-bracket survivors play each other; nobody drops in.

   For a bracket of size N with W = log2(N) winners rounds, the losers side has
   2(W-1) rounds: LR1 is the first minor (losers of WR1 play each other), then
   it alternates major/minor up to the losers final.

   ## The drop pattern, and why it is not just "in order"

   When the losers of winners round R drop into a losers round, feeding them in
   the same order they appear in the winners bracket causes immediate rematches
   -- two players who met in WR1 land in the same LR2 match. The fix every
   bracket does is to permute the dropping order. We reverse it on alternating
   rounds, which is the common convention and is cheap to explain: the top half
   of the winners bracket drops into the bottom half of the losers bracket.

   It is not a perfect rematch-avoider for every size (nothing simple is), so
   `findRematches` below reports any that survive rather than claiming there
   are none. */
export function doubleElimination(entrants, { grandFinalsReset = true } = {}) {
  const size = bracketSize(entrants.length);
  const wRounds = Math.log2(size);
  const single = singleElimination(entrants);
  const matches = single.matches.map((m) => ({ ...m, slots: m.slots.map((s) => ({ ...s })) }));

  if (size < 2) return { type: 'double', size, rounds: wRounds, matches };

  const lRounds = 2 * (wRounds - 1);
  /* Match count per losers round. Minor rounds (odd) and the major round that
     follows them have the same width; the width halves after each major. */
  const widthOf = (lr) => size / 2 ** (Math.floor((lr + 1) / 2) + 1);

  for (let lr = 1; lr <= lRounds; lr += 1) {
    const width = Math.max(1, widthOf(lr));
    for (let i = 0; i < width; i += 1) {
      matches.push({
        id: `L${lr}-${i + 1}`, bracket: 'L', round: lr, index: i,
        name: roundName(lr, lRounds, 'L'),
        slots: [{ kind: 'from', from: null, take: 'winner', entrantId: null, bye: false },
          { kind: 'from', from: null, take: 'winner', entrantId: null, bye: false }],
        winnerTo: null, loserTo: null,
      });
    }
  }

  const lAt = (lr, i) => matches.find((m) => m.bracket === 'L' && m.round === lr && m.index === i);

  /* LR1: losers of winners round 1, paired off. */
  const w1 = matches.filter((m) => m.bracket === 'W' && m.round === 1);
  for (let i = 0; i < widthOf(1); i += 1) {
    const match = lAt(1, i);
    match.slots[0] = slotFrom(w1[i * 2].id, 'loser');
    match.slots[1] = slotFrom(w1[i * 2 + 1].id, 'loser');
  }

  for (let lr = 2; lr <= lRounds; lr += 1) {
    const width = Math.max(1, widthOf(lr));
    const isMinor = lr % 2 === 0; /* LR2, LR4… take drops from winners. */
    const prevWidth = Math.max(1, widthOf(lr - 1));

    for (let i = 0; i < width; i += 1) {
      const match = lAt(lr, i);
      if (isMinor) {
        /* Survivor of the previous losers round, plus a fresh drop from the
           winners round that just finished. */
        const wRound = lr / 2 + 1;
        const drops = matches.filter((m) => m.bracket === 'W' && m.round === wRound);
        /* Alternate the drop direction so the winners top half meets the
           losers bottom half. */
        const dropIndex = wRound % 2 === 0 ? drops.length - 1 - i : i;
        match.slots[0] = slotFrom(lAt(lr - 1, i).id, 'winner');
        match.slots[1] = slotFrom(drops[dropIndex].id, 'loser');
      } else {
        /* Major: two survivors of the previous losers round. */
        match.slots[0] = slotFrom(lAt(lr - 1, i * 2).id, 'winner');
        match.slots[1] = slotFrom(lAt(lr - 1, Math.min(i * 2 + 1, prevWidth - 1)).id, 'winner');
      }
    }
  }

  /* Grand final: winners final winner vs losers final winner. */
  const winnersFinal = matches.find((m) => m.bracket === 'W' && m.round === wRounds);
  const losersFinal = matches.find((m) => m.bracket === 'L' && m.round === lRounds);
  matches.push({
    id: 'GF-1', bracket: 'GF', round: 1, index: 0, name: 'Grand Final',
    slots: [slotFrom(winnersFinal.id, 'winner'), slotFrom(losersFinal.id, 'winner')],
    winnerTo: null, loserTo: null,
  });

  /* The reset. Created up front but marked conditional -- it only becomes a
     real match if the losers-side player wins the first grand final. Creating
     it up front rather than on demand means the bracket's shape never changes
     under a viewer mid-event, which matters on a projector. */
  if (grandFinalsReset) {
    matches.push({
      id: 'GF-2', bracket: 'GF', round: 2, index: 0, name: 'Grand Final (reset)',
      conditional: true,
      slots: [slotFrom('GF-1', 'loser'), slotFrom('GF-1', 'winner')],
      winnerTo: null, loserTo: null,
    });
  }

  linkForward(matches);
  return { type: 'double', size, rounds: wRounds, losersRounds: lRounds, matches: resolveByes(matches) };
}

/* Turn the slots' backward references ("I am fed by the winner of W1-3") into
   forward pointers on the source match ("my winner goes to W2-2 slot 0").
   Progression walks forward, so it needs the forward form; generation is far
   easier to write in the backward form. Deriving one from the other beats
   maintaining both and letting them disagree. */
function linkForward(matches) {
  const byId = new Map(matches.map((m) => [m.id, m]));
  for (const match of matches) {
    match.winnerTo = null;
    match.loserTo = null;
  }
  for (const match of matches) {
    match.slots.forEach((slot, slotIndex) => {
      if (slot.kind !== 'from' || !slot.from) return;
      const source = byId.get(slot.from);
      if (!source) return;
      const target = { match: match.id, slot: slotIndex };
      if (slot.take === 'winner') source.winnerTo = target;
      else source.loserTo = target;
    });
  }
  return matches;
}

/* A round-one match with one empty slot is a bye: the present entrant advances
   with no set played. Resolving them at generation time -- rather than asking
   a TO to click through sixteen phantom matches -- is table stakes, and
   start.gg does it too. What is worth doing better is SAYING so: these matches
   carry state 'bye' and the UI renders them as an advance, not as a 2-0. */
function resolveByes(matches) {
  const byId = new Map(matches.map((m) => [m.id, m]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of matches) {
      if (match.state) continue;
      const [a, b] = match.slots;
      const aEmpty = a.kind === 'seed' && a.bye;
      const bEmpty = b.kind === 'seed' && b.bye;
      if (!aEmpty && !bEmpty) continue;
      if (aEmpty && bEmpty) continue;
      const advancing = aEmpty ? b : a;
      match.state = 'bye';
      match.winnerId = advancing.entrantId;
      if (match.winnerTo) {
        const target = byId.get(match.winnerTo.match);
        target.slots[match.winnerTo.slot] = {
          kind: 'seed', seed: advancing.seed, entrantId: advancing.entrantId, bye: false,
        };
        changed = true;
      }
    }
  }
  return matches;
}

/* --------------------------------------------------------------------------
   Progression
   -------------------------------------------------------------------------- */

/* Apply a reported result and push the players forward. Returns a NEW match
   list; nothing here mutates its input, so the caller can diff before and
   after to show "this changed 4 matches" and can undo by keeping the old array.
   Undo mattering is not hypothetical -- mis-reported sets are the single most
   common thing a TO has to fix. */
export function reportResult(matches, matchId, { winnerId, scoreA, scoreB }) {
  const next = matches.map((m) => ({ ...m, slots: m.slots.map((s) => ({ ...s })) }));
  const byId = new Map(next.map((m) => [m.id, m]));
  const match = byId.get(matchId);
  if (!match) return next;

  const [a, b] = match.slots;
  if (!a.entrantId || !b.entrantId) return next;

  match.state = 'complete';
  match.winnerId = winnerId;
  match.loserId = winnerId === a.entrantId ? b.entrantId : a.entrantId;
  match.score = { a: scoreA ?? null, b: scoreB ?? null };
  match.reportedAt = new Date().toISOString();

  const push = (target, entrantId) => {
    if (!target || !entrantId) return;
    const dest = byId.get(target.match);
    if (!dest) return;
    const seed = [a, b].find((s) => s.entrantId === entrantId)?.seed ?? null;
    dest.slots[target.slot] = { kind: 'seed', seed, entrantId, bye: false };
  };

  push(match.winnerTo, match.winnerId);
  push(match.loserTo, match.loserId);

  /* Grand finals: if the losers-side player wins GF-1, the reset is live. If
     the winners-side player wins, the reset never happens and is dropped from
     the view rather than left hanging as a match that will never be played. */
  if (match.bracket === 'GF' && match.round === 1) {
    const reset = byId.get('GF-2');
    if (reset) {
      const winnersSidePlayer = a.entrantId;
      reset.conditional = match.winnerId === winnersSidePlayer;
      reset.cancelled = match.winnerId === winnersSidePlayer;
    }
  }

  return next;
}

/* Undo a report and everything downstream of it. Walks forward from the match
   clearing any slot that was filled by it, recursively, so un-reporting a
   quarter-final correctly empties the semi it fed. */
export function clearResult(matches, matchId) {
  const next = matches.map((m) => ({ ...m, slots: m.slots.map((s) => ({ ...s })) }));
  const byId = new Map(next.map((m) => [m.id, m]));

  const clear = (id) => {
    const match = byId.get(id);
    if (!match || match.state === 'bye') return;
    delete match.state;
    delete match.winnerId;
    delete match.loserId;
    delete match.score;
    delete match.reportedAt;
    for (const target of [match.winnerTo, match.loserTo]) {
      if (!target) continue;
      const dest = byId.get(target.match);
      if (!dest) continue;
      const slot = dest.slots[target.slot];
      if (slot.kind === 'seed' && slot.entrantId) {
        dest.slots[target.slot] = {
          kind: 'from', from: id,
          take: target === match.winnerTo ? 'winner' : 'loser',
          entrantId: null, bye: false,
        };
        clear(dest.id);
      }
    }
  };

  clear(matchId);
  return next;
}

/* Matches that can be played right now: both slots filled, not yet reported.
   This is the queue the run view works from, and it is derived rather than
   stored -- a stored "ready" flag is a thing that can be wrong. */
export function readyMatches(matches) {
  return matches.filter((m) => !m.state && !m.cancelled
    && m.slots[0].entrantId && m.slots[1].entrantId);
}

/* Any pairing that already happened earlier in this bracket. Reported by the
   seeding lab and by the run view, because a losers-bracket rematch in round
   two is usually a sign the drop pattern misfired for this size, and a TO
   would rather know than find out from the players. */
export function findRematches(matches) {
  const seen = new Map();
  const out = [];
  for (const match of matches) {
    const [a, b] = match.slots;
    if (!a.entrantId || !b.entrantId) continue;
    const key = [a.entrantId, b.entrantId].sort().join('|');
    if (seen.has(key)) out.push({ match, previous: seen.get(key) });
    else seen.set(key, match);
  }
  return out;
}

/* Final standings. Placement in a double-elimination bracket is decided by the
   round a player was eliminated in, and ties within a round share a placement
   (two people knocked out in losers round 3 are both 5th). Computing it from
   the bracket rather than storing it means it is always right after a
   correction. */
export function standings(bracket, entrantsById) {
  const { matches } = bracket;
  const eliminated = new Map();
  for (const match of matches) {
    if (match.state !== 'complete' || !match.loserId) continue;
    /* A loss in winners is not an elimination in double elim. */
    if (bracket.type === 'double' && match.bracket === 'W') continue;
    if (match.bracket === 'GF' && match.round === 1 && bracket.matches.some((m) => m.id === 'GF-2' && !m.cancelled)) continue;
    eliminated.set(match.loserId, match);
  }

  const depth = (match) => (match.bracket === 'GF' ? 1000 : match.bracket === 'L' ? match.round : 0);
  const rows = [...eliminated.entries()]
    .map(([id, match]) => ({ id, entrant: entrantsById.get(id), depth: depth(match) }))
    .sort((x, y) => y.depth - x.depth);

  const champion = matches.find((m) => m.bracket === 'GF' && !m.cancelled && m.state === 'complete'
    && (m.id === 'GF-2' || !matches.some((r) => r.id === 'GF-2' && !r.cancelled)))?.winnerId
    || matches.filter((m) => m.state === 'complete').slice(-1)[0]?.winnerId;

  const out = [];
  if (champion && entrantsById.get(champion)) out.push({ place: 1, entrant: entrantsById.get(champion) });

  let place = out.length + 1;
  let i = 0;
  while (i < rows.length) {
    const tied = rows.filter((r) => r.depth === rows[i].depth);
    for (const row of tied) {
      if (row.entrant && row.id !== champion) out.push({ place, entrant: row.entrant });
    }
    place += tied.length;
    i += tied.length;
  }
  return out;
}
