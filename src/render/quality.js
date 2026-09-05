// Quality tiering.
//
// Two-stage: a real GPU micro-benchmark at boot picks the starting tier, then
// the running average frame time nudges the tier down (and back up) while
// playing. Mid-tier phones vary enormously, so the boot guess is treated as a
// hint rather than a verdict.

import * as THREE from '../../vendor/three.module.min.js';

export const TIERS = {
  low: {
    name: 'low', pixelRatio: 1.0, radialSegments: 6, maxRings: 110,
    motes: 160, bloom: false, bloomLevels: 0, shadowRibbons: false, noiseOctaves: 2, lookahead: 2, samples: 0,
  },
  medium: {
    name: 'medium', pixelRatio: 1.35, radialSegments: 8, maxRings: 170,
    motes: 420, bloom: true, bloomLevels: 1, shadowRibbons: true, noiseOctaves: 3, lookahead: 3, samples: 2,
  },
  high: {
    name: 'high', pixelRatio: 2.0, radialSegments: 12, maxRings: 240,
    motes: 900, bloom: true, bloomLevels: 2, shadowRibbons: true, noiseOctaves: 4, lookahead: 3, samples: 4,
  },
};

const BENCH_FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uT;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), u.x), u.y);
}
void main(){
  vec2 p = vUv * 12.0;
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 10; i++) { v += a * noise(p + uT); p *= 2.03; a *= 0.55; }
  gl_FragColor = vec4(vec3(v), 1.0);
}`;

const BENCH_VERT = `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function deviceHint() {
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const cores = navigator.hardwareConcurrency || (mobile ? 4 : 8);
  const mem = navigator.deviceMemory || (mobile ? 4 : 8);
  if (!mobile && cores >= 8 && mem >= 8) return 'high';
  if (cores <= 4 || mem <= 3) return 'low';
  return 'medium';
}

// ~40ms of fullscreen fragment work, forced to completion with a 1px read.
export function benchmark(renderer) {
  const forced = new URLSearchParams(location.search).get('tier');
  if (forced && TIERS[forced]) {
    console.log('[quality] tier forced to', forced);
    return TIERS[forced];
  }
  const hint = deviceHint();
  let tier = hint;
  try {
    const rt = new THREE.WebGLRenderTarget(256, 256, { depthBuffer: false, stencilBuffer: false });
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new THREE.ShaderMaterial({
      vertexShader: BENCH_VERT, fragmentShader: BENCH_FRAG, uniforms: { uT: { value: 0 } },
    });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam); // warm-up / shader compile, excluded from timing

    const buf = new Uint8Array(4);
    const t0 = performance.now();
    const PASSES = 24;
    for (let i = 0; i < PASSES; i++) {
      mat.uniforms.uT.value = i;
      renderer.render(scene, cam);
    }
    renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, buf); // forces GPU sync
    const perPass = (performance.now() - t0) / PASSES;
    renderer.setRenderTarget(prevTarget);

    rt.dispose(); mat.dispose(); scene.children[0].geometry.dispose();

    if (perPass < 0.55) tier = 'high';
    else if (perPass < 1.8) tier = 'medium';
    else tier = 'low';

    // Never promote a phone-class device above the heuristic guess purely on a
    // synthetic score - thermals will claw it back a minute into a session.
    if (hint === 'low' && tier === 'high') tier = 'medium';
    console.log(`[quality] bench ${perPass.toFixed(2)}ms/pass, hint=${hint} -> ${tier}`);
  } catch (err) {
    console.warn('[quality] benchmark failed, using device hint', err);
  }
  return TIERS[tier];
}

// Runtime watchdog: sustained slow frames step the tier down, a long clean
// stretch steps it back up (once).
export class QualityWatchdog {
  constructor(tier, onChange) {
    // An explicitly forced tier is honoured for the whole session - QA and
    // capture runs need a stable tier, and software GL would demote instantly.
    this.locked = TIERS[new URLSearchParams(location.search).get('tier')] !== undefined;
    this.tier = tier;
    this.onChange = onChange;
    this.avg = 16.7;
    this.slow = 0;
    this.fast = 0;
    this.demoted = false;
    this.order = ['low', 'medium', 'high'];
  }

  update(dtMs) {
    if (this.locked) return;
    this.avg += (Math.min(dtMs, 100) - this.avg) * 0.05;
    if (this.avg > 22) { this.slow += 1; this.fast = 0; } else if (this.avg < 15) { this.fast += 1; this.slow = 0; }

    const idx = this.order.indexOf(this.tier.name);
    if (this.slow > 180 && idx > 0) {
      this.slow = 0; this.demoted = true;
      this.tier = TIERS[this.order[idx - 1]];
      this.onChange(this.tier);
    } else if (this.fast > 900 && this.demoted && idx < 2) {
      this.fast = 0; this.demoted = false;
      this.tier = TIERS[this.order[idx + 1]];
      this.onChange(this.tier);
    }
  }
}
