// Plays thousands of full AI-vs-AI games in Standard (with random house-rule
// combinations) and Chaos Mode, checking engine invariants after every action:
// card conservation, legal turn order, no stalls, rules isolation.
import { UnoGame, HOUSE_RULES } from '../js/engine.js';
import { AIPlayer, PERSONALITIES, DIFFICULTIES } from '../js/ai.js';

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function must(game, action) {
  const r = game.apply(action);
  if (!r.ok) throw new Error(`Illegal AI action ${JSON.stringify(action)} -> ${r.error}`);
  game.checkIntegrity();
  return r;
}

// Everything that can happen out of turn between two turns: Mercy, UNO catches, Jump-Ins.
function outOfTurn(game, ais, rng, counters) {
  for (let guard = 0; guard < 50 && game.phase === 'turn'; guard++) {
    const order = ais.filter((ai) => !game.players[ai.pid].out).sort(() => rng() - 0.5);
    let acted = false;
    if (game.mercyTargets().length) {
      counters.mercyChances++;
      const caller = order.find((ai) => game.canCallMercy(ai.pid) && ai.wantsMercy(game.publicView(ai.pid)));
      if (caller) {
        const before = game.activeCount();
        must(game, { type: 'mercy', player: caller.pid });
        if (game.phase === 'turn' && game.activeCount() !== before - 2) throw new Error('Mercy must knock out exactly two');
        counters.mercyCalls++;
        acted = true;
      }
    }
    if (game.phase !== 'turn') return;
    if (game.unoVulnerable !== null) {
      const v = game.unoVulnerable;
      const catcher = order.find((ai) => ai.pid !== v && ai.wantsToCatch());
      if (catcher) { must(game, { type: 'catch', player: catcher.pid, target: v }); counters.catches++; acted = true; }
    }
    for (const ai of order) {
      if (game.phase !== 'turn') return;
      const a = ai.decideJumpIn(game.publicView(ai.pid));
      if (a) {
        if (game.mode !== 'standard' || !game.rules.jumpIn) throw new Error('Jump-In outside Standard rules');
        must(game, a);
        counters.jumpIns++;
        acted = true;
        break; // others get a chance to interrupt before the next jump
      }
    }
    if (!acted) return;
  }
}

export function playGame({ mode, rules, n, seed, personalities, difficulties, tuning = {} }) {
  const rng = mulberry32(seed);
  const players = Array.from({ length: n }, (_, i) => ({ name: `P${i}` }));
  const game = new UnoGame({ mode, rules, players, rng, ...tuning });
  const ais = players.map((_, i) => new AIPlayer(i, personalities[i], difficulties[i], rng));
  const counters = { mercyChances: 0, mercyCalls: 0, catches: 0, jumpIns: 0 };
  game.start();
  game.checkIntegrity();
  let steps = 0;
  while (game.phase === 'turn') {
    if (++steps > (tuning.maxSteps || 20000)) throw new Error(`${mode} game ${seed} did not finish`);
    outOfTurn(game, ais, rng, counters);
    if (game.phase !== 'turn') break;
    const pid = game.current;
    if (game.players[pid].out) throw new Error('Knocked-out player has the turn');
    must(game, ais[pid].decide(game.publicView(pid)));
    if (game.phase === 'turn') {
      const cur = game.players[game.current];
      if (cur.hand.length === 0) throw new Error('Current player has an empty hand');
      if (game.pending && game.pending.amount <= 0) throw new Error('Bad pending penalty');
      if (game.mode === 'standard') {
        if (game.effects.lock || game.effects.collapse || game.effects.storm || game.meter) throw new Error('Chaos leaked into Standard');
        if (game.players.some((p) => p.out)) throw new Error('Knockouts in Standard');
        if (game.pending && !game.rules.stacking && game.legalPlays(game.current).length) throw new Error('Stacking while disabled');
      }
    }
    game.drainEvents();
  }
  if (game.winHow !== 'lastStanding' && game.players[game.winner].hand.length !== 0) throw new Error('Winner has cards');
  return { game, ais, counters };
}

const isMain = process.argv[1] && process.argv[1].endsWith('simulate.test.js');
if (isMain) {
  const persKeys = Object.keys(PERSONALITIES);
  const diffKeys = Object.keys(DIFFICULTIES);
  const ruleKeys = Object.keys(HOUSE_RULES);
  const GAMES = Number(process.env.GAMES || 1500);
  const summary = {};
  for (const mode of ['standard', 'chaos']) {
    const agg = { games: GAMES, avgTurns: 0, maxTurns: 0, lastStanding: 0, chaosEvents: 0, challenges: 0,
      maxStack: 0, swaps: 0, mercyChances: 0, mercyCalls: 0, catches: 0, jumpIns: 0, wins: {} };
    for (let g = 0; g < GAMES; g++) {
      const n = 2 + (g % 5);
      // Standard: every 4th game uses the default preset, others a random rule mix.
      let rules;
      if (mode === 'standard' && g % 4) {
        const r = mulberry32(g + 99);
        rules = Object.fromEntries(ruleKeys.map((k) => [k, r() < 0.5]));
      }
      const { game, ais, counters } = playGame({
        mode, rules, n, seed: g * 7919 + (mode === 'chaos' ? 1 : 0),
        personalities: Array.from({ length: n }, (_, i) => persKeys[(g + i) % persKeys.length]),
        difficulties: Array.from({ length: n }, (_, i) => diffKeys[(g * 3 + i) % diffKeys.length]),
      });
      agg.avgTurns += game.turn / GAMES;
      agg.maxTurns = Math.max(agg.maxTurns, game.turn);
      if (game.winHow === 'lastStanding') agg.lastStanding++;
      agg.chaosEvents += game.stats.chaosEvents;
      agg.challenges += game.stats.challenges;
      agg.swaps += game.stats.swaps;
      agg.maxStack = Math.max(agg.maxStack, game.stats.maxStack);
      for (const k of ['mercyChances', 'mercyCalls', 'catches', 'jumpIns']) agg[k] += counters[k];
      const w = ais[game.winner].personality;
      agg.wins[w] = (agg.wins[w] || 0) + 1;
    }
    agg.avgTurns = +agg.avgTurns.toFixed(1);
    summary[mode] = agg;
  }
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.standard.jumpIns || !summary.standard.swaps) throw new Error('House rules never exercised');

  // Skill check: an expert Mastermind should beat three Easy AIs well above the 25% fair share.
  for (const mode of ['standard', 'chaos']) {
    let wins = 0;
    const G = 800;
    for (let g = 0; g < G; g++) {
      const seat = g % 4;
      const personalities = ['aggressor', 'trickster', 'opportunist', 'strategist'];
      const difficulties = ['easy', 'easy', 'easy', 'easy'];
      personalities[seat] = 'mastermind';
      difficulties[seat] = 'expert';
      const { game } = playGame({ mode, n: 4, seed: 100000 + g, personalities, difficulties });
      if (game.winner === seat) wins++;
    }
    const rate = wins / G;
    console.log(`${mode}: expert Mastermind vs 3 Easy AIs wins ${(rate * 100).toFixed(1)}% (fair share 25%)`);
    if (rate < 0.3) throw new Error(`Expert AI is not clearly stronger than Easy AI in ${mode}`);
  }
  console.log('simulation OK');
}
