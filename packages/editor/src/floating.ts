// SPDX-License-Identifier: Apache-2.0
/**
 * The floating layer (ADR 0094, 0071): elements that sit over the page rather than in its text (stickers). They live in the Live
 * document's root map `floating`, one entry per element by its id, so two people moving different stickers both keep their move, and they
 * are versioned and restored with the body. A copy without a Live document reads them from its JSON (`attrs.floating`). The editor makes
 * two layers over the text (behind and in front) and hands them to the Face, which draws the elements; it answers where blocks and lines
 * are, for anchoring.
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
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

/**
 * Text flowing around floating elements (ADR 0071): a wrap is a float at the start of its block, shaped like the element (box, oval, or the
 * picture's own outline); a gap is the part of a line an element covers, kept clear by a spacer before the first word it covers. Neither
 * ever enters the document: both are decorations, measured again when fonts arrive or the column changes width.
 */
export interface Wrap { anchor: string; side?: "start" | "end"; width: number; height: number; inset: number; top: number; margin: number; shape?: "rect" | "oval" | "contour"; image?: string; kind?: undefined }
export interface Gap { kind: "gap"; anchor: string; x0: number; x1: number; y0: number; y1: number; shape?: "rect" | "oval" }
type Spacer = { anchor: string; pos: number; width: number };

const wrapKey = new PluginKey("nuahWraps");

export function wrapsLayer(view: () => EditorView) {
  let wraps: Wrap[] = [], gaps: Gap[] = [], spacers: Spacer[] = [], json = "[]", settling = false, timer = 0;
  const redraw = () => view().dispatch(view().state.tr.setMeta(wrapKey, 1).setMeta("addToHistory", false));
  const blockPosOf = (id: string) => { let at = -1; view().state.doc.descendants((n, p) => { if (at < 0 && n.isTextblock && n.attrs.blockId === id) at = p; return at < 0; }); return at; };
  /** Every word of a text block with where it is, relative to the block's text box. */
  const wordsOf = (blockPos: number) => {
    const v = view(), dom = v.nodeDOM(blockPos) as HTMLElement | null;
    if (!dom) return null;
    const r = dom.getBoundingClientRect(), cs = getComputedStyle(dom), px = (x: string) => parseFloat(x) || 0;
    const ox = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft), oy = r.top + px(cs.borderTopWidth) + px(cs.paddingTop);
    const out: { pos: number; left: number; right: number; top: number; bottom: number }[] = [];
    const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT, { acceptNode: (n) => ((n.parentElement as HTMLElement | null)?.closest(".sticker-gap, .sticker-wrap") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const re = /\S+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(node.data))) {
        const range = document.createRange();
        range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
        const rect = range.getClientRects()[0];
        if (!rect) continue;
        let pos = -1;
        try { pos = v.posAtDOM(node, m.index); } catch { continue; }
        out.push({ pos, left: rect.left - ox, right: rect.right - ox, top: rect.top - oy, bottom: rect.bottom - oy });
      }
    }
    return out;
  };
  /** The part of the line at height y the element covers, or null. */
  const holeAt = (g: Gap, y: number): [number, number] | null => {
    if (y < g.y0 || y > g.y1) return null;
    if (g.shape !== "oval") return [g.x0, g.x1];
    const cx = (g.x0 + g.x1) / 2, cy = (g.y0 + g.y1) / 2, a = (g.x1 - g.x0) / 2, b = (g.y1 - g.y0) / 2, k = (y - cy) / b;
    if (Math.abs(k) >= 1) return null;
    const dx = a * Math.sqrt(1 - k * k);
    return [cx - dx, cx + dx];
  };
  const nextGap = (g: Gap, words: NonNullable<ReturnType<typeof wordsOf>>) => {
    const lines: (typeof words)[] = [];
    for (const w of [...words].sort((p, q) => p.top - q.top || p.left - q.left)) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last[0]!.top - w.top) < 3) last.push(w); else lines.push([w]);
    }
    for (const line of lines) {
      const hole = holeAt(g, (line[0]!.top + line[0]!.bottom) / 2);
      if (!hole) continue;
      const w = line.find((x) => x.right > hole[0] + 0.5);
      if (!w || w.left >= hole[1] - 0.5) continue;
      if (spacers.some((s) => s.anchor === g.anchor && s.pos === w.pos)) continue;
      return { pos: w.pos, width: Math.max(1, hole[1] - w.left) };
    }
    return null;
  };
  const settle = () => {
    if (settling) return;
    settling = true;
    try {
      spacers = [];
      redraw();
      for (const g of gaps) for (let i = 0; i < 80; i++) {
        const at = blockPosOf(g.anchor), words = at >= 0 ? wordsOf(at) : null, next = words && nextGap(g, words);
        if (!next) break;
        spacers.push({ anchor: g.anchor, pos: next.pos, width: next.width });
        redraw();
      }
    } finally { settling = false; }
  };
  const soon = () => { cancelAnimationFrame(timer); timer = requestAnimationFrame(() => { if (gaps.length) settle(); }); };
  const plugin = new Plugin({
    key: wrapKey,
    state: { init: () => 0, apply: (tr, n) => { if (!settling && tr.docChanged && (gaps.length || spacers.length)) { spacers = spacers.map((s) => ({ ...s, pos: tr.mapping.map(s.pos) })); soon(); } return n; } },
    props: {
      decorations: (st) => {
        if (!wraps.length && !spacers.length) return null;
        const ds: Decoration[] = [];
        for (const w of wraps) {
          let at = -1;
          st.doc.descendants((n, p) => { if (at < 0 && n.isTextblock && n.attrs.blockId === w.anchor) at = p + 1; return at < 0; });
          if (at < 0) continue;
          ds.push(Decoration.widget(at, () => {
            const el = document.createElement("div");
            el.className = "sticker-wrap"; el.setAttribute("aria-hidden", "true"); el.contentEditable = "false";
            const f = el.style;
            f.setProperty("float", w.side === "end" ? "inline-end" : "inline-start");
            f.width = w.width + "px"; f.height = w.height + "px";
            f.setProperty(w.side === "end" ? "margin-inline-end" : "margin-inline-start", Math.max(0, w.inset) + "px");
            f.marginBlockStart = Math.max(0, w.top) + "px";
            f.setProperty("shape-margin", Math.max(0, w.margin) + "px");
            if (w.shape === "oval") f.setProperty("shape-outside", "ellipse(50% 50%)");
            else if (w.shape === "contour" && w.image) { f.setProperty("shape-outside", `url("${String(w.image).replace(/["\\]/g, "")}")`); f.setProperty("shape-image-threshold", "0.2"); }
            else f.setProperty("shape-outside", "border-box");
            return el;
          }, { key: "w" + JSON.stringify(w), side: -1, ignoreSelection: true, stopEvent: () => true }));
        }
        for (const sp of spacers) {
          if (sp.pos < 0 || sp.pos > st.doc.content.size) continue;
          ds.push(Decoration.widget(sp.pos, () => {
            const el = document.createElement("span");
            el.className = "sticker-gap"; el.setAttribute("aria-hidden", "true"); el.contentEditable = "false";
            el.style.width = Math.round(sp.width) + "px";
            return el;
          }, { key: `g${sp.pos}:${Math.round(sp.width)}`, side: -1, ignoreSelection: true, stopEvent: () => true }));
        }
        return DecorationSet.create(st.doc, ds);
      },
    },
    view: (v) => {
      // text metrics change when a font arrives or the column changes width: the gaps are measured again
      let width = 0;
      const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { const w = v.dom.getBoundingClientRect().width; if (Math.abs(w - width) > 0.5) { width = w; soon(); } }) : null;
      ro?.observe(v.dom);
      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
      fonts?.addEventListener?.("loadingdone", soon);
      return { destroy() { ro?.disconnect(); fonts?.removeEventListener?.("loadingdone", soon); cancelAnimationFrame(timer); } };
    },
  });
  return {
    plugin,
    set(list: (Wrap | Gap)[]) {
      const next = JSON.stringify(list);
      if (next === json) return;
      json = next;
      wraps = list.filter((w): w is Wrap => (w as Gap).kind !== "gap");
      gaps = list.filter((w): w is Gap => (w as Gap).kind === "gap");
      if (gaps.length || spacers.length) settle(); else redraw();
    },
  };
}
