// DOM user interface: screens, HUD, seat labels, announcements and modals.
// Pure presentation: it reports user intent through callbacks and promises.

import { COLOR_HEX, COLOR_NAMES, CARD_TYPES, CHAOS_CARD_COUNTS, HERO_TYPES, isHero } from './cards.js';
import { HOUSE_RULES, CHAOS_EVENTS, MERCY_THRESHOLD, OVERLOAD_LIMIT } from './engine.js';
import { PERSONALITIES, DIFFICULTIES } from './ai.js';
import { cardThumbDataURL, drawCardBack, CARD_BACKS } from './textures.js';

const $ = (s, el = document) => el.querySelector(s);
const cardLabelFor = (card) => {
  const info = CARD_TYPES[card.type];
  const color = card.color === 'wild' ? '' : `${COLOR_NAMES[card.color]} `;
  return card.type === 'number' ? `${color}${card.value}` : `${color}${info.label}`;
};
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const AVATARS = ['😎', '🤖', '👾', '🦊', '🐼', '🐙', '🦄', '🐸', '👽', '🐯', '🐧', '🦉', '🐲', '🌟'];
export const AI_ROSTER = [
  { name: 'Luna', avatar: '🤖', color: '#f2a65a' },
  { name: 'Dusty', avatar: '👾', color: '#c9a7ff' },
  { name: 'Pudding', avatar: '🐸', color: '#f6e27a' },
  { name: 'Nova', avatar: '🦊', color: '#7fd1ff' },
  { name: 'Pixel', avatar: '🐙', color: '#ff9bb5' },
  { name: 'Rex', avatar: '🐲', color: '#9be59b' },
  { name: 'Mochi', avatar: '🐼', color: '#ffd1a1' },
];
export const FELTS = ['#0f6b3a', '#0d4f7a', '#6b0f1c', '#3b1a6b', '#17122b', '#2b2b2b'];

export class UI {
  constructor() {
    this.stack = ['loading'];
    this.seatEls = [];
    this.onNavigate = () => {};
    this.logLines = [];
    $$('[data-go]').forEach((b) => b.addEventListener('click', () => this.show(b.dataset.go)));
    $$('[data-back]').forEach((b) => b.addEventListener('click', () => this.back()));
  }

  // ---------------------------------------------------------------- screens
  show(id, push = true) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    if (push && this.stack[this.stack.length - 1] !== id) this.stack.push(id);
    this.current = id;
    this.onNavigate(id);
  }

  back() {
    this.stack.pop();
    const prev = this.stack[this.stack.length - 1] || 'menu';
    this.show(prev, false);
  }

  // Overlay a panel (settings/rules) on top of the paused game.
  overlay(id) {
    const el = document.getElementById(id);
    el.classList.add('active');
    el.style.zIndex = 70;
    return new Promise((res) => {
      const close = () => { el.classList.remove('active'); el.style.zIndex = ''; res(); };
      const btn = $('.back', el);
      const h = () => { btn.removeEventListener('click', h, true); close(); };
      btn.addEventListener('click', h, true);
    });
  }

  setLoading(text) { $('#loading-text').textContent = text; }

  // ---------------------------------------------------------------- feedback
  // Big announcements are queued so each one stays readable instead of being
  // replaced instantly; if a backlog builds up, old ones are dropped.
  announce(title, sub = '', opts = {}) {
    this.annQueue = this.annQueue || [];
    this.annQueue.push({ title, sub, opts });
    if (this.annQueue.length > 3) this.annQueue.splice(0, this.annQueue.length - 3);
    if (!this.annBusy) this._nextAnn();
  }

  _nextAnn() {
    const a = this.annQueue.shift();
    if (!a) { this.annBusy = false; return; }
    this.annBusy = true;
    const el = document.createElement('div');
    el.className = `ann${a.opts.chaos ? ' chaos' : ''}${a.opts.shake ? ' shake' : ''}`;
    if (a.opts.glow) el.style.setProperty('--ann-glow', a.opts.glow);
    el.innerHTML = `<b>${esc(a.title)}</b>${a.sub ? `<small>${esc(a.sub)}</small>` : ''}`;
    $('#announce').replaceChildren(el);
    const hold = this.annQueue.length ? 1300 : 2200;
    setTimeout(() => { el.remove(); this._nextAnn(); }, hold);
  }

  // Panel showing the last card played, who played it and what it did.
  lastPlay(card, who, fx = '') {
    this.thumbs = this.thumbs || new Map();
    const key = `${card.color}|${card.type}|${card.value}`;
    if (!this.thumbs.has(key)) this.thumbs.set(key, cardThumbDataURL(card, 90));
    const el = $('#lastplay');
    el.classList.remove('hidden', 'flash');
    void el.offsetWidth;
    el.classList.add('flash');
    $('#lastplay-img').src = this.thumbs.get(key);
    $('#lastplay-who').textContent = who;
    $('#lastplay-card').textContent = cardLabelFor(card);
    $('#lastplay-fx').textContent = fx;
  }

  setLastPlayFx(fx) { $('#lastplay-fx').textContent = fx; }
  clearLastPlay() { $('#lastplay').classList.add('hidden'); }

  heroBanner(cardType, playerName) {
    const info = CARD_TYPES[cardType];
    const el = document.createElement('div');
    el.className = 'ann hero';
    el.innerHTML = `<i>★ HERO ★ · ${esc(playerName)}</i><b>${esc(info.label)}</b><em>${esc(info.title)}</em><span>${esc(info.power)}</span><small>${esc(info.desc)}</small>`;
    $('#announce').replaceChildren(el);
    setTimeout(() => el.remove(), 4200);
  }

  toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  log(msg) {
    const host = $('#log');
    const el = document.createElement('div');
    el.textContent = msg;
    host.prepend(el);
    while (host.children.length > 5) host.lastChild.remove();
  }

  clearLog() { $('#log').replaceChildren(); }

  flash(color = '#fff', strength = 0.6) {
    const f = $('#flash');
    f.style.transition = 'none';
    f.style.background = `radial-gradient(circle, ${color}, transparent 75%)`;
    f.style.opacity = strength;
    requestAnimationFrame(() => { f.style.transition = 'opacity 0.8s ease-out'; f.style.opacity = 0; });
  }

  setChaosLook(on, intensity = 0) {
    document.body.classList.toggle('chaos', on);
    document.documentElement.style.setProperty('--chaos', on ? intensity.toFixed(2) : 0);
  }

  // ---------------------------------------------------------------- seats
  buildSeats(players, humanId) {
    const host = $('#seats');
    host.replaceChildren();
    this.seatEls = players.map((p) => {
      const el = document.createElement('div');
      el.className = `seat${p.id === humanId ? ' human' : ''}`;
      el.style.setProperty('--seat-color', p.color || '#444');
      const sub = p.id === humanId ? 'You' : `${PERSONALITIES[p.personality].icon} ${PERSONALITIES[p.personality].name} · ${DIFFICULTIES[p.difficulty].name}`;
      el.innerHTML = `<div class="av">${esc(p.avatar)}</div><div class="who"><b>${esc(p.name)}</b><small>${esc(sub)}</small></div><span class="think"><i></i><i></i><i></i></span><div class="count">7</div><span class="hero-chip hidden"></span>`;
      host.appendChild(el);
      return el;
    });
  }

  positionSeats(renderer) {
    this.seatEls.forEach((el, i) => {
      if (el.classList.contains('human')) return;
      let s = renderer.seatScreen(i);
      if (!s) return;
      // Keep labels on screen and clear of the top bar / chaos meter. If there is no
      // room above a far player's cards, the plate sits on the felt in front of them.
      const minTop = (window.innerWidth < 640 ? 150 : 128) + (document.body.classList.contains('chaos') ? 50 : 0);
      if (s.y < minTop) {
        const f = renderer.seatScreenFront(i);
        if (f) s = { x: f.x, y: f.y + 24 };
      }
      // Reading offsetWidth forces layout, so measure rarely and skip no-op writes.
      if (!el._w || (this._frameCount || 0) % 60 === 0) el._w = el.offsetWidth || 160;
      const w = el._w;
      const left = Math.round(Math.min(window.innerWidth - w / 2 - 8, Math.max(w / 2 + 8, s.x)));
      const top = Math.round(Math.min(window.innerHeight - 90, Math.max(minTop, s.y)));
      if (left !== el._l) { el.style.left = `${left}px`; el._l = left; }
      if (top !== el._t) { el.style.top = `${top}px`; el._t = top; }
    });
    this._frameCount = (this._frameCount || 0) + 1;
  }

  updateSeats(game, opts = {}) {
    game.players.forEach((p, i) => {
      const el = this.seatEls[i];
      if (!el) return;
      $('.count', el).textContent = p.out ? '–' : p.hand.length + (p.stash ? p.stash.length : 0);
      // HERO indicator (Chaos only): hidden information until used, except your own.
      const chip = $('.hero-chip', el);
      chip.classList.toggle('hidden', game.mode !== 'chaos');
      if (game.mode === 'chaos') {
        const held = el.classList.contains('human') ? p.hand.find(isHero) : null;
        let txt = '⚡ HERO';
        let cls = 'hero-chip';
        if (p.heroUsed) { txt = `⚡ ${CARD_TYPES[p.heroUsed].label} · USED`; cls += ' used'; }
        else if (held) { txt = `⚡ ${CARD_TYPES[held.type].label} READY`; cls += ' ready'; }
        if (p.shield) { txt = '🛡 SHIELDED'; cls += ' live'; }
        if (p.superSpeed) { txt = `⚡ SUPER SPEED · ${p.superSpeed}`; cls += ' live'; }
        if (p.stash) { txt = '☀ GOLDEN CARD'; cls += ' live'; }
        chip.className = cls;
        chip.textContent = txt;
      }
      el.classList.toggle('turn', game.phase === 'turn' && game.current === i);
      el.classList.toggle('thinking', opts.thinking === i);
      el.classList.toggle('out', !!p.out);
      let tag = $('.tag', el);
      const want = p.out ? 'out' : p.hand.length === 1 && game.phase === 'turn' ? 'uno' : null;
      if (!want) { if (tag) tag.remove(); return; }
      if (!tag) { tag = document.createElement('span'); el.appendChild(tag); }
      tag.className = `tag ${want}`;
      tag.textContent = want === 'out' ? 'OUT' : 'UNO!';
    });
  }

  bubble(pid, text) {
    const el = this.seatEls[pid];
    if (!el) return;
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    el.appendChild(b);
    setTimeout(() => b.remove(), 1850);
  }

  pop(pid) {
    const el = this.seatEls[pid];
    if (!el) return;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  // ---------------------------------------------------------------- HUD
  setTurnBanner(text, mine, next = '') {
    const b = $('#turn-banner');
    b.innerHTML = `${esc(text)}${next ? `<small>next: ${esc(next)}</small>` : ''}`;
    b.classList.toggle('mine', !!mine);
    $('#hint-line').classList.toggle('mine', !!mine);
  }

  setChips(mode, roundText) {
    const m = $('#mode-chip');
    m.textContent = mode === 'chaos' ? 'Chaos' : 'Standard';
    m.classList.toggle('chaos', mode === 'chaos');
    $('#round-chip').textContent = roundText;
  }

  updateTableInfo(game) {
    const c = $('#info-color');
    const hex = COLOR_HEX[game.activeColor] || '#fff';
    c.style.background = hex;
    c.style.color = hex;
    c.title = `Active color: ${COLOR_NAMES[game.activeColor] || ''}`;
    $('#info-dir').classList.toggle('ccw', game.direction < 0);
    $('#info-deck').textContent = game.drawPile.length;
  }

  updateChaos(game) {
    const on = game.mode === 'chaos';
    $('#chaos-meter').classList.toggle('hidden', !on);
    if (!on) { $('#effects').replaceChildren(); return; }
    $('#meter-fill').style.width = `${game.meter}%`;
    $('#chaos-level').textContent = `Lv ${game.chaosLevel}`;
    const fx = game.effects;
    const chips = [];
    if (fx.apocalypse) chips.push(`☠ Draws ×2 · ${fx.apocalypse}`);
    if (fx.collapse) chips.push(`🚫 ${COLOR_NAMES[fx.collapse.color]} collapsed · ${fx.collapse.turns}`);
    if (fx.lock) chips.push(`🔒 ${COLOR_NAMES[fx.lock.color]} locked · ${fx.lock.turns}`);
    if (fx.storm) chips.push(`🌪 Wild Storm · ${fx.storm}`);
    if (fx.crisis) chips.push(`⏱ Time Crisis · ${fx.crisis}`);
    $('#effects').innerHTML = chips.map((c) => `<span class="fx">${esc(c)}</span>`).join('');
  }

  setPending(amount, pos) {
    const b = $('#pending-badge');
    if (!amount) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
    $('b', b).textContent = `+${amount}`;
    if (pos) { b.style.left = `${pos.x}px`; b.style.top = `${pos.y}px`; }
  }

  setActions(a) {
    const set = (id, show, text) => {
      const el = document.getElementById(id);
      el.classList.toggle('hidden', !show);
      if (text) el.textContent = text;
    };
    set('btn-draw', a.draw, a.drawText);
    set('btn-keep', a.keep);
    set('btn-challenge', a.challenge);
    set('btn-uno', a.uno);
    $('#btn-uno').classList.toggle('urgent', !!a.unoUrgent);
    set('btn-catch', a.catch, a.catchText);
    set('btn-mercy', a.mercy, a.mercyText);
    $('#hint-line').textContent = a.hint || '';
  }

  setTimer(sec, total = 5) {
    const t = $('#timer');
    if (sec === null) { t.classList.add('hidden'); return; }
    t.classList.remove('hidden');
    $('b', t).textContent = Math.ceil(sec);
    $('circle', t).style.strokeDashoffset = `${100.5 * (1 - sec / total)}`;
  }

  // ---------------------------------------------------------------- modals
  _modal(id) {
    const m = document.getElementById(id);
    m.classList.remove('hidden');
    return () => m.classList.add('hidden');
  }

  chooseColor(allowed) {
    const close = this._modal('modal-color');
    return new Promise((res) => {
      $$('#modal-color [data-color]').forEach((b) => {
        b.disabled = !allowed.includes(b.dataset.color);
        b.onclick = () => { close(); res(b.dataset.color); };
      });
    });
  }

  chooseTarget(title, options) {
    const close = this._modal('modal-target');
    $('#target-title').textContent = title;
    const list = $('#target-list');
    list.replaceChildren();
    return new Promise((res) => {
      for (const o of options) {
        const b = document.createElement('button');
        b.innerHTML = `<span class="av">${esc(o.avatar)}</span>${esc(o.name)}<span class="n">${o.count}</span>`;
        b.onclick = () => { close(); res(o.id); };
        list.appendChild(b);
      }
    });
  }

  closeModals() { $$('.modal').forEach((m) => m.classList.add('hidden')); }

  roundResult({ title, sub, rows, nextText, showNext }) {
    const close = this._modal('modal-round');
    $('#round-title').textContent = title;
    $('#round-sub').textContent = sub;
    $('#round-table').innerHTML = `<tr><th>Player</th><th>Cards left</th><th>Round</th><th>Total</th></tr>${rows.map((r) =>
      `<tr class="${r.me ? 'me' : ''}"><td>${esc(r.avatar)} ${esc(r.name)}</td><td>${esc(r.cards)}</td><td>${r.round ? `+${r.round}` : ''}</td><td>${r.total}</td></tr>`).join('')}`;
    const next = $('#next-round');
    next.textContent = nextText;
    next.classList.toggle('hidden', !showNext);
    return new Promise((res) => {
      next.onclick = () => { close(); res('next'); };
      $('#round-menu').onclick = () => { close(); res('menu'); };
    });
  }

  // ---------------------------------------------------------------- setup screen
  buildSetup(state, onChange) {
    const s = state;
    const render = () => {
      $$('#mode-choice .choice').forEach((b) => b.classList.toggle('on', b.dataset.mode === s.mode));
      $('#house-rules').classList.toggle('hidden', s.mode !== 'standard');
      $$('#opp-count button').forEach((b) => b.classList.toggle('on', +b.dataset.n === s.opponents.length));
      $$('#env-choice .choice').forEach((b) => b.classList.toggle('on', b.dataset.env === s.env));
      $('#difficulty').value = s.difficulty;
      $('#match-length').value = String(s.matchTo);
      $$('#rule-toggles input').forEach((i) => { i.checked = !!s.rules[i.dataset.rule]; });
      const list = $('#opp-list');
      list.replaceChildren();
      s.opponents.forEach((o, i) => {
        const r = AI_ROSTER[i];
        const row = document.createElement('div');
        row.className = 'opp-row';
        row.innerHTML = `<span class="av">${r.avatar}</span><span class="nm">${r.name}</span><select>${['random', ...Object.keys(PERSONALITIES)].map((k) =>
          `<option value="${k}" ${o.personality === k ? 'selected' : ''}>${k === 'random' ? '🎲 Random' : `${PERSONALITIES[k].icon} ${PERSONALITIES[k].name}`}</option>`).join('')}</select>`;
        $('select', row).onchange = (e) => { o.personality = e.target.value; onChange(s); };
        row.title = o.personality !== 'random' ? PERSONALITIES[o.personality].blurb : 'Random personality';
        list.appendChild(row);
      });
    };
    const toggles = $('#rule-toggles');
    toggles.innerHTML = Object.entries(HOUSE_RULES).map(([k, r]) =>
      `<label class="toggle"><input type="checkbox" data-rule="${k}" /><span><b>${esc(r.name)}</b><small>${esc(r.desc)}</small></span></label>`).join('');
    $$('input', toggles).forEach((i) => { i.onchange = () => { s.rules[i.dataset.rule] = i.checked; onChange(s); }; });
    $$('#mode-choice .choice').forEach((b) => { b.onclick = () => { s.mode = b.dataset.mode; render(); onChange(s); }; });
    $$('#env-choice .choice').forEach((b) => { b.onclick = () => { s.env = b.dataset.env; render(); onChange(s, 'env'); }; });
    $$('#opp-count button').forEach((b) => {
      b.onclick = () => {
        const n = +b.dataset.n;
        while (s.opponents.length < n) s.opponents.push({ personality: 'random' });
        s.opponents.length = n;
        render(); onChange(s);
      };
    });
    $('#difficulty').onchange = (e) => { s.difficulty = e.target.value; onChange(s); };
    $('#match-length').onchange = (e) => { s.matchTo = +e.target.value; onChange(s); };
    this.renderSetup = render;
    render();
  }

  // ---------------------------------------------------------------- rules page
  buildRules() {
    const thumb = (card) => cardThumbDataURL(card, 70);
    const chaosCards = Object.keys(CHAOS_CARD_COUNTS).map((type) => {
      const color = CARD_TYPES[type].wild ? 'wild' : 'red';
      return `<div class="card-tile"><img alt="" src="${thumb({ color, type, value: null })}" /><div><b>${esc(CARD_TYPES[type].label)}</b><small>${esc(CARD_TYPES[type].desc)}</small></div></div>`;
    }).join('');
    const events = Object.values(CHAOS_EVENTS).map((e) => `<li><b>${esc(e.name)}</b> — ${esc(e.desc)}</li>`).join('');
    const rules = Object.values(HOUSE_RULES).map((r) => `<li><b>${esc(r.name)}</b> — ${esc(r.desc)}</li>`).join('');
    $('#rules-body').innerHTML = `
      <h3>Standard Mode</h3>
      <div class="rule-block">
        <p>Everyone starts with 7 cards. Match the top of the discard pile by <b>color</b>, <b>number</b> or <b>symbol</b>. If you can't play, draw one card. You may play it straight away if it fits.</p>
        <ul>
          <li><b>Skip</b> — the next player loses their turn. <b>Reverse</b> — flips direction (with 2 players it acts as a Skip).</li>
          <li><b>Draw Two</b> — the next player draws 2 and loses their turn. <b>Wild</b> — choose the next color.</li>
          <li><b>Wild Draw Four</b> — choose a color; the next player draws 4. It's only legal if you have no card of the current color. The victim may <b>challenge</b>: if you bluffed, you draw the penalty instead. If the play was legal, the challenger draws the penalty + 2.</li>
          <li>Call <b>UNO</b> when you go down to one card (press UNO before or right after playing). If someone catches you before the next player starts their turn, you draw 2.</li>
          <li>First to empty their hand wins the round and scores the cards left in everyone else's hands (numbers = face value, actions = 20, wilds = 50).</li>
        </ul>
      </div>
      <h3>House Rules (toggle before each match)</h3>
      <div class="rule-block"><ul>${rules}</ul><p>Default preset: Progressive UNO, Jump-In and Seven-O.</p></div>
      <h3>Chaos Mode</h3>
      <div class="rule-block">
        <p>Every action card fills the shared <b>Chaos Meter</b>. When it's full, a random <b>Chaos Event</b> fires. Stacks can escalate: +2 → +4 → +10, and a Mirror reflects any stack. Each event raises the chaos level and the table gets wilder.</p>
        <ul>
          <li><b>Mercy!</b> — when one player holds exactly 1 card while another holds ${MERCY_THRESHOLD}+ cards, anyone except the 1-card player can call Mercy. Both are knocked out of the round and their cards are dealt evenly to everyone still in.</li>
          <li><b>Overload</b> — reaching ${OVERLOAD_LIMIT} cards knocks you out. The last player standing wins.</li>
          <li>Effect durations count turns; colors locked by Color Lock can't be collapsed; Wild Storm is paused while a color is locked.</li>
        </ul>
      </div>
      <h3>Chaos Events</h3>
      <div class="rule-block"><ul>${events}</ul></div>
      <h3>Chaos Cards</h3>
      <div class="card-grid">${chaosCards}</div>
      <h3>HERO Cards</h3>
      <div class="rule-block"><p>Extremely rare ultimate cards hidden in the Chaos deck — never dealt, only found by drawing. Each player can obtain and use <b>one</b> HERO per match. A HERO plays like a Wild, triggers its ability at once, then leaves the match for good. HERO cards can't be stolen, swapped or redistributed.</p></div>
      <div class="card-grid hero-grid">${HERO_TYPES.map((type) => `<div class="card-tile"><img alt="" src="${thumb({ color: 'wild', type, value: null })}" /><div><b>${esc(CARD_TYPES[type].label)} — ${esc(CARD_TYPES[type].power)}</b><small>${esc(CARD_TYPES[type].desc)}</small></div></div>`).join('')}</div>
      <h3>AI Personalities</h3>
      <div class="rule-block"><ul>${Object.values(PERSONALITIES).map((p) => `<li>${p.icon} <b>${esc(p.name)}</b> — ${esc(p.blurb)}</li>`).join('')}</ul>
      <p>The AI never sees your cards. Hard and Expert opponents count cards and model what you're likely holding, and the Expert Mastermind simulates possible futures before it moves.</p></div>`;
  }

  // ---------------------------------------------------------------- stats page
  buildStats(stats, onReset) {
    const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
    const mode = (k) => stats.byMode[k] || { games: 0, wins: 0 };
    const rows = stats.history.slice(0, 25).map((h) => `<tr><td>${new Date(h.date).toLocaleDateString()}</td><td>${h.mode === 'chaos' ? 'Chaos' : 'Standard'}</td>
      <td class="${h.win ? 'win-tag' : 'loss-tag'}">${h.win ? 'Win' : 'Loss'}</td><td>${esc(h.winner)}</td><td>${h.score}</td><td>${h.turns}</td><td>${h.opponents}</td></tr>`).join('');
    $('#stats-body').innerHTML = `
      <div class="tiles">
        <div class="tile"><b>${stats.games}</b><small>Rounds played</small></div>
        <div class="tile"><b>${stats.wins}</b><small>Wins</small></div>
        <div class="tile"><b>${stats.games - stats.wins}</b><small>Losses</small></div>
        <div class="tile"><b>${pct(stats.wins, stats.games)}</b><small>Win rate</small></div>
        <div class="tile"><b>${stats.bestStreak}</b><small>Best streak</small></div>
        <div class="tile"><b>${stats.bestScore}</b><small>Best round score</small></div>
        <div class="tile"><b>${stats.matchesWon}/${stats.matches}</b><small>Matches won</small></div>
        <div class="tile"><b>${pct(mode('standard').wins, mode('standard').games)}</b><small>Standard win rate</small></div>
        <div class="tile"><b>${pct(mode('chaos').wins, mode('chaos').games)}</b><small>Chaos win rate</small></div>
        <div class="tile"><b>${stats.longestStack}</b><small>Biggest stack</small></div>
        <div class="tile"><b>${stats.chaosEvents}</b><small>Chaos events</small></div>
        <div class="tile"><b>${stats.jumpIns}</b><small>Your jump-ins</small></div>
        <div class="tile"><b>${stats.unoCalls}</b><small>UNO calls</small></div>
        <div class="tile"><b>${stats.caught}</b><small>Times caught</small></div>
      </div>
      <h3>Match history</h3>
      ${rows ? `<table class="history"><tr><th>Date</th><th>Mode</th><th>Result</th><th>Winner</th><th>Points</th><th>Turns</th><th>Opp.</th></tr>${rows}</table>` : '<p style="color:var(--muted)">No rounds played yet.</p>'}
      <p style="margin-top:18px"><button class="btn danger" id="reset-stats">Reset statistics</button></p>`;
    $('#reset-stats').onclick = () => { if (confirm('Reset all statistics?')) onReset(); };
  }

  // ---------------------------------------------------------------- customize
  buildCustomize(profile, onChange) {
    const name = $('#cust-name');
    name.value = profile.name;
    name.oninput = () => { profile.name = name.value.trim() || 'You'; onChange(profile); };
    const av = $('#avatar-grid');
    av.innerHTML = AVATARS.map((a) => `<button data-a="${a}" class="${profile.avatar === a ? 'on' : ''}">${a}</button>`).join('');
    $$('button', av).forEach((b) => { b.onclick = () => { profile.avatar = b.dataset.a; $$('button', av).forEach((x) => x.classList.toggle('on', x === b)); onChange(profile); }; });
    const backs = $('#back-grid');
    backs.innerHTML = Object.entries(CARD_BACKS).map(([k, v]) => {
      const c = drawCardBack(k);
      const small = document.createElement('canvas');
      small.width = 120; small.height = 186;
      small.getContext('2d').drawImage(c, 0, 0, 120, 186);
      return `<button data-b="${k}" class="${profile.cardBack === k ? 'on' : ''}"><img alt="" src="${small.toDataURL()}" />${esc(v.name)}</button>`;
    }).join('');
    $$('button', backs).forEach((b) => { b.onclick = () => { profile.cardBack = b.dataset.b; $$('button', backs).forEach((x) => x.classList.toggle('on', x === b)); onChange(profile, 'back'); }; });
    const felts = $('#felt-grid');
    felts.innerHTML = FELTS.map((f) => `<button data-f="${f}" style="background:${f}" class="${profile.felt === f ? 'on' : ''}" aria-label="Felt ${f}"></button>`).join('');
    $$('button', felts).forEach((b) => { b.onclick = () => { profile.felt = b.dataset.f; $$('button', felts).forEach((x) => x.classList.toggle('on', x === b)); onChange(profile, 'felt'); }; });
  }

  bindSettings(settings, onChange) {
    $$('[data-setting]').forEach((el) => {
      const k = el.dataset.setting;
      if (el.type === 'checkbox') el.checked = !!settings[k];
      else el.value = String(settings[k]);
      el.oninput = el.onchange = () => {
        settings[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : (k === 'speed' ? +el.value : el.value);
        onChange(settings, k);
      };
    });
  }
}
