// The vine body: a spring chain that the tube mesh is rebuilt around every
// frame, plus the shader that gives it translucency and growing surface detail.
//
// Sim model: each spine node is pinned by a spring to the rest position it was
// born at (the point on the track the head passed through) and is also coupled
// to its neighbours. The pin gives the vine its shape; the coupling lets an
// impulse at the head travel backwards as a wave, which is what sells the
// soft-body feel on a fork commit or a hazard hit.

import * as THREE from '../../vendor/three.module.min.js';
import { CURVE_CHUNK } from './curve.js';

export const NODE_SPACING = 1.25;

const VERT = `
${CURVE_CHUNK}
attribute float aThick;
attribute float aTip;
attribute float aArc;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vThick;
varying float vTip;
varying float vArc;
varying float vAngle;
varying float vViewDist;
#include <fog_pars_vertex>
void main(){
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorld = worldPos.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vThick = aThick;
  vTip = aTip;
  vArc = aArc;
  vAngle = uv.x;
  vec4 mvPosition = curveView(viewMatrix * worldPos);
  vViewDist = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vThick;
varying float vTip;
varying float vArc;
varying float vAngle;
varying float vViewDist;

uniform vec3 uBase, uDeep, uGlow, uSSS, uRim;
uniform vec3 uLightDir, uLightColor, uAmbTop, uAmbBot;
uniform float uTime, uRippleArc, uRippleAmp, uHurt, uShine;
uniform int uMode;     // 0 bark, 1 scale, 2 crystal
uniform int uOctaves;
uniform vec2 uNearFade;
uniform vec2 uTrail;   // world units behind the head where the body dissolves
uniform float uHeadArc;
uniform int uDebug;    // 0 off, 1 height field, 2 perturbed normal, 3 thickness
#include <fog_pars_fragment>

float hash13(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1,0,0));
  float n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1));
  float n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float fbm(vec3 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    if (i >= uOctaves) break;
    v += a * vnoise(p);
    p *= 2.07;
    a *= 0.52;
  }
  return v;
}

// Surface height field. Its character switches with the biome material, and its
// amplitude ramps in with thickness so a freshly grown tip reads as smooth.
float surface(vec3 p, float ang, float arc){
  if (uMode == 1) {
    // Scales: offset rows of overlapping lobes around the circumference.
    float rows = 9.0;
    float y = arc * 1.6;
    float row = floor(y);
    float ax = fract(ang * rows + mod(row, 2.0) * 0.5);
    float ay = fract(y);
    vec2 d = vec2(ax - 0.5, ay - 0.5);
    float lobe = 1.0 - smoothstep(0.16, 0.46, length(d * vec2(1.0, 1.35)));
    return lobe * 0.75 + fbm(p * 2.4) * 0.25;
  }
  if (uMode == 2) {
    // Crystal: quantised noise -> flat facets with hard edges.
    float n = fbm(p * 1.7);
    return floor(n * 7.0) / 7.0 + fbm(p * 6.0) * 0.08;
  }
  // Bark: fibres stretched along the vine, broken up by low-frequency rot, plus
  // a finer grain so the surface still holds up close to the camera.
  float fibre = fbm(vec3(p.x * 3.4, p.y * 3.4, p.z * 0.55 + arc * 0.35));
  float ridge = abs(sin(fibre * 7.5 + arc * 1.6));
  float grain = vnoise(vec3(p.x * 14.0, p.y * 14.0, p.z * 3.0 + arc));
  return mix(mix(fibre, 1.0 - ridge, 0.55), grain, 0.18);
}

void main(){
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uLightDir);

  float detail = smoothstep(0.06, 0.75, vThick);
  vec3 sp = vWorld * 0.32;
  float h = surface(sp, vAngle, vArc);

  // Analytic bump: sample the height field along two surface tangents.
  if (uOctaves >= 3) {
    vec3 T = normalize(cross(N, abs(N.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
    vec3 B = cross(N, T);
    float e = 0.22;
    float hT = surface(sp + T * e, vAngle + 0.03, vArc);
    float hB = surface(sp + B * e, vAngle, vArc + 0.05);
    float amp = 3.2 * detail;
    vec3 bumped = normalize(N - (hT - h) * amp * T - (hB - h) * amp * B);
    // A steep gradient can flip the normal past the silhouette, which shows up
    // as isolated black pixels; clamp it back toward the geometric normal.
    N = dot(bumped, N) < 0.25 ? normalize(mix(N, bumped, 0.5)) : bumped;
  }

  // Creases double as cheap ambient occlusion.
  // Contrast is deliberately aggressive: the height field is rich, but once it
  // passes through wrapped diffuse plus ambient plus subsurface, a gentle
  // modulation washes out to a flat plastic tube.
  float crease = smoothstep(0.8, 0.18, h);
  vec3 albedo = mix(uBase, uDeep, crease * (0.62 + 0.25 * detail));
  albedo *= mix(1.0, 0.55 + 0.9 * h, detail);

  // Wrapped diffuse - the soft-body read comes from light bleeding past the
  // terminator rather than a hard lambert edge.
  float ndl = dot(N, L);
  float wrap = clamp((ndl + 0.45) / 1.45, 0.0, 1.0);
  vec3 diffuse = uLightColor * wrap;

  vec3 ambient = mix(uAmbBot, uAmbTop, N.y * 0.5 + 0.5);
  float fill = clamp(dot(N, normalize(vec3(-L.x, 0.15, -L.z))) * 0.5 + 0.5, 0.0, 1.0);
  ambient += uRim * fill * 0.28;
  float ao = mix(1.0, 0.34, crease) * mix(0.68, 1.0, N.y * 0.5 + 0.5);

  // Subsurface: light travelling through the body toward the camera. Thin
  // sections (new growth, the tip) transmit far more.
  float thin = 1.0 - smoothstep(0.0, 0.85, vThick);
  float back = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 3.5);
  // Modulated by the height field as well: an unmodulated transmit term is a
  // flat wash of the subsurface colour, and on the wide near-camera body that
  // wash is strong enough to erase the bark entirely.
  float sss = back * (0.35 + 0.65 * thin) * (0.45 + 0.55 * (1.0 - crease)) * (0.5 + 0.5 * h);
  vec3 transmit = uSSS * sss * 1.5;

  float shine = uMode == 2 ? uShine * 2.2 : uShine;
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), uMode == 2 ? 96.0 : 34.0) * shine;

  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 rim = uRim * fres * (0.35 + 0.65 * thin);

  // The body behind the head sweeps toward the camera and shows the viewer a
  // lot of grazing-angle surface, where the rim and subsurface terms peak. At
  // that scale they stop being an accent and become a flat wash of rim colour
  // over the whole lower frame, so both are pulled down along the tail. Keyed
  // off arc behind the head rather than camera distance: the rig sits further
  // back in portrait, and this read has to hold on both.
  float tail = smoothstep(4.0, 14.0, uHeadArc - vArc);
  rim *= mix(1.0, 0.2, tail);
  transmit *= mix(1.0, 0.4, tail);

  // Growth tip glow, and the ripple that races back down the body when the
  // player commits to a fork.
  float tipGlow = pow(clamp(vTip, 0.0, 1.0), 2.6);
  float ripple = uRippleAmp * exp(-pow((vArc - uRippleArc) * 0.55, 2.0));

  // Weights tuned so the skin's own hue survives: a full-strength warm key on
  // green albedo reads as olive, so the key is pulled back and the cool
  // hemisphere fill and subsurface term carry more of the exposure.
  vec3 color = albedo * (diffuse * 1.3 + ambient * 0.7) * ao
             + transmit * 0.5
             + spec * uLightColor * 0.3
             + rim * 0.7
             + uGlow * (tipGlow * 0.9 + ripple * 0.9);

  color = mix(color, vec3(1.0, 0.25, 0.2), uHurt * 0.55);

  // Near-camera dissolve. The body trailing under the camera is only a few
  // units away and would otherwise fill the lower third of the frame as a flat
  // slab; fading it into the atmosphere keeps the head and the forks readable
  // and reads as the vine receding into mist behind you.
  float nearFade = smoothstep(uNearFade.x, uNearFade.y, vViewDist);
  // The body behind the head sweeps toward the camera and, on a chase rig, its
  // near end is a frame-filling wedge - wide enough that no amount of surface
  // detail survives at that scale. Dissolving it by arc distance behind the
  // head (rather than by distance to the camera, which a high rig never gets
  // small) keeps the silhouette a tapering tail on every aspect ratio.
  float trailFade = 1.0 - smoothstep(uTrail.x, uTrail.y, uHeadArc - vArc);
  color = mix(fogColor, color, min(nearFade, trailFade));

  if (uDebug == 1) { gl_FragColor = vec4(vec3(h), 1.0); return; }
  if (uDebug == 4) { gl_FragColor = vec4(vec3(crease), 1.0); return; }
  if (uDebug == 5) { gl_FragColor = vec4(albedo, 1.0); return; }
  if (uDebug == 6) { gl_FragColor = vec4(vec3(wrap), 1.0); return; }
  if (uDebug == 7) { gl_FragColor = vec4(albedo * (diffuse * 0.85 + ambient * 0.7) * ao, 1.0); return; }
  if (uDebug == 2) { gl_FragColor = vec4(N * 0.5 + 0.5, 1.0); return; }
  if (uDebug == 3) { gl_FragColor = vec4(vec3(detail), 1.0); return; }

  gl_FragColor = vec4(color, 1.0);
  #include <fog_fragment>
}`;

export class VineBody {
  constructor(tier, skin, biome) {
    this.tier = tier;
    this.radial = tier.radialSegments;
    this.maxRings = tier.maxRings;

    this.nodes = [];       // {rest, pos, vel, arc}
    this.headPos = new THREE.Vector3();
    this.headDir = new THREE.Vector3(0, 0, 1);
    this.travel = 0;
    this.radius = 1.15;
    this.visibleRings = 24;

    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uBase: { value: new THREE.Color(0x3f7d3a) },
        uDeep: { value: new THREE.Color(0x123a1c) },
        uGlow: { value: new THREE.Color(0x9dff6a) },
        uNearFade: { value: new THREE.Vector2(5, 16) },
        uTrail: { value: new THREE.Vector2(16, 34) },
        uHeadArc: { value: 0 },
        uSSS: { value: new THREE.Color(0x74d84a) },
        uRim: { value: new THREE.Color(0x66ffcc) },
        uLightDir: { value: new THREE.Vector3(0.62, 0.5, -0.45).normalize() },
        uLightColor: { value: new THREE.Color(0xffe6b0) },
        uAmbTop: { value: new THREE.Color(0x2a4a3a) },
        uAmbBot: { value: new THREE.Color(0x060d0a) },
        uTime: { value: 0 },
        uRippleArc: { value: -999 },
        uRippleAmp: { value: 0 },
        uHurt: { value: 0 },
        uShine: { value: 0.13 },
        uMode: { value: 0 },
        uOctaves: { value: tier.noiseOctaves },
        uDebug: { value: 0 },
      },
    ]);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, fog: true,
    });

    this._buildGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;

    if (skin) this.setSkin(skin);
    if (biome) this.setBiome(biome);
  }

  _buildGeometry() {
    const R = this.radial, N = this.maxRings;
    const vertCount = R * N;
    const geo = new THREE.BufferGeometry();
    this.aPos = new Float32Array(vertCount * 3);
    this.aNorm = new Float32Array(vertCount * 3);
    this.aUv = new Float32Array(vertCount * 2);
    this.aThick = new Float32Array(vertCount);
    this.aTip = new Float32Array(vertCount);
    this.aArc = new Float32Array(vertCount);

    const idx = new Uint32Array((N - 1) * R * 6);
    let o = 0;
    for (let i = 0; i < N - 1; i++) {
      for (let j = 0; j < R; j++) {
        const a = i * R + j;
        const b = i * R + ((j + 1) % R);
        const c = (i + 1) * R + j;
        const d = (i + 1) * R + ((j + 1) % R);
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }

    geo.setAttribute('position', new THREE.BufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.aNorm, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.aUv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aThick', new THREE.BufferAttribute(this.aThick, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aTip', new THREE.BufferAttribute(this.aTip, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aArc', new THREE.BufferAttribute(this.aArc, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    // Scratch frame vectors, reused every rebuild.
    this._t = new THREE.Vector3();
    this._n = new THREE.Vector3(0, 1, 0);
    this._b = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  setSkin(skin) {
    this.uniforms.uBase.value.setHex(skin.base);
    this.uniforms.uDeep.value.setHex(skin.deep);
    this.uniforms.uGlow.value.setHex(skin.glow);
    this.uniforms.uSSS.value.setHex(skin.sss);
  }

  setBiome(biome) {
    this.uniforms.uRim.value.setHex(biome.rim);
    this.uniforms.uLightColor.value.setHex(biome.key);
    this.uniforms.uAmbTop.value.setHex(biome.sky[0]).multiplyScalar(3.4);
    this.uniforms.uAmbBot.value.setHex(biome.sky[1]);
    this.uniforms.uMode.value = biome.material === 'scale' ? 1 : biome.material === 'crystal' ? 2 : 0;
    this.uniforms.uShine.value = biome.material === 'crystal' ? 0.28 : biome.material === 'scale' ? 0.2 : 0.13;
  }

  setTier(tier) {
    if (tier.radialSegments === this.radial && tier.maxRings === this.maxRings) {
      this.uniforms.uOctaves.value = tier.noiseOctaves;
      return;
    }
    const nodes = this.nodes;
    this.geometry.dispose();
    this.tier = tier;
    this.radial = tier.radialSegments;
    this.maxRings = tier.maxRings;
    this.uniforms.uOctaves.value = tier.noiseOctaves;
    this._buildGeometry();
    this.mesh.geometry = this.geometry;
    this.nodes = nodes.slice(-this.maxRings);
  }

  reset(startPos) {
    this.nodes.length = 0;
    this.travel = 0;
    this.headPos.copy(startPos);
    for (let i = 0; i < 6; i++) {
      this._pushNode(new THREE.Vector3(startPos.x, startPos.y, startPos.z - (6 - i) * NODE_SPACING));
    }
    this.uniforms.uRippleAmp.value = 0;
    this.uniforms.uHurt.value = 0;
  }

  _pushNode(p) {
    this.nodes.push({
      rest: p.clone(),
      pos: p.clone(),
      vel: new THREE.Vector3(),
      arc: this.travel,
    });
    if (this.nodes.length > this.maxRings) this.nodes.shift();
  }

  // Called by the game each frame with the head's position on the track.
  advance(headPos, headDir, distance) {
    this.travel = distance;
    this.headPos.copy(headPos);
    this.headDir.copy(headDir);
    const last = this.nodes[this.nodes.length - 1];
    if (!last || last.rest.distanceTo(headPos) >= NODE_SPACING) this._pushNode(headPos);
  }

  // A whip impulse applied near the tip, falling off backwards.
  impulse(dir, strength, reach = 14) {
    const n = this.nodes.length;
    for (let i = Math.max(0, n - reach); i < n; i++) {
      const f = (i - (n - reach)) / reach;
      this.nodes[i].vel.addScaledVector(dir, strength * f * f);
    }
  }

  ripple(strength = 1) {
    this.uniforms.uRippleArc.value = this.travel;
    this.uniforms.uRippleAmp.value = strength;
  }

  hurt() { this.uniforms.uHurt.value = 1; }

  update(dt, length, elapsed) {
    const u = this.uniforms;
    u.uTime.value = elapsed;
    u.uRippleAmp.value *= Math.pow(0.12, dt);      // fade the flash
    u.uRippleArc.value += dt * 46;                 // and let the wave travel
    u.uHurt.value *= Math.pow(0.02, dt);
    u.uHeadArc.value = this.travel;

    this._simulate(dt, elapsed);

    // Global thickness follows total length: the vine visibly fattens as the
    // run goes well, which is also what drives shader detail. The radius is
    // sized against the ~4-unit lane width so the vine reads as a trunk filling
    // its lane rather than a wire lying on it.
    const target = 1.15 + 1.55 * (1 - Math.exp(-length / 140));
    this.radius += (target - this.radius) * Math.min(1, dt * 3);

    // How far the body trails before it dissolves into the atmosphere. This is
    // the real length of the visible tail: on a chase rig the trail runs at the
    // camera, so a long one is a frame-filling wedge rather than a readable
    // body. It grows a little with length, and the ring count follows it - a
    // ring past the dissolve is invisible work.
    const trailEnd = Math.min(24, 13 + length * 0.045);
    u.uTrail.value.set(trailEnd * 0.3, trailEnd);
    this.visibleRings = Math.max(10, Math.min(this.maxRings, Math.round(trailEnd / NODE_SPACING) + 4));

    this._rebuild(length);
  }

  _simulate(dt, elapsed) {
    const h = Math.min(dt, 1 / 30);
    const nodes = this.nodes;
    const n = nodes.length;
    const pin = 46, damp = 7.2, couple = 26;

    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      const tipness = i / Math.max(1, n - 1);

      // Pin toward the path. The tip is pinned hard so collisions match visuals.
      const k = pin * (0.5 + 0.5 * tipness);
      node.vel.x += (node.rest.x - node.pos.x) * k * h;
      node.vel.y += (node.rest.y - node.pos.y) * k * h;
      node.vel.z += (node.rest.z - node.pos.z) * k * h;

      if (i > 0 && i < n - 1) {
        const a = nodes[i - 1].pos, b = nodes[i + 1].pos;
        node.vel.x += ((a.x + b.x) * 0.5 - node.pos.x) * couple * h;
        node.vel.y += ((a.y + b.y) * 0.5 - node.pos.y) * couple * h;
        node.vel.z += ((a.z + b.z) * 0.5 - node.pos.z) * couple * h;
      }

      // Idle breathing so the vine is never completely still.
      const sway = Math.sin(elapsed * 1.7 + node.arc * 0.22) * 0.5;
      node.vel.x += sway * 0.35 * h;
      node.vel.y += Math.cos(elapsed * 1.3 + node.arc * 0.17) * 0.28 * h;

      const d = Math.exp(-damp * h);
      node.vel.multiplyScalar(d);
      node.pos.addScaledVector(node.vel, h);
    }

    if (n) {
      const tip = nodes[n - 1];
      tip.pos.lerp(this.headPos, 0.55);
    }
  }

  _rebuild(length) {
    const nodes = this.nodes;
    const n = nodes.length;
    if (n < 2) return;

    const R = this.radial;
    const count = Math.min(n, this.visibleRings);
    const start = n - count;

    // Parallel-transport frame keeps the tube from twisting between rings.
    let nx = this._n.set(0, 1, 0);
    const t = this._t, b = this._b, tmp = this._tmp;
    let o3 = 0, o2 = 0, o1 = 0;

    for (let i = 0; i < count; i++) {
      const idx = start + i;
      const node = nodes[idx];
      // Tangent over a 2-node stencil. A 1-node stencil on a spring chain lets
      // per-node jitter rotate consecutive rings against each other, which tears
      // the silhouette into a sawtooth.
      const prev = nodes[Math.max(start, idx - 2)];
      const next = nodes[Math.min(n - 1, idx + 2)];
      t.subVectors(next.pos, prev.pos);
      if (t.lengthSq() < 1e-8) t.set(0, 0, 1);
      t.normalize();

      // Re-orthogonalise the carried normal against the new tangent.
      tmp.copy(t).multiplyScalar(nx.dot(t));
      nx.sub(tmp);
      if (nx.lengthSq() < 1e-6) nx.set(0, 1, 0).sub(tmp.copy(t).multiplyScalar(t.y));
      nx.normalize();
      b.crossVectors(t, nx);

      const along = i / (count - 1);                      // 0 tail .. 1 tip
      const tailFade = Math.min(1, along * 6.0);
      // Round the last few rings down to a point so the tube reads as a growing
      // tip rather than a pipe sawn off mid-air.
      const tipT = Math.max(0, along - 0.88) / 0.12;
      const tipTaper = Math.sqrt(Math.max(0.0, 1 - tipT * tipT * 0.985));
      const wobble = 1 + Math.sin(node.arc * 0.22) * 0.07; // slow enough to read as taper, not serration
      const r = this.radius * tailFade * tipTaper * wobble;
      const thickness = Math.min(1, (this.radius / 2.4) * tailFade);
      // Tip glow is measured in world units back from the growth point, not as
      // a fraction of the body: on a long vine a normalised falloff lights the
      // entire on-screen section, which erases the material read completely.
      const tipness = Math.max(0, 1 - (this.travel - node.arc) / 2.5);

      for (let j = 0; j < R; j++) {
        const a = (j / R) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const dx = nx.x * ca + b.x * sa;
        const dy = nx.y * ca + b.y * sa;
        const dz = nx.z * ca + b.z * sa;
        this.aPos[o3] = node.pos.x + dx * r;
        this.aPos[o3 + 1] = node.pos.y + dy * r;
        this.aPos[o3 + 2] = node.pos.z + dz * r;
        this.aNorm[o3] = dx; this.aNorm[o3 + 1] = dy; this.aNorm[o3 + 2] = dz;
        o3 += 3;
        this.aUv[o2] = j / R; this.aUv[o2 + 1] = along;
        o2 += 2;
        this.aThick[o1] = thickness;
        this.aTip[o1] = tipness;
        this.aArc[o1] = node.arc;
        o1 += 1;
      }
    }

    // The whole buffer is re-uploaded rather than a sub-range: at 240 rings x 12
    // segments this is ~35k floats, well under the cost of tracking dirty ranges.
    const g = this.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.attributes.aThick.needsUpdate = true;
    g.attributes.aTip.needsUpdate = true;
    g.attributes.aArc.needsUpdate = true;
    g.setDrawRange(0, Math.max(0, (count - 1) * R * 6));
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
