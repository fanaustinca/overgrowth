// CrazyGames SDK v3. https://docs.crazygames.com/
//
// window.CrazyGames.SDK surface used here:
//   SDK.init(), SDK.game.loadingStart/loadingStop/gameplayStart/gameplayStop,
//   SDK.game.happytime(), SDK.ad.requestAd(type, callbacks), SDK.ad.hasAdblock()
import { SDKAdapter, loadScript } from './adapter.js';

const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';

export class CrazyGamesAdapter extends SDKAdapter {
  constructor() {
    super();
    this.name = 'crazygames';
    this.sdk = null;
    this.playing = false;
    this.loadingOpen = false;
  }

  async init() {
    try {
      if (!window.CrazyGames) await loadScript(SDK_URL);
      this.sdk = window.CrazyGames && window.CrazyGames.SDK;
      if (!this.sdk) throw new Error('CrazyGames SDK missing after load');
      await this.sdk.init();
      this.ready = true;
      try { this.adBlocked = await this.sdk.ad.hasAdblock(); } catch (_) {}
      try { this.sdk.game.loadingStart(); this.loadingOpen = true; } catch (_) {}
    } catch (err) {
      console.warn('[crazygames] init failed, continuing ad-free:', err);
      this.adBlocked = true;
      this.sdk = null;
    }
  }

  loadingProgress(percent) {
    if (!this.sdk || percent < 100 || !this.loadingOpen) return;
    this.loadingOpen = false;
    try { this.sdk.game.loadingStop(); } catch (_) {}
  }

  gameplayStart() {
    if (!this.sdk || this.playing) return;
    this.playing = true;
    try { this.sdk.game.gameplayStart(); } catch (_) {}
  }

  gameplayStop() {
    if (!this.sdk || !this.playing) return;
    this.playing = false;
    try { this.sdk.game.gameplayStop(); } catch (_) {}
  }

  // requestAd is callback-based; wrap it and always resolve so a failed ad can
  // never leave the results screen waiting.
  _requestAd(type) {
    return new Promise((resolve) => {
      if (!this.sdk) return resolve(false);
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      try {
        this.sdk.ad.requestAd(type, {
          adFinished: () => done(true),
          adError: () => done(false),
          adStarted: () => {},
        });
      } catch (_) {
        done(false);
      }
      setTimeout(() => done(false), 45000);
    });
  }

  async showMidgameAd() {
    this.gameplayStop();
    await this._requestAd('midgame');
  }

  async showRewardedAd() {
    this.gameplayStop();
    return this._requestAd('rewarded');
  }

  submitScore(value) {
    try { this.sdk && this.sdk.game.inviteLink && void value; } catch (_) {}
  }

  happyTime() {
    try { this.sdk && this.sdk.game.happytime(); } catch (_) {}
  }
}
