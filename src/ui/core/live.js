// Live: one block of lines at the bottom of the output that is redrawn in place.
//
// Why it feels smooth and costs almost nothing:
//  - one timer, time-based animation (frames are computed from elapsed ms, never counted)
//  - a frame identical to the previous one is never written
//  - a frame is a single write(), wrapped in "synchronized output" so terminals paint it atomically
//  - lines are cut to the terminal width, so cursor math never breaks on wrapping
import process from 'node:process';
import { caps, cursor, truncate } from './ansi.js';

const live = new Set();
let hooked = false;

// Whatever happens, never leave the user's terminal without a cursor
function hookExit() {
  if (hooked) return;
  hooked = true;
  process.on('exit', () => {
    for (const l of live) l.release();
  });
}

export class Live {
  constructor({ out = process.stdout, fps = 60 } = {}) {
    this.out = out;
    this.frameMs = 1000 / fps;
    this.enabled = caps.interactive;
    this.height = 0;
    this.prev = null;
    this.timer = null;
    this.draw = null;
  }

  get columns() {
    return Math.max(20, (this.out.columns || 80) - 1);
  }

  // draw(elapsedMs, dtMs) -> string[]
  start(draw) {
    this.draw = draw;
    this.t0 = this.last = performance.now();
    if (!this.enabled) return;
    hookExit();
    live.add(this);
    this.out.write(cursor.hide);
    this.tick();
    this.timer = setInterval(() => this.tick(), this.frameMs);
  }

  tick() {
    const now = performance.now();
    const lines = this.draw(now - this.t0, now - this.last);
    this.last = now;
    this.paint(lines);
  }

  // Redraw immediately (e.g. after a key press) instead of waiting for the next frame
  refresh() {
    if (this.timer) this.tick();
  }

  paint(lines) {
    const next = lines.map((l) => truncate(l, this.columns));
    const key = next.join('\n');
    if (key === this.prev) return;
    this.prev = key;

    let buf = cursor.syncStart + cursor.up(this.height - 1) + '\r';
    buf += next.map((l) => cursor.eraseLine + l).join('\n');
    if (next.length < this.height) buf += cursor.eraseDown;
    buf += cursor.syncEnd;

    this.height = next.length;
    this.out.write(buf);
  }

  // Draws the last frame, leaves it on screen as normal output, restores the cursor
  stop(finalLines) {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.enabled) {
      if (finalLines?.length) this.out.write(finalLines.join('\n') + '\n');
      return;
    }
    if (finalLines) this.paint(finalLines);
    this.out.write('\n');
    this.release();
  }

  release() {
    if (!live.delete(this)) return;
    this.out.write(cursor.show);
  }
}
