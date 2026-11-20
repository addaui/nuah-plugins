// SPDX-License-Identifier: Apache-2.0
/**
 * The slash menu (ADR 0046, 0094): "/" in text opens it; what follows filters across every group. Each card kind an enabled plugin
 * brings is an item from its declaration (its module loads when chosen); plugins add more items, content elements' among them.
 */
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { CardHost } from "./card";
import { commandsFor, insertElement } from "./commands";
import { groupLabel } from "./messages";

export interface SlashItem { id: string; label: string; group: string; icon?: string; keywords: string; run: (view: EditorView, at: number) => void | Promise<void> }
interface Open { from: number; to: number; query: string }

const key = new PluginKey<Open | null>("nuahSlash");
const TRIGGER = /(?:^|\s)\/([\p{L}\p{N}_-]*)$/u;

function find(state: EditorState): Open | null {
  const sel = state.selection;
  if (!sel.empty || !sel.$from.parent.isTextblock) return null;
  const $f = sel.$from, before = $f.parent.textBetween(0, $f.parentOffset, "\0", "\0");
  const m = TRIGGER.exec(before);
  if (!m) return null;
  return { from: sel.from - m[1]!.length - 1, to: sel.from, query: m[1]! };
}

export function slashItems(host: CardHost): SlashItem[] {
  const lang = host.hooks.lang as "en" | "ar";
  const items: SlashItem[] = [];
  for (const k of host.list.kinds) {
    if (k.shape !== "card" || k.placement === "floating") continue;
    items.push({
      id: k.kind, label: k.label[lang] ?? k.label.en, group: k.group ?? "", icon: k.icon, keywords: `${k.keywords ?? ""} ${k.label.en} ${k.kind}`.toLowerCase(),
      run: async (view, at) => {
        await host.loader.loadFor(new Set([k.kind]));
        const s = host.elements.get(k.kind)?.def.ways?.slash?.find((x) => !x.apply && !x.id);
        const init = s?.init ? await s.init() : {};
        if (init !== null) insertElement(view, host, k.kind, init ?? {}, at);
      },
    });
  }
  for (const { def } of host.elements.all()) {
    for (const [i, s] of (def.ways?.slash ?? []).entries()) {
      if (!s.apply && !s.id) continue; // the kind's own item is above
      items.push({
        id: `${def.kind}#${s.id ?? i}`, label: s.label[lang] ?? s.label.en, group: s.group ?? "", icon: s.icon, keywords: `${s.keywords ?? ""} ${s.label.en}`.toLowerCase(),
        run: async (view, at) => {
          if (s.apply) s.apply(commandsFor(view, host, at));
          else { const init = s.init ? await s.init() : {}; if (init !== null) insertElement(view, host, def.kind, init ?? {}, at); }
        },
      });
    }
  }
  return items;
}

/** How well an item fits what was typed (lower is better): the label itself, its start, a word of it, inside it, then a keyword; null when it does not fit. */
function fit(i: SlashItem, q: string): number | null {
  if (!q) return 0;
  const l = i.label.toLowerCase();
  if (l === q) return 0;
  if (l.startsWith(q)) return 1;
  if (l.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  if (l.includes(q)) return 3;
  return i.keywords.includes(q) ? 4 : null;
}

/** What fits the query, best first, so Enter picks it. A group stays together and goes where its best item goes; with nothing typed the order is the plugins' own, each group once. */
export function filterItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.toLowerCase();
  const found = items.map((i, at) => ({ i, at, f: fit(i, q) })).filter((x): x is { i: SlashItem; at: number; f: number } => x.f !== null);
  const best = new Map<string, { f: number; at: number }>();
  for (const x of found) { const b = best.get(x.i.group); best.set(x.i.group, { f: Math.min(x.f, b?.f ?? x.f), at: b?.at ?? x.at }); }
  return found
    .sort((a, b) => {
      const ga = best.get(a.i.group)!, gb = best.get(b.i.group)!;
      return ga.f - gb.f || ga.at - gb.at || (a.i.group === b.i.group ? a.f - b.f || a.at - b.at : a.at - b.at);
    })
    .map((x) => x.i);
}

export function slashPlugin(host: CardHost): Plugin {
  let index = 0, dismissed: number | null = null;
  let shown: SlashItem[] = [];
  const choose = (view: EditorView, open: Open, item: SlashItem | undefined) => {
    if (!item) return;
    view.dispatch(view.state.tr.delete(open.from, open.to));
    void item.run(view, open.from);
  };
  return new Plugin<Open | null>({
    key,
    state: { init: () => null, apply: (_tr, _v, _o, state) => { const o = find(state); if (!o) dismissed = null; return o && o.from !== dismissed ? o : null; } },
    props: {
      handleKeyDown(view, e) {
        const open = key.getState(view.state);
        if (!open || shown.length === 0) return false;
        if (e.key === "ArrowDown") { index = (index + 1) % shown.length; view.dispatch(view.state.tr); return true; }
        if (e.key === "ArrowUp") { index = (index - 1 + shown.length) % shown.length; view.dispatch(view.state.tr); return true; }
        if (e.key === "Enter" || e.key === "Tab") { choose(view, open, shown[index]); return true; }
        if (e.key === "Escape") { dismissed = open.from; view.dispatch(view.state.tr); return true; }
        return false;
      },
    },
    view(view) {
      let menu: HTMLElement | null = null;
      const close = () => { menu?.remove(); menu = null; shown = []; index = 0; };
      return {
        update(v) {
          const open = key.getState(v.state);
          if (!open) { close(); return; }
          const items = filterItems(slashItems(host), open.query);
          if (items.length === 0) { close(); return; }
          if (items.map((i) => i.id).join() !== shown.map((i) => i.id).join()) index = 0;
          shown = items;
          menu ??= document.body.appendChild(Object.assign(document.createElement("div"), { className: "nuah-slash" }));
          menu.setAttribute("role", "listbox");
          menu.replaceChildren();
          let group: string | null = null;
          items.forEach((it, i) => {
            if (it.group !== group) { group = it.group; if (group) menu!.append(Object.assign(document.createElement("div"), { className: "nuah-slash-group", textContent: groupLabel(host.hooks.lang, group) })); }
            const row = document.createElement("div");
            row.className = "nuah-slash-item" + (i === index ? " is-active" : "");
            row.setAttribute("role", "option");
            row.dataset.id = it.id;
            const ico = document.createElement("span");
            ico.className = "nuah-slash-ico";
            const icon = it.icon ? host.hooks.ui.icon(it.icon) : null;
            if (icon) ico.append(icon);
            const label = document.createElement("span");
            label.className = "nuah-slash-label";
            label.textContent = it.label;
            row.append(ico, label);
            row.addEventListener("mousedown", (e) => { e.preventDefault(); choose(v, open, it); });
            menu!.append(row);
          });
          try { const c = v.coordsAtPos(open.from); Object.assign(menu.style, { position: "fixed", left: `${c.left}px`, top: `${c.bottom + 4}px` }); } catch { /* jsdom has no layout */ }
          void view;
        },
        destroy: close,
      };
    },
  });
}
