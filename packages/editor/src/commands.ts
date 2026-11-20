// SPDX-License-Identifier: Apache-2.0
/** What the ways in do to the page: put an element in, change the block the person is in (ADR 0094). */
import type { EditorView } from "prosemirror-view";
import { Fragment, Slice, type Node as PmNode } from "prosemirror-model";
import { setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { wrapInList } from "prosemirror-schema-list";
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
  if (init.node) {
    // a content element's way in gives the node itself
    const n = view.state.schema.nodeFromJSON(init.node);
    if (n.isInline) view.dispatch(view.state.tr.replaceSelectionWith(n)); else insertAt(view, n, pos);
    return (n.attrs.blockId as string) ?? "";
  }
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
    toggleList: (list, item) => !!type(list) && !!type(item) && wrapInList(type(list)!)(view.state, view.dispatch),
    insertNode: (json) => insertAt(view, view.state.schema.nodeFromJSON(json), pos),
    insertInline: (json) => {
      const nodes = json.map((j) => view.state.schema.nodeFromJSON(j));
      view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)).scrollIntoView());
    },
    replaceBlock: (blockId, json) => {
      let at = -1, size = 0;
      view.state.doc.descendants((n, p) => { if (at < 0 && n.attrs.blockId === blockId) { at = p; size = n.nodeSize; } return at < 0; });
      if (at >= 0) view.dispatch(view.state.tr.replaceWith(at, at + size, view.state.schema.nodeFromJSON(json)));
    },
    insertElement: (kind, init) => insertElement(view, host, kind, init, pos),
    toggleMark: (name, attrs) => {
      const t = view.state.schema.marks[name];
      return !!t && toggleMark(t, attrs ?? null, { removeWhenPresent: false })(view.state, view.dispatch);
    },
    markActive: (name) => markActive(view.state, name),
    blockActive: (t, attrs) => {
      const p = view.state.selection.$from.parent;
      return p.type.name === t && Object.entries(attrs ?? {}).every(([k, v]) => p.attrs[k] === v);
    },
    setAlign: (value) => {
      const { from, to } = view.state.selection, tr = view.state.tr;
      view.state.doc.nodesBetween(from, to, (n, pos) => { if (n.isTextblock && "align" in n.attrs) tr.setNodeMarkup(pos, undefined, { ...n.attrs, align: value }); });
      if (!tr.docChanged) return false;
      view.dispatch(tr);
      return true;
    },
    spot: () => {
      try {
        const r = view.coordsAtPos(Math.min(pos ?? view.state.selection.from, view.state.doc.content.size));
        return { left: r.left, top: r.top, bottom: r.bottom };
      } catch {
        const r = view.dom.getBoundingClientRect();
        return { left: r.left, top: r.top, bottom: r.top };
      }
    },
  };
}

/** Whether all text of the selection has the mark; at a cursor, whether what is typed next would. */
export function markActive(state: import("prosemirror-state").EditorState, name: string): boolean {
  const t = state.schema.marks[name];
  if (!t) return false;
  const { from, to, empty, $from } = state.selection;
  if (empty) return !!t.isInSet(state.storedMarks ?? $from.marks());
  let all = true, any = false;
  state.doc.nodesBetween(from, to, (n) => { if (n.isText) { any = true; if (!t.isInSet(n.marks)) all = false; } });
  return any && all;
}
