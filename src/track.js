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

const SAMPLES = 16;      // spine samples per branch
const MIN_GAP = 5.2;     // narrowest the two lanes leaving a fork may end up
const TIER_STEP = 1.15;  // height a branch takes on relative to its parent

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

    // Both lanes are placed together rather than independently. Placing them
    // one at a time and folding whichever one left the play area used to let
    // the right lane end up left of the left one - the two ribbons crossed in
    // an X right where the player is trying to read them. Resolving the pair
    // means the ordering can be guaranteed instead of hoped for.
    const lats = this._lateralPair(node, rnd);

    const kids = [];
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const isRisk = doubleRisk || (side > 0) === riskOnRight;
      kids.push(this._buildBranch(node, side, isRisk, lats[i]));
    }
    node.children = kids;
    return kids;
  }

  // Where the two lanes leaving a node end up. Ordered (left stays left),
  // never closer than MIN_GAP, and shifted - not folded - back inside the play
  // area when the pair would overrun an edge.
  _lateralPair(node, rnd) {
    // A gentle pull back toward the middle. Without it the pair shift below
    // parks a lane on the wall and it stays there: the track stops wandering
    // and the vine hugs the edge of the play area for forks at a time.
    const centre = node.lat * 0.78;
    let lo = centre - lerp(4.4, 6.6, rnd());
    let hi = centre + lerp(4.4, 6.6, rnd());

    const gap = hi - lo;
    if (gap < MIN_GAP) {
      const mid = (lo + hi) / 2;
      lo = mid - MIN_GAP / 2;
      hi = mid + MIN_GAP / 2;
    }
    if (hi > LANE_MAX) { const d = hi - LANE_MAX; lo -= d; hi -= d; }
    if (lo < -LANE_MAX) { const d = -LANE_MAX - lo; lo += d; hi += d; }
    // Both edges at once only happens if the pair is wider than the box; then
    // the box wins and the gap is whatever fits.
    return [clamp(lo, -LANE_MAX, LANE_MAX), clamp(hi, -LANE_MAX, LANE_MAX)];
  }

  _buildBranch(node, side, isRisk, lat) {
    const id = node.id + (side < 0 ? 'L' : 'R');
    const cached = this.branches.get(id);
    if (cached) return cached;

    const rnd = streamFor(this.seed, 'branch:' + id);
    const depth = node.depth + 1;
    const stage = stageForDepth(node.depth);
    const span = spacingForDepth(node.depth);

    const y0 = node.pos.y;
    // Each lane takes a step up or down relative to its parent, pulled back
    // toward level so it cannot drift. Two lanes that pass laterally close
    // (cousins from different forks, which a bounded play area makes
    // unavoidable) are then separated in height instead, so one clearly runs
    // over the other rather than merging into it.
    const step = side * TIER_STEP * lerp(0.8, 1.25, rnd());
    const y1 = clamp(y0 * 0.55 + step, -3.4, 3.4);

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
      // The first branch is entered before the player has seen anything, so a
      // trapped one would end the run on a choice they never made. Everything
      // from the first real fork onward is fair game.
      const pHaz = depth === 1 ? 0 : clamp(0.55 + 0.06 * stage, 0, 0.9);
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
