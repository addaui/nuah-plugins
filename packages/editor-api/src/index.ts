// SPDX-License-Identifier: Apache-2.0
/**
 * editor.element@1 (ADR 0094): the agreement between an editor and the Browser modules of element plugins. A module's default export
 * is `register(api)`; it calls `api.element(...)` once per kind it brings. Nothing here is code: an editor built another way gives the
 * same shapes and runs the same modules.
 */
import type { ElementKindDecl, MarkSpec, NodeSpec, OptionDecl } from "@nuah/editor-core";

export type Label = { en: string; ar?: string };
export interface Spot { left: number; top: number; bottom: number }
export interface MenuItem { label: string; icon?: string; checked?: boolean; danger?: boolean; disabled?: boolean; heading?: boolean; onclick?: () => void; sub?: MenuItem[] }

/** What the app draws for every plugin, so they all look like the app. */
export interface Ui {
  menu(x: number, y: number, items: MenuItem[]): void;
  /** Draws into a popover at a spot; the function returned is called when it closes. */
  popover(at: Spot, render: (el: HTMLElement) => (() => void) | void): () => void;
  /** A modal that grows to the page (the full view); returns a function that closes it. */
  modal(title: string, render: (el: HTMLElement, close: () => void) => (() => void) | void): () => void;
  toast(text: string): void;
  /** Something slow started; call the function returned when it is done. Shown in one shared loading toast after 300 ms. */
  loading(label: string): () => void;
  askText(label: string, initial?: string): Promise<string | null>;
  askUrl(label: string): Promise<string | null>;
  icon(name: string): Node | null;
}

export interface RunReport { stage: "loading" | "running"; text?: string }
export interface RunResult { ok: boolean; stdout: string; stderr: string; files: { name: string; type: string; bytes: Uint8Array }[]; ms: number }

/** What a view is given: the element, its state and the editor's services. */
export interface ElementCtx {
  readonly blockId: string;
  readonly kind: string;
  readonly v: number;
  /** The element's settings (`attrs.data`); `set` merges a patch and is a change everyone sees. */
  readonly data: Record<string, unknown>;
  set(patch: Record<string, unknown>): void;
  /** The element's own Loro container (the type its kind declares), or null when the kind declares none. */
  readonly state: unknown;
  /** Live values only worth sending, not keeping (an object turning while dragged), under this element's key. */
  readonly presence: { set(value: unknown): void; others(): unknown[]; subscribe(f: () => void): () => void };
  /** Option values resolved: the element's, else the page's, else the person's, else the admin's, else the default. */
  readonly options: Record<string, unknown>;
  readonly editable: boolean;
  readonly lang: string;
  readonly dir: "ltr" | "rtl";
  /** Changes made with this origin (by the full view) stay out of the page's undo: the view keeps its own. */
  readonly origin: string;
  openFull(): void;
  close(): void;
  /** Ends a group of changes to the state, marked as this element's own (the page's undo skips them; the view keeps its own undo). */
  commit(): void;
  files: { upload(file: Blob, name?: string): Promise<string> };
  /** An Operation of the plugin's own (or another's it may call), with the person's rights. */
  call(operation: string, input: unknown): Promise<unknown>;
  /** Runs code through the Runner for the language (ADR 0096); refused with reason `no_runner` or `not_allowed`. */
  run(language: string, source: string, report?: (r: RunReport) => void): Promise<RunResult>;
  readonly ui: Ui;
}

export interface View { update(ctx: ElementCtx): void; destroy(): void }
export type ViewFactory = (place: HTMLElement, ctx: ElementCtx) => View;

/** What makes a new element: its settings and, for its own state, a function that fills the new container. */
export interface ElementInit {
  data?: Record<string, unknown>;
  fill?: (state: unknown) => void;
  /** For a content element: the node to put in (a picture, a card) instead of an element. */
  node?: unknown;
}

/** What a content element's slash item may do to the block the person is in. */
export interface EditorCommands {
  setBlock(type: string, attrs?: Record<string, unknown>): boolean;
  wrapIn(type: string, attrs?: Record<string, unknown>): boolean;
  /** A list: wraps the block in `list` holding `item`. */
  toggleList(list: string, item: string): boolean;
  insertNode(json: unknown): void;
  /** Inline content (text, an inline node) at the cursor. */
  insertInline(json: unknown[]): void;
  /** Puts other content in the place of a block. */
  replaceBlock(blockId: string, json: unknown): void;
  insertElement(kind: string, init?: ElementInit): string;
}

export interface Ways {
  /** Slash menu items. A card kind gets one from its declaration anyway; more items, or a content element's, are listed here. */
  slash?: { id?: string; label: Label; keywords?: string; icon?: string; group?: string; init?: () => ElementInit | Promise<ElementInit | null>; apply?: (c: EditorCommands) => void }[];
  /** Typed at the start of an empty line, then Enter or space: `` ```mermaid ``. */
  shortcuts?: { match: string; init?: () => ElementInit }[];
  paste?: { text?: RegExp; url?: RegExp; make: (s: string) => ElementInit | Promise<ElementInit | null> }[];
  files?: { accept: string[]; make: (file: File) => ElementInit | Promise<ElementInit | null> }[];
  keys?: Record<string, (c: EditorCommands) => boolean>;
  /** Items for the right-click menu of an element of this kind. */
  menu?: (ctx: ElementCtx) => MenuItem[];
}

export interface ElementDef {
  kind: string;
  views?: { card?: ViewFactory; full?: ViewFactory; raw?: ViewFactory };
  options?: OptionDecl[];
  ways?: Ways;
  fallback?: (ctx: ElementCtx) => { text: string; picture?: string };
  /** From each older version to the next: change the settings and the state in place. */
  upgrade?: Record<number, (data: Record<string, unknown>, state: unknown) => Record<string, unknown>>;
  markdown?: { to: (ctx: ElementCtx) => string };
  /** Content elements: the nodes and marks the engine's schema gets. */
  nodes?: NodeSpec[];
  marks?: MarkSpec[];
  /**
   * Extras only a ProseMirror engine reads, given its libraries: plugins (input rules, keymaps, decorations), node views, and
   * additions to the specs of this plugin's own nodes and marks (toDOM and parseDOM by attribute, `defining`, `inclusive`...).
   */
  prosemirror?: (pm: Record<string, unknown>) => { plugins?: unknown[] | ((schema: unknown) => unknown[]); nodeViews?: Record<string, unknown>; nodes?: Record<string, Record<string, unknown>>; marks?: Record<string, Record<string, unknown>> };
  /** Other plugins' kinds this one opens, as `kind@version`. */
  opens?: string[];
  convert?: { to?: { kind: string; make: (ctx: ElementCtx) => ElementInit }[] };
}

export interface EditorApi {
  readonly version: string;
  /** Declares a kind of this plugin (its kind must be `@<this plugin>/<name>`). */
  element(def: ElementDef): void;
  /** For a Runner (ADR 0096): the languages it runs and how. */
  runner(languages: string[], run: (req: { language: string; source: string }, report: (r: RunReport) => void) => Promise<RunResult>): void;
  lang(): string;
  readonly ui: Ui;
  call(operation: string, input: unknown): Promise<unknown>;
  files: { upload(file: Blob, name?: string): Promise<string> };
  /** A button in every block's margin (comments, reactions), whatever the block's kind. */
  margin(action: MarginAction): void;
  /** Items for the right-click menu of every block; the items may change the page through the commands. */
  menu(items: (block: BlockRef, commands: EditorCommands) => MenuItem[]): void;
  /**
   * A service the Face offers by name (a product's own: open a page, pick something to link to, make a page), or undefined when this
   * Face has none of that name. A plugin that needs one says what it does without it.
   */
  service<T = (...args: never[]) => unknown>(name: string): T | undefined;
}

/** A block, as margin actions and menus see it. */
export interface BlockRef { blockId: string; type: string; kind: string | null; attrs: Record<string, unknown>; /** The block's text. */ text: string }
export interface MarginAction { id: string; icon: string; label: Label; count?: (b: BlockRef) => number; run: (b: BlockRef, anchor: HTMLElement) => void }

export type { ElementKindDecl };
