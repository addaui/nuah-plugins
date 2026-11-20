// SPDX-License-Identifier: Apache-2.0
/**
 * The engine (ADR 0062, 0094): ProseMirror's libraries, bound to the page's Live document through loro-prosemirror (ADR 0093).
 * Undo is the person's own, from Loro. Every block a plugin marks `ids`, and every element, carries a stable id (ADR 0043).
 */
import { EditorState, NodeSelection, Plugin, PluginKey, type Command, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet, type NodeViewConstructor } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import type { Schema, Node as PmNode } from "prosemirror-model";
import { UndoManager, type LoroDoc } from "loro-crdt";
import { LoroSyncPlugin, LoroUndoPlugin, LoroEphemeralCursorPlugin, undo as loroUndo, redo as loroRedo, type CursorEphemeralStore } from "loro-prosemirror";
import type { Registry } from "@nuah/editor-core";
import { buildSchema, outgrows, scanJson, scanLoro, type SpecExtras } from "./schema";
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
  /** Plugins' additions to their nodes' and marks' specs. */
  extras?: SpecExtras;
  /** The hint on the empty line the cursor is in. */
  placeholder?: string;
  /** Called with the document after every change (a description kept as JSON has no Live document to write into). */
  onChange?: (doc: unknown) => void;
}
export interface Engine {
  readonly view: EditorView;
  /** Opens another document (no Live document: a description replaced from outside). */
  setContent(json: unknown): void;
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
        // always set: when a decoration's attribute goes, ProseMirror removes it rather than restoring the node's own
        if (node.isTextblock) out.push(Decoration.node(pos, pos + node.nodeSize, { dir: /\p{L}/u.test(node.textContent) ? "auto" : page }));
      });
      return DecorationSet.create(state.doc, out);
    },
  },
});

/** The page's hint on the empty top-level line the cursor is in (`data-placeholder`, drawn by the Face's styles). */
function placeholder(text: string) {
  return new Plugin({
    key: new PluginKey("nuahPlaceholder"),
    props: {
      decorations(state) {
        const { $from, empty } = state.selection;
        if (!text || !empty || $from.depth !== 1 || !$from.parent.isTextblock || $from.parent.content.size > 0) return null;
        return DecorationSet.create(state.doc, [Decoration.node($from.before(), $from.after(), { class: "is-empty", "data-placeholder": text })]);
      },
    },
  });
}

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
    const plugins: Plugin[] = [...(o.plugins?.(schema) ?? []), blockIds(idTypes), blockDir, placeholder(o.placeholder ?? ""), dropCursor(), gapCursor()];
    if (o.live) {
      // an element's full view keeps its own undo: what it commits as `el:<id>` stays out of the page's (ADR 0094)
      plugins.unshift(LoroSyncPlugin({ doc: o.live.doc as never }), LoroUndoPlugin({ doc: o.live.doc as never, undoManager: new UndoManager(o.live.doc, { excludeOriginPrefixes: ["el:"] }) as never }));
      if (o.live.ephemeral) plugins.push(LoroEphemeralCursorPlugin(drawableCursors(o.live.ephemeral, o.live.doc), { user: o.live.user }) as never);
      plugins.push(keymap({ "Mod-z": loroUndo, "Mod-y": loroRedo, "Shift-Mod-z": loroRedo }));
    }
    plugins.push(tailLine(), typeAfterSelectedCard(), keymap({ Backspace: selectAtomBeside(-1), Delete: selectAtomBeside(1) }), keymap(baseKeymap));
    const doc: PmNode = !o.live && o.content ? schema.nodeFromJSON(o.content) : schema.topNodeType.createAndFill()!;
    return EditorState.create({ schema, doc, plugins });
  };
  // every mark the schema knows is a Loro text style (loro-prosemirror configures a document once, with the first schema only)
  const styles = (s: Schema) => o.live?.doc.configTextStyle(Object.fromEntries(Object.entries(s.marks).map(([n, t]) => [n, { expand: t.spec.inclusive === false ? "none" : "after" }])) as never);
  let schema = buildSchema(o.registry, found(), o.extras);
  styles(schema);
  const view = new EditorView(o.place, {
    state: stateFor(schema),
    editable: () => editable,
    nodeViews: o.nodeViews,
    dispatchTransaction(tr: Transaction) {
      view.updateState(view.state.apply(tr));
      if (tr.docChanged) o.onChange?.(view.state.doc.toJSON());
    },
  });
  // a person whose plugin we lack wrote something new: widen the schema and open the document again, so nothing of it is lost
  const unsub = o.live?.doc.subscribe(() => {
    const f = found();
    if (outgrows(schema, f)) { schema = buildSchema(o.registry, f, o.extras); styles(schema); view.updateState(stateFor(schema)); }
  });
  const run = (cmd: (s: EditorState, d?: (tr: Transaction) => void) => boolean) => cmd(view.state, view.dispatch);
  return {
    view,
    json: () => view.state.doc.toJSON(),
    setContent(json) {
      o.content = json;
      const f = found();
      if (outgrows(schema, f)) { schema = buildSchema(o.registry, f, o.extras); styles(schema); }
      view.updateState(stateFor(schema));
    },
    text: () => view.state.doc.textBetween(0, view.state.doc.content.size, "\n"),
    undo: () => run(loroUndo as never),
    redo: () => run(loroRedo as never),
    setEditable(on) { editable = on; view.setProps({}); },
    destroy() { unsub?.(); view.destroy(); },
  };
}

/**
 * Backspace at the start of a line, or Delete at its end, next to a card or another atom: the first press selects it, the second removes it.
 * ProseMirror's own keys remove it at once, and with it everything the element held (a whole sketch).
 * An empty line is left to ProseMirror, which removes the line and selects the neighbour already.
 */
function selectAtomBeside(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    // only a text selection has a cursor
    const $c = (sel as Partial<TextSelection>).$cursor ?? null;
    if (!$c || !$c.parent.isTextblock || !$c.parent.content.size || $c.depth < 1) return false;
    if (dir < 0 ? $c.parentOffset > 0 : $c.parentOffset < $c.parent.content.size) return false;
    const $edge = state.doc.resolve(dir < 0 ? $c.before() : $c.after());
    const beside = dir < 0 ? $edge.nodeBefore : $edge.nodeAfter;
    if (!beside?.isAtom || beside.isInline) return false;
    if (dispatch) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, dir < 0 ? $edge.pos - beside.nodeSize : $edge.pos)).scrollIntoView());
    return true;
  };
}

/**
 * Typing while a card (or another block atom) is selected starts a new line after it with what was typed; the card stays.
 * ProseMirror would replace the selection with the text, and a click near a card selects it, so one "/" removed a sketch.
 */
function typeAfterSelectedCard(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, _from, _to, text) {
        const sel = view.state.selection as NodeSelection;
        const node = sel.node;
        if (!node || node.isInline || !node.isAtom) return false;
        const para = view.state.schema.topNodeType.contentMatch.defaultType;
        if (!para?.isTextblock) return false;
        const after = sel.to;
        const tr = view.state.tr.insert(after, para.create(null, view.state.schema.text(text)));
        tr.setSelection(TextSelection.create(tr.doc, after + 1 + text.length)).scrollIntoView();
        view.dispatch(tr);
        return true;
      },
    },
  });
}

/**
 * A line after the last element, so a mouse can always start writing at the end: shown when the page does not end with an empty
 * line; a click adds one there and puts the cursor in it. Nothing is stored until the click.
 */
function tailLine(): Plugin {
  return new Plugin({
    view(view) {
      const tail = document.createElement("div");
      tail.className = "nuah-tail";
      tail.setAttribute("aria-hidden", "true");
      view.dom.after(tail);
      const sync = () => {
        const last = view.state.doc.lastChild;
        tail.hidden = !view.editable || (!!last && last.isTextblock && last.content.size === 0);
      };
      tail.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const { state } = view;
        const para = state.schema.topNodeType.contentMatch.defaultType;
        if (!para) return;
        const end = state.doc.content.size;
        const tr = state.tr.insert(end, para.create());
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 1)).scrollIntoView());
        view.focus();
      });
      sync();
      return { update: sync, destroy: () => tail.remove() };
    },
  });
}
