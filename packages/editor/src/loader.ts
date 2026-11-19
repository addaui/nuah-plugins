// SPDX-License-Identifier: Apache-2.0
/**
 * Loads element plugins' Browser modules (ADR 0094, 0095): each once, only when needed. Content element plugins (their nodes make
 * the schema) load with the page; a card element's plugin loads when a page holds one of its kinds or someone inserts one. A load that
 * takes longer than 300 ms is shown in the app's loading toast; a module that fails is remembered, and its elements show their
 * Fallback.
 */
import type { ElementKindDecl } from "@nuah/editor-core";
import type { EditorApi, Ui } from "@nuah/editor-api";

/** One module as `describe` (or `editor.elements`) lists it. */
export interface ModuleEntry { plugin: string; url: string; data: { kinds?: ElementKindDecl[]; languages?: string[] } | null }
export interface LoaderOptions {
  list: ModuleEntry[];
  ui: Pick<Ui, "loading">;
  /** The api one plugin's module gets. */
  api: (plugin: string) => EditorApi;
  importer?: (url: string) => Promise<{ default?: unknown }>;
}
export interface Loader {
  loadContent(): Promise<void>;
  loadFor(kinds: Set<string>): Promise<void>;
  loadPlugin(plugin: string): Promise<void>;
  loaded(plugin: string): boolean;
  /** Why the plugin's module could not be used, or null. */
  failed(plugin: string): string | null;
  /** The plugin that declares a kind, if any enabled one does. */
  declarer(kind: string): ModuleEntry | undefined;
}

const SLOW_MS = 300;

export function createLoader(o: LoaderOptions): Loader {
  const importer = o.importer ?? ((u: string) => import(/* @vite-ignore */ u));
  const pending = new Map<string, Promise<void>>();
  const ok = new Set<string>();
  const errors = new Map<string, string>();
  const byKind = new Map<string, ModuleEntry>();
  for (const e of o.list) for (const k of e.data?.kinds ?? []) if (!byKind.has(k.kind)) byKind.set(k.kind, e);

  const load = (e: ModuleEntry): Promise<void> => {
    let p = pending.get(e.plugin);
    if (p) return p;
    p = (async () => {
      let done: (() => void) | null = null;
      const slow = setTimeout(() => { done = o.ui.loading(e.plugin); }, SLOW_MS);
      try {
        const m = await importer(e.url);
        if (typeof m.default !== "function") throw new Error(`${e.plugin}: the module has no register function as its default export`);
        (m.default as (api: EditorApi) => void)(o.api(e.plugin));
        ok.add(e.plugin);
      } catch (err) {
        errors.set(e.plugin, err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(slow);
        (done as (() => void) | null)?.();
      }
    })();
    pending.set(e.plugin, p);
    return p;
  };
  const entries = (plugins: Iterable<ModuleEntry | undefined>) => Promise.all([...new Set([...plugins].filter((x): x is ModuleEntry => !!x))].map(load)).then(() => undefined);
  return {
    loadContent: () => entries(o.list.filter((e) => e.data?.kinds?.some((k) => k.shape === "content"))),
    loadFor: (kinds) => entries([...kinds].map((k) => byKind.get(k))),
    loadPlugin: (plugin) => entries([o.list.find((e) => e.plugin === plugin)]),
    loaded: (plugin) => ok.has(plugin),
    failed: (plugin) => errors.get(plugin) ?? null,
    declarer: (kind) => byKind.get(kind),
  };
}
