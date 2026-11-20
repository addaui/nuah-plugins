// SPDX-License-Identifier: Apache-2.0
/**
 * Moving a block by dragging it: from its handle in the margin, or a card itself. It drops only between top-level blocks (inside a
 * callout, a toggle or columns comes later): while dragging, one line shows the gap it will land in, the gap nearest the pointer,
 * so there is no place where a drop does something unseen.
 */
import { NodeSelection, Plugin, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

type Dragging = { slice: import("prosemirror-model").Slice; move: boolean; node?: NodeSelection };
const dragging = (view: EditorView) => (view as unknown as { dragging: Dragging | null }).dragging;

/** The dragged thing, when it is one whole top-level block. */
function movedBlock(view: EditorView): { from: number; to: number } | null {
  const d = dragging(view);
  const sel = d?.node;
  if (!d || !sel || !(sel instanceof NodeSelection) || sel.$from.depth !== 0 || !sel.node.isBlock) return null;
  return { from: sel.from, to: sel.to };
}

/** The gap nearest a height on screen: the position between two top-level blocks (before the first block whose middle is below it). */
export function gapAt(view: EditorView, y: number): { pos: number; top: number } | null {
  let found: { pos: number; top: number } | null = null, last: DOMRect | null = null;
  view.state.doc.forEach((_n, offset) => {
    if (found) return;
    const dom = view.nodeDOM(offset) as HTMLElement | null;
    if (!dom?.getBoundingClientRect) return;
    const r = dom.getBoundingClientRect();
    if (y < r.top + r.height / 2) found = { pos: offset, top: last ? (last.bottom + r.top) / 2 : r.top - 2 };
    last = r;
  });
  return found ?? (last ? { pos: view.state.doc.content.size, top: (last as DOMRect).bottom + 2 } : null);
}

/** Moves the block at from..to to a gap; nothing when the gap is the block's own place. */
export function moveBlock(state: EditorState, block: { from: number; to: number }, gap: number) {
  if (gap >= block.from && gap <= block.to) return null;
  const node = state.doc.slice(block.from, block.to).content;
  const tr = state.tr.delete(block.from, block.to);
  const at = tr.mapping.map(gap);
  tr.insert(at, node);
  return tr.setSelection(NodeSelection.create(tr.doc, at)).scrollIntoView();
}

export function movePlugin(): Plugin {
  let line: HTMLElement | null = null;
  const hide = () => { if (line) line.hidden = true; };
  return new Plugin({
    view(view) {
      line = document.createElement("div");
      line.className = "nuah-drop-line";
      line.hidden = true;
      document.body.append(line);
      return { destroy: () => { line?.remove(); line = null; } };
    },
    props: {
      handleDOMEvents: {
        dragover(view, e) {
          if (!movedBlock(view)) return false;
          e.preventDefault();
          const g = gapAt(view, e.clientY);
          if (g && line) {
            const r = view.dom.getBoundingClientRect();
            Object.assign(line.style, { position: "fixed", left: `${r.left}px`, width: `${r.width}px`, top: `${g.top - 1}px` });
            line.hidden = false;
          }
          return true; // the block line replaces the caret-shaped drop cursor
        },
        dragleave(view, e) { if (!view.dom.contains(e.relatedTarget as Node | null)) hide(); return false; },
        dragend() { hide(); return false; },
        drop(view, e) {
          const block = movedBlock(view);
          if (!block) return false;
          e.preventDefault();
          hide();
          const g = gapAt(view, e.clientY);
          const tr = g ? moveBlock(view.state, block, g.pos) : null;
          if (tr) view.dispatch(tr);
          (view as unknown as { dragging: Dragging | null }).dragging = null;
          return true;
        },
      },
    },
  });
}
