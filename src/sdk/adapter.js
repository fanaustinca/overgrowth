// Platform abstraction. Game code only ever talks to this interface, so the
// same build ships to Poki, CrazyGames, or a plain web host by swapping the
// implementation that gets instantiated at boot.
//
// Every method is defensive: a blocked, missing, or slow SDK must degrade to a
// no-op rather than stall the game loop.

export class SDKAdapter {
  constructor() {
    this.name = 'none';
    this.adBlocked = false;
    this.ready = false;
  }

  async init() { this.ready = true; }
  loadingProgress(_percent) {}
  gameplayStart() {}
  gameplayStop() {}
  async showMidgameAd() {}
  async showRewardedAd() { return false; }
  submitScore(_value) {}
  happyTime() {}
  isAdBlocked() { return this.adBlocked; }
}

// Injects a third-party script with a hard timeout so a blocked CDN can never
// hold the game on the loading screen.
export function loadScript(src, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      ok ? resolve() : reject(err || new Error('script failed: ' + src));
    };
    el.async = true;
    el.src = src;
    el.onload = () => finish(true);
    el.onerror = () => finish(false);
    setTimeout(() => finish(false, new Error('script timeout: ' + src)), timeoutMs);
    document.head.appendChild(el);
  });
}

export function detectPlatform() {
  const q = new URLSearchParams(location.search).get('platform');
  if (q) return q.toLowerCase();
  if (typeof window !== 'undefined') {
    if (window.OVERGROWTH_PLATFORM) return String(window.OVERGROWTH_PLATFORM).toLowerCase();
    if (window.PokiSDK) return 'poki';
    if (window.CrazyGames) return 'crazygames';
  }
  return 'local';
}

export async function createAdapter(platform = detectPlatform()) {
  let adapter;
  try {
    switch (platform) {
      case 'poki': {
        const { PokiAdapter } = await import('./poki.js');
        adapter = new PokiAdapter();
        break;
      }
      case 'crazygames':
      case 'crazy': {
        const { CrazyGamesAdapter } = await import('./crazygames.js');
        adapter = new CrazyGamesAdapter();
        break;
      }
      default: {
        const { LocalAdapter } = await import('./local.js');
        adapter = new LocalAdapter();
      }
    }
    await adapter.init();
    return adapter;
  } catch (err) {
    console.warn('[sdk] falling back to local adapter:', err);
    const { LocalAdapter } = await import('./local.js');
    const fallback = new LocalAdapter();
    fallback.adBlocked = true;
    await fallback.init();
    return fallback;
  }
}
