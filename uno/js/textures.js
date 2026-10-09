// Procedural canvas textures: card faces, card backs and table materials.
// Everything is drawn at runtime, so the game ships with no image assets.

import { COLOR_HEX, CARD_TYPES } from './cards.js';

export const CARD_PX = { w: 512, h: 794 };
const FONT = '"Lilita One", "Arial Black", Impact, sans-serif';

const SHADE = {
  red: ['#ff4a4f', '#c3121b'],
  yellow: ['#ffd84a', '#e0a800'],
  green: ['#3fc263', '#16793a'],
  blue: ['#3d8cff', '#0f4fae'],
  wild: ['#2a2a2a', '#070707'],
};

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function canvas(w = CARD_PX.w, h = CARD_PX.h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function noise(ctx, w, h, alpha = 0.05, scale = 1) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 255 * alpha * scale;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

// Outlined, shadowed headline text (the classic chunky card numerals).
function bigText(ctx, text, x, y, size, fill, stroke = '#111', strokeW = size * 0.07, rot = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  // drop shadow
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = strokeW;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, size * 0.05, size * 0.05);
  ctx.fillText(text, size * 0.05, size * 0.05);
  ctx.strokeStyle = stroke;
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = fill;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function skipIcon(ctx, x, y, r, color, lw) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = lw * 1.9;
  ctx.strokeStyle = '#111';
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-r * 0.7, r * 0.7); ctx.lineTo(r * 0.7, -r * 0.7); ctx.stroke();
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-r * 0.7, r * 0.7); ctx.lineTo(r * 0.7, -r * 0.7); ctx.stroke();
  ctx.restore();
}

function arrow(ctx, len, w) {
  ctx.beginPath();
  ctx.moveTo(-len / 2, -w / 2);
  ctx.lineTo(len / 2 - w, -w / 2);
  ctx.lineTo(len / 2 - w, -w * 1.2);
  ctx.lineTo(len / 2 + w * 0.4, 0);
  ctx.lineTo(len / 2 - w, w * 1.2);
  ctx.lineTo(len / 2 - w, w / 2);
  ctx.lineTo(-len / 2, w / 2);
  ctx.closePath();
}

function reverseIcon(ctx, x, y, s, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-Math.PI / 4);
  for (const dir of [1, -1]) {
    ctx.save();
    ctx.translate(0, dir * s * 0.22);
    ctx.scale(dir, 1);
    arrow(ctx, s, s * 0.2);
    ctx.lineWidth = s * 0.08;
    ctx.strokeStyle = '#111';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function miniCards(ctx, x, y, s, colors) {
  colors.forEach((col, i) => {
    ctx.save();
    ctx.translate(x + (i - (colors.length - 1) / 2) * s * 0.38, y + (i % 2 ? -1 : 1) * s * 0.06);
    ctx.rotate(-0.25 + i * 0.12);
    rr(ctx, -s * 0.24, -s * 0.36, s * 0.48, s * 0.72, s * 0.06);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = s * 0.03; ctx.strokeStyle = '#111'; ctx.stroke();
    rr(ctx, -s * 0.2, -s * 0.32, s * 0.4, s * 0.64, s * 0.05);
    ctx.fillStyle = col; ctx.fill();
    ctx.restore();
  });
}

function fourColorOval(ctx, cx, cy, rx, ry, rot) {
  const cols = [COLOR_HEX.red, COLOR_HEX.blue, COLOR_HEX.yellow, COLOR_HEX.green];
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.clip();
  cols.forEach((c, i) => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, Math.max(rx, ry) * 1.5, (i * Math.PI) / 2, ((i + 1) * Math.PI) / 2);
    ctx.closePath();
    ctx.fillStyle = c; ctx.fill();
  });
  ctx.restore();
}

function label(card) {
  switch (card.type) {
    case 'number': return String(card.value);
    case 'draw2': return '+2';
    case 'wild4': return '+4';
    case 'plus10': return '+10';
    case 'everyone4': return 'ALL+4';
    case 'steal3': return 'STEAL';
    case 'colorlock': return 'LOCK';
    case 'destroyer': return 'BOOM';
    case 'chaoswild': return 'CHAOS';
    case 'mirror': return 'MIRROR';
    case 'shufflehands': return 'SHUFFLE';
    case 'laststand': return 'LAST';
    case 'ultreverse': return 'ULT';
    default: return '';
  }
}

function cornerMark(ctx, card, fill) {
  const t = card.type;
  const draw = (x, y, rot) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    if (t === 'skip') skipIcon(ctx, 0, 0, 30, '#fff', 9);
    else if (t === 'reverse') reverseIcon(ctx, 0, 0, 70, '#fff');
    else if (t === 'wild') fourColorOval(ctx, 0, 0, 26, 38, 0.45);
    else {
      const txt = label(card);
      const size = txt.length > 3 ? 34 : txt.length > 2 ? 52 : 74;
      bigText(ctx, txt, 0, 0, size, fill || '#fff', '#111', size * 0.12);
    }
    ctx.restore();
  };
  draw(80, 98, 0);
  draw(CARD_PX.w - 80, CARD_PX.h - 98, Math.PI);
}

// ------------------------------------------------------------------ faces
export function drawCardFace(card) {
  if (card.type.startsWith('hero_')) return drawHeroFace(card);
  const c = canvas();
  const ctx = c.getContext('2d');
  const { w, h } = CARD_PX;
  const info = CARD_TYPES[card.type];
  const chaos = info.chaos;
  const base = card.color;

  // White card stock with soft edge vignette.
  rr(ctx, 0, 0, w, h, 46);
  ctx.fillStyle = '#fbfaf6';
  ctx.fill();

  // Inner colored field.
  const inset = 24;
  rr(ctx, inset, inset, w - inset * 2, h - inset * 2, 30);
  const [hi, lo] = SHADE[base];
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, hi); g.addColorStop(1, lo);
  ctx.fillStyle = g;
  ctx.fill();

  if (chaos) {
    ctx.save();
    rr(ctx, inset, inset, w - inset * 2, h - inset * 2, 30);
    ctx.clip();
    // dark radial core with neon glow
    const rg = ctx.createRadialGradient(w / 2, h / 2, 40, w / 2, h / 2, h * 0.65);
    rg.addColorStop(0, base === 'wild' ? 'rgba(170,40,255,0.55)' : 'rgba(0,0,0,0.0)');
    rg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
    // hazard stripes
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = '#000';
    for (let i = -h; i < w + h; i += 46) {
      ctx.beginPath();
      ctx.moveTo(i, 0); ctx.lineTo(i + 22, 0); ctx.lineTo(i + 22 - h, h); ctx.lineTo(i - h, h);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // lightning crackle
    ctx.strokeStyle = 'rgba(255,90,255,0.55)';
    ctx.lineWidth = 3;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      let x = Math.random() * w;
      let y = 0;
      ctx.moveTo(x, y);
      while (y < h) { x += (Math.random() - 0.5) * 60; y += 30 + Math.random() * 40; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    ctx.restore();
    // neon border
    rr(ctx, inset + 6, inset + 6, w - inset * 2 - 12, h - inset * 2 - 12, 26);
    ctx.lineWidth = 7;
    const ng = ctx.createLinearGradient(0, 0, w, h);
    ng.addColorStop(0, '#ff2bd6'); ng.addColorStop(0.5, '#8a2bff'); ng.addColorStop(1, '#22e0ff');
    ctx.strokeStyle = ng;
    ctx.shadowColor = '#ff2bd6';
    ctx.shadowBlur = 18;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Center tilted oval.
  const cx = w / 2;
  const cy = h / 2;
  const rx = 182;
  const ry = 318;
  const rot = 0.42;
  if (card.type === 'wild' || card.type === 'wild4') {
    fourColorOval(ctx, cx, cy, rx, ry, rot);
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.lineWidth = 10; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.restore();
  } else {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    if (chaos) {
      const og = ctx.createRadialGradient(0, 0, 10, 0, 0, ry);
      og.addColorStop(0, base === 'wild' ? '#3a0f57' : 'rgba(255,255,255,0.97)');
      og.addColorStop(1, base === 'wild' ? '#12031f' : 'rgba(235,235,235,0.97)');
      ctx.fillStyle = og;
    } else ctx.fillStyle = '#fdfdfb';
    ctx.fill();
    if (chaos) { ctx.lineWidth = 6; ctx.strokeStyle = '#ff2bd6'; ctx.stroke(); }
    ctx.restore();
  }

  const ink = base === 'wild' ? '#fff' : COLOR_HEX[base];
  // Center symbol.
  switch (card.type) {
    case 'number':
      bigText(ctx, String(card.value), cx, cy + 10, 300, ink, '#111', 18);
      if (card.value === 6 || card.value === 9) {
        ctx.fillStyle = '#111'; ctx.fillRect(cx - 60, cy + 150, 120, 16);
        ctx.fillStyle = ink; ctx.fillRect(cx - 54, cy + 153, 108, 10);
      }
      break;
    case 'skip': skipIcon(ctx, cx, cy, 112, ink, 36); break;
    case 'reverse': reverseIcon(ctx, cx, cy, 260, ink); break;
    case 'draw2': miniCards(ctx, cx, cy, 220, [ink, ink]); break;
    case 'wild': break;
    case 'wild4':
      miniCards(ctx, cx, cy, 170, [COLOR_HEX.blue, COLOR_HEX.green, COLOR_HEX.red, COLOR_HEX.yellow]);
      break;
    default: {
      // Chaos cards: big glowing label + subtitle.
      const txt = label(card);
      // Fit the headline inside the oval.
      let size = 230;
      ctx.font = `${size}px ${FONT}`;
      const maxW = 330;
      const tw = ctx.measureText(txt).width;
      if (tw > maxW) size = Math.floor((size * maxW) / tw);
      ctx.save();
      ctx.shadowColor = '#ff2bd6';
      ctx.shadowBlur = 30;
      bigText(ctx, txt, cx, cy - 10, size, base === 'wild' ? '#ffe9ff' : ink, '#111', size * 0.09, -0.12);
      ctx.restore();
      ctx.font = `38px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = base === 'wild' ? '#ffb8f5' : '#222';
      const sub = info.label.toUpperCase();
      const sw = ctx.measureText(sub).width;
      if (sw > 300) ctx.font = `${Math.floor((38 * 300) / sw)}px ${FONT}`;
      ctx.fillText(sub, cx, cy + 150);
    }
  }
  if (card.type === 'wild4') bigText(ctx, '+4', cx, cy + 210, 110, '#fff', '#111', 12);

  if (chaos) {
    // CHAOS tag
    ctx.save();
    ctx.translate(w / 2, 58);
    rr(ctx, -78, -22, 156, 44, 20);
    ctx.fillStyle = '#12031f'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#ff2bd6'; ctx.stroke();
    ctx.font = `30px ${FONT}`; ctx.fillStyle = '#ff7bf0'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('CHAOS', 0, 2);
    ctx.restore();
  }
  cornerMark(ctx, card, '#fff');

  // Gloss: diagonal sheen.
  ctx.save();
  rr(ctx, 0, 0, w, h, 46);
  ctx.clip();
  const sheen = ctx.createLinearGradient(0, 0, w, h * 0.7);
  sheen.addColorStop(0, 'rgba(255,255,255,0.22)');
  sheen.addColorStop(0.35, 'rgba(255,255,255,0.04)');
  sheen.addColorStop(0.36, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  noise(ctx, w, h, 0.035);
  return c;
}

// ------------------------------------------------------------------ backs
export const CARD_BACKS = {
  classic: { name: 'Classic', field: ['#1b1b1b', '#000'], oval: ['#ff3b30', '#b8000b'], text: '#ffd60a', stars: false },
  midnight: { name: 'Midnight', field: ['#0b1a3a', '#020814'], oval: ['#1e8bff', '#0a3c8c'], text: '#9ff3ff', stars: false },
  royal: { name: 'Royal Gold', field: ['#1a1206', '#060402'], oval: ['#d4a017', '#7a5600'], text: '#fff4c2', stars: false },
  galaxy: { name: 'Million Stars', field: ['#1a0b3a', '#05010f'], oval: ['#7b2bff', '#2b0a6b'], text: '#ffe066', stars: true },
};

export function drawCardBack(style = 'classic') {
  const s = CARD_BACKS[style] || CARD_BACKS.classic;
  const c = canvas();
  const ctx = c.getContext('2d');
  const { w, h } = CARD_PX;
  rr(ctx, 0, 0, w, h, 46);
  ctx.fillStyle = '#fbfaf6';
  ctx.fill();
  rr(ctx, 24, 24, w - 48, h - 48, 30);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, s.field[0]); g.addColorStop(1, s.field[1]);
  ctx.fillStyle = g;
  ctx.fill();
  if (s.stars) {
    ctx.save();
    rr(ctx, 24, 24, w - 48, h - 48, 30);
    ctx.clip();
    for (let i = 0; i < 260; i++) {
      const r = Math.random() ** 3 * 2.6 + 0.4;
      ctx.fillStyle = `rgba(255,255,255,${0.35 + Math.random() * 0.65})`;
      ctx.beginPath(); ctx.arc(Math.random() * w, Math.random() * h, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(0.42);
  ctx.beginPath(); ctx.ellipse(0, 0, 175, 300, 0, 0, Math.PI * 2);
  const og = ctx.createRadialGradient(-40, -80, 20, 0, 0, 300);
  og.addColorStop(0, s.oval[0]); og.addColorStop(1, s.oval[1]);
  ctx.fillStyle = og;
  ctx.fill();
  ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
  ctx.restore();
  bigText(ctx, 'UNO', w / 2, h / 2, 170, s.text, '#111', 16, -0.35);
  ctx.save();
  rr(ctx, 0, 0, w, h, 46);
  ctx.clip();
  const sheen = ctx.createLinearGradient(0, 0, w, h * 0.7);
  sheen.addColorStop(0, 'rgba(255,255,255,0.2)');
  sheen.addColorStop(0.4, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  noise(ctx, w, h, 0.03);
  return c;
}

// Small 2D card thumbnail for the HUD/rules screens.
export function cardThumbDataURL(card, width = 90) {
  const src = drawCardFace(card);
  const c = canvas(width, Math.round(width * 1.55));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL();
}

// ------------------------------------------------------------------ table surfaces
export function drawFelt(color = '#0f6b3a', size = 1024) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  // Baked ambient occlusion: darker toward the rim.
  const rg = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.52);
  rg.addColorStop(0, 'rgba(255,255,255,0.10)');
  rg.addColorStop(0.75, 'rgba(0,0,0,0.05)');
  rg.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, size, 0.09);
  // fibers
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 9000; i++) {
    ctx.strokeStyle = Math.random() < 0.5 ? '#fff' : '#000';
    const x = Math.random() * size;
    const y = Math.random() * size;
    const a = Math.random() * Math.PI;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * 4, y + Math.sin(a) * 4); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return c;
}

export function drawWood(base = '#5a2f17', size = 1024, rings = true) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 180; i++) {
    const y = Math.random() * size;
    ctx.strokeStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,220,170'},${0.04 + Math.random() * 0.08})`;
    ctx.lineWidth = 1 + Math.random() * 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= size; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.01 + i) * (rings ? 8 : 3));
    ctx.stroke();
  }
  noise(ctx, size, size, 0.05);
  return c;
}

export function drawCarpet(a = '#3a0c12', b = '#5a1219', size = 512) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = b;
  ctx.lineWidth = 10;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      ctx.save();
      ctx.translate(i * 128 + 64, j * 128 + 64);
      ctx.rotate(Math.PI / 4);
      ctx.strokeRect(-36, -36, 72, 72);
      ctx.restore();
    }
  }
  ctx.fillStyle = 'rgba(212,160,23,0.35)';
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    ctx.beginPath(); ctx.arc(i * 128 + 64, j * 128 + 64, 8, 0, Math.PI * 2); ctx.fill();
  }
  noise(ctx, size, size, 0.12);
  return c;
}

export function drawNeonSign(text, color = '#ff2bd6', w = 1024, h = 256) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.font = `${h * 0.62}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  for (const blur of [60, 30, 12]) {
    ctx.shadowBlur = blur;
    ctx.fillStyle = color;
    ctx.fillText(text, w / 2, h / 2);
  }
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#fff';
  ctx.globalAlpha = 0.85;
  ctx.fillText(text, w / 2, h / 2);
  return c;
}

// ------------------------------------------------------------------ surface detail (normal maps)
// Convert a grayscale height canvas into a tangent-space normal map.
export function heightToNormal(src, strength = 2) {
  const w = src.width;
  const h = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, w, h).data;
  const out = canvas(w, h);
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const d = img.data;
  const H = (x, y) => sd[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      d[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      d[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function grayNoise(size, blobs, fibers, base = 128) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = `rgb(${base},${base},${base})`;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < blobs; i++) {
    const v = Math.floor(Math.random() * 255);
    ctx.fillStyle = `rgba(${v},${v},${v},0.08)`;
    const r = 1 + Math.random() * 3;
    ctx.beginPath(); ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.lineCap = 'round';
  for (let i = 0; i < fibers; i++) {
    const v = Math.random() < 0.5 ? 255 : 0;
    ctx.strokeStyle = `rgba(${v},${v},${v},0.12)`;
    ctx.lineWidth = 0.6 + Math.random();
    const x = Math.random() * size;
    const y = Math.random() * size;
    const a = Math.random() * Math.PI * 2;
    const l = 2 + Math.random() * 5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  return c;
}

// Felt: matted fibers.
export const feltNormal = () => heightToNormal(grayNoise(512, 4000, 26000), 2.2);
// Card stock: very fine paper tooth.
export const paperNormal = () => heightToNormal(grayNoise(256, 9000, 1200), 0.9);
// Leather: pebbled grain.
export function leatherNormal() {
  const c = canvas(512, 512);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const r = 2 + Math.random() * 5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  return heightToNormal(c, 3);
}
// Wood: grain lines become shallow grooves.
export function woodNormal() {
  const c = canvas(512, 512);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 140; i++) {
    const y = Math.random() * 512;
    ctx.strokeStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.15})`;
    ctx.lineWidth = 1 + Math.random() * 3;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= 512; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.02 + i) * 4);
    ctx.stroke();
  }
  return heightToNormal(c, 1.6);
}

// Casino felt with printed playing-area markings.
export function drawCasinoFelt(color, size = 2048) {
  const c = drawFelt(color, size);
  const ctx = c.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.strokeStyle = '#f3d27a';
  ctx.lineWidth = size * 0.004;
  for (const [rx, ry] of [[0.36, 0.33], [0.345, 0.315]]) {
    ctx.beginPath(); ctx.ellipse(cx, cy, size * rx, size * ry, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 0.09;
  ctx.fillStyle = '#ffffff';
  ctx.font = `${size * 0.05}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * size * 0.4, cy + Math.sin(a) * size * 0.375);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText('★', 0, 0);
    ctx.restore();
  }
  ctx.font = `${size * 0.028}px ${FONT}`;
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#f3d27a';
  ctx.fillText('MATCH COLOR · NUMBER · SYMBOL', cx, cy + size * 0.27);
  ctx.save();
  ctx.translate(cx, cy - size * 0.27);
  ctx.rotate(Math.PI);
  ctx.fillText('FIRST TO EMPTY THEIR HAND WINS', 0, 0);
  ctx.restore();
  ctx.restore();
  return c;
}

// ------------------------------------------------------------------ HERO card faces
// Original procedural designs (no official artwork): foil card, gold frame, emblem.
export const HERO_STYLE = {
  hero_superman: { name: 'SUPERMAN', title: 'THE MAN OF STEEL', power: 'SUPER SPEED', bg: ['#1b4fd8', '#08123f'], accent: '#e8202a', glow: '#5aa0ff' },
  hero_cap: { name: 'CAPTAIN AMERICA', title: 'THE FIRST AVENGER', power: 'VIBRANIUM SHIELD', bg: ['#1d3c8f', '#0a1230'], accent: '#d8202a', glow: '#ffffff' },
  hero_sentry: { name: 'SENTRY', title: 'THE GOLDEN GUARDIAN', power: 'A MILLION EXPLODING SUNS', bg: ['#f5c242', '#6b3c00'], accent: '#fff3b0', glow: '#ffd34d' },
  hero_thor: { name: 'THOR', title: 'GOD OF THUNDER', power: "MJOLNIR'S WRATH", bg: ['#3b4a63', '#0b0f1a'], accent: '#7fd4ff', glow: '#9fe3ff' },
};

function heroEmblem(ctx, type, cx, cy, s) {
  ctx.save();
  ctx.translate(cx, cy);
  if (type === 'hero_superman') {
    // Speed chevrons inside a crest shape.
    ctx.beginPath();
    ctx.moveTo(-s * 0.9, -s * 0.55); ctx.lineTo(s * 0.9, -s * 0.55); ctx.lineTo(s * 1.05, -s * 0.2); ctx.lineTo(0, s * 0.95); ctx.lineTo(-s * 1.05, -s * 0.2); ctx.closePath();
    ctx.fillStyle = '#f7d21e'; ctx.fill();
    ctx.lineWidth = s * 0.09; ctx.strokeStyle = '#b8000b'; ctx.stroke();
    ctx.fillStyle = '#e8202a';
    for (let k = 0; k < 3; k++) {
      const y = -s * 0.32 + k * s * 0.32;
      ctx.beginPath();
      ctx.moveTo(-s * 0.55 + k * s * 0.12, y); ctx.lineTo(0, y + s * 0.22); ctx.lineTo(s * 0.55 - k * s * 0.12, y);
      ctx.lineTo(s * 0.55 - k * s * 0.12, y + s * 0.1); ctx.lineTo(0, y + s * 0.32); ctx.lineTo(-s * 0.55 + k * s * 0.12, y + s * 0.1);
      ctx.closePath(); ctx.fill();
    }
  } else if (type === 'hero_cap') {
    const rings = ['#d8202a', '#f4f4f4', '#d8202a', '#1d4fbf'];
    rings.forEach((c, i) => {
      ctx.beginPath(); ctx.arc(0, 0, s * (1 - i * 0.22), 0, Math.PI * 2);
      const g = ctx.createRadialGradient(-s * 0.3, -s * 0.3, 0, 0, 0, s);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, c); g.addColorStop(1, c);
      ctx.fillStyle = g; ctx.fill();
    });
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = k % 2 ? s * 0.13 : s * 0.33;
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill();
  } else if (type === 'hero_sentry') {
    for (let k = 0; k < 24; k++) {
      ctx.save();
      ctx.rotate((k * Math.PI) / 12);
      ctx.beginPath(); ctx.moveTo(-s * 0.06, 0); ctx.lineTo(0, -s * (k % 2 ? 1.05 : 1.35)); ctx.lineTo(s * 0.06, 0); ctx.closePath();
      ctx.fillStyle = k % 2 ? '#ffe7a0' : '#fff8dc'; ctx.fill();
      ctx.restore();
    }
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.6);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, '#ffe066'); g.addColorStop(1, '#f2a900');
    ctx.beginPath(); ctx.arc(0, 0, s * 0.55, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  } else if (type === 'hero_thor') {
    // Lightning behind a hammer silhouette.
    ctx.strokeStyle = '#bfefff'; ctx.lineWidth = s * 0.05; ctx.shadowColor = '#7fd4ff'; ctx.shadowBlur = 30;
    for (const dir of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(dir * s * 0.2, -s * 1.2);
      ctx.lineTo(dir * s * 0.6, -s * 0.5); ctx.lineTo(dir * s * 0.35, -s * 0.4); ctx.lineTo(dir * s * 0.95, s * 0.3); ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.rotate(-0.35);
    const mg = ctx.createLinearGradient(-s, -s * 0.6, s, s * 0.2);
    mg.addColorStop(0, '#e9eef5'); mg.addColorStop(0.5, '#8d97a8'); mg.addColorStop(1, '#4b5263');
    rr(ctx, -s * 0.75, -s * 0.75, s * 1.5, s * 0.75, s * 0.1);
    ctx.fillStyle = mg; ctx.fill(); ctx.lineWidth = s * 0.04; ctx.strokeStyle = '#1b1f28'; ctx.stroke();
    rr(ctx, -s * 0.11, -s * 0.02, s * 0.22, s * 1.05, s * 0.06);
    ctx.fillStyle = '#6b4226'; ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c9a35a';
    rr(ctx, -s * 0.15, s * 0.95, s * 0.3, s * 0.12, s * 0.04); ctx.fill();
  }
  ctx.restore();
}

export function drawHeroFace(card) {
  const st = HERO_STYLE[card.type];
  const c = canvas();
  const ctx = c.getContext('2d');
  const { w, h } = CARD_PX;
  rr(ctx, 0, 0, w, h, 46);
  const frame = ctx.createLinearGradient(0, 0, w, h);
  frame.addColorStop(0, '#fff2b8'); frame.addColorStop(0.3, '#d4a017'); frame.addColorStop(0.55, '#fff6d0'); frame.addColorStop(0.8, '#a87a12'); frame.addColorStop(1, '#ffe08a');
  ctx.fillStyle = frame; ctx.fill();
  rr(ctx, 20, 20, w - 40, h - 40, 32);
  const bg = ctx.createRadialGradient(w / 2, h * 0.42, 20, w / 2, h / 2, h * 0.7);
  bg.addColorStop(0, st.bg[0]); bg.addColorStop(1, st.bg[1]);
  ctx.fillStyle = bg; ctx.fill();
  ctx.save();
  rr(ctx, 20, 20, w - 40, h - 40, 32); ctx.clip();
  // radiating light rays
  ctx.globalAlpha = 0.18;
  for (let k = 0; k < 18; k++) {
    ctx.save(); ctx.translate(w / 2, h * 0.42); ctx.rotate((k * Math.PI) / 9);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-30, -h); ctx.lineTo(30, -h); ctx.closePath();
    ctx.fillStyle = st.glow; ctx.fill(); ctx.restore();
  }
  ctx.globalAlpha = 1;
  heroEmblem(ctx, card.type, w / 2, h * 0.42, 150);
  // holographic foil
  const holo = ctx.createLinearGradient(0, 0, w, h);
  ['rgba(255,0,128,0.10)', 'rgba(255,200,0,0.08)', 'rgba(0,255,180,0.08)', 'rgba(0,140,255,0.10)', 'rgba(200,0,255,0.08)'].forEach((col, i) => holo.addColorStop(i / 4, col));
  ctx.fillStyle = holo; ctx.fillRect(0, 0, w, h);
  ctx.restore();
  // HERO banner
  ctx.save();
  ctx.translate(w / 2, 70);
  rr(ctx, -95, -26, 190, 52, 24);
  ctx.fillStyle = '#120a00'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = '#ffd34d'; ctx.stroke();
  ctx.font = `36px ${FONT}`; ctx.fillStyle = '#ffd34d'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('★ HERO ★', 0, 2);
  ctx.restore();
  // name / title / power
  const fit = (text, size, maxW) => { ctx.font = `${size}px ${FONT}`; const tw = ctx.measureText(text).width; return tw > maxW ? Math.floor((size * maxW) / tw) : size; };
  const nameSize = fit(st.name, 64, w - 90);
  bigText(ctx, st.name, w / 2, h * 0.73, nameSize, '#ffffff', '#120a00', nameSize * 0.12);
  ctx.font = `26px ${FONT}`; ctx.textAlign = 'center'; ctx.fillStyle = st.accent;
  ctx.fillText(st.title, w / 2, h * 0.79);
  ctx.save();
  ctx.translate(w / 2, h * 0.87);
  rr(ctx, -(w - 90) / 2, -26, w - 90, 52, 18);
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fill(); ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 2; ctx.stroke();
  const ps = fit(st.power, 30, w - 120);
  ctx.font = `${ps}px ${FONT}`; ctx.fillStyle = '#ffe9a0'; ctx.textBaseline = 'middle';
  ctx.fillText(st.power, 0, 2);
  ctx.restore();
  // corner stars
  for (const [x, y, r] of [[60, 60, 0], [w - 60, h - 60, Math.PI]]) bigText(ctx, '★', x, y, 52, '#ffd34d', '#120a00', 6, r);
  noise(ctx, w, h, 0.03);
  return c;
}
