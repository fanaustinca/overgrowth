// Boot, game loop, and the wiring between sim, renderer, SDK, and UI.

import * as THREE from '../vendor/three.module.min.js';
import { Game, simulateRoute, LEFT, RIGHT } from './game.js';
import { dailySeed, todaySeedString, randomSeed, hashString } from './rng.js';
import { Progression } from './progression.js';
import { GhostPlayback } from './ghost.js';
import { createAdapter, detectPlatform } from './sdk/adapter.js';
import { benchmark, QualityWatchdog } from './render/quality.js';
import { World } from './render/world.js';
import { VineBody } from './render/vine.js';
import { TrackView, pointAt } from './render/trackview.js';
import { PostChain } from './render/post.js';
import { UI } from './ui.js';
import { Sound } from './sound.js';

const ADS_EVERY_N_RUNS = 3;

class Overgrowth {
  constructor() {
    this.state = 'boot';            // boot | menu | run | results
    this.mode = 'daily';
    this.runsSinceAd = 0;
    this.revivedThisRun = false;
    this.creditedPeak = 0;
    this.flare = 0;
    this.ca = 0;
    this.clock = 0;
    this.floaters = [];
    this._tmpVec = new THREE.Vector3();
  }

  async boot() {
    this.prog = new Progression();
    this.sound = new Sound(this.prog.state.muted);

    this.ui = new UI(this.prog, {
      onPlay: (mode) => this.startRun(mode),
      onMenu: () => this.toMenu(),
      onShare: () => this.share(),
      onRevive: () => this.revive(),
      onCosmeticChange: () => this.applyCosmetics(),
      onToggleSound: () => {
        this.prog.state.muted = !this.prog.state.muted;
        this.prog.save();
        this.sound.setMuted(this.prog.state.muted);
        this.ui.setSoundLabel(this.prog.state.muted);
      },
      onModeChange: (mode) => { this.mode = mode; this.refreshMenu(); },
    });
    this.ui.setLoading(5);

    const canvas = document.getElementById('canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x050d09, 1);
    if (!this.renderer.capabilities.isWebGL2) console.warn('[boot] WebGL2 unavailable, running on WebGL1 fallback');
    this.ui.setLoading(20);

    this.tier = benchmark(this.renderer);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.tier.pixelRatio));
    this.watchdog = new QualityWatchdog(this.tier, (t) => this.applyTier(t));
    this.ui.setLoading(35);

    // SDK first: platforms want init() as early as possible, and loading
    // progress reported while the rest of the scene builds.
    this.adapter = await createAdapter(detectPlatform());
    this.adapter.loadingProgress(45);
    this.ui.setLoading(45);

    const biome = this.prog.biome;
    this.world = new World(this.tier, biome);
    this.vine = new VineBody(this.tier, this.prog.skin, biome);
    this.world.scene.add(this.vine.mesh);
    this.view = new TrackView(this.world.scene, this.tier, biome);
    this.post = new PostChain(this.renderer, this.tier);
    this.ui.setLoading(70);
    this.adapter.loadingProgress(70);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 120));

    // Warm the shaders on a throwaway run so the first real fork never hitches.
    this.game = new Game(dailySeed(), {});
    this.syncView();
    this.vine.reset(new THREE.Vector3(0, 0, 0));
    this.vine.update(0.016, 10, 0);
    this.renderer.compile(this.world.scene, this.world.camera);
    this.renderer.setRenderTarget(this.post.renderTarget);
    this.renderer.render(this.world.scene, this.world.camera);
    this.post.present(0);
    this.ui.setLoading(92);

    this._bindInput();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'run') this.adapter.gameplayStop();
      else if (!document.hidden && this.state === 'run') this.adapter.gameplayStart();
    });

    this.ui.setLoading(100);
    this.adapter.loadingProgress(100);
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.frame(t));

    setTimeout(() => {
      this.ui.hideLoading();
      this.toMenu();
    }, 220);
  }

  _bindInput() {
    const tap = (e) => {
      this.sound.resume();
      if (this.state !== 'run') return;
      // Ignore taps that landed on UI controls.
      if (e.target && e.target.closest && e.target.closest('.btn, .card, .mode')) return;
      this.game.tap();
    };
    window.addEventListener('pointerdown', tap, { passive: true });

    // Desktop gets an absolute left/right as well as the one-button flip:
    // A / D and the arrow keys pick a side, space and enter toggle.
    const SIDE = { ArrowLeft: LEFT, KeyA: LEFT, ArrowRight: RIGHT, KeyD: RIGHT };
    window.addEventListener('keydown', (e) => {
      const side = SIDE[e.code];
      const toggle = e.code === 'Space' || e.code === 'Enter';
      if (side === undefined && !toggle) return;
      e.preventDefault();
      if (this.state === 'run') {
        this.sound.resume();
        if (side !== undefined) this.game.select(side);
        else if (!e.repeat) this.game.tap();
      } else if (!e.repeat && (this.state === 'menu' || this.state === 'results')) {
        this.startRun(this.mode);
      }
    });
  }

  applyTier(tier) {
    this.tier = tier;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.pixelRatio));
    this.world.setTier(tier);
    this.vine.setTier(tier);
    this.view.setTier(tier);
    this.post.setTier(tier);
    this.resize();
    console.log('[quality] switched to', tier.name);
  }

  applyCosmetics() {
    const biome = this.prog.biome;
    this.world.setBiome(biome);
    this.vine.setSkin(this.prog.skin);
    this.vine.setBiome(biome);
    this.view.setBiome(biome);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.world.resize(w, h);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.post.setSize(size.x, size.y);
    const pr = this.renderer.getPixelRatio();
    this.world.setPixelRatio(pr);
    this.view.setPixelRatio(pr);
  }

  // ---- run lifecycle -------------------------------------------------------

  get seedLabel() {
    return this.mode === 'daily' ? todaySeedString() : 'endless #' + (this.seed % 100000);
  }

  refreshMenu() {
    const todayBest = this.prog.bestForSeed(todaySeedString());
    this.ui.el.menuSeed.textContent = this.mode === 'daily' ? todaySeedString() : 'random each run';
    this.ui.el.menuToday.textContent = todayBest || 0;
  }

  toMenu() {
    this.state = 'menu';
    this.adapter.gameplayStop();
    this.ui.hideHud();
    this.ui.hide('results');
    this.ui.showMenu({
      seedLabel: this.mode === 'daily' ? todaySeedString() : 'random each run',
      todayBest: this.prog.bestForSeed(todaySeedString()),
    });
  }

  startRun(mode) {
    this.mode = mode || this.mode;
    // ?seed= pins the track for QA and bug reports; daily mode is otherwise the
    // same tree for every player on a given UTC date.
    const forcedSeed = new URLSearchParams(location.search).get('seed');
    this.seed = forcedSeed ? hashString(forcedSeed)
      : (this.mode === 'daily' ? dailySeed() : randomSeed());
    this.revivedThisRun = false;
    this.creditedPeak = 0;

    this.game = new Game(this.seed, {
      onFlip: (side) => {
        this.sound.flip();
        this.vine.ripple(0.45);
        this.ui.setSelection(side === LEFT);
        this.syncView();
      },
      onFork: (next, finished) => this.onFork(next, finished),
      onPickup: (p, pos) => this.onPickup(p, pos),
      onHazard: (loss, pos) => this.onHazard(loss, pos),
      onEnd: (result) => this.onEnd(result),
    });

    // Ghost: only meaningful when the recorded route belongs to this seed.
    const stored = this.mode === 'daily' ? this.prog.routeForSeed(todaySeedString()) : null;
    this.ghost = stored ? new GhostPlayback(this.game.track, stored) : null;
    this.ghostArc = null;

    this.vine.reset(new THREE.Vector3(this.game.head.x, this.game.head.y, this.game.head.z));
    this.view.clear();
    this.syncView();

    this.ui.hide('menu');
    this.ui.hide('results');
    this.ui.showHud(this.mode);
    this.ui.setSelection(this.game.selection === LEFT);
    this.ui.setLength(this.game.length);
    this.ui.setStage(0);
    this.ui.setGhostDelta(null);
    this.state = 'run';
    this.adapter.gameplayStart();
    this.sound.resume();
  }

  onFork(next) {
    this.vine.ripple(1.0);
    this.world.addShake(next.tier === 'risk' ? 0.3 : 0.18);
    this.flare = Math.max(this.flare, next.tier === 'risk' ? 0.85 : 0.55);
    this.ca = Math.max(this.ca, 0.0035);
    this.sound.fork();
    this.vine.impulse(this._tmpVec.set(next.side * 3.2, 1.1, 0), 1.0);
    if (this.game.forks === 1) this.ui.hideTapHint();
  }

  onPickup(p, pos) {
    const v = new THREE.Vector3(pos.x, pos.y + 0.8, pos.z);
    if (p.type === 'gem') {
      this.sound.gem();
      this.view.burst(v, 0xffd166, 34, 9);
      this.flare = Math.max(this.flare, 1.0);
      this.float(v, `×${this.game.multiplier.toFixed(1)}`, '#ffd166');
      this.adapter.happyTime();
    } else {
      this.sound.orb(this.game.pickupsTaken);
      this.view.burst(v, this.prog.biome.rim, 22, 7);
      this.flare = Math.max(this.flare, 0.6);
      this.float(v, `+${Math.round(p.value * this.game.multiplier)}`, '#7dffb0');
    }
    this.world.addShake(0.14);
    this.vine.ripple(0.8);
  }

  onHazard(loss, pos) {
    const v = new THREE.Vector3(pos.x, pos.y + 0.6, pos.z);
    this.sound.hit();
    this.view.burst(v, this.prog.skin.base, 46, 12);
    this.vine.hurt();
    this.vine.impulse(this._tmpVec.set((Math.random() - 0.5) * 8, -3, -4), 2.2, 20);
    this.world.addShake(1.0);
    this.ca = Math.max(this.ca, 0.016);
    this.flare = Math.max(this.flare, 0.5);
    this.float(v, `−${Math.round(loss)}`, '#ff6b7d');
  }

  onEnd(result) {
    this.state = 'results';
    this.adapter.gameplayStop();
    this.sound.die();
    this.world.addShake(1.2);
    this.ui.hideHud();

    const seedString = this.mode === 'daily' ? todaySeedString() : 'endless';
    const credit = Math.max(0, result.peakLength - this.creditedPeak);
    this.creditedPeak = result.peakLength;

    const outcome = this.prog.recordRun({
      peakLength: result.peakLength,
      credit,
      seedString,
      route: this.mode === 'daily' ? result.route : null,
      countRun: !this.revivedThisRun,
    });

    if (outcome.newPersonalBest) {
      this.adapter.happyTime();
      this.sound.unlock();
    }
    this.adapter.submitScore(result.peakLength);

    for (const item of outcome.unlocked) {
      this.ui.toast('Unlocked · ' + item.name, 'Equip it from Skins & Biomes');
      this.sound.unlock();
    }

    const optimal = this.computeOptimal();
    this.ui.showResults({
      result,
      best: this.prog.state.best,
      seedLabel: this.mode === 'daily' ? todaySeedString() : 'endless',
      isBest: outcome.newPersonalBest,
      optimal,
      canRevive: !this.adapter.isAdBlocked(),
      revivedAlready: this.revivedThisRun,
    });

    // Show the optimal route as a dotted overlay behind the results panel.
    this.view.setGhost(this.optimalBranches || []);

    if (!this.revivedThisRun) this.runsSinceAd += 1;
    if (this.runsSinceAd >= ADS_EVERY_N_RUNS) {
      this.runsSinceAd = 0;
      // Never during a run - only once the results screen is already up.
      setTimeout(() => { if (this.state === 'results') this.adapter.showMidgameAd(); }, 600);
    }
  }

  // The seed's ceiling: beam-search the best route through the track, then
  // replay it through the sim so the number we quote is a length that was
  // actually reachable under decay - not a sum of branch values. Depth is
  // fixed rather than trimmed to the player's run, so every player on a daily
  // seed sees the same target; withering ends even a perfect route near 160
  // forks, so searching deeper only costs time. Cached per seed - the solve is
  // ~100ms and the answer never changes.
  computeOptimal() {
    if (this.optimalCache && this.optimalCache.seed === this.seed) {
      this.optimalBranches = this.optimalCache.branches;
      return this.optimalCache.value;
    }
    const t0 = performance.now();
    const best = this.game.track.optimalRoute(160, 48);
    const replay = simulateRoute(this.seed, best.path);
    const branches = [];
    let node = this.game.track.root;
    for (const id of best.path) {
      const b = this.game.track.childrenOf(node).find((k) => k.id === id);
      if (!b) break;
      branches.push(b);
      node = this.game.track.nodeAfter(b);
    }
    this.optimalBranches = branches.slice(0, 30);
    this.optimalCache = { seed: this.seed, value: replay.peakLength, branches: this.optimalBranches };
    const ms = performance.now() - t0;
    if (ms > 60) console.log(`[optimal] solved + replayed in ${ms.toFixed(0)}ms -> ${replay.peakLength}`);
    return replay.peakLength;
  }

  async revive() {
    this.ui.el.reviveBtn.disabled = true;
    const granted = await this.adapter.showRewardedAd();
    this.ui.el.reviveBtn.disabled = false;
    if (!granted) {
      this.ui.toast('Ad unavailable', 'No worries — run again for free');
      return;
    }
    this.revivedThisRun = true;
    this.game.revive();
    this.view.setGhost(this.ghost && this.ghost.valid ? this.ghost.branches : []);
    this.ui.hide('results');
    this.ui.showHud(this.mode);
    this.vine.ripple(1.4);
    this.world.addShake(0.6);
    this.flare = 1.2;
    this.sound.unlock();
    this.state = 'run';
    this.adapter.gameplayStart();
  }

  share() {
    const s = this.prog.bestForSeed(todaySeedString());
    const text = `🌿 Overgrowth — ${s} on today's track (${todaySeedString()})`;
    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => this.ui.toast('Copied', text),
        () => this.ui.toast('Your score', text),
      );
    } else {
      this.ui.toast('Your score', text);
    }
  }

  // ---- per-frame -----------------------------------------------------------

  float(worldPos, text, color) {
    const p = worldPos.clone().project(this.world.camera);
    if (p.z > 1) return;
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = `position:fixed;left:${(p.x * 0.5 + 0.5) * window.innerWidth}px;top:${(-p.y * 0.5 + 0.5) * window.innerHeight}px;
      transform:translate(-50%,-50%);color:${color};font-weight:800;font-size:clamp(20px,5vw,30px);pointer-events:none;
      text-shadow:0 2px 14px rgba(0,0,0,.8);transition:transform .85s cubic-bezier(.2,.8,.3,1),opacity .85s ease`;
    // Inside the HUD, not the body: a floater parented to the body outlives the
    // run and draws over the results and wardrobe panels.
    this.ui.el.hud.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = 'translate(-50%,-140%) scale(1.15)';
      el.style.opacity = '0';
    });
    setTimeout(() => el.remove(), 900);
  }

  syncView() {
    const list = this.game.lookahead(this.tier.lookahead);
    const projected = this.game.projectedRoute(this.tier.lookahead);
    // projected[0] is the branch already being travelled; the highlight belongs
    // on projected[1], the fork actually still open to the player.
    const passed = this.game.branch ? this.game.s / Math.max(1e-3, this.game.branch.arcLength) : 0;
    this.view.setLookahead(list, projected[1] || null, projected.slice(1), passed);
  }

  ghostPosition() {
    if (!this.ghost || !this.ghost.valid) return null;
    const at = this.ghost.distanceAt(this.game.elapsed);
    if (!at) return null;
    let remaining = at.distance;
    for (const b of this.ghost.branches) {
      if (remaining <= b.arcLength) return { pos: pointAt(b, remaining / b.arcLength), length: at.length };
      remaining -= b.arcLength;
    }
    return null;
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const dtMs = Math.min(now - this.lastFrame, 100);
    this.lastFrame = now;
    const dt = dtMs / 1000;
    this.clock += dt;
    this.watchdog.update(dtMs);

    if (this.state === 'run') {
      this.game.update(dt);
      this.syncView();
      this.ui.setLength(this.game.length);
      this.ui.setStage(this.game.stage);
      this.ui.setMultiplier(this.game.multiplier, this.game.multForks);

      const gp = this.ghostPosition();
      if (gp) {
        this.ui.setGhostDelta(this.game.length - gp.length);
        this.view.setGhost(this.ghost.branches.filter(
          (b) => b.points[0].z > this.game.head.z - 20 && b.points[0].z < this.game.head.z + 150,
        ));
      }
      this.ghostWorld = gp ? new THREE.Vector3(gp.pos.x, gp.pos.y, gp.pos.z) : null;
    }

    const head = this.game.head;
    const headVec = this._tmpVec.set(head.x, head.y, head.z);
    this.vine.advance(headVec, this.game.dir, this.game.distance);
    this.vine.update(dt, this.game.length, this.clock);

    this.world.updateCamera(dt, headVec, this.game.dir, this.game.length);
    this.world.updateMotes(dt, this.clock, headVec, this.game.speed);
    this.world.update(dt, this.clock);
    this.view.update(dt, this.clock, this.ghostWorld);

    // Post uniforms: flare rides the head's screen position, CA rides the shake.
    this.flare *= Math.pow(0.015, dt);
    this.ca *= Math.pow(0.02, dt);
    const proj = headVec.clone().project(this.world.camera);
    this.post.set('uFlare', this.flare * 0.55);
    this.post.composite.material.uniforms.uFlarePos.value.set(proj.x * 0.5 + 0.5, proj.y * 0.5 + 0.5);
    this.post.composite.material.uniforms.uFlareTint.value.copy(this.vine.uniforms.uGlow.value);
    this.post.set('uCA', this.ca + this.world.shake * 0.004);
    this.post.set('uExposure', 0.88 + this.world.zoom * 0.05);

    this.renderer.setRenderTarget(this.post.renderTarget);
    this.renderer.clear();
    this.renderer.render(this.world.scene, this.world.camera);
    // Captured before the post passes, which would otherwise overwrite the counts.
    this.stats = { calls: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles, fps: 1 / dt };
    this.post.present(this.clock);
  }
}

const game = new Overgrowth();
game.boot().catch((err) => {
  console.error('[boot] fatal', err);
  const el = document.getElementById('loadPct');
  if (el) el.textContent = 'Could not start — WebGL may be unavailable.';
});
window.OVERGROWTH = game;
