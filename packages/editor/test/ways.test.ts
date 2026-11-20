import { describe, expect, it, vi } from "vitest";
import { LoroText } from "loro-crdt";
import { Slice } from "prosemirror-model";
import { elementsOf, insertCard, kind, listWith, page, tick } from "./helpers";

const D = "@t/diagram/chart", S = "@t/sketch/canvas";
const card = (k: string, ways: any = {}, extra: any = {}) => ({ default: (api: any) => api.element({ kind: k, ways, views: { card: (p: HTMLElement) => { p.textContent = k; return { update() {}, destroy() {} }; }, ...(extra.views ?? {}) }, ...extra }) });
const typeText = (v: any, text: string) => { for (const ch of text) { const s = v.state; const handled = v.someProp("handleTextInput", (f: any) => f(v, s.selection.from, s.selection.to, ch)); if (!handled) v.dispatch(v.state.tr.insertText(ch)); } };
const key = (v: any, k: string) => v.someProp("handleKeyDown", (f: any) => f(v, new KeyboardEvent("keydown", { key: k })));

describe("ways in", () => {
  it("slash_lists_kinds_from_plugins", async () => {
    const p = await page({ list: listWith(kind(D, "@t/diagram", 1, { label: { en: "Diagram", ar: "مخطط" }, group: "media" }), kind(S, "@t/sketch", 1, { label: { en: "Sketch" } })), modules: { "@t/diagram": card(D), "@t/sketch": card(S) } });
    const v = p.engine.view;
    typeText(v, "/");
    const menu = () => document.querySelector(".nuah-slash");
    expect(menu()?.textContent).toContain("Diagram");
    expect(menu()?.textContent).toContain("Sketch");
    typeText(v, "diag");
    expect(menu()?.textContent).toContain("Diagram");
    expect(menu()?.textContent).not.toContain("Sketch");
    key(v, "Enter");
    await tick(10);
    expect(elementsOf(p.doc).map((e) => e.attributes.kind)).toEqual([D]);
    expect(p.engine.text()).not.toContain("/diag");
    expect(menu()).toBeNull();
    p.handle.destroy();
  });

  it("shortcut_makes_element", async () => {
    const p = await page({ list: listWith(kind(D, "@t/diagram")), modules: { "@t/diagram": card(D, { shortcuts: [{ match: "```mermaid", init: () => ({ data: { from: "shortcut" } }) }] }) } });
    await p.loader.loadFor(new Set([D]));
    const v = p.engine.view;
    v.dispatch(v.state.tr.insertText("```mermaid", 1));
    key(v, "Enter");
    await tick(10);
    const els = elementsOf(p.doc);
    expect(els.map((e) => [e.attributes.kind, e.attributes.data])).toEqual([[D, { from: "shortcut" }]]);
    expect(p.engine.text()).not.toContain("```");
    p.handle.destroy();
  });

  it("file_with_two_openers_asks_once", async () => {
    const make = (who: string) => async () => ({ data: { by: who } });
    const p = await page({
      list: listWith(kind(D, "@t/diagram", 1, { accepts: [".csv"] }), kind(S, "@t/sketch", 1, { accepts: ["text/csv"] })),
      modules: { "@t/diagram": card(D, { files: [{ accept: [".csv"], make: make("diagram") }] }), "@t/sketch": card(S, { files: [{ accept: ["text/csv"], make: make("sketch") }] }) },
    });
    (p.ui.menu as any).mockImplementation((_x: number, _y: number, items: any[]) => items.find((i) => i.label.includes("sketch")).onclick());
    const file = () => new File(["a,b\n1,2"], "data.csv", { type: "text/csv" });
    await p.host.files!([file()], 1);
    await p.host.files!([file()], 1);
    await tick(10);
    expect(p.ui.menu).toHaveBeenCalledTimes(1);
    expect(elementsOf(p.doc).map((e) => e.attributes.data.by)).toEqual(["sketch", "sketch"]);
    p.handle.destroy();
  });

  it("key_clash_first_plugin_wins", async () => {
    const first = vi.fn(() => true), second = vi.fn(() => true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = await page({ list: listWith(kind(D, "@t/diagram"), kind(S, "@t/sketch")), modules: { "@t/diagram": card(D, { keys: { "Mod-Shift-d": first } }), "@t/sketch": card(S, { keys: { "Mod-Shift-d": second } }) } });
    await p.loader.loadFor(new Set([D, S]));
    p.host.refreshWays!();
    p.engine.view.someProp("handleKeyDown", (f: any) => f(p.engine.view, new KeyboardEvent("keydown", { key: "d", shiftKey: true, ctrlKey: true })));
    expect(first).toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("Mod-Shift-d")).length).toBe(1);
    warn.mockRestore();
    p.handle.destroy();
  });

  it("page_undo_skips_full_view_changes", async () => {
    let fullCtx: any;
    const p = await page({ list: listWith(kind(S, "@t/sketch")), modules: { "@t/sketch": card(S, {}, { views: { full: (_el: HTMLElement, ctx: any) => { fullCtx = ctx; return { update() {}, destroy() {} }; } } }) } });
    (p.ui.modal as any).mockImplementation((_t: string, render: any) => { render(document.createElement("div"), () => {}); return () => {}; });
    const v = p.engine.view;
    v.dispatch(v.state.tr.insertText("typed", 1));
    p.doc.commit();
    insertCard(v, { blockId: "e1", kind: S, plugin: "@t/sketch" });
    await tick(10);
    p.host.openFull!("e1");
    (fullCtx.state as LoroText).insert(0, "drawn");
    fullCtx.commit();
    await tick(10);
    p.engine.undo(); await tick(10);
    p.engine.undo(); await tick(10);
    expect((p.doc.getMap("elements").get("e1") as LoroText).toString()).toBe("drawn");
    expect(p.engine.text()).not.toContain("typed");
    p.handle.destroy();
  });

  it("paste_card_copies_state_with_new_id", async () => {
    const p = await page({ list: listWith(kind(S, "@t/sketch")), modules: { "@t/sketch": card(S) } });
    const v = p.engine.view;
    insertCard(v, { blockId: "e1", kind: S, plugin: "@t/sketch", data: { ink: "blue" } });
    (p.doc.getMap("elements").ensureMergeableText("e1") as LoroText).insert(0, "original");
    p.doc.commit();
    await tick(10);
    let at = -1; v.state.doc.descendants((n, pos) => { if (n.attrs.blockId === "e1") at = pos; });
    let slice: Slice = v.state.doc.slice(at, at + 1);
    slice = v.someProp("transformCopied", (f: any) => f(slice, v)) ?? slice;
    slice = v.someProp("transformPasted", (f: any) => f(slice, v, false)) ?? slice;
    v.dispatch(v.state.tr.insert(v.state.doc.content.size, slice.content));
    await tick(10);
    const els = elementsOf(p.doc);
    expect(els.length).toBe(2);
    const copy = els[1].attributes;
    expect(copy.blockId).not.toBe("e1");
    expect(copy.data).toEqual({ ink: "blue" });
    expect(copy.copy).toBeUndefined();
    const copied = p.doc.getMap("elements").get(copy.blockId) as LoroText;
    expect(copied.toString()).toBe("original");
    copied.insert(0, "changed ");
    p.doc.commit();
    expect((p.doc.getMap("elements").get("e1") as LoroText).toString()).toBe("original");
    p.handle.destroy();
  });
});

describe("commands for plugins", () => {
  it("insert_inline_and_replace_a_block", async () => {
    const { commandsFor } = await import("../src/commands");
    const p = await page({ list: listWith() });
    const v = p.engine.view;
    v.dispatch(v.state.tr.insertText("hello ", 1));
    const c = commandsFor(v, p.host);
    c.insertInline([{ type: "text", text: "world" }]);
    expect(p.engine.text()).toBe("hello world");
    const id = v.state.doc.child(0).attrs.blockId;
    c.replaceBlock(id, { type: "paragraph", content: [{ type: "text", text: "replaced" }] });
    expect(p.engine.text()).toBe("replaced");
    p.handle.destroy();
  });

  it("block_menu_items_get_the_commands", async () => {
    const seen: unknown[] = [];
    const mod = { default: (api: any) => { api.element({ kind: "@t/m/none" }); api.menu((b: any, c: any) => { seen.push([b.blockId, typeof c?.replaceBlock]); return []; }); } };
    const p = await page({ list: listWith(kind("@t/m/none", "@t/m")), modules: { "@t/m": mod } });
    await p.loader.loadFor(new Set(["@t/m/none"]));
    const v = p.engine.view;
    v.dispatch(v.state.tr.insertText("x", 1));
    const { menuFor } = await import("../src/surfaces");
    menuFor(v, p.host, new Map(), v.state.doc.child(0).attrs.blockId);
    expect(seen).toEqual([[v.state.doc.child(0).attrs.blockId, "function"]]);
    p.handle.destroy();
  });
});

describe("ways in for content elements", () => {
  it("a_file_rule_may_insert_a_node", async () => {
    const mod = { default: (api: any) => api.element({ kind: "@t/pic/image", nodes: [{ id: "pic", group: "block", atom: true, ids: true, attrs: { src: { default: "" } } }], ways: { files: [{ accept: ["image/png"], make: async () => ({ node: { type: "pic", attrs: { src: "/files/f1" } } }) }] } }) };
    const p = await page({ list: { kinds: [...listWith().kinds, { kind: "@t/pic/image", version: 1, shape: "content", placement: "block", label: { en: "Picture" }, plugin: "@t/pic", module: "/plugins/t/pic/index.js", openers: ["@t/pic"], default: null, accepts: ["image/png"] } as never], runners: [] }, modules: { "@t/pic": mod } });
    await p.host.files!([new File(["x"], "a.png", { type: "image/png" })], 1);
    expect(JSON.stringify(p.handle.json())).toContain('"src":"/files/f1"');
    p.handle.destroy();
  });
});

describe("the slash menu's order", () => {
  const item = (id: string, label: string, group: string, keywords = "") => ({ id, label, group, keywords: `${keywords} ${label}`.toLowerCase(), run: () => {} });
  it("puts_the_best_match_first_so_enter_picks_it_and_keeps_groups_together", async () => {
    const { filterItems } = await import("../src/slash");
    const items = [
      item("link", "Link to a page or task", "links", "mention ref"),
      item("task", "Task", "list", "todo"),
      item("check", "Checklist", "list", "task todo"),
      item("quote", "Quote", "text"),
    ];
    expect(filterItems(items, "task").map((i) => i.id)).toEqual(["task", "check", "link"]);
    // with nothing typed, the order is the plugins' own
    expect(filterItems(items, "").map((i) => i.id)).toEqual(["link", "task", "check", "quote"]);
  });
});
