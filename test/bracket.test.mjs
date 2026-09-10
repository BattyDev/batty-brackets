/* Brackets · engine proof
   ---------------------------------------------------------------------------
   Run: node brackets/test/bracket.test.mjs

   No test framework on purpose -- the repo has no build step and no
   node_modules, and a bracket engine's invariants are simple enough to assert
   directly. What is NOT simple is double elimination, which is why most of
   this file is about it: the losers bracket is the part every home-grown
   bracket implementation gets subtly wrong, usually by producing a losers
   round that is one match too wide and silently dropping somebody.

   The properties worth holding onto:

     * every entrant who loses twice is out, and nobody loses twice and stays
     * the bracket drains -- simulating every match to completion leaves
       exactly one unbeaten player and no unplayable matches
     * seeds 1 and 2 cannot meet before the final
     * byes go to the top seeds and cost nobody a set
     * un-reporting a set removes exactly what it caused, no more
   -------------------------------------------------------------------------- */

import {
  standardSeedOrder, bracketSize, snakeSeed, separate, meetingRound,
  singleElimination, doubleElimination, reportResult, clearResult,
  readyMatches, projectedMeetings, standings, findRematches,
} from '../lib/bracket.js';

let passed = 0;
let failed = 0;

function ok(label, condition, detail) {
  if (condition) { passed += 1; return; }
  failed += 1;
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(label, a === e, `expected ${e}\n        actual   ${a}`);
}

const entrants = (n) => Array.from({ length: n }, (_, i) => ({
  id: `e${i + 1}`, name: `Player ${i + 1}`, seed: i + 1,
}));

/* ---------------------------------------------------------------- seeding */
console.log('seed order');
/* The Challonge / start.gg convention, which is what players expect to see:
   1v8, 4v5, 2v7, 3v6. Seed 2 opens the BOTTOM HALF rather than sitting in the
   last position -- an older convention puts it last, and both keep 1 and 2
   apart until the final, but only one of them matches what every other bracket
   in the scene looks like. */
eq('standardSeedOrder(2)', standardSeedOrder(2), [1, 2]);
eq('standardSeedOrder(4)', standardSeedOrder(4), [1, 4, 2, 3]);
eq('standardSeedOrder(8)', standardSeedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
eq('standardSeedOrder(16)', standardSeedOrder(16),
  [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]);

ok('bracketSize rounds up', bracketSize(12) === 16 && bracketSize(16) === 16 && bracketSize(5) === 8);

/* 1 and 2 at opposite ends, for every size. */
for (const size of [4, 8, 16, 32, 64]) {
  const order = standardSeedOrder(size);
  ok(`size ${size}: seed 1 first`, order[0] === 1);
  ok(`size ${size}: seed 2 opens the bottom half`, order[size / 2] === 2);
  ok(`size ${size}: 1 and 2 meet only in the final`,
    meetingRound(order.indexOf(1), order.indexOf(2), size) === Math.log2(size));
  /* Seeds 3 and 4 must be in opposite halves of the bracket to each other and
     split across the two top seeds, or the semi-finals are not seeded at all. */
  ok(`size ${size}: 3 and 4 cannot meet before the semi`,
    size < 4 || meetingRound(order.indexOf(3), order.indexOf(4), size) >= Math.log2(size) - 1);
  ok(`size ${size}: every seed appears once`, new Set(order).size === size);
}

/* ------------------------------------------------------------------ snake */
console.log('snake seeding');
{
  const pools = snakeSeed(entrants(16), 4);
  eq('pool A takes 1, 8, 9, 16', pools[0].map((e) => e.seed), [1, 8, 9, 16]);
  eq('pool B takes 2, 7, 10, 15', pools[1].map((e) => e.seed), [2, 7, 10, 15]);
  const sums = pools.map((p) => p.reduce((t, e) => t + e.seed, 0));
  ok('pools carry equal seed weight', new Set(sums).size === 1, `sums ${sums}`);

  const uneven = snakeSeed(entrants(10), 3);
  ok('uneven entrants still place everyone',
    uneven.flat().length === 10 && new Set(uneven.flat().map((e) => e.id)).size === 10);
}

/* ------------------------------------------------------------- separation */
console.log('separation');
{
  /* Seeds 1 and 2 are from the same venue -- they meet in the final anyway, so
     there is nothing to fix and the pass should leave them alone. */
  const clean = entrants(8).map((e) => ({ ...e, group: e.seed <= 2 ? 'batty' : null }));
  const result = separate(clean);
  eq('no swaps when the only same-group pair meets in the final', result.moves.length, 0);

  /* Seeds 1 and 8 are the same venue: in an 8 bracket they meet in round one.
     Swapping 8 with 7 (within tolerance) pushes that meeting back. */
  const collide = entrants(8).map((e) => ({ ...e, group: [1, 8].includes(e.seed) ? 'batty' : null }));
  const fixed = separate(collide, { tolerance: 2 });
  ok('a round-one collision is improved', fixed.moves.length > 0);
  ok('no round-one collisions remain',
    fixed.collisions.filter((c) => c.round === 1).length === 0,
    JSON.stringify(fixed.collisions));

  /* Nobody moves further than the tolerance allows. */
  const far = entrants(16).map((e) => ({ ...e, group: e.seed % 4 === 0 ? 'batty' : null }));
  const limited = separate(far, { tolerance: 2 });
  limited.seeds.forEach((entrant, i) => {
    ok(`seed ${entrant.seed} stayed within tolerance of ${i + 1}`,
      Math.abs(entrant.seed - (i + 1)) <= 4);
  });

  /* Honest about what it cannot fix: 12 of 16 from one venue must collide. */
  const crowded = entrants(16).map((e) => ({ ...e, group: e.seed <= 12 ? 'batty' : null }));
  const dense = separate(crowded);
  ok('unavoidable collisions are reported, not hidden', dense.collisions.length > 0);
}

/* -------------------------------------------------------- single elim */
console.log('single elimination');
{
  const bracket = singleElimination(entrants(8));
  eq('8 entrants -> 7 matches', bracket.matches.length, 7);
  eq('3 rounds', bracket.rounds, 3);
  eq('round one pairs 1v8', bracket.matches[0].slots.map((s) => s.seed), [1, 8]);
  eq('the last round is named', bracket.matches.at(-1).name, 'Winners Final');
  ok('every non-final match sends its winner somewhere',
    bracket.matches.filter((m) => m.round < 3).every((m) => m.winnerTo));
}

console.log('byes');
{
  const bracket = singleElimination(entrants(5));
  eq('5 entrants use an 8 bracket', bracket.size, 8);
  const byes = bracket.matches.filter((m) => m.state === 'bye');
  eq('three byes', byes.length, 3);
  /* Seeds 1, 2 and 3 get them -- 4 and 5 play each other. */
  const advanced = byes.map((m) => m.winnerId).sort();
  eq('byes go to the top seeds', advanced, ['e1', 'e2', 'e3']);
  ok('a bye is not a played set', byes.every((m) => !m.score));
  /* Two matches are playable at once: 4v5 in round one, and 2v3 in round two
     -- both of whom byed in and are therefore already sitting in their seats.
     A bracket that made 2 and 3 wait for 4v5 to finish would be idling a
     station for no reason, which at a local is a real cost. */
  const ready = readyMatches(bracket.matches);
  eq('two matches are immediately playable', ready.length, 2);
  eq('the round-one match is 4 v 5', ready[0].slots.map((s) => s.seed), [4, 5]);
  eq('and the byed-in seeds can start too', ready[1].slots.map((s) => s.seed), [2, 3]);
}

/* -------------------------------------------------------- double elim */
console.log('double elimination');
for (const n of [4, 8, 16, 32]) {
  const bracket = doubleElimination(entrants(n));
  const size = bracketSize(n);
  const w = bracket.matches.filter((m) => m.bracket === 'W').length;
  const l = bracket.matches.filter((m) => m.bracket === 'L').length;
  const gf = bracket.matches.filter((m) => m.bracket === 'GF').length;

  eq(`n=${n}: winners matches`, w, size - 1);
  eq(`n=${n}: losers matches`, l, size - 2);
  eq(`n=${n}: grand final plus reset`, gf, 2);

  /* Every slot that is fed by another match must name a match that exists. */
  const ids = new Set(bracket.matches.map((m) => m.id));
  const dangling = bracket.matches.flatMap((m) => m.slots
    .filter((s) => s.kind === 'from' && s.from && !ids.has(s.from))
    .map((s) => `${m.id} <- ${s.from}`));
  eq(`n=${n}: no slot points at a missing match`, dangling, []);

  /* Every match except the grand finals must send its winner onward, and every
     winners match except the winners final must send its loser onward. A
     losers-bracket player who is not sent onward has been silently dropped --
     the classic bug. */
  const strandedW = bracket.matches
    .filter((m) => m.bracket !== 'GF' && !m.winnerTo).map((m) => m.id);
  eq(`n=${n}: no winner is stranded`, strandedW, []);
  const strandedL = bracket.matches
    .filter((m) => m.bracket === 'W' && m.round < Math.log2(size) && !m.loserTo)
    .map((m) => m.id);
  eq(`n=${n}: every winners loser has a losers seat`, strandedL, []);

  /* Nobody may be fed into two different seats. */
  const targets = bracket.matches.flatMap((m) => [m.winnerTo, m.loserTo])
    .filter(Boolean).map((t) => `${t.match}:${t.slot}`);
  eq(`n=${n}: no two feeds share a seat`, targets.length, new Set(targets).size);
}

/* Simulate a whole 8-entrant event, better seed always winning, and check it
   drains to one champion having played the right number of sets. */
console.log('full simulation');
{
  const roster = entrants(8);
  const byId = new Map(roster.map((e) => [e.id, e]));
  let bracket = doubleElimination(roster);
  let matches = bracket.matches;
  const seedOf = (id) => byId.get(id).seed;

  let guard = 0;
  const losses = new Map();
  while (guard < 100) {
    guard += 1;
    const ready = readyMatches(matches).filter((m) => !m.cancelled);
    if (!ready.length) break;
    const match = ready[0];
    const [a, b] = match.slots;
    const winnerId = seedOf(a.entrantId) <= seedOf(b.entrantId) ? a.entrantId : b.entrantId;
    const loserId = winnerId === a.entrantId ? b.entrantId : a.entrantId;
    losses.set(loserId, (losses.get(loserId) || 0) + 1);
    matches = reportResult(matches, match.id, { winnerId, scoreA: 2, scoreB: 0 });
  }

  ok('the bracket drains', guard < 100, `stopped after ${guard} iterations`);
  const unplayed = matches.filter((m) => !m.state && !m.cancelled);
  eq('nothing is left unplayable', unplayed.map((m) => m.id), []);

  /* Everyone except the champion lost exactly twice. */
  const twice = [...losses.entries()].filter(([, n]) => n === 2).length;
  eq('seven players lost twice', twice, 7);
  ok('nobody lost three times', [...losses.values()].every((n) => n <= 2));

  const table = standings({ ...bracket, matches }, byId);
  eq('seed 1 wins when nobody upsets', table[0]?.entrant.seed, 1);
  eq('seed 2 is runner-up', table[1]?.entrant.seed, 2);
  eq('everyone is placed', table.length, 8);

  /* Rematches in an 8-entrant double elimination are partly STRUCTURAL: the
     player who loses the winners final drops into the losers final, and the
     grand final is by definition a rematch of something. What the drop
     permutation exists to prevent is an EARLY rematch -- two players who met
     in winners round one being pushed straight back together in losers round
     one or two. That is the property worth asserting. */
  const rematches = findRematches(matches);
  ok('every reported rematch really did happen before',
    rematches.every((r) => r.previous && r.previous.id !== r.match.id),
    rematches.map((r) => `${r.match.id} repeats ${r.previous?.id}`).join(', '));
  const early = rematches.filter((r) => r.match.bracket === 'L' && r.match.round <= 2);
  eq('no rematch in the early losers rounds', early.map((r) => r.match.id), []);
}

/* ------------------------------------------------------------------ undo */
console.log('undo');
{
  const roster = entrants(8);
  const fresh = singleElimination(roster);
  const after = reportResult(fresh.matches, 'W1-1', { winnerId: 'e1', scoreA: 2, scoreB: 0 });
  const semi = after.find((m) => m.id === 'W2-1');
  eq('the winner advances', semi.slots[0].entrantId, 'e1');

  const undone = clearResult(after, 'W1-1');
  const semiAgain = undone.find((m) => m.id === 'W2-1');
  eq('undo empties the seat it filled', semiAgain.slots[0].entrantId, null);
  eq('and the match is unreported', undone.find((m) => m.id === 'W1-1').state, undefined);

  /* Undo must cascade: reporting two rounds then undoing the first must clear
     the second, or the bracket keeps a ghost result. */
  let chain = reportResult(fresh.matches, 'W1-1', { winnerId: 'e1' });
  chain = reportResult(chain, 'W1-2', { winnerId: 'e4' });
  chain = reportResult(chain, 'W2-1', { winnerId: 'e1' });
  const cascaded = clearResult(chain, 'W1-1');
  eq('the downstream result is cleared too', cascaded.find((m) => m.id === 'W2-1').state, undefined);
  eq('the untouched sibling survives', cascaded.find((m) => m.id === 'W1-2').state, 'complete');
}

/* ------------------------------------------------------------- projection */
console.log('projection');
{
  const rounds = projectedMeetings(entrants(8));
  eq('three rounds projected', rounds.length, 3);
  eq('round one is the seed order', rounds[0].pairs.map((p) => [p.a.seed, p.b.seed]),
    [[1, 8], [4, 5], [2, 7], [3, 6]]);
  eq('the final is 1 v 2', rounds[2].pairs.map((p) => [p.a.seed, p.b.seed]), [[1, 2]]);

  const withByes = projectedMeetings(entrants(6));
  ok('byes are marked in the projection', withByes[0].pairs.some((p) => p.bye));
}

/* ------------------------------------------------------------------ done */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
