// The editable document behind a tab: the current bytes, the snapshot undo
// history and the saved state. Every change goes through execute() (a named
// step, run by the pdf-lib worker) or undo/redo/jumpTo. Operations are
// serialised; `onChange` (the tab reloading its view) is awaited inside the
// queue, so the view and the model never disagree.
import { UndoHistory, newVersion } from './undo-history.js';
import { applyOp, runQuery, closeWorkerDoc } from './pdf-worker.js';

export class ReadOnlyError extends Error {
  constructor(reason) {
    super(`This document can't be edited (${reason})`);
    this.name = 'ReadOnlyError';
    this.reason = reason;
  }
}

let nextDoc = 1;

export class DocumentModel extends EventTarget {
  /**
   * @param {object} o
   * @param {Uint8Array} o.bytes
   * @param {number} o.pageCount
   * @param {string} o.openLabel        label of the initial history entry
   * @param {boolean} [o.clean]         false for recovered documents (not saved anywhere)
   * @param {string|null} [o.readOnly]  reason, e.g. 'encrypted'
   * @param {(change) => Promise} o.onChange
   * @param {object} [o.limits]
   */
  constructor({ bytes, pageCount, openLabel, clean = true, readOnly = null, onChange, limits }) {
    super();
    this.docId = `d${nextDoc++}`;
    this.history = new UndoHistory({
      version: newVersion(),
      label: openLabel,
      bytes,
      pageCount,
      affected: null,
      time: Date.now(),
      initial: true,
      readOnly,
    }, limits);
    this.savedEntry = clean ? this.history.current : null;
    this.readOnly = readOnly;
    this.onChange = onChange;
    this.queue = Promise.resolve();
    this.busy = false;
    this.fileHandle = null;
  }

  get bytes() {
    return this.history.current.bytes;
  }

  get dirty() {
    return this.history.current !== this.savedEntry;
  }

  get canUndo() {
    return this.history.canUndo;
  }

  get canRedo() {
    return this.history.canRedo;
  }

  /** Serialise a task behind every earlier one. */
  enqueue(task) {
    const run = this.queue.then(async () => {
      this.busy = true;
      this.emit('busychange');
      try {
        return await task();
      } finally {
        this.busy = false;
        this.emit('busychange');
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Run a named operation as one undo step.
   * @param {string} op     worker op name (core/ops)
   * @param {object} args
   * @param {string} label  user-facing step name
   */
  execute(op, args, label) {
    return this.enqueue(async () => {
      if (this.readOnly) throw new ReadOnlyError(this.readOnly);
      const from = this.history.current;
      const version = newVersion();
      let result;
      try {
        result = await applyOp({
          docId: this.docId,
          version: from.version,
          newVersion: version,
          op,
          args,
          getBytes: () => from.bytes,
        });
      } catch (err) {
        if (err.name === 'EncryptedPDFError') {
          this.readOnly = 'encrypted';
          this.emit('readonlychange');
          throw new ReadOnlyError('encrypted');
        }
        throw err;
      }
      const entry = {
        version,
        label,
        bytes: result.bytes,
        pageCount: result.pageCount,
        affected: result.affected,
        time: Date.now(),
      };
      this.history.push(entry);
      await this.changed({
        from,
        to: entry,
        affected: result.affected,
        structural: from.pageCount !== entry.pageCount,
      });
      return result.value;
    });
  }

  /**
   * Record bytes made outside the pdf-lib worker (e.g. qpdf removing
   * encryption) as one undo step. `readOnly` is the state that goes with them
   * (null = editable); undo/redo restore each step's own state.
   */
  commitBytes(bytes, { label, pageCount, readOnly = null }) {
    return this.enqueue(async () => {
      const from = this.history.current;
      const entry = {
        version: newVersion(),
        label,
        bytes,
        pageCount: pageCount ?? from.pageCount,
        affected: null,
        time: Date.now(),
        readOnly,
      };
      this.history.push(entry);
      await this.changed({ from, to: entry, affected: null, structural: true });
      return true;
    });
  }

  /** A read-only operation on the current state (nothing is recorded). */
  query(op, args) {
    return this.enqueue(async () => {
      const cur = this.history.current;
      return runQuery({ docId: this.docId, version: cur.version, op, args, getBytes: () => cur.bytes });
    });
  }

  undo() {
    return this.enqueue(async () => {
      if (!this.history.canUndo) return false;
      await this.changed(this.history.moveTo(this.history.index - 1));
      return true;
    });
  }

  redo() {
    return this.enqueue(async () => {
      if (!this.history.canRedo) return false;
      await this.changed(this.history.moveTo(this.history.index + 1));
      return true;
    });
  }

  /** Jump to any entry of the history (Undo History panel). */
  jumpTo(entry) {
    return this.enqueue(async () => {
      if (entry === this.history.current) return false;
      await this.changed(this.history.moveTo(entry));
      return true;
    });
  }

  async changed(change) {
    // Steps that know their read-only state (the opened file, commitBytes) restore it.
    if (change.to && change.to.readOnly !== undefined) this.setReadOnly(change.to.readOnly);
    try {
      await this.onChange?.(change);
    } finally {
      this.emit('historychange');
      this.emit('dirtychange');
    }
  }

  /** Mark the document read-only (e.g. it turned out to be encrypted). */
  setReadOnly(reason) {
    const cur = this.history.current;
    if (cur?.initial) cur.readOnly = reason; // the opened file's own state, restored by undo
    if (this.readOnly === reason) return;
    this.readOnly = reason;
    this.emit('readonlychange');
  }

  markSaved() {
    this.savedEntry = this.history.current;
    this.emit('dirtychange');
    this.emit('historychange');
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  dispose() {
    closeWorkerDoc(this.docId);
  }
}
