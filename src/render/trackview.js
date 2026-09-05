// Everything the player reads ahead of the vine: lane ribbons for the upcoming
// forks, reward orbs, hazard clusters, the ghost overlay, and debris bursts.
//
// Meshes are pooled by branch id. The look-ahead window is only ~14 branches
// wide, so the pool churns a handful of objects per fork rather than rebuilding
// the world.

import * as THREE from '../../vendor/three.module.min.js';
import { GROUND_Y } from './world.js';
import { CURVE_CHUNK } from './curve.js';

const RIBBON_VERT = `
${CURVE_CHUNK}
varying vec2 vUv;
varying float vFade;
#include <fog_pars_vertex>
void main(){
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = curveView(viewMatrix * worldPos);
  vFade = smoothstep(14.0, 45.0, -mvPosition.z); // the lane under the vine is metres away and would otherwise dominate
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const RIBBON_FRAG = `
precision mediump float;
varying vec2 vUv;
varying float vFade;
uniform vec3 uColor, uHot;
uniform float uTime, uSelected, uAhead, uRisk, uAlpha, uPassed;
#include <fog_pars_fragment>
void main(){
  float edge = abs(vUv.x - 0.5) * 2.0;
  float body = smoothstep(1.0, 0.55, edge);
  float spine = exp(-edge * edge * 7.0);

  // Energy running along the lane; the selected lane runs brighter and faster.
  float speed = 1.4 + uSelected * 2.2;
  float flow = 0.5 + 0.5 * sin(vUv.y * 15.0 - uTime * speed * 3.0);
  float rails = smoothstep(0.72, 0.98, edge) * (0.35 + 0.65 * flow);

  // Risk lanes get a nervous flicker so they read as dangerous at a glance.
  float flicker = mix(1.0, 0.72 + 0.28 * sin(uTime * 9.0 + vUv.y * 4.0), uRisk);

  vec3 col = uColor * (body * 0.6 + rails * 1.35) + uHot * (spine * (0.22 + 0.36 * flow));
  col *= flicker;
  col *= mix(1.0, 1.75, uSelected);

  float depthFade = 1.0 / (1.0 + uAhead * 0.5);
  float a = (body * 0.5 + rails * 0.85 + spine * 0.55) * uAlpha * depthFade * vFade;
  a *= mix(0.7, 1.0, uSelected);
  // The stretch of lane the vine has already grown over is dead information and
  // sits right under the camera, where it would otherwise be the brightest
  // thing on screen. uPassed is -1 on every branch but the current one, which
  // leaves this term at 1.
  a *= smoothstep(uPassed - 0.04, uPassed + 0.14, vUv.y);

  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
}`;

const SHADOW_FRAG = `
precision mediump float;
varying vec2 vUv;
varying float vFade;
uniform float uAlpha;
void main(){
  float edge = abs(vUv.x - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, edge) * uAlpha * vFade;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a * 0.55);
}`;

const GHOST_FRAG = `
precision mediump float;
varying vec2 vUv;
varying float vFade;
uniform vec3 uColor;
uniform float uTime, uAlpha;
#include <fog_pars_fragment>
void main(){
  float edge = abs(vUv.x - 0.5) * 2.0;
  float dash = step(0.45, fract(vUv.y * 9.0 - uTime * 0.6));
  float body = smoothstep(1.0, 0.2, edge) * dash;
  gl_FragColor = vec4(uColor, body * uAlpha * vFade * 0.5);
  #include <fog_fragment>
}`;

const GLOW_VERT = `
${CURVE_CHUNK}
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main(){
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorld = worldPos.xyz;
  vNormalV = normalize(normalMatrix * normal);
  vec4 mvPosition = curveView(viewMatrix * worldPos);
  vViewDir = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const HALO_FRAG = `
precision mediump float;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vWorld;
uniform vec3 uColor;
uniform float uTime;
void main(){
  // Billboarded-ish soft glow: fades at grazing angles so it reads as light,
  // not as a card.
  float f = pow(max(dot(normalize(vNormalV), normalize(vViewDir)), 0.0), 1.5);
  float pulse = 0.7 + 0.3 * sin(uTime * 3.5 + vWorld.z);
  gl_FragColor = vec4(uColor * f * pulse * 0.4, f * 0.32 * pulse);
}`;

const ORB_FRAG = `
precision mediump float;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vWorld;
uniform vec3 uColor, uCore;
uniform float uTime;
#include <fog_pars_fragment>
void main(){
  float fres = pow(1.0 - max(dot(normalize(vNormalV), normalize(vViewDir)), 0.0), 2.2);
  float pulse = 0.75 + 0.25 * sin(uTime * 4.0 + vWorld.z * 0.5);
  // Core stays a tint of the pickup's own colour: a white core reads as a
  // generic bauble and loses the safe/risk colour language.
  vec3 col = mix(uCore, uColor, 0.35 + 0.65 * fres) * pulse * (1.0 + fres * 1.6);
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}`;

const HAZARD_FRAG = `
precision mediump float;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vWorld;
uniform vec3 uColor;
uniform float uTime;
#include <fog_pars_fragment>
void main(){
  vec3 N = normalize(vNormalV);
  float fres = pow(1.0 - max(dot(N, normalize(vViewDir)), 0.0), 1.6);
  float pulse = 0.55 + 0.45 * sin(uTime * 5.5 + vWorld.z * 0.7 + vWorld.x);
  float lit = max(N.y, 0.0) * 0.25;
  vec3 col = vec3(0.05, 0.02, 0.03) + uColor * (fres * 1.6 * pulse + lit);
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}`;

const NODE_FRAG = `
precision mediump float;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vWorld;
uniform vec3 uColor;
uniform float uTime;
#include <fog_pars_fragment>
void main(){
  float pulse = 0.6 + 0.4 * sin(uTime * 3.0 - vWorld.z * 0.18);
  gl_FragColor = vec4(uColor * pulse * 0.9, 1.0);
  #include <fog_fragment>
}`;

const DEBRIS_VERT = `
${CURVE_CHUNK}
attribute float aSize;
attribute float aLife;
varying float vLife;
uniform float uPixelRatio;
void main(){
  vLife = aLife;
  vec4 mv = curveView(modelViewMatrix * vec4(position, 1.0));
  gl_PointSize = aSize * uPixelRatio * (60.0 / max(-mv.z, 1.0)) * clamp(aLife, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const DEBRIS_FRAG = `
precision mediump float;
varying float vLife;
uniform vec3 uColor;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5 || vLife <= 0.0) discard;
  float core = exp(-r * r * 12.0);
  gl_FragColor = vec4(uColor * (1.0 + core), core * clamp(vLife, 0.0, 1.0));
}`;

// `lift` places the ribbon below the path centreline: lanes are rails the vine
// rides above, not decals painted on top of it. Drawing them at the same height
// as the vine puts an additive sheet straight through the body.
function ribbonGeometry(points, width, flatten, lift = 0) {
  const n = points.length;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx = new Uint16Array((n - 1) * 6);
  const t = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    t.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
    side.crossVectors(t, up).normalize().multiplyScalar(width);
    const y = flatten ? GROUND_Y + 0.05 : p.y + lift;
    const o = i * 6;
    pos[o] = p.x - side.x; pos[o + 1] = y - side.y * 0.15; pos[o + 2] = p.z - side.z;
    pos[o + 3] = p.x + side.x; pos[o + 4] = y + side.y * 0.15; pos[o + 5] = p.z + side.z;
    const u = i * 4;
    uv[u] = 0; uv[u + 1] = i / (n - 1);
    uv[u + 2] = 1; uv[u + 3] = i / (n - 1);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, o = i * 6;
    idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2;
    idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

export function pointAt(branch, t) {
  const pts = branch.points;
  const f = Math.max(0, Math.min(1, t)) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  const k = f - i;
  const a = pts[i], b = pts[i + 1];
  return new THREE.Vector3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
}

const DEBRIS_MAX = 260;

export class TrackView {
  constructor(scene, tier, biome) {
    this.scene = scene;
    this.tier = tier;
    this.biome = biome;
    this.entries = new Map();   // branch id -> { group, ... }
    this.ghostEntries = new Map();
    this.selectedId = null;

    this.ribbonTemplate = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG, fog: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uColor: { value: new THREE.Color(0x4be08a) }, uHot: { value: new THREE.Color(0xbdf5d2) },
          uTime: { value: 0 }, uSelected: { value: 0 }, uAhead: { value: 0 },
          uRisk: { value: 0 }, uAlpha: { value: 1 }, uPassed: { value: -1 },
        },
      ]),
    });

    this.shadowTemplate = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT, fragmentShader: SHADOW_FRAG,
      transparent: true, depthWrite: false, uniforms: { uAlpha: { value: 0.9 } },
    });

    this.ghostMat = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT, fragmentShader: GHOST_FRAG, fog: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uColor: { value: new THREE.Color(0x9fd8ff) }, uTime: { value: 0 }, uAlpha: { value: 1 } },
      ]),
    });

    this.orbMat = this._glowMat(ORB_FRAG, 0x8dff9a, 0xd8ffe4);
    this.gemMat = this._glowMat(ORB_FRAG, 0xffb63c, 0xffe9a8);
    this.hazardMat = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: HAZARD_FRAG, fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uColor: { value: new THREE.Color(0xff3b5c) }, uTime: { value: 0 } },
      ]),
    });

    this.haloGeo = new THREE.SphereGeometry(1.5, 12, 10);
    this.orbHalo = this._glowMat(HALO_FRAG, 0x8dff9a, 0xffffff);
    this.gemHalo = this._glowMat(HALO_FRAG, 0xffd166, 0xffffff);
    for (const m of [this.orbHalo, this.gemHalo]) {
      m.transparent = true; m.depthWrite = false; m.blending = THREE.AdditiveBlending; m.fog = false;
    }
    this.nodeMat = this._glowMat(NODE_FRAG, 0xffffff, 0xffffff);
    this.nodeGeo = new THREE.TorusGeometry(2.0, 0.12, 6, 24);
    this.orbGeo = new THREE.IcosahedronGeometry(0.85, 1);
    this.gemGeo = new THREE.OctahedronGeometry(1.05, 0);
    this.spikeGeo = new THREE.ConeGeometry(0.45, 2.0, 5);

    this.ghostMarker = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 10), this._glowMat(ORB_FRAG, 0x9fd8ff, 0xffffff));
    this.ghostMarker.material.transparent = true;
    this.ghostMarker.material.opacity = 0.5;
    this.ghostMarker.visible = false;
    this.scene.add(this.ghostMarker);

    this._buildDebris();
    this.setBiome(biome);
  }

  _glowMat(frag, color, core) {
    return new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: frag, fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uColor: { value: new THREE.Color(color) }, uCore: { value: new THREE.Color(core) }, uTime: { value: 0 } },
      ]),
    });
  }

  _buildDebris() {
    const pos = new Float32Array(DEBRIS_MAX * 3);
    const size = new Float32Array(DEBRIS_MAX);
    const life = new Float32Array(DEBRIS_MAX);
    this.debrisVel = new Float32Array(DEBRIS_MAX * 3);
    this.debrisCursor = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLife', new THREE.BufferAttribute(life, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.debris = new THREE.Points(g, new THREE.ShaderMaterial({
      vertexShader: DEBRIS_VERT, fragmentShader: DEBRIS_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(0xff8a5c) }, uPixelRatio: { value: 1 } },
    }));
    this.debris.frustumCulled = false;
    this.scene.add(this.debris);
    this.debrisPos = pos; this.debrisSize = size; this.debrisLife = life;
  }

  setPixelRatio(pr) { this.debris.material.uniforms.uPixelRatio.value = pr; }

  setBiome(biome) {
    this.biome = biome;
    this.safeColor = new THREE.Color(biome.rim);
    this.riskColor = new THREE.Color(biome.risk || biome.key);
    this.orbMat.uniforms.uColor.value.setHex(biome.rim);
    this.gemMat.uniforms.uColor.value.setHex(0xffd166);
    this.nodeMat.uniforms.uColor.value.setHex(biome.rim);
    this.hazardMat.uniforms.uColor.value.setHex(biome.id === 'abyss' ? 0xff4bd8 : 0xff3b5c);
    this.ghostMat.uniforms.uColor.value.setHex(0x9fd8ff);
  }

  setTier(tier) { this.tier = tier; }

  // Rebuild the visible set from the current look-ahead list. `projectedIds` is
  // the route the vine takes if the player never taps again: the immediate next
  // branch lights fully, the ones beyond it at half strength, so intent is
  // readable two to three forks out.
  setLookahead(list, selectedId, projectedIds, passed = 0) {
    this.selectedId = selectedId;
    const projected = projectedIds ? new Set(projectedIds) : null;
    const keep = new Set();
    for (const { branch, ahead } of list) {
      keep.add(branch.id);
      let entry = this.entries.get(branch.id);
      if (!entry) entry = this._createBranch(branch);
      entry.ahead = Math.max(0, ahead);
      entry.ribbon.material.uniforms.uAhead.value = Math.max(0, ahead);
      // ahead === -1 is the branch under the vine right now: it has already been
      // decided, so it steps back and lets the open fork carry the eye.
      entry.ribbon.material.uniforms.uAlpha.value =
        ahead < 0 ? 0.4 : (branch.tier === 'risk' ? 0.85 : 1.0);
      entry.ribbon.material.uniforms.uPassed.value = ahead < 0 ? passed : -1;
      entry.ribbonTargetSel = branch.id === selectedId ? 1
        : (projected && projected.has(branch.id) ? 0.45 : 0);
      if (entry.shadow) entry.shadow.material.uniforms.uAlpha.value = 0.85 / (1 + Math.max(0, ahead));
    }
    for (const [id, entry] of this.entries) {
      if (!keep.has(id)) { this._destroy(entry); this.entries.delete(id); }
    }
  }

  setGhost(branches) {
    const keep = new Set();
    for (const b of branches || []) {
      keep.add(b.id);
      if (!this.ghostEntries.has(b.id)) {
        const mesh = new THREE.Mesh(ribbonGeometry(b.points, b.width * 1.0, false, -1.4), this.ghostMat);
        mesh.renderOrder = 3;
        this.scene.add(mesh);
        this.ghostEntries.set(b.id, mesh);
      }
    }
    for (const [id, mesh] of this.ghostEntries) {
      if (!keep.has(id)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        this.ghostEntries.delete(id);
      }
    }
  }

  _createBranch(branch) {
    const group = new THREE.Group();
    const risk = branch.tier === 'risk';

    const mat = this.ribbonTemplate.clone();
    mat.uniforms.uColor.value.copy(risk ? this.riskColor : this.safeColor);
    mat.uniforms.uRisk.value = risk ? 1 : 0;
    mat.uniforms.uAlpha.value = risk ? 0.85 : 1.0;
    const ribbon = new THREE.Mesh(ribbonGeometry(branch.points, branch.width * 1.3, false, -2.1), mat);
    ribbon.renderOrder = 1;
    group.add(ribbon);

    let shadow = null;
    if (this.tier.shadowRibbons) {
      shadow = new THREE.Mesh(
        ribbonGeometry(branch.points, branch.width * 2.4, true),
        this.shadowTemplate.clone(),
      );
      shadow.renderOrder = 0;
      group.add(shadow);
    }

    // Fork marker at the branch's end point, where the next choice happens.
    const end = branch.points[branch.points.length - 1];
    const ring = new THREE.Mesh(this.nodeGeo, this.nodeMat);
    ring.position.set(end.x, end.y - 2.0, end.z);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    const pickupMeshes = [];
    for (const p of branch.pickups) {
      const isGem = p.type === 'gem';
      const mesh = new THREE.Mesh(isGem ? this.gemGeo : this.orbGeo, isGem ? this.gemMat : this.orbMat);
      mesh.position.copy(pointAt(branch, p.t));
      mesh.position.y += 0.2;
      const halo = new THREE.Mesh(this.haloGeo, isGem ? this.gemHalo : this.orbHalo);
      halo.renderOrder = 4;
      mesh.add(halo);
      mesh.userData.pickup = p;
      mesh.userData.baseY = mesh.position.y;
      group.add(mesh);
      pickupMeshes.push(mesh);
    }

    const hazardMeshes = [];
    for (const hz of branch.hazards) {
      const cluster = new THREE.Group();
      cluster.position.copy(pointAt(branch, hz.t));
      cluster.position.y -= 1.9;
      const spikes = 4;
      for (let i = 0; i < spikes; i++) {
        const s = new THREE.Mesh(this.spikeGeo, this.hazardMat);
        const a = hz.phase + (i / spikes) * Math.PI * 2;
        s.position.set(Math.cos(a) * 0.75, 0.85, Math.sin(a) * 0.75);
        s.rotation.set(Math.cos(a) * 0.42, 0, -Math.sin(a) * 0.42);
        cluster.add(s);
      }
      cluster.userData.hazard = hz;
      group.add(cluster);
      hazardMeshes.push(cluster);
    }

    this.scene.add(group);
    const entry = { branch, group, ribbon, shadow, pickupMeshes, hazardMeshes, sel: 0, ahead: 0 };
    this.entries.set(branch.id, entry);
    return entry;
  }

  _destroy(entry) {
    this.scene.remove(entry.group);
    entry.ribbon.geometry.dispose();
    entry.ribbon.material.dispose();
    if (entry.shadow) { entry.shadow.geometry.dispose(); entry.shadow.material.dispose(); }
  }

  burst(position, colorHex, count = 26, spread = 7) {
    this.debris.material.uniforms.uColor.value.setHex(colorHex);
    for (let i = 0; i < count; i++) {
      const i1 = this.debrisCursor;
      const i3 = i1 * 3;
      this.debrisPos[i3] = position.x; this.debrisPos[i3 + 1] = position.y; this.debrisPos[i3 + 2] = position.z;
      this.debrisVel[i3] = (Math.random() - 0.5) * spread;
      this.debrisVel[i3 + 1] = Math.random() * spread * 0.8 + 1.5;
      this.debrisVel[i3 + 2] = (Math.random() - 0.5) * spread;
      this.debrisSize[i1] = 0.6 + Math.random() * 1.6;
      this.debrisLife[i1] = 1;
      this.debrisCursor = (this.debrisCursor + 1) % DEBRIS_MAX;
    }
  }

  update(dt, elapsed, ghostPos) {
    this.ribbonTemplate.uniforms.uTime.value = elapsed;
    this.ghostMat.uniforms.uTime.value = elapsed;
    this.orbMat.uniforms.uTime.value = elapsed;
    this.gemMat.uniforms.uTime.value = elapsed;
    this.orbHalo.uniforms.uTime.value = elapsed;
    this.gemHalo.uniforms.uTime.value = elapsed;
    this.orbHalo.uniforms.uColor.value.copy(this.orbMat.uniforms.uColor.value);
    this.hazardMat.uniforms.uTime.value = elapsed;
    this.nodeMat.uniforms.uTime.value = elapsed;

    for (const entry of this.entries.values()) {
      const u = entry.ribbon.material.uniforms;
      u.uTime.value = elapsed;
      entry.sel += ((entry.ribbonTargetSel || 0) - entry.sel) * Math.min(1, dt * 9);
      u.uSelected.value = entry.sel;

      for (const m of entry.pickupMeshes) {
        const p = m.userData.pickup;
        if (p.taken) { m.visible = false; continue; }
        m.rotation.y += dt * 1.6;
        m.rotation.x += dt * 0.7;
        m.position.y = m.userData.baseY + Math.sin(elapsed * 2.4 + m.position.z) * 0.18;
      }
      for (const c of entry.hazardMeshes) {
        c.visible = !c.userData.hazard.hit;
        c.rotation.y += dt * 0.5;
      }
    }

    if (ghostPos) {
      this.ghostMarker.visible = true;
      this.ghostMarker.position.copy(ghostPos);
      this.ghostMarker.position.y += 1.0;
    } else {
      this.ghostMarker.visible = false;
    }

    // Debris integration.
    let anyAlive = false;
    for (let i = 0; i < DEBRIS_MAX; i++) {
      if (this.debrisLife[i] <= 0) continue;
      anyAlive = true;
      const i3 = i * 3;
      this.debrisVel[i3 + 1] -= 14 * dt;
      this.debrisPos[i3] += this.debrisVel[i3] * dt;
      this.debrisPos[i3 + 1] += this.debrisVel[i3 + 1] * dt;
      this.debrisPos[i3 + 2] += this.debrisVel[i3 + 2] * dt;
      this.debrisLife[i] -= dt * 0.85;
    }
    if (anyAlive) {
      this.debris.geometry.attributes.position.needsUpdate = true;
      this.debris.geometry.attributes.aLife.needsUpdate = true;
      this.debris.geometry.attributes.aSize.needsUpdate = true;
    }
  }

  clear() {
    for (const entry of this.entries.values()) this._destroy(entry);
    this.entries.clear();
    for (const [, mesh] of this.ghostEntries) { this.scene.remove(mesh); mesh.geometry.dispose(); }
    this.ghostEntries.clear();
    this.debrisLife.fill(0);
    this.debris.geometry.attributes.aLife.needsUpdate = true;
  }
}
