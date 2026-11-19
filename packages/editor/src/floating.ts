// SPDX-License-Identifier: Apache-2.0
/**
 * The floating layer (ADR 0094, 0071): elements that sit over the page rather than in its text (stickers). They live in the Live
 * document's root map `floating`, one entry per element by its id, so two people moving different stickers both keep their move, and they
 * are versioned and restored with the body. A copy without a Live document reads them from its JSON (`attrs.floating`). The editor makes
 * two layers over the text (behind and in front) and hands them to the Face, which draws the elements; it answers where blocks and lines
 * are, for anchoring.
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { LoroDoc } from "loro-crdt";

export interface FloatingHooks {
  onLayers(l: { back: HTMLElement; front: HTMLElement }): void;
  onList(list: unknown[]): void;
  onLayout(): void;
}

type Item = { id: string; [k: string]: unknown };
const byOrder = (a: Item, b: Item) => String(a.z ?? "").localeCompare(String(b.z ?? "")) || a.id.localeCompare(b.id);

/** The list: from the Live document, else from the JSON the editor opened. */
export function floatingOf(doc: LoroDoc | undefined, content: unknown): unknown[] {
  if (doc) return Object.values(doc.getMap("floating").toJSON() as Record<string, Item>).sort(byOrder);
  const a = (content as { attrs?: { floating?: unknown } } | null)?.attrs?.floating;
  return Array.isArray(a) ? a : [];
}

/** Writes the list into the Live document: only the entries that changed, and removes the ones that went. */
export function setFloating(doc: LoroDoc | undefined, list: unknown[]) {
  if (!doc) return;
  const m = doc.getMap("floating"), now = m.toJSON() as Record<string, unknown>, keep = new Set<string>();
  for (const it of list as Item[]) {
    if (!it || typeof it.id !== "string") continue;
    keep.add(it.id);
    if (JSON.stringify(now[it.id]) !== JSON.stringify(it)) m.set(it.id, JSON.parse(JSON.stringify(it)));
  }
  for (const id of Object.keys(now)) if (!keep.has(id)) m.delete(id);
  doc.commit();
}

/** The top-level block at a point, by its id, and the character under the point in it (for a sticker pinned to a word). */
export function blockAt(view: EditorView, x: number, y: number): { id: string; at?: number } | null {
  const p = view.posAtCoords({ left: x, top: y });
  if (!p) return null;
  const $p = view.state.doc.resolve(p.pos);
  if ($p.depth < 1) { const n = view.state.doc.nodeAt(p.inside); return n?.attrs.blockId ? { id: n.attrs.blockId } : null; }
  const top = $p.node(1);
  return top.attrs.blockId ? { id: top.attrs.blockId, ...(top.isTextblock ? { at: p.pos - $p.start(1) } : {}) } : null;
}

/** The top of the line a character of a block is on, in the page's coordinates. */
export function lineTop(view: EditorView, id: string, at: number): number | null {
  let pos = -1;
  view.state.doc.forEach((n, off) => { if (pos < 0 && n.attrs.blockId === id) pos = off + 1 + Math.min(at, n.content.size); });
  if (pos < 0) return null;
  try { return view.coordsAtPos(pos).top; } catch { return null; }
}

export function floatingPlugin(place: HTMLElement, hooks: FloatingHooks | undefined, doc: LoroDoc | undefined, content: () => unknown): Plugin {
  return new Plugin({
    key: new PluginKey("nuahFloating"),
    view(view) {
      if (!hooks) return {};
      const make = (name: string) => { const el = document.createElement("div"); el.className = `nuah-floating nuah-floating-${name}`; el.setAttribute("aria-hidden", "false"); return el; };
      const back = make("back"), front = make("front");
      place.prepend(back);
      place.append(front);
      hooks.onLayers({ back, front });
      let last = JSON.stringify(floatingOf(doc, content()));
      hooks.onList(floatingOf(doc, content()));
      const unsub = doc?.getMap("floating").subscribe(() => {
        const now = JSON.stringify(floatingOf(doc, null));
        if (now !== last) { last = now; hooks.onList(floatingOf(doc, null)); }
      });
      const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => hooks.onLayout()) : null;
      ro?.observe(view.dom);
      return {
        update(v, prev) { if (!prev.doc.eq(v.state.doc)) hooks.onLayout(); },
        destroy() { unsub?.(); ro?.disconnect(); back.remove(); front.remove(); },
      };
    },
  });
}
