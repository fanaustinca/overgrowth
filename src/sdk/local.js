// Development / self-hosted adapter. Logs the calls a real platform would make
// and simulates ad breaks with a short delay so pacing can be tested offline.
import { SDKAdapter } from './adapter.js';

const SIMULATED_AD_MS = 600;

export class LocalAdapter extends SDKAdapter {
  constructor() {
    super();
    this.name = 'local';
    this.log = new URLSearchParams(location.search).has('sdklog');
  }

  _trace(...args) { if (this.log) console.log('[local-sdk]', ...args); }

  async init() { this.ready = true; this._trace('init'); }
  loadingProgress(p) { this._trace('loadingProgress', Math.round(p) + '%'); }
  gameplayStart() { this._trace('gameplayStart'); }
  gameplayStop() { this._trace('gameplayStop'); }

  async showMidgameAd() {
    this._trace('midgame ad');
    await new Promise((r) => setTimeout(r, SIMULATED_AD_MS));
  }

  async showRewardedAd() {
    this._trace('rewarded ad -> granted');
    await new Promise((r) => setTimeout(r, SIMULATED_AD_MS));
    return true;
  }

  submitScore(v) { this._trace('submitScore', v); }
  happyTime() { this._trace('happytime'); }
}
