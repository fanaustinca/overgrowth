// Run state machine: movement along the branch tree, fork commits, pickups,
// hazards, length economy, and the escalation curve.
//
// Rendering-free on purpose - it emits events and exposes the head transform,
// which keeps the sim testable in node and the visuals swappable.

import { Track, stageForDepth } from './track.js';
import { GhostRecorder } from './ghost.js';

export const BASE_SPEED = 17.0;
export const START_LENGTH = 10;
export const HAZARD_MIN_LOSS = 8;
export const HAZARD_FRACTION = 0.22;
export const MULT_FORKS = 8;

// Withering. Without it a player who reads every fork correctly and always
// takes the safe lane can never die, and sessions have no upper bound. The
// proportional term makes a long vine expensive to hold, so growth plateaus
// unless the player starts taking risk lanes; the flat term is what actually
// kills a starved vine. Both scale with stage, which is the escalation curve.
export const DECAY = { flat: 0.45, flatPerStage: 0.16, rate: 0.007, ratePerStage: 0.002 };

export const LEFT = -1;
export const RIGHT = 1;

// Replays a known route through a fresh sim of the same seed and reports what
// it would actually have scored - decay, hazards and all. Comparing the
// player's peak against this is honest in a way that summing branch values is
// not: the raw sum ignores withering, so it always looks unreachable.
export function simulateRoute(seed, path, maxSeconds = 900) {
  const g = new Game(seed, {});
  let idx = 0;
  if (path.length && g.branch.id !== path[0]) {
    g.selection = g.selection === LEFT ? RIGHT : LEFT;
    g._enterBranch(g._childForSelection());
  }
  if (path.length && g.branch.id === path[0]) idx = 1;

  const dt = 1 / 60;
  let t = 0;
  while (!g.over && t < maxSeconds) {
    if (idx < path.length) {
      const node = g.track.nodeAfter(g.branch);
      const kids = g.track.childrenOf(node);
      const desired = kids[0].id === path[idx] ? LEFT : RIGHT;
      if (g.selection !== desired) g.selection = desired;
    }
    const before = g.branch.id;
    g.update(dt);
    t += dt;
    if (g.branch.id !== before && idx < path.length) idx += 1;
    if (idx >= path.length && g.forks > path.length) break;
  }
  return { peakLength: Math.round(g.peakLength), forks: g.forks, seconds: t };
}

export class Game {
  constructor(seed, events = {}) {
    this.events = events;
    this.reset(seed);
  }

  reset(seed) {
    this.track = new Track(seed);
    this.seed = seed;
    this.node = this.track.root;
    this.branch = null;
    this.s = 0;
    this.selection = RIGHT;
    this.length = START_LENGTH;
    this.peakLength = START_LENGTH;
    this.distance = 0;
    this.elapsed = 0;
    this.multiplier = 1;
    this.multForks = 0;
    this.forks = 0;
    this.hazardsHit = 0;
    this.pickupsTaken = 0;
    this.over = false;
    this.recorder = new GhostRecorder();
    this.head = { x: 0, y: 0, z: 0 };
    this.dir = { x: 0, y: 0, z: 1 };
    this._enterBranch(this._childForSelection());
  }

  get stage() { return stageForDepth(this.node.depth); }
  get speed() { return BASE_SPEED * (1 + Math.min(this.length, 420) / 460); }

  get decayPerSecond() {
    const st = this.stage;
    return (DECAY.flat + DECAY.flatPerStage * st) + this.length * (DECAY.rate + DECAY.ratePerStage * st);
  }

  // Children are [left, right]; selection maps directly onto that.
  _childForSelection(node = this.node) {
    const kids = this.track.childrenOf(node);
    return this.selection === LEFT ? kids[0] : kids[1];
  }

  // The route the vine will take if the player never taps again - drives the
  // look-ahead highlight so intent is always visible 2-3 forks out.
  projectedRoute(depth = 3) {
    const ids = [];
    if (this.branch) ids.push(this.branch.id);
    let node = this.branch ? this.track.nodeAfter(this.branch) : this.node;
    for (let i = ids.length; i < depth + 1; i++) {
      const b = this._childForSelection(node);
      ids.push(b.id);
      node = this.track.nodeAfter(b);
    }
    return ids;
  }

  lookahead(depth) {
    const from = this.branch ? this.track.nodeAfter(this.branch) : this.node;
    const list = this.track.lookahead(from, depth);
    if (this.branch) list.unshift({ branch: this.branch, ahead: -1 });
    return list;
  }

  _enterBranch(branch) {
    this.branch = branch;
    this.s = 0;
    this.recorder.takeBranch(branch.id);
    for (const p of branch.pickups) p.taken = false;
    for (const h of branch.hazards) h.hit = false;
  }

  // The single input. Flipping is always legal; it takes effect at the next
  // unresolved fork, so there is no timing window to miss.
  tap() {
    if (this.over) return;
    this.selection = this.selection === LEFT ? RIGHT : LEFT;
    this.events.onFlip && this.events.onFlip(this.selection);
  }

  _pointAtArc(branch, s) {
    const cum = branch.cum, pts = branch.points;
    const target = Math.max(0, Math.min(branch.arcLength, s));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < target) i++;
    const a = pts[i - 1], b = pts[i];
    const span = cum[i] - cum[i - 1];
    const k = span > 1e-6 ? (target - cum[i - 1]) / span : 0;
    return {
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
      z: a.z + (b.z - a.z) * k,
      dx: b.x - a.x, dy: b.y - a.y, dz: b.z - a.z,
    };
  }

  addLength(amount) {
    this.length += amount;
    if (this.length > this.peakLength) this.peakLength = this.length;
  }

  update(dt) {
    if (this.over) return;
    this.elapsed += dt;

    let remaining = this.speed * dt;
    // A single frame can, at high speed and low framerate, cross a whole
    // branch; loop so no fork or hazard is ever skipped.
    let guard = 0;
    while (remaining > 0 && !this.over && guard++ < 8) {
      const prevS = this.s;
      const step = Math.min(remaining, this.branch.arcLength - this.s);
      this.s += step;
      remaining -= step;
      this.distance += step;

      this._resolveContacts(prevS, this.s);

      if (this.s >= this.branch.arcLength - 1e-6) {
        this._commitFork();
      }
    }

    if (!this.over) {
      this.length -= this.decayPerSecond * dt;
      if (this.length <= 0) { this.length = 0; this._end(); }
    }

    const p = this._pointAtArc(this.branch, this.s);
    this.head.x = p.x; this.head.y = p.y; this.head.z = p.z;
    const dl = Math.hypot(p.dx, p.dy, p.dz) || 1;
    this.dir.x = p.dx / dl; this.dir.y = p.dy / dl; this.dir.z = p.dz / dl;

    this.recorder.sample(dt, this.elapsed, this.distance, this.length);
  }

  _resolveContacts(fromS, toS) {
    const b = this.branch;
    for (const p of b.pickups) {
      if (p.taken) continue;
      const at = p.t * b.arcLength;
      if (at > fromS && at <= toS) {
        p.taken = true;
        this.pickupsTaken += 1;
        if (p.type === 'gem') {
          this.multiplier = Math.min(4, this.multiplier + p.value);
          this.multForks = MULT_FORKS;
        } else {
          this.addLength(p.value * this.multiplier);
        }
        this.events.onPickup && this.events.onPickup(p, this._pointAtArc(b, at));
      }
    }

    for (const h of b.hazards) {
      if (h.hit) continue;
      const at = h.t * b.arcLength;
      if (at > fromS && at <= toS) {
        h.hit = true;
        this.hazardsHit += 1;
        const loss = Math.max(HAZARD_MIN_LOSS, this.length * HAZARD_FRACTION);
        this.length -= loss;
        this.multiplier = 1;
        this.multForks = 0;
        this.events.onHazard && this.events.onHazard(loss, this._pointAtArc(b, at));
        if (this.length <= 0) {
          this.length = 0;
          this._end();
          return;
        }
      }
    }
  }

  _commitFork() {
    const finished = this.branch;
    if (finished.tier === 'safe') this.addLength(finished.reward * this.multiplier);

    this.node = this.track.nodeAfter(finished);
    this.forks += 1;
    if (this.multForks > 0 && --this.multForks === 0) this.multiplier = 1;

    const overflow = this.s - finished.arcLength;
    const next = this._childForSelection();
    this._enterBranch(next);
    this.s = Math.max(0, overflow);
    this.events.onFork && this.events.onFork(next, finished);
  }

  _end() {
    this.over = true;
    this.events.onEnd && this.events.onEnd(this.buildResult());
  }

  buildResult() {
    return {
      peakLength: Math.round(this.peakLength),
      forks: this.forks,
      hazardsHit: this.hazardsHit,
      pickupsTaken: this.pickupsTaken,
      seed: this.seed,
      duration: this.elapsed,
      route: this.recorder.build(this.peakLength),
    };
  }

  // Rewarded-ad revive: regrow to half the peak and carry on from here.
  revive() {
    if (!this.over) return;
    this.over = false;
    this.length = Math.max(START_LENGTH, this.peakLength * 0.5);
    this.multiplier = 1;
    this.multForks = 0;
    for (const h of this.branch.hazards) h.hit = true; // don't re-hit on the spot
  }
}
