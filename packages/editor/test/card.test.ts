import { describe, expect, it, vi } from "vitest";
import { LoroDoc, LoroText } from "loro-crdt";
import { elementsOf, insertCard, kind, listWith, page, sync, tick } from "./helpers";

const K = "@t/sketch/canvas";
/** A card plugin whose card view records what it was given. */
function recorder(seen: any[], fallback = (ctx: any) => ({ text: String((ctx.state as LoroText)?.toString?.() ?? "") })) {
  return { default: (api: any) => api.element({ kind: K, fallback, views: { card: (place: HTMLElement, ctx: any) => { place.textContent = "card"; seen.push({ data: ctx.data }); return { update: (c: any) => { seen.push({ data: c.data, text: (c.state as LoroText).toString() }); }, destroy() {} }; } } }) };
}

describe("card elements", () => {
  it("card_update_runs_on_remote_change", async () => {
    const seen: any[] = [];
    const a = await page({ list: listWith(kind(K, "@t/sketch")), modules: { "@t/sketch": recorder(seen) } });
    insertCard(a.engine.view, { blockId: "e1", kind: K, plugin: "@t/sketch" });
    await tick();
    const b = await page({ doc: (() => { const d = new LoroDoc(); a.doc.commit(); d.import(a.doc.export({ mode: "snapshot" })); return d; })(), list: listWith(kind(K, "@t/sketch")), modules: { "@t/sketch": recorder([]) } });
    const pos = (v: any) => { let p = -1; v.state.doc.descendants((n: any, at: number) => { if (n.attrs.blockId === "e1") p = at; }); return p; };
    b.handle.setAttrs(pos(b.engine.view), { data: { color: "red" } });
    (b.doc.getMap("elements").ensureMergeableText("e1") as LoroText).insert(0, "hello");
    sync(b.doc, a.doc);
    await tick(10);
    expect(seen.some((s) => s.data?.color === "red")).toBe(true);
    expect(seen.some((s) => s.text === "hello")).toBe(true);
    a.handle.destroy(); b.handle.destroy();
  });

  it("unknown_element_survives_remote_edits", async () => {
    const withIt = await page({ list: listWith(kind(K, "@t/sketch")), modules: { "@t/sketch": recorder([]) } });
    insertCard(withIt.engine.view, { blockId: "e1", kind: K, plugin: "@t/sketch", data: { color: "blue" } });
    await tick();
    const d2 = new LoroDoc(); withIt.doc.commit(); d2.import(withIt.doc.export({ mode: "snapshot" }));
    const without = await page({ doc: d2, list: listWith() });
    expect(without.place.querySelector(".nuah-missing")).not.toBeNull();
    // the side with the plugin changes the element and its state; the side without types elsewhere
    const pos = (v: any) => { let p = -1; v.state.doc.descendants((n: any, at: number) => { if (n.attrs.blockId === "e1") p = at; }); return p; };
    withIt.handle.setAttrs(pos(withIt.engine.view), { data: { color: "green" } });
    (withIt.doc.getMap("elements").ensureMergeableText("e1") as LoroText).insert(0, "shapes");
    without.engine.view.dispatch(without.engine.view.state.tr.insertText("typed", 1));
    sync(withIt.doc, without.doc);
    await tick(10);
    without.engine.view.dispatch(without.engine.view.state.tr.insertText("!", 1));
    await tick(1200);
    sync(withIt.doc, without.doc);
    expect(JSON.stringify(elementsOf(without.doc))).toBe(JSON.stringify(elementsOf(withIt.doc)));
    expect(elementsOf(without.doc)[0].attributes.data).toEqual({ color: "green" });
    expect(JSON.stringify((without.doc.toJSON() as any).elements)).toBe(JSON.stringify((withIt.doc.toJSON() as any).elements));
    withIt.handle.destroy(); without.handle.destroy();
  });

  it("concurrent_first_state_merges", async () => {
    const a = new LoroDoc(), b = new LoroDoc();
    (a.getMap("elements").ensureMergeableText("e1") as LoroText).insert(0, "A");
    (b.getMap("elements").ensureMergeableText("e1") as LoroText).insert(0, "B");
    sync(a, b);
    const t = (a.getMap("elements").ensureMergeableText("e1") as LoroText).toString();
    expect(t.length).toBe(2);
    expect(t).toContain("A"); expect(t).toContain("B");
    expect((b.getMap("elements").ensureMergeableText("e1") as LoroText).toString()).toBe(t);
  });

  it("fallback_written_after_settle_only_when_changed", async () => {
    const fallback = vi.fn((ctx: any) => ({ text: (ctx.state as LoroText).toString() }));
    const a = await page({ list: listWith(kind(K, "@t/sketch")), modules: { "@t/sketch": recorder([], fallback) } });
    insertCard(a.engine.view, { blockId: "e1", kind: K, plugin: "@t/sketch" });
    await tick();
    (a.doc.getMap("elements").ensureMergeableText("e1") as LoroText).insert(0, "flow A to B");
    a.doc.commit();
    await tick(1200);
    expect(elementsOf(a.doc)[0].attributes.fallback).toEqual({ text: "flow A to B" });
    const before = a.doc.oplogVersion().toJSON();
    a.handle.setAttrs(1, {}); // nothing changed
    await tick(1200);
    expect(a.doc.oplogVersion().toJSON()).toEqual(before);
    a.handle.destroy();
  });

  it("missing_known_plugin_shows_enable_for_allowed", async () => {
    const seed = await page({ list: listWith(kind(K, "@t/sketch")), modules: { "@t/sketch": recorder([]) } });
    insertCard(seed.engine.view, { blockId: "e1", kind: K, plugin: "@t/sketch" });
    await tick();
    for (const [canEnable, label] of [[true, "Enable"], [false, "Ask an admin"]] as const) {
      const d = new LoroDoc(); seed.doc.commit(); d.import(seed.doc.export({ mode: "snapshot" }));
      const enable = vi.fn(async () => {});
      const p = await page({ doc: d, list: listWith(), hooks: { needsPlugin: () => ({ known: true, canEnable, enable }) } });
      const bar = p.place.querySelector(".nuah-missing")!;
      expect(bar.textContent).toContain("@t/sketch");
      expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toContain(label);
      if (canEnable) { (bar.querySelector("button") as HTMLButtonElement).click(); expect(enable).toHaveBeenCalled(); }
      p.handle.destroy();
    }
    seed.handle.destroy();
  });

  it("missing_unknown_plugin_shows_raw_button", async () => {
    const seed = await page({ list: listWith(kind(K, "@t/sketch")), modules: { "@t/sketch": recorder([]) } });
    insertCard(seed.engine.view, { blockId: "e1", kind: K, plugin: "@t/sketch", data: { color: "blue" } });
    await tick();
    const d = new LoroDoc(); seed.doc.commit(); d.import(seed.doc.export({ mode: "snapshot" }));
    const p = await page({ doc: d, list: listWith() });
    const bar = p.place.querySelector(".nuah-missing")!;
    expect(bar.textContent).toContain("This element needs a plugin to be viewed");
    const raw = [...bar.querySelectorAll("button")].find((b) => b.textContent === "View raw data")!;
    raw.click();
    expect(p.ui.modal).toHaveBeenCalled();
    const host = document.createElement("div");
    (p.ui.modal.mock.calls[0] as any)[1](host, () => {});
    expect(host.textContent).toContain('"color": "blue"');
    p.handle.destroy(); seed.handle.destroy();
  });

  it("newer_version_opens_read_only", async () => {
    const seen: any[] = [];
    const p = await page({ list: listWith(kind(K, "@t/sketch", 1)), modules: { "@t/sketch": recorder(seen) } });
    insertCard(p.engine.view, { blockId: "e1", kind: K, plugin: "@t/sketch", v: 3 });
    await tick();
    expect(p.place.textContent).toContain("This element is newer than its plugin (@t/sketch)");
    expect(seen.length).toBe(0);
    p.handle.destroy();
  });

  it("failed_module_shows_fallback_and_page_stays_editable", async () => {
    const seed = await page({ list: listWith(kind(K, "@t/sketch")), modules: { "@t/sketch": recorder([]) } });
    insertCard(seed.engine.view, { blockId: "e1", kind: K, plugin: "@t/sketch", fallback: { text: "a sketch of the plan" } });
    await tick();
    const d = new LoroDoc(); seed.doc.commit(); d.import(seed.doc.export({ mode: "snapshot" }));
    const p = await page({ doc: d, list: listWith(kind(K, "@t/sketch")), modules: { "@t/sketch": new Error("404") } });
    await tick(10);
    expect(p.place.textContent).toContain("a sketch of the plan");
    expect(p.place.textContent).toContain("Could not load @t/sketch");
    p.engine.view.dispatch(p.engine.view.state.tr.insertText("still typing", 1));
    expect(p.engine.text()).toContain("still typing");
    p.handle.destroy(); seed.handle.destroy();
  });

  it("a_module_that_loads_without_the_kind_shows_the_fallback_and_does_not_loop", async () => {
    let registered = 0;
    const other = { default: (api: any) => { registered++; api.element({ kind: "@t/sketch/other" }); } };
    const p = await page({ list: listWith(kind(K, "@t/sketch")), modules: { "@t/sketch": other } });
    insertCard(p.engine.view, { blockId: "e1", kind: K, plugin: "@t/sketch", fallback: { text: "a sketch of the plan" } });
    await tick(20);
    expect(p.place.textContent).toContain("a sketch of the plan");
    expect(p.place.textContent).toContain("Could not load @t/sketch");
    expect(registered).toBe(1);
    p.handle.destroy();
  });

  it("older_version_upgraded_on_open", async () => {
    const seen: any[] = [];
    const mod = { default: (api: any) => api.element({ kind: K, upgrade: { 1: (d: any) => ({ ...d, colour: d.color, color: undefined }), 2: (d: any) => ({ ...d, size: d.size ?? "m" }) },
      views: { card: (_p: HTMLElement, ctx: any) => { seen.push(ctx.data); return { update: (c: any) => seen.push(c.data), destroy() {} }; } } }) };
    const p = await page({ list: listWith(kind(K, "@t/sketch", 3)), modules: { "@t/sketch": mod } });
    insertCard(p.engine.view, { blockId: "e1", kind: K, plugin: "@t/sketch", v: 1, data: { color: "red" } });
    await tick(10);
    const el = elementsOf(p.doc)[0].attributes;
    expect(el.v).toBe(3);
    expect(el.data).toEqual({ colour: "red", size: "m" });
    p.handle.destroy();
  });
});
