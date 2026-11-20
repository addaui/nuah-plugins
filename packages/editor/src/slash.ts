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

/** The usual order of groups when nothing else decides: text first. Groups not named here follow, in the plugins' order. */
const GROUPS = ["text", "list", "layout", "media", "code", "reference"];
const groupRank = (g: string) => { const i = GROUPS.indexOf(g); return i < 0 ? GROUPS.length : i; };

/**
 * What fits the query, best first, so Enter picks it. A group stays together and is placed by its best match, then by how often
 * this person picked its items (`used`, by item id), then by the usual order; inside a group the same.
 */
export function filterItems(items: SlashItem[], query: string, used: Record<string, number> = {}): SlashItem[] {
  const q = query.toLowerCase();
  const found = items.map((i, at) => ({ i, at, f: fit(i, q), u: used[i.id] ?? 0 })).filter((x): x is { i: SlashItem; at: number; f: number; u: number } => x.f !== null);
  const best = new Map<string, { f: number; u: number; at: number }>();
  for (const x of found) { const b = best.get(x.i.group); best.set(x.i.group, { f: Math.min(x.f, b?.f ?? x.f), u: Math.max(x.u, b?.u ?? 0), at: b?.at ?? x.at }); }
  return found
    .sort((a, b) => {
      const ga = best.get(a.i.group)!, gb = best.get(b.i.group)!;
      if (a.i.group !== b.i.group) return ga.f - gb.f || gb.u - ga.u || groupRank(a.i.group) - groupRank(b.i.group) || ga.at - gb.at;
      return a.f - b.f || b.u - a.u || a.at - b.at;
    })
    .map((x) => x.i);
}

const USED = "nuah.editor.slash.used";
/** How often this person picked each item, kept on this device only (a convenience, not shared). */
function readUsed(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(USED) ?? "{}") as Record<string, number>; } catch { return {}; }
}
function noteUsed(id: string) {
  try { const u = readUsed(); u[id] = (u[id] ?? 0) + 1; localStorage.setItem(USED, JSON.stringify(u)); } catch { /* nothing kept */ }
}

export function slashPlugin(host: CardHost): Plugin {
  let index = 0, dismissed: number | null = null;
  let shown: SlashItem[] = [];
  const choose = (view: EditorView, open: Open, item: SlashItem | undefined) => {
    if (!item) return;
    noteUsed(item.id);
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
          const items = filterItems(slashItems(host), open.query, readUsed());
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
            if (i === index) queueMicrotask(() => row.scrollIntoView?.({ block: "nearest" }));
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
          try {
            const c = v.coordsAtPos(open.from);
            const line = v.domAtPos(open.from).node;
            const rtl = getComputedStyle((line.nodeType === 1 ? line : line.parentElement) as Element).direction === "rtl";
            menu.style.position = "fixed";
            const at = placeMenu(c, { width: menu.offsetWidth, height: menu.offsetHeight }, { width: innerWidth, height: innerHeight }, rtl);
            Object.assign(menu.style, { left: `${at.left}px`, top: `${at.top}px` });
          } catch { /* jsdom has no layout */ }
          void view;
        },
        destroy: close,
      };
    },
  });
}

/** Where the menu goes: under the caret, starting where the line starts (its right edge at the caret in right-to-left text), above the line when there is no room below, never off the screen. */
export function placeMenu(caret: { left: number; right: number; top: number; bottom: number }, size: { width: number; height: number }, screen: { width: number; height: number }, rtl: boolean): { left: number; top: number } {
  const gap = 4, margin = 8;
  const left = Math.max(margin, Math.min(rtl ? caret.right - size.width : caret.left, screen.width - size.width - margin));
  const below = caret.bottom + gap;
  const top = below + size.height > screen.height - margin && caret.top - gap - size.height >= margin ? caret.top - gap - size.height : below;
  return { left, top };
}
