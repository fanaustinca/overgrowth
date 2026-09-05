// Procedural branching track.
//
// The track is an infinite binary tree. Every branch has a stable string id
// ("r" for the root, then a trail of L/R), and every property of that branch is
// derived from streamFor(seed, id). That means the whole tree exists implicitly:
// two players on the same seed see the same forks even if they take different
// routes, which is what makes daily-seed scores comparable and lets the ghost
// overlay replay a route that was recorded on an earlier attempt.
//
// Escalation is keyed to depth rather than to the player's length, because
// length differs per route and would desynchronise the shared track. Depth and
// length track each other closely in practice (~2.5 length per fork), so
// `stage` below advances roughly every 50 length as the brief specifies.

import { streamFor } from './rng.js';

export const LANE_MAX = 9.0;
export const FORKS_PER_STAGE = 16; // ~50 length at an average +3.1/fork

const SAMPLES = 16; // spine samples per branch

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function stageForDepth(depth) {
  return Math.floor(depth / FORKS_PER_STAGE);
}

// Forward distance between consecutive forks. Tightens with stage so late-run
// decisions have to be read faster.
export function spacingForDepth(depth) {
  return lerp(36, 21, clamp(stageForDepth(depth) / 7, 0, 1));
}

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t, uu = u * u, tt = t * t;
  const a = uu * u, b = 3 * uu * t, c = 3 * u * tt, d = tt * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    z: a * p0.z + b * p1.z + c * p2.z + d * p3.z,
  };
}

export class Track {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.nodes = new Map();
    this.branches = new Map();
    const root = {
      id: 'r',
      depth: 0,
      pos: { x: 0, y: 0, z: 0 },
      lat: 0,
      children: null,
    };
    this.nodes.set('r', root);
    this.root = root;
  }

  // Both branches leaving a node, built (and cached) on demand.
  childrenOf(node) {
    if (node.children) return node.children;
    const rnd = streamFor(this.seed, 'fork:' + node.id);
    const stage = stageForDepth(node.depth);

    // Which side carries the risk lane, and whether this is a rare double-risk fork.
    const riskOnRight = rnd() < 0.5;
    const doubleRisk = stage >= 2 && rnd() < 0.12;

    const kids = [];
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const isRisk = doubleRisk || (side > 0) === riskOnRight;
      kids.push(this._buildBranch(node, side, isRisk));
    }
    node.children = kids;
    return kids;
  }

  _buildBranch(node, side, isRisk) {
    const id = node.id + (side < 0 ? 'L' : 'R');
    const cached = this.branches.get(id);
    if (cached) return cached;

    const rnd = streamFor(this.seed, 'branch:' + id);
    const depth = node.depth + 1;
    const stage = stageForDepth(node.depth);
    const span = spacingForDepth(node.depth);

    // Lateral target. Branches that would run off the play area get folded back
    // toward the centre so the track never drifts out of frame.
    const spread = lerp(4.2, 6.4, rnd());
    let lat = node.lat + side * spread;
    if (Math.abs(lat) > LANE_MAX) lat = node.lat - side * spread * lerp(0.5, 0.9, rnd());
    lat = clamp(lat, -LANE_MAX, LANE_MAX);

    const y0 = node.pos.y;
    const y1 = clamp(y0 + (rnd() - 0.5) * 2.6, -3.0, 3.0);

    const p0 = { x: node.pos.x, y: y0, z: node.pos.z };
    const p3 = { x: lat, y: y1, z: node.pos.z + span };
    // Tangents parallel to travel at both ends -> smooth split and re-merge.
    const p1 = { x: p0.x, y: lerp(y0, y1, 0.25), z: p0.z + span * 0.42 };
    const p2 = { x: p3.x, y: lerp(y0, y1, 0.75), z: p3.z - span * 0.42 };

    const points = [];
    const cum = [];       // cumulative arc length, for constant-speed travel
    let arc = 0;
    for (let i = 0; i <= SAMPLES; i++) {
      const p = bezier(p0, p1, p2, p3, i / SAMPLES);
      if (i > 0) {
        const q = points[i - 1];
        arc += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
      }
      points.push(p);
      cum.push(arc);
    }

    const branch = {
      id,
      side,
      depth,
      tier: isRisk ? 'risk' : 'safe',
      points,
      cum,
      arcLength: arc,
      width: isRisk ? lerp(0.62, 0.78, rnd()) : lerp(1.0, 1.18, rnd()),
      brightness: isRisk ? 0.42 : 1.0,
      hazards: [],
      pickups: [],
      reward: isRisk ? 0 : 1, // safe lanes pay out on completion
      fromId: node.id,
      toId: id,
    };

    if (isRisk) {
      // Reward: an orb worth 3-5, or (less often) a multiplier gem.
      const gem = rnd() < 0.18;
      if (gem) {
        branch.pickups.push({ t: lerp(0.35, 0.65, rnd()), type: 'gem', value: 0.5, taken: false });
      } else {
        const orbs = rnd() < 0.35 ? 2 : 1;
        for (let i = 0; i < orbs; i++) {
          const value = 3 + Math.floor(rnd() * 3); // 3-5
          branch.pickups.push({
            t: orbs === 1 ? lerp(0.4, 0.6, rnd()) : lerp(0.28, 0.72, i / (orbs - 1)),
            type: 'orb',
            value,
            taken: false,
          });
        }
      }

      // Hazard cluster. Most risk lanes are trapped: that is deliberate, and it
      // is what stops blind risk-taking from dominating. Hazards are drawn on
      // the lane well before the fork resolves, so a player who reads ahead can
      // pick out the clean risk lanes - which is the entire skill of the game.
      const pHaz = clamp(0.55 + 0.06 * stage, 0, 0.9);
      if (rnd() < pHaz) {
        const count = 1 + (rnd() < clamp(0.2 + 0.09 * stage, 0, 0.7) ? 1 : 0)
                        + (rnd() < clamp(0.05 + 0.06 * stage, 0, 0.5) ? 1 : 0);
        const base = lerp(0.3, 0.62, rnd());
        for (let i = 0; i < count; i++) {
          branch.hazards.push({
            t: clamp(base + i * 0.11, 0.12, 0.92),
            radius: 1.05,
            phase: rnd() * Math.PI * 2,
            hit: false,
          });
        }
      }
    }

    this.branches.set(id, branch);
    return branch;
  }

  // The node a branch arrives at.
  nodeAfter(branch) {
    let n = this.nodes.get(branch.id);
    if (n) return n;
    const end = branch.points[branch.points.length - 1];
    n = {
      id: branch.id,
      depth: branch.depth,
      pos: { x: end.x, y: end.y, z: end.z },
      lat: end.x,
      children: null,
    };
    this.nodes.set(branch.id, n);
    return n;
  }

  // Subtree used for the look-ahead render: every branch reachable within
  // `depth` forks of `node`, flagged with how far ahead it sits.
  lookahead(node, depth = 3) {
    const out = [];
    const walk = (n, d) => {
      if (d >= depth) return;
      for (const b of this.childrenOf(n)) {
        out.push({ branch: b, ahead: d });
        walk(this.nodeAfter(b), d + 1);
      }
    };
    walk(node, 0);
    return out;
  }

  // Expected value of a branch, used by the optimal-route solver and by the
  // "did I read that fork right" scoring on the results screen.
  expectedValue(branch) {
    if (branch.tier === 'safe') return 1;
    let gain = 0;
    for (const p of branch.pickups) gain += p.type === 'gem' ? 2.5 : p.value;
    // A hazard costs ~22% of a mid-run vine, call it 9 length.
    return gain - branch.hazards.length * 9;
  }

  // Beam search for the best route through this seed - shown as the dotted
  // "optimal path" on the results screen.
  optimalRoute(maxDepth, beam = 64) {
    let states = [{ node: this.root, score: 0, path: [] }];
    for (let d = 0; d < maxDepth; d++) {
      const next = [];
      for (const s of states) {
        for (const b of this.childrenOf(s.node)) {
          next.push({
            node: this.nodeAfter(b),
            score: s.score + this.expectedValue(b),
            path: s.path.concat(b.id),
          });
        }
      }
      next.sort((a, b) => b.score - a.score);
      states = next.slice(0, beam);
      if (!states.length) break;
    }
    return states[0] || { score: 0, path: [] };
  }
}
