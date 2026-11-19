// SPDX-License-Identifier: Apache-2.0
/**
 * The ways in that plugins register (ADR 0094): typing shortcuts, paste rules, files and keys. Files go to the plugin that accepts
 * their type; when several do, the person chooses once (for this session), and the Owner's default comes first when there is one.
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { keydownHandler } from "prosemirror-keymap";
import type { ElementDef, ElementInit } from "@nuah/editor-api";
import type { CardHost } from "./card";
import { commandsFor, insertElement } from "./commands";

const extOf = (name: string) => (name.includes(".") ? "." + name.split(".").pop()!.toLowerCase() : "");
const accepts = (list: string[] | undefined, f: File) => !!list?.some((a) => a.toLowerCase() === extOf(f.name) || (f.type && a.toLowerCase() === f.type.toLowerCase()));

/** The loaded definitions, in the order their plugins are listed (that order decides who keeps a clashing key). */
function defs(host: CardHost): ElementDef[] {
  const order = [...new Set(host.list.kinds.map((k) => k.plugin))];
  return host.elements.all().sort((a, b) => order.indexOf(a.plugin) - order.indexOf(b.plugin)).map((d) => d.def);
}

/** Files dropped or pasted at a place: each to the element that accepts it. */
export function fileRouter(host: CardHost, view: () => EditorView) {
  const chosen = new Map<string, string>();
  const pick = (f: File, kinds: string[]): Promise<string | null> => {
    const key = f.type || extOf(f.name);
    const remembered = chosen.get(key);
    if (remembered && kinds.includes(remembered)) return Promise.resolve(remembered);
    const owner = host.list.kinds.find((k) => kinds.includes(k.kind) && k.default)?.kind;
    if (kinds.length === 1) return Promise.resolve(kinds[0]!);
    if (owner) return Promise.resolve(owner);
    const lang = host.hooks.lang as "en";
    return new Promise((resolve) => {
      host.hooks.ui.menu(0, 0, kinds.map((k) => {
        const d = host.list.kinds.find((x) => x.kind === k)!;
        return { label: d.label[lang] ?? d.label.en, onclick: () => { chosen.set(key, k); resolve(k); } };
      }));
    });
  };
  return async (files: File[], pos?: number): Promise<number> => {
    let made = 0;
    for (const f of files) {
      const kinds = host.list.kinds.filter((k) => accepts(k.accepts, f)).map((k) => k.kind);
      if (kinds.length === 0) continue;
      const kind = await pick(f, kinds);
      if (!kind) continue;
      await host.loader.loadFor(new Set([kind]));
      const rule = host.elements.get(kind)?.def.ways?.files?.find((r) => accepts(r.accept, f));
      const init: ElementInit | null = rule ? await rule.make(f) : {};
      if (init === null) continue;
      insertElement(view(), host, kind, init, pos);
      made++;
    }
    return made;
  };
}

export function waysPlugin(host: CardHost, files: (fs: File[], pos?: number) => Promise<number>) {
  let keys: ((view: EditorView, e: KeyboardEvent) => boolean) | null = null;
  const warned = new Set<string>();
  const refresh = () => {
    const bindings: Record<string, (s: unknown, d: unknown, v?: EditorView) => boolean> = {};
    const owner = new Map<string, string>();
    for (const d of defs(host)) {
      for (const [k, run] of Object.entries(d.ways?.keys ?? {})) {
        if (owner.has(k)) {
          if (!warned.has(k)) { warned.add(k); console.warn(`editor: ${k} is claimed by ${owner.get(k)} and ${d.kind}; ${owner.get(k)} keeps it`); }
          continue;
        }
        owner.set(k, d.kind);
        bindings[k] = (_s, _d, v) => !!v && run(commandsFor(v, host));
      }
    }
    keys = keydownHandler(bindings as never);
  };
  const shortcut = (view: EditorView): boolean => {
    const { $from, empty } = view.state.selection;
    if (!empty || !$from.parent.isTextblock || $from.parentOffset !== $from.parent.content.size) return false;
    const text = $from.parent.textContent;
    for (const d of defs(host)) for (const s of d.ways?.shortcuts ?? []) {
      if (text !== s.match) continue;
      const from = $from.before(), to = $from.after();
      view.dispatch(view.state.tr.replaceWith(from, to, view.state.schema.nodes.paragraph?.create() ?? []));
      insertElement(view, host, d.kind, s.init?.() ?? {}, from);
      return true;
    }
    return false;
  };
  const plugin = new Plugin({
    key: new PluginKey("nuahWays"),
    props: {
      handleKeyDown(view, e) {
        if ((e.key === "Enter" || e.key === " ") && !e.shiftKey && shortcut(view)) return true;
        return keys ? keys(view, e) : false;
      },
      handlePaste(view, e) {
        const fs = [...(e.clipboardData?.files ?? [])];
        if (fs.length) { void files(fs); return true; }
        const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
        if (!text) return false;
        for (const d of defs(host)) for (const r of d.ways?.paste ?? []) {
          const isUrl = /^https?:\/\/\S+$/.test(text);
          if ((r.text && r.text.test(text)) || (r.url && isUrl && r.url.test(text))) {
            void Promise.resolve(r.make(text)).then((init) => { if (init) insertElement(view, host, d.kind, init); });
            return true;
          }
        }
        return false;
      },
      handleDrop(view, e) {
        const fs = [...((e as DragEvent).dataTransfer?.files ?? [])];
        if (!fs.length) return false;
        const at = view.posAtCoords({ left: (e as DragEvent).clientX, top: (e as DragEvent).clientY })?.pos;
        void files(fs, at);
        return true;
      },
    },
  });
  refresh();
  return { plugin, refresh };
}
