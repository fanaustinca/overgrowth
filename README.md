# OVERGROWTH

A one-tap branching-path growth runner. A vine grows forward on its own along a
procedurally branching path; a tap anywhere flips which branch it takes at the
next fork. Desktop can also pick a side outright with **A** / **D** or the arrow
keys, and space or enter flips. Safe lanes are wide and lit and pay +1. Risk lanes are narrow, dim,
and carry orbs (+3–5) or a multiplier gem — and usually hazards, which snap
segments off the vine. The run ends when the vine withers to nothing, so a bad
read costs length, never an instant death.

WebGL2 (Three.js r160), no build step, no backend, no runtime CDN.

---

## Running it

Any static file server, because the game is ES modules:

    python3 -m http.server 8123
    # → http://localhost:8123/index.html

Opening `index.html` from `file://` will not work (module CORS).

### URL flags

| Flag | Values | Effect |
| --- | --- | --- |
| `?platform=` | `poki`, `crazygames`, `local` | Forces the SDK adapter. Omitted → auto-detect. |
| `?tier=` | `low`, `medium`, `high` | Forces a quality tier and locks the runtime watchdog. Omitted → boot benchmark picks one. |
| `?seed=` | any string | Pins the track to that seed in both modes, for QA and bug reports. |
| `?sdklog` | — | Makes the local adapter log every SDK call it would have made. |

---

## File map

    index.html                 shell: canvas, HUD, menus, all CSS inline
    vendor/three.module.min.js Three.js r160, vendored (655 KB)
    src/main.js                orchestration: boot, states, frame loop, ads
    src/game.js                simulation - movement, forks, pickups, decay
    src/track.js               the implicit branch tree + optimal-route search
    src/rng.js                 FNV-1a hash + mulberry32, per-branch streams
    src/ghost.js               run recording and playback
    src/progression.js         lifetime growth, skins, biomes, persistence
    src/ui.js                  DOM screens
    src/sound.js               WebAudio synth (no audio assets)
    src/sdk/adapter.js         SDKAdapter interface, script loader, detection
    src/sdk/poki.js            PokiAdapter
    src/sdk/crazygames.js      CrazyGamesAdapter
    src/sdk/local.js           LocalAdapter (logs, no-ops)
    src/render/world.js        camera rig, sky, ground, fog, mote field
    src/render/vine.js         the hero: spring chain + tube + skin shader
    src/render/trackview.js    lane ribbons, pickups, hazards, ghost, debris
    src/render/post.js         bright-pass → gaussian mips → ACES composite
    src/render/quality.js      tier table, boot benchmark, runtime watchdog
    src/render/curve.js        shared world-curvature GLSL chunk

Total source ~3.6 k lines; the whole build is 856 KB on disk, of which Three.js
is 78 %. There are no image, audio, or font assets to load — every surface is
generated in a shader and every sound is synthesised.

---

## Platform integration

Game code only ever calls `SDKAdapter`. Shipping to a new portal means writing
one subclass; nothing else in the codebase knows what a portal is.

    init()                 // load + init the SDK, resolve even if it fails
    loadingProgress(pct)   // 0-100 during boot
    gameplayStart()        // a run begins
    gameplayStop()         // a run ends - always before any ad
    showMidgameAd()        // interstitial, results screen only
    showRewardedAd()       // resolves true only if the ad was actually watched
    submitScore(value)     // peak length of the run
    happyTime()            // a moment worth celebrating
    isAdBlocked()          // for hiding the rewarded-revive button

Every method is wrapped so a blocked, missing, or slow SDK degrades to a no-op:
`loadScript` has a 6 s timeout, and a failed `init()` sets `adBlocked` and lets
the game run ad-free rather than stalling on the loading screen.

### Poki

`?platform=poki`, or let auto-detect see `window.PokiSDK`. Loads
`https://game-cdn.poki.com/scripts/v2/poki-sdk.js`. `gameplayStart`/`Stop`
bracket every run, `gameplayStop` always fires before `commercialBreak()`, and
`rewardedBreak()` gates the revive. Upload the folder as-is; Poki serves it from
their own origin.

### CrazyGames

`?platform=crazygames`, or auto-detect on `window.CrazyGames`. Loads
`https://sdk.crazygames.com/crazygames-sdk-v3.js` and uses
`SDK.game.loadingStart/loadingStop`, `gameplayStart/gameplayStop`,
`happytime()`, `SDK.ad.requestAd('midgame'|'rewarded', …)` and
`SDK.ad.hasAdblock()`.

### Ad policy

**No ad ever interrupts a run.** Interstitials fire only once the results screen
is already up (after a 600 ms beat), and only every 3rd run
(`ADS_EVERY_N_RUNS` in `src/main.js`). The rewarded ad is opt-in: it regrows the
vine to 50 % of its peak and resumes the same run. A revived run still counts
once toward lifetime growth — `recordRun` takes an explicit credit so reviving
cannot farm unlocks.

---

## Systems

**Deterministic track.** `dailySeed()` hashes `overgrowth/YYYY-MM-DD` (UTC), so
every player gets the same tree on the same day and a shared score is
comparable. The tree is implicit: `childrenOf(node)` derives both branches from
a per-branch RNG stream keyed by the branch id, so any part of the track can be
generated on demand without walking to it, and the beam search can look ahead
160 forks in ~70 ms.

**Escalation.** Stage rises every 16 forks. Fork spacing tightens 36 → 21 units,
risk-lane hazard probability climbs `0.55 + 0.06 × stage`, and withering scales
with both stage and current length. The result is a natural session curve:
a blind run dies in ~15 s, a careful one runs 60-90 s, a well-read one 2-3 min.

**Ghost + optimal route.** Every run records its branch choices. The results
screen replays your best run as a ghost and draws the seed's optimal route as a
dotted overlay. The number it quotes is not a sum of branch values — that
ignores withering and is unreachable — but the peak length that route actually
reaches when replayed through the simulation.

**Reading the fork.** Three things say where the vine is going: chevrons run up
the chosen lane, the lane the player is *not* taking drops well back, and a HUD
picker mirrors the choice. Left and right always mean the player's left and
right: the chase camera looks down +z, which mirrors world x, so `LEFT`/`RIGHT`
in `game.js` are screen sides and every branch resolves through `childOnSide`.

**Progression** is cosmetic only: 5 vine skins and 4 biomes unlocked by
cumulative lifetime length. Nothing affects difficulty or scoring.

**Quality tiers.** A 24-pass fbm benchmark runs at boot (forced synchronous with
a `readRenderTargetPixels`) and picks low / medium / high, which set pixel
ratio, tube segments, ring budget, shader octaves, and MSAA samples. A watchdog
demotes on sustained frame drops and promotes back when there is headroom;
`?tier=` locks it for capture work.

All state lives in `localStorage` under `overgrowth.v1`.

---

## Debug hooks

`window.OVERGROWTH` is the game instance. Useful during art work:

    OVERGROWTH.vine.material.uniforms.uDebug.value = 5   // 1 height, 2 normal,
        // 3 detail, 4 crease, 5 albedo, 6 wrapped diffuse, 7 lit-no-effects
    OVERGROWTH.world.closeUp = true                      // inspection rig
    OVERGROWTH.startRun('daily' | 'endless')
