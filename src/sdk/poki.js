// Poki. https://sdk.poki.com/
//
// Contract Poki enforces and this adapter honours:
//   - init() before anything, gameLoadingFinished() once assets are ready
//   - gameplayStart/gameplayStop must bracket every run, and gameplayStop must
//     fire before any commercial break
//   - commercialBreak() only between runs, never mid-run
//   - rewardedBreak() resolves true only if the ad was actually watched
import { SDKAdapter, loadScript } from './adapter.js';

const SDK_URL = 'https://game-cdn.poki.com/scripts/v2/poki-sdk.js';

export class PokiAdapter extends SDKAdapter {
  constructor() {
    super();
    this.name = 'poki';
    this.sdk = null;
    this.playing = false;
  }

  async init() {
    try {
      if (!window.PokiSDK) await loadScript(SDK_URL);
      this.sdk = window.PokiSDK;
      if (!this.sdk) throw new Error('PokiSDK missing after load');
      await this.sdk.init();
      this.ready = true;
    } catch (err) {
      // Poki treats an adblocked session as playable - just ad-free.
      console.warn('[poki] init failed, continuing ad-free:', err);
      this.adBlocked = true;
      this.sdk = null;
    }
  }

  loadingProgress(percent) {
    if (!this.sdk) return;
    try {
      this.sdk.gameLoadingProgress({ percentageDone: Math.max(0, Math.min(100, percent)) / 100 });
      if (percent >= 100) this.sdk.gameLoadingFinished();
    } catch (_) {}
  }

  gameplayStart() {
    if (!this.sdk || this.playing) return;
    this.playing = true;
    try { this.sdk.gameplayStart(); } catch (_) {}
  }

  gameplayStop() {
    if (!this.sdk || !this.playing) return;
    this.playing = false;
    try { this.sdk.gameplayStop(); } catch (_) {}
  }

  async showMidgameAd() {
    if (!this.sdk) return;
    this.gameplayStop();
    try { await this.sdk.commercialBreak(); } catch (_) {}
  }

  async showRewardedAd() {
    if (!this.sdk) return false;
    this.gameplayStop();
    try {
      const success = await this.sdk.rewardedBreak();
      return success === true;
    } catch (_) {
      return false;
    }
  }

  submitScore(value) {
    // Poki has no score API; the platform reads engagement from gameplay
    // events. Kept for interface parity and for custom analytics hooks.
    try { this.sdk && this.sdk.customEvent && this.sdk.customEvent('run', 'end', { value }); } catch (_) {}
  }

  happyTime() {
    try { this.sdk && this.sdk.happyTime && this.sdk.happyTime(1); } catch (_) {}
  }
}
