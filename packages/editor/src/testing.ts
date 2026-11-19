// SPDX-License-Identifier: Apache-2.0
/**
 * The compliance suite every element plugin runs (ADR 0094 decision 12), against the real editor host and real Loro, in jsdom:
 * save and reload; the element untouched while its plugin is off; a Fallback written; upgrade from each older version; Arabic and
 * right-to-left; two people editing it at once converge. A plugin calls `runElementCompliance` from its own tests with its own vitest.
 */
import type { describe as Describe, expect as Expect, it as It } from "vitest";
import { LoroDoc } from "loro-crdt";
import type { ElementKindDecl } from "@nuah/editor-core";
import type { ElementCtx, ElementDef } from "@nuah/editor-api";
import { resetSharedForTests } from "@nuah/browser-kit";
import { open, type ElementsList, type FaceHooks, type Mounted } from "./face";
import { stateJson } from "./state";

export interface Harness { describe: typeof Describe; it: typeof It; expect: typeof Expect }
export interface Sample {
  /** A card: its settings and what to put in its new container. */
  data?: Record<string, unknown>;
  fill?: (state: unknown) => void;
  /** A second, concurrent change by another person (for the converge check): settings and state. */
  other?: { data?: Record<string, unknown>; fill?: (state: unknown) => void };
  /** A content element: the node as JSON. */
  node?: unknown;
}
export interface PluginUnderTest {
  plugin: string;
  module: { default: unknown };
  kinds: ElementKindDecl[];
  samples: Record<string, Sample>;
  /** Content plugins the samples need besides this one (the basic text, when the plugin is not it). */
  with?: { plugin: string; module: { default: unknown }; kinds: ElementKindDecl[] }[];
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const noop = () => {};
export const testUi = () => ({ menu: noop, popover: () => noop, modal: () => noop, toast: noop, loading: () => noop, askText: async () => null, askUrl: async () => null, icon: () => null });

export const BASIC = {
  plugin: "@nuah/editor-basic",
  module: { default: (api: { element(d: ElementDef): void }) => api.element({ kind: "@nuah/editor-basic/paragraph", nodes: [{ id: "paragraph", group: "block", content: "inline*", ids: true, dom: { tag: "p" } }] }) },
  kinds: [{ kind: "@nuah/editor-basic/paragraph", version: 1, shape: "content", placement: "block", label: { en: "Text" } }] as ElementKindDecl[],
};

function listOf(mods: { plugin: string; kinds: ElementKindDecl[] }[]): ElementsList {
  return { kinds: mods.flatMap((m) => m.kinds.map((k) => ({ ...k, plugin: m.plugin, module: `/plugins/${m.plugin.slice(1)}/index.js`, openers: [m.plugin], default: null }))), runners: [] };
}

/** A page through the real mount, with exactly these plugins' modules. */
export async function openPage(mods: { plugin: string; module: { default: unknown }; kinds: ElementKindDecl[] }[], o: { doc?: LoroDoc; lang?: string; hooks?: Partial<FaceHooks>; declared?: { plugin: string; kinds: ElementKindDecl[] }[] } = {}): Promise<Mounted & { doc: LoroDoc; place: HTMLElement }> {
  resetSharedForTests();
  const doc = o.doc ?? new LoroDoc();
  const importer = async (url: string) => {
    const m = mods.find((x) => url.includes(x.plugin.slice(1) + "/"));
    if (!m) throw new Error(`no module at ${url}`);
    return m.module as { default?: unknown };
  };
  const place = document.createElement("div");
  document.body.append(place);
  const m = await open(place, { ui: testUi(), lang: o.lang ?? "en", editable: true, live: { doc }, elements: async () => listOf(o.declared ?? mods), importer, ...o.hooks } as FaceHooks);
  await tick();
  return { ...m, doc, place };
}

export const copyOf = (d: LoroDoc) => { d.commit(); const c = new LoroDoc(); c.import(d.export({ mode: "snapshot" })); return c; };
export const sync = (a: LoroDoc, b: LoroDoc) => { a.commit(); b.commit(); b.import(a.export({ mode: "update", from: b.oplogVersion() })); a.import(b.export({ mode: "update", from: a.oplogVersion() })); };
const childrenOf = (d: LoroDoc) => (((d.toJSON() as Record<string, any>).doc?.children ?? []) as any[]);
const find = (m: Mounted, blockId: string) => { let p = -1; m.engine.view.state.doc.descendants((n, at) => { if (n.attrs.blockId === blockId) p = at; }); return p; };

/** Puts a sample element on the page and returns its id. */
export function insertSample(m: Mounted & { doc: LoroDoc }, decl: ElementKindDecl, plugin: string, s: Sample, v = decl.version): string {
  const view = m.engine.view;
  // a first line of its own, so the sample goes after it and "typing elsewhere" has somewhere to go
  if (view.state.doc.firstChild?.isTextblock && view.state.doc.firstChild.content.size === 0) view.dispatch(view.state.tr.insertText("first line", 1));
  if (decl.shape === "content") {
    const id = "c" + Math.random().toString(36).slice(2, 10);
    const n = s.node as { attrs?: Record<string, unknown> };
    m.handle.insert({ ...n, attrs: { ...(n.attrs ?? {}), blockId: id } });
    m.doc.commit();
    return id;
  }
  const id = "c" + Math.random().toString(36).slice(2, 10);
  const type = decl.placement === "inline" ? "elementInline" : "element";
  const node = view.state.schema.nodes[type]!.create({ blockId: id, kind: decl.kind, v, plugin, data: s.data ?? {}, fallback: null });
  if (type === "element") view.dispatch(view.state.tr.insert(view.state.doc.content.size, node));
  else view.dispatch(view.state.tr.insert(1, node));
  if (s.fill && decl.state) {
    const map = m.doc.getMap("elements") as unknown as Record<string, (k: string) => unknown>;
    const fn = { text: "ensureMergeableText", map: "ensureMergeableMap", list: "ensureMergeableList", movableList: "ensureMergeableMovableList", tree: "ensureMergeableTree" }[decl.state];
    s.fill(map[fn]!.call(map, id));
  }
  m.doc.commit();
  return id;
}

/** Wraps a module so the suite sees every context its card views get. */
function spying(mod: { default: unknown }, seen: ElementCtx[]) {
  return { default: (api: { element(d: ElementDef): void }) => (mod.default as (a: unknown) => void)({ ...api, element: (d: ElementDef) => api.element({ ...d, views: d.views?.card ? { ...d.views, card: (p, c) => { seen.push(c); const v = d.views!.card!(p, c); return { update: (x) => { seen.push(x); v.update(x); }, destroy: () => v.destroy() }; } } : d.views }) }) };
}

export function runElementCompliance(p: PluginUnderTest, { describe, it, expect }: Harness) {
  const others = p.with ?? (p.plugin === BASIC.plugin ? [] : [BASIC]);
  const all = (mod = p.module) => [...others, { plugin: p.plugin, module: mod, kinds: p.kinds }];
  for (const decl of p.kinds) {
    const s = p.samples[decl.kind];
    if (!s) continue;
    describe(`${decl.kind} (element compliance, ADR 0094)`, () => {
      it("is saved and reloaded unchanged", async () => {
        const a = await openPage(all());
        const id = insertSample(a, decl, p.plugin, s);
        await tick(10);
        const b = await openPage(all(), { doc: copyOf(a.doc) });
        expect(b.handle.json()).toEqual(a.handle.json());
        expect(stateJson(b.doc, id)).toEqual(stateJson(a.doc, id));
        a.handle.destroy(); b.handle.destroy();
      });
      it("is left untouched while its plugin is off", async () => {
        const a = await openPage(all());
        const id = insertSample(a, decl, p.plugin, s);
        await tick(1100);
        const before = JSON.stringify(childrenOf(a.doc).find((c) => JSON.stringify(c).includes(id)));
        const stateBefore = JSON.stringify(stateJson(a.doc, id));
        const off = await openPage(others, { doc: copyOf(a.doc), declared: others });
        const v = off.engine.view;
        v.dispatch(v.state.tr.insertText("typed elsewhere ", 1));
        await tick(1100);
        off.doc.commit();
        expect(JSON.stringify(childrenOf(off.doc).find((c) => JSON.stringify(c).includes(id)))).toBe(before);
        expect(JSON.stringify(stateJson(off.doc, id))).toBe(stateBefore);
        a.handle.destroy(); off.handle.destroy();
      });
      if (decl.shape === "card") {
        it("keeps a Fallback for when it cannot be drawn", async () => {
          const a = await openPage(all());
          const id = insertSample(a, decl, p.plugin, s);
          await tick(1100);
          const fb = a.engine.view.state.doc.nodeAt(find(a, id))?.attrs.fallback;
          expect(typeof fb?.text).toBe("string");
          a.handle.destroy();
        });
        it("is drawn right to left in Arabic", async () => {
          const seen: ElementCtx[] = [];
          const a = await openPage(all(spying(p.module, seen)), { lang: "ar" });
          insertSample(a, decl, p.plugin, s);
          await tick(10);
          expect(seen.length).toBeGreaterThan(0);
          expect(seen.every((c) => c.lang === "ar" && c.dir === "rtl")).toBe(true);
          a.handle.destroy();
        });
        it("converges when two people change it at once", async () => {
          const a = await openPage(all());
          const id = insertSample(a, decl, p.plugin, s);
          await tick(10);
          const b = await openPage(all(), { doc: copyOf(a.doc) });
          const o = s.other ?? { data: { "x:compliance": 1 } };
          a.handle.setAttrs(find(a, id), { data: { ...(a.engine.view.state.doc.nodeAt(find(a, id))!.attrs.data), ...(s.data ?? {}), "x:a": 1 } });
          b.handle.setAttrs(find(b, id), { data: { ...(b.engine.view.state.doc.nodeAt(find(b, id))!.attrs.data), ...(o.data ?? {}) } });
          if (o.fill && decl.state) o.fill((b.doc.getMap("elements") as any).get(id));
          sync(a.doc, b.doc);
          await tick(10);
          expect(JSON.stringify(childrenOf(a.doc))).toBe(JSON.stringify(childrenOf(b.doc)));
          expect(stateJson(a.doc, id)).toEqual(stateJson(b.doc, id));
          a.handle.destroy(); b.handle.destroy();
        });
      }
      it("upgrades from each older version", async () => {
        const mod = p.module as { default: (api: unknown) => void };
        let def: ElementDef | undefined;
        mod.default({ version: "1.0.0", element: (d: ElementDef) => { if (d.kind === decl.kind) def = d; }, runner() {}, lang: () => "en", ui: testUi(), call: async () => null, files: { upload: async () => "" } });
        const steps = Object.keys(def?.upgrade ?? {}).map(Number);
        for (const from of steps) {
          if (decl.shape !== "card") continue;
          const a = await openPage(all());
          const id = insertSample(a, decl, p.plugin, s, from);
          await tick(10);
          expect(a.engine.view.state.doc.nodeAt(find(a, id))?.attrs.v).toBe(decl.version);
          a.handle.destroy();
        }
      });
    });
  }
}
