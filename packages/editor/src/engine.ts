// SPDX-License-Identifier: Apache-2.0
/**
 * The engine (ADR 0062, 0094): ProseMirror's libraries, bound to the page's Live document through loro-prosemirror (ADR 0093).
 * Undo is the person's own, from Loro. Every block a plugin marks `ids`, and every element, carries a stable id (ADR 0043).
 */
import { EditorState, Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet, type NodeViewConstructor } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import type { Schema, Node as PmNode } from "prosemirror-model";
import { UndoManager, type LoroDoc } from "loro-crdt";
import { LoroSyncPlugin, LoroUndoPlugin, LoroEphemeralCursorPlugin, undo as loroUndo, redo as loroRedo, type CursorEphemeralStore } from "loro-prosemirror";
import type { Registry } from "@nuah/editor-core";
import { buildSchema, outgrows, scanJson, scanLoro } from "./schema";
import { ELEMENT_TYPES } from "./nodes";

export interface Live { doc: LoroDoc; ephemeral?: CursorEphemeralStore; user?: { name: string; color: string } }
export interface EngineOptions {
  place: HTMLElement;
  registry: Registry;
  live?: Live;
  /** The document as JSON, when there is no Live document (a read-only copy, the shared-page reader). */
  content?: unknown;
  editable?: boolean;
  /** More ProseMirror plugins (the host's surfaces, plugins' extras), before the base keymap. */
  plugins?: (schema: Schema) => Plugin[];
  nodeViews?: Record<string, NodeViewConstructor>;
}
export interface Engine {
  readonly view: EditorView;
  json(): unknown;
  text(): string;
  undo(): boolean;
  redo(): boolean;
  setEditable(on: boolean): void;
  destroy(): void;
}

export const newBlockId = () => {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return "b" + Array.from(a, (x) => (x % 36).toString(36)).join("");
};

/** Gives every block that carries ids one, and a new one to a copy that repeats an id (the first keeps it). Placeholders are never touched. */
function blockIds(idTypes: Set<string>) {
  return new Plugin({
    key: new PluginKey("nuahBlockId"),
    appendTransaction(trs, _old, state) {
      if (!trs.some((t) => t.docChanged)) return null;
      const seen = new Set<string>(), tr = state.tr;
      let changed = false;
      state.doc.descendants((node, pos) => {
        if (!idTypes.has(node.type.name)) return;
        const id = node.attrs.blockId;
        if (!id || seen.has(id)) { tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: newBlockId() }); changed = true; } else seen.add(id);
      });
      return changed ? tr.setMeta("addToHistory", false) : null;
    },
  });
}

/** A text block with no letter yet (empty, or only a "/" being typed) takes the page's direction; `dir=auto` has nothing to read in it. */
const blockDir = new Plugin({
  key: new PluginKey("nuahBlockDir"),
  props: {
    decorations(state) {
      const page = document.documentElement.dir === "rtl" ? "rtl" : "ltr", out: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        if (node.isTextblock && !/\p{L}/u.test(node.textContent)) out.push(Decoration.node(pos, pos + node.nodeSize, { dir: page }));
      });
      return DecorationSet.create(state.doc, out);
    },
  },
});

/** Another person's cursor in text this copy has not received yet is left out: the binding throws drawing it (ADR 0093). */
function drawableCursors(store: CursorEphemeralStore, doc: LoroDoc): CursorEphemeralStore {
  const here = (c: unknown) => { if (!c) return true; try { return !!doc.getCursorPos(c as never); } catch { return false; } };
  return new Proxy(store, {
    get(t, k) {
      if (k === "getAll") return () => Object.fromEntries(Object.entries(t.getAll()).filter(([, st]: [string, any]) => here(st.anchor) && here(st.focus)));
      const v = (t as any)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

export function createEngine(o: EngineOptions): Engine {
  const idTypes = new Set([...o.registry.idTypes(), ...ELEMENT_TYPES]);
  let editable = o.editable ?? true;
  const found = () => (o.live ? scanLoro(o.live.doc) : scanJson(o.content ?? null));
  const stateFor = (schema: Schema): EditorState => {
    const plugins: Plugin[] = [...(o.plugins?.(schema) ?? []), blockIds(idTypes), blockDir, dropCursor(), gapCursor()];
    if (o.live) {
      // an element's full view keeps its own undo: what it commits as `el:<id>` stays out of the page's (ADR 0094)
      plugins.unshift(LoroSyncPlugin({ doc: o.live.doc as never }), LoroUndoPlugin({ doc: o.live.doc as never, undoManager: new UndoManager(o.live.doc, { excludeOriginPrefixes: ["el:"] }) as never }));
      if (o.live.ephemeral) plugins.push(LoroEphemeralCursorPlugin(drawableCursors(o.live.ephemeral, o.live.doc), { user: o.live.user }) as never);
      plugins.push(keymap({ "Mod-z": loroUndo, "Mod-y": loroRedo, "Shift-Mod-z": loroRedo }));
    }
    plugins.push(keymap(baseKeymap));
    const doc: PmNode = !o.live && o.content ? schema.nodeFromJSON(o.content) : schema.topNodeType.createAndFill()!;
    return EditorState.create({ schema, doc, plugins });
  };
  // every mark the schema knows is a Loro text style (loro-prosemirror configures a document once, with the first schema only)
  const styles = (s: Schema) => o.live?.doc.configTextStyle(Object.fromEntries(Object.entries(s.marks).map(([n, t]) => [n, { expand: t.spec.inclusive === false ? "none" : "after" }])) as never);
  let schema = buildSchema(o.registry, found());
  styles(schema);
  const view = new EditorView(o.place, {
    state: stateFor(schema),
    editable: () => editable,
    nodeViews: o.nodeViews,
    dispatchTransaction(tr: Transaction) { view.updateState(view.state.apply(tr)); },
  });
  // a person whose plugin we lack wrote something new: widen the schema and open the document again, so nothing of it is lost
  const unsub = o.live?.doc.subscribe(() => {
    const f = found();
    if (outgrows(schema, f)) { schema = buildSchema(o.registry, f); styles(schema); view.updateState(stateFor(schema)); }
  });
  const run = (cmd: (s: EditorState, d?: (tr: Transaction) => void) => boolean) => cmd(view.state, view.dispatch);
  return {
    view,
    json: () => view.state.doc.toJSON(),
    text: () => view.state.doc.textBetween(0, view.state.doc.content.size, "\n"),
    undo: () => run(loroUndo as never),
    redo: () => run(loroRedo as never),
    setEditable(on) { editable = on; view.setProps({}); },
    destroy() { unsub?.(); view.destroy(); },
  };
}
