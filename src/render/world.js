// Scene, lighting, ground, drifting motes, and the camera rig.

import * as THREE from '../../vendor/three.module.min.js';
import { CURVE_CHUNK } from './curve.js';

const GROUND_Y = -7.5;

const GROUND_FRAG = `
precision mediump float;
varying vec2 vUv;
varying vec3 vWorld;
uniform vec3 uNear, uFar;
uniform float uTime;
#include <fog_pars_fragment>
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}
void main(){
  float n = noise(vWorld.xz * 0.06) * 0.6 + noise(vWorld.xz * 0.24) * 0.3;
  // A soft brightening under the play area anchors the track to the floor.
  float lane = exp(-abs(vWorld.x) * 0.035);
  vec3 col = mix(uFar, uNear, lane * 0.75 + n * 0.35);
  col *= 0.55 + 0.45 * n;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}`;

const GROUND_VERT = `
${CURVE_CHUNK}
varying vec2 vUv;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main(){
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorld = worldPos.xyz;
  vec4 mvPosition = curveView(viewMatrix * worldPos);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const SKY_VERT = `
varying float vH;
void main(){
  vH = normalize(position).y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = `
precision mediump float;
varying float vH;
uniform vec3 uTop, uBottom, uHorizon;
void main(){
  float h = vH * 0.5 + 0.5;
  vec3 col = mix(uBottom, uHorizon, smoothstep(0.0, 0.5, h));
  col = mix(col, uTop, smoothstep(0.45, 1.0, h));
  gl_FragColor = vec4(col, 1.0);
}`;

const MOTE_VERT = `
${CURVE_CHUNK}
attribute float aSize;
attribute float aSeed;
varying float vAlpha;
varying float vSeed;
uniform float uTime;
uniform float uPixelRatio;
void main(){
  vec3 p = position;
  // Cheap per-mote swirl so the field never looks like a static point cloud.
  p.x += sin(uTime * 0.7 + aSeed * 6.28) * 0.9;
  p.y += cos(uTime * 0.55 + aSeed * 12.0) * 0.7;
  vec4 mv = curveView(modelViewMatrix * vec4(p, 1.0));
  float dist = -mv.z;
  vAlpha = smoothstep(140.0, 30.0, dist) * smoothstep(1.5, 8.0, dist);
  vSeed = aSeed;
  gl_PointSize = aSize * uPixelRatio * (34.0 / max(dist, 1.0));
  gl_Position = projectionMatrix * mv;
}`;

const MOTE_FRAG = `
// highp to match the vertex stage's default precision for uTime - a mismatch
// on a uniform shared across stages fails program validation on some drivers.
precision highp float;
varying float vAlpha;
varying float vSeed;
uniform vec3 uColor;
uniform float uTime;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float core = exp(-r * r * 16.0);
  float twinkle = 0.65 + 0.35 * sin(uTime * 3.0 + vSeed * 30.0);
  gl_FragColor = vec4(uColor * core * twinkle, core * vAlpha * 0.9);
}`;

export class World {
  constructor(tier, biome) {
    this.tier = tier;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 320);

    this.fog = new THREE.Fog(0x081a12, 55, 260);
    this.scene.fog = this.fog;

    this.groundMat = new THREE.ShaderMaterial({
      vertexShader: GROUND_VERT,
      fragmentShader: GROUND_FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uNear: { value: new THREE.Color(0x123020) }, uFar: { value: new THREE.Color(0x040d08) }, uTime: { value: 0 } },
      ]),
      fog: true,
    });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(460, 660, 40, 60), this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = GROUND_Y;
    this.ground.renderOrder = -1;
    this.scene.add(this.ground);

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x050f0a) },
        uHorizon: { value: new THREE.Color(0x123a26) },
        uBottom: { value: new THREE.Color(0x030805) },
      },
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(280, 24, 16), this.skyMat);
    this.sky.renderOrder = -2;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this._buildMotes(tier);

    // Camera rig state.
    this.camTarget = new THREE.Vector3();
    this.camPos = new THREE.Vector3(0, 6, -14);
    this.lookAt = new THREE.Vector3();
    this.shake = 0;
    this.shakeVec = new THREE.Vector3();
    this.zoom = 0;
    this.port = 0;

    this.setBiome(biome);
  }

  _buildMotes(tier) {
    if (this.motes) {
      this.scene.remove(this.motes);
      this.motes.geometry.dispose();
      this.motes.material.dispose();
    }
    const count = tier.motes;
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const seed = new Float32Array(count);
    this.moteBox = { x: 70, y: 34, z: 150 };
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.moteBox.x;
      pos[i * 3 + 1] = (Math.random() - 0.5) * this.moteBox.y + 2;
      pos[i * 3 + 2] = Math.random() * this.moteBox.z;
      size[i] = 0.5 + Math.random() * 1.7;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.motes = new THREE.Points(geo, new THREE.ShaderMaterial({
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0xffe9a8) },
        uPixelRatio: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.motes.frustumCulled = false;
    this.scene.add(this.motes);
    this.motePos = pos;
    this.moteCount = count;
  }

  setTier(tier) {
    this.tier = tier;
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x050f0a) },
        uHorizon: { value: new THREE.Color(0x123a26) },
        uBottom: { value: new THREE.Color(0x030805) },
      },
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(280, 24, 16), this.skyMat);
    this.sky.renderOrder = -2;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this._buildMotes(tier);
  }

  setBiome(biome) {
    this.biome = biome;
    this.fog.color.setHex(biome.fog);
    this.scene.background = new THREE.Color(biome.sky[1]);
    this.groundMat.uniforms.uNear.value.setHex(biome.sky[0]).multiplyScalar(3.6);
    this.groundMat.uniforms.uFar.value.setHex(biome.sky[1]).multiplyScalar(2.0);
    this.motes.material.uniforms.uColor.value.setHex(biome.mote);
    this.skyMat.uniforms.uTop.value.setHex(biome.sky[1]).multiplyScalar(1.4);
    this.skyMat.uniforms.uBottom.value.setHex(biome.sky[1]);
    this.skyMat.uniforms.uHorizon.value.setHex(biome.fog).multiplyScalar(2.0);
  }

  setPixelRatio(pr) { this.motes.material.uniforms.uPixelRatio.value = pr; }

  addShake(amount) { this.shake = Math.min(1.4, this.shake + amount); }

  // Camera pulls back and widens as the vine gets longer - the scale-and-stakes
  // read from the brief. Both are smoothed so growth never snaps.
  updateCamera(dt, headPos, headDir, length) {
    const k = 1 - Math.exp(-length / 170);
    this.zoom += (k - this.zoom) * Math.min(1, dt * 1.4);

    // Pitched down ~30 degrees, which is the shallowest angle that keeps the
    // horizon just off the top of the frame. Anything shallower compresses the
    // next three forks into a thin band at the skyline, and the whole game is
    // reading those forks; anything steeper loses the vine's body entirely.
    // A portrait phone crops the frame horizontally, so the two candidate lanes
    // and the near ribbon crowd the edges. Pull the rig back and up (and widen
    // a little) in proportion to how far the aspect falls below landscape.
    const port = this.closeUp ? 0 : THREE.MathUtils.clamp((1.6 - (this.aspect || 1.6)) / 1.05, 0, 1);
    const dist = ((this.closeUp ? 9.0 : 26.0) + 9.0 * this.zoom) * (1 + 0.24 * port);
    const height = ((this.closeUp ? 3.5 : 21.0) + 7.0 * this.zoom) * (1 + 0.34 * port);
    const fov = (56 + 10 * this.zoom) * (1 + 0.12 * port);
    this.port = port;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    this.camTarget.set(
      this.closeUp ? headPos.x + 7 : headPos.x * 0.55 - headDir.x * dist * 0.25,
      headPos.y + height,
      this.closeUp ? headPos.z - 14 : headPos.z - dist,
    );
    const follow = 1 - Math.exp(-dt * 4.5);
    this.camPos.lerp(this.camTarget, follow);

    this.shake *= Math.pow(0.02, dt);
    if (this.shake > 0.001) {
      const s = this.shake;
      this.shakeVec.set(
        (Math.random() - 0.5) * s * 1.1,
        (Math.random() - 0.5) * s * 0.9,
        (Math.random() - 0.5) * s * 0.5,
      );
    } else {
      this.shakeVec.set(0, 0, 0);
    }

    this.camera.position.copy(this.camPos).add(this.shakeVec);
    // Look a fixed distance past the head rather than at the horizon: that keeps
    // the head high enough in frame to read, with the next two forks above it.
    // closeUp is a debug rig: it sits alongside the body a little way back from
    // the tip so the material can be inspected away from the growth glow.
    this.lookAt.lerp(
      this.closeUp
        ? new THREE.Vector3(headPos.x, headPos.y, headPos.z - 12)
        : new THREE.Vector3(headPos.x * 0.6, headPos.y + 1.0 + 3.5 * this.port, headPos.z + 12 + 18 * this.port),
      1 - Math.exp(-dt * 5),
    );
    this.camera.lookAt(this.lookAt);

    // Keep the ground, sky, and mote field centred on the action.
    this.ground.position.z = headPos.z + 120;
    this.ground.position.x = headPos.x * 0.3;
    this.sky.position.copy(this.camera.position);
  }

  // Motes wrap around the camera and get shoved by the passing vine head.
  updateMotes(dt, elapsed, headPos, speed) {
    this.motes.material.uniforms.uTime.value = elapsed;
    const p = this.motePos;
    const cz = this.camera.position.z;
    const cx = this.camera.position.x;
    const box = this.moteBox;
    const drift = dt * (0.6 + speed * 0.02);
    for (let i = 0; i < this.moteCount; i++) {
      const i3 = i * 3;
      p[i3 + 1] += drift * 0.6;
      p[i3 + 2] -= drift * 2.2;

      // Push away from the vine head so movement disturbs the field.
      const dx = p[i3] - headPos.x, dy = p[i3 + 1] - headPos.y, dz = p[i3 + 2] - headPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 36 && d2 > 0.01) {
        const f = (1 - d2 / 36) * dt * 26 / Math.sqrt(d2);
        p[i3] += dx * f; p[i3 + 1] += dy * f; p[i3 + 2] += dz * f;
      }

      if (p[i3 + 2] < cz - 20) p[i3 + 2] += box.z;
      else if (p[i3 + 2] > cz + box.z) p[i3 + 2] -= box.z;
      if (p[i3] < cx - box.x / 2) p[i3] += box.x;
      else if (p[i3] > cx + box.x / 2) p[i3] -= box.x;
      if (p[i3 + 1] > 22) p[i3 + 1] = -14;
    }
    this.motes.geometry.attributes.position.needsUpdate = true;
  }

  resize(width, height) {
    this.aspect = width / height;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt, elapsed) {
    this.groundMat.uniforms.uTime.value = elapsed;
  }
}

export { GROUND_Y };
