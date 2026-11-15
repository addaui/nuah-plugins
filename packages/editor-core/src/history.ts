import { applyTransaction, type Transaction } from "./transform";
import type { Node } from "./doc";

/**
 * Undo and redo over transactions. Transactions with the same `group` that follow each other within `joinMs` are one undo (typing a word). Nothing here
 * depends on an engine, so the same history serves any of them, and a collaboration layer can replace it with one that only undoes your own changes.
 */
export class History {
  private past: { tr: Transaction; at: number }[] = [];
  private future: Transaction[] = [];
  constructor(private joinMs = 500) {}

  /** Records the inverse of a transaction that was applied. */
  push(inverse: Transaction, at = Date.now()) {
    this.future = [];
    const last = this.past.at(-1);
    if (last && inverse.group && last.tr.group === inverse.group && at - last.at <= this.joinMs) {
      last.tr = { steps: [...inverse.steps, ...last.tr.steps], group: last.tr.group };
      last.at = at;
    } else this.past.push({ tr: inverse, at });
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  undo(doc: Node): Node {
    const e = this.past.pop();
    if (!e) return doc;
    const r = applyTransaction(doc, e.tr);
    this.future.push(r.inverse);
    return r.doc;
  }
  redo(doc: Node): Node {
    const t = this.future.pop();
    if (!t) return doc;
    const r = applyTransaction(doc, t);
    this.past.push({ tr: r.inverse, at: 0 });
    return r.doc;
  }
}
