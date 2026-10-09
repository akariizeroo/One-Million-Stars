// Three.js presentation layer. Reads game state, never changes it.
//
// Every card is a real mesh (rounded, beveled, with thickness) whose target pose
// is computed from the game state: draw pile, discard pile, the human's fanned
// hand (anchored in front of the camera) and opponents' hands around the table.
// sync() tweens every card to its target; zone changes fly in an arc.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import {
  drawCardFace, drawCardBack, drawFelt, drawWood, drawCarpet, drawNeonSign, drawCasinoFelt,
  feltNormal, paperNormal, leatherNormal, woodNormal,
} from './textures.js';
import { COLOR_HEX, handSortKey } from './cards.js';

const CW = 1;
const CH = 1.55;
const CT = 0.012;
const GAP = 0.0068;
const DRAW_POS = new THREE.Vector3(-1.35, 0, -0.15);
const DISCARD_POS = new THREE.Vector3(0.85, 0, -0.15);
const TABLE_RX = 6.1;
const TABLE_RZ = 4.7;
const SEAT_RX = 4.75;
const SEAT_RZ = 3.55;
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  outBack: (t) => { const c1 = 1.4; const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
};

export const QUALITY = {
  low: { pixelRatio: 1, shadows: false, shadowSize: 0, bloom: false, dof: false, aa: false, ao: false },
  medium: { pixelRatio: 1.25, shadows: true, shadowSize: 1024, bloom: true, dof: false, aa: true, ao: false },
  high: { pixelRatio: 1.75, shadows: true, shadowSize: 2048, bloom: true, dof: false, aa: true, ao: true },
  ultra: { pixelRatio: 2, shadows: true, shadowSize: 4096, bloom: true, dof: true, aa: true, ao: true },
};

// Film-style grade applied last: chromatic aberration (Chaos), saturation,
// contrast, lens vignette and animated grain.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, time: { value: 0 }, grain: { value: 0.035 }, vignette: { value: 1.15 },
    aberration: { value: 0.0 }, saturation: { value: 1.08 }, contrast: { value: 1.06 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time, grain, vignette, aberration, saturation, contrast;
    varying vec2 vUv;
    void main() {
      vec2 d = vUv - 0.5;
      vec3 col;
      if (aberration > 0.0) {
        col.r = texture2D(tDiffuse, vUv + d * aberration).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, vUv - d * aberration).b;
      } else col = texture2D(tDiffuse, vUv).rgb;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, saturation);
      col = (col - 0.5) * contrast + 0.5;
      float v = smoothstep(0.95, 0.25, length(d) * vignette);
      col *= mix(0.68, 1.0, v);
      float n = fract(sin(dot(vUv * 1000.0 + time, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * grain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// A ring of geometry swept around an ellipse: each profile point is [outward offset, height].
// Keeps a constant cross-section all the way round (unlike a scaled torus).
function sweepEllipse(profile, rx, rz, segments = 220, uRepeat = 1) {
  const pos = [];
  const uv = [];
  const idx = [];
  const np = profile.length;
  for (let i = 0; i <= segments; i++) {
    const th = (i / segments) * Math.PI * 2;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const nx = c / rx;
    const nz = sn / rz;
    const nl = Math.hypot(nx, nz);
    for (let j = 0; j < np; j++) {
      const [u, v] = profile[j];
      pos.push(rx * c + (nx / nl) * u, v, rz * sn + (nz / nl) * u);
      uv.push((i / segments) * uRepeat, j / (np - 1));
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < np - 1; j++) {
      const a = i * np + j;
      const b = (i + 1) * np + j;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Rounded padded-bumper cross-section.
const RAIL_PROFILE = [[0.02, -0.02], [0.02, 0.1], [0.07, 0.22], [0.17, 0.3], [0.31, 0.335], [0.45, 0.31], [0.56, 0.23], [0.62, 0.11], [0.63, 0.0], [0.61, -0.14], [0.56, -0.3]];
const RACETRACK_PROFILE = [[-0.42, -0.005], [-0.41, 0.022], [-0.38, 0.03], [0.02, 0.03], [0.03, -0.01]];
const WOOD_EDGE_PROFILE = [[-0.02, 0.0], [0.05, 0.0], [0.11, -0.03], [0.13, -0.08], [0.11, -0.13], [0.05, -0.16], [-0.02, -0.16]];

export const ENVIRONMENTS = {
  casino: { name: 'Luxury Casino' },
  living: { name: 'Modern Living Room' },
  neon: { name: 'Neon Gaming Lounge' },
};

// Card geometry: an extruded rounded rectangle split into three material groups
// (front face, back face, edge) with UVs mapped across each face.
function buildCardGeometry() {
  const r = 0.085;
  const w = CW - 0.004;
  const h = CH - 0.004;
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: CT - 0.004, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2, curveSegments: 7,
  });
  g.translate(0, 0, -(CT - 0.004) / 2);
  const src = g.index ? g.toNonIndexed() : g;
  const pos = src.attributes.position;
  const nor = src.attributes.normal;
  const buckets = [[], [], []];
  for (let t = 0; t < pos.count; t += 3) {
    const nz = (nor.getZ(t) + nor.getZ(t + 1) + nor.getZ(t + 2)) / 3;
    const b = nz > 0.92 ? 0 : nz < -0.92 ? 1 : 2;
    buckets[b].push(t);
  }
  const P = [];
  const N = [];
  const U = [];
  const out = new THREE.BufferGeometry();
  let start = 0;
  buckets.forEach((tris, gi) => {
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const x = pos.getX(t + k);
        const y = pos.getY(t + k);
        P.push(x, y, pos.getZ(t + k));
        N.push(nor.getX(t + k), nor.getY(t + k), nor.getZ(t + k));
        const u = (x + CW / 2) / CW;
        const v = (y + CH / 2) / CH;
        U.push(gi === 1 ? 1 - u : u, v);
      }
    }
    out.addGroup(start, tris.length * 3, gi);
    start += tris.length * 3;
  });
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  out.computeBoundingSphere();
  return out;
}

function canvasTex(canvas, renderer, srgb = true, repeat = null) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
  return t;
}

export class Renderer {
  constructor(container, opts = {}) {
    this.container = container;
    this.quality = opts.quality || 'high';
    this.speed = 1;
    this.shakeEnabled = true;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.baseCam = { pos: new THREE.Vector3(0, 9.2, 8.6), look: new THREE.Vector3(0, 0, 0.5), fov: 42 };
    this.camAnim = null;
    this.camLook = this.baseCam.look.clone();
    this.shake = { t: 0, amp: 0 };

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.paperN = canvasTex(paperNormal(), this.renderer, false, 3);
    this.feltN = canvasTex(feltNormal(), this.renderer, false, 7);
    this.leatherN = canvasTex(leatherNormal(), this.renderer, false);
    this.leatherN.repeat.set(60, 1);
    this.woodN = canvasTex(woodNormal(), this.renderer, false);
    this.woodN.repeat.set(24, 1);

    this.geometry = buildCardGeometry();
    this.faceCache = new Map();
    this.backMat = new THREE.MeshPhysicalMaterial({ roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.2, envMapIntensity: 0.45,
      normalMap: this.paperN, normalScale: new THREE.Vector2(0.18, 0.18) });
    this.edgeMat = new THREE.MeshStandardMaterial({ color: 0xe9e5dc, roughness: 0.75, envMapIntensity: 0.4 });
    this.setCardBack(opts.cardBack || 'classic');

    this.meshes = new Map();
    this.anims = new Map();
    this.particles = [];
    this.seats = [];
    this.humanId = 0;
    this.hoverId = null;
    this.selectedId = null;
    this.drag = null;
    this.interactive = { playable: new Set(), jumpable: new Set(), hints: true, myTurn: false };
    this.discardJitter = new Map();
    this.game = null;
    this.onCardPlay = () => {};
    this.onDrawPile = () => {};
    this.onHover = () => {};
    this.onFrame = () => {};
    this.updaters = [];
    this.glowCards = new Map();
    this.envGroup = new THREE.Group();
    this.scene.add(this.envGroup);
    this.fxGroup = new THREE.Group();
    this.scene.add(this.fxGroup);
    this.chaos = 0;
    this.clock = new THREE.Clock();
    this.time = 0;
    this.idle = true;

    this._buildLights();
    this._buildCenterpieces();
    this.setEnvironment(opts.environment || 'casino', opts.felt);
    this.setQuality(this.quality);
    this._bindPointer();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this._frame());
  }

  // ---------------------------------------------------------------- setup
  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xfff2e0, 0x201810, 0.55);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xfff1dd, 2.1);
    this.key.position.set(2.5, 12, 4);
    this.key.target.position.set(0, 0, 0);
    this.key.shadow.camera.left = -8; this.key.shadow.camera.right = 8;
    this.key.shadow.camera.top = 7; this.key.shadow.camera.bottom = -7;
    this.key.shadow.camera.near = 2; this.key.shadow.camera.far = 30;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.key.shadow.radius = 4;
    this.scene.add(this.key, this.key.target);
    this.spot = new THREE.SpotLight(0xffe2b0, 60, 30, 0.75, 0.6, 1.6);
    this.spot.position.set(0, 11, 0.5);
    this.spot.target.position.set(0, 0, 0);
    this.scene.add(this.spot, this.spot.target);
    this.chaosLightA = new THREE.PointLight(0xff1f6a, 0, 25, 1.5);
    this.chaosLightA.position.set(-6, 4, -2);
    this.chaosLightB = new THREE.PointLight(0x8a2bff, 0, 25, 1.5);
    this.chaosLightB.position.set(6, 4, -2);
    this.scene.add(this.chaosLightA, this.chaosLightB);
  }

  _buildCenterpieces() {
    // Active color halo under the discard pile.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.05, 1.35, 64),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(DISCARD_POS).add(new THREE.Vector3(0, 0.003, 0));
    this.colorRing = ring;
    this.scene.add(ring);
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(1.6, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.09, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.copy(DISCARD_POS).add(new THREE.Vector3(0, 0.002, 0));
    this.colorGlow = glow;
    this.scene.add(glow);
    this.colorLight = new THREE.PointLight(0xffffff, 0, 6, 2);
    this.colorLight.position.copy(DISCARD_POS).add(new THREE.Vector3(0, 1.2, 0));
    this.scene.add(this.colorLight);

    // Direction-of-play arrows circling the center.
    const dir = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    for (let k = 0; k < 2; k++) {
      const arc = new THREE.Mesh(new THREE.RingGeometry(2.55, 2.85, 48, 1, 0, Math.PI * 0.72), mat);
      arc.rotation.z = k * Math.PI;
      dir.add(arc);
      const head = new THREE.Mesh(new THREE.CircleGeometry(0.42, 3), mat);
      const a = k * Math.PI;
      head.position.set(Math.cos(a) * 2.7, Math.sin(a) * 2.7, 0);
      head.rotation.z = a + Math.PI;
      dir.add(head);
    }
    dir.rotation.x = -Math.PI / 2;
    dir.position.set(-0.25, 0.004, -0.15);
    dir.scale.set(1.25, 1, 1);
    this.dirRing = dir;
    this.dirSign = 1;
    this.scene.add(dir);

    // Turn spotlight disc (moves to the current seat).
    this.turnDisc = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1.15, 48),
      new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.turnDisc.rotation.x = -Math.PI / 2;
    this.turnDisc.position.y = 0.004;
    this.scene.add(this.turnDisc);
  }

  setQuality(q) {
    this.quality = QUALITY[q] ? q : 'high';
    const Q = QUALITY[this.quality];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.pixelRatio));
    this.renderer.shadowMap.enabled = Q.shadows;
    if (Q.shadows) {
      this.key.castShadow = true;
      this.key.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
      if (this.key.shadow.map) { this.key.shadow.map.dispose(); this.key.shadow.map = null; }
    } else this.key.castShadow = false;
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    this._buildComposer();
    this.resize();
  }

  _buildComposer() {
    const Q = QUALITY[this.quality];
    if (this.composer) { this.composer.renderTarget1.dispose(); this.composer.renderTarget2.dispose(); }
    this.gtao = null;
    this.grade = null;
    if (!Q.bloom && !Q.dof) { this.composer = null; return; }
    const size = this.renderer.getSize(new THREE.Vector2());
    const pr = this.renderer.getPixelRatio();
    // HDR + MSAA render target: post-processing would otherwise lose anti-aliasing.
    const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, samples: Q.aa ? 4 : 0 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (Q.ao) {
      // Ground-truth ambient occlusion: soft contact shadows where cards meet felt and rail.
      this.gtao = new GTAOPass(this.scene, this.camera, size.x, size.y);
      this.gtao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1.2, scale: 1.1, samples: 16 });
      this.gtao.blendIntensity = 0.85;
      this.composer.addPass(this.gtao);
    }
    // Threshold above 1.0 (HDR): only real emitters bloom, never white card faces.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.5, 0.5, 1.05);
    this.composer.addPass(this.bloom);
    this.bokeh = null;
    if (Q.dof) {
      this.bokeh = new BokehPass(this.scene, this.camera, { focus: 11.5, aperture: 0.0016, maxblur: 0.006 });
      this.composer.addPass(this.bokeh);
    }
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
  }

  setCardBack(style) {
    this.backStyle = style;
    if (this.backMat.map) this.backMat.map.dispose();
    this.backMat.map = canvasTex(drawCardBack(style), this.renderer);
    this.backMat.needsUpdate = true;
  }

  // ---------------------------------------------------------------- environments
  // Bake a light-probe of the room (emissive walls, lamps, windows, neon) into a
  // prefiltered environment map, so every glossy surface reflects the actual room.
  _buildEnvMap(env) {
    const s = new THREE.Scene();
    const basic = (hex, k = 1) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), side: THREE.DoubleSide });
    const add = (geo, mat, x, y, z, rx = 0, ry = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); s.add(m); return m; };
    const room = { casino: 0x160406, living: 0x8f7d66, neon: 0x040108 }[env];
    const box = new THREE.Mesh(new THREE.BoxGeometry(40, 18, 40), new THREE.MeshBasicMaterial({ color: room, side: THREE.BackSide }));
    box.position.y = 6;
    s.add(box);
    if (env === 'casino') {
      add(new THREE.CircleGeometry(2.6, 32), basic(0xffd9a0, 9), 0, 12.5, 0, Math.PI / 2);
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2;
        add(new THREE.SphereGeometry(0.5, 8, 6), basic(i % 3 ? 0xff9a3c : 0xffe08a, 5), Math.cos(a) * 17, 2 + (i % 4), Math.sin(a) * 17);
      }
      add(new THREE.PlaneGeometry(40, 40), basic(0x3a0c12, 0.6), 0, -3, 0, -Math.PI / 2);
    } else if (env === 'living') {
      add(new THREE.PlaneGeometry(10, 7), basic(0xf4f8ff, 7), -7, 6, -19.5);
      add(new THREE.PlaneGeometry(6, 6), basic(0xfff0d0, 2.2), 0, 14.5, 0, Math.PI / 2);
      add(new THREE.SphereGeometry(1, 12, 8), basic(0xffd28a, 5), 11, 5, -8);
      add(new THREE.PlaneGeometry(40, 40), basic(0x6b4a2e, 0.8), 0, -3, 0, -Math.PI / 2);
    } else {
      for (const [c, x] of [[0xff2bd6, -19.5], [0x22e0ff, 19.5]]) {
        for (let k = 0; k < 3; k++) add(new THREE.PlaneGeometry(0.6, 14), basic(c, 6), x, 6, -10 + k * 10, 0, Math.PI / 2);
      }
      add(new THREE.PlaneGeometry(14, 3.5), basic(0xff2bd6, 4), -6, 7, -19.5);
      add(new THREE.PlaneGeometry(14, 3.5), basic(0x22e0ff, 4), 7, 5, -19.5);
      add(new THREE.PlaneGeometry(8, 8), basic(0x8a5bff, 1.2), 0, 14.5, 0, Math.PI / 2);
    }
    const tex = this.pmrem.fromScene(s, 0.02).texture;
    s.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    return tex;
  }

  setEnvironment(name, feltColor = null) {
    this.envName = ENVIRONMENTS[name] ? name : 'casino';
    for (const c of [...this.envGroup.children]) {
      this.envGroup.remove(c);
      c.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
    this.signs = [];
    this.bokehDots = [];
    const g = this.envGroup;
    const R = this.renderer;
    const env = this.envName;
    const feltHex = feltColor || (env === 'casino' ? '#0f6b3a' : env === 'neon' ? '#17122b' : '#6b3f22');

    // Reflections come from a light-probe of this specific room.
    if (this.envMap) this.envMap.dispose();
    this.envMap = this._buildEnvMap(env);
    this.scene.environment = this.envMap;

    // ---- Table: playing surface, wooden racetrack, padded rail (or a solid wood top).
    const surface = env === 'living'
      ? new THREE.MeshPhysicalMaterial({ map: canvasTex(drawWood('#7a4a26', 2048), R), normalMap: this.woodN.clone(), normalScale: new THREE.Vector2(0.35, 0.35),
        roughness: 0.38, clearcoat: 0.85, clearcoatRoughness: 0.12 })
      : new THREE.MeshPhysicalMaterial({
        map: canvasTex(env === 'casino' ? drawCasinoFelt(feltHex) : drawFelt(feltHex, 2048), R),
        normalMap: this.feltN, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.96,
        sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color(feltHex).lerp(new THREE.Color('#ffffff'), 0.35), envMapIntensity: 0.25,
      });
    if (surface.normalMap && env === 'living') { surface.normalMap.repeat.set(1, 1); surface.normalMap.needsUpdate = true; }
    // Cylinder caps map UVs sideways; rotate so printed markings face the players.
    surface.map.center.set(0.5, 0.5);
    surface.map.rotation = -Math.PI / 2;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.12, 128), surface);
    top.scale.set(TABLE_RX, 1, TABLE_RZ);
    top.position.y = -0.06;
    top.receiveShadow = true;
    g.add(top);
    this.tableTop = top;

    let rimMat;
    if (env === 'living') {
      rimMat = new THREE.MeshPhysicalMaterial({ map: canvasTex(drawWood('#6a3d1f'), R, true), normalMap: this.woodN, normalScale: new THREE.Vector2(0.4, 0.4), roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.12 });
      const edge = new THREE.Mesh(sweepEllipse(WOOD_EDGE_PROFILE, TABLE_RX, TABLE_RZ, 220, 30), rimMat);
      edge.castShadow = true; edge.receiveShadow = true;
      g.add(edge);
    } else {
      const neon = env === 'neon';
      const wood = new THREE.MeshPhysicalMaterial({
        map: canvasTex(drawWood(neon ? '#16121c' : '#4a1a0c'), R), normalMap: this.woodN, normalScale: new THREE.Vector2(0.3, 0.3),
        roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08, metalness: neon ? 0.4 : 0,
      });
      wood.map.wrapS = THREE.RepeatWrapping; wood.map.repeat.set(30, 1);
      const track = new THREE.Mesh(sweepEllipse(RACETRACK_PROFILE, TABLE_RX, TABLE_RZ), wood);
      track.receiveShadow = true;
      g.add(track);
      rimMat = new THREE.MeshPhysicalMaterial({
        color: neon ? 0x09070d : 0x1c0e09, roughness: neon ? 0.28 : 0.52, clearcoat: neon ? 0.9 : 0.35, clearcoatRoughness: 0.3,
        normalMap: this.leatherN, normalScale: new THREE.Vector2(0.55, 0.55), sheen: neon ? 0 : 0.4, sheenColor: new THREE.Color('#5a3020'),
      });
      const rail = new THREE.Mesh(sweepEllipse(RAIL_PROFILE, TABLE_RX, TABLE_RZ), rimMat);
      rail.castShadow = true; rail.receiveShadow = true;
      g.add(rail);
      // Brass / chrome studs
      const studMat = new THREE.MeshStandardMaterial({ color: neon ? 0xb8b8c8 : 0xc9a35a, metalness: 1, roughness: 0.25 });
      const stud = new THREE.SphereGeometry(0.035, 12, 8);
      for (let i = 0; i < 64; i++) {
        const th = (i / 64) * Math.PI * 2;
        const nx = Math.cos(th) / TABLE_RX; const nz = Math.sin(th) / TABLE_RZ; const nl = Math.hypot(nx, nz);
        const m = new THREE.Mesh(stud, studMat);
        m.position.set(TABLE_RX * Math.cos(th) + (nx / nl) * 0.6, -0.12, TABLE_RZ * Math.sin(th) + (nz / nl) * 0.6);
        g.add(m);
      }
      if (neon) {
        for (const [c, u, y] of [[0xff2bd6, 0.64, -0.04], [0x22e0ff, -0.43, 0.035]]) {
          const tube = new THREE.Mesh(sweepEllipse([[u, y], [u, y + 0.025], [u + 0.012, y + 0.025]], TABLE_RX, TABLE_RZ), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(3.5) }));
          g.add(tube);
          this.signs.push(tube);
        }
      }
    }
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.6, 3.2, 32), rimMat);
    pedestal.position.y = -1.75;
    g.add(pedestal);

    // Floor + room
    let floorMat;
    if (env === 'casino') floorMat = new THREE.MeshStandardMaterial({ map: canvasTex(drawCarpet(), R, true, 14), roughness: 1 });
    else if (env === 'living') floorMat = new THREE.MeshStandardMaterial({ map: canvasTex(drawWood('#8a6038', 1024, false), R, true, 6), roughness: 0.6 });
    else {
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const x = c.getContext('2d'); x.fillStyle = '#05040a'; x.fillRect(0, 0, 256, 256);
      x.strokeStyle = '#7b2bff'; x.lineWidth = 3; x.shadowColor = '#b05bff'; x.shadowBlur = 8; x.strokeRect(0, 0, 256, 256);
      floorMat = new THREE.MeshStandardMaterial({ map: canvasTex(c, R, true, 18), roughness: 0.25, metalness: 0.6, emissive: 0x2a0b55, emissiveIntensity: 0.25 });
    }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -3.35;
    floor.receiveShadow = true;
    g.add(floor);

    const skyColors = { casino: ['#3a0608', '#0a0102'], living: ['#d9c7ad', '#7d6a55'], neon: ['#1a0638', '#020008'] }[env];
    const sky = new THREE.Mesh(new THREE.SphereGeometry(70, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color(skyColors[0]) }, bottom: { value: new THREE.Color(skyColors[1]) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y*1.6+0.35,0.0,1.0); gl_FragColor = vec4(mix(bottom, top, h),1.0); }',
    }));
    g.add(sky);
    this.scene.background = new THREE.Color(skyColors[1]);

    if (env === 'casino') {
      this.scene.fog = new THREE.Fog(0x14020a, 22, 60);
      this.hemi.color.set(0xffe6c4); this.hemi.intensity = 0.45;
      this.key.color.set(0xffe2b8); this.key.intensity = 1.35;
      this.spot.color.set(0xffd9a0); this.spot.intensity = 26;
      // Lamp shade over the table.
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 2.2, 1.1, 48, 1, true),
        new THREE.MeshStandardMaterial({ color: 0x0d3b22, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide, emissive: 0x331a00, emissiveIntensity: 0.2 }));
      shade.position.set(0, 12.2, 0.4);
      g.add(shade);
      // Distant bokeh lights (slot machines, chandeliers).
      for (let i = 0; i < 70; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 26 + Math.random() * 18;
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.25 + Math.random() * 0.5, 8, 8),
          new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(0.04 + Math.random() * 0.1, 0.9, 0.55 + Math.random() * 0.2).multiplyScalar(2.5) }));
        dot.position.set(Math.cos(a) * r, -1 + Math.random() * 10, Math.sin(a) * r - 6);
        g.add(dot);
        this.bokehDots.push(dot);
      }
      // Chip stacks near seats.
      const chipCols = [0xc0161d, 0x1b3fa0, 0x111111, 0x0e7a3a];
      for (let s = 0; s < 6; s++) {
        const a = -0.9 + s * 0.36;
        for (let k = 0; k < 6 + (s % 3) * 3; k++) {
          const chip = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.045, 24),
            new THREE.MeshStandardMaterial({ color: chipCols[(s + k) % 4], roughness: 0.4 }));
          chip.position.set(Math.sin(a) * 5.0 + (k % 2) * 0.01, 0.023 + k * 0.047, Math.cos(a) * 3.75 * (s % 2 ? 1 : -1) * 0.2 + 3.2);
          if (s >= 3) chip.position.set(-chip.position.x, chip.position.y, -0.5 + (s - 3) * 0.6 - 2.2);
          chip.castShadow = true;
          g.add(chip);
        }
      }
    } else if (env === 'living') {
      this.scene.fog = new THREE.Fog(0xb8a68d, 30, 70);
      this.hemi.color.set(0xfff4e2); this.hemi.groundColor.set(0x6b5440); this.hemi.intensity = 0.9;
      this.key.color.set(0xfff0d8); this.key.intensity = 2.4;
      this.key.position.set(-6, 12, -3);
      this.spot.color.set(0xffe9c8); this.spot.intensity = 14;
      const wallMat = new THREE.MeshStandardMaterial({ color: 0xe9dcc8, roughness: 0.95 });
      const back = new THREE.Mesh(new THREE.PlaneGeometry(60, 20), wallMat);
      back.position.set(0, 5, -16);
      g.add(back);
      const win = new THREE.Mesh(new THREE.PlaneGeometry(9, 6), new THREE.MeshBasicMaterial({ color: 0xfff6dc }));
      win.position.set(-7, 5.5, -15.9);
      g.add(win);
      const frameMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
      for (const [w, h, x, y] of [[9.4, 0.25, -7, 8.5], [9.4, 0.25, -7, 2.5], [0.25, 6.2, -11.5, 5.5], [0.25, 6.2, -2.5, 5.5], [0.2, 6, -7, 5.5]]) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.2), frameMat); b.position.set(x, y, -15.8); g.add(b);
      }
      const sofaMat = new THREE.MeshStandardMaterial({ color: 0x3b5b7a, roughness: 0.9 });
      const sofa = new THREE.Group();
      const seat = new THREE.Mesh(new THREE.BoxGeometry(9, 1.2, 3), sofaMat); seat.position.y = -2.6; sofa.add(seat);
      const backrest = new THREE.Mesh(new THREE.BoxGeometry(9, 2.6, 0.9), sofaMat); backrest.position.set(0, -1.4, -1.2); sofa.add(backrest);
      for (const sx of [-4.7, 4.7]) { const arm = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2, 3), sofaMat); arm.position.set(sx, -2, 0); sofa.add(arm); }
      sofa.position.set(5, 0, -11);
      g.add(sofa);
      const rug = new THREE.Mesh(new THREE.CircleGeometry(11, 64), new THREE.MeshStandardMaterial({ color: 0xa4473a, roughness: 1 }));
      rug.rotation.x = -Math.PI / 2; rug.position.y = -3.33; rug.receiveShadow = true; g.add(rug);
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.5, 1.4, 24), new THREE.MeshStandardMaterial({ color: 0xd8d2c8, roughness: 0.5 }));
      pot.position.set(-11, -2.6, -9); g.add(pot);
      for (let i = 0; i < 9; i++) {
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), new THREE.MeshStandardMaterial({ color: 0x2f6b34, roughness: 0.8 }));
        leaf.scale.set(0.5, 1.4, 0.2);
        leaf.position.set(-11 + Math.cos(i) * 0.6, -0.8 + Math.random() * 1.2, -9 + Math.sin(i) * 0.6);
        leaf.rotation.set(Math.random(), i, Math.random() * 0.6);
        g.add(leaf);
      }
      const lampPole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 8, 12), new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8, roughness: 0.3 }));
      lampPole.position.set(11, 0.6, -8); g.add(lampPole);
      const lampShade = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.2, 1.4, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0xfff1d0, emissive: 0xffd28a, emissiveIntensity: 0.6, side: THREE.DoubleSide }));
      lampShade.position.set(11, 4.8, -8); g.add(lampShade);
      const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.45, 24), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.2, clearcoat: 1 }));
      mug.position.set(4.6, 0.225, 1.6); mug.castShadow = true; g.add(mug);
    } else {
      this.scene.fog = new THREE.FogExp2(0x0b0218, 0.028);
      this.hemi.color.set(0xb38cff); this.hemi.groundColor.set(0x12002a); this.hemi.intensity = 0.35;
      this.key.color.set(0xd9c8ff); this.key.intensity = 1.2;
      this.spot.color.set(0xc9a6ff); this.spot.intensity = 22;
      const signA = new THREE.Mesh(new THREE.PlaneGeometry(10, 2.5), new THREE.MeshBasicMaterial({ map: canvasTex(drawNeonSign('UNO', '#ff2bd6'), R), transparent: true, depthWrite: false, color: new THREE.Color(2.2, 2.2, 2.2) }));
      signA.position.set(-6, 6, -14);
      const signB = new THREE.Mesh(new THREE.PlaneGeometry(10, 2.5), new THREE.MeshBasicMaterial({ map: canvasTex(drawNeonSign('PLAY', '#22e0ff'), R), transparent: true, depthWrite: false, color: new THREE.Color(2.2, 2.2, 2.2) }));
      signB.position.set(7, 4.5, -14);
      signB.rotation.y = -0.3;
      g.add(signA, signB);
      this.signs.push(signA, signB);
      for (const [c, x] of [[0xff2bd6, -9], [0x22e0ff, 9]]) {
        const l = new THREE.PointLight(c, 40, 30, 1.6);
        l.position.set(x, 4, -6);
        g.add(l);
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.15, 10, 0.15), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(3) }));
        bar.position.set(x * 1.6, 2, -12);
        g.add(bar);
        this.signs.push(bar);
      }
    }
    this.key.position.set(env === 'living' ? -6 : 2.5, 12, env === 'living' ? -3 : 4);
    this.baseBloom = env === 'neon' ? 0.7 : env === 'casino' ? 0.28 : 0.16;
  }

  // ---------------------------------------------------------------- cards
  _faceMaterial(card) {
    const key = `${card.color}|${card.type}|${card.value}`;
    let tex = this.faceCache.get(key);
    if (!tex) { tex = canvasTex(drawCardFace(card), this.renderer); this.faceCache.set(key, tex); }
    return new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.22, emissive: 0x000000, envMapIntensity: 0.3,
      normalMap: this.paperN, normalScale: new THREE.Vector2(0.18, 0.18) });
  }

  ensureCard(card) {
    let m = this.meshes.get(card.id);
    if (m) return m;
    m = new THREE.Mesh(this.geometry, [this._faceMaterial(card), this.backMat, this.edgeMat]);
    m.castShadow = true;
    m.userData = { id: card.id, card, zone: 'pile', target: null };
    m.position.copy(DRAW_POS);
    m.quaternion.copy(this._flat(false, 0));
    this.scene.add(m);
    this.meshes.set(card.id, m);
    return m;
  }

  clearCards() {
    for (const m of this.meshes.values()) { this.scene.remove(m); m.material[0].dispose(); }
    this.meshes.clear();
    this.anims.clear();
    this.discardJitter.clear();
    this.hoverId = null;
    this.selectedId = null;
    this.drag = null;
  }

  _flat(faceUp, rotY) {
    const q = new THREE.Quaternion().setFromAxisAngle(X, faceUp ? -Math.PI / 2 : Math.PI / 2);
    return new THREE.Quaternion().setFromAxisAngle(Y, rotY).multiply(q);
  }

  // ---------------------------------------------------------------- seats
  setupSeats(players, humanId = 0) {
    this.humanId = humanId;
    const n = players.length;
    this.seats = [];
    const opp = [];
    for (let k = 1; k < n; k++) opp.push((humanId + k) % n);
    players.forEach((p, i) => {
      let phi;
      if (i === humanId) phi = 0;
      else {
        const k = opp.indexOf(i);
        const m = opp.length;
        phi = m === 1 ? Math.PI : (58 + (k * 244) / (m - 1)) * (Math.PI / 180);
      }
      const pos = new THREE.Vector3(-Math.sin(phi) * SEAT_RX, 0, Math.cos(phi) * SEAT_RZ);
      this.seats[i] = { phi, pos, human: i === humanId };
    });
  }

  seatScreen(pid) {
    const s = this.seats[pid];
    if (!s) return null;
    const p = s.human ? new THREE.Vector3(0, 0, 4.3) : s.pos.clone().add(new THREE.Vector3(0, 2.25, 0));
    p.project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height, visible: p.z < 1 };
  }

  // Alternative anchor: on the felt just in front of a player's cards.
  seatScreenFront(pid) {
    const s = this.seats[pid];
    if (!s || s.human) return null;
    const p = s.pos.clone().multiplyScalar(0.8).setY(0);
    p.project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height };
  }

  worldToScreen(v) {
    const p = v.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height };
  }

  discardScreen() { return this.worldToScreen(DISCARD_POS.clone().add(new THREE.Vector3(0, 0.3, -1.3))); }
  drawScreen() { return this.worldToScreen(DRAW_POS.clone().add(new THREE.Vector3(0, 0.4, 1.0))); }

  // ---------------------------------------------------------------- layout
  _humanHandPoses(cards) {
    const poses = new Map();
    const cam = this.layoutCam;
    const n = cards.length;
    if (!n) return poses;
    const dist = this.handDist;
    const fovR = (cam.fov * Math.PI) / 180;
    const visH = 2 * dist * Math.tan(fovR / 2);
    const visW = visH * cam.aspect;
    const maxSpan = Math.max(0.5, Math.min(visW * 0.92 - CW, 11));
    const spacing = Math.min(0.66, n > 1 ? maxSpan / (n - 1) : 0);
    const span = spacing * (n - 1);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const center = cam.position.clone().add(fwd.clone().multiplyScalar(dist)).add(up.clone().multiplyScalar(-visH * this.handDrop));
    const baseQ = cam.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(X, -0.18));
    cards.forEach((c, i) => {
      const x = -span / 2 + i * spacing;
      const nx = span > 0 ? x / Math.max(span / 2, 2.5) : 0;
      const fan = -nx * 0.16;
      let lift = -nx * nx * 0.22;
      let toward = 0.002 * i;
      if (c.id === this.hoverId && !this.drag) { lift += 0.42; toward += 0.25; }
      else if (c.id === this.selectedId) { lift += 0.55; toward += 0.3; }
      else if (this.interactive.playable.has(c.id) || this.interactive.jumpable.has(c.id)) lift += 0.12;
      const pos = center.clone()
        .add(right.clone().multiplyScalar(x))
        .add(up.clone().multiplyScalar(lift))
        .add(fwd.clone().multiplyScalar(-toward));
      const q = baseQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Z, fan));
      poses.set(c.id, { pos, quat: q, zone: `hand:${this.humanId}` });
    });
    return poses;
  }

  _opponentPoses(pid, cards) {
    const poses = new Map();
    const seat = this.seats[pid];
    const n = cards.length;
    const out = seat.pos.clone().setY(0).normalize();
    // Cards are held facing their owner and lean toward the table, so the camera only
    // ever sees their backs. Tilt further if needed so faces can never leak.
    let tilt = -0.3;
    let nrm;
    const toCam = this.layoutCam.position.clone().sub(seat.pos).normalize();
    for (let k = 0; k < 8; k++) {
      nrm = out.clone().add(new THREE.Vector3(0, tilt, 0)).normalize();
      if (nrm.dot(toCam) < -0.25) break;
      tilt -= 0.2;
    }
    const yAxis = Y.clone().sub(nrm.clone().multiplyScalar(Y.dot(nrm))).normalize();
    const xAxis = new THREE.Vector3().crossVectors(yAxis, nrm).normalize();
    const base = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, nrm));
    const spacing = Math.min(0.32, n > 1 ? 3.2 / (n - 1) : 0);
    const span = spacing * (n - 1);
    cards.forEach((c, i) => {
      const x = -span / 2 + i * spacing;
      const fan = -(x / Math.max(span / 2, 1.2)) * 0.32;
      const pos = seat.pos.clone()
        .add(xAxis.clone().multiplyScalar(x))
        .add(new THREE.Vector3(0, 0.85 - Math.abs(x) * 0.08, 0))
        .add(nrm.clone().multiplyScalar(-0.004 * i));
      const q = base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Z, fan));
      poses.set(c.id, { pos, quat: q, zone: `hand:${pid}` });
    });
    return poses;
  }

  computePoses(game) {
    const poses = new Map();
    game.drawPile.forEach((c, i) => {
      const j = ((c.id * 9301 + 49297) % 233280) / 233280;
      poses.set(c.id, {
        pos: DRAW_POS.clone().add(new THREE.Vector3((j - 0.5) * 0.03, CT / 2 + i * GAP, (j - 0.5) * 0.02)),
        quat: this._flat(false, (j - 0.5) * 0.05), zone: 'pile', hidden: i < game.drawPile.length - 60,
      });
    });
    const dl = game.discard.length;
    game.discard.forEach((c, i) => {
      let jit = this.discardJitter.get(c.id);
      if (!jit) { jit = { x: (Math.random() - 0.5) * 0.35, z: (Math.random() - 0.5) * 0.3, r: (Math.random() - 0.5) * 0.9 }; this.discardJitter.set(c.id, jit); }
      const visibleIdx = Math.max(0, i - (dl - 40));
      poses.set(c.id, {
        pos: DISCARD_POS.clone().add(new THREE.Vector3(jit.x, CT / 2 + visibleIdx * GAP, jit.z)),
        quat: this._flat(true, jit.r), zone: 'discard', hidden: i < dl - 40,
      });
    });
    // HERO cards that left the match vanish (their cinematic already played).
    (game.removed || []).forEach((c) => {
      poses.set(c.id, { pos: DISCARD_POS.clone().add(new THREE.Vector3(0, 0.6, 0)), quat: this._flat(true, 0), zone: 'removed', hidden: true });
    });
    // Sentry: the real hand is set aside face down in a neat stack.
    game.players.forEach((p) => {
      if (!p.stash) return;
      const base = this.stashPoint(p.id);
      p.stash.forEach((c, i) => {
        poses.set(c.id, { pos: base.clone().add(new THREE.Vector3(0, CT / 2 + i * GAP * 1.2, 0)), quat: this._flat(false, 0.3), zone: `stash:${p.id}` });
      });
    });
    game.players.forEach((p) => {
      if (p.id === this.humanId) {
        const sorted = [...p.hand].sort((a, b) => handSortKey(a) - handSortKey(b));
        this._humanOrder = sorted.map((c) => c.id);
        for (const [id, pose] of this._humanHandPoses(sorted)) poses.set(id, pose);
      } else {
        for (const [id, pose] of this._opponentPoses(p.id, p.hand)) poses.set(id, pose);
      }
    });
    return poses;
  }

  /**
   * Tween every card to its pose for the current game state.
   * @param {object} opt { dur, focus: [ids] animated in order with stagger, stagger, arc, toss: id }
   */
  sync(game, opt = {}) {
    this.game = game;
    for (const c of game.cards.values()) this.ensureCard(c);
    const poses = this.computePoses(game);
    const sp = this.speed;
    const dur = (opt.dur ?? 0.32) / sp;
    const stagger = (opt.stagger ?? 0.06) / sp;
    const focus = opt.focus || [];
    const focusIdx = new Map(focus.map((id, i) => [id, i]));
    let longest = 0;
    for (const [id, pose] of poses) {
      const m = this.meshes.get(id);
      if (!m || (this.drag && this.drag.id === id)) continue;
      const prevZone = m.userData.zone;
      m.userData.zone = pose.zone;
      const t = m.userData.target;
      const changed = !t || t.pos.distanceToSquared(pose.pos) > 1e-6 || t.quat.angleTo(pose.quat) > 1e-3;
      m.userData.target = pose;
      if (pose.hidden && !this.anims.has(id) && prevZone === pose.zone) {
        m.visible = false;
        m.position.copy(pose.pos); m.quaternion.copy(pose.quat);
        continue;
      }
      m.visible = true;
      if (!changed) continue;
      const zoneMove = prevZone !== pose.zone;
      let d = zoneMove ? Math.max(dur, 0.5 / sp) : dur;
      let delay = 0;
      if (focusIdx.has(id)) { delay = focusIdx.get(id) * stagger; d = opt.flight ? opt.flight / sp : Math.max(d, 0.48 / sp); }
      const arc = zoneMove ? (opt.arc ?? 1.1) : 0;
      const spin = opt.toss === id ? (Math.random() < 0.5 ? -1 : 1) * Math.PI * 2 : 0;
      this._animate(m, pose, d, delay, arc, spin, opt.toss === id, pose.hidden);
      longest = Math.max(longest, delay + d);
    }
    return new Promise((res) => setTimeout(res, longest * 1000 + 16));
  }

  _animate(m, pose, dur, delay, arc, spin, land, hideAfter) {
    this.anims.set(m.userData.id, {
      m, fromP: m.position.clone(), fromQ: m.quaternion.clone(), toP: pose.pos.clone(), toQ: pose.quat.clone(),
      t0: this.time + delay, dur: Math.max(0.01, dur), arc, spin, land, hideAfter,
    });
  }

  _updateAnims() {
    const tmpQ = new THREE.Quaternion();
    for (const [id, a] of this.anims) {
      const raw = (this.time - a.t0) / a.dur;
      if (raw < 0) continue;
      const t = Math.min(1, raw);
      let e;
      if (a.land) {
        // Tossed card: flies to a touchdown point short of its resting spot, then
        // slides across the felt and stops under friction.
        const LAND = 0.72;
        if (!a.touch) {
          const dir = a.toP.clone().sub(a.fromP).setY(0);
          const slide = Math.min(0.45, dir.length() * 0.12);
          a.touch = a.toP.clone().sub(dir.normalize().multiplyScalar(slide));
        }
        if (t < LAND) {
          const k = ease.out(t / LAND);
          a.m.position.lerpVectors(a.fromP, a.touch, k);
          a.m.position.y += Math.sin(Math.PI * k) * a.arc;
          e = k;
        } else {
          const k = (t - LAND) / (1 - LAND);
          a.m.position.lerpVectors(a.touch, a.toP, 1 - (1 - k) * (1 - k));
          a.m.position.y += Math.max(0, Math.sin(k * Math.PI * 2) * 0.012 * (1 - k)); // tiny skip
          e = 1;
        }
      } else {
        e = ease.inOut(t);
        a.m.position.lerpVectors(a.fromP, a.toP, e);
        a.m.position.y += Math.sin(Math.PI * Math.min(1, t * 1.05)) * a.arc;
      }
      a.m.quaternion.slerpQuaternions(a.fromQ, a.toQ, e);
      if (a.spin) a.m.quaternion.premultiply(tmpQ.setFromAxisAngle(Y, a.spin * (1 - e)));
      if (t >= 1) {
        a.m.position.copy(a.toP);
        a.m.quaternion.copy(a.toQ);
        if (a.hideAfter) a.m.visible = false;
        this.anims.delete(id);
      }
    }
  }

  // Riffle-shuffle animation for the draw pile.
  async animateShuffle(game) {
    const pile = game.drawPile;
    const half = Math.floor(pile.length / 2);
    const sp = this.speed;
    pile.forEach((c, i) => {
      const m = this.ensureCard(c);
      const left = i < half;
      const k = left ? i : i - half;
      const pos = DRAW_POS.clone().add(new THREE.Vector3(left ? -0.75 : 0.75, CT / 2 + k * GAP * 1.6, 0.1));
      const q = this._flat(false, left ? 0.25 : -0.25).multiply(new THREE.Quaternion().setFromAxisAngle(Y, left ? 0.12 : -0.12));
      this._animate(m, { pos, quat: q }, 0.35 / sp, 0, 0.25, 0, false);
      m.userData.zone = 'pile';
      m.visible = true;
    });
    await new Promise((r) => setTimeout(r, 420 / sp));
    for (const m of this.meshes.values()) m.userData.target = null;
    await this.sync(game, { dur: 0.45, stagger: 0.004 });
  }

  // ---------------------------------------------------------------- state visuals
  setActiveColor(color, pulse = true) {
    const c = new THREE.Color(COLOR_HEX[color] || '#ffffff');
    this.colorRing.material.color.copy(c);
    this.colorGlow.material.color.copy(c);
    this.colorLight.color.copy(c);
    this.colorLight.intensity = 6;
    if (pulse) { this.colorPulse = 1; this.burst(DISCARD_POS.clone().add(new THREE.Vector3(0, 0.2, 0)), c, 50, 2.2); }
  }

  setDirection(dir) {
    if (dir !== this.dirSign) { this.dirSign = dir; this.dirFlip = 1; }
  }

  setTurn(pid) {
    this.turnPid = pid;
    const s = this.seats[pid];
    if (!s) return;
    const p = s.human ? new THREE.Vector3(0, 0, 3.4) : s.pos.clone().multiplyScalar(0.86);
    this.turnTarget = p;
  }

  setInteractive(state) {
    Object.assign(this.interactive, state);
    this._applyDim();
    if (this.game) this.sync(this.game, { dur: 0.18 });
  }

  _applyDim() {
    const { playable, jumpable, myTurn, hints } = this.interactive;
    if (!this.game) return;
    const me = this.game.players[this.humanId];
    if (!me) return;
    for (const c of me.hand) {
      const m = this.meshes.get(c.id);
      if (!m) continue;
      const mat = m.material[0];
      const live = playable.has(c.id) || jumpable.has(c.id);
      const dim = hints && myTurn && !live;
      mat.color.setScalar(dim ? 0.38 : 1);
      mat.emissive.setHex(hints && live ? (jumpable.has(c.id) && !myTurn ? 0x2a1240 : 0x2b2000) : 0x000000);
    }
    for (const id of this.meshes.keys()) {
      if (me.hand.some((c) => c.id === id)) continue;
      const mat = this.meshes.get(id).material[0];
      if (mat.color.r !== 1) mat.color.setScalar(1);
      if (mat.emissive.getHex()) mat.emissive.setHex(0);
    }
  }

  setChaos(level01) { this.chaos = level01; }

  // ---------------------------------------------------------------- effects
  burst(pos, color, count = 60, speed = 3, life = 1.1) {
    const geo = new THREE.BufferGeometry();
    const P = new Float32Array(count * 3);
    const V = [];
    for (let i = 0; i < count; i++) {
      P[i * 3] = pos.x; P[i * 3 + 1] = pos.y; P[i * 3 + 2] = pos.z;
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random()));
      V.push(v);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    const mat = new THREE.PointsMaterial({ color: new THREE.Color(color).multiplyScalar(2.5), size: 0.12, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    this.fxGroup.add(pts);
    this.particles.push({ pts, V, t: 0, life, gravity: -3 });
  }

  burstAt(x, y, z, color, count, speed, life) { this.burst(new THREE.Vector3(x, y, z), color, count, speed, life); }

  seatPoint(pid) {
    const s = this.seats[pid];
    if (!s) return new THREE.Vector3();
    return s.human ? new THREE.Vector3(0, 0, 3.2) : s.pos.clone();
  }

  confettiAtSeat(pid, count = 300) { this.confetti(this.seatPoint(pid), count); }

  // Where Sentry's set-aside hand rests on the table.
  stashPoint(pid) {
    const s = this.seats[pid];
    if (!s) return new THREE.Vector3();
    return s.human ? new THREE.Vector3(-3.4, 0, 2.2) : s.pos.clone().multiplyScalar(0.7).setY(0);
  }

  setCardGlow(id, color = null) {
    if (color === null) {
      this.glowCards.delete(id);
      const m = this.meshes.get(id);
      if (m) m.material[0].emissive.setHex(0);
    } else this.glowCards.set(id, color);
  }

  confetti(center, count = 260) {
    const cols = [0xe2262f, 0xf6c412, 0x2a9d48, 0x1d68d4, 0xffffff];
    const geo = new THREE.PlaneGeometry(0.12, 0.07);
    for (let k = 0; k < cols.length; k++) {
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: cols[k], side: THREE.DoubleSide }), Math.floor(count / cols.length));
      const items = [];
      for (let i = 0; i < mesh.count; i++) {
        items.push({
          p: center.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, 4 + Math.random() * 3, (Math.random() - 0.5) * 2)),
          v: new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 3, (Math.random() - 0.5) * 6),
          r: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
          w: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8),
        });
      }
      this.fxGroup.add(mesh);
      this.particles.push({ confetti: mesh, items, t: 0, life: 6 });
    }
  }

  _updateParticles(dt) {
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.t += dt;
      if (p.confetti) {
        p.items.forEach((it, k) => {
          it.v.y -= 2.2 * dt;
          it.v.multiplyScalar(0.985);
          it.p.addScaledVector(it.v, dt);
          if (it.p.y < 0.01) { it.p.y = 0.01; it.v.set(0, 0, 0); }
          it.r.x += it.w.x * dt; it.r.y += it.w.y * dt;
          q.setFromEuler(it.r);
          m4.compose(it.p, q, one);
          p.confetti.setMatrixAt(k, m4);
        });
        p.confetti.instanceMatrix.needsUpdate = true;
        if (p.t > p.life) { this.fxGroup.remove(p.confetti); p.confetti.geometry.dispose(); this.particles.splice(i, 1); }
        continue;
      }
      const a = p.pts.geometry.attributes.position;
      for (let k = 0; k < p.V.length; k++) {
        p.V[k].y += p.gravity * dt;
        a.setXYZ(k, a.getX(k) + p.V[k].x * dt, a.getY(k) + p.V[k].y * dt, a.getZ(k) + p.V[k].z * dt);
      }
      a.needsUpdate = true;
      p.pts.material.opacity = Math.max(0, 1 - p.t / p.life);
      if (p.t > p.life) { this.fxGroup.remove(p.pts); p.pts.geometry.dispose(); p.pts.material.dispose(); this.particles.splice(i, 1); }
    }
  }

  shakeCamera(amp = 0.25, dur = 0.6) {
    if (!this.shakeEnabled) return;
    this.shake = { t: dur, dur, amp };
  }

  // Cinematic camera moves: 'reset', 'center' (dramatic close-up), or a seat id.
  focus(target, dur = 1.2) {
    let pos;
    let look;
    if (target === 'reset') { pos = this.baseCam.pos.clone(); look = this.baseCam.look.clone(); }
    else if (target === 'center') { pos = new THREE.Vector3(0, 5.2, 4.6); look = new THREE.Vector3(0, 0, -0.2); }
    else if (target === 'overhead') { pos = new THREE.Vector3(0, 14, 0.8); look = new THREE.Vector3(0, 0, 0); }
    else if (target === 'hero') { pos = new THREE.Vector3(0, 3.4, 6.8); look = new THREE.Vector3(0, 1.7, -0.2); }
    else {
      const s = this.seats[target];
      if (!s) return;
      const sp = s.human ? new THREE.Vector3(0, 0.5, 3.6) : s.pos.clone().add(new THREE.Vector3(0, 1, 0));
      look = sp.clone();
      pos = sp.clone().multiplyScalar(s.human ? 1.1 : -0.25).add(new THREE.Vector3(0, 3.6, s.human ? 3.4 : 0));
      if (!s.human) pos.add(sp.clone().setY(0).normalize().multiplyScalar(-4.5));
    }
    this.camAnim = { fromP: this.camera.position.clone(), fromL: this.camLook.clone(), toP: pos, toL: look, t0: this.time, dur };
  }

  // ---------------------------------------------------------------- input
  _bindPointer() {
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const setNdc = (e) => {
      const r = this.canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      return r;
    };
    const handMeshes = () => {
      if (!this.game) return [];
      const me = this.game.players[this.humanId];
      return me ? me.hand.map((c) => this.meshes.get(c.id)).filter(Boolean) : [];
    };
    const pick = (e) => {
      setNdc(e);
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects(handMeshes(), false)[0];
      return hit ? hit.object.userData.id : null;
    };
    const pickPile = (e) => {
      if (!this.game) return false;
      setNdc(e);
      ray.setFromCamera(ndc, this.camera);
      const top = this.game.drawPile.slice(-6).map((c) => this.meshes.get(c.id)).filter(Boolean);
      return ray.intersectObjects(top, false).length > 0;
    };
    const canAct = (id) => this.interactive.playable.has(id) || this.interactive.jumpable.has(id);

    this.canvas.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const d = this.drag;
        if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 10) d.moved = true;
        if (d.moved) {
          setNdc(e);
          ray.setFromCamera(ndc, this.camera);
          const p = new THREE.Vector3();
          ray.ray.intersectPlane(d.plane, p);
          if (p) d.mesh.position.lerp(p, 0.6);
          const r = this.canvas.getBoundingClientRect();
          d.overTable = (e.clientY - r.top) / r.height < 0.62;
          d.mesh.quaternion.slerp(d.overTable ? this._flat(true, 0) : d.q0, 0.15);
          this.anims.delete(d.id);
        }
        return;
      }
      const id = pick(e);
      if (id !== this.hoverId) {
        this.hoverId = id;
        if (id !== null) this.onHover(id);
        this.canvas.style.cursor = id !== null && canAct(id) ? 'grab' : pickPile(e) && this.interactive.myTurn ? 'pointer' : 'default';
        if (this.game) this.sync(this.game, { dur: 0.14 });
      }
    });

    this.canvas.addEventListener('pointerdown', (e) => {
      const id = pick(e);
      if (id === null) {
        if (pickPile(e)) this.onDrawPile();
        else if (this.selectedId !== null) { this.selectedId = null; if (this.game) this.sync(this.game, { dur: 0.15 }); }
        return;
      }
      const m = this.meshes.get(id);
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
      this.drag = { id, mesh: m, sx: e.clientX, sy: e.clientY, moved: false, q0: m.quaternion.clone(), touch: e.pointerType !== 'mouse',
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, m.position) };
      this.canvas.setPointerCapture(e.pointerId);
    });

    const end = (e) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      if (d.moved) {
        if (d.overTable && canAct(d.id)) { this.selectedId = null; this.onCardPlay(d.id); }
        else if (this.game) { d.mesh.userData.target = null; this.sync(this.game, { dur: 0.3 }); }
        return;
      }
      // Tap / click
      if (!canAct(d.id)) { this.onCardPlay(d.id, true); return; }
      if (d.touch && this.selectedId !== d.id) {
        this.selectedId = d.id;
        if (this.game) this.sync(this.game, { dur: 0.15 });
        return;
      }
      this.selectedId = null;
      this.onCardPlay(d.id);
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointerleave', () => { if (!this.drag && this.hoverId !== null) { this.hoverId = null; if (this.game) this.sync(this.game, { dur: 0.15 }); } });
  }

  // ---------------------------------------------------------------- frame
  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    const aspect = w / h;
    this.camera.aspect = aspect;
    // Portrait screens: pull the camera up and back so the whole table fits.
    if (aspect < 0.8) { this.baseCam.pos.set(0, 16.5, 11.5); this.baseCam.look.set(0, 0, -0.4); this.baseCam.fov = 52; this.handDist = 8.2; this.handDrop = 0.31; }
    else if (aspect < 1.3) { this.baseCam.pos.set(0, 12, 10.5); this.baseCam.look.set(0, 0, -0.4); this.baseCam.fov = 46; this.handDist = 8.6; this.handDrop = 0.31; }
    else { this.baseCam.pos.set(0, 9.6, 9.0); this.baseCam.look.set(0, 0, -0.5); this.baseCam.fov = 42; this.handDist = 8.6; this.handDrop = 0.31; }
    this.camera.fov = this.baseCam.fov;
    if (!this.camAnim) { this.camera.position.copy(this.baseCam.pos); this.camLook.copy(this.baseCam.look); }
    this.camera.lookAt(this.camLook);
    this.camera.updateProjectionMatrix();
    // The hand is laid out against the *base* camera so cinematic moves don't drag it along.
    this.layoutCam = new THREE.PerspectiveCamera(this.baseCam.fov, aspect, 0.1, 200);
    this.layoutCam.position.copy(this.baseCam.pos);
    this.layoutCam.lookAt(this.baseCam.look);
    this.layoutCam.updateMatrixWorld();
    if (this.composer) {
      this.composer.setSize(w, h);
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
    }
    if (this.game) { for (const m of this.meshes.values()) m.userData.target = null; this.sync(this.game, { dur: 0.01 }); }
  }

  _frame() {
    // Animations run on real elapsed time so they finish on schedule even at low
    // frame rates; only the particle simulation uses a clamped step.
    const raw = this.clock.getDelta();
    const dt = Math.min(0.05, raw);
    this.time += Math.min(raw, 0.5);
    const t = this.time;
    this._updateAnims();
    this._updateParticles(dt);

    // Camera: cinematic tween, idle orbit (menus) and shake.
    if (this.camAnim) {
      const a = this.camAnim;
      const k = ease.inOut(Math.min(1, (t - a.t0) / a.dur));
      this.camera.position.lerpVectors(a.fromP, a.toP, k);
      this.camLook.lerpVectors(a.fromL, a.toL, k);
      if (k >= 1 && a.done !== true) a.done = true;
    } else if (this.idle) {
      const r = 11;
      this.camera.position.set(Math.sin(t * 0.06) * r, 6.5 + Math.sin(t * 0.13) * 0.6, Math.cos(t * 0.06) * r);
      this.camLook.set(0, 0, 0);
    }
    this.camera.lookAt(this.camLook);
    if (this.shake.t > 0) {
      this.shake.t -= dt;
      const s = this.shake.amp * (this.shake.t / this.shake.dur);
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    }
    // Subtle handheld sway during play.
    if (!this.idle && !this.camAnim) {
      this.camera.position.x += Math.sin(t * 0.5) * 0.02;
      this.camera.position.y += Math.sin(t * 0.37) * 0.015;
    }

    // Direction arrows rotate with the direction of play.
    this.dirRing.rotation.z += dt * 0.35 * -this.dirSign * (1 + this.chaos * 2);
    if (this.dirFlip) {
      this.dirFlip = Math.max(0, this.dirFlip - dt * 1.6);
      this.dirRing.scale.y = Math.cos(this.dirFlip * Math.PI) * -1 * -1;
      this.dirRing.scale.y = 1 - Math.sin(this.dirFlip * Math.PI) * 1.9;
    }
    this.dirRing.children.forEach((c, i) => { if (i % 2 === 1) c.scale.set(1, this.dirSign, 1); });

    // Active color halo pulse.
    this.colorPulse = Math.max(0, (this.colorPulse || 0) - dt * 1.4);
    const pulse = 0.32 + Math.sin(t * 3) * 0.06 + this.colorPulse * 0.4;
    this.colorRing.material.opacity = pulse;
    this.colorRing.scale.setScalar(1 + this.colorPulse * 0.25);
    this.colorLight.intensity = 1.2 + this.colorPulse * 6;

    // Turn disc glides to the current seat.
    if (this.turnTarget) {
      this.turnDisc.position.lerp(new THREE.Vector3(this.turnTarget.x, 0.004, this.turnTarget.z), 1 - Math.pow(0.001, dt));
      this.turnDisc.material.opacity = 0.35 + Math.sin(t * 4) * 0.12;
      this.turnDisc.rotation.z += dt * 0.8;
    }

    // Chaos: pulsing colored lights, stronger bloom, swaying signs.
    const ch = this.chaos;
    this.chaosLightA.intensity = ch * (30 + Math.sin(t * 6) * 18);
    this.chaosLightB.intensity = ch * (30 + Math.cos(t * 5.3) * 18);
    this.chaosLightA.position.x = Math.sin(t * 0.8) * 7;
    this.chaosLightB.position.x = Math.cos(t * 0.7) * 7;
    if (this.bloom) this.bloom.strength = this.baseBloom + ch * 0.6 + (this.colorPulse || 0) * 0.3;
    if (this.grade) {
      const u = this.grade.uniforms;
      u.time.value = t % 100;
      u.aberration.value = ch > 0.3 ? (ch - 0.3) * 0.012 + (this.shake.t > 0 ? 0.006 : 0) : (this.shake.t > 0 ? 0.003 : 0);
      u.saturation.value = 1.08 + ch * 0.25;
      u.contrast.value = 1.06 + ch * 0.08;
    }
    for (const s of this.signs) if (s.material && s.material.opacity !== undefined && s.material.map) s.material.opacity = 0.85 + Math.sin(t * 7 + s.position.x) * 0.08 * (1 + ch * 3);

    for (const u of this.updaters) u(dt, t);
    for (const [id, col] of this.glowCards) {
      const m = this.meshes.get(id);
      if (m) m.material[0].emissive.setHex(col).multiplyScalar(0.35 + Math.sin(t * 5) * 0.2);
    }
    this.onFrame(dt);
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
