// SPDX-License-Identifier: Apache-2.0
/**
 * Formatting (ADR 0097): the Format items plugins and the Face add, drawn by the host in three places. The Format bar goes into a
 * place the Face gives; the Selection bar appears over selected text with the basic items, when the person switched it on; the
 * Element tab asks the handle for the items of a whole element and applies one to all of its text.
 */
import { Plugin, TextSelection, type EditorState } from "prosemirror-state";
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
    b.addEventListener("click", () => { safe(() => it.run(commandsFor(view, host)), undefined); view.focus(); });
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
      update();
      return { update, destroy: () => { sel.remove(); bar?.replaceChildren(); } };
    },
  });
}

/** The items for a whole element (the Element tab), each with whether it is on for all of the element's text. */
export function formatOf(view: EditorView, host: CardHost, blockId: string): { id: string; label: string; icon?: string; group?: string; applies: string; active: boolean }[] {
  const range = blockText(view.state, blockId);
  if (!range) return [];
  const shim = shimAt(view, range);
  const c = commandsFor(shim as never, host);
  return formatItems(host).map((i) => ({ id: i.id, label: labelOf(i, host.hooks.lang), icon: i.icon, group: i.group, applies: i.applies ?? "both", active: !!i.isActive && safe(() => i.isActive!(c), false) }));
}

/** Runs one item over all of an element's text; the person's cursor stays where it was. */
export function applyFormat(view: EditorView, host: CardHost, blockId: string, id: string): void {
  const item = formatItems(host).find((i) => i.id === id);
  const range = blockText(view.state, blockId);
  if (!item || !range) return;
  const before = view.state.selection;
  safe(() => item.run(commandsFor(shimAt(view, range) as never, host)), undefined);
  const s = view.state;
  view.dispatch(s.tr.setSelection(before.map(s.doc, s.tr.mapping)));
}

/** The text of a block: from the start to the end of its content (the first textblock inside, for a container like a callout). */
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

/** A view whose selection is the element's whole text: commands read and write through it, changes go to the real view. */
function shimAt(view: EditorView, range: { from: number; to: number }) {
  let state = view.state.apply(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(range.from), view.state.doc.resolve(range.to))));
  return {
    get state() { return state; },
    dispatch(tr: import("prosemirror-state").Transaction) { view.dispatch(tr); state = state.apply(tr); },
    get dom() { return view.dom; },
    coordsAtPos: (p: number) => view.coordsAtPos(p),
    domAtPos: (p: number) => view.domAtPos(p),
    focus: () => view.focus(),
  };
}
