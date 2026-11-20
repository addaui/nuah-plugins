// SPDX-License-Identifier: Apache-2.0
/**
 * editor.element@1 as this editor gives it (ADR 0094): each plugin's module gets an api of its own, through which it declares the
 * kinds it brings. A plugin declares only its own kinds; opening another's is what `opens` is for.
 */
import { parseKind, Registry } from "@nuah/editor-core";
import type { BlockRef, EditorApi, EditorCommands, ElementDef, MarginAction, MenuItem, RunReport, RunResult, Ui } from "@nuah/editor-api";

export const API_VERSION = "1.0.0";
export interface Declared { plugin: string; def: ElementDef }
type Run = (req: { language: string; source: string }, report: (r: RunReport) => void) => Promise<RunResult>;

/** Every kind the loaded modules declared, and every Runner. */
export class Elements {
  private kinds = new Map<string, Declared>();
  private byPlugin = new Map<string, ElementDef[]>();
  readonly margins: { plugin: string; action: MarginAction }[] = [];
  readonly menus: { plugin: string; items: (b: BlockRef, c: EditorCommands) => MenuItem[] }[] = [];
  private runners = new Map<string, { plugin: string; run: Run }>();
  add(plugin: string, def: ElementDef) { this.kinds.set(def.kind, { plugin, def }); this.byPlugin.set(plugin, [...(this.byPlugin.get(plugin) ?? []), def]); }
  /** The definition `plugin` draws `kind` with: its own, or one of its kinds that `opens` it (ADR 0094 "Open with"). */
  defFor(kind: string, plugin: string): ElementDef | undefined {
    const own = this.kinds.get(kind);
    if (own && own.plugin === plugin) return own.def;
    return this.byPlugin.get(plugin)?.find((d) => d.opens?.some((o) => o === kind || o.startsWith(kind + "@")));
  }
  get(kind: string): Declared | undefined { return this.kinds.get(kind); }
  all(): Declared[] { return [...this.kinds.values()]; }
  addRunner(plugin: string, languages: string[], run: Run) { for (const l of languages) this.runners.set(l, { plugin, run }); }
  runner(language: string) { return this.runners.get(language); }
  /**
   * The model registry from every content element's nodes and marks (a fresh one: plugins may load later). Each node carries the
   * plugin that declares it and the kind's version (`plugin`, `v`), so a page says which plugin knows every block (ADR 0094).
   */
  registry(versions: (kind: string) => number = () => 1): Registry {
    const r = new Registry();
    for (const { plugin, def } of this.kinds.values()) {
      const v = versions(def.kind);
      for (const n of def.nodes ?? []) if (!r.has(n.id)) r.addNode(n.id === "doc" || n.id === "text" ? n : { ...n, attrs: { ...(n.attrs ?? {}), plugin: { default: plugin }, v: { default: v } } });
      for (const m of def.marks ?? []) if (!r.marks.has(m.id)) r.addMark(m);
    }
    return r;
  }
}

export interface HostServices {
  ui: Ui;
  /** The Face's own services by name (`face.editor` hooks), for element plugins that ask. */
  services?: Record<string, unknown>;
  lang?: string;
  call?: (operation: string, input: unknown) => Promise<unknown>;
  files?: { upload(file: Blob, name?: string): Promise<string> };
}

export function apiFor(plugin: string, els: Elements, host: HostServices): EditorApi {
  return {
    version: API_VERSION,
    element(def) {
      if (parseKind(def.kind).plugin !== plugin) throw new Error(`${plugin} may only declare its own kinds, not ${def.kind}`);
      els.add(plugin, def);
    },
    runner(languages, run) { els.addRunner(plugin, languages, run); },
    margin(action) { els.margins.push({ plugin, action }); },
    menu(items) { els.menus.push({ plugin, items }); },
    service: <T,>(name: string) => host.services?.[name] as T | undefined,
    lang: () => host.lang ?? "en",
    ui: host.ui,
    call: (op, input) => (host.call ? host.call(op, input) : Promise.reject(new Error("calls are not available here"))),
    files: { upload: (f, n) => (host.files ? host.files.upload(f, n) : Promise.reject(new Error("uploads are not available here"))) },
  };
}
