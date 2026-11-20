// SPDX-License-Identifier: Apache-2.0
/**
 * The surfaces around elements (ADR 0094, 0046, 0073): who opens a kind ("Open with"), turning one kind into another, the context the
 * Element tab shows (with pinned options first), the right-click menu of a block, and the margin beside each block.
 */
import { NodeSelection, Plugin, PluginKey, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PmNode } from "prosemirror-model";
import type { BlockRef, MenuItem } from "@nuah/editor-api";
import type { OptionDecl } from "@nuah/editor-core";
import type { CardHost } from "./card";
import { viewRaw } from "./card";
import { commandsFor, insertElement } from "./commands";
import { msg } from "./messages";
import { stateFor, type StateType } from "./state";

/** this element's choice, else the person's (a preference), else the Owner's default, else the plugin that declares the kind. */
export function openerFor(host: CardHost, chosen: Map<string, string>, kind: string, blockId?: string): string | undefined {
  const k = host.list.kinds.find((x) => x.kind === kind);
  if (!k) return undefined;
  const can = (p: unknown): p is string => typeof p === "string" && k.openers.includes(p);
  const mine = blockId ? chosen.get(blockId) : undefined;
  if (can(mine)) return mine;
  const person = host.hooks.pref?.(`editor.opener.${kind}`);
  if (can(person)) return person;
  if (can(k.default)) return k.default;
  return k.plugin;
}

const refOf = (n: PmNode): BlockRef => ({ blockId: n.attrs.blockId, type: n.type.name, kind: typeof n.attrs.kind === "string" && n.attrs.kind ? n.attrs.kind : null, attrs: { ...n.attrs }, text: n.textContent });
export const findBlock = (state: EditorState, blockId: string): { node: PmNode; pos: number } | null => {
  let out: { node: PmNode; pos: number } | null = null;
  state.doc.descendants((node, pos) => { if (!out && node.attrs.blockId === blockId) out = { node, pos }; return !out; });
  return out;
};

/** The options a node shows: an element's (from its Opener's definition), or the content element's that declares its node type. */
function optionsOf(host: CardHost, n: PmNode): OptionDecl[] {
  let opts: OptionDecl[] = [];
  if ((n.type.name === "element" || n.type.name === "elementInline") && n.attrs.kind) {
    const p = host.openerFor(n.attrs.kind, n.attrs.blockId);
    opts = (p && host.elements.defFor(n.attrs.kind, p)?.options) || [];
  } else {
    opts = host.elements.all().find((d) => d.def.nodes?.some((x) => x.id === n.type.name))?.def.options ?? [];
  }
  return [...opts.filter((o) => o.pinned), ...opts.filter((o) => !o.pinned)];
}

/** Reports the element the cursor is in (or that is selected), innermost first, to the Face's Element tab. */
export function contextPlugin(host: CardHost): Plugin {
  let last = "";
  return new Plugin({
    key: new PluginKey("nuahContext"),
    view: () => ({
      update(view) {
        if (!host.hooks.onContext) return;
        const sel = view.state.selection, chain: unknown[] = [];
        const push = (n: PmNode, pos: number) => chain.push({ node: n.type.name, pos, attrs: { ...n.attrs }, id: n.attrs.blockId ?? null, kind: n.attrs.kind || null, options: optionsOf(host, n) });
        const selected = sel instanceof NodeSelection;
        if (selected) push(sel.node, sel.from);
        for (let d = sel.$from.depth; d >= 1; d--) push(sel.$from.node(d), sel.$from.before(d));
        const key = JSON.stringify(chain);
        if (key === last) return;
        last = key;
        host.hooks.onContext(chain.length ? { chain, selected } : null);
      },
    }),
  });
}

/** Writes an option: an element's goes into its settings, a content node's into the attribute it names. */
export function setOption(view: EditorView, host: CardHost, blockId: string, id: string, value: unknown) {
  const b = findBlock(view.state, blockId);
  if (!b) return;
  const isEl = b.node.type.name === "element" || b.node.type.name === "elementInline";
  const attr = optionsOf(host, b.node).find((o) => o.id === id)?.attr ?? id;
  const attrs = isEl ? { ...b.node.attrs, data: { ...(b.node.attrs.data ?? {}), [id]: value } } : { ...b.node.attrs, [attr]: value };
  view.dispatch(view.state.tr.setNodeMarkup(b.pos, undefined, attrs));
}

/** Turns an element into another kind through its plugin's `convert.to`; the new element takes the old one's place. Returns its id. */
export async function turnInto(view: EditorView, host: CardHost, blockId: string, kind: string): Promise<string | null> {
  const card = host.cards.get(blockId), b = findBlock(view.state, blockId);
  if (!card || !b) return null;
  const opener = host.openerFor(b.node.attrs.kind, blockId);
  const step = opener ? host.elements.defFor(b.node.attrs.kind, opener)?.convert?.to?.find((t) => t.kind === kind) : undefined;
  const ctx = card.ctxNow();
  if (!step || !ctx) return null;
  const init = step.make(ctx);
  await host.loader.loadFor(new Set([kind]));
  const at = findBlock(view.state, blockId)!;
  view.dispatch(view.state.tr.delete(at.pos, at.pos + at.node.nodeSize));
  const decl = host.list.kinds.find((k) => k.kind === kind);
  const id = insertElement(view, host, kind, { data: init.data }, at.pos);
  if (init.fill && decl?.state && host.doc) { init.fill(stateFor(host.doc, id, decl.state as StateType, true).container); host.doc.commit(); }
  return id;
}

/** The right-click menu of a block: the kind's items, every plugin's items, Open with, Turn into, View raw data. */
export function menuFor(view: EditorView, host: CardHost, chosen: Map<string, string>, blockId: string): MenuItem[] {
  const b = findBlock(view.state, blockId);
  if (!b) return [];
  const lang = host.hooks.lang, ref = refOf(b.node), items: MenuItem[] = [];
  const card = host.cards.get(blockId), ctx = card?.ctxNow();
  const kind: string | null = ref.kind;
  if (kind && ctx) {
    const opener = host.openerFor(kind, blockId);
    const def = opener ? host.elements.defFor(kind, opener) : undefined;
    items.push(...(def?.ways?.menu?.(ctx) ?? []));
    const k = host.list.kinds.find((x) => x.kind === kind);
    if (k && k.openers.length > 1) items.push({ label: msg(lang, "openWith"), sub: k.openers.map((p) => ({ label: p, checked: p === opener, onclick: () => void host.openWith?.(blockId, p) })) });
    const to = def?.convert?.to ?? [];
    if (to.length) items.push({ label: msg(lang, "turnInto"), sub: to.map((t) => { const d = host.list.kinds.find((x) => x.kind === t.kind); return { label: d ? d.label[lang as "en"] ?? d.label.en : t.kind, onclick: () => void host.turnInto?.(blockId, t.kind) }; }) });
  }
  for (const m of host.elements.menus) items.push(...m.items(ref, commandsFor(view, host)));
  if (kind) items.push({ label: msg(lang, "viewRaw"), onclick: () => viewRaw(host, b.node) });
  return items;
}

/** The margin beside a block (ADR 0046): every plugin's actions with their counts, then the handle. Logical sides, so it mirrors in Arabic. */
export function gutterFor(view: EditorView, host: CardHost, chosen: Map<string, string>, blockId: string): HTMLElement | null {
  const b = findBlock(view.state, blockId);
  if (!b) return null;
  const ref = refOf(b.node), lang = host.hooks.lang;
  const g = document.createElement("div");
  g.className = "nuah-gutter";
  g.dir = lang === "ar" ? "rtl" : "ltr";
  g.contentEditable = "false";
  g.style.insetInlineStart = "calc(-1 * var(--nuah-gutter-width, 4.5rem))";
  for (const { action } of host.elements.margins) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nuah-gutter-action";
    btn.dataset.action = action.id;
    btn.setAttribute("aria-label", action.label[lang as "en"] ?? action.label.en);
    const icon = host.hooks.ui.icon(action.icon);
    if (icon) btn.append(icon);
    const n = action.count?.(ref) ?? 0;
    if (n) btn.append(Object.assign(document.createElement("span"), { className: "nuah-gutter-count", textContent: String(n) }));
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => action.run(ref, btn));
    g.append(btn);
  }
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "nuah-gutter-handle";
  handle.draggable = true;
  const hi = host.hooks.ui.icon("grip");
  if (hi) handle.append(hi);
  handle.addEventListener("mousedown", () => { const at = findBlock(view.state, blockId); if (at) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at.pos))); });
  handle.addEventListener("click", (e) => { const r = handle.getBoundingClientRect(); host.hooks.ui.menu(r.left, r.bottom, menuFor(view, host, chosen, blockId)); e.preventDefault(); });
  g.append(handle);
  return g;
}

/** Shows the margin of the top-level block under the mouse, and opens a block's menu on right click. */
export function marginPlugin(host: CardHost, chosen: Map<string, string>): Plugin {
  return new Plugin({
    key: new PluginKey("nuahMargin"),
    props: {
      handleDOMEvents: {
        contextmenu(view, e) {
          const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
          if (!at) return false;
          const $p = view.state.doc.resolve(at.inside >= 0 ? at.inside : at.pos);
          const n = $p.depth >= 1 ? $p.node(1) : view.state.doc.nodeAt(at.inside);
          if (!n?.attrs.blockId) return false;
          e.preventDefault();
          host.hooks.ui.menu(e.clientX, e.clientY, menuFor(view, host, chosen, n.attrs.blockId));
          return true;
        },
      },
    },
    view(view) {
      let shown: { el: HTMLElement; id: string } | null = null;
      const move = (e: MouseEvent) => {
        const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
        if (!at) return;
        const $p = view.state.doc.resolve(at.pos);
        const top = $p.depth >= 1 ? $p.before(1) : at.inside;
        const n = top >= 0 ? view.state.doc.nodeAt(top) : null;
        const id = n?.attrs.blockId;
        if (!id || shown?.id === id) return;
        shown?.el.remove();
        const g = gutterFor(view, host, chosen, id);
        const dom = view.nodeDOM(top) as HTMLElement | null;
        if (!g || !dom) { shown = null; return; }
        g.style.position = "absolute";
        g.style.top = `${dom.offsetTop}px`;
        view.dom.parentElement?.append(g);
        shown = { el: g, id };
      };
      view.dom.addEventListener("mousemove", move);
      return { destroy() { view.dom.removeEventListener("mousemove", move); shown?.el.remove(); } };
    },
  });
}
