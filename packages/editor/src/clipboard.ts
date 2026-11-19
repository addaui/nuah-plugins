// SPDX-License-Identifier: Apache-2.0
/**
 * Copying an element copies its own state (ADR 0094): the clipboard carries the container's content in the node (`copy`), and a
 * paste gives the element a new id and a new container filled from it, so the copy and the original never share state.
 */
import { Fragment, Slice, type Node as PmNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { LoroList, LoroMap, LoroMovableList, LoroText, type LoroDoc } from "loro-crdt";
import { newBlockId } from "./engine";
import { stateFor, type StateType } from "./state";
import type { CardHost } from "./card";

const isElement = (n: PmNode) => n.type.name === "element" || n.type.name === "elementInline";

function mapSlice(slice: Slice, f: (n: PmNode) => PmNode): Slice {
  const go = (frag: Fragment): Fragment => {
    const out: PmNode[] = [];
    frag.forEach((n) => out.push(f(n.content.size ? n.copy(go(n.content)) : n)));
    return Fragment.from(out);
  };
  return new Slice(go(slice.content), slice.openStart, slice.openEnd);
}

function save(doc: LoroDoc, id: string): unknown {
  const c = doc.getMap("elements").get(id);
  if (c instanceof LoroText) return { t: "text", delta: c.toDelta() };
  if (c instanceof LoroMap) return { t: "map", json: c.toJSON() };
  if (c instanceof LoroMovableList) return { t: "movableList", json: c.toJSON() };
  if (c instanceof LoroList) return { t: "list", json: c.toJSON() };
  return null;
}
function restore(c: unknown, copy: { t: string; delta?: unknown[]; json?: unknown }) {
  if (c instanceof LoroText && copy.delta) c.applyDelta(copy.delta as never);
  else if (c instanceof LoroMap && copy.json && typeof copy.json === "object") for (const [k, v] of Object.entries(copy.json as Record<string, unknown>)) c.set(k, v as never);
  else if ((c instanceof LoroList || c instanceof LoroMovableList) && Array.isArray(copy.json)) copy.json.forEach((v, i) => c.insert(i, v as never));
}

export function clipboardPlugin(host: CardHost): Plugin {
  return new Plugin({
    key: new PluginKey("nuahClipboard"),
    props: {
      transformCopied: (slice) => (host.doc ? mapSlice(slice, (n) => (isElement(n) && n.attrs.blockId ? n.type.create({ ...n.attrs, copy: save(host.doc!, n.attrs.blockId) }, n.content, n.marks) : n)) : slice),
      transformPasted: (slice) => mapSlice(slice, (n) => (isElement(n) ? n.type.create({ ...n.attrs, blockId: newBlockId() }, n.content, n.marks) : n)),
    },
    appendTransaction(trs, _o, state) {
      if (!trs.some((t) => t.docChanged)) return null;
      const tr = state.tr;
      let changed = false;
      state.doc.descendants((n, pos) => {
        if (!isElement(n) || !n.attrs.copy) return;
        const decl = host.list.kinds.find((k) => k.kind === n.attrs.kind);
        if (host.doc && decl?.state) restore(stateFor(host.doc, n.attrs.blockId, decl.state as StateType, true).container, n.attrs.copy);
        tr.setNodeMarkup(pos, undefined, { ...n.attrs, copy: null });
        changed = true;
      });
      if (changed) host.doc?.commit();
      return changed ? tr : null;
    },
  });
}
