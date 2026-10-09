// Targeted rule tests: each builds an exact table position and checks one rule.
import assert from 'node:assert/strict';
import { UnoGame } from '../js/engine.js';

let idSeq = 10000;
const C = (color, type, value = null) => ({ id: idSeq++, color, type, value });
const N = (color, value) => C(color, 'number', value);

// Build a game in a precise state. hands: array of card arrays. top: discard top.
function setup({ mode = 'standard', rules, hands, top, current = 0, color, direction = 1 }) {
  const game = new UnoGame({ mode, rules, players: hands.map((_, i) => ({ name: `P${i}` })), rng: () => 0.42 });
  game.start(0);
  // Throw away the random deal and lay out the exact position.
  const all = [...game.cards.values()];
  game.cards = new Map();
  const reg = (c) => { game.cards.set(c.id, c); return c; };
  game.players.forEach((p, i) => { p.hand = hands[i].map(reg); });
  game.discard = [reg(top)];
  game.drawPile = all.map((c) => ({ ...c, id: idSeq++ })).map(reg); // fresh deck to draw from
  game.activeColor = color || (top.color === 'wild' ? 'red' : top.color);
  game.current = current;
  game.direction = direction;
  game.drainEvents();
  game.checkIntegrity();
  return game;
}
const play = (g, player, card, extra = {}) => g.apply({ type: 'play', player, cardId: card.id, ...extra });
const counts = (g) => g.players.map((p) => p.hand.length);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- basics
test('match by color, number or symbol; reject mismatches', () => {
  const r5 = N('red', 5), b5 = N('blue', 5), g7 = N('green', 7), rs = C('red', 'skip');
  const g = setup({ hands: [[b5, g7, rs, N('red', 1)], [N('red', 2)]], top: N('red', 5) });
  assert.deepEqual(new Set(g.legalPlays(0)), new Set([b5.id, rs.id, g.players[0].hand[3].id]));
  assert.equal(play(g, 0, g7).ok, false);
  assert.equal(play(g, 1, r5).ok, false, 'not your turn / not your card');
});

test('draw one; a playable drawn card may be played or kept', () => {
  const g = setup({ hands: [[N('blue', 1), N('blue', 2)], [N('red', 2)]], top: N('red', 5) });
  const drawn = N('red', 9); g.cards.set(drawn.id, drawn); g.drawPile.push(drawn);
  assert.ok(g.apply({ type: 'draw', player: 0 }).ok);
  assert.equal(g.current, 0, 'still my turn after drawing a playable card');
  assert.deepEqual(g.legalPlays(0), [drawn.id], 'only the drawn card is playable');
  assert.ok(g.apply({ type: 'pass', player: 0 }).ok);
  assert.equal(g.current, 1);
});

test('unplayable draw ends the turn', () => {
  const g = setup({ hands: [[N('blue', 1), N('blue', 2)], [N('red', 2)]], top: N('red', 5) });
  const c = N('green', 1); g.cards.set(c.id, c); g.drawPile.push(c);
  assert.ok(g.apply({ type: 'draw', player: 0 }).ok);
  assert.equal(g.current, 1);
});

test('skip, reverse (2-player reverse acts as skip), draw two', () => {
  let g = setup({ hands: [[C('red', 'skip'), N('red', 1)], [N('red', 2)], [N('red', 3)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0]);
  assert.equal(g.current, 2);
  g = setup({ hands: [[C('red', 'reverse'), N('red', 1)], [N('red', 2)], [N('red', 3)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0]);
  assert.equal(g.direction, -1);
  assert.equal(g.current, 2);
  g = setup({ hands: [[C('red', 'reverse'), N('red', 1)], [N('red', 2)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0]);
  assert.equal(g.current, 0, 'two players: reverse = play again');
  g = setup({ rules: { stacking: false }, hands: [[C('red', 'draw2'), N('red', 1)], [N('red', 2), C('blue', 'draw2')], [N('red', 3)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0]);
  assert.equal(g.current, 1);
  assert.deepEqual(g.legalPlays(1), [], 'no stacking when Progressive UNO is off');
  g.apply({ type: 'draw', player: 1 });
  assert.equal(g.players[1].hand.length, 4);
  assert.equal(g.current, 2, 'victim loses their turn');
});

test('wild: chosen color becomes active', () => {
  const g = setup({ hands: [[C('wild', 'wild'), N('red', 1)], [N('red', 2)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0], { color: 'blue' });
  assert.equal(g.activeColor, 'blue');
});

// ---------------------------------------------------------------- Progressive UNO
test('stacking +2 on +2 accumulates; first non-stacker draws all and loses turn', () => {
  const g = setup({ hands: [[C('red', 'draw2'), N('red', 1)], [C('blue', 'draw2'), N('red', 2)], [N('green', 3), N('green', 4)], [N('red', 9)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0]);
  assert.equal(g.pending.amount, 2);
  play(g, 1, g.players[1].hand[0]);
  assert.equal(g.pending.amount, 4);
  assert.equal(g.current, 2);
  g.apply({ type: 'draw', player: 2 });
  assert.equal(g.players[2].hand.length, 6);
  assert.equal(g.current, 3);
  assert.equal(g.pending, null);
});

test('no mixing +2 and +4 in Standard', () => {
  const g = setup({ hands: [[C('red', 'draw2'), N('red', 1)], [C('wild', 'wild4'), N('red', 2)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0]);
  assert.deepEqual(g.legalPlays(1), []);
  const g2 = setup({ hands: [[C('wild', 'wild4'), N('blue', 1)], [C('red', 'draw2'), C('wild', 'wild4'), N('red', 2)]], top: N('green', 5) });
  play(g2, 0, g2.players[0].hand[0], { color: 'red' });
  assert.deepEqual(g2.legalPlays(1), [g2.players[1].hand[1].id]);
});

// ---------------------------------------------------------------- Wild Draw Four challenges
test('challenge a bluffed +4: bluffer draws, challenger keeps the turn', () => {
  const g = setup({ hands: [[C('wild', 'wild4'), N('green', 1)], [N('red', 2), N('red', 3)], [N('red', 4)]], top: N('green', 5) });
  play(g, 0, g.players[0].hand[0], { color: 'red' });
  assert.ok(g.canChallenge(1));
  g.apply({ type: 'challenge', player: 1 });
  assert.deepEqual(counts(g), [5, 2, 1]);
  assert.equal(g.current, 1);
});

test('challenge a legal +4: challenger draws 6 and loses the turn', () => {
  const g = setup({ hands: [[C('wild', 'wild4'), N('blue', 1)], [N('red', 2), N('red', 3)], [N('red', 4)]], top: N('green', 5) });
  play(g, 0, g.players[0].hand[0], { color: 'red' });
  g.apply({ type: 'challenge', player: 1 });
  assert.deepEqual(counts(g), [1, 8, 1]);
  assert.equal(g.current, 2);
});

test('stacked +4 is only challengeable with Stacking Challenges on', () => {
  for (const stackChallenge of [false, true]) {
    const g = setup({ rules: { stackChallenge }, hands: [[C('wild', 'wild4'), N('blue', 1)], [C('wild', 'wild4'), N('red', 2)], [N('red', 4), N('red', 6)]], top: N('green', 5) });
    play(g, 0, g.players[0].hand[0], { color: 'red' });
    play(g, 1, g.players[1].hand[0], { color: 'blue' }); // bluff: P1 held red
    assert.equal(g.canChallenge(2), stackChallenge);
    if (stackChallenge) {
      g.apply({ type: 'challenge', player: 2 });
      assert.deepEqual(counts(g), [1, 9, 2], 'bluffer draws the whole stack');
      assert.equal(g.current, 2);
    }
  }
});

// ---------------------------------------------------------------- UNO calls
test('forgetting UNO can be caught for +2 before the next turn starts', () => {
  const g = setup({ hands: [[N('red', 1), N('red', 2)], [N('red', 3), N('red', 4)], [N('red', 6)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0]);
  assert.equal(g.unoVulnerable, 0);
  assert.ok(g.apply({ type: 'catch', player: 2, target: 0 }).ok);
  assert.equal(g.players[0].hand.length, 3);
});

test('calling UNO (or saying it late but before being caught) is safe', () => {
  let g = setup({ hands: [[N('red', 1), N('red', 2)], [N('red', 3), N('red', 4)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0], { sayUno: true });
  assert.equal(g.unoVulnerable, null);
  g = setup({ hands: [[N('red', 1), N('red', 2)], [N('red', 3), N('red', 4)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0]);
  assert.ok(g.apply({ type: 'uno', player: 0 }).ok);
  assert.equal(g.apply({ type: 'catch', player: 1, target: 0 }).ok, false);
});

test('UNO catch window closes when the next player acts', () => {
  const g = setup({ hands: [[N('red', 1), N('red', 2)], [N('red', 3), N('red', 4)], [N('red', 6)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0]);
  play(g, 1, g.players[1].hand[0]);
  assert.equal(g.apply({ type: 'catch', player: 2, target: 0 }).ok, false);
});

test('first to empty their hand wins and scores opponents\' cards', () => {
  const g = setup({ hands: [[N('red', 1)], [N('red', 3), C('blue', 'skip')], [C('wild', 'wild')]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0]);
  assert.equal(g.phase, 'gameover');
  assert.equal(g.winner, 0);
  assert.equal(g.roundScore, 3 + 20 + 50);
});

// ---------------------------------------------------------------- Jump-In
test('jump in with an identical card; play continues from the jumper', () => {
  const g = setup({ hands: [[N('red', 1), N('red', 2)], [N('blue', 3), N('blue', 4)], [N('red', 5), N('green', 1)], [N('red', 8)]], top: N('red', 5) });
  assert.deepEqual(g.jumpInOptions(2), [g.players[2].hand[0].id]);
  assert.ok(g.apply({ type: 'jumpin', player: 2, cardId: g.players[2].hand[0].id }).ok);
  assert.equal(g.current, 3, 'turn passes on from the jumper');
});

test('jump-in needs an identical card (color AND number/symbol); never wilds', () => {
  const g = setup({ hands: [[N('red', 1), N('red', 2)], [N('blue', 5), N('red', 6), C('wild', 'wild')]], top: N('red', 5) });
  assert.deepEqual(g.jumpInOptions(1), []);
});

test('jump-in with an action card applies its effect from the jumper', () => {
  const g = setup({ hands: [[N('red', 1), N('red', 2)], [N('blue', 3), N('blue', 4)], [C('red', 'skip'), N('green', 1)], [N('red', 8)]], top: C('red', 'skip') });
  g.apply({ type: 'jumpin', player: 2, cardId: g.players[2].hand[0].id });
  assert.equal(g.current, 0, 'P3 skipped, back to P0');
});

test('jump-in with an identical +2 adds to the stack and passes it on', () => {
  const g = setup({ hands: [[C('red', 'draw2'), N('red', 2)], [N('blue', 3), N('blue', 4)], [C('red', 'draw2'), N('green', 1)], [N('red', 8)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0]);
  assert.equal(g.current, 1);
  g.apply({ type: 'jumpin', player: 2, cardId: g.players[2].hand[0].id });
  assert.equal(g.pending.amount, 4);
  assert.equal(g.current, 3);
});

test('multiple jump-ins are individual plays (and anyone may interrupt between)', () => {
  const g = setup({ hands: [[N('red', 1), N('red', 2)], [N('red', 5), N('blue', 4)], [N('red', 5), N('red', 5), N('green', 1)], [N('red', 8), N('blue', 2)]], top: N('red', 5) });
  g.apply({ type: 'jumpin', player: 2, cardId: g.players[2].hand[0].id });
  assert.equal(g.current, 3);
  assert.equal(g.jumpInOptions(2).length, 1, 'P2 may jump again with the second red 5');
  assert.equal(g.jumpInOptions(1).length, 1, 'P1 may interrupt first');
  g.apply({ type: 'jumpin', player: 1, cardId: g.players[1].hand[0].id });
  assert.equal(g.current, 2, 'P1 interrupted; play continues from P1');
  assert.deepEqual(g.jumpInOptions(2), [], 'it is P2\'s regular turn now');
});

test('Jump-In UNO: winning by jump-in only when enabled', () => {
  for (const jumpInUno of [false, true]) {
    const g = setup({ rules: { jumpInUno }, hands: [[N('red', 1), N('red', 2)], [N('red', 5)], [N('red', 8)]], top: N('red', 5) });
    assert.equal(g.jumpInOptions(1).length, jumpInUno ? 1 : 0);
    if (jumpInUno) {
      g.apply({ type: 'jumpin', player: 1, cardId: g.players[1].hand[0].id });
      assert.equal(g.winner, 1);
    }
  }
});

test('jump-in disabled when the rule is off', () => {
  const g = setup({ rules: { jumpIn: false }, hands: [[N('red', 1), N('red', 2)], [N('red', 5), N('red', 6)]], top: N('red', 5) });
  assert.deepEqual(g.jumpInOptions(1), []);
});

// ---------------------------------------------------------------- Seven-O
test('playing a 7 swaps hands with the chosen opponent', () => {
  const a = N('red', 7), keep = [N('red', 1), N('blue', 2)];
  const theirs = [N('green', 9)];
  const g = setup({ hands: [[a, ...keep], [N('yellow', 1), N('yellow', 2), N('yellow', 3)], theirs], top: N('red', 5) });
  play(g, 0, a, { target: 2 });
  assert.deepEqual(g.players[0].hand.map((c) => c.id), theirs.map((c) => c.id));
  assert.deepEqual(g.players[2].hand.map((c) => c.id), keep.map((c) => c.id));
  assert.equal(g.current, 1);
});

test('playing a 0 passes every hand along the direction of play', () => {
  const h0 = [N('red', 0), N('red', 1)], h1 = [N('blue', 1)], h2 = [N('green', 1), N('green', 2)];
  const g = setup({ hands: [h0, h1, h2], top: N('red', 5) });
  const ids = (h) => h.map((c) => c.id);
  const rest0 = ids(h0.slice(1)), was1 = ids(h1), was2 = ids(h2);
  play(g, 0, h0[0]);
  assert.deepEqual(ids(g.players[1].hand), rest0);
  assert.deepEqual(ids(g.players[2].hand), was1);
  assert.deepEqual(ids(g.players[0].hand), was2);
});

test('going out with a 7 wins without swapping', () => {
  const g = setup({ hands: [[N('red', 7)], [N('red', 1), N('red', 2)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0], { target: 1 });
  assert.equal(g.winner, 0);
});

// ---------------------------------------------------------------- additions
test('Draw Until Playable keeps drawing until a playable card', () => {
  const g = setup({ rules: { drawUntilPlayable: true }, hands: [[N('blue', 1), N('blue', 2)], [N('red', 2)]], top: N('red', 5) });
  const seq = [N('green', 1), N('yellow', 2), N('red', 9)];
  for (const c of seq) g.cards.set(c.id, c);
  g.drawPile.push(...seq.slice().reverse());
  g.apply({ type: 'draw', player: 0 });
  assert.equal(g.players[0].hand.length, 5);
  assert.equal(g.drawnCard, seq[2].id);
});

test('Force Play: a playable drawn card cannot be kept', () => {
  const g = setup({ rules: { forcePlay: true }, hands: [[N('blue', 1), N('blue', 2)], [N('red', 2)]], top: N('red', 5) });
  const c = N('red', 9); g.cards.set(c.id, c); g.drawPile.push(c);
  g.apply({ type: 'draw', player: 0 });
  assert.equal(g.apply({ type: 'pass', player: 0 }).ok, false);
  assert.ok(play(g, 0, c).ok);
});

// ---------------------------------------------------------------- Chaos
test('Chaos: Mercy knocks out the 1-card player and the 20+ player, cards dealt evenly', () => {
  const big = Array.from({ length: 21 }, (_, i) => N('blue', i % 10));
  const g = setup({ mode: 'chaos', hands: [[N('red', 1), N('red', 2)], [N('green', 3)], big, [N('red', 4), N('red', 6)]], top: N('red', 5) });
  assert.deepEqual(g.mercyTargets(), [1, 2]);
  assert.equal(g.canCallMercy(1), false, 'the one-card player cannot call it');
  assert.ok(g.canCallMercy(2), 'the big hand may call it');
  assert.ok(g.apply({ type: 'mercy', player: 0 }).ok);
  assert.ok(g.players[1].out && g.players[2].out);
  assert.deepEqual(counts(g), [2 + 11, 0, 0, 2 + 11]);
  g.checkIntegrity();
});

test('Chaos: Overload knocks out a player reaching 30 cards', () => {
  const g = setup({ mode: 'chaos', hands: [[C('wild', 'plus10'), N('red', 2)], Array.from({ length: 25 }, () => N('blue', 1)), [N('red', 4), N('red', 6)]], top: N('red', 5) });
  play(g, 0, g.players[0].hand[0], { color: 'red' });
  g.apply({ type: 'draw', player: 1 });
  assert.ok(g.players[1].out);
  assert.equal(g.current, 2);
  g.checkIntegrity();
});

test('Standard mode never has Mercy or Overload', () => {
  const big = Array.from({ length: 21 }, (_, i) => N('blue', i % 10));
  const g = setup({ hands: [[N('red', 1), N('red', 2)], [N('green', 3)], big], top: N('red', 5) });
  assert.deepEqual(g.mercyTargets(), []);
});

// ---------------------------------------------------------------- HERO cards
const H = (type) => C('wild', type);
const chaos = (hands, top = N('red', 5), extra = {}) => setup({ mode: 'chaos', hands, top, ...extra });

test('HERO cards are never dealt in starting hands', () => {
  for (let seed = 0; seed < 40; seed++) {
    let x = seed;
    const g = new UnoGame({ mode: 'chaos', players: Array.from({ length: 6 }, () => ({})), rng: () => ((x = (x * 9301 + 49297) % 233280) / 233280) });
    g.start(0);
    assert.ok(g.players.every((p) => p.hand.every((c) => !c.type.startsWith('hero_'))));
  }
});

test('only one HERO per player: a second hero draw is replaced', () => {
  const g = chaos([[H('hero_thor'), N('red', 1)], [N('red', 2)]]);
  const hero2 = H('hero_cap'); const plain = N('blue', 4);
  g.cards.set(hero2.id, hero2); g.cards.set(plain.id, plain);
  g.drawPile.push(plain, hero2); // hero2 on top
  g._drawCards(0, 1, 'draw');
  assert.ok(!g.players[0].hand.includes(hero2), 'second hero not taken');
  assert.ok(g.players[0].hand.includes(plain));
  g.checkIntegrity();
});

test('HERO card is a Wild, sets the color, and leaves the match once covered', () => {
  const thor = H('hero_thor');
  const g = chaos([[thor, N('blue', 1), N('blue', 2)], [N('red', 2), N('red', 3)], [N('red', 4), N('red', 6)]]);
  assert.ok(g.legalPlays(0).includes(thor.id));
  play(g, 0, thor, { color: 'blue' });
  assert.equal(g.activeColor, 'blue');
  assert.equal(g.players[0].heroUsed, 'hero_thor');
  // Thor skipped everyone: back to P0, who covers the hero.
  assert.equal(g.current, 0);
  play(g, 0, g.players[0].hand[0]);
  assert.ok(g.removed.includes(thor), 'hero permanently removed');
  g.checkIntegrity();
});

test('Superman: 4 uninterrupted extra turns; draw cards land immediately', () => {
  const sup = H('hero_superman');
  const g = chaos([[sup, N('red', 1), N('red', 2), C('red', 'draw2'), N('red', 3), N('red', 4), N('red', 6)], [N('green', 2), N('green', 3)], [N('green', 4), N('green', 6)]]);
  play(g, 0, sup, { color: 'red' });
  for (let k = 0; k < 4; k++) {
    assert.equal(g.current, 0, `extra turn ${k + 1}`);
    assert.deepEqual(g.mercyTargets(), []);
    const c = g.players[0].hand.find((x) => g.legalPlays(0).includes(x.id));
    play(g, 0, c);
  }
  assert.equal(g.current, 1, 'play passes on after four extra turns');
  assert.equal(g.players[1].hand.length, 4, 'the +2 hit P1 instantly');
  assert.equal(g.pending, null);
});

test('Captain America: shield rebounds a draw stack onto the attacker', () => {
  const cap = H('hero_cap');
  const g = chaos([[C('red', 'draw2'), N('red', 1), N('red', 9)], [cap, N('green', 3), N('green', 4)], [N('green', 5), N('green', 6)]]);
  play(g, 0, g.players[0].hand[0]);
  assert.ok(g.legalPlays(1).includes(cap.id), 'Cap can answer a stack');
  play(g, 1, cap, { color: 'green' });
  assert.equal(g.current, 0, 'stack rebounds to the attacker');
  assert.equal(g.pending.amount, 2);
  g.apply({ type: 'draw', player: 0 });
  assert.equal(g.players[0].hand.length, 4);
});

test('Captain America: Skip and Everyone +4 rebound while the shield is up', () => {
  const cap = H('hero_cap');
  const g = chaos([[cap, N('red', 1), N('red', 2)], [C('green', 'skip'), C('wild', 'everyone4'), N('green', 4), N('green', 8)], [N('green', 5), N('green', 6)]], N('red', 5));
  play(g, 0, cap, { color: 'green' });
  play(g, 1, g.players[1].hand[1], { color: 'green' }); // everyone4
  assert.equal(g.players[0].hand.length, 2, 'shielded player draws nothing');
  assert.equal(g.players[1].hand.length, 3 + 4, 'attacker draws the rebound');
  assert.equal(g.players[2].hand.length, 6);
});

test('Captain America: shield expires after its owner\'s next turn', () => {
  const cap = H('hero_cap');
  const g = chaos([[cap, N('red', 1), N('red', 2)], [N('red', 3), N('red', 4)]], N('red', 5));
  play(g, 0, cap, { color: 'red' });
  assert.ok(g.players[0].shield);
  play(g, 1, g.players[1].hand[0]);
  assert.ok(g.players[0].shield, 'still up during the round');
  play(g, 0, g.players[0].hand[0]);
  assert.equal(g.players[0].shield, null);
});

test('Sentry: opponents draw 15; hand set aside; exact golden match wins', () => {
  const sentry = H('hero_sentry');
  const g = chaos([[sentry, N('blue', 1), N('blue', 2)], [N('red', 3), N('red', 4)], [N('green', 5), N('green', 6)]]);
  // Plant the golden card: the topmost number card in the pile.
  const golden = N('yellow', 7); g.cards.set(golden.id, golden); g.drawPile.push(golden);
  play(g, 0, sentry, { color: 'red' });
  // Opponents drew 15 first, so the golden card is the next number card after those.
  assert.equal(g.players[1].hand.length, 17);
  assert.equal(g.players[0].hand.length, 1);
  assert.equal(g.players[0].stash.length, 2);
  assert.deepEqual(g.mercyTargets(), [], 'golden state is immune to Mercy');
  const gold = g.players[0].hand[0];
  // Make the top card an exact match before P0's turn comes round.
  const match = { id: idSeq++, color: gold.color, type: 'number', value: gold.value };
  g.cards.set(match.id, match);
  g.players[1].hand.push(match);
  g.activeColor = gold.color;
  play(g, 1, match);
  g.apply({ type: 'draw', player: 2 });
  if (g.current === 2) g.apply({ type: 'pass', player: 2 });
  assert.equal(g.winner, 0, 'exact match: Sentry wins');
  assert.equal(g.winHow, 'sentry');
});

test('Sentry: no exact match → the real hand returns', () => {
  const sentry = H('hero_sentry');
  const g = chaos([[sentry, N('blue', 1), N('blue', 2)], [N('red', 3), N('red', 4)]]);
  play(g, 0, sentry, { color: 'red' });
  const gold = g.players[0].hand[0];
  const other = { id: idSeq++, color: 'red', type: 'number', value: gold.value === 9 ? 8 : 9 };
  g.cards.set(other.id, other); g.players[1].hand.push(other);
  play(g, 1, other);
  assert.equal(g.current, 0);
  assert.equal(g.players[0].stash, null);
  assert.equal(g.players[0].hand.length, 2, 'blue 1 and blue 2 are back');
  g.checkIntegrity();
});

test('Thor: escalating +4, +8, +12 and every opponent loses a turn; pierces shields', () => {
  const thor = H('hero_thor');
  const g = chaos([[thor, N('red', 1), N('red', 2)], [N('green', 1)], [N('green', 2)], [N('green', 3)]]);
  g.players[2].shield = 'armed';
  play(g, 0, thor, { color: 'red' });
  assert.deepEqual(counts(g), [2, 5, 9, 13]);
  assert.equal(g.current, 0, 'all opponents skipped');
});

test('HERO cards cannot be stolen or swapped', () => {
  const thor = H('hero_thor');
  const g = chaos([[C('red', 'steal3'), N('red', 1), N('red', 2)], [thor, N('green', 1), N('green', 2), N('green', 3), N('green', 4)], [N('green', 5), N('green', 6)]]);
  play(g, 0, g.players[0].hand[0], { target: 1 });
  assert.ok(g.players[1].hand.includes(thor));
  g._triggerChaos('swap');
  g._triggerChaos('reverseReality');
  const owner = g.players.find((p) => p.hand.includes(thor));
  assert.equal(owner.id, 1);
  g.checkIntegrity();
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} rule tests passed`);
if (failed) process.exit(1);
