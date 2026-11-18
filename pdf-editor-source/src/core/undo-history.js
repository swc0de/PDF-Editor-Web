// Snapshot-based undo history.
//
// Why snapshots and not do/undo pairs: every step stores the complete PDF
// bytes *after* the step. Undo/redo/jump just switch which snapshot is
// current. That is exact for any operation — including ones that can't be
// inverted cheaply (rasterised redaction, OCR text layers, flattening) — and
// it can't drift out of sync the way paired inverse operations can. pdf-lib
// rewrites the whole file on save anyway, so a snapshot costs nothing extra
// to produce. The price is memory, so the history is capped by step count and
// by total bytes; the oldest snapshots are dropped first (the panel says so).

export const DEFAULT_LIMITS = { maxSteps: 100, maxBytes: 512 * 1024 * 1024 };

let nextVersion = 1;
export const newVersion = () => `v${nextVersion++}`;

/**
 * @typedef {Object} HistoryEntry
 * @property {string} version     unique id of this state
 * @property {string} label       user-facing step name ("Rotate page 3")
 * @property {Uint8Array} bytes   the whole document after this step
 * @property {number} pageCount
 * @property {number[]|null} affected  pages this step changed (null = any)
 * @property {number} time
 */

export class UndoHistory {
  constructor(initial, limits = DEFAULT_LIMITS) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.entries = [initial];
    this.index = 0;
    this.trimmed = 0;
  }

  get current() {
    return this.entries[this.index];
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.entries.length - 1;
  }

  get undoEntry() {
    return this.canUndo ? this.current : null;
  }

  get redoEntry() {
    return this.canRedo ? this.entries[this.index + 1] : null;
  }

  get totalBytes() {
    return this.entries.reduce((sum, e) => sum + e.bytes.length, 0);
  }

  /** Add a step after the current one (discarding any redo branch). */
  push(entry) {
    this.entries.splice(this.index + 1);
    this.entries.push(entry);
    this.index = this.entries.length - 1;
    this.trim();
  }

  trim() {
    const { maxSteps, maxBytes } = this.limits;
    while (this.index > 0 && (this.entries.length - 1 > maxSteps || this.totalBytes > maxBytes)) {
      this.entries.shift();
      this.index--;
      this.trimmed++;
    }
  }

  /**
   * Make entry `to` current. Returns what changed between the two states:
   * the union of the affected pages of every step crossed (null = any).
   */
  moveTo(to) {
    const target = typeof to === 'number' ? to : this.entries.indexOf(to);
    if (target < 0 || target >= this.entries.length) throw new RangeError('No such history entry');
    const from = this.index;
    const lo = Math.min(from, target);
    const hi = Math.max(from, target);
    let affected = new Set();
    for (let i = lo + 1; i <= hi; i++) {
      const a = this.entries[i].affected;
      if (!a) {
        affected = null;
        break;
      }
      a.forEach((p) => affected.add(p));
    }
    const fromEntry = this.entries[from];
    this.index = target;
    return {
      from: fromEntry,
      to: this.current,
      affected: affected ? [...affected].sort((a, b) => a - b) : null,
      structural: fromEntry.pageCount !== this.current.pageCount,
    };
  }
}
