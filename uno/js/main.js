// Game controller. Owns the match flow and wires engine, AI, renderer, audio and UI.
//
// Concurrency model: every action — your clicks, AI turns, and out-of-turn plays
// (Jump-In, UNO catches, Mercy) — goes through submit(), which applies it to the
// engine and plays its animations strictly one at a time. Each applied action bumps
// `version`; timers scheduled for an older version silently expire. That makes
// overlapping turns or half-finished animations impossible.

import { UnoGame, DEFAULT_RULES, CHAOS_EVENTS } from './engine.js';
import { AIPlayer, PERSONALITIES } from './ai.js';
import { Renderer } from './render.js';
import { HeroFX } from './hero.js';
import { AudioSystem } from './audio.js';
import { UI, AI_ROSTER } from './ui.js';
import { CARD_TYPES, COLOR_HEX, COLOR_NAMES, cardLabel, isWild } from './cards.js';

const HUMAN = 0;

// ------------------------------------------------------------------ persistence
const store = {
  get(key, def) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...structuredClone(def), ...JSON.parse(raw) } : structuredClone(def);
    } catch { return structuredClone(def); }
  },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable */ } },
};
const settings = store.get('uno.settings', {
  master: 0.8, sfx: 0.9, ambience: 0.45, music: 0.4, voice: true,
  quality: 'auto', speed: 1, shake: true, hints: true,
});
// v2: older saves defaulted to a fixed 'high' quality, which lagged on many machines.
if (!settings.v2) { settings.quality = 'auto'; settings.v2 = true; store.set('uno.settings', settings); }
const profile = store.get('uno.profile', { name: 'You', avatar: '😎', cardBack: 'classic', felt: null });
let stats = store.get('uno.stats', {
  games: 0, wins: 0, byMode: {}, bestScore: 0, streak: 0, bestStreak: 0, matches: 0, matchesWon: 0,
  longestStack: 0, chaosEvents: 0, jumpIns: 0, unoCalls: 0, caught: 0, history: [],
});
const setup = store.get('uno.setup', {
  mode: 'standard', rules: { ...DEFAULT_RULES }, opponents: [{ personality: 'random' }, { personality: 'random' }, { personality: 'random' }],
  difficulty: 'normal', env: 'casino', matchTo: 500,
});
setup.rules = { ...DEFAULT_RULES, ...setup.rules };

// ------------------------------------------------------------------ systems
const ui = new UI();
const audio = new AudioSystem();
audio.setVolumes(settings);
audio.voice = settings.voice;
let renderer;
let heroFX;

// ------------------------------------------------------------------ match state
let game = null;
let ais = [];
let match = null;
let version = 0;
let roundToken = 0;
let timers = [];
let waiters = [];
let busy = Promise.resolve();
let paused = false;
let humanChoosing = false;
let crisis = null;
let thinking = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spd = () => settings.speed || 1;
const nameOf = (pid) => (game ? game.players[pid].name : '');
const you = (pid) => pid === HUMAN;

function addTimer(fn, ms, v) {
  const id = setTimeout(function run() {
    timers = timers.filter((t) => t !== id);
    if (v !== version || !game || game.phase !== 'turn') return;
    if (paused || humanChoosing) { const again = setTimeout(run, 300); timers.push(again); return; }
    fn();
  }, ms);
  timers.push(id);
}
function clearTimers() { timers.forEach(clearTimeout); timers = []; }
function notify() { const w = waiters; waiters = []; w.forEach((r) => r()); }
const waitChange = () => new Promise((r) => waiters.push(r));

// Apply one action and present it. Serialized through `busy`.
function submit(action) {
  const token = roundToken;
  const p = busy.then(async () => {
    if (token !== roundToken || !game || game.phase !== 'turn') return false;
    const res = game.apply(action);
    if (!res.ok) return false;
    version++;
    clearTimers();
    stopCrisis();
    thinking = null;
    renderer.setInteractive({ playable: new Set(), jumpable: new Set(), myTurn: false });
    ui.setActions({});
    await present(game.drainEvents());
    // A short beat after an opponent's move so you can see what happened.
    if (action.player !== HUMAN && (action.type === 'play' || action.type === 'jumpin')) await sleep(350 / spd());
    if (token === roundToken) notify();
    return true;
  });
  busy = p.catch((e) => console.error(e));
  return p;
}

// ------------------------------------------------------------------ round flow
async function startMatch() {
  const persKeys = Object.keys(PERSONALITIES);
  match = {
    setup: structuredClone(setup),
    personalities: setup.opponents.map((o) => (o.personality === 'random' ? persKeys[Math.floor(Math.random() * persKeys.length)] : o.personality)),
    totals: new Array(setup.opponents.length + 1).fill(0),
    round: 0,
    dealer: Math.floor(Math.random() * (setup.opponents.length + 1)),
  };
  stats.matches++;
  store.set('uno.stats', stats);
  await playRound();
}

async function playRound() {
  const token = ++roundToken;
  clearTimers();
  paused = false;
  match.round++;
  const S = match.setup;
  const players = [{ name: profile.name, avatar: profile.avatar, isHuman: true, color: '#e2262f' }];
  S.opponents.forEach((o, i) => {
    const r = AI_ROSTER[i];
    players.push({ name: r.name, avatar: r.avatar, color: r.color, personality: match.personalities[i], difficulty: S.difficulty });
  });
  game = new UnoGame({ mode: S.mode, rules: S.rules, players });
  ais = players.map((p, i) => (i === HUMAN ? null : new AIPlayer(i, p.personality, p.difficulty)));

  ui.show('hud');
  ui.clearLog();
  ui.clearLastPlay();
  ui.closeModals();
  ui.buildSeats(game.players, HUMAN);
  ui.setChips(S.mode, S.matchTo ? `Round ${match.round} · to ${S.matchTo}` : 'Single round');
  ui.setChaosLook(S.mode === 'chaos', 0.15);
  ui.setPending(0);
  ui.setActions({});
  renderer.idle = false;
  heroFX.clear();
  renderer.glowCards.clear();
  renderer.clearCards();
  renderer.setEnvironment(S.env, profile.felt);
  renderer.setupSeats(game.players, HUMAN);
  renderer.setChaos(S.mode === 'chaos' ? 0.12 : 0);
  renderer.focus('reset', 1.4);
  audio.setAmbience(S.env);
  if (S.mode === 'chaos') audio.setChaos(0.1); else audio.stopChaos();

  match.dealer = (match.dealer + 1) % game.n;
  game.start(match.dealer);
  await presentDeal(game.drainEvents(), token);
  if (token !== roundToken) return;
  ui.log(game.current === HUMAN ? 'You go first' : `${nameOf(game.current)} goes first`);
  while (token === roundToken && game.phase === 'turn') {
    await busy;
    if (token !== roundToken || game.phase !== 'turn') break;
    schedule(version);
    await waitChange();
  }
  if (token === roundToken && game.phase === 'gameover') await endRound(token);
}

async function presentDeal(events, token) {
  const all = [...game.cards.values()];
  renderer.game = game;
  all.forEach((c) => renderer.ensureCard(c));
  ui.updateSeats(game);
  await sleep(500);
  audio.shuffle();
  await renderer.animateShuffle({ drawPile: all, cards: game.cards, discard: [], players: [] });
  await sleep(150);
  const deal = events.find((e) => e.t === 'deal');
  const flip = events.find((e) => e.t === 'flip');
  const order = deal ? deal.order.map((o) => o.id) : [];
  order.forEach((_, i) => audio.deal(i * 0.045 / spd()));
  await renderer.sync(game, { focus: [...order, flip.id], stagger: 0.045, flight: 0.42 });
  if (token !== roundToken) return;
  audio.flip();
  renderer.setActiveColor(game.activeColor);
  renderer.setDirection(game.direction);
  renderer.setTurn(game.current);
  updateHUD();
}

// Plan everything that may happen at this exact state: the current player's move
// and any out-of-turn opportunities for every other player.
function schedule(v) {
  const cur = game.current;
  updateHUD();
  const vuln = game.unoVulnerable;
  // UNO catches
  if (vuln !== null) {
    for (const ai of ais) {
      if (!ai || !game.canCatch(ai.pid, vuln)) continue;
      if (ai.wantsToCatch()) addTimer(() => submit({ type: 'catch', player: ai.pid, target: vuln }), ai.catchDelay(), v);
    }
    if (vuln !== HUMAN && ais[vuln]) {
      const save = { easy: 0.15, normal: 0.35, hard: 0.6, expert: 0.9 }[ais[vuln].difficulty];
      if (Math.random() < save) addTimer(() => submit({ type: 'uno', player: vuln }), 350 + Math.random() * 900, v);
    }
  }
  // Mercy
  if (game.mercyTargets().length) {
    for (const ai of ais) {
      if (!ai || !game.canCallMercy(ai.pid)) continue;
      if (ai.wantsMercy(game.publicView(ai.pid))) addTimer(() => submit({ type: 'mercy', player: ai.pid }), ai.catchDelay() * 1.3, v);
    }
  }
  // Jump-Ins
  for (const ai of ais) {
    if (!ai || ai.pid === cur || game.players[ai.pid].out) continue;
    const a = ai.decideJumpIn(game.publicView(ai.pid));
    if (a) addTimer(() => submit(a), ai.jumpDelay() / Math.sqrt(spd()), v);
  }
  // The current player
  if (cur === HUMAN) humanTurn(v);
  else {
    const ai = ais[cur];
    thinking = cur;
    let t = ai.reactionTime(game.publicView(cur)) / Math.sqrt(spd());
    if (vuln !== null) t = Math.max(t, 1500);
    addTimer(() => {
      const view = game.publicView(cur);
      const action = ai.decide(view);
      submit(action).then((ok) => {
        if (!ok && game && game.phase === 'turn' && game.current === cur) {
          submit({ type: game.drawnCard !== null && !game.rules.forcePlay ? 'pass' : 'draw', player: cur });
        }
      });
    }, t, v);
    refreshHumanOutOfTurn();
  }
  ui.updateSeats(game, { thinking });
}

function humanTurn(v) {
  thinking = null;
  const legal = new Set(game.legalPlays(HUMAN));
  renderer.setInteractive({ playable: legal, jumpable: new Set(), myTurn: true, hints: settings.hints });
  if (game.effects.crisis > 0) startCrisis(v);
  refreshHumanActions();
}

function refreshHumanOutOfTurn() {
  if (!game || game.phase !== 'turn' || game.current === HUMAN) return;
  const jump = new Set(game.jumpInOptions(HUMAN));
  renderer.setInteractive({ playable: new Set(), jumpable: jump, myTurn: false, hints: settings.hints });
  refreshHumanActions();
}

// "Play a Blue card or a 2 — or draw": exactly what the human can do right now.
function matchHint() {
  const top = game.top();
  const color = COLOR_NAMES[game.activeColor];
  const sym = top && !isWild(top) ? (top.type === 'number' ? `a ${top.value}` : `a ${CARD_TYPES[top.type].label}`) : '';
  const n = game.legalPlays(HUMAN).length;
  const what = `Play a ${color} card${sym ? ` or ${sym}` : ''}`;
  return n ? `${what} (${n} playable) · or draw` : `No playable card — click the deck to draw`;
}

function refreshHumanActions() {
  if (!game || game.phase !== 'turn') { ui.setActions({}); return; }
  const me = game.players[HUMAN];
  const mine = game.current === HUMAN && !me.out;
  const vuln = game.unoVulnerable;
  const a = {};
  if (mine) {
    if (game.drawnCard !== null) {
      a.keep = !game.rules.forcePlay;
      a.hint = game.rules.forcePlay ? 'Force Play: you must play the card you drew' : 'Play the card you drew, or keep it';
    } else {
      a.draw = true;
      a.drawText = game.pending ? `Draw ${game.pending.amount}` : 'Draw';
      a.challenge = game.canChallenge(HUMAN);
      a.hint = game.pending ? (game.legalPlays(HUMAN).length ? 'Stack a matching card, or take the penalty' : 'You must take the penalty')
        : matchHint();
    }
    a.uno = me.hand.length === 2 && !me.saidUno && (game.legalPlays(HUMAN).length > 0);
  } else if (!me.out) {
    const j = game.jumpInOptions(HUMAN).length;
    a.hint = j ? 'You hold an identical card: click it to JUMP IN!' : `${nameOf(game.current)} is playing…`;
  }
  if (vuln === HUMAN) { a.uno = true; a.unoUrgent = true; }
  if (vuln !== null && game.canCatch(HUMAN, vuln)) { a.catch = true; a.catchText = `Catch ${nameOf(vuln)}!`; }
  if (game.canCallMercy(HUMAN)) {
    const [one, big] = game.mercyTargets();
    a.mercy = true;
    a.mercyText = `MERCY! (${nameOf(one)} & ${nameOf(big)})`;
  }
  ui.setActions(a);
}

// ------------------------------------------------------------------ Time Crisis
function startCrisis(v) {
  stopCrisis();
  const total = 5;
  const t0 = performance.now();
  let lastSec = 6;
  crisis = setInterval(() => {
    if (paused) return;
    const left = total - (performance.now() - t0) / 1000;
    ui.setTimer(Math.max(0, left), total);
    if (Math.ceil(left) < lastSec) { lastSec = Math.ceil(left); if (left > 0) audio.tick(); }
    if (left <= 0) {
      stopCrisis();
      ui.closeModals();
      humanChoosing = false;
      if (v === version) submit({ type: 'timeout', player: HUMAN });
    }
  }, 100);
}
function stopCrisis() { if (crisis) clearInterval(crisis); crisis = null; ui.setTimer(null); }

// ------------------------------------------------------------------ human input
async function onHumanCard(id, invalid) {
  audio.unlock();
  if (!game || game.phase !== 'turn' || paused || humanChoosing) return;
  const card = game.card(id);
  const v = version;
  const isTurn = game.current === HUMAN && game.legalPlays(HUMAN).includes(id);
  const isJump = !isTurn && game.canJumpIn(HUMAN, card);
  if (invalid || (!isTurn && !isJump)) {
    if (game.current === HUMAN) {
      audio.error();
      if (game.drawnCard !== null) ui.toast('You can only play the card you just drew');
      else if (game.pending) ui.toast(`Stack a ${game.mode === 'chaos' ? 'draw card or Mirror' : CARD_TYPES[game.pending.kind].label} or draw ${game.pending.amount}`);
      else ui.toast(`That card doesn't match ${COLOR_NAMES[game.activeColor]} / the top card`);
    }
    return;
  }
  const action = { type: isTurn ? 'play' : 'jumpin', player: HUMAN, cardId: id };
  const lastCard = game.players[HUMAN].hand.length === 1;
  humanChoosing = true;
  try {
    if (isWild(card)) {
      const allowed = game.allowedColors();
      action.color = allowed.length === 1 ? allowed[0] : await ui.chooseColor(allowed);
    }
    if (game.needsTarget(card) && !lastCard) {
      const seven = card.type === 'number';
      const opts = game.opponentsOf(HUMAN).map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, count: p.hand.length }));
      action.target = await ui.chooseTarget(
        seven ? 'Seven! Swap hands with…' : card.type === 'steal3' ? 'Steal three cards from…' : 'Destroy three cards of…', opts);
    }
  } finally { humanChoosing = false; }
  if (v !== version || !game || game.phase !== 'turn') { ui.toast('Too slow — the table moved on!'); return; }
  submit(action);
}

function humanDraw() {
  audio.unlock();
  if (!game || game.phase !== 'turn' || game.current !== HUMAN || paused || humanChoosing) return;
  if (game.drawnCard !== null) { ui.toast(game.rules.forcePlay ? 'Force Play: play the card you drew' : 'Play the drawn card or keep it'); return; }
  submit({ type: 'draw', player: HUMAN });
}

function bindHud() {
  const on = (id, fn) => { document.getElementById(id).onclick = () => { audio.unlock(); audio.click(); fn(); }; };
  on('btn-draw', humanDraw);
  on('btn-keep', () => submit({ type: 'pass', player: HUMAN }));
  on('btn-challenge', () => submit({ type: 'challenge', player: HUMAN }));
  on('btn-uno', () => submit({ type: 'uno', player: HUMAN }));
  on('btn-catch', () => game && game.unoVulnerable !== null && submit({ type: 'catch', player: HUMAN, target: game.unoVulnerable }));
  on('btn-mercy', () => submit({ type: 'mercy', player: HUMAN }));
  on('pause-btn', pause);
  on('resume-btn', resume);
  on('quit-btn', () => { resume(); goMenu(); });
  on('pause-settings', async () => { document.getElementById('modal-pause').classList.add('hidden'); await ui.overlay('settings'); document.getElementById('modal-pause').classList.remove('hidden'); });
  on('pause-rules', async () => { document.getElementById('modal-pause').classList.add('hidden'); await ui.overlay('modes'); document.getElementById('modal-pause').classList.remove('hidden'); });
  window.addEventListener('keydown', (e) => {
    if (ui.current !== 'hud' || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') { paused ? resume() : pause(); }
    if (paused) return;
    if (k === 'd' || k === ' ') { e.preventDefault(); humanDraw(); }
    if (k === 'u') submit({ type: 'uno', player: HUMAN });
    if (k === 'k' && game && game.drawnCard !== null) submit({ type: 'pass', player: HUMAN });
    if (k === 'c' && game && game.canChallenge(HUMAN)) submit({ type: 'challenge', player: HUMAN });
  });
}

function pause() {
  if (!game || game.phase !== 'turn' || paused) return;
  paused = true;
  document.getElementById('modal-pause').classList.remove('hidden');
}
function resume() {
  if (!paused) return;
  paused = false;
  document.getElementById('modal-pause').classList.add('hidden');
  clearTimers();
  stopCrisis();
  notify(); // reschedule from the current state
}

// ------------------------------------------------------------------ developer panel
// Toggle with the ` key (or the 🛠 button when the URL contains ?dev). Lets you give
// yourself any card, fire any Chaos event and take the turn, to test every card.
const DEV_COLORS = ['red', 'yellow', 'green', 'blue'];
function devRun(fn, label) {
  if (!game || game.phase !== 'turn') { ui.toast('Start a game first'); return; }
  busy = busy.then(async () => {
    if (!game || game.phase !== 'turn') return;
    fn(game);
    version++;
    clearTimers();
    stopCrisis();
    ui.log(`🛠 ${label}`);
    await present(game.drainEvents());
    await renderer.sync(game, { dur: 0.3 });
    notify();
  }).catch((e) => console.error(e));
}
function devGive(type, color, value = null) {
  devRun((g) => {
    const card = { id: g._nextId++, color: CARD_TYPES[type].wild ? 'wild' : color, type, value };
    g.cards.set(card.id, card);
    const me = g.players[HUMAN];
    if (CARD_TYPES[type].hero) me.heroUsed = null; // testing: allow another hero
    (me.stash || me.hand).push(card);
  }, `Gave you ${cardLabel({ type, color: CARD_TYPES[type].wild ? 'wild' : color, value })}`);
}
function buildDevPanel() {
  const el = document.getElementById('dev-panel');
  const types = Object.keys(CARD_TYPES).filter((t) => t !== 'number');
  const btn = (txt, act, cls = '') => `<button class="${cls}" data-act="${act}">${txt}</button>`;
  el.innerHTML = `
    <header><b>🛠 Developer</b><button data-act="close">✕</button></header>
    <label>Color <select id="dev-color">${DEV_COLORS.map((c) => `<option>${c}</option>`).join('')}</select></label>
    <h4>Numbers</h4><div class="dev-grid">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((v) => btn(v, `num:${v}`)).join('')}</div>
    <h4>Action &amp; wild cards</h4><div class="dev-grid">${types.filter((t) => !CARD_TYPES[t].chaos).map((t) => btn(CARD_TYPES[t].label, `card:${t}`)).join('')}</div>
    <h4>Chaos cards</h4><div class="dev-grid">${types.filter((t) => CARD_TYPES[t].chaos && !CARD_TYPES[t].hero).map((t) => btn(CARD_TYPES[t].label, `card:${t}`, 'chaos')).join('')}</div>
    <h4>HERO cards</h4><div class="dev-grid">${types.filter((t) => CARD_TYPES[t].hero).map((t) => btn(CARD_TYPES[t].label, `card:${t}`, 'hero')).join('')}</div>
    <h4>Chaos events</h4><div class="dev-grid">${Object.entries(CHAOS_EVENTS).map(([k, e]) => btn(e.name, `event:${k}`, 'chaos')).join('')}</div>
    <h4>Table</h4><div class="dev-grid">
      ${btn('My turn now', 'myturn')}${btn('Fill Chaos Meter', 'meter')}${btn('Clear draw stack', 'nopending')}
      ${btn('Give me 5 random', 'rand5')}${btn('Leave me 2 cards', 'two')}${btn('Opponents to 1 card', 'opp1')}</div>
    <p class="dev-note">Chaos cards, events and HERO cards only work in Chaos Mode games.</p>`;
  el.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const [kind, arg] = b.dataset.act.split(':');
    const color = document.getElementById('dev-color').value;
    if (kind === 'close') return toggleDev(false);
    if (kind === 'num') return devGive('number', color, +arg);
    if (kind === 'card') {
      if (CARD_TYPES[arg].chaos && game && game.mode !== 'chaos') return ui.toast('That card needs a Chaos Mode game');
      return devGive(arg, color);
    }
    if (kind === 'event') {
      if (game && game.mode !== 'chaos') return ui.toast('Chaos events need a Chaos Mode game');
      return devRun((g) => g._triggerChaos(arg), `Triggered ${CHAOS_EVENTS[arg].name}`);
    }
    if (kind === 'myturn') return devRun((g) => { g.pending = null; g.drawnCard = null; g.current = HUMAN; g.emit({ t: 'pendingResolved' }); g.emit({ t: 'turn', p: HUMAN }); }, 'Took the turn');
    if (kind === 'meter') return devRun((g) => { g.meter = 99; g.emit({ t: 'meter', value: 99 }); }, 'Chaos Meter at 99%');
    if (kind === 'nopending') return devRun((g) => { g.pending = null; g.emit({ t: 'pendingResolved' }); }, 'Cleared the stack');
    if (kind === 'rand5') return devRun((g) => g._drawCards(HUMAN, 5, 'dev'), 'Drew 5');
    if (kind === 'two') return devRun((g) => { const h = g.players[HUMAN].hand; while (h.length > 2) g.drawPile.unshift(h.pop()); }, 'Hand cut to 2');
    if (kind === 'opp1') return devRun((g) => { for (const p of g.players) if (p.id !== HUMAN && !p.out) while (p.hand.length > 1) g.drawPile.unshift(p.hand.pop()); }, 'Opponents down to 1 card');
  };
}
function toggleDev(show) {
  const el = document.getElementById('dev-panel');
  if (!el.innerHTML) buildDevPanel();
  el.classList.toggle('hidden', show === undefined ? !el.classList.contains('hidden') : !show);
}

function goMenu() {
  roundToken++;
  clearTimers();
  stopCrisis();
  notify();
  game = null;
  paused = false;
  ui.closeModals();
  ui.setChaosLook(false);
  audio.stopChaos();
  renderer.setChaos(0);
  heroFX.clear();
  renderer.glowCards.clear();
  renderer.clearCards();
  showMenuScene();
  ui.show('menu');
}

// ------------------------------------------------------------------ presentation
function updateHUD() {
  if (!game) return;
  ui.updateSeats(game, { thinking });
  ui.updateTableInfo(game);
  ui.updateChaos(game);
  ui.setPending(game.pending ? game.pending.amount : 0, renderer.discardScreen());
  if (game.phase === 'turn') {
    const cur = game.current;
    const speed = game.players[cur].superSpeed > 0 ? ' · SUPER SPEED ⚡' : '';
    const nxt = game.nextIndex(1);
    const nextName = nxt === cur ? '' : nxt === HUMAN ? 'you' : nameOf(nxt);
    ui.setTurnBanner(cur === HUMAN ? (game.pending ? `Your turn · +${game.pending.amount} incoming!` : `Your turn${speed}`) : `${nameOf(cur)}'s turn${speed}`, cur === HUMAN, nextName);
    renderer.setTurn(cur);
  }
  if (game.mode === 'chaos') {
    const intensity = Math.min(1, 0.12 + game.chaosLevel * 0.09 + game.meter / 400);
    renderer.setChaos(intensity);
    audio.setChaos(intensity);
    ui.setChaosLook(true, intensity);
  }
}

const EVENT_SUBS = {
  seven: (e) => `${nameOf(e.a)} swapped hands with ${nameOf(e.b)}`,
  zero: () => 'Every hand passes along the direction of play',
  swap: (e) => `${nameOf(e.a)} and ${nameOf(e.b)} swapped hands`,
  reverseReality: () => 'All hands were redistributed',
  shufflehands: () => 'Every hand was collected and re-dealt',
};

// Plain-language summary of what a play does, shown in the "last play" panel.
function describePlay(e) {
  const card = e.card;
  const t = card.type;
  const tgt = (pid) => (pid === HUMAN ? 'you' : nameOf(pid));
  const nextP = game.phase === 'turn' ? tgt(game.current) : '';
  const color = COLOR_NAMES[e.color];
  if (t === 'number') {
    if (game.rules.sevenO && card.value === 7 && e.target !== null && e.target !== undefined) return `Swapped hands with ${tgt(e.target)}`;
    if (game.rules.sevenO && card.value === 0) return 'Every hand passed along';
    return nextP ? `${nextP[0].toUpperCase()}${nextP.slice(1)} ${nextP === 'you' ? 'are' : 'is'} up` : '';
  }
  if (t === 'skip') return 'Next player skipped';
  if (t === 'reverse') return 'Direction reversed';
  if (t === 'draw2' || t === 'wild4' || t === 'plus10') {
    const amt = game.pending ? game.pending.amount : 0;
    return amt ? `+${amt} → ${nextP} must stack or draw${isWild(card) ? ` · color ${color}` : ''}` : `Penalty dealt${isWild(card) ? ` · color ${color}` : ''}`;
  }
  if (t === 'wild') return `Color is now ${color}`;
  if (CARD_TYPES[t].hero) return CARD_TYPES[t].power;
  return `${CARD_TYPES[t].desc || ''}`.split('.')[0];
}

async function present(events) {
  const S = spd();
  for (const e of events) {
    switch (e.t) {
      case 'newDeck':
        e.cards.forEach((c) => renderer.ensureCard(c));
        ui.toast('A fresh deck joins the pile!');
        break;
      case 'play': {
        const card = e.card;
        const info = CARD_TYPES[card.type];
        audio.slide();
        setTimeout(() => audio.impact(info.action ? 1.2 : 0.9), 300 / S);
        ui.log(`${nameOf(e.p)} played ${cardLabel(card)}${isWild(card) ? ` → ${COLOR_NAMES[e.color]}` : ''}`);
        ui.pop(e.p);
        await renderer.sync(game, { focus: [e.id], toss: e.id, flight: 0.52, arc: 1.3 });
        ui.lastPlay(card, `${you(e.p) ? 'You' : nameOf(e.p)}${e.jump ? ' jumped in with' : ' played'}`, describePlay(e));
        renderer.setActiveColor(e.color, e.color !== e.prevColor || isWild(card));
        if (isWild(card)) { audio.wild(); ui.flash(COLOR_HEX[e.color], 0.3); }
        if (info.hero) {
          // The HERO cinematic itself follows on the 'hero' event.
        } else if (info.chaos) {
          audio.chaos();
          ui.announce(info.label, info.desc, { chaos: true });
          renderer.burst(renderer.meshes.get(e.id).position.clone(), 0xff2bd6, 120, 4);
          renderer.shakeCamera(0.15, 0.4);
          await sleep(500 / S);
        } else if (card.type === 'wild4' || card.type === 'draw2') {
          renderer.burst(renderer.meshes.get(e.id).position.clone(), 0xff3b30, 60, 3);
        }
        updateHUD();
        break;
      }
      case 'jumpIn':
        audio.jumpIn();
        ui.announce('JUMP IN!', `${nameOf(e.p)} cuts in`, { glow: '#8a2bff' });
        ui.pop(e.p);
        if (you(e.p)) stats.jumpIns++;
        break;
      case 'draw': {
        const n = e.ids.length;
        const st = Math.max(0.02, Math.min(0.09, 0.9 / n));
        e.ids.forEach((_, i) => audio.draw(i * st / S));
        if (e.reason !== 'draw') { ui.bubble(e.p, `+${n}`); ui.log(`${nameOf(e.p)} draws ${n}`); }
        if (n >= 4) audio.penalty(n);
        await renderer.sync(game, { focus: e.ids, stagger: st, flight: 0.45 });
        ui.updateSeats(game, { thinking });
        break;
      }
      case 'drawnPlayable':
        if (you(e.p)) ui.toast(e.forced ? 'You drew a playable card — Force Play!' : 'You drew a playable card');
        break;
      case 'turn':
        renderer.setTurn(e.p);
        if (you(e.p)) audio.turn();
        break;
      case 'skip':
        ui.bubble(e.p, 'Skipped!');
        break;
      case 'direction':
        renderer.setDirection(e.dir);
        audio.whoosh();
        ui.log(`Direction reversed`);
        break;
      case 'pending':
        ui.setPending(e.amount, renderer.discardScreen());
        if (e.stacked) { audio.penalty(e.amount); ui.toast(`Stack grows to +${e.amount}!`); }
        stats.longestStack = Math.max(stats.longestStack, e.amount);
        break;
      case 'pendingResolved':
        ui.setPending(0);
        break;
      case 'mirror':
        ui.announce('MIRROR!', `${nameOf(e.p)} reflects +${e.amount} back at ${nameOf(e.to)}`, { chaos: true });
        audio.swap();
        break;
      case 'uno':
        audio.uno();
        ui.bubble(e.p, 'UNO!');
        ui.announce('UNO!', nameOf(e.p), { glow: '#e2262f' });
        if (you(e.p)) stats.unoCalls++;
        break;
      case 'unoArmed':
        audio.click();
        ui.toast('UNO called — now play your second-to-last card!');
        break;
      case 'unoMissed':
        if (!you(e.p)) ui.log(`${nameOf(e.p)} didn't say UNO…`);
        break;
      case 'caught':
        audio.caught();
        ui.announce('CAUGHT!', `${nameOf(e.by)} caught ${nameOf(e.p)} without UNO · +2`, { glow: '#3fd06a', shake: true });
        if (you(e.p)) stats.caught++;
        break;
      case 'challenge':
        audio.boom();
        ui.announce(e.success ? 'BLUFF CAUGHT!' : 'CHALLENGE FAILED', e.success
          ? `${nameOf(e.target)} draws the penalty`
          : `${nameOf(e.p)} draws the penalty + 2`, { glow: '#ffb020', shake: true });
        break;
      case 'handsChanged':
        audio.swap();
        ui.announce(e.reason === 'seven' ? 'SEVEN!' : e.reason === 'zero' ? 'ZERO!' : 'HANDS SWAPPED', (EVENT_SUBS[e.reason] || (() => ''))(e), { glow: '#22e0ff' });
        renderer.shakeCamera(0.12, 0.4);
        await renderer.sync(game, { dur: 0.75 / S, arc: 1.8 });
        break;
      case 'transfer':
        if (e.reason === 'steal3') ui.announce('STEAL!', `${nameOf(e.to)} steals ${e.ids.length} from ${nameOf(e.from)}`, { chaos: true });
        audio.whoosh();
        await renderer.sync(game, { focus: e.ids, stagger: 0.07, flight: 0.55, arc: 1.4 });
        break;
      case 'destroy':
        audio.boom();
        ui.announce('DESTROYED!', `${nameOf(e.p)} loses ${e.ids.length} cards`, { chaos: true, shake: true });
        await renderer.sync(game, { focus: e.ids, stagger: 0.08, flight: 0.5 });
        break;
      case 'reshuffle':
        audio.shuffle();
        ui.toast('Reshuffling the discard pile');
        await renderer.sync(game, { focus: e.ids.slice(-40), stagger: 0.012, flight: 0.4 });
        break;
      case 'meter':
        ui.updateChaos(game);
        break;
      case 'chaosEvent': {
        const ev = CHAOS_EVENTS[e.key];
        stats.chaosEvents++;
        audio.chaos();
        ui.flash('#ff2bd6', 0.7);
        ui.announce(ev.name, ev.desc, { chaos: true, shake: true });
        renderer.shakeCamera(0.45, 0.9);
        if (settings.shake && !e.sub) renderer.focus('center', 0.9 / S);
        renderer.burstAt(0, 0.5, 0, 0xff2bd6, 200, 6, 1.6);
        await sleep((e.key === 'anarchy' ? 1600 : 1300) / S);
        if (!e.sub) renderer.focus('reset', 0.9 / S);
        updateHUD();
        break;
      }
      case 'heist':
        ui.log(`${nameOf(e.p)} pulled off the heist!`);
        break;
      case 'roulette':
        ui.log(`Roulette: ${nameOf(e.p)} receives ${e.amount}`);
        ui.bubble(e.p, e.amount ? `🎰 +${e.amount}` : '🎰 0!');
        break;
      case 'effect':
        if (e.key === 'lock') ui.announce('COLOR LOCK', `${COLOR_NAMES[e.color]} is locked for two rounds`, { chaos: true });
        if (e.key === 'collapse') ui.toast(`${COLOR_NAMES[e.color]} has collapsed — unplayable!`);
        updateHUD();
        break;
      case 'effectEnd':
        ui.log(`${{ apocalypse: 'Draw Apocalypse', collapse: 'Color Collapse', lock: 'Color Lock', storm: 'Wild Storm', crisis: 'Time Crisis' }[e.key]} ended`);
        updateHUD();
        break;
      case 'color':
        renderer.setActiveColor(e.color);
        ui.log(`🌪 The storm turns the color ${COLOR_NAMES[e.color]}`);
        break;
      case 'mercy':
        audio.mercy();
        ui.flash('#ff2bd6', 0.5);
        ui.announce('MERCY!', `${nameOf(e.by)} knocks out ${e.out.map(nameOf).join(' and ')}`, { chaos: true, shake: true });
        renderer.shakeCamera(0.3, 0.7);
        await sleep(900 / S);
        await renderer.sync(game, { dur: 0.8 / S, arc: 1.6 });
        break;
      case 'eliminated':
        audio.boom();
        ui.announce('OVERLOAD!', `${nameOf(e.p)} hit the card limit and is knocked out`, { chaos: true, shake: true });
        await renderer.sync(game, { dur: 0.7 / S, arc: 1.2 });
        break;
      case 'timeout':
        audio.error();
        ui.announce("TIME'S UP!", `${nameOf(e.p)} draws ${e.amount}`, { chaos: true });
        break;
      case 'hero': {
        const type = `hero_${e.hero}`;
        audio.hero(e.hero);
        ui.flash('#ffd34d', 0.8);
        ui.heroBanner(type, you(e.p) ? 'You' : nameOf(e.p));
        ui.log(`★ ${nameOf(e.p)} unleashed ${CARD_TYPES[type].label}: ${CARD_TYPES[type].power}!`);
        if (you(e.p)) stats.heroes = (stats.heroes || 0) + 1;
        await heroFX.play(e.hero, e.p);
        updateHUD();
        break;
      }
      case 'thorStrike':
        audio.thunder();
        ui.bubble(e.p, `⚡ +${e.amount}`);
        await heroFX.strike(e.p);
        break;
      case 'shieldBlock':
        audio.clang();
        heroFX.shieldBlock(e.p);
        ui.announce('BLOCKED!', e.amount ? `${nameOf(e.p)}'s shield rebounds +${e.amount} onto ${nameOf(e.to)}` : `${nameOf(e.p)}'s shield turns the attack back on ${nameOf(e.to)}`, { glow: '#9fd0ff', shake: true });
        renderer.shakeCamera(0.2, 0.3);
        await sleep(600 / S);
        break;
      case 'shieldEnd':
        heroFX.removeShield(e.p);
        ui.log(`${nameOf(e.p)}'s shield fades`);
        break;
      case 'superTurn':
        audio.whoosh();
        renderer.burstAt(renderer.seatPoint(e.p).x, 1, renderer.seatPoint(e.p).z, Math.random() < 0.5 ? 0x3d8cff : 0xff3b30, 80, 4, 0.7);
        ui.toast(e.left ? `Super Speed! ${e.left + 1} turns left` : 'Super Speed: final turn!');
        break;
      case 'sentryGolden':
        heroFX.setSentryAura(e.p, true);
        renderer.setCardGlow(e.id, 0xffb300);
        await renderer.sync(game, { focus: e.stash, stagger: 0.03, flight: 0.5 });
        ui.toast(`${you(e.p) ? 'Your' : `${nameOf(e.p)}'s`} hand is set aside — one golden card for a round`);
        break;
      case 'sentryResolve':
        heroFX.setSentryAura(e.p, false);
        renderer.setCardGlow(e.id, null);
        if (e.exact) {
          audio.sun();
          ui.flash('#ffd34d', 1);
          ui.announce('GOLDEN VICTORY!', `${nameOf(e.p)}'s golden card matches exactly!`, { glow: '#ffd34d', shake: true });
          await sleep(1200 / S);
        } else {
          ui.log(`The golden card fades — ${nameOf(e.p)}'s hand returns`);
          await renderer.sync(game, { dur: 0.6 / S, arc: 1 });
        }
        break;
      case 'win':
        break;
      default:
        break;
    }
  }
  await renderer.sync(game, { dur: 0.3 });
  updateHUD();
  store.set('uno.stats', stats);
}

// ------------------------------------------------------------------ end of round
async function endRound(token) {
  clearTimers();
  stopCrisis();
  renderer.setInteractive({ playable: new Set(), jumpable: new Set(), myTurn: false });
  ui.setActions({});
  ui.setPending(0);
  ui.updateSeats(game);
  const w = game.winner;
  const won = w === HUMAN;
  const score = game.roundScore;
  match.totals[w] += score;

  // Stats
  stats.games++;
  const m = stats.byMode[game.mode] || (stats.byMode[game.mode] = { games: 0, wins: 0 });
  m.games++;
  if (won) { stats.wins++; m.wins++; stats.streak++; stats.bestStreak = Math.max(stats.bestStreak, stats.streak); stats.bestScore = Math.max(stats.bestScore, score); }
  else stats.streak = 0;
  stats.history.unshift({ date: Date.now(), mode: game.mode, win: won, winner: nameOf(w), score, turns: game.turn, opponents: game.n - 1 });
  stats.history = stats.history.slice(0, 40);

  // Cinematic
  renderer.setTurn(w);
  if (settings.shake) renderer.focus(w, 1.6 / spd());
  if (won) {
    audio.win();
    audio.say('You win!');
    renderer.confettiAtSeat(w, 300);
    ui.flash('#ffd34d', 0.6);
  } else {
    audio.lose();
  }
  ui.announce(won ? 'VICTORY!' : 'DEFEAT', `${nameOf(w)} ${game.winHow === 'lastStanding' ? 'is the last one standing' : 'went out'} · +${score} points`,
    { glow: won ? '#ffd34d' : '#555' });
  await sleep(3000);
  if (token !== roundToken) return;

  const S = match.setup;
  const target = S.matchTo;
  const matchOver = !target || match.totals[w] >= target;
  if (matchOver && target) { if (won) stats.matchesWon++; }
  store.set('uno.stats', stats);
  const rows = game.players.map((p) => ({
    name: p.name, avatar: p.avatar, me: p.id === HUMAN,
    cards: p.out ? 'OUT' : p.hand.length, round: p.id === w ? score : 0, total: match.totals[p.id],
  })).sort((a, b) => b.total - a.total);
  const title = matchOver && target ? (won ? 'Match won!' : `${nameOf(w)} wins the match`) : won ? 'Victory!' : 'Defeat';
  const sub = target ? (matchOver ? `First to ${target} points` : `Round ${match.round} · first to ${target} wins the match`) : 'Single round';
  const choice = await ui.roundResult({ title, sub, rows, showNext: true, nextText: matchOver ? 'Play again' : 'Next round' });
  if (token !== roundToken) return;
  renderer.focus('reset', 1);
  if (choice === 'next') {
    if (matchOver) await startMatch();
    else await playRound();
  } else goMenu();
}

// ------------------------------------------------------------------ menus
function showMenuScene() {
  // A decorative deal spinning slowly behind the menus.
  const demo = new UnoGame({ mode: 'standard', players: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }] });
  demo.start(0);
  renderer.idle = true;
  renderer.camAnim = null;
  renderer.setupSeats(demo.players, 0);
  renderer.sync(demo, { dur: 0.01 });
  renderer.game = null; // not interactive
  renderer.setActiveColor(demo.activeColor, false);
  renderer.setTurn(0);
}

function wireMenus() {
  ui.onNavigate = (id) => {
    if (id === 'stats') ui.buildStats(stats, () => {
      stats = { games: 0, wins: 0, byMode: {}, bestScore: 0, streak: 0, bestStreak: 0, matches: 0, matchesWon: 0, longestStack: 0, chaosEvents: 0, jumpIns: 0, unoCalls: 0, caught: 0, history: [] };
      store.set('uno.stats', stats);
      ui.buildStats(stats, () => {});
    });
    if (id === 'setup' && ui.renderSetup) ui.renderSetup();
  };
  ui.buildSetup(setup, (s, what) => {
    store.set('uno.setup', s);
    if (what === 'env') { renderer.setEnvironment(s.env, profile.felt); audio.setAmbience(s.env); }
  });
  document.getElementById('rules-default').onclick = () => { setup.rules = { ...DEFAULT_RULES }; store.set('uno.setup', setup); ui.buildSetup(setup, () => store.set('uno.setup', setup)); };
  document.getElementById('start-game').onclick = () => { audio.unlock(); audio.click(); startMatch(); };
  ui.buildRules();
  ui.buildCustomize(profile, (p, what) => {
    store.set('uno.profile', p);
    if (what === 'back') renderer.setCardBack(p.cardBack);
    if (what === 'felt') renderer.setEnvironment(setup.env, p.felt);
  });
  ui.bindSettings(settings, (s, k) => {
    store.set('uno.settings', s);
    if (['master', 'sfx', 'ambience', 'music'].includes(k)) audio.setVolumes(s);
    if (k === 'voice') audio.voice = s.voice;
    if (k === 'quality') renderer.setQuality(s.quality);
    if (k === 'speed') renderer.speed = s.speed;
    if (k === 'shake') renderer.shakeEnabled = s.shake;
    if (k === 'hints') renderer.setInteractive({ hints: s.hints });
  });
  document.addEventListener('pointerdown', () => { audio.unlock(); }, { once: false });
  document.querySelectorAll('.btn, .choice, .seg button').forEach((b) => b.addEventListener('pointerenter', () => audio.hover()));
}

// ------------------------------------------------------------------ boot
async function boot() {
  ui.setLoading('Loading fonts…');
  try { await Promise.race([document.fonts.load('80px "Lilita One"'), sleep(2500)]); } catch { /* fallback fonts */ }
  ui.setLoading('Building the table…');
  await sleep(30);
  try {
    renderer = new Renderer(document.getElementById('stage'), {
      quality: settings.quality, environment: setup.env, cardBack: profile.cardBack, felt: profile.felt,
    });
  } catch (err) {
    console.error(err);
    ui.setLoading('Your browser could not start WebGL. Try another browser or enable hardware acceleration.');
    return;
  }
  renderer.speed = settings.speed;
  renderer.shakeEnabled = settings.shake;
  renderer.interactive.hints = settings.hints;
  heroFX = new HeroFX(renderer);
  renderer.onCardPlay = onHumanCard;
  renderer.onDrawPile = humanDraw;
  renderer.onHover = () => audio.hover();
  renderer.onFrame = () => {
    if (ui.current === 'hud') {
      ui.positionSeats(renderer);
      if (game && game.pending) ui.setPending(game.pending.amount, renderer.discardScreen());
    }
  };
  audio.setAmbience(setup.env);
  bindHud();
  window.addEventListener('keydown', (e) => { if (e.key === '`') toggleDev(); });
  if (location.search.includes('dev')) {
    const db = document.getElementById('dev-btn');
    db.classList.remove('hidden');
    db.onclick = () => toggleDev();
  }
  wireMenus();
  showMenuScene();
  ui.show('menu');
  window.__uno = { get game() { return game; }, renderer, ui, audio, submit, heroFX };
}

boot();
