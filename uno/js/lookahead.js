// Monte Carlo look-ahead for the strongest AIs ("determinized rollouts").
//
// The AI never peeks at hidden cards. Instead it rebuilds the unseen cards from
// public knowledge (deck composition minus the discard pile and its own hand),
// deals them randomly to opponents (biased away from colors an opponent has shown
// they lack), then plays each candidate move out to the end of the round many
// times with a fast policy. The move that wins most often is chosen.

import { UnoGame } from './engine.js';
import { makeDeck, isWild, COLORS } from './cards.js';

const sig = (c) => `${c.color}|${c.type}|${c.value}`;

// Fast rollout policy: sensible but cheap.
function fastAction(g, pid, rng) {
  const p = g.players[pid];
  const legal = g.legalPlays(pid);
  if (!legal.length) {
    if (g.drawnCard !== null) return { type: 'pass', player: pid };
    return { type: 'draw', player: pid };
  }
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of p.hand) if (counts[c.color] !== undefined) counts[c.color]++;
  let best = null;
  let bestS = -Infinity;
  for (const id of legal) {
    const c = g.card(id);
    let s = rng() * 0.3;
    if (isWild(c)) s -= p.hand.length > 2 ? 2 : 0;
    else s += counts[c.color] * 0.5;
    if (c.type === 'draw2' || c.type === 'skip' || c.type === 'wild4' || c.type === 'plus10') s += 0.4;
    if (s > bestS) { bestS = s; best = c; }
  }
  const allowed = g.allowedColors();
  const color = allowed.reduce((a, b) => (counts[b] > counts[a] ? b : a), allowed[0]);
  const target = g.opponentsOf(pid).reduce((a, b) => (b.hand.length < a.hand.length ? b : a)).id;
  return { type: 'play', player: pid, cardId: best.id, color, target, sayUno: true };
}

// Build a concrete game consistent with everything the AI can see.
export function determinize(view, ai, rng) {
  const g = new UnoGame({ mode: view.mode, rules: view.rules, players: Array.from({ length: view.n }, () => ({})), rng });
  g.emit = () => {};
  const total = Object.values(view.composition).reduce((a, b) => a + b, 0);
  const deckSize = makeDeck(view.mode, () => 0).length;
  const decks = Math.max(1, Math.round(total / deckSize));
  let nextId = 1e6;
  const pool = [];
  for (let d = 0; d < decks; d++) pool.push(...makeDeck(view.mode, () => nextId++));
  // Remove everything visible: the discard pile and my own hand.
  const bySig = new Map();
  for (const c of pool) { const k = sig(c); if (!bySig.has(k)) bySig.set(k, []); bySig.get(k).push(c); }
  const take = (c) => { const arr = bySig.get(sig(c)); if (arr && arr.length) arr.pop(); };
  view.discard.forEach(take);
  view.hand.forEach(take);
  const unseen = [...bySig.values()].flat();
  g.shuffle(unseen);

  g.cards = new Map();
  const reg = (c) => { g.cards.set(c.id, c); return c; };
  g.discard = view.discard.map((c) => reg({ ...c }));
  g._nextId = nextId + 1000;

  // Deal hidden hands, biased away from colors each opponent is believed to lack.
  for (let i = 0; i < view.n; i++) {
    const pl = g.players[i];
    pl.out = view.out[i];
    if (i === view.me) { pl.hand = view.hand.map((c) => reg({ ...c })); continue; }
    pl.hand = [];
    const lack = ai && ai.usesModel ? ai.model(i).lack : null;
    for (let k = 0; k < view.counts[i] && unseen.length; k++) {
      let idx = unseen.length - 1;
      if (lack) {
        for (let tries = 0; tries < 6; tries++) {
          const j = Math.floor(rng() * unseen.length);
          const c = unseen[j];
          if (c.color === 'wild' || rng() >= (lack[c.color] || 0)) { idx = j; break; }
        }
      }
      pl.hand.push(reg(unseen.splice(idx, 1)[0]));
    }
  }
  g.drawPile = unseen.slice(0, Math.max(0, view.drawPileCount)).map(reg);
  // Any surplus (should not happen) is ignored; integrity is not needed for rollouts.

  g.activeColor = view.activeColor;
  g.direction = view.direction;
  g.current = view.current;
  g.pending = view.pending ? { ...view.pending, illegal: false } : null;
  g.drawnCard = view.drawnCard;
  g.effects = JSON.parse(JSON.stringify(view.effects));
  g.meter = view.meter;
  g.chaosLevel = view.chaosLevel;
  g.phase = 'turn';
  return g;
}

function evaluate(g, me) {
  if (g.phase === 'gameover') return g.winner === me ? 1 : 0;
  if (g.players[me].out) return 0;
  const mine = g.players[me].hand.length;
  let best = Infinity;
  for (const p of g.players) if (p.id !== me && !p.out) best = Math.min(best, p.hand.length);
  return Math.max(0.02, Math.min(0.98, 0.5 + 0.07 * (best - mine)));
}

// Average outcome of taking `action` now, over `rollouts` determinized playouts.
export function rolloutValue(view, ai, action, rollouts, rng, depth = 70) {
  let sum = 0;
  for (let r = 0; r < rollouts; r++) {
    const g = determinize(view, ai, rng);
    if (!g.apply({ ...action }).ok) return -1;
    for (let t = 0; t < depth && g.phase === 'turn'; t++) {
      const pid = g.current;
      if (g.players[pid].out) break;
      g.apply(fastAction(g, pid, rng));
    }
    sum += evaluate(g, view.me);
  }
  return sum / rollouts;
}

export { COLORS };
