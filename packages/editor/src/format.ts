// SPDX-License-Identifier: Apache-2.0
/**
 * Formatting (ADR 0097): the Format items plugins and the Face add, drawn by the host in three places. The Format bar goes into a
 * place the Face gives; the Selection bar appears over selected text with the basic items, when the person switched it on; the
 * Element tab asks the handle for the items of a whole element and applies one to all of its text.
 */
import { Plugin, Selection, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { Mapping } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";
import type { FormatItem } from "@nuah/editor-api";
import type { CardHost } from "./card";
import { commandsFor } from "./commands";

/** Every Format item: the plugins' in the order they loaded, then the Face's. */
export function formatItems(host: CardHost): FormatItem[] {
  return [...host.elements.formats.map((f) => f.item), ...(host.hooks.format ?? [])];
}

const labelOf = (i: FormatItem, lang: string) => (lang === "ar" && i.label.ar) || i.label.en;
const safe = <T>(f: () => T, or: T): T => { try { return f(); } catch { return or; } };

/** Draws items as a row of buttons, a thin line between groups; each button keeps the editor's selection and runs its item. */
function drawItems(el: HTMLElement, items: FormatItem[], view: EditorView, host: CardHost) {
  el.replaceChildren();
  let group: string | undefined | null = null;
  for (const it of items) {
    if (group !== null && it.group !== group) el.append(Object.assign(document.createElement("span"), { className: "nuah-format-sep" }));
    group = it.group;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nuah-format-item";
    b.dataset.format = it.id;
    const label = labelOf(it, host.hooks.lang);
    b.title = label;
    b.setAttribute("aria-label", label);
    const icon = it.icon ? host.hooks.ui.icon(it.icon) : null;
    if (icon) b.append(icon); else b.textContent = label;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => { if (!view.editable) return; safe(() => void it.run(commandsFor(view, host)), undefined); view.focus(); });
    el.append(b);
  }
  if (!el.getAttribute("role")) { el.setAttribute("role", "toolbar"); el.setAttribute("aria-label", host.hooks.lang === "ar" ? "التنسيق" : "Formatting"); }
}

/** Marks which buttons are on for the current selection. */
function syncItems(el: HTMLElement, items: FormatItem[], view: EditorView, host: CardHost) {
  const c = commandsFor(view, host);
  const buttons = new Map([...el.querySelectorAll<HTMLElement>("[data-format]")].map((b) => [b.dataset.format!, b]));
  for (const it of items) {
    const b = buttons.get(it.id);
    if (!b) continue;
    const on = !!it.isActive && safe(() => it.isActive!(c), false);
    b.setAttribute("aria-pressed", String(on));
    b.classList.toggle("is-on", on);
  }
}

export function formatPlugin(host: CardHost): Plugin {
  return new Plugin({
    view(view) {
      const bar = host.hooks.formatBar ?? null;
      const sel = document.createElement("div");
      sel.className = "nuah-selection-bar";
      sel.hidden = true;
      document.body.append(sel);
      let drawn = "", drawnSel = "";
      const update = () => {
        const items = formatItems(host);
        if (bar) {
          const key = items.map((i) => i.id).join();
          if (key !== drawn) { drawItems(bar, items, view, host); drawn = key; }
          bar.hidden = !view.editable || items.length === 0;
          syncItems(bar, items, view, host);
        }
        // the Selection bar: only basic items, only over selected text, only when the person switched it on
        const basic = items.filter((i) => i.basic);
        const s = view.state.selection;
        const on = !!host.hooks.pref?.("editor.selection_bar") && view.editable && s instanceof TextSelection && !s.empty && basic.length > 0;
        if (!on) { sel.hidden = true; sel.classList.remove("is-shown"); return; }
        const key = basic.map((i) => i.id).join();
        if (key !== drawnSel) { drawItems(sel, basic, view, host); drawnSel = key; }
        syncItems(sel, basic, view, host);
        sel.hidden = false;
        safe(() => {
          const a = view.coordsAtPos(s.from), b = view.coordsAtPos(s.to);
          const left = Math.max(8, Math.min((a.left + b.right) / 2 - sel.offsetWidth / 2, innerWidth - sel.offsetWidth - 8));
          const top = a.top - sel.offsetHeight - 8 >= 8 ? a.top - sel.offsetHeight - 8 : b.bottom + 8;
          Object.assign(sel.style, { position: "fixed", left: `${left}px`, top: `${top}px` });
        }, undefined);
        requestAnimationFrame(() => sel.classList.add("is-shown"));
      };
      // it is placed against the window: it goes when the page scrolls or the editor loses focus, and comes back with the next selection
      const hide = () => { sel.hidden = true; sel.classList.remove("is-shown"); };
      const onBlur = (e: FocusEvent) => { if (!sel.contains(e.relatedTarget as Node | null)) hide(); };
      document.addEventListener("scroll", hide, true);
      view.dom.addEventListener("blur", onBlur);
      update();
      return { update, destroy: () => { document.removeEventListener("scroll", hide, true); view.dom.removeEventListener("blur", onBlur); sel.remove(); bar?.replaceChildren(); } };
    },
  });
}

/** The items for a whole element (the Element tab), each with whether it is on for all of the element's text. */
export function formatOf(view: EditorView, host: CardHost, blockId: string): { id: string; label: string; icon?: string; group?: string; groupLabel?: string; attr?: string; applies: string; active: boolean }[] {
  if (!blockText(view.state, blockId)) return [];
  const c = commandsFor(shimAt(view, blockId) as never, host);
  const items = formatItems(host).filter((i) => i.applies !== "insert");
  const lang = host.hooks.lang;
  const named = new Map<string, string>();
  for (const i of items) if (i.group && i.groupLabel && !named.has(i.group)) named.set(i.group, (lang === "ar" && i.groupLabel.ar) || i.groupLabel.en);
  return items.map((i) => ({ id: i.id, label: labelOf(i, lang), icon: i.icon, group: i.group, groupLabel: i.group ? named.get(i.group) : undefined, attr: i.attr, applies: i.applies ?? "both", active: !!i.isActive && safe(() => i.isActive!(c), false) }));
}

/**
 * Runs one item over all of an element's text (nothing on a page that cannot be written). The person's selection is mapped
 * through what the item changed, so it stays on the same text; an item that finishes later applies to the document as it is then.
 */
export async function applyFormat(view: EditorView, host: CardHost, blockId: string, id: string): Promise<void> {
  const item = formatItems(host).find((i) => i.id === id && i.applies !== "insert");
  if (!item || !view.editable || !blockText(view.state, blockId)) return;
  const before = view.state.selection;
  const shim = shimAt(view, blockId);
  try { await item.run(commandsFor(shim as never, host)); } catch { /* the item's own failure leaves the page as it was */ }
  const s = view.state;
  // changes others made meanwhile are not in the shim's mapping: if the old selection no longer fits, the nearest place will do
  const back = safe(() => before.map(s.doc, shim.mapping), null) ?? Selection.near(s.doc.resolve(Math.min(before.from, s.doc.content.size)));
  view.dispatch(s.tr.setSelection(back));
}

/** The range of a block: from the start to the end of its content (all of a container's text, a callout's or a list's). */
function blockText(state: EditorState, blockId: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.doc.descendants((n, pos) => {
    if (found) return false;
    if (n.attrs.blockId !== blockId) return true;
    found = { from: pos + 1, to: pos + n.nodeSize - 1 };
    return false;
  });
  return found;
}

/**
 * A view whose selection is the element's whole text, read afresh from the real view each time (so an item that finishes later
 * works on the document as it is then); what it dispatches goes to the real view, and its mapping is kept for the person's selection.
 */
function shimAt(view: EditorView, blockId: string) {
  const mapping = new Mapping();
  const at = () => {
    const s = view.state, r = blockText(s, blockId);
    return r ? s.apply(s.tr.setSelection(TextSelection.between(s.doc.resolve(r.from), s.doc.resolve(r.to)))) : s;
  };
  return {
    mapping,
    get state() { return at(); },
    get editable() { return view.editable; },
    dispatch(tr: Transaction) { if (!view.editable) return; view.dispatch(tr); mapping.appendMapping(tr.mapping); },
    get dom() { return view.dom; },
    coordsAtPos: (p: number) => view.coordsAtPos(p),
    domAtPos: (p: number) => view.domAtPos(p),
    focus: () => view.focus(),
  };
}
