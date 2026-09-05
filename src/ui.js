// DOM overlay controller. The markup lives in index.html (cheaper to parse than
// building it in JS); this file just wires it up.

import { SKINS, BIOMES } from './progression.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(progression, handlers) {
    this.prog = progression;
    this.h = handlers;
    this.el = {
      loading: $('loading'), loadBar: $('loadBar').firstElementChild, loadPct: $('loadPct'),
      hud: $('hud'), length: $('length'), hudBest: $('hudBest'), hudStage: $('hudStage'),
      hudModeLabel: $('hudModeLabel'), mult: $('mult'), ghostDelta: $('ghostDelta'), tapHint: $('tapHint'),
      menu: $('menu'), menuBest: $('menuBest'), menuToday: $('menuToday'), menuLifetime: $('menuLifetime'),
      menuSeed: $('menuSeed'), modeDaily: $('modeDaily'), modeEndless: $('modeEndless'),
      results: $('results'), resultScore: $('resultScore'), resultBest: $('resultBest'), resultSeed: $('resultSeed'),
      resultForks: $('resultForks'), resultOrbs: $('resultOrbs'), resultHits: $('resultHits'),
      resultBadge: $('resultBadge'), resultRoute: $('resultRoute'), reviveBtn: $('reviveBtn'),
      wardrobe: $('wardrobe'), skinGrid: $('skinGrid'), biomeGrid: $('biomeGrid'),
      wLifetime: $('wLifetime'), wBar: $('wBar'), wNext: $('wNext'),
      toast: $('toast'), muteBtn: $('muteBtn'),
    };
    this.mode = 'daily';
    this._bind();
  }

  _bind() {
    const on = (id, fn) => $(id).addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    on('playBtn', () => this.h.onPlay(this.mode));
    on('retryBtn', () => this.h.onPlay(this.mode));
    on('menuBtn', () => this.h.onMenu());
    on('shareBtn', () => this.h.onShare());
    on('reviveBtn', () => this.h.onRevive());
    on('wardrobeBtn', () => this.showWardrobe());
    on('wardrobeClose', () => { this.hide('wardrobe'); this.show('menu'); });
    on('muteBtn', () => this.h.onToggleSound());
    on('modeDaily', () => this.setMode('daily'));
    on('modeEndless', () => this.setMode('endless'));
  }

  setMode(mode) {
    this.mode = mode;
    this.el.modeDaily.classList.toggle('on', mode === 'daily');
    this.el.modeEndless.classList.toggle('on', mode === 'endless');
    this.h.onModeChange && this.h.onModeChange(mode);
  }

  show(name) { this.el[name].hidden = false; requestAnimationFrame(() => this.el[name].classList.remove('fade')); }

  hide(name) {
    const el = this.el[name];
    el.classList.add('fade');
    setTimeout(() => { el.hidden = true; }, 280);
  }

  setLoading(pct) {
    this.el.loadBar.style.width = Math.round(pct) + '%';
    this.el.loadPct.textContent = Math.round(pct) + '%';
  }

  hideLoading() { this.hide('loading'); }

  setSoundLabel(muted) { this.el.muteBtn.textContent = muted ? 'Sound: Off' : 'Sound: On'; }

  showMenu({ seedLabel, todayBest }) {
    const s = this.prog.state;
    this.el.menuBest.textContent = s.best;
    this.el.menuToday.textContent = todayBest || 0;
    this.el.menuLifetime.textContent = s.lifetime.toLocaleString();
    this.el.menuSeed.textContent = seedLabel;
    this.setSoundLabel(s.muted);
    this.show('menu');
  }

  showHud(mode) {
    this.el.hud.classList.add('on');
    this.el.hudModeLabel.textContent = mode === 'daily' ? 'DAILY' : 'ENDLESS';
    this.el.hudBest.textContent = this.prog.state.best;
    this.el.tapHint.style.display = '';
  }

  hideHud() { this.el.hud.classList.remove('on'); }

  setLength(v) { this.el.length.textContent = Math.max(0, Math.round(v)); }
  setStage(stage) { this.el.hudStage.textContent = 'STAGE ' + (stage + 1); }
  hideTapHint() { this.el.tapHint.style.display = 'none'; }

  setMultiplier(mult, forksLeft) {
    const on = mult > 1;
    this.el.mult.classList.toggle('on', on);
    if (on) this.el.mult.textContent = `×${mult.toFixed(1)} · ${forksLeft} forks`;
  }

  setGhostDelta(delta) {
    if (delta === null) { this.el.ghostDelta.classList.remove('on'); return; }
    this.el.ghostDelta.classList.add('on');
    const ahead = delta >= 0;
    this.el.ghostDelta.textContent = `${ahead ? '▲' : '▼'} ${Math.abs(Math.round(delta))} vs ghost`;
    this.el.ghostDelta.style.color = ahead ? '#7dffb0' : '#9fd8ff';
  }

  showResults({ result, best, seedLabel, isBest, optimal, canRevive, revivedAlready }) {
    this.el.resultScore.textContent = result.peakLength;
    this.el.resultBest.textContent = best;
    this.el.resultSeed.textContent = seedLabel;
    this.el.resultForks.textContent = result.forks;
    this.el.resultOrbs.textContent = result.pickupsTaken;
    this.el.resultHits.textContent = result.hazardsHit;
    this.el.resultBadge.hidden = !isBest;
    this.el.reviveBtn.hidden = !canRevive || revivedAlready;

    const pct = optimal > 0 ? Math.min(100, Math.round((result.peakLength / optimal) * 100)) : 0;
    this.el.resultRoute.innerHTML =
      `A perfect read of this track reaches <i>${Math.round(optimal)}</i> — you got <i>${pct}%</i> of the way.<br>` +
      `The dotted line is that route; your best run replays as the ghost.`;
    this.show('results');
  }

  showWardrobe() {
    this.hide('menu');
    const s = this.prog.state;
    this.el.wLifetime.textContent = s.lifetime.toLocaleString();

    const nextSkin = this.prog.nextLocked(SKINS);
    const nextBiome = this.prog.nextLocked(BIOMES);
    const next = [nextSkin, nextBiome].filter(Boolean).sort((a, b) => a.unlockAt - b.unlockAt)[0];
    if (next) {
      this.el.wBar.style.width = Math.min(100, (s.lifetime / next.unlockAt) * 100) + '%';
      this.el.wNext.textContent = `${(next.unlockAt - s.lifetime).toLocaleString()} more to unlock ${next.name}`;
    } else {
      this.el.wBar.style.width = '100%';
      this.el.wNext.textContent = 'Everything unlocked. Show-off.';
    }

    this._grid(this.el.skinGrid, SKINS, s.skin, (item) => {
      const c = document.createElement('div');
      c.className = 'swatch';
      c.style.background = `linear-gradient(135deg,#${item.base.toString(16).padStart(6, '0')},#${item.deep.toString(16).padStart(6, '0')} 60%,#${item.glow.toString(16).padStart(6, '0')})`;
      return c;
    }, (id) => { this.prog.setSkin(id); this.h.onCosmeticChange(); this.showWardrobe(); });

    this._grid(this.el.biomeGrid, BIOMES, s.biome, (item) => {
      const c = document.createElement('div');
      c.className = 'swatch';
      c.style.background = `linear-gradient(135deg,#${item.sky[0].toString(16).padStart(6, '0')},#${item.key.toString(16).padStart(6, '0')} 70%,#${item.rim.toString(16).padStart(6, '0')})`;
      return c;
    }, (id) => { this.prog.setBiome(id); this.h.onCosmeticChange(); this.showWardrobe(); });

    this.show('wardrobe');
  }

  _grid(container, list, selectedId, swatchFor, onPick) {
    container.innerHTML = '';
    for (const item of list) {
      const unlocked = this.prog.state.lifetime >= item.unlockAt;
      const card = document.createElement('button');
      card.className = 'card' + (item.id === selectedId ? ' sel' : '') + (unlocked ? '' : ' locked');
      card.appendChild(swatchFor(item));
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = item.name;
      const rq = document.createElement('div');
      rq.className = 'rq';
      rq.textContent = unlocked ? (item.id === selectedId ? 'Equipped' : 'Tap to equip') : `${item.unlockAt.toLocaleString()} lifetime`;
      card.append(nm, rq);
      if (unlocked) card.addEventListener('click', (e) => { e.stopPropagation(); onPick(item.id); });
      container.appendChild(card);
    }
  }

  toast(title, sub) {
    const t = this.el.toast;
    t.firstElementChild.textContent = title;
    t.lastElementChild.textContent = sub || '';
    t.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
  }
}
