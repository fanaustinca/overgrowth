// Hand-rolled post chain: bright-pass -> separable gaussian mips -> composite
// with ACES tonemapping, chromatic aberration, radial flare, vignette, grain.
//
// Written directly against WebGLRenderTarget instead of pulling in the
// EffectComposer addons: it keeps the bundle small, and every stage can be
// switched off individually by the quality tier (which is what makes the
// low-end path actually cheap rather than just "fewer pixels of the same work").

import * as THREE from '../../vendor/three.module.min.js';

const QUAD_VERT = `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BRIGHT_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform float uThreshold, uKnee;
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, l - uThreshold) / max(l, 1e-4);
  gl_FragColor = vec4(c * contrib, 1.0);
}`;

const BLUR_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uDir;      // texel-sized step, horizontal or vertical
void main(){
  vec3 sum = texture2D(tSrc, vUv).rgb * 0.227027;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  sum += (texture2D(tSrc, vUv + o1).rgb + texture2D(tSrc, vUv - o1).rgb) * 0.3162162162;
  sum += (texture2D(tSrc, vUv + o2).rgb + texture2D(tSrc, vUv - o2).rgb) * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}`;

const COMPOSITE_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D tScene, tBloom0, tBloom1;
uniform float uBloom, uCA, uVignette, uGrain, uTime, uExposure;
uniform float uFlare;        // 0..1 strength of the fork-choice light flare
uniform vec2  uFlarePos;     // screen-space origin of the flare
uniform vec3  uFlareTint;
uniform int   uBloomLevels;

vec3 aces(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main(){
  vec2 uv = vUv;
  vec2 fromCenter = uv - 0.5;

  // Chromatic aberration scales with the micro-shake, strongest at the edges.
  float ca = uCA * (0.35 + dot(fromCenter, fromCenter) * 2.0);
  vec3 col;
  col.r = texture2D(tScene, uv + fromCenter * ca).r;
  col.g = texture2D(tScene, uv).g;
  col.b = texture2D(tScene, uv - fromCenter * ca).b;

  if (uBloomLevels > 0) {
    vec3 b = texture2D(tBloom0, uv).rgb;
    if (uBloomLevels > 1) b += texture2D(tBloom1, uv).rgb * 0.7;
    col += b * uBloom;
  }

  // Screen-space flare: an anisotropic streak plus a soft bloom disc.
  if (uFlare > 0.001) {
    vec2 d = uv - uFlarePos;
    d.x *= 1.9;
    float r = length(d);
    float disc = exp(-r * 9.0);
    float streak = exp(-abs(d.y) * 90.0) * exp(-abs(d.x) * 3.0);
    col += uFlareTint * uFlare * (disc * 0.9 + streak * 0.75);
  }

  col = aces(col * uExposure);
  col *= 1.0 - uVignette * dot(fromCenter, fromCenter) * 1.6;

  float g = fract(sin(dot(uv * 1024.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  col += (g - 0.5) * uGrain;

  gl_FragColor = vec4(col, 1.0);
}`;

class Pass {
  constructor(fragmentShader, uniforms) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false,
    });
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  render(renderer, target) {
    renderer.setRenderTarget(target || null);
    renderer.render(this.scene, this.camera);
  }
  dispose() { this.material.dispose(); }
}

function makeRT(w, h, samples = 0) {
  const rt = new THREE.WebGLRenderTarget(Math.max(2, w | 0), Math.max(2, h | 0), {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  // MSAA on the scene target only. The vine's silhouette against a near-black
  // background aliases badly without it, and the bloom mips don't need it.
  if (samples) rt.samples = samples;
  return rt;
}

export class PostChain {
  constructor(renderer, tier) {
    this.renderer = renderer;
    this.tier = tier;
    this.enabled = true;

    this.bright = new Pass(BRIGHT_FRAG, {
      tSrc: { value: null }, uThreshold: { value: 0.95 }, uKnee: { value: 0.22 },
    });
    this.blur = new Pass(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.composite = new Pass(COMPOSITE_FRAG, {
      tScene: { value: null }, tBloom0: { value: null }, tBloom1: { value: null },
      uBloom: { value: 0.55 }, uCA: { value: 0 }, uVignette: { value: 0.55 },
      uGrain: { value: 0.022 }, uTime: { value: 0 }, uExposure: { value: 1.05 },
      uFlare: { value: 0 }, uFlarePos: { value: new THREE.Vector2(0.5, 0.5) },
      uFlareTint: { value: new THREE.Color(1, 1, 1) },
      uBloomLevels: { value: tier.bloom ? tier.bloomLevels : 0 },
    });

    this.levels = [];
    this.size = new THREE.Vector2(1, 1);
    this.setSize(1, 1);
  }

  setTier(tier) {
    this.tier = tier;
    this.composite.material.uniforms.uBloomLevels.value = tier.bloom ? tier.bloomLevels : 0;
    this.setSize(this.size.x, this.size.y);
  }

  setSize(width, height) {
    this.size.set(width, height);
    const w = Math.max(2, Math.floor(width));
    const h = Math.max(2, Math.floor(height));
    if (this.sceneRT) this.sceneRT.dispose();
    this.sceneRT = makeRT(w, h, this.tier.samples || 0);

    for (const lv of this.levels) { lv.a.dispose(); lv.b.dispose(); }
    this.levels = [];
    const count = this.tier.bloom ? this.tier.bloomLevels : 0;
    let lw = w, lh = h;
    for (let i = 0; i < count; i++) {
      lw = Math.max(2, Math.floor(lw / 2));
      lh = Math.max(2, Math.floor(lh / 2));
      this.levels.push({ a: makeRT(lw, lh), b: makeRT(lw, lh), w: lw, h: lh });
    }
    const u = this.composite.material.uniforms;
    u.tBloom0.value = this.levels[0] ? this.levels[0].a.texture : null;
    u.tBloom1.value = this.levels[1] ? this.levels[1].a.texture : null;
  }

  get renderTarget() { return this.sceneRT; }

  set(name, value) {
    const u = this.composite.material.uniforms[name];
    if (u) u.value = value;
  }

  // Call after the scene has been rendered into `renderTarget`.
  present(time) {
    const r = this.renderer;
    this.composite.material.uniforms.uTime.value = time;
    this.composite.material.uniforms.tScene.value = this.sceneRT.texture;

    let src = this.sceneRT;
    for (let i = 0; i < this.levels.length; i++) {
      const lv = this.levels[i];
      if (i === 0) {
        this.bright.material.uniforms.tSrc.value = src.texture;
        this.bright.render(r, lv.a);
      } else {
        this.blur.material.uniforms.tSrc.value = src.texture;
        this.blur.material.uniforms.uDir.value.set(1 / (lv.w * 2), 0);
        this.blur.render(r, lv.a);
      }
      this.blur.material.uniforms.tSrc.value = lv.a.texture;
      this.blur.material.uniforms.uDir.value.set(1 / lv.w, 0);
      this.blur.render(r, lv.b);
      this.blur.material.uniforms.tSrc.value = lv.b.texture;
      this.blur.material.uniforms.uDir.value.set(0, 1 / lv.h);
      this.blur.render(r, lv.a);
      src = lv.a;
    }

    this.composite.render(r, null);
  }

  dispose() {
    this.sceneRT && this.sceneRT.dispose();
    for (const lv of this.levels) { lv.a.dispose(); lv.b.dispose(); }
    this.bright.dispose(); this.blur.dispose(); this.composite.dispose();
  }
}
