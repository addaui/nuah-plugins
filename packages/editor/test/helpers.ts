// Shared by the host's tests: a page with a basic paragraph plugin and test card plugins, opened through the real mount.
import { vi } from "vitest";
import { LoroDoc } from "loro-crdt";
import { open, type FaceHooks, type ElementsList } from "../src/face";
import { resetSharedForTests } from "@nuah/browser-kit";

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export const ui = () => ({ menu: vi.fn(), popover: vi.fn(() => () => {}), modal: vi.fn(() => () => {}), toast: vi.fn(), loading: vi.fn(() => () => {}), askText: vi.fn(), askUrl: vi.fn(), icon: () => null });

const basicModule = { default: (api: any) => api.element({ kind: "@nuah/editor-basic/paragraph", nodes: [{ id: "paragraph", group: "block", content: "inline*", ids: true, dom: { tag: "p" } }] }) };
export const kind = (k: string, plugin: string, version = 1, extra: Record<string, unknown> = {}) => ({ kind: k, version, shape: "card", placement: "block", label: { en: k }, plugin, module: `/plugins/${plugin.slice(1)}/index.js`, openers: [plugin], default: null, state: "text", ...extra });
export function listWith(...cards: ReturnType<typeof kind>[]): ElementsList {
  return { kinds: [{ kind: "@nuah/editor-basic/paragraph", version: 1, shape: "content", placement: "block", label: { en: "Text" }, plugin: "@nuah/editor-basic", module: "/plugins/nuah/editor-basic/index.js", openers: ["@nuah/editor-basic"], default: null } as never, ...(cards as never[])], runners: [] };
}
export async function page(o: { doc?: LoroDoc; list?: ElementsList; modules?: Record<string, unknown>; hooks?: Partial<FaceHooks> } = {}) {
  resetSharedForTests();
  const doc = o.doc ?? new LoroDoc();
  const u = ui();
  const importer = vi.fn(async (url: string) => {
    if (url.includes("editor-basic")) return basicModule;
    const plugin = Object.keys(o.modules ?? {}).find((p) => url.includes(p.slice(1)));
    if (!plugin) throw new Error(`no module at ${url}`);
    const m = (o.modules ?? {})[plugin];
    if (m instanceof Error) throw m;
    return m as { default: unknown };
  });
  const place = document.createElement("div");
  document.body.append(place);
  const m = await open(place, { ui: u, lang: "en", editable: true, live: { doc }, elements: async () => o.list ?? listWith(), importer, ...o.hooks } as FaceHooks);
  await tick();
  return { ...m, doc, ui: u, place, importer };
}
/** Inserts a card element at the end of the page. */
export function insertCard(v: any, attrs: Record<string, unknown>) {
  const s = v.state;
  v.dispatch(s.tr.insert(s.doc.content.size, s.schema.nodes.element.create({ data: {}, fallback: null, v: 1, ...attrs })));
}
export const sync = (a: LoroDoc, b: LoroDoc) => { a.commit(); b.commit(); b.import(a.export({ mode: "update", from: b.oplogVersion() })); a.import(b.export({ mode: "update", from: a.oplogVersion() })); };
export const elementsOf = (d: LoroDoc) => ((d.toJSON() as any).doc.children as any[]).filter((c) => c.nodeName === "element");
