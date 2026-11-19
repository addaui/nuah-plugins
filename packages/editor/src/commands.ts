// SPDX-License-Identifier: Apache-2.0
/** What the ways in do to the page: put an element in, change the block the person is in (ADR 0094). */
import type { EditorView } from "prosemirror-view";
import type { Node as PmNode } from "prosemirror-model";
import { setBlockType, wrapIn } from "prosemirror-commands";
import type { EditorCommands, ElementInit } from "@nuah/editor-api";
import { newBlockId } from "./engine";
import { stateFor, type StateType } from "./state";
import type { CardHost } from "./card";

/** Content goes between blocks: onto an empty line (which it replaces), or after the block the place is in. */
export function insertAt(view: EditorView, content: PmNode | PmNode[], pos?: number) {
  const s = view.state, $p = s.doc.resolve(Math.min(pos ?? s.selection.from, s.doc.content.size));
  let range = { from: $p.pos, to: $p.pos };
  if ($p.depth >= 1) { const from = $p.before(1), to = $p.after(1), top = $p.node(1); range = top.isTextblock && top.content.size === 0 ? { from, to } : { from: to, to }; }
  view.dispatch(s.tr.replaceWith(range.from, range.to, content));
}

/** A new element of `kind` (its module need not be loaded): a block between blocks, or inline at the cursor. Returns its id. */
export function insertElement(view: EditorView, host: CardHost, kind: string, init: ElementInit = {}, pos?: number): string {
  const decl = host.list.kinds.find((k) => k.kind === kind);
  if (!decl) throw new Error(`no enabled plugin brings ${kind}`);
  const id = newBlockId();
  const type = decl.placement === "inline" ? "elementInline" : "element";
  const node = view.state.schema.nodes[type]!.create({ blockId: id, kind, v: decl.version, plugin: decl.plugin, data: init.data ?? {}, fallback: null });
  if (type === "element") insertAt(view, node, pos);
  else view.dispatch(view.state.tr.replaceSelectionWith(node));
  if (init.fill && decl.state && host.doc) {
    init.fill(stateFor(host.doc, id, decl.state as StateType, true).container);
    host.doc.commit();
  }
  return id;
}

export function commandsFor(view: EditorView, host: CardHost, pos?: number): EditorCommands {
  const type = (n: string) => view.state.schema.nodes[n];
  return {
    setBlock: (t, attrs) => !!type(t) && setBlockType(type(t)!, attrs)(view.state, view.dispatch),
    wrapIn: (t, attrs) => !!type(t) && wrapIn(type(t)!, attrs)(view.state, view.dispatch),
    toggleList: (list, item) => !!type(list) && !!type(item) && wrapIn(type(list)!)(view.state, view.dispatch),
    insertNode: (json) => insertAt(view, view.state.schema.nodeFromJSON(json), pos),
    insertElement: (kind, init) => insertElement(view, host, kind, init, pos),
  };
}
