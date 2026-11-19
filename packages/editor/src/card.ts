// SPDX-License-Identifier: Apache-2.0
/**
 * A card element in the page (ADR 0094): the editor gives the plugin that opens its kind a place to draw, the element's settings,
 * its own Loro container and the editor's services, and calls `update` on every change, local or remote. While the plugin loads, or
 * when it failed, the element shows its Fallback; with no plugin, the missing bar. An element no plugin opens is never written to.
 */
import type { Node as PmNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import type { LoroDoc } from "loro-crdt";
import type { ElementCtx, ElementDef, RunResult, View } from "@nuah/editor-api";
import { resolveOption } from "@nuah/editor-core";
import type { Elements } from "./api";
import type { Loader } from "./loader";
import type { ElementsList, FaceHooks } from "./face";
import { elementPresence, localPresence, stateFor, stateJson, type PresenceStore, type StateType } from "./state";
import { fallbackView, missingBar, showRaw } from "./missing";
import { msg } from "./messages";

export interface CardHost {
  elements: Elements;
  loader: Loader;
  list: ElementsList;
  hooks: FaceHooks;
  doc?: LoroDoc;
  presence: PresenceStore;
  editable(): boolean;
  /** The plugin that opens a kind here: this element's choice, else the person's, else the Owner's, else the declaring plugin's. */
  openerFor(kind: string, blockId?: string): string | undefined;
  /** Every card drawn now, by element id. */
  cards: Map<string, Card>;
  /** The page's defaults for element options, by kind (ADR 0073). */
  defaults?: Record<string, Record<string, unknown>>;
  /** Files dropped or pasted at a place (ways.ts). */
  files?: (files: File[], pos?: number) => Promise<number>;
  /** Re-reads the loaded plugins' keys (after modules load). */
  refreshWays?: () => void;
  openFull?: (blockId: string) => void;
  openWith?: (blockId: string, plugin: string) => Promise<void>;
  turnInto?: (blockId: string, kind: string) => Promise<string | null>;
  gutterFor?: (blockId: string) => HTMLElement | null;
}

const FALLBACK_MS = 1000;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class Card implements NodeView {
  dom: HTMLElement;
  private body: HTMLElement;
  private mounted: View | null = null;
  private stateSub: (() => void) | null = null;
  private presenceSub: (() => void) | null = null;
  private fbTimer: ReturnType<typeof setTimeout> | undefined;
  private closeFull: (() => void) | null = null;
  private dead = false;

  constructor(private node: PmNode, private view: EditorView, private getPos: () => number | undefined, private host: CardHost) {
    this.dom = document.createElement(node.type.spec.inline ? "span" : "div");
    this.dom.className = "nuah-card";
    this.dom.contentEditable = "false";
    this.dom.dataset.kind = node.attrs.kind;
    this.body = document.createElement(node.type.spec.inline ? "span" : "div");
    this.dom.append(this.body);
    if (node.attrs.blockId) host.cards.set(node.attrs.blockId, this);
    this.render();
  }

  private get kind(): string { return this.node.attrs.kind; }
  private get decl() { return this.host.list.kinds.find((k) => k.kind === this.kind); }
  private get lang() { return this.host.hooks.lang; }

  /** The definition this element is drawn with, or why not. */
  private resolve(): { def: ElementDef; plugin: string } | { why: "missing" | "loading" | "failed" | "newer"; plugin: string } {
    const plugin = this.host.openerFor(this.kind, this.node.attrs.blockId) ?? this.decl?.plugin;
    if (!plugin || !this.decl) return { why: "missing", plugin: this.node.attrs.plugin || plugin || "" };
    if (this.host.loader.failed(plugin)) return { why: "failed", plugin };
    const def = this.host.elements.defFor(this.kind, plugin);
    if (!def || !this.host.loader.loaded(plugin)) return { why: "loading", plugin };
    if ((this.node.attrs.v ?? 1) > (this.decl.version ?? 1)) return { why: "newer", plugin };
    return { def, plugin };
  }

  private render() {
    if (this.dead) return;
    this.teardown();
    this.body.replaceChildren();
    const r = this.resolve();
    if ("def" in r) {
      if (this.upgrade(r.def)) return; // the upgraded node comes back through update()
      const card = r.def.views?.card;
      if (!card) { this.body.append(fallbackView(this.node.attrs.fallback)); return; }
      const place = document.createElement(this.node.type.spec.inline ? "span" : "div");
      place.className = "nuah-card-view";
      this.body.append(place);
      this.mounted = card(place, this.ctx(r.def));
      this.watchState();
      // the state may have changed while the module loaded: the Fallback is checked once now (written only if it differs)
      this.scheduleFallback(r.def);
      return;
    }
    if (r.why === "missing") {
      this.body.append(missingBar({ plugin: r.plugin, attrs: { ...this.node.attrs }, state: this.host.doc ? stateJson(this.host.doc, this.node.attrs.blockId) : null, lang: this.lang, ui: this.host.hooks.ui, needsPlugin: this.host.hooks.needsPlugin }), fallbackView(this.node.attrs.fallback));
      return;
    }
    if (r.why === "newer") {
      const note = document.createElement("div");
      note.className = "nuah-missing";
      note.textContent = msg(this.lang, "newer", { plugin: r.plugin });
      const pre = document.createElement("pre");
      pre.className = "nuah-raw";
      pre.dir = "ltr";
      pre.textContent = JSON.stringify({ data: this.node.attrs.data, state: this.host.doc ? stateJson(this.host.doc, this.node.attrs.blockId) : null }, null, 2);
      this.body.append(note, pre);
      return;
    }
    this.body.append(fallbackView(this.node.attrs.fallback));
    if (r.why === "failed") {
      const line = document.createElement("div");
      line.className = "nuah-card-error";
      line.textContent = msg(this.lang, "failed", { plugin: r.plugin });
      this.body.append(line);
      return;
    }
    // loading: draw when the module is in
    void this.host.loader.loadPlugin(r.plugin).then(() => this.render());
  }

  /** An element of an older version is brought up to the plugin's version when it opens (by someone who may write): each step in turn. */
  private upgrade(def: ElementDef): boolean {
    const from: number = this.node.attrs.v ?? 1, to = this.decl?.version ?? 1;
    if (from >= to || !this.host.editable()) return false;
    const pos = this.getPos();
    if (pos === undefined) return false;
    let data = { ...(this.node.attrs.data ?? {}) } as Record<string, unknown>;
    const state = this.stateType() && this.host.doc ? stateFor(this.host.doc, this.node.attrs.blockId, this.stateType()!, true).container : null;
    for (let v = from; v < to; v++) {
      const step = def.upgrade?.[v];
      if (step) data = step(data, state);
    }
    data = Object.fromEntries(Object.entries(data).filter(([, x]) => x !== undefined));
    queueMicrotask(() => {
      const p = this.getPos();
      if (p !== undefined && !this.dead) this.view.dispatch(this.view.state.tr.setNodeMarkup(p, undefined, { ...this.node.attrs, v: to, data }));
    });
    return true;
  }

  private stateType(): StateType | null { return (this.decl?.state as StateType | undefined) ?? null; }

  private ctx(def: ElementDef): ElementCtx {
    const self = this, attrs = this.node.attrs, blockId: string = attrs.blockId;
    const editable = this.host.editable();
    const peer = this.host.doc ? String(this.host.doc.peerIdStr) : "me";
    const st = this.stateType();
    let state: unknown = null;
    const options: Record<string, unknown> = {};
    const pref = (k: string) => this.host.hooks.pref?.(k);
    for (const o of def.options ?? []) {
      const person = pref(`editor.option.${this.kind}.${o.id}`);
      options[o.id] = resolveOption(o, this.kind, (attrs.data ?? {}) as Record<string, unknown>, this.host.defaults as never, person !== undefined && person !== null && person !== "" ? { person: { [this.kind]: { [o.id]: person as string } } } : undefined).value;
    }
    return {
      blockId, kind: this.kind, v: attrs.v ?? 1, data: (attrs.data ?? {}) as Record<string, unknown>,
      set: (patch) => self.setData(patch),
      get state() {
        if (state === null && st && self.host.doc) { const s = stateFor(self.host.doc, blockId, st, editable); state = s.container; if (s.attached) self.watchState(); }
        return state;
      },
      presence: elementPresence(this.host.presence ?? localPresence(), blockId, peer),
      options, editable, lang: this.lang, dir: this.lang === "ar" ? "rtl" : "ltr", origin: `el:${blockId}`,
      openFull: () => self.openFull(def),
      commit: () => self.host.doc?.commit({ origin: `el:${blockId}` }),
      close: () => { self.closeFull?.(); self.closeFull = null; },
      files: { upload: (f, n) => (self.host.hooks.files ? self.host.hooks.files.upload(f, n) : Promise.reject(new Error("uploads are not available here"))) },
      call: (op, input) => (self.host.hooks.call ? self.host.hooks.call(op, input) : Promise.reject(new Error("calls are not available here"))),
      run: (language, source, report) => self.run(language, source, report),
      ui: this.host.hooks.ui,
    };
  }

  private async run(language: string, source: string, report?: (r: { stage: "loading" | "running"; text?: string }) => void): Promise<RunResult> {
    if (!this.host.editable()) throw Object.assign(new Error(msg(this.lang, "notAllowed")), { reason: "not_allowed" });
    const r = this.host.list.runners.find((x) => x.languages.includes(language));
    if (!r) throw Object.assign(new Error(msg(this.lang, "noRunner", { language })), { reason: "no_runner" });
    await this.host.loader.loadPlugin(r.plugin);
    const run = this.host.elements.runner(language);
    if (!run) throw Object.assign(new Error(msg(this.lang, "noRunner", { language })), { reason: "no_runner" });
    return run.run({ language, source }, report ?? (() => {}));
  }

  private openFull(def: ElementDef) {
    const full = def.views?.full;
    if (!full || this.closeFull) return;
    let v: View | null = null;
    this.closeFull = this.host.hooks.ui.modal(String(this.decl?.label?.[this.lang as "en"] ?? this.decl?.label?.en ?? this.kind), (el, close) => {
      v = full(el, this.ctx(def));
      const stop = this.host.doc?.subscribe(() => v?.update(this.ctx(def)));
      return () => { stop?.(); v?.destroy(); v = null; this.closeFull = null; void close; this.refresh(); };
    });
  }

  private setData(patch: Record<string, unknown>) {
    const pos = this.getPos();
    if (pos === undefined || !this.host.editable()) return;
    const data = { ...(this.node.attrs.data ?? {}), ...patch };
    if (same(data, this.node.attrs.data)) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, data }));
  }

  /** Changes to this element's own container, including its creation by someone else (the `elements` map is watched as a whole). */
  private watchState() {
    if (this.stateSub || !this.host.doc || !this.node.attrs.blockId) return;
    const id: string = this.node.attrs.blockId;
    const mine = (ev: { path?: unknown[]; diff?: { type?: string; updated?: Record<string, unknown> } }) =>
      (Array.isArray(ev.path) && ev.path.includes(id)) || (ev.diff?.type === "map" && !!ev.diff.updated && id in ev.diff.updated);
    this.stateSub = this.host.doc.getMap("elements").subscribe((batch: { events: unknown[] }) => {
      if (batch.events.some((e) => mine(e as never))) this.refresh();
    });
  }

  /** Something changed: tell the view, and write the Fallback once things settle. */
  private refresh() {
    const r = this.resolve();
    if (!("def" in r)) { this.render(); return; }
    if (this.mounted) this.mounted.update(this.ctx(r.def)); else this.render();
    this.scheduleFallback(r.def);
  }

  private scheduleFallback(def: ElementDef) {
    if (!def.fallback || !this.host.editable()) return;
    clearTimeout(this.fbTimer);
    this.fbTimer = setTimeout(() => {
      if (this.dead) return;
      const pos = this.getPos();
      if (pos === undefined) return;
      const fb = def.fallback!(this.ctx(def));
      if (same(fb, this.node.attrs.fallback)) return;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, fallback: fb }).setMeta("addToHistory", false));
    }, FALLBACK_MS);
  }

  update(node: PmNode): boolean {
    if (node.type !== this.node.type) return false;
    const kindChanged = node.attrs.kind !== this.node.attrs.kind || node.attrs.blockId !== this.node.attrs.blockId;
    const changed = !same(node.attrs.data, this.node.attrs.data) || !same(node.attrs.v, this.node.attrs.v);
    this.node = node;
    if (kindChanged) this.render();
    else if (changed) this.refresh();
    return true;
  }
  stopEvent() { return true; }
  ignoreMutation() { return true; }
  selectNode() { this.dom.classList.add("is-selected"); }
  deselectNode() { this.dom.classList.remove("is-selected"); }
  private teardown() { this.mounted?.destroy(); this.mounted = null; this.stateSub?.(); this.stateSub = null; this.presenceSub?.(); this.presenceSub = null; }
  /** Draws again (another Opener was chosen). */
  redraw() { this.render(); }
  /** The context a view would get now (Turn into, the right-click menu), or null when the element is not drawn. */
  ctxNow(): ElementCtx | null { const r = this.resolve(); return "def" in r ? this.ctx(r.def) : null; }
  /** Opens the full view (the right-click menu, the host's api). */
  full() { const r = this.resolve(); if ("def" in r) this.openFull(r.def); }
  destroy() { if (this.host.cards.get(this.node.attrs.blockId) === this) this.host.cards.delete(this.node.attrs.blockId); this.dead = true; clearTimeout(this.fbTimer); this.closeFull?.(); this.teardown(); }
}

/** Shows an element's raw data (the right-click menu's "View raw data"). */
export function viewRaw(host: CardHost, node: PmNode) {
  showRaw(host.hooks.ui, host.hooks.lang, { ...node.attrs }, host.doc ? stateJson(host.doc, node.attrs.blockId) : null);
}
