// Card definitions, deck construction and card metadata.
// Pure data module: no DOM, no Three.js, safe to import from Node tests.

export const COLORS = ['red', 'yellow', 'green', 'blue'];

export const COLOR_HEX = {
  red: '#e2262f',
  yellow: '#f6c412',
  green: '#2a9d48',
  blue: '#1d68d4',
  wild: '#151515',
};

export const COLOR_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' };

// type -> metadata. `wild` cards have color 'wild' and need a color choice when played.
export const CARD_TYPES = {
  number:       { label: 'Number',          points: 0,  wild: false, chaos: false, action: false },
  skip:         { label: 'Skip',            points: 20, wild: false, chaos: false, action: true },
  reverse:      { label: 'Reverse',         points: 20, wild: false, chaos: false, action: true },
  draw2:        { label: 'Draw Two',        points: 20, wild: false, chaos: false, action: true },
  wild:         { label: 'Wild',            points: 50, wild: true,  chaos: false, action: true },
  wild4:        { label: 'Wild Draw Four',  points: 50, wild: true,  chaos: false, action: true },
  // ---- Chaos exclusives ----
  plus10:       { label: '+10',             points: 60, wild: true,  chaos: true, action: true,
                  desc: 'Next player draws 10 unless they counter with another +10 or a Mirror.' },
  everyone4:    { label: 'Everyone Draw +4',points: 50, wild: true,  chaos: true, action: true,
                  desc: 'Every opponent draws four cards.' },
  ultreverse:   { label: 'Ultimate Reverse',points: 30, wild: false, chaos: true, action: true,
                  desc: 'Reverses direction and skips the next player.' },
  steal3:       { label: 'Steal Three',     points: 30, wild: false, chaos: true, action: true,
                  desc: 'Take three random cards from a player of your choice (they always keep at least two).' },
  colorlock:    { label: 'Color Lock',      points: 50, wild: true,  chaos: true, action: true,
                  desc: 'Choose a color and lock it for two rounds. Only that color (or wilds) can be played.' },
  destroyer:    { label: 'Hand Destroyer',  points: 30, wild: false, chaos: true, action: true,
                  desc: 'An opponent of your choice discards three random cards (they always keep at least two).' },
  chaoswild:    { label: 'Chaos Wild',      points: 50, wild: true,  chaos: true, action: true,
                  desc: 'Choose a color and immediately unleash a random Chaos Event.' },
  mirror:       { label: 'Mirror',          points: 50, wild: true,  chaos: true, action: true,
                  desc: 'Reflect an incoming draw penalty back onto the attacker. Otherwise acts as a Wild.' },
  shufflehands: { label: 'Shuffle Hands',   points: 50, wild: true,  chaos: true, action: true,
                  desc: 'Collect every hand and deal the cards back out evenly, starting with the next player.' },
  laststand:    { label: 'Last Stand',      points: 50, wild: true,  chaos: true, action: true,
                  desc: 'Only playable when you hold two cards or fewer. Every opponent draws five.' },
  // ---- HERO cards (Chaos only, extremely rare, one per player per match) ----
  hero_superman: { label: 'Superman', title: 'The Man of Steel', power: 'Super Speed', points: 100, wild: true, chaos: true, action: true, hero: true,
                  desc: 'Take 4 consecutive turns. Nobody can interrupt, catch you or call Mercy until you finish.' },
  hero_cap:      { label: 'Captain America', title: 'The First Avenger', power: 'Vibranium Shield', points: 100, wild: true, chaos: true, action: true, hero: true,
                  desc: 'A shield protects you for one round: draw stacks, Skips and attacks aimed at you rebound onto the attacker. Can be played instantly against a draw stack. Other HERO abilities pierce it.' },
  hero_sentry:   { label: 'Sentry', title: 'The Golden Guardian', power: 'Power of a Million Exploding Suns', points: 100, wild: true, chaos: true, action: true, hero: true,
                  desc: 'Every opponent draws 15. Your hand is set aside and you hold one golden card for a round: if it exactly matches the top card (number AND color) when your turn comes, you win. Otherwise your hand returns.' },
  hero_thor:     { label: 'Thor', title: 'God of Thunder', power: "Mjolnir's Wrath", points: 100, wild: true, chaos: true, action: true, hero: true,
                  desc: 'Mjolnir circles the table: each opponent in turn draws +4, +8, +12… and loses their next turn.' },
};

export const HERO_TYPES = ['hero_superman', 'hero_cap', 'hero_sentry', 'hero_thor'];
export const isHero = (card) => !!card && card.type.startsWith('hero_');

export const CHAOS_CARD_COUNTS = {
  plus10: 2, everyone4: 2, colorlock: 2, chaoswild: 3, mirror: 3, shufflehands: 2, laststand: 2,
  // colored chaos cards: one per color
  ultreverse: 4, steal3: 4, destroyer: 4,
};

export const isWild = (card) => card.color === 'wild';
export const cardPoints = (card) => (card.type === 'number' ? card.value : CARD_TYPES[card.type].points);
export const isDrawType = (type) => type === 'draw2' || type === 'wild4' || type === 'plus10';
export const DRAW_VALUE = { draw2: 2, wild4: 4, plus10: 10 };
export const STACK_RANK = { draw2: 1, wild4: 2, plus10: 3 };

export function cardLabel(card) {
  const color = card.color === 'wild' ? '' : COLOR_NAMES[card.color] + ' ';
  if (card.type === 'number') return `${color}${card.value}`;
  return `${color}${CARD_TYPES[card.type].label}`;
}

// Build one full deck. `nextId` is a function returning a fresh unique id.
export function makeDeck(mode, nextId) {
  const cards = [];
  const add = (color, type, value = null) => cards.push({ id: nextId(), color, type, value });
  for (const color of COLORS) {
    add(color, 'number', 0);
    for (let v = 1; v <= 9; v++) { add(color, 'number', v); add(color, 'number', v); }
    for (const t of ['skip', 'reverse', 'draw2']) { add(color, t); add(color, t); }
  }
  for (let i = 0; i < 4; i++) { add('wild', 'wild'); add('wild', 'wild4'); }
  if (mode === 'chaos') {
    for (const type of HERO_TYPES) add('wild', type);
    for (const [type, count] of Object.entries(CHAOS_CARD_COUNTS)) {
      if (CARD_TYPES[type].wild) {
        for (let i = 0; i < count; i++) add('wild', type);
      } else {
        for (const color of COLORS) add(color, type);
      }
    }
  }
  return cards;
}

// Sort key used for displaying a hand.
const TYPE_ORDER = ['number', 'skip', 'reverse', 'draw2', 'ultreverse', 'steal3', 'destroyer',
  'wild', 'wild4', 'colorlock', 'chaoswild', 'mirror', 'shufflehands', 'plus10', 'everyone4', 'laststand',
  'hero_superman', 'hero_cap', 'hero_sentry', 'hero_thor'];
export function handSortKey(card) {
  const ci = card.color === 'wild' ? 4 : COLORS.indexOf(card.color);
  return ci * 1000 + TYPE_ORDER.indexOf(card.type) * 20 + (card.value ?? 0);
}
