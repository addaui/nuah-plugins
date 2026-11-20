// SPDX-License-Identifier: Apache-2.0
/**
 * face.editor@1 (ADR 0095): what a Face calls to put an editor on a page. The Face draws the app's menus, popovers, modals and toasts
 * (`ui`) and answers for the Core (`elements`, `call`, `files`); the editor loads the element plugins it needs and opens the page.
 */
import * as pmModel from "prosemirror-model";
import * as pmState from "prosemirror-state";
import * as pmView from "prosemirror-view";
import * as pmTransform from "prosemirror-transform";
import * as pmKeymap from "prosemirror-keymap";
import * as pmCommands from "prosemirror-commands";
import * as pmInputrules from "prosemirror-inputrules";
import * as pmSchemaList from "prosemirror-schema-list";
import * as loroPm from "loro-prosemirror";
import { setShared } from "@nuah/browser-kit";
import type { ElementKindDecl } from "@nuah/editor-core";
import type { Ui } from "@nuah/editor-api";
import { apiFor, Elements } from "./api";
import { createEngine, type Engine, type Live } from "./engine";
import { createLoader, type Loader, type ModuleEntry } from "./loader";
import { Card, type CardHost } from "./card";
import { applyFormat, formatOf, formatPlugin } from "./format";
import { slashPlugin } from "./slash";
import { fileRouter, waysPlugin } from "./ways";
import { clipboardPlugin } from "./clipboard";
import { contextPlugin, gutterFor, marginPlugin, openerFor, setOption, turnInto } from "./surfaces";
import { blockAt, floatingOf, floatingPlugin, lineTop, setFloating, wrapsLayer, type FloatingHooks } from "./floating";

const IDLE_MS = 1500;
import { localPresence, type PresenceStore } from "./state";
import type { NodeViewConstructor } from "prosemirror-view";

/** `editor.elements`, as the Core answers it (Task 13). */
export interface ElementsList {
  kinds: (ElementKindDecl & { plugin: string; module: string; openers: string[]; default: string | null })[];
  runners: { plugin: string; module: string; languages: string[] }[];
  /** Plugins with a module and no kinds (margin actions, block menus). */
  modules?: { plugin: string; module: string }[];
}
export interface FaceHooks {
  ui: Ui;
  lang: string;
  editable: boolean;
  live?: Live;
  content?: unknown;
  placeholder?: string;
  elements(): Promise<ElementsList>;
  call?(operation: string, input: unknown): Promise<unknown>;
  files?: { upload(file: Blob, name?: string): Promise<string> };
  /** Whether a missing plugin is known to the Core and whether this person may switch it on (owner and admins, ADR 0094). */
  needsPlugin?(plugin: string): { known: boolean; canEnable: boolean; enable(): Promise<void> };
  /** A person's preference (the default Opener of a kind is `editor.opener.<kind>`). */
  pref?(key: string): unknown;
  /** The element the cursor is in or that is selected, innermost first, with its options (pinned first), for the Element tab. */
  onContext?(ctx: { chain: unknown[]; selected: boolean } | null): void;
  onChange?(doc: unknown): void;
  /** Services this Face offers element plugins by name (EditorApi.service). */
  services?: Record<string, unknown>;
  /** The floating layer (stickers): the layers to draw in, the list, and when to lay them out again. */
  floating?: FloatingHooks;
  /** Where the Format bar goes (ADR 0097): the Face places it (under the title) and styles it. */
  formatBar?: HTMLElement;
  /** Format items of the Face's own (Madar: add a sticker). */
  format?: import("@nuah/editor-api").FormatItem[];
  /** Loads a module (tests hand in their own). */
  importer?(url: string): Promise<{ default?: unknown }>;
}
export interface EditorHandle {
  json(): unknown;
  live(): boolean;
  setEditable(on: boolean): void;
  focus(atEnd?: boolean): void;
  isEmpty(): boolean;
  /** Content goes between blocks: onto an empty line (which it replaces), or after the block the place is in. */
  insert(content: unknown, pos?: number): void;
  /** Writes attributes of the node at a position. */
  setAttrs(pos: number, patch: Record<string, unknown>): void;
  /** Writes one option of a block (the Element tab). */
  setOption(blockId: string, id: string, value: unknown): void;
  /** Replaces the document (no Live document: a description that changed elsewhere). */
  set(doc: unknown): void;
  /** The page's defaults for element options, by node type or kind (ADR 0073). */
  setDefaults(defaults: Record<string, Record<string, unknown>>): void;
  /** Counts of margin actions changed (comments): the margin is drawn again. */
  refreshComments(): void;
  /** The floating layer's list, and writing it (one change everyone sees). */
  floating(): unknown[];
  setFloating(list: unknown[]): void;
  /** The top-level block at a point (its id, and the character under the point), and the top of the line a character is on. */
  blockAt(x: number, y: number): { id: string; at?: number } | null;
  lineTop(id: string, at: number): number | null;
  /** Text flowing around floating elements: shaped floats, and spacers where an element covers part of a line (ADR 0071). */
  setWraps(list: unknown[]): void;
  /** The Format items for a whole element, with whether each is on for all of its text (the Element tab, ADR 0097). */
  format(blockId: string): { id: string; label: string; icon?: string; group?: string; applies: string; active: boolean }[];
  /** Applies one Format item to all of an element's text. */
  applyFormat(blockId: string, id: string): void;
  destroy(): void;
}
/** What the editor shares with the element modules it loads (a module never bundles these, ADR 0095). */
function share() {
  setShared({
    "prosemirror-model": pmModel, "prosemirror-state": pmState, "prosemirror-view": pmView, "prosemirror-transform": pmTransform,
    "prosemirror-keymap": pmKeymap, "prosemirror-commands": pmCommands, "prosemirror-inputrules": pmInputrules, "prosemirror-schema-list": pmSchemaList, "loro-prosemirror": loroPm,
  });
}

export function modulesOf(list: ElementsList): ModuleEntry[] {
  const by = new Map<string, ModuleEntry>();
  for (const k of list.kinds) {
    const { plugin, module, openers: _o, default: _d, ...decl } = k;
    const e = by.get(plugin) ?? { plugin, url: module, data: { kinds: [] } };
    e.data!.kinds!.push(decl);
    by.set(plugin, e);
  }
  for (const r of list.runners) if (!by.has(r.plugin)) by.set(r.plugin, { plugin: r.plugin, url: r.module, data: { languages: r.languages } });
  for (const m of list.modules ?? []) if (!by.has(m.plugin)) by.set(m.plugin, { plugin: m.plugin, url: m.module, data: { kinds: [] } });
  return [...by.values()];
}

export interface Mounted { handle: EditorHandle; engine: Engine; loader: Loader; elements: Elements; list: ElementsList; host: CardHost }

/** The parts, for the host's own surfaces and tests. */
export async function open(place: HTMLElement, hooks: FaceHooks): Promise<Mounted> {
  share();
  const list = await hooks.elements();
  const elements = new Elements();
  const loader = createLoader({ list: modulesOf(list), ui: hooks.ui, api: (p) => apiFor(p, elements, hooks), importer: hooks.importer });
  await loader.loadContent();
  let editable = hooks.editable;
  const presence = (hooks.live?.ephemeral as unknown as PresenceStore | undefined) ?? localPresence();
  const host: CardHost = {
    elements, loader, list, hooks, doc: hooks.live?.doc, presence, editable: () => editable, cards: new Map(),
    openerFor: (kind, blockId) => openerFor(host, chosen, kind, blockId),
  };
  const chosen = new Map<string, string>();
  const card: NodeViewConstructor = (node, view, getPos) => new Card(node, view, getPos as () => number | undefined, host);
  let engineRef: Engine | null = null;
  const wraps = wrapsLayer(() => engineRef!.view);
  const files = fileRouter(host, () => engineRef!.view);
  const ways = waysPlugin(host, files);
  // what content plugins add for a ProseMirror engine: plugins, node views, spec additions
  const pm = { model: pmModel, state: pmState, view: pmView, transform: pmTransform, keymap: pmKeymap, commands: pmCommands, inputrules: pmInputrules, schemaList: pmSchemaList };
  const extra = elements.all().map(({ def }) => def.prosemirror?.(pm) ?? {});
  const extras = { nodes: Object.assign({}, ...extra.map((x) => x.nodes ?? {})), marks: Object.assign({}, ...extra.map((x) => x.marks ?? {})) };
  const version = (kind: string) => list.kinds.find((k) => k.kind === kind)?.version ?? 1;
  const engine = createEngine({
    place, registry: elements.registry(version), live: hooks.live, content: hooks.content, editable, extras, placeholder: hooks.placeholder, onChange: hooks.onChange,
    nodeViews: { ...(Object.assign({}, ...extra.map((x) => x.nodeViews ?? {})) as Record<string, NodeViewConstructor>), element: card, elementInline: card },
    plugins: (schema) => [floatingPlugin(place, hooks.floating, hooks.live?.doc, () => hooks.content), wraps.plugin, slashPlugin(host), ways.plugin, clipboardPlugin(host), contextPlugin(host), formatPlugin(host), marginPlugin(host, chosen), ...(extra.flatMap((x) => (typeof x.plugins === "function" ? x.plugins(schema) : x.plugins ?? [])) as pmState.Plugin[])],
  });
  engineRef = engine;
  host.files = files;
  host.refreshWays = ways.refresh;
  host.openFull = (id) => host.cards.get(id)?.full();
  host.openWith = async (id, plugin) => { chosen.set(id, plugin); await loader.loadPlugin(plugin); host.cards.get(id)?.redraw(); };
  host.turnInto = (id, kind) => turnInto(engine.view, host, id, kind);
  host.gutterFor = (id) => gutterFor(engine.view, host, chosen, id);
  // the ways in live in plugins' code: once the page is open and quiet, every enabled element plugin loads in the background
  const later = setTimeout(() => { void loader.loadFor(new Set(list.kinds.map((k) => k.kind))).then(() => ways.refresh()); }, IDLE_MS);
  const view = engine.view;
  const handle: EditorHandle = {
    json: () => engine.json(),
    live: () => !!hooks.live,
    setEditable: (on) => { editable = on; engine.setEditable(on); },
    focus(atEnd) {
      view.focus();
      if (atEnd) view.dispatch(view.state.tr.setSelection(pmState.Selection.atEnd(view.state.doc)));
    },
    isEmpty: () => view.state.doc.childCount <= 1 && view.state.doc.textContent === "" && !view.state.doc.firstChild?.isAtom,
    insert(content, pos) {
      const s = view.state, $p = s.doc.resolve(Math.min(pos ?? s.selection.from, s.doc.content.size));
      let range = { from: $p.pos, to: $p.pos };
      if ($p.depth >= 1) { const from = $p.before(1), to = $p.after(1), top = $p.node(1); range = top.isTextblock && top.content.size === 0 ? { from, to } : { from: to, to }; }
      const node = Array.isArray(content) ? content.map((c) => s.schema.nodeFromJSON(c)) : s.schema.nodeFromJSON(content);
      view.dispatch(s.tr.replaceWith(range.from, range.to, node));
    },
    setAttrs(pos, patch) {
      const n = view.state.doc.nodeAt(pos);
      if (n) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...patch }));
    },
    setOption: (id, option, value) => setOption(engine.view, host, id, option, value),
    set: (doc) => engine.setContent(doc),
    setDefaults: (d) => { host.defaults = d; for (const c of host.cards.values()) c.redraw(); },
    floating: () => floatingOf(hooks.live?.doc, hooks.content),
    setFloating: (list) => setFloating(hooks.live?.doc, list),
    blockAt: (x, y) => blockAt(engine.view, x, y),
    lineTop: (id, at) => lineTop(engine.view, id, at),
    setWraps: (list) => wraps.set(list as never),
    format: (id) => formatOf(engine.view, host, id),
    applyFormat: (id, item) => applyFormat(engine.view, host, id, item),
    refreshComments: () => { engine.view.dom.parentElement?.querySelectorAll(".nuah-gutter").forEach((g) => g.remove()); },
    destroy: () => { clearTimeout(later); engine.destroy(); },
  };
  return { handle, engine, loader, elements, list, host };
}

export async function mount(place: HTMLElement, hooks: FaceHooks): Promise<EditorHandle> {
  return (await open(place, hooks)).handle;
}
