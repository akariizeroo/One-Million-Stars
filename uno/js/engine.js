// UNO rules engine. Pure logic: no DOM, no rendering, no timers.
//
// The engine is a strict state machine. Every change goes through apply(action),
// which validates the action against the current phase and player, mutates the
// state, and records presentation events (drained by the controller to drive
// animation/audio) plus public history entries (read by the AI).
//
// Phases: 'setup' -> 'turn' -> 'gameover'.
// Within 'turn', sub-states are expressed by `pending` (a draw-penalty stack the
// current player must answer) and `drawnCard` (the player drew a playable card
// and may play it or pass).

import {
  COLORS, CARD_TYPES, makeDeck, cardPoints, isWild, DRAW_VALUE, STACK_RANK,
} from './cards.js';

export const CHAOS_EVENTS = {
  apocalypse: { name: 'Draw Apocalypse', desc: 'Every draw penalty is doubled for the next round.' },
  reverseReality: { name: 'Reverse Reality', desc: 'Direction reverses and every hand is randomly redistributed.' },
  collapse: { name: 'Color Collapse', desc: 'A random color becomes unplayable for a while.' },
  heist: { name: 'Hand Heist', desc: 'One player steals random cards from every opponent.' },
  roulette: { name: 'UNO Roulette', desc: 'A random player receives between 0 and 12 cards.' },
  storm: { name: 'Wild Storm', desc: 'The active color changes randomly after every turn.' },
  explosion: { name: 'Card Explosion', desc: 'Every player receives 3–8 extra cards.' },
  crisis: { name: 'Time Crisis', desc: 'Five seconds per turn — or draw two as a penalty.' },
  swap: { name: 'Hand Swap', desc: 'Two random players exchange their entire hands.' },
  anarchy: { name: 'Total Anarchy', desc: 'Three random Chaos Events at once!' },
};

// How much each action card fills the Chaos Meter (before level scaling).
export const METER_GAIN = {
  skip: 12, reverse: 12, draw2: 16, wild: 10, wild4: 22,
  plus10: 30, everyone4: 25, ultreverse: 18, steal3: 18, colorlock: 16,
  destroyer: 20, chaoswild: 0, mirror: 20, shufflehands: 22, laststand: 25,
};

// Chaos Mercy rule: when one player holds exactly one card while another holds
// MERCY_THRESHOLD or more, any player other than the one-card player may call
// "Mercy!". Both of those players are knocked out of the round and their cards
// are dealt evenly to everyone still in.
export const MERCY_THRESHOLD = 20;
// Overload: anyone reaching OVERLOAD_LIMIT cards in Chaos Mode is knocked out and
// their cards are shuffled back into the deck. This guarantees every game ends.
export const OVERLOAD_LIMIT = 30;
export const CHAOS_STACK_CAP = 40;

const FINISHING_EFFECTS = new Set(['draw2', 'wild4', 'plus10', 'mirror', 'everyone4', 'laststand']);

// Standard Mode house rules. Each one is a real, widely played UNO house rule and
// can be toggled individually; DEFAULT_RULES is the default preset.
export const HOUSE_RULES = {
  stacking: { name: 'Progressive UNO', desc: 'Stack +2 on +2 and +4 on +4. The penalty grows until someone cannot (or will not) stack, and they draw it all. No mixing +2 and +4.' },
  jumpIn: { name: 'Jump-In', desc: 'Play an identical card (same color and number or symbol) out of turn. Play continues from you.' },
  sevenO: { name: 'Seven-O', desc: 'Playing a 7 swaps your hand with an opponent of your choice. Playing a 0 passes every hand along in the direction of play.' },
  drawUntilPlayable: { name: 'Draw Until Playable', desc: 'When you draw, keep drawing until you get a playable card.' },
  forcePlay: { name: 'Force Play', desc: 'A playable card drawn from the deck must be played immediately.' },
  jumpInUno: { name: 'Jump-In UNO', desc: 'You may win by jumping in with your final matching card.' },
  stackChallenge: { name: 'Stacking Challenges', desc: 'The most recent Wild Draw Four can be challenged even inside a +4 stack. Guilty: the bluffer draws the whole stack. Innocent: the challenger draws the stack + 2.' },
};
export const DEFAULT_RULES = {
  stacking: true, jumpIn: true, sevenO: true,
  drawUntilPlayable: false, forcePlay: false, jumpInUno: false, stackChallenge: false,
};

export class UnoGame {
  /**
   * @param {object} cfg
   * @param {'standard'|'chaos'} cfg.mode
   * @param {object} [cfg.rules] Standard Mode house rules (see HOUSE_RULES)
   * @param {Array<{name:string,isHuman?:boolean}>} cfg.players
   * @param {() => number} [cfg.rng]
   */
  constructor(cfg) {
    this.mode = cfg.mode === 'chaos' ? 'chaos' : 'standard';
    // Chaos Mode has its own fixed rule set (always stacking, no Jump-In / Seven-O).
    this.rules = this.mode === 'chaos'
      ? { stacking: true, jumpIn: false, sevenO: false, drawUntilPlayable: false, forcePlay: false, jumpInUno: false, stackChallenge: false }
      : { ...DEFAULT_RULES, ...(cfg.rules || {}) };
    this.rng = cfg.rng || Math.random;
    this.handSize = cfg.handSize || 7;
    this.stackCap = cfg.stackCap ?? CHAOS_STACK_CAP;
    this.overloadLimit = cfg.overloadLimit ?? OVERLOAD_LIMIT;
    this.meterScale = cfg.meterScale ?? 0.7;
    this.players = cfg.players.map((p, i) => ({ ...p, id: i, hand: [], saidUno: false, out: false }));
    this.n = this.players.length;
    if (this.n < 2) throw new Error('UNO needs at least two players');
    this._nextId = 1;
    this.cards = new Map(); // id -> card (every card ever created)
    this.drawPile = []; // top of pile = end of array
    this.discard = []; // top card = end of array
    this.activeColor = null;
    this.direction = 1;
    this.current = 0;
    this.pending = null; // { amount, kind, attacker, challengeable, illegal, prevColor }
    this.drawnCard = null; // id of a just-drawn playable card
    this.unoVulnerable = null; // pid who reached one card without calling UNO
    this.effects = { apocalypse: 0, collapse: null, storm: 0, crisis: 0, lock: null };
    this.meter = 0;
    this.chaosLevel = 0;
    this.turn = 0;
    this.phase = 'setup';
    this.winner = null;
    this.roundScore = 0;
    this.events = [];
    this.history = [];
    this.stats = { cardsPlayed: 0, chaosEvents: 0, maxStack: 0, challenges: 0, decksAdded: 0, jumpIns: 0, swaps: 0 };
  }

  // ------------------------------------------------------------------ helpers
  emit(e) { this.events.push(e); }
  drainEvents() { const e = this.events; this.events = []; return e; }
  top() { return this.discard[this.discard.length - 1]; }
  card(id) { return this.cards.get(id); }
  randInt(lo, hi) { return lo + Math.floor(this.rng() * (hi - lo + 1)); }
  pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  // Next seat in turn order, skipping knocked-out players.
  nextIndex(steps = 1, from = this.current, dir = this.direction) {
    let idx = from;
    for (let s = 0; s < steps; s++) {
      let guard = 0;
      do { idx = (((idx + dir) % this.n) + this.n) % this.n; } while (this.players[idx].out && ++guard < this.n);
    }
    return idx;
  }
  active() { return this.players.filter((p) => !p.out); }
  activeCount() { return this.active().length; }
  penaltyMult() { return this.effects.apocalypse > 0 ? 2 : 1; }
  allowedColors() {
    if (this.effects.lock) return [this.effects.lock.color];
    return COLORS.filter((c) => !this.effects.collapse || c !== this.effects.collapse.color);
  }
  opponentsOf(pid) { return this.players.filter((p) => p.id !== pid && !p.out); }

  _addDeck() {
    const cards = makeDeck(this.mode, () => this._nextId++);
    for (const c of cards) this.cards.set(c.id, c);
    this.shuffle(cards);
    this.drawPile.unshift(...cards); // new deck goes underneath
    this.stats.decksAdded++;
    this.emit({ t: 'newDeck', cards });
    return cards;
  }

  // ------------------------------------------------------------------ setup
  start(firstPlayer = null) {
    if (this.phase !== 'setup') throw new Error('Game already started');
    this._addDeck();
    this.shuffle(this.drawPile);
    this.emit({ t: 'shuffle' });
    const order = [];
    for (let r = 0; r < this.handSize; r++) {
      for (const p of this.players) {
        const c = this.drawPile.pop();
        p.hand.push(c);
        order.push({ p: p.id, id: c.id });
      }
    }
    this.emit({ t: 'deal', order });
    // Flip the starter: must be a number card (others are buried back in the pile).
    let c = this.drawPile.pop();
    while (c.type !== 'number') {
      this.drawPile.splice(Math.floor(this.rng() * (this.drawPile.length - 10)), 0, c);
      c = this.drawPile.pop();
    }
    this.discard.push(c);
    this.activeColor = c.color;
    this.emit({ t: 'flip', id: c.id, color: c.color });
    this.current = firstPlayer ?? Math.floor(this.rng() * this.n);
    this.phase = 'turn';
    this.history.push({ t: 'start', top: { ...c } });
    this.emit({ t: 'turn', p: this.current });
  }

  // ------------------------------------------------------------------ queries
  canPlayCard(pid, card) {
    if (this.phase !== 'turn' || pid !== this.current || !card) return false;
    const p = this.players[pid];
    if (!p.hand.includes(card)) return false;
    if (this.drawnCard !== null && card.id !== this.drawnCard) return false;
    const fx = this.effects;
    if (fx.collapse && card.color === fx.collapse.color) return false;
    if (fx.lock && !isWild(card) && card.color !== fx.lock.color) return false;
    if (card.type === 'laststand' && p.hand.length > 2) return false;
    if (this.pending) return this._canStack(card);
    if (isWild(card)) return true;
    if (card.color === this.activeColor) return true;
    const top = this.top();
    if (top && !isWild(top)) {
      if (card.type === 'number' && top.type === 'number' && card.value === top.value) return true;
      if (card.type !== 'number' && card.type === top.type) return true;
    }
    return false;
  }

  _canStack(card) {
    const kind = this.pending.kind;
    if (this.mode === 'standard') return this.rules.stacking && card.type === kind;
    if (card.type === 'mirror') return true;
    const r = STACK_RANK[card.type];
    return r !== undefined && r >= STACK_RANK[kind];
  }

  // Jump-In: an identical card (same color + same number/symbol) played out of turn.
  canJumpIn(pid, card) {
    if (!this.rules.jumpIn || this.phase !== 'turn' || pid === this.current || !card) return false;
    const p = this.players[pid];
    if (p.out || !p.hand.includes(card) || isWild(card)) return false;
    if (p.hand.length === 1 && !this.rules.jumpInUno) return false;
    const top = this.top();
    if (!top || isWild(top) || card.color !== top.color || card.type !== top.type) return false;
    if (card.type === 'number' && card.value !== top.value) return false;
    // A pending penalty can only be jumped with an identical +2 (when stacking is on).
    if (this.pending) return this.rules.stacking && card.type === this.pending.kind;
    return true;
  }

  jumpInOptions(pid) {
    if (!this.rules.jumpIn || this.phase !== 'turn' || pid === this.current) return [];
    return this.players[pid].hand.filter((c) => this.canJumpIn(pid, c)).map((c) => c.id);
  }

  needsTarget(card) {
    return card.type === 'steal3' || card.type === 'destroyer'
      || (this.rules.sevenO && card.type === 'number' && card.value === 7);
  }

  legalPlays(pid) {
    if (this.phase !== 'turn' || pid !== this.current) return [];
    return this.players[pid].hand.filter((c) => this.canPlayCard(pid, c)).map((c) => c.id);
  }

  // The pair [onePid, bigPid] that Mercy would knock out right now, or [] if it can't be called.
  // With several candidates: the one-card player soonest in turn order, and the biggest hand.
  mercyTargets() {
    if (this.mode !== 'chaos' || this.phase !== 'turn') return [];
    const alive = this.active();
    if (alive.length < 3) return [];
    const big = alive.filter((p) => p.hand.length >= MERCY_THRESHOLD)
      .sort((a, b) => b.hand.length - a.hand.length)[0];
    if (!big) return [];
    let one = null;
    let i = this.current;
    for (let k = 0; k < this.n && !one; k++) {
      const p = this.players[i];
      if (!p.out && p.hand.length === 1) one = p;
      i = this.nextIndex(1, i);
    }
    return one ? [one.id, big.id] : [];
  }

  canCallMercy(pid) {
    const targets = this.mercyTargets();
    return targets.length > 0 && !this.players[pid].out && pid !== targets[0];
  }

  canChallenge(pid) {
    return this.phase === 'turn' && pid === this.current && !!this.pending && this.pending.challengeable;
  }

  // Public information only — this is everything an AI is allowed to see.
  publicView(pid) {
    const me = this.players[pid];
    const composition = { red: 0, yellow: 0, green: 0, blue: 0, wild: 0 };
    for (const c of this.cards.values()) composition[c.color]++;
    return {
      me: pid,
      mode: this.mode,
      rules: { ...this.rules },
      n: this.n,
      hand: me.hand.map((c) => ({ ...c })),
      counts: this.players.map((p) => p.hand.length),
      out: this.players.map((p) => p.out),
      current: this.current,
      direction: this.direction,
      top: { ...this.top() },
      activeColor: this.activeColor,
      pending: this.pending ? { amount: this.pending.amount, kind: this.pending.kind,
        attacker: this.pending.attacker, challengeable: this.pending.challengeable,
        prevColor: this.pending.prevColor } : null,
      drawnCard: this.drawnCard,
      legal: this.legalPlays(pid),
      allowedColors: this.allowedColors(),
      effects: JSON.parse(JSON.stringify(this.effects)),
      meter: this.meter,
      chaosLevel: this.chaosLevel,
      penaltyMult: this.penaltyMult(),
      discard: this.discard.map((c) => ({ ...c })),
      drawPileCount: this.drawPile.length,
      composition,
      history: this.history,
      unoVulnerable: this.unoVulnerable,
      canChallenge: this.canChallenge(pid),
      jumpIns: this.jumpInOptions(pid),
      mercyTargets: this.mercyTargets(),
      canMercy: this.canCallMercy(pid),
    };
  }

  // ------------------------------------------------------------------ actions
  apply(action) {
    if (this.phase !== 'turn') return { ok: false, error: 'Game is not in progress' };
    const pid = action.player;
    if (pid === undefined || pid < 0 || pid >= this.n) return { ok: false, error: 'Unknown player' };
    if (this.players[pid].out) return { ok: false, error: 'Player is knocked out' };
    let res;
    switch (action.type) {
      case 'play': res = this._play(pid, action); break;
      case 'draw': res = this._draw(pid); break;
      case 'pass': res = this._pass(pid); break;
      case 'challenge': res = this._challenge(pid); break;
      case 'uno': res = this._uno(pid); break;
      case 'catch': res = this._catch(pid, action.target); break;
      case 'timeout': res = this._timeout(pid); break;
      case 'mercy': res = this._mercy(pid); break;
      case 'jumpin': res = this._jumpIn(pid, action); break;
      default: return { ok: false, error: `Unknown action ${action.type}` };
    }
    if (res.ok) this._settle();
    return res;
  }

  _closeUnoWindow() {
    if (this.unoVulnerable !== null) {
      this.unoVulnerable = null;
      this.emit({ t: 'unoWindowClosed' });
    }
  }

  _play(pid, action) {
    if (pid !== this.current) return { ok: false, error: 'Not your turn' };
    const p = this.players[pid];
    const idx = p.hand.findIndex((c) => c.id === action.cardId);
    if (idx < 0) return { ok: false, error: 'Card not in hand' };
    const card = p.hand[idx];
    if (!this.canPlayCard(pid, card)) return { ok: false, error: 'Card cannot be played now' };

    let color = card.color;
    if (isWild(card)) {
      const allowed = this.allowedColors();
      color = allowed.includes(action.color) ? action.color : this._defaultColor(pid, card);
    }
    let target = null;
    if (this.needsTarget(card)) {
      target = action.target;
      if (target === undefined || target === null || target === pid || target < 0 || target >= this.n
        || this.players[target].out) {
        // Defaults: steal/destroy the biggest hand; a Seven swaps with the smallest.
        const seven = card.type === 'number';
        target = this.opponentsOf(pid).sort((a, b) => (seven ? a.hand.length - b.hand.length
          : b.hand.length - a.hand.length))[0].id;
      }
    }

    this._closeUnoWindow();
    const prevColor = this.activeColor;
    const wasPending = !!this.pending;
    const illegal = card.type === 'wild4' && (!wasPending || this.rules.stackChallenge)
      && p.hand.some((c) => c !== card && c.color === prevColor);

    p.hand.splice(idx, 1);
    this.discard.push(card);
    this.drawnCard = null;
    if (action.sayUno) p.saidUno = true;
    this.activeColor = color;
    this.stats.cardsPlayed++;
    this.emit({ t: 'play', p: pid, id: card.id, card: { ...card }, color, prevColor, target, jump: !!action.jump });

    // UNO call bookkeeping
    if (p.hand.length === 1) {
      if (p.saidUno) this.emit({ t: 'uno', p: pid });
      else { this.unoVulnerable = pid; this.emit({ t: 'unoMissed', p: pid }); }
    }
    p.saidUno = false;

    const out = p.hand.length === 0;
    if (!out && this.mode === 'chaos') {
      const gain = Math.round((METER_GAIN[card.type] || 0) * this.meterScale * (1 + Math.min(0.5, 0.05 * this.chaosLevel)));
      if (gain) { this.meter = Math.min(100, this.meter + gain); this.emit({ t: 'meter', value: this.meter }); }
    }

    const histEntry = { t: 'play', p: pid, card: { ...card }, prevColor, color, stacked: wasPending, jump: !!action.jump, turn: this.turn };
    this.history.push(histEntry);

    if (!out || FINISHING_EFFECTS.has(card.type)) this._effect(pid, card, target, illegal, prevColor);
    histEntry.next = this.current;
    if (this.phase !== 'turn') return { ok: true };

    if (out) {
      // Final penalty still lands (it counts towards the winner's score).
      if (this.pending && this.phase === 'turn') {
        const victim = this.current;
        const amt = this.pending.amount;
        this.pending = null;
        this._drawCards(victim, amt, 'penalty');
      }
      this._win(pid);
      return { ok: true };
    }

    if (this.mode === 'chaos' && this.meter >= 100 && this.phase === 'turn') {
      this.meter = 0;
      this.emit({ t: 'meter', value: 0 });
      this._triggerChaos();
    }
    this._checkWinAny(pid);
    return { ok: true };
  }

  _defaultColor(pid, exclude) {
    const allowed = this.allowedColors();
    const counts = Object.fromEntries(allowed.map((c) => [c, 0]));
    for (const c of this.players[pid].hand) if (c !== exclude && counts[c.color] !== undefined) counts[c.color]++;
    return allowed.reduce((a, b) => (counts[b] > counts[a] ? b : a), allowed[0]);
  }

  _effect(pid, card, target, illegal, prevColor) {
    const m = this.penaltyMult();
    switch (card.type) {
      case 'number':
        if (this.rules.sevenO && card.value === 7) this._sevenSwap(pid, target);
        else if (this.rules.sevenO && card.value === 0) this._zeroRotate();
        this._advance(1);
        break;
      case 'wild':
        this._advance(1);
        break;
      case 'skip':
        this.emit({ t: 'skip', p: this.nextIndex(1) });
        this._advance(2);
        break;
      case 'reverse':
        this.direction *= -1;
        this.emit({ t: 'direction', dir: this.direction });
        if (this.activeCount() === 2) { this.emit({ t: 'skip', p: this.nextIndex(1) }); this._advance(2); }
        else this._advance(1);
        break;
      case 'draw2':
      case 'wild4':
      case 'plus10': {
        const stacked = !!this.pending;
        if (!this.pending) this.pending = { amount: 0, kind: card.type, attacker: pid };
        this.pending.amount += DRAW_VALUE[card.type] * m;
        if (this.mode === 'chaos') this.pending.amount = Math.min(this.stackCap, this.pending.amount);
        this.pending.kind = card.type;
        this.pending.attacker = pid;
        this.pending.challengeable = card.type === 'wild4' && (!stacked || this.rules.stackChallenge);
        this.pending.illegal = illegal;
        this.pending.prevColor = prevColor;
        this.stats.maxStack = Math.max(this.stats.maxStack, this.pending.amount);
        this.emit({ t: 'pending', amount: this.pending.amount, kind: card.type, stacked });
        this._advance(1);
        break;
      }
      case 'mirror':
        if (this.pending) {
          const att = this.pending.attacker;
          this.pending.attacker = pid;
          this.pending.challengeable = false;
          this.pending.illegal = false;
          const to = this.players[att].out ? this.nextIndex(1) : att;
          this.emit({ t: 'mirror', p: pid, to, amount: this.pending.amount });
          this.emit({ t: 'pending', amount: this.pending.amount, kind: this.pending.kind, stacked: true });
          this._setTurn(to);
        } else this._advance(1);
        break;
      case 'everyone4':
        for (const o of this.opponentsOf(pid)) this._drawCards(o.id, 4 * m, 'everyone4');
        this._advance(1);
        break;
      case 'laststand':
        for (const o of this.opponentsOf(pid)) this._drawCards(o.id, 5 * m, 'laststand');
        this._advance(1);
        break;
      case 'ultreverse':
        this.direction *= -1;
        this.emit({ t: 'direction', dir: this.direction });
        this.emit({ t: 'skip', p: this.nextIndex(1) });
        this._advance(2);
        break;
      case 'steal3': {
        const t = this.players[target];
        const k = Math.min(3, Math.max(0, t.hand.length - 2));
        const ids = this._takeRandom(t, k);
        this.players[pid].hand.push(...ids.map((id) => this.card(id)));
        this.emit({ t: 'transfer', from: target, to: pid, ids, reason: 'steal3' });
        this.history.push({ t: 'transfer', from: target, to: pid, n: ids.length });
        this._advance(1);
        break;
      }
      case 'destroyer': {
        const t = this.players[target];
        const k = Math.min(3, Math.max(0, t.hand.length - 2));
        const ids = this._takeRandom(t, k);
        const topCard = this.discard.pop();
        this.discard.push(...ids.map((id) => this.card(id)), topCard);
        this.emit({ t: 'destroy', p: target, ids });
        this.history.push({ t: 'destroy', p: target, cards: ids.map((id) => ({ ...this.card(id) })) });
        this._advance(1);
        break;
      }
      case 'colorlock':
        this.effects.lock = { color: this.activeColor, turns: 2 * this.activeCount() };
        this.emit({ t: 'effect', key: 'lock', color: this.activeColor });
        this._advance(1);
        break;
      case 'chaoswild':
        this._advance(1);
        this._triggerChaos();
        break;
      case 'shufflehands': {
        const pool = this.shuffle(this.active().flatMap((pl) => pl.hand));
        for (const pl of this.active()) pl.hand = [];
        let i = this.nextIndex(1);
        for (const c of pool) { this.players[i].hand.push(c); i = this.nextIndex(1, i); }
        this.emit({ t: 'handsChanged', reason: 'shufflehands' });
        this.history.push({ t: 'handsMixed' });
        this._clearStaleUno();
        this._advance(1);
        break;
      }
      default:
        this._advance(1);
    }
  }

  _sevenSwap(pid, target) {
    const a = this.players[pid];
    const b = this.players[target];
    [a.hand, b.hand] = [b.hand, a.hand];
    this.stats.swaps++;
    this.emit({ t: 'handsChanged', reason: 'seven', a: pid, b: target });
    this.history.push({ t: 'handsMixed', players: [pid, target], reason: 'seven' });
    this._clearStaleUno();
  }

  // Every hand passes to the next player in the direction of play.
  _zeroRotate() {
    const alive = this.active();
    const hands = new Map(alive.map((p) => [p.id, p.hand]));
    for (const p of alive) this.players[this.nextIndex(1, p.id)].hand = hands.get(p.id);
    this.stats.swaps++;
    this.emit({ t: 'handsChanged', reason: 'zero', dir: this.direction });
    this.history.push({ t: 'handsMixed', reason: 'zero' });
    this._clearStaleUno();
  }

  _jumpIn(pid, action) {
    const card = this.players[pid].hand.find((c) => c.id === action.cardId);
    if (!this.canJumpIn(pid, card)) return { ok: false, error: 'Cannot jump in with that card' };
    const from = this.current;
    this.current = pid; // the jumper takes control of the turn
    this.drawnCard = null;
    this.stats.jumpIns++;
    this.emit({ t: 'jumpIn', p: pid, from, id: card.id });
    this.history.push({ t: 'jumpIn', p: pid, from });
    return this._play(pid, { ...action, jump: true });
  }

  _takeRandom(player, k) {
    const ids = [];
    for (let i = 0; i < k; i++) {
      const j = Math.floor(this.rng() * player.hand.length);
      ids.push(player.hand.splice(j, 1)[0].id);
    }
    return ids;
  }

  _draw(pid) {
    if (pid !== this.current) return { ok: false, error: 'Not your turn' };
    if (this.pending) {
      const amt = this.pending.amount;
      this.pending = null;
      this._closeUnoWindow();
      this._drawCards(pid, amt, 'penalty');
      this.history.push({ t: 'draw', p: pid, n: amt, voluntary: false, turn: this.turn });
      this.emit({ t: 'pendingResolved' });
      this._advance(1);
      return { ok: true };
    }
    if (this.drawnCard !== null) return { ok: false, error: 'Already drew this turn' };
    this._closeUnoWindow();
    // Draw one card — or, with Draw Until Playable, keep going until one fits.
    const limit = this.rules.drawUntilPlayable ? 60 : 1;
    let c = null;
    let drawn = 0;
    for (let i = 0; i < limit; i++) {
      const [id] = this._drawCards(pid, 1, 'draw');
      drawn++;
      c = this.card(id);
      this.drawnCard = id;
      if (c && this.canPlayCard(pid, c)) break;
      c = null;
    }
    this.history.push({ t: 'draw', p: pid, n: drawn, voluntary: true, activeColor: this.activeColor,
      top: { ...this.top() }, turn: this.turn });
    if (c) {
      this.emit({ t: 'drawnPlayable', p: pid, id: c.id, forced: this.rules.forcePlay });
    } else {
      this.drawnCard = null;
      this._advance(1);
    }
    return { ok: true };
  }

  _pass(pid) {
    if (pid !== this.current) return { ok: false, error: 'Not your turn' };
    if (this.drawnCard === null) return { ok: false, error: 'You can only pass after drawing' };
    if (this.rules.forcePlay) return { ok: false, error: 'Force Play: the drawn card must be played' };
    this._closeUnoWindow();
    this.drawnCard = null;
    this.history.push({ t: 'pass', p: pid, turn: this.turn });
    this._advance(1);
    return { ok: true };
  }

  _challenge(pid) {
    if (!this.canChallenge(pid)) return { ok: false, error: 'Nothing to challenge' };
    this._closeUnoWindow();
    const off = this.pending.attacker;
    const amt = this.pending.amount;
    const guilty = this.pending.illegal;
    this.pending = null;
    this.stats.challenges++;
    this.emit({ t: 'challenge', p: pid, target: off, success: guilty });
    this.emit({ t: 'pendingResolved' });
    this.history.push({ t: 'challenge', p: pid, target: off, success: guilty, turn: this.turn });
    if (guilty) {
      this._drawCards(off, amt, 'challenge');
      // Challenger keeps their turn and plays normally.
    } else {
      this._drawCards(pid, amt + 2, 'challenge');
      this._advance(1);
    }
    return { ok: true };
  }

  _uno(pid) {
    const p = this.players[pid];
    if (this.unoVulnerable === pid && p.hand.length === 1) {
      this.unoVulnerable = null;
      this.emit({ t: 'uno', p: pid, late: true });
      return { ok: true };
    }
    if (pid === this.current && p.hand.length === 2) {
      p.saidUno = true;
      this.emit({ t: 'unoArmed', p: pid });
      return { ok: true };
    }
    return { ok: false, error: 'Cannot call UNO now' };
  }

  _catch(pid, target) {
    if (this.unoVulnerable === null || this.unoVulnerable !== target || target === pid) {
      return { ok: false, error: 'Nobody to catch' };
    }
    this.unoVulnerable = null;
    this.emit({ t: 'caught', p: target, by: pid });
    this.history.push({ t: 'caught', p: target, by: pid });
    this._drawCards(target, 2, 'caught');
    return { ok: true };
  }

  _mercy(pid) {
    if (!this.canCallMercy(pid)) return { ok: false, error: 'Mercy cannot be called now' };
    const targets = this.mercyTargets();
    const pool = [];
    for (const t of targets) {
      const p = this.players[t];
      p.out = true;
      pool.push(...p.hand);
      p.hand = [];
      if (this.unoVulnerable === t) this.unoVulnerable = null;
    }
    this.emit({ t: 'mercy', by: pid, out: targets });
    this.history.push({ t: 'mercy', by: pid, out: targets });
    for (const t of targets) this.history.push({ t: 'eliminated', p: t });
    const alive = this.active();
    if (alive.length === 1) {
      this.drawPile.unshift(...pool); // nobody left to deal to: cards go back in the deck
      this._win(alive[0].id, 'lastStanding');
      return { ok: true };
    }
    // Deal the knocked-out players' cards evenly, starting after the caller.
    this.shuffle(pool);
    const given = new Map();
    let i = this.nextIndex(1, pid);
    for (const c of pool) {
      this.players[i].hand.push(c);
      given.set(i, [...(given.get(i) || []), c.id]);
      i = this.nextIndex(1, i);
    }
    for (const [to, ids] of given) {
      this.emit({ t: 'transfer', from: null, to, ids, reason: 'mercy' });
      this.history.push({ t: 'transfer', from: null, to, n: ids.length });
    }
    if (this.pending && this.players[this.pending.attacker].out) this.pending.attacker = this.nextIndex(1, this.pending.attacker);
    if (this.players[this.current].out) {
      // The stack dies with a knocked-out player; play moves on.
      if (this.pending) { this.pending = null; this.emit({ t: 'pendingResolved' }); }
      this.drawnCard = null;
    }
    this._clearStaleUno();
    return { ok: true };
  }

  _timeout(pid) {
    if (pid !== this.current || this.effects.crisis <= 0) return { ok: false, error: 'No timer running' };
    this._closeUnoWindow();
    const amt = 2 + (this.pending ? this.pending.amount : 0);
    const hadPending = !!this.pending;
    this.pending = null;
    this.drawnCard = null;
    this.emit({ t: 'timeout', p: pid, amount: amt });
    if (hadPending) this.emit({ t: 'pendingResolved' });
    this._drawCards(pid, amt, 'timeout');
    this.history.push({ t: 'draw', p: pid, n: amt, voluntary: false, turn: this.turn });
    this._advance(1);
    return { ok: true };
  }

  // ------------------------------------------------------------------ internals
  _drawCards(pid, n, reason) {
    const p = this.players[pid];
    const ids = [];
    if (p.out) return ids;
    if (this.mode === 'chaos') n = Math.min(n, this.overloadLimit - p.hand.length);
    for (let i = 0; i < n; i++) {
      if (this.drawPile.length === 0) this._reshuffle();
      if (this.drawPile.length === 0) this._addDeck();
      const c = this.drawPile.pop();
      p.hand.push(c);
      ids.push(c.id);
    }
    if (ids.length) this.emit({ t: 'draw', p: pid, ids, reason });
    if (this.unoVulnerable === pid && p.hand.length !== 1) this.unoVulnerable = null;
    this._overloadCheck(pid);
    return ids;
  }

  _overloadCheck(pid) {
    const p = this.players[pid];
    if (this.mode !== 'chaos' || p.out || p.hand.length < this.overloadLimit || this.phase !== 'turn') return;
    p.out = true;
    const ids = p.hand.map((c) => c.id);
    this.drawPile.unshift(...this.shuffle(p.hand));
    p.hand = [];
    if (this.unoVulnerable === pid) this.unoVulnerable = null;
    this.emit({ t: 'eliminated', p: pid, ids, reason: 'overload' });
    this.history.push({ t: 'eliminated', p: pid });
    const alive = this.active();
    if (alive.length === 1) { this._win(alive[0].id, 'lastStanding'); return; }
    if (this.pending && this.pending.attacker === pid) this.pending.attacker = this.nextIndex(1, pid);
    if (this.current === pid && this.pending) {
      // The stack dies with a knocked-out player; _settle() moves play on.
      this.pending = null;
      this.emit({ t: 'pendingResolved' });
    }
  }

  _reshuffle() {
    if (this.discard.length <= 1) return;
    const top = this.discard.pop();
    const rest = this.shuffle(this.discard);
    this.discard = [top];
    this.drawPile = rest.concat(this.drawPile);
    this.emit({ t: 'reshuffle', ids: rest.map((c) => c.id) });
    this.history.push({ t: 'reshuffle' });
  }

  _setTurn(idx) {
    this.current = idx;
    this.turn++;
    this.drawnCard = null;
    this._tickEffects();
    this.emit({ t: 'turn', p: this.current });
  }

  _advance(steps) { this._setTurn(this.nextIndex(steps)); }

  // Called after any action: if the current player was knocked out mid-turn, move on.
  _settle() {
    if (this.phase === 'turn' && this.players[this.current].out) this._advance(1);
  }

  _tickEffects() {
    const fx = this.effects;
    if (fx.apocalypse > 0 && --fx.apocalypse === 0) this.emit({ t: 'effectEnd', key: 'apocalypse' });
    if (fx.collapse && --fx.collapse.turns <= 0) { fx.collapse = null; this.emit({ t: 'effectEnd', key: 'collapse' }); }
    if (fx.lock && --fx.lock.turns <= 0) { fx.lock = null; this.emit({ t: 'effectEnd', key: 'lock' }); }
    if (fx.crisis > 0 && --fx.crisis === 0) this.emit({ t: 'effectEnd', key: 'crisis' });
    if (fx.storm > 0) {
      fx.storm--;
      if (!fx.lock) {
        const choices = this.allowedColors().filter((c) => c !== this.activeColor);
        if (choices.length) {
          this.activeColor = this.pick(choices);
          this.emit({ t: 'color', color: this.activeColor, reason: 'storm' });
          this.history.push({ t: 'color', color: this.activeColor });
        }
      }
      if (fx.storm === 0) this.emit({ t: 'effectEnd', key: 'storm' });
    }
  }

  _clearStaleUno() {
    if (this.unoVulnerable !== null && this.players[this.unoVulnerable].hand.length !== 1) this.unoVulnerable = null;
  }

  _triggerChaos(key = null, sub = false) {
    const keys = Object.keys(CHAOS_EVENTS);
    if (!key) {
      // Total Anarchy is rarer than the rest.
      key = this.rng() < 0.06 ? 'anarchy' : this.pick(keys.filter((k) => k !== 'anarchy'));
    }
    if (!sub) this.chaosLevel++;
    this.stats.chaosEvents++;
    this.emit({ t: 'chaosEvent', key, level: this.chaosLevel, sub });
    this.history.push({ t: 'chaosEvent', key });
    const fx = this.effects;
    const n = this.activeCount();
    switch (key) {
      case 'apocalypse':
        fx.apocalypse += n;
        break;
      case 'reverseReality': {
        this.direction *= -1;
        this.emit({ t: 'direction', dir: this.direction });
        const alive = this.active();
        const sizes = alive.map((p) => p.hand.length);
        const pool = this.shuffle(alive.flatMap((p) => p.hand));
        alive.forEach((p, i) => { p.hand = pool.splice(0, sizes[i]); });
        this.emit({ t: 'handsChanged', reason: 'reverseReality' });
        this.history.push({ t: 'handsMixed' });
        break;
      }
      case 'collapse': {
        const choices = COLORS.filter((c) => !fx.lock || c !== fx.lock.color);
        const n = this.activeCount();
        fx.collapse = { color: this.pick(choices), turns: n + 1 };
        this.emit({ t: 'effect', key: 'collapse', color: fx.collapse.color });
        break;
      }
      case 'heist': {
        const thief = this.pick(this.active());
        for (const o of this.opponentsOf(thief.id)) {
          const k = Math.min(this.randInt(1, 2), Math.max(0, o.hand.length - 1));
          if (!k) continue;
          const ids = this._takeRandom(o, k);
          thief.hand.push(...ids.map((id) => this.card(id)));
          this.emit({ t: 'transfer', from: o.id, to: thief.id, ids, reason: 'heist' });
          this.history.push({ t: 'transfer', from: o.id, to: thief.id, n: ids.length });
        }
        this.emit({ t: 'heist', p: thief.id });
        break;
      }
      case 'roulette': {
        const victim = this.pick(this.active());
        const k = this.randInt(0, 12);
        this.emit({ t: 'roulette', p: victim.id, amount: k });
        if (k) this._drawCards(victim.id, k, 'roulette');
        this.history.push({ t: 'draw', p: victim.id, n: k, voluntary: false });
        break;
      }
      case 'storm':
        fx.storm += n;
        break;
      case 'explosion':
        for (const p of this.active()) {
          if (this.phase !== 'turn') break;
          const k = this.randInt(3, 8);
          this._drawCards(p.id, k, 'explosion');
          this.history.push({ t: 'draw', p: p.id, n: k, voluntary: false });
        }
        break;
      case 'crisis':
        fx.crisis += 2 * n;
        break;
      case 'swap': {
        const a = this.pick(this.active());
        const b = this.pick(this.active().filter((p) => p !== a));
        [a.hand, b.hand] = [b.hand, a.hand];
        this.emit({ t: 'handsChanged', reason: 'swap', a: a.id, b: b.id });
        this.history.push({ t: 'handsMixed', players: [a.id, b.id] });
        break;
      }
      case 'anarchy': {
        const pool = this.shuffle(keys.filter((k) => k !== 'anarchy')).slice(0, 3);
        for (const k of pool) if (this.phase === 'turn') this._triggerChaos(k, true);
        break;
      }
      default:
        break;
    }
    this._clearStaleUno();
  }

  _checkWinAny(preferred) {
    if (this.phase !== 'turn') return;
    const empty = this.players.filter((p) => !p.out && p.hand.length === 0);
    if (!empty.length) return;
    const w = empty.find((p) => p.id === preferred) || empty[0];
    this._win(w.id);
  }

  _win(pid, how = 'out') {
    if (this.phase === 'gameover') return;
    this.phase = 'gameover';
    this.winner = pid;
    this.winHow = how;
    this.pending = null;
    this.unoVulnerable = null;
    this.roundScore = this.players.reduce(
      (sum, p) => sum + (p.id === pid ? 0 : p.out ? 50 : p.hand.reduce((s, c) => s + cardPoints(c), 0)), 0);
    this.history.push({ t: 'win', p: pid });
    this.emit({ t: 'win', p: pid, score: this.roundScore, how });
  }

  // Sanity check used by tests: every card is in exactly one place.
  checkIntegrity() {
    const seen = new Set();
    const add = (c, where) => {
      if (!c) throw new Error(`Undefined card in ${where}`);
      if (seen.has(c.id)) throw new Error(`Card ${c.id} duplicated (${where})`);
      seen.add(c.id);
    };
    this.drawPile.forEach((c) => add(c, 'drawPile'));
    this.discard.forEach((c) => add(c, 'discard'));
    this.players.forEach((p) => p.hand.forEach((c) => add(c, `hand ${p.id}`)));
    if (seen.size !== this.cards.size) throw new Error(`Card count mismatch ${seen.size} vs ${this.cards.size}`);
    return true;
  }
}

export { CARD_TYPES };
