// Input: on-screen ◀ ▶ ▲ pads (landscape) plus keyboard. Exposes the current
// button state {left,right,jump}. Co-op direct mode has no swap — each client
// drives only its own hero.

export class Input {
  constructor() {
    this.left = false; this.right = false; this.jump = false;
    this._bindPad('btnLeft', 'left');
    this._bindPad('btnRight', 'right');
    this._bindPad('btnJump', 'jump');

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.key === 'ArrowLeft' || e.key === 'a') this.left = true;
      if (e.key === 'ArrowRight' || e.key === 'd') this.right = true;
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ') this.jump = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'a') this.left = false;
      if (e.key === 'ArrowRight' || e.key === 'd') this.right = false;
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ') this.jump = false;
    });
  }

  _bindPad(id, key) {
    const el = document.getElementById(id);
    if (!el) return;
    const down = (e) => { e.preventDefault(); this[key] = true; el.classList.add('held'); };
    const up = (e) => { e.preventDefault(); this[key] = false; el.classList.remove('held'); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  }

  snapshot() { return { left: this.left, right: this.right, jump: this.jump }; }
}
