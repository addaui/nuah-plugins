import { describe, expect, it, vi } from "vitest";
import { LoroText } from "loro-crdt";
import { Slice } from "prosemirror-model";
import { NodeSelection, TextSelection } from "prosemirror-state";
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

  it("copy_and_paste_through_the_clipboard_html_keeps_the_card_and_copies_its_state", async () => {
    const p = await page({ list: listWith(kind(S, "@t/sketch")), modules: { "@t/sketch": card(S) } });
    const v = p.engine.view;
    insertCard(v, { blockId: "e1", kind: S, plugin: "@t/sketch", data: { ink: "blue" } });
    (p.doc.getMap("elements").ensureMergeableText("e1") as LoroText).insert(0, "original");
    p.doc.commit();
    await tick(10);
    let at = -1; v.state.doc.descendants((n, pos) => { if (n.attrs.blockId === "e1") at = pos; });
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, at)));
    const { dom } = (v as any).serializeForClipboard(v.state.selection.content());
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));
    (v as any).pasteHTML(dom.innerHTML, new Event("paste"));
    await tick(10);
    const els = elementsOf(p.doc);
    expect(els.length).toBe(2);
    const ids = els.map((e: any) => e.attributes.blockId);
    const copyId = ids.find((i: string) => i !== "e1");
    expect(copyId).toBeTruthy();
    expect(els.find((e: any) => e.attributes.blockId === copyId).attributes.data).toEqual({ ink: "blue" });
    expect((p.doc.getMap("elements").get(copyId) as LoroText).toString()).toBe("original");
    p.handle.destroy();
  });

  it("dragging_a_card_to_move_it_keeps_its_id_and_its_state", async () => {
    const p = await page({ list: listWith(kind(S, "@t/sketch")), modules: { "@t/sketch": card(S) } });
    const v = p.engine.view;
    v.dispatch(v.state.tr.insertText("a", 1));
    insertCard(v, { blockId: "e1", kind: S, plugin: "@t/sketch" });
    (p.doc.getMap("elements").ensureMergeableText("e1") as LoroText).insert(0, "drawn");
    p.doc.commit();
    await tick(10);
    let at = -1; v.state.doc.descendants((n, pos) => { if (n.attrs.blockId === "e1") at = pos; });
    let slice: Slice = v.state.doc.slice(at, at + 1);
    slice = v.someProp("transformCopied", (f: any) => f(slice, v)) ?? slice;
    (v as any).dragging = { slice, move: true };
    slice = v.someProp("transformPasted", (f: any) => f(slice, v, false)) ?? slice;
    (v as any).dragging = null;
    v.dispatch(v.state.tr.delete(at, at + 1).insert(0, slice.content));
    await tick(10);
    const els = elementsOf(p.doc);
    expect(els.map((e: any) => e.attributes.blockId)).toEqual(["e1"]);
    expect((p.doc.getMap("elements").get("e1") as LoroText).toString()).toBe("drawn");
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

  it("say_where_on_screen_the_insertion_happens_so_a_picker_opens_there", async () => {
    const { commandsFor } = await import("../src/commands");
    const p = await page({ list: listWith() });
    const v = p.engine.view;
    v.dispatch(v.state.tr.insertText("hi", 1));
    const asked: number[] = [];
    // jsdom lays nothing out: the view's own measure stands in
    (v as any).coordsAtPos = (pos: number) => { asked.push(pos); return { left: 40, right: 40, top: 100, bottom: 118 }; };
    expect(commandsFor(v, p.host).spot()).toEqual({ left: 40, top: 100, bottom: 118 });
    expect(asked).toEqual([v.state.selection.from]);
    expect(commandsFor(v, p.host, 1).spot()).toEqual({ left: 40, top: 100, bottom: 118 });
    expect(asked.at(-1)).toBe(1);
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
    // with nothing typed: the usual order (text, lists, ...), each group once
    expect(filterItems(items, "").map((i) => i.id)).toEqual(["quote", "task", "check", "link"]);
    const mixed = [item("sketch", "Sketch", "media"), item("task", "Task", "list"), item("image", "Image", "media"), item("bullets", "Bullet list", "list")];
    expect(filterItems(mixed, "").map((i) => i.id)).toEqual(["task", "bullets", "sketch", "image"]);
  });
});

describe("deleting next to a card", () => {
  const setup = async () => {
    const p = await page({ list: listWith(kind(S, "@t/sketch")), modules: { "@t/sketch": card(S) } });
    const v = p.engine.view;
    v.dispatch(v.state.tr.insertText("a", 1));
    insertCard(v, { blockId: "e1", kind: S, plugin: "@t/sketch" });
    const s = v.state;
    v.dispatch(s.tr.insert(s.doc.content.size, s.schema.nodes.paragraph.create(null, s.schema.text("b"))));
    await tick();
    return { p, v };
  };
  const cards = (v: any) => { const n: string[] = []; v.state.doc.forEach((c: any) => { if (c.type.name === "element") n.push(c.attrs.blockId); }); return n; };

  it("delete_at_the_end_of_a_line_selects_the_card_after_it_first", async () => {
    const { p, v } = await setup();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 2)));
    key(v, "Delete");
    expect(cards(v)).toEqual(["e1"]);
    expect((v.state.selection as any).node?.attrs.blockId).toBe("e1");
    key(v, "Delete");
    expect(cards(v)).toEqual([]);
    p.handle.destroy();
  });

  it("backspace_at_the_start_of_a_line_selects_the_card_before_it_first", async () => {
    const { p, v } = await setup();
    const start = v.state.doc.content.size - 2; // inside the last paragraph, before "b"
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, start)));
    key(v, "Backspace");
    expect(cards(v)).toEqual(["e1"]);
    expect((v.state.selection as any).node?.attrs.blockId).toBe("e1");
    p.handle.destroy();
  });
});

describe("where the slash menu opens", () => {
  const caret = { left: 900, right: 900, top: 200, bottom: 218 };
  const size = { width: 260, height: 300 };
  const screen = { width: 1024, height: 768 };
  it("starts_at_the_caret_in_the_lines_direction_and_stays_on_screen", async () => {
    const { placeMenu } = await import("../src/slash");
    // right to left: the menu's right edge at the caret
    expect(placeMenu(caret, size, screen, true)).toEqual({ left: 640, top: 222 });
    // left to right near the edge: pulled back inside
    expect(placeMenu(caret, size, screen, false)).toEqual({ left: 1024 - 260 - 8, top: 222 });
    // no room below: above the line
    expect(placeMenu({ ...caret, top: 600, bottom: 618 }, size, screen, false).top).toBe(600 - 300 - 4);
  });
});

describe("typing while a card is selected", () => {
  it("starts_a_new_line_after_the_card_and_keeps_the_card", async () => {
    const p = await page({ list: listWith(kind(S, "@t/sketch")), modules: { "@t/sketch": card(S) } });
    const v = p.engine.view;
    insertCard(v, { blockId: "e1", kind: S, plugin: "@t/sketch" });
    await tick();
    let at = -1; v.state.doc.descendants((n, pos) => { if (n.attrs.blockId === "e1") at = pos; });
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, at)));
    typeText(v, "/x");
    const names: string[] = []; v.state.doc.forEach((n: any) => names.push(n.type.name + (n.isTextblock ? ":" + n.textContent : "")));
    expect(names).toContain("element");
    expect(names[names.indexOf("element") + 1]).toBe("paragraph:/x");
    p.handle.destroy();
  });
});

describe("the line after the last element", () => {
  it("shows_when_the_page_ends_with_a_card_and_a_click_adds_a_line_there", async () => {
    const p = await page({ list: listWith(kind(S, "@t/sketch")), modules: { "@t/sketch": card(S) } });
    const v = p.engine.view;
    const tail = () => p.place.querySelector(".nuah-tail") as HTMLElement | null;
    expect(tail()?.hidden).toBe(true); // an empty page ends with an empty line already
    insertCard(v, { blockId: "e1", kind: S, plugin: "@t/sketch" });
    await tick();
    v.dispatch(v.state.tr.delete(0, v.state.doc.child(0).nodeSize)); // only the card is left
    expect(v.state.doc.lastChild!.type.name).toBe("element");
    expect(tail()!.hidden).toBe(false);
    tail()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(v.state.doc.lastChild!.type.name).toBe("paragraph");
    expect(v.state.selection.$from.parent).toBe(v.state.doc.lastChild);
    expect(tail()!.hidden).toBe(true);
    p.handle.destroy();
  });
});

describe("the slash menu's groups", () => {
  const item = (id: string, group: string) => ({ id, label: id, group, keywords: id, run: () => {} });
  const items = [item("sketch", "media"), item("link", "reference"), item("task", "list"), item("text", "text"), item("callout", "layout")];
  it("put_text_first_then_the_usual_order_and_then_what_this_person_uses_most_goes_first", async () => {
    const { filterItems } = await import("../src/slash");
    expect(filterItems(items, "").map((i) => i.group)).toEqual(["text", "list", "layout", "media", "reference"]);
    expect(filterItems(items, "", { link: 5, sketch: 2 }).map((i) => i.group)).toEqual(["reference", "media", "text", "list", "layout"]);
  });
});
