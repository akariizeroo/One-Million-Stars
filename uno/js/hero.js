// HERO card cinematics: stylized original 3D hero figures, signature visual effects
// and persistent table markers (Captain America's shield, Sentry's golden aura).

import * as THREE from 'three';
import { HERO_STYLE, drawHeroFace } from './textures.js';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const out = (t) => 1 - Math.pow(1 - t, 3);
const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);

function emblemTexture(type, size = 256) {
  // Crop the emblem area of the hero card art.
  const face = drawHeroFace({ type });
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const sx = face.width * 0.18;
  const sy = face.height * 0.42 - face.width * 0.32;
  c.getContext('2d').drawImage(face, sx, sy, face.width * 0.64, face.width * 0.64, 0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function shieldTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const rings = ['#c8141e', '#f2f2f2', '#c8141e', '#1d4fbf'];
  rings.forEach((col, i) => { ctx.beginPath(); ctx.arc(128, 128, 128 - i * 28, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); });
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? 17 : 42;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    ctx.lineTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r);
  }
  ctx.closePath(); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SUITS = {
  superman: { suit: 0x1b4fd8, cape: 0xd8202a, trim: 0xd8202a, metal: 0.1 },
  cap: { suit: 0x1d3c8f, cape: null, trim: 0xd8202a, metal: 0.15 },
  sentry: { suit: 0xd9a91f, cape: 0x1d3c8f, trim: 0x1d3c8f, metal: 0.55 },
  thor: { suit: 0x3b4a63, cape: 0xa0141c, trim: 0xc0c8d6, metal: 0.8 },
};

export class HeroFX {
  constructor(renderer) {
    this.r = renderer;
    this.items = [];
    this.shields = new Map();
    this.auras = new Map();
    this.hammer = null;
    this.shieldTex = shieldTexture();
    renderer.updaters.push((dt, t) => this.update(dt, t));
  }

  get speed() { return this.r.speed || 1; }
  wait(ms) { return new Promise((res) => setTimeout(res, ms / this.speed)); }

  // ---------------------------------------------------------------- figures
  buildFigure(hero) {
    const S = SUITS[hero];
    const g = new THREE.Group();
    const suit = new THREE.MeshPhysicalMaterial({ color: S.suit, roughness: 0.32, metalness: S.metal, clearcoat: 0.6, clearcoatRoughness: 0.2,
      emissive: hero === 'sentry' ? 0x7a5200 : 0x000000, emissiveIntensity: 0.6 });
    const trim = new THREE.MeshPhysicalMaterial({ color: S.trim, roughness: 0.35, metalness: 0.4, clearcoat: 0.5 });
    const skin = new THREE.MeshPhysicalMaterial({ color: 0xd9a37a, roughness: 0.55, sheen: 0.5, sheenColor: new THREE.Color('#ffd0b0') });
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
      m.castShadow = true;
      g.add(m);
      return m;
    };
    add(new THREE.CapsuleGeometry(0.3, 0.62, 8, 16), suit, 0, 1.3, 0); // torso
    add(new THREE.SphereGeometry(0.33, 20, 16), suit, 0, 1.55, 0).scale.set(1.25, 0.75, 0.9); // chest/shoulders
    const head = add(new THREE.SphereGeometry(0.2, 24, 18), hero === 'cap' || hero === 'thor' ? suit : skin, 0, 2.08, 0);
    head.scale.set(0.95, 1.1, 1);
    if (hero !== 'cap' && hero !== 'thor') add(new THREE.SphereGeometry(0.205, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.45), new THREE.MeshPhysicalMaterial({ color: hero === 'sentry' ? 0xf2d27a : 0x111111, roughness: 0.4 }), 0, 2.12, -0.01);
    if (hero === 'cap' || hero === 'thor') add(new THREE.SphereGeometry(0.16, 16, 12, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.4), skin, 0, 2.02, 0.06);
    add(new THREE.CylinderGeometry(0.09, 0.11, 0.16, 12), skin, 0, 1.86, 0); // neck
    add(new THREE.TorusGeometry(0.29, 0.045, 8, 24), trim, 0, 0.98, 0, Math.PI / 2); // belt
    const armL = add(new THREE.CapsuleGeometry(0.095, 0.62, 6, 10), suit, -0.48, 1.35, 0, 0, 0, 0.2);
    const armR = add(new THREE.CapsuleGeometry(0.095, 0.62, 6, 10), suit, 0.48, 1.35, 0, 0, 0, -0.2);
    add(new THREE.CapsuleGeometry(0.12, 0.72, 6, 10), suit, -0.16, 0.48, 0, 0, 0, 0.04);
    add(new THREE.CapsuleGeometry(0.12, 0.72, 6, 10), suit, 0.16, 0.48, 0, 0, 0, -0.04);
    for (const x of [-0.16, 0.16]) add(new THREE.CapsuleGeometry(0.125, 0.22, 6, 10), trim, x, 0.08, 0.03);
    // chest emblem
    const emb = new THREE.Mesh(new THREE.CircleGeometry(0.2, 32), new THREE.MeshBasicMaterial({ map: emblemTexture(`hero_${hero}`), transparent: true }));
    emb.position.set(0, 1.55, 0.3);
    g.add(emb);
    let cape = null;
    if (S.cape) {
      const geo = new THREE.PlaneGeometry(0.95, 1.5, 10, 16);
      geo.translate(0, -0.75, 0);
      cape = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ color: S.cape, roughness: 0.6, sheen: 1, sheenColor: hdr(S.cape, 1.4), side: THREE.DoubleSide }));
      cape.position.set(0, 1.78, -0.28);
      cape.rotation.x = 0.12;
      cape.castShadow = true;
      cape.userData.base = geo.attributes.position.array.slice();
      g.add(cape);
    }
    let prop = null;
    if (hero === 'cap') {
      prop = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 48), [
        new THREE.MeshPhysicalMaterial({ color: 0xbfc4cc, metalness: 1, roughness: 0.3 }),
        new THREE.MeshPhysicalMaterial({ map: this.shieldTex, metalness: 0.5, roughness: 0.3, clearcoat: 1 }),
        new THREE.MeshPhysicalMaterial({ color: 0x1d4fbf, metalness: 0.5, roughness: 0.4 }),
      ]);
      prop.rotation.x = Math.PI / 2;
      prop.position.set(-0.62, 1.35, 0.18);
      g.add(prop);
    }
    if (hero === 'thor') prop = this.buildHammer();
    if (prop && hero === 'thor') { prop.position.set(0.62, 1.0, 0.1); g.add(prop); }
    if (hero === 'sentry') {
      const aura = new THREE.Mesh(new THREE.SphereGeometry(1.4, 32, 24), new THREE.MeshBasicMaterial({ color: hdr(0xffc83d, 1.6), transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
      aura.position.y = 1.2;
      g.add(aura);
      g.userData.aura = aura;
    }
    g.userData = { ...g.userData, cape, prop, armL, armR, hero };
    return g;
  }

  buildHammer() {
    const h = new THREE.Group();
    const steel = new THREE.MeshPhysicalMaterial({ color: 0xaeb6c4, metalness: 1, roughness: 0.25, clearcoat: 0.4 });
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.3), steel);
    head.castShadow = true;
    h.add(head);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.55, 12), new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.7 }));
    handle.position.y = -0.4;
    h.add(handle);
    const strap = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 16), new THREE.MeshStandardMaterial({ color: 0x3b2414 }));
    strap.position.y = -0.7;
    h.add(strap);
    return h;
  }

  // ---------------------------------------------------------------- primitives
  pillar(color, x = 0, z = 0) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 16, 40, 1, true),
      new THREE.MeshBasicMaterial({ color: hdr(color, 1.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    m.position.set(x, 7.5, z);
    this.r.scene.add(m);
    return m;
  }

  lightning(from, to, color = 0xbfefff) {
    const pts = [];
    const segs = 14;
    for (let i = 0; i <= segs; i++) {
      const p = from.clone().lerp(to, i / segs);
      if (i > 0 && i < segs) p.add(new THREE.Vector3((Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.7));
      pts.push(p);
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: hdr(color, 4), transparent: true }));
    const glow = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.05, 6), new THREE.MeshBasicMaterial({ color: hdr(color, 2.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const light = new THREE.PointLight(color, 80, 14, 1.5);
    light.position.copy(to).add(new THREE.Vector3(0, 0.6, 0));
    this.r.scene.add(line, glow, light);
    this.items.push({ t: 0, life: 0.45, tick: (k) => {
      const flicker = Math.random() > 0.3 ? 1 : 0.2;
      line.material.opacity = (1 - k) * flicker;
      glow.material.opacity = (1 - k) * flicker;
      light.intensity = 80 * (1 - k) * flicker;
    }, done: () => { this.r.scene.remove(line, glow, light); line.geometry.dispose(); glow.geometry.dispose(); } });
  }

  seatPoint(pid, y = 0) {
    const p = this.r.seatPoint(pid).clone();
    p.y = y;
    return p;
  }

  // ---------------------------------------------------------------- cinematic
  async play(hero, pid) {
    const r = this.r;
    const st = HERO_STYLE[`hero_${hero}`];
    const glow = new THREE.Color(st.glow);
    const fig = this.buildFigure(hero);
    fig.position.set(0, -2.6, -0.2);
    fig.scale.setScalar(1.05);
    r.scene.add(fig);
    const pillar = this.pillar(glow);
    const light = new THREE.PointLight(glow, 0, 16, 1.4);
    light.position.set(0, 3, 1.5);
    r.scene.add(light);
    if (r.shakeEnabled) r.focus('hero', 0.9 / this.speed);
    r.burstAt(0, 0.2, 0, glow.getHex(), 220, 6, 1.4);
    r.shakeCamera(0.3, 0.6);

    // Rise out of the table in a pillar of light.
    const rise = { t: 0 };
    this.items.push({ t: 0, life: 1.1 / this.speed, tick: (k) => {
      rise.t = k;
      const e = out(k);
      fig.position.y = -2.6 + e * 2.6;
      fig.rotation.y = (1 - e) * Math.PI * 2;
      pillar.material.opacity = Math.sin(Math.PI * Math.min(1, k * 1.2)) * 0.5 + 0.15;
      light.intensity = 30 * e;
    } });
    this.items.push({ t: 0, life: 999, figure: fig, tick: (k, dt, time) => this.animateFigure(fig, time) });
    await this.wait(1300);

    // Signature move.
    if (hero === 'superman') await this.superSpeed(fig, glow);
    else if (hero === 'cap') await this.throwShield(fig, pid);
    else if (hero === 'sentry') await this.goldenSun(fig);
    else if (hero === 'thor') await this.summonThunder(fig);

    // Exit.
    this.items.push({ t: 0, life: 0.6 / this.speed, tick: (k) => {
      fig.scale.setScalar(1.05 * (1 - out(k)));
      pillar.material.opacity = 0.15 * (1 - k);
      light.intensity = 30 * (1 - k);
    }, done: () => {
      r.scene.remove(fig, pillar, light);
      this.items = this.items.filter((it) => it.figure !== fig);
      fig.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      pillar.geometry.dispose();
    } });
    await this.wait(500);
    if (r.shakeEnabled) r.focus('reset', 0.9 / this.speed);
  }

  animateFigure(fig, time) {
    const { cape, armL, armR, aura } = fig.userData;
    if (cape) {
      const pos = cape.geometry.attributes.position;
      const base = cape.userData.base;
      for (let i = 0; i < pos.count; i++) {
        const y = base[i * 3 + 1];
        const x = base[i * 3];
        const w = -y; // 0 at shoulders → 1.5 at hem
        pos.setZ(i, base[i * 3 + 2] - w * w * 0.35 - Math.sin(time * 6 + w * 4 + x * 2) * 0.08 * w);
      }
      pos.needsUpdate = true;
      cape.geometry.computeVertexNormals();
    }
    if (armL && fig.userData.pose !== 'strike') { armL.rotation.z = 0.2 + Math.sin(time * 2) * 0.05; armR.rotation.z = -0.2 - Math.sin(time * 2) * 0.05; }
    if (aura) { aura.scale.setScalar(1 + Math.sin(time * 4) * 0.06); aura.material.opacity = 0.16 + Math.sin(time * 5) * 0.05; }
    fig.position.y += Math.sin(time * 2.2) * 0.002;
  }

  async superSpeed(fig) {
    const r = this.r;
    const start = fig.position.clone();
    fig.userData.armR.rotation.z = -2.8;
    this.items.push({ t: 0, life: 1.6 / this.speed, tick: (k) => {
      const a = k * Math.PI * 4;
      const rad = 4.6 * Math.sin(Math.PI * Math.min(1, k * 1.15));
      fig.position.set(Math.sin(a) * rad * 1.15, 1 + Math.sin(k * Math.PI) * 1.2, Math.cos(a) * rad - 0.2);
      fig.rotation.set(-0.9 * Math.sin(Math.PI * k), a + Math.PI / 2, 0);
      if (Math.random() < 0.85) {
        r.burstAt(fig.position.x, fig.position.y + 1.2, fig.position.z, Math.random() < 0.5 ? 0x3d8cff : 0xff3b30, 10, 0.6, 0.6);
      }
    }, done: () => { fig.position.copy(start); fig.rotation.set(0, 0, 0); } });
    await this.wait(1650);
    r.shakeCamera(0.35, 0.5);
    r.burstAt(0, 1.5, 0, 0xffffff, 160, 7, 0.8);
  }

  async throwShield(fig, pid) {
    const prop = fig.userData.prop;
    fig.userData.pose = 'strike';
    fig.userData.armL.rotation.z = 1.6;
    await this.wait(250);
    const world = new THREE.Vector3();
    prop.getWorldPosition(world);
    fig.remove(prop);
    prop.position.copy(world);
    prop.rotation.set(Math.PI / 2, 0, 0);
    this.r.scene.add(prop);
    const target = this.shieldSpot(pid);
    const from = world.clone();
    this.items.push({ t: 0, life: 0.9 / this.speed, tick: (k) => {
      const e = ease(k);
      prop.position.lerpVectors(from, target, e);
      prop.position.y += Math.sin(Math.PI * k) * 1.4;
      prop.rotation.z += 0.6;
    }, done: () => this.attachShield(pid, prop) });
    await this.wait(950);
    this.r.burstAt(target.x, target.y, target.z, 0xffffff, 120, 4, 0.9);
    this.r.shakeCamera(0.2, 0.3);
  }

  shieldSpot(pid) {
    const s = this.r.seats[pid];
    if (!s || s.human) return new THREE.Vector3(-3.2, 1.2, 3.0);
    return s.pos.clone().multiplyScalar(0.78).setY(1.35);
  }

  attachShield(pid, mesh = null) {
    if (this.shields.has(pid)) return;
    let m = mesh;
    if (!m) {
      m = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 48), [
        new THREE.MeshPhysicalMaterial({ color: 0xbfc4cc, metalness: 1, roughness: 0.3 }),
        new THREE.MeshPhysicalMaterial({ map: this.shieldTex, metalness: 0.5, roughness: 0.3, clearcoat: 1 }),
        new THREE.MeshPhysicalMaterial({ color: 0x1d4fbf, metalness: 0.5, roughness: 0.4 }),
      ]);
      m.position.copy(this.shieldSpot(pid));
      this.r.scene.add(m);
    }
    m.scale.setScalar(1.6);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.82, 48), new THREE.MeshBasicMaterial({ color: hdr(0x9fd0ff, 2), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.r.scene.add(ring);
    const spot = this.shieldSpot(pid);
    const entry = { mesh: m, ring, pulse: 0 };
    this.shields.set(pid, entry);
    this.items.push({ t: 0, life: 1e9, shield: pid, tick: (k, dt, time) => {
      m.position.set(spot.x, spot.y + Math.sin(time * 2) * 0.06, spot.z);
      m.lookAt(this.r.camera.position);
      m.rotateX(Math.PI / 2);
      ring.position.copy(m.position);
      ring.lookAt(this.r.camera.position);
      entry.pulse = Math.max(0, entry.pulse - dt * 2);
      ring.scale.setScalar(1 + entry.pulse * 0.6);
      ring.material.opacity = 0.35 + entry.pulse * 0.6 + Math.sin(time * 4) * 0.08;
    } });
  }

  shieldBlock(pid) {
    const e = this.shields.get(pid);
    if (!e) this.attachShield(pid);
    const s = this.shields.get(pid);
    s.pulse = 1;
    this.r.burstAt(s.mesh.position.x, s.mesh.position.y, s.mesh.position.z, 0x9fd0ff, 90, 3.5, 0.7);
  }

  removeShield(pid) {
    const e = this.shields.get(pid);
    if (!e) return;
    this.shields.delete(pid);
    this.items = this.items.filter((it) => it.shield !== pid);
    this.items.push({ t: 0, life: 0.5, tick: (k) => { e.mesh.scale.setScalar(1.6 * (1 - k)); e.ring.material.opacity = 0.5 * (1 - k); },
      done: () => this.r.scene.remove(e.mesh, e.ring) });
  }

  async goldenSun(fig) {
    const r = this.r;
    fig.userData.pose = 'strike';
    fig.userData.armL.rotation.z = 2.6;
    fig.userData.armR.rotation.z = -2.6;
    this.items.push({ t: 0, life: 0.5 / this.speed, tick: (k) => { fig.position.y = 1.2 * out(k); } });
    await this.wait(500);
    const sun = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.MeshBasicMaterial({ color: hdr(0xffd34d, 3), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    sun.position.set(0, 2.4, -0.2);
    const core = new THREE.PointLight(0xffd34d, 0, 40, 1.2);
    core.position.copy(sun.position);
    r.scene.add(sun, core);
    r.shakeCamera(0.6, 1.4);
    this.items.push({ t: 0, life: 1.6 / this.speed, tick: (k) => {
      const e = out(k);
      sun.scale.setScalar(0.2 + e * 9);
      sun.material.opacity = 0.95 * (1 - k * k);
      core.intensity = 400 * Math.sin(Math.PI * k);
      if (Math.random() < 0.5) r.burstAt((Math.random() - 0.5) * 8, 0.3, (Math.random() - 0.5) * 6, 0xffe08a, 20, 3, 0.8);
    }, done: () => { r.scene.remove(sun, core); sun.geometry.dispose(); } });
    await this.wait(1500);
  }

  setSentryAura(pid, on) {
    if (!on) {
      const a = this.auras.get(pid);
      if (a) { this.r.scene.remove(a.group); this.auras.delete(pid); this.items = this.items.filter((it) => it.aura !== pid); }
      return;
    }
    if (this.auras.has(pid)) return;
    const group = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.35, 48), new THREE.MeshBasicMaterial({ color: hdr(0xffd34d, 2.2), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    const light = new THREE.PointLight(0xffd34d, 18, 6, 1.6);
    light.position.y = 1.2;
    group.add(ring, light);
    const p = this.r.stashPoint(pid);
    group.position.set(p.x, 0.01, p.z);
    this.r.scene.add(group);
    this.auras.set(pid, { group });
    this.items.push({ t: 0, life: 1e9, aura: pid, tick: (k, dt, time) => { ring.rotation.z += dt * 0.8; ring.material.opacity = 0.45 + Math.sin(time * 3) * 0.15; } });
  }

  async summonThunder(fig) {
    const r = this.r;
    const ham = fig.userData.prop;
    fig.userData.pose = 'strike';
    fig.userData.armR.rotation.z = -2.9;
    ham.position.set(0.25, 2.55, 0.05);
    ham.rotation.z = Math.PI;
    await this.wait(250);
    const top = new THREE.Vector3(0, 2.7, -0.2);
    for (let i = 0; i < 3; i++) {
      this.lightning(new THREE.Vector3((Math.random() - 0.5) * 3, 14, -2 + Math.random() * 2), top.clone());
      r.shakeCamera(0.3, 0.25);
      await this.wait(170);
    }
    // Mjolnir leaves the hero's hand and waits to strike.
    const world = new THREE.Vector3();
    ham.getWorldPosition(world);
    fig.remove(ham);
    ham.position.copy(world);
    ham.scale.setScalar(1.6);
    r.scene.add(ham);
    this.hammer = ham;
    this.hammerIdle = 0;
    await this.wait(300);
  }

  // One Mjolnir strike on a player's seat.
  async strike(pid) {
    const r = this.r;
    if (!this.hammer) { this.hammer = this.buildHammer(); this.hammer.scale.setScalar(1.6); this.hammer.position.set(0, 3, 0); r.scene.add(this.hammer); }
    const ham = this.hammer;
    const from = ham.position.clone();
    const to = this.seatPoint(pid, 1.6);
    const s = r.seats[pid];
    if (s && s.human) to.set(0, 1.6, 3.2);
    this.hammerIdle = 0;
    this.items.push({ t: 0, life: 0.38 / this.speed, tick: (k) => {
      ham.position.lerpVectors(from, to, ease(k));
      ham.position.y += Math.sin(Math.PI * k) * 1.2;
      ham.rotation.z += 0.9;
    } });
    await this.wait(380);
    this.lightning(new THREE.Vector3(to.x + (Math.random() - 0.5), 14, to.z), to.clone().setY(0.2));
    r.burstAt(to.x, 0.4, to.z, 0x9fe3ff, 120, 5, 0.9);
    r.shakeCamera(0.35, 0.35);
  }

  update(dt, time) {
    if (this.hammer) {
      this.hammerIdle = (this.hammerIdle || 0) + dt;
      this.hammer.rotation.y += dt * 2;
      if (this.hammerIdle > 2.2) {
        const h = this.hammer;
        this.hammer = null;
        this.items.push({ t: 0, life: 0.6, tick: (k) => { h.position.y += dt * 12; h.scale.setScalar(1.6 * (1 - k)); }, done: () => this.r.scene.remove(h) });
      }
    }
    // Iterate a snapshot: ticks and done-callbacks may add or remove items.
    for (const it of this.items.slice()) {
      if (!this.items.includes(it)) continue;
      it.t += dt;
      const k = Math.min(1, it.t / it.life);
      it.tick(k, dt, time);
      if (k >= 1) {
        const i = this.items.indexOf(it);
        if (i >= 0) this.items.splice(i, 1);
        if (it.done) it.done();
      }
    }
  }

  clear() {
    for (const [pid] of this.shields) this.removeShield(pid);
    for (const [pid] of this.auras) this.setSentryAura(pid, false);
  }
}
