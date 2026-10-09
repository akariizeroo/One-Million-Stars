// AI opponents. Every decision is made from UnoGame.publicView(): the AI sees its
// own hand, card counts, the discard pile and the public action history — never
// another player's hidden cards.

import { COLORS, cardPoints, isWild, STACK_RANK } from './cards.js';
import { METER_GAIN } from './engine.js';
import { rolloutValue } from './lookahead.js';

export const PERSONALITIES = {
  strategist: { name: 'Strategist', icon: '♟', blurb: 'Counts cards, remembers plays and plans ahead.',
    flex: 1.3, attack: 0.8, block: 1.1, shed: 0.6, chaos: 0.8, bluff: 0, challengeBias: 0, model: true, lookahead: true },
  aggressor: { name: 'Aggressor', icon: '⚔', blurb: 'Hammers you with Draws and Skips.',
    flex: 0.2, attack: 2.3, block: 0.5, shed: 0.9, chaos: 1.4, bluff: 0.08, challengeBias: 0.1, model: false, lookahead: false },
  trickster: { name: 'Trickster', icon: '🃏', blurb: 'Bluffs, challenges and stirs up chaos.',
    flex: 0.6, attack: 1.0, block: 0.8, shed: 0.6, chaos: 1.7, bluff: 0.5, challengeBias: 0.22, model: false, lookahead: false },
  opportunist: { name: 'Opportunist', icon: '🦊', blurb: 'Adapts on the fly and punishes mistakes.',
    flex: 0.8, attack: 1.0, block: 0.9, shed: 1.0, chaos: 1.0, bluff: 0.1, challengeBias: 0.05, model: true, lookahead: false, catchBonus: 0.25 },
  mastermind: { name: 'Mastermind', icon: '🧠', blurb: 'Probability, opponent modeling, long-term plans.',
    flex: 1.4, attack: 1.1, block: 1.7, shed: 0.7, chaos: 1.0, bluff: 0.15, challengeBias: 0, model: true, lookahead: true },
};

export const DIFFICULTIES = {
  easy:   { name: 'Easy',   noise: 2.4, blunder: 0.28, forgetUno: 0.22, catchP: 0.3,  react: [1150, 2000], model: false },
  normal: { name: 'Normal', noise: 1.0, blunder: 0.07, forgetUno: 0.08, catchP: 0.6,  react: [950, 1650],  model: false },
  hard:   { name: 'Hard',   noise: 0.35, blunder: 0,   forgetUno: 0.02, catchP: 0.85, react: [800, 1400],  model: true },
  expert: { name: 'Expert', noise: 0.08, blunder: 0,   forgetUno: 0,    catchP: 0.97, react: [700, 1300],  model: true },
};

const threatOf = (count) => (count <= 1 ? 3.2 : count === 2 ? 2.2 : count <= 4 ? 1.1 : 0.35);

// Monte Carlo rollouts per decision (0 = heuristics only). Lowered in fast tests.
export const LOOKAHEAD = { mastermind: { expert: 160, hard: 70 }, strategist: { expert: 60 }, scale: 1 };

export class AIPlayer {
  constructor(pid, personality, difficulty, rng = Math.random) {
    this.pid = pid;
    this.personality = PERSONALITIES[personality] ? personality : 'strategist';
    this.difficulty = DIFFICULTIES[difficulty] ? difficulty : 'normal';
    this.P = PERSONALITIES[this.personality];
    this.D = DIFFICULTIES[this.difficulty];
    this.rng = rng;
    this.cursor = 0;
    this.models = new Map(); // pid -> { lack: {color:0..1}, lackWild, challenges, wd4Faced, bluffsCaught }
    this.lastHistory = null;
  }

  get rolloutBudget() {
    const b = (LOOKAHEAD[this.personality] || {})[this.difficulty] || 0;
    return Math.round(b * LOOKAHEAD.scale);
  }

  // Pick among candidate actions by simulated win rate (heuristic score breaks ties).
  lookahead(view, scored) {
    const budget = this.rolloutBudget;
    if (!budget || scored.length < 2) return null;
    scored.sort((a, b) => b.score - a.score);
    const cands = scored.slice(0, 4);
    const per = Math.max(6, Math.floor(budget / cands.length));
    let best = null;
    let bestV = -Infinity;
    for (const c of cands) {
      const v = rolloutValue(view, this, c.action, per, this.rng) + 0.004 * c.score;
      if (v > bestV) { bestV = v; best = c.action; }
    }
    return best;
  }

  // Opponent modeling is unlocked by personality OR difficulty.
  get usesModel() { return this.P.model || this.D.model; }

  model(pid) {
    if (!this.models.has(pid)) {
      this.models.set(pid, { lack: { red: 0, yellow: 0, green: 0, blue: 0 }, lackWild: 0,
        challenges: 0, wd4Faced: 0, bluffsCaught: 0, timesChallenged: 0 });
    }
    return this.models.get(pid);
  }

  // Incrementally learn from public history.
  observe(view) {
    const h = view.history;
    if (h !== this.lastHistory) { this.lastHistory = h; this.cursor = Math.min(this.cursor, h.length); }
    for (; this.cursor < h.length; this.cursor++) {
      const e = h[this.cursor];
      if (e.p === this.pid && e.t !== 'challenge' && e.t !== 'caught') continue;
      switch (e.t) {
        case 'play': {
          const m = this.model(e.p);
          if (!isWild(e.card)) m.lack[e.card.color] = 0;
          else m.lackWild = 0;
          if (e.card.type === 'wild4' && !e.stacked && e.next !== undefined) this.model(e.next).wd4Faced++;
          break;
        }
        case 'draw': {
          const m = this.model(e.p);
          if (e.voluntary && e.activeColor) {
            m.lack[e.activeColor] = Math.max(m.lack[e.activeColor], 0.82);
            m.lackWild = Math.max(m.lackWild, 0.45);
          }
          const decay = Math.pow(0.78, e.n || 0);
          for (const c of COLORS) if (!(e.voluntary && c === e.activeColor)) m.lack[c] *= decay;
          m.lackWild *= Math.pow(0.95, e.n || 0);
          break;
        }
        case 'challenge':
          this.model(e.p).challenges++;
          this.model(e.target).timesChallenged++;
          if (e.success) this.model(e.target).bluffsCaught++;
          break;
        case 'transfer': {
          const m = this.model(e.to);
          for (const c of COLORS) m.lack[c] *= 0.6;
          break;
        }
        case 'mercy':
          for (const t of e.out) this.models.delete(t);
          break;
        case 'handsMixed':
          for (const [pid, m] of this.models) {
            if (!e.players || e.players.includes(pid)) { for (const c of COLORS) m.lack[c] = 0; m.lackWild = 0; }
          }
          break;
        default: break;
      }
    }
  }

  // ---------------------------------------------------------------- estimation
  unseen(view) {
    const u = { ...view.composition };
    let total = 0;
    if (this.usesModel) {
      for (const c of view.discard) u[c.color]--;
      for (const c of view.hand) u[c.color]--;
    }
    for (const k of Object.keys(u)) { u[k] = Math.max(0, u[k]); total += u[k]; }
    return { u, total: Math.max(1, total) };
  }

  pHasColor(view, pid, color, us = this.unseen(view)) {
    const count = view.counts[pid];
    const f = us.u[color] / us.total;
    const base = 1 - Math.pow(1 - f, count);
    return base * (1 - (this.usesModel ? this.model(pid).lack[color] : 0));
  }

  pHasWild(view, pid, us = this.unseen(view)) {
    const count = view.counts[pid];
    const base = 1 - Math.pow(1 - us.u.wild / us.total, count);
    return base * (1 - (this.usesModel ? this.model(pid).lackWild : 0));
  }

  // Probability that player pid can follow `color` on top of `card`.
  pCanPlay(view, pid, color, card, us) {
    const pc = this.pHasColor(view, pid, color, us);
    const pw = this.pHasWild(view, pid, us);
    const matchFrac = card && !isWild(card) ? (card.type === 'number' ? 6 : 6) / us.total : 0;
    const pm = 1 - Math.pow(1 - matchFrac, view.counts[pid]);
    return 1 - (1 - pc) * (1 - pw) * (1 - pm);
  }

  seat(view, from, dir, steps) {
    let idx = from;
    for (let s = 0; s < steps; s++) {
      let g = 0;
      do { idx = ((idx + dir) % view.n + view.n) % view.n; } while (view.out[idx] && ++g < view.n);
    }
    return idx;
  }

  nextAfter(view, card) {
    const alive = view.out.filter((o) => !o).length;
    let dir = view.direction;
    let steps = 1;
    if (card.type === 'reverse') { dir = -dir; if (alive === 2) steps = 2; }
    if (card.type === 'skip') steps = 2;
    if (card.type === 'ultreverse') { dir = -dir; steps = 2; }
    return this.seat(view, view.me, dir, steps);
  }

  // ---------------------------------------------------------------- decisions
  reactionTime(view) {
    const [lo, hi] = this.D.react;
    let t = lo + this.rng() * (hi - lo);
    if (this.personality === 'mastermind' || this.personality === 'strategist') t += 180;
    if (view && view.effects && view.effects.crisis > 0) t = Math.min(t, 2400);
    return t;
  }

  wantsToCatch() {
    return this.rng() < Math.min(0.99, this.D.catchP + (this.P.catchBonus || 0));
  }

  // Mercy knocks out the one-card player and the 20+ card player, but everyone left
  // inherits the big hand. Worth it when it wins outright or the share is bearable.
  wantsMercy(view) {
    const [one, big] = view.mercyTargets;
    if (!view.canMercy || big === this.pid) return false;
    const remaining = view.out.filter((o) => !o).length - 2;
    if (remaining <= 1) return true; // I'm the last one standing: instant win
    const share = (view.counts[one] + view.counts[big]) / remaining;
    const tolerance = this.personality === 'aggressor' || this.personality === 'trickster' ? 14 : 10;
    if (this.usesModel && share > tolerance && view.hand.length + share > 18) return false;
    return this.rng() < Math.min(0.99, this.D.catchP + (this.P.catchBonus || 0));
  }

  // Jump-In: shedding a card out of turn is free tempo, unless a Seven-O swap would hurt.
  decideJumpIn(view) {
    if (!view.jumpIns || !view.jumpIns.length) return null;
    this.observe(view);
    const chance = { easy: 0.35, normal: 0.6, hard: 0.85, expert: 0.95 }[this.difficulty]
      + (this.personality === 'opportunist' || this.personality === 'aggressor' ? 0.1 : 0);
    if (this.rng() >= chance) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const id of view.jumpIns) {
      const card = view.hand.find((c) => c.id === id);
      let s = 1 + this.sevenOValue(view, card);
      if (card.type === 'draw2' && this.P.flex > 1.2 && !view.pending) s -= 0.5;
      if (s > bestScore) { bestScore = s; best = card; }
    }
    if (!best || bestScore < 0) return null;
    const action = this.playAction(view, best);
    action.type = 'jumpin';
    return action;
  }

  jumpDelay() {
    const base = { easy: 1300, normal: 950, hard: 700, expert: 520 }[this.difficulty];
    return base * (this.personality === 'opportunist' ? 0.75 : 1) * (0.75 + this.rng() * 0.5);
  }

  // Seven-O: value of the hand exchange caused by playing `card` (0 if none).
  sevenOValue(view, card) {
    if (!view.rules || !view.rules.sevenO || card.type !== 'number') return 0;
    const rest = view.hand.length - 1;
    if (rest === 0) return 0; // going out: no swap happens
    if (card.value === 7) {
      const t = this.swapTarget(view);
      return 1.1 * (rest - view.counts[t]);
    }
    if (card.value === 0) {
      const prev = this.seat(view, view.me, -view.direction, 1);
      return 1.0 * (rest - view.counts[prev]);
    }
    return 0;
  }

  swapTarget(view) {
    let best = null;
    for (let i = 0; i < view.n; i++) {
      if (i === view.me || view.out[i]) continue;
      if (best === null || view.counts[i] < view.counts[best]) best = i;
    }
    return best;
  }

  catchDelay() {
    const base = { easy: 1100, normal: 800, hard: 600, expert: 450 }[this.difficulty];
    return base * (this.personality === 'opportunist' ? 0.7 : 1) * (0.7 + this.rng() * 0.6);
  }

  decide(view) {
    this.observe(view);
    if (view.pending) return this.decidePenalty(view);
    const legal = view.hand.filter((c) => view.legal.includes(c.id));
    if (view.drawnCard !== null) {
      const c = legal.find((x) => x.id === view.drawnCard);
      if (!c) return { type: 'pass', player: this.pid };
      if (view.rules && view.rules.forcePlay) return this.playAction(view, c);
      const keep = c.type === 'mirror' || (c.type === 'plus10' && view.hand.length > 3 && this.P.flex > 1)
        || (isWild(c) && this.P.flex > 1.2 && view.hand.length > 6 && this.rng() < 0.5);
      if (keep) return { type: 'pass', player: this.pid };
      return this.playAction(view, c);
    }
    if (!legal.length) return { type: 'draw', player: this.pid };

    if (this.rng() < this.D.blunder) return this.playAction(view, legal[Math.floor(this.rng() * legal.length)]);

    const holdsActive = (card) => view.hand.some((c) => c.id !== card.id && c.color === view.activeColor);
    let best = null;
    let bestScore = -Infinity;
    const us = this.unseen(view);
    const scored = [];
    for (const card of legal) {
      if (card.type === 'wild4' && holdsActive(card) && !this.willBluff(view)) continue;
      const action = this.playAction(view, card, us);
      const s = this.scorePlay(view, card, action, us) + (this.rng() - 0.5) * 2 * this.D.noise;
      scored.push({ action, score: s });
      if (s > bestScore) { bestScore = s; best = action; }
    }
    if (!best) return { type: 'draw', player: this.pid };
    return this.lookahead(view, scored) || best;
  }

  willBluff(view) {
    if (this.P.bluff <= 0) return false;
    const next = this.seat(view, view.me, view.direction, 1);
    const m = this.model(next);
    const propensity = m.wd4Faced ? m.challenges / Math.max(1, m.wd4Faced) : 0.25;
    return this.rng() < this.P.bluff * (1 - Math.min(0.9, propensity * 1.5));
  }

  playAction(view, card, us = this.unseen(view)) {
    const action = { type: 'play', player: this.pid, cardId: card.id };
    if (isWild(card)) action.color = this.chooseColor(view, card, us);
    if (card.type === 'steal3' || card.type === 'destroyer') action.target = this.chooseTarget(view, card);
    else if (view.rules && view.rules.sevenO && card.type === 'number' && card.value === 7) action.target = this.swapTarget(view);
    if (view.hand.length === 2) action.sayUno = this.rng() >= this.D.forgetUno;
    return action;
  }

  chooseColor(view, card, us) {
    const allowed = view.allowedColors;
    const next = this.nextAfter(view, card);
    let best = allowed[0];
    let bestScore = -Infinity;
    for (const color of allowed) {
      let s = 0;
      for (const c of view.hand) {
        if (c.id === card.id || c.color !== color) continue;
        s += c.type === 'number' ? 1 : 1.35;
      }
      if (this.usesModel) s += (1 - this.pHasColor(view, next, color, us)) * 1.6 * this.P.block;
      s += this.rng() * this.D.noise * 0.6;
      if (s > bestScore) { bestScore = s; best = color; }
    }
    return best;
  }

  chooseTarget(view) {
    // Prefer the opponent with the biggest hand (never accelerate a near-winner).
    let best = null;
    for (let i = 0; i < view.n; i++) {
      if (i === view.me || view.out[i]) continue;
      if (best === null || view.counts[i] > view.counts[best]) best = i;
    }
    return best;
  }

  attackWeight(view) {
    let w = this.P.attack;
    if (this.personality === 'opportunist') {
      const minOpp = Math.min(...view.counts.filter((_, i) => i !== view.me && !view.out[i]));
      w = minOpp <= 2 ? 2.2 : view.hand.length > minOpp + 4 ? 0.7 : 1.1;
    }
    return w * (view.penaltyMult > 1 ? 1.4 : 1);
  }

  scorePlay(view, card, action, us) {
    const W = this.P;
    const me = view.hand.length;
    const n = view.n;
    const opp = view.counts.map((c, i) => (i === view.me || view.out[i] ? Infinity : c));
    const minOpp = Math.min(...opp);
    const alive = view.counts.filter((_, i) => !view.out[i]);
    const avg = alive.reduce((a, b) => a + b, 0) / alive.length;
    const color = action.color || card.color;
    const nextNormal = this.seat(view, view.me, view.direction, 1);
    const prevNormal = this.seat(view, view.me, -view.direction, 1);
    const nextAfter = this.nextAfter(view, card);
    const attackW = this.attackWeight(view);
    let s = 0;

    // Shed high-value cards, especially when someone is about to go out.
    s += W.shed * (cardPoints(card) / 25) * (minOpp <= 3 ? 1.6 : 0.6);

    // Flexibility: wild cards are precious; spending them early costs.
    if (isWild(card)) s -= W.flex * (me > 4 ? 2.0 : me > 2 ? 1.0 : 0.2);

    // Attacks.
    const t = threatOf(view.counts[nextNormal]);
    switch (card.type) {
      case 'skip': s += attackW * 0.9 * t + (this.personality === 'aggressor' ? 0.8 : 0); break;
      case 'reverse':
        s += n === 2 ? attackW * 0.9 * t : attackW * 0.6 * (t - threatOf(view.counts[prevNormal]));
        break;
      case 'draw2': s += attackW * 1.6 * t + (this.personality === 'aggressor' ? 1.2 : 0); break;
      case 'wild4': s += attackW * 2.6 * t + (this.personality === 'aggressor' ? 1.5 : 0); break;
      case 'plus10': s += attackW * 4.0 * t + (this.personality === 'aggressor' ? 2 : 0) - (W.flex > 1 && minOpp > 3 ? 1.5 : 0); break;
      case 'ultreverse': s += attackW * 1.1 * threatOf(view.counts[prevNormal]); break;
      case 'everyone4': {
        let sum = 0;
        for (let i = 0; i < n; i++) if (i !== view.me && !view.out[i]) sum += threatOf(view.counts[i]) + 0.4;
        s += attackW * 1.2 * sum;
        break;
      }
      case 'laststand': {
        let sum = 0;
        for (let i = 0; i < n; i++) if (i !== view.me && !view.out[i]) sum += threatOf(view.counts[i]) + 0.8;
        s += 3 + attackW * 1.3 * sum;
        break;
      }
      case 'shufflehands': s += W.chaos * 0.9 * (me - avg) - 0.5; break;
      case 'chaoswild': s += W.chaos * 0.3 * (me - minOpp) - 0.4 + (this.personality === 'trickster' ? 1 : 0); break;
      case 'colorlock': {
        const mine = view.hand.filter((c) => c.color === color && c.id !== card.id).length;
        s += 0.55 * mine - 0.6;
        break;
      }
      case 'steal3': s += this.personality === 'trickster' ? 0.3 : -1.3; break;
      case 'destroyer': s += -0.4; break;
      case 'mirror': s -= 3.5; break; // hold for defence
      // ---- HERO cards: once per match, so timing is everything.
      case 'hero_superman':
        // Four uninterrupted turns: devastating when it can carry me to (or near) zero.
        s += (me <= 5 ? 9 : me <= 7 ? 3 : -1.5) + (minOpp <= 2 ? 3 : 0);
        break;
      case 'hero_cap':
        // A shield is a defensive tool; hold it unless I'm about to go out or under fire.
        s += me <= 2 ? 1 : minOpp <= 2 ? 0.5 : -3;
        break;
      case 'hero_sentry':
        // +15 to every opponent: save it for when someone threatens to win.
        s += minOpp <= 3 ? 10 : avg > 9 ? -1 : 2;
        break;
      case 'hero_thor': {
        let threat = 0;
        for (let i = 0; i < n; i++) if (i !== view.me && !view.out[i]) threat += threatOf(view.counts[i]);
        s += minOpp <= 3 ? 8 + threat * 0.5 : 2.5;
        break;
      }
      default: break;
    }

    // Seven-O hand exchanges.
    s += this.sevenOValue(view, card);

    // Continuity: how much of my remaining hand still follows afterwards.
    const rest = view.hand.filter((c) => c.id !== card.id);
    if (rest.length) {
      const follow = rest.filter((c) => isWild(c) || c.color === color
        || (!isWild(card) && c.type === card.type && (c.type !== 'number' || c.value === card.value))).length;
      s += 1.3 * (follow / rest.length);
      // Keep colors I hold lots of.
      const share = rest.filter((c) => c.color === color).length / rest.length;
      s += 0.8 * share;
    }

    // Blocking: chance the next player is stuck (needs card counting / modeling).
    if (this.usesModel) {
      const pStuck = 1 - this.pCanPlay(view, nextAfter, color, card, us);
      s += W.block * pStuck * (threatOf(view.counts[nextAfter]) + 0.4);
    }

    // Lookahead / endgame planning.
    if ((W.lookahead || this.difficulty === 'expert') && rest.length && rest.length <= 3) {
      const wilds = rest.filter(isWild).length;
      if (rest.length === 1) s += isWild(rest[0]) && rest[0].type !== 'laststand' ? 2.2 : rest[0].color === color ? 1.4 : 0;
      else s += 0.6 * wilds;
      if (rest.some((c) => c.type === 'laststand') && rest.length <= 2) s += 1.5;
    }

    // Chaos meter awareness: leaders avoid triggering random events; the behind push for them.
    if (view.mode === 'chaos') {
      const gain = (METER_GAIN[card.type] || 0) * (1 + 0.15 * view.chaosLevel);
      if (gain && view.meter + gain >= 100) s += W.chaos * 0.18 * (me - avg);
    }
    return s;
  }

  decidePenalty(view) {
    const pend = view.pending;
    // Challenge an illegal Wild Draw Four?
    if (view.canChallenge) {
      const p = this.estimateIllegal(view);
      let challenge;
      if (this.D.model || this.P.model) {
        // Win: offender draws, I keep my turn. Lose: I draw amount+2 instead of amount.
        const threshold = 2 / (pend.amount + 4) - this.P.challengeBias;
        challenge = p > threshold + (this.rng() - 0.5) * 0.08;
      } else {
        challenge = this.rng() < 0.12 + this.P.challengeBias + (p > 0.75 ? 0.2 : 0);
      }
      if (challenge) return { type: 'challenge', player: this.pid };
    }
    const legal = view.hand.filter((c) => view.legal.includes(c.id));
    if (!legal.length || this.rng() < this.D.blunder * 0.5) return { type: 'draw', player: this.pid };
    const us = this.unseen(view);
    let best = null;
    let bestScore = 0; // drawing scores 0
    const scored = [{ action: { type: 'draw', player: this.pid }, score: 0 }];
    for (const card of legal) {
      let s = 2 + pend.amount * 0.4;
      if (card.type === 'hero_cap') {
        // Shield the stack back at the attacker — worth it for anything sizeable.
        s = pend.amount >= 6 ? 6 + pend.amount * 0.5 : 0.5;
      } else if (card.type === 'mirror') {
        const attacker = pend.attacker;
        s += pend.amount >= 6 || this.personality === 'aggressor' ? 1.5 : -1.2;
        s += threatOf(view.counts[attacker]) * 0.6;
        if (legal.some((c) => c.type !== 'mirror')) s -= 0.8;
      } else {
        s -= (STACK_RANK[card.type] - STACK_RANK[pend.kind]) * 0.5; // don't escalate needlessly
        if (card.type === 'plus10' && this.P.flex > 1) s -= 0.6;
      }
      s += (this.rng() - 0.5) * this.D.noise;
      scored.push({ action: this.playAction(view, card, us), score: s });
      if (s > bestScore) { bestScore = s; best = card; }
    }
    const la = this.lookahead(view, scored);
    if (la) return la;
    return best ? this.playAction(view, best, us) : { type: 'draw', player: this.pid };
  }

  // Bayesian estimate that the Wild Draw Four was a bluff: a player only plays it
  // illegally if they are a bluffer AND held the previous color.
  estimateIllegal(view) {
    const pend = view.pending;
    const off = pend.attacker;
    const m = this.model(off);
    const pHas = this.pHasColor(view, off, pend.prevColor);
    const prior = (m.bluffsCaught + 0.35) / (m.timesChallenged + 2);
    const bluff = prior * pHas;
    return bluff / (bluff + (1 - pHas) + 1e-6);
  }
}
