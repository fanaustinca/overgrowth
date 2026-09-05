// Ghost recording and playback.
//
// A route is just the sequence of branch ids the vine took plus a coarse
// time->distance trace. Because the track tree is fully determined by the seed,
// replaying those ids on a later attempt reproduces the exact same path through
// the world - so the overlay is a few hundred bytes, not a keyframe dump.

const SAMPLE_HZ = 10;

export class GhostRecorder {
  constructor() { this.reset(); }

  reset() {
    this.branchIds = [];
    this.trace = []; // flat [t, distance, length, ...]
    this._acc = 0;
  }

  takeBranch(id) { this.branchIds.push(id); }

  sample(dt, elapsed, distance, length) {
    this._acc += dt;
    if (this._acc < 1 / SAMPLE_HZ) return;
    this._acc = 0;
    this.trace.push(+elapsed.toFixed(2), Math.round(distance * 10) / 10, Math.round(length));
  }

  build(peakLength) {
    return { v: 1, peak: Math.round(peakLength), ids: this.branchIds.slice(), trace: this.trace.slice() };
  }
}

export class GhostPlayback {
  constructor(track, route) {
    this.track = track;
    this.route = route || null;
    this.branches = [];
    this.valid = false;
    if (route && route.ids && route.ids.length) this._resolve();
  }

  // Walk the recorded ids back down the live tree. Any mismatch (a route saved
  // under a different track version) just disables the overlay.
  _resolve() {
    let node = this.track.root;
    for (const id of this.route.ids) {
      const kids = this.track.childrenOf(node);
      const b = kids.find((k) => k.id === id);
      if (!b) return;
      this.branches.push(b);
      node = this.track.nodeAfter(b);
    }
    this.valid = this.branches.length > 0;
  }

  get peak() { return this.route ? this.route.peak : 0; }

  // Distance the ghost had covered at time t, for the racing marker.
  distanceAt(t) {
    const tr = this.route && this.route.trace;
    if (!tr || tr.length < 6) return null;
    const last = tr.length - 3;
    if (t >= tr[last]) return { distance: tr[last + 1], length: tr[last + 2], done: true };
    for (let i = 0; i <= last - 3; i += 3) {
      if (t < tr[i + 3]) {
        const t0 = tr[i], t1 = tr[i + 3];
        const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        return {
          distance: tr[i + 1] + (tr[i + 4] - tr[i + 1]) * f,
          length: tr[i + 2] + (tr[i + 5] - tr[i + 2]) * f,
          done: false,
        };
      }
    }
    return { distance: tr[1], length: tr[2], done: false };
  }
}
