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
import * as loroPm from "loro-prosemirror";
import { setShared } from "@nuah/browser-kit";
import type { ElementKindDecl } from "@nuah/editor-core";
import type { Ui } from "@nuah/editor-api";
import { apiFor, Elements } from "./api";
import { createEngine, type Engine, type Live } from "./engine";
import { createLoader, type Loader, type ModuleEntry } from "./loader";
import { Card, type CardHost } from "./card";
import { slashPlugin } from "./slash";
import { fileRouter, waysPlugin } from "./ways";
import { clipboardPlugin } from "./clipboard";
import { contextPlugin, gutterFor, marginPlugin, openerFor, setOption, turnInto } from "./surfaces";

const IDLE_MS = 1500;
import { localPresence, type PresenceStore } from "./state";
import type { NodeViewConstructor } from "prosemirror-view";

/** `editor.elements`, as the Core answers it (Task 13). */
export interface ElementsList {
  kinds: (ElementKindDecl & { plugin: string; module: string; openers: string[]; default: string | null })[];
  runners: { plugin: string; module: string; languages: string[] }[];
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
  destroy(): void;
}
/** What the editor shares with the element modules it loads (a module never bundles these, ADR 0095). */
function share() {
  setShared({
    "prosemirror-model": pmModel, "prosemirror-state": pmState, "prosemirror-view": pmView, "prosemirror-transform": pmTransform,
    "prosemirror-keymap": pmKeymap, "prosemirror-commands": pmCommands, "prosemirror-inputrules": pmInputrules, "loro-prosemirror": loroPm,
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
  const files = fileRouter(host, () => engineRef!.view);
  const ways = waysPlugin(host, files);
  const engine = createEngine({
    place, registry: elements.registry(), live: hooks.live, content: hooks.content, editable, nodeViews: { element: card, elementInline: card },
    plugins: () => [slashPlugin(host), ways.plugin, clipboardPlugin(host), contextPlugin(host), marginPlugin(host, chosen)],
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
    destroy: () => { clearTimeout(later); engine.destroy(); },
  };
  return { handle, engine, loader, elements, list, host };
}

export async function mount(place: HTMLElement, hooks: FaceHooks): Promise<EditorHandle> {
  return (await open(place, hooks)).handle;
}
