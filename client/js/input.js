// Input: on-screen ◀ ▶ ▲ pads (landscape) plus keyboard. Exposes the current
// button state {left,right,jump}. Co-op direct mode has no swap — each client
// drives only its own hero.
//
// Touch: the whole left pad is ONE slide zone. A finger is captured on press and
// steers toward whichever arrow centre it is nearest, so a thumb can roll from ◀
// to ▶ (or drift off the buttons) without the hero stopping. Distances are
// measured in screen space, so this survives the forced-landscape rotation.
// Keyboard: physical keys (e.code, layout/CapsLock independent); the most recent
// direction wins when both are held; everything releases when focus is lost.

const KEY_LEFT = new Set(['ArrowLeft', 'KeyA']);
const KEY_RIGHT = new Set(['ArrowRight', 'KeyD']);
const KEY_JUMP = new Set(['ArrowUp', 'KeyW', 'Space']);

export class Input {
  constructor() {
    this.left = false; this.right = false; this.jump = false;

    this._keys = { left: false, right: false, jump: false };
    this._keyDir = 0;                 // last pressed keyboard direction
    this._dirPtrs = new Map();        // pointerId -> -1 | 1 on the move pad
    this._jumpPtrs = new Set();

    this._bindMovePad();
    this._bindJump();

    window.addEventListener('keydown', (e) => {
      const c = e.code;
      if (KEY_LEFT.has(c)) { this._keys.left = true; this._keyDir = -1; }
      else if (KEY_RIGHT.has(c)) { this._keys.right = true; this._keyDir = 1; }
      else if (KEY_JUMP.has(c)) this._keys.jump = true;
      else return;
      e.preventDefault();
      this._sync();
    });
    window.addEventListener('keyup', (e) => {
      const c = e.code;
      if (KEY_LEFT.has(c)) { this._keys.left = false; if (this._keys.right) this._keyDir = 1; }
      else if (KEY_RIGHT.has(c)) { this._keys.right = false; if (this._keys.left) this._keyDir = -1; }
      else if (KEY_JUMP.has(c)) this._keys.jump = false;
      else return;
      this._sync();
    });
    const releaseAll = () => {
      this._keys.left = this._keys.right = this._keys.jump = false;
      this._keyDir = 0;
      this._dirPtrs.clear(); this._jumpPtrs.clear();
      this._sync();
    };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
    // Inside the host iframe the game never gets key focus on its own.
    window.addEventListener('pointerdown', () => { try { window.focus(); } catch {} }, true);
  }

  _bindMovePad() {
    const bl = document.getElementById('btnLeft'), br = document.getElementById('btnRight');
    const pad = bl && bl.parentElement;
    if (!pad || !br) return;
    const dirAt = (e) => {
      const a = bl.getBoundingClientRect(), b = br.getBoundingClientRect();
      const da = Math.hypot(e.clientX - (a.left + a.width / 2), e.clientY - (a.top + a.height / 2));
      const db = Math.hypot(e.clientX - (b.left + b.width / 2), e.clientY - (b.top + b.height / 2));
      return da <= db ? -1 : 1;
    };
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { pad.setPointerCapture(e.pointerId); } catch {}
      this._dirPtrs.set(e.pointerId, dirAt(e));
      this._sync();
    });
    pad.addEventListener('pointermove', (e) => {
      if (!this._dirPtrs.has(e.pointerId)) return;
      const d = dirAt(e);
      if (d !== this._dirPtrs.get(e.pointerId)) { this._dirPtrs.set(e.pointerId, d); this._sync(); }
    });
    const up = (e) => { if (this._dirPtrs.delete(e.pointerId)) this._sync(); };
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('lostpointercapture', up);
  }

  _bindJump() {
    const el = document.getElementById('btnJump');
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch {}
      this._jumpPtrs.add(e.pointerId);
      this._sync();
    });
    const up = (e) => { if (this._jumpPtrs.delete(e.pointerId)) this._sync(); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  _sync() {
    // newest touch on the move pad wins, then the newest keyboard direction
    let dir = 0;
    for (const d of this._dirPtrs.values()) dir = d;
    if (!dir) dir = this._keys.left && this._keys.right ? this._keyDir
      : this._keys.left ? -1 : this._keys.right ? 1 : 0;
    this.left = dir < 0; this.right = dir > 0;
    this.jump = this._keys.jump || this._jumpPtrs.size > 0;
    const bl = document.getElementById('btnLeft'), br = document.getElementById('btnRight');
    const bj = document.getElementById('btnJump');
    if (bl) bl.classList.toggle('held', this.left);
    if (br) br.classList.toggle('held', this.right);
    if (bj) bj.classList.toggle('held', this.jump);
  }

  snapshot() { return { left: this.left, right: this.right, jump: this.jump }; }
}
