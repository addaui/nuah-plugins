import type { Node } from "./doc";
import type { Transaction } from "./transform";

/**
 * What an editing engine must give the editor (ADR 0074). Everything the engine is good at (selection, IME, clipboard, drag, caret across blocks) stays
 * behind this; everything plugins extend (the model, the registry, commands, options) is in front of it. A second adapter can be written to the same
 * interface and run against the same tests.
 */
export interface EditorEngine {
  mount(host: HTMLElement): void;
  destroy(): void;
  /** Replaces the whole document (opening a page, a restored version). */
  setDoc(doc: Node): void;
  /** Called with what the person's editing did, as steps against the model. */
  onTransaction(cb: (tr: Transaction, doc: Node) => void): () => void;
  /** Applies a transaction made elsewhere (a command, another person). */
  dispatch(tr: Transaction): void;
  /** Where the cursor is: the path of the innermost block and the offset in it, or the path of a selected block object. */
  selection(): { path: number[]; offset?: number; selected?: boolean } | null;
  focus(): void;
}
