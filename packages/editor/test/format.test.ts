import { describe, expect, it } from "vitest";
import { TextSelection } from "prosemirror-state";
import { kind, listWith, page, tick } from "./helpers";

// a content plugin that adds a mark and the Format items for it (as @nuah/editor-basic does)
const fmt = {
  default: (api: any) => {
    api.element({ kind: "@t/fmt/bold", marks: [{ id: "bold" }] });
    api.format({ id: "bold", label: { en: "Bold" }, icon: "bold", group: "marks", basic: true, applies: "text", isActive: (c: any) => c.markActive("bold"), run: (c: any) => c.toggleMark("bold") });
    api.format({ id: "later-bold", label: { en: "Later bold" }, applies: "text", run: async (c: any) => { await new Promise((r) => setTimeout(r, 5)); c.toggleMark("bold"); } });
    api.format({ id: "add", label: { en: "Add" }, applies: "insert", run: () => {} });
    api.format({ id: "center", label: { en: "Center" }, icon: "align-center", group: "align", applies: "block", isActive: () => false, run: (c: any) => c.setAlign("center") });
  },
};
const list = () => listWith(kind("@t/fmt/bold", "@t/fmt", 1, { shape: "content" }));
const open = async (hooks: Record<string, unknown> = {}) => {
  const bar = document.createElement("div");
  const p = await page({ list: list(), modules: { "@t/fmt": fmt }, hooks: { formatBar: bar, ...hooks } as never });
  const v = p.engine.view;
  v.dispatch(v.state.tr.insertText("hello world", 1));
  return { p, v, bar };
};
const press = (b: Element) => { b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); (b as HTMLElement).click(); };

describe("formatting (ADR 0097)", () => {
  it("the_format_bar_draws_what_plugins_add_and_runs_it_on_the_selection", async () => {
    const { p, v, bar } = await open();
    await tick();
    const bold = bar.querySelector('[data-format="bold"]')!;
    expect(bold).toBeTruthy();
    expect(bar.querySelector('[data-format="center"]')).toBeTruthy();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
    press(bold);
    expect(JSON.stringify(v.state.doc.toJSON())).toContain('"bold"');
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    p.handle.destroy();
  });

  it("the_selection_bar_shows_only_basic_items_over_selected_text_when_switched_on", async () => {
    const off = await open();
    off.v.dispatch(off.v.state.tr.setSelection(TextSelection.create(off.v.state.doc, 1, 6)));
    expect(document.querySelector(".nuah-selection-bar:not([hidden])")).toBeNull();
    off.p.handle.destroy();
    const { p, v } = await open({ pref: (k: string) => k === "editor.selection_bar" });
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
    const sb = document.querySelector(".nuah-selection-bar:not([hidden])")!;
    expect(sb).toBeTruthy();
    expect(sb.querySelector('[data-format="bold"]')).toBeTruthy();
    expect(sb.querySelector('[data-format="center"]')).toBeNull();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 3)));
    expect(document.querySelector(".nuah-selection-bar:not([hidden])")).toBeNull();
    p.handle.destroy();
  });

  it("the_element_tab_formats_the_whole_element", async () => {
    const { p, v } = await open();
    const id = v.state.doc.child(0).attrs.blockId;
    expect(p.handle.format(id).find((f: any) => f.id === "bold")).toMatchObject({ active: false });
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 3))); // the cursor somewhere in it
    await p.handle.applyFormat(id, "bold");
    const text = v.state.doc.child(0).firstChild!;
    expect(text.text).toBe("hello world");
    expect(text.marks.map((m) => m.type.name)).toEqual(["bold"]);
    expect(p.handle.format(id).find((f: any) => f.id === "bold")).toMatchObject({ active: true });
    expect(v.state.selection.from).toBe(3); // the cursor stays where it was
    p.handle.destroy();
  });

  it("an_item_that_finishes_later_applies_to_the_document_as_it_is_then", async () => {
    const { p, v } = await open();
    const id = v.state.doc.child(0).attrs.blockId;
    const done = p.handle.applyFormat(id, "later-bold");
    v.dispatch(v.state.tr.insertText("!", v.state.doc.child(0).nodeSize - 1)); // someone types meanwhile
    await done;
    const text = v.state.doc.child(0).firstChild!;
    expect(text.text).toBe("hello world!");
    expect(text.marks.map((m) => m.type.name)).toEqual(["bold"]);
    p.handle.destroy();
  });

  it("nothing_is_formatted_on_a_page_that_cannot_be_written", async () => {
    const { p, v, bar } = await open();
    const id = v.state.doc.child(0).attrs.blockId;
    p.handle.setEditable(false);
    await p.handle.applyFormat(id, "bold");
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
    (bar.querySelector('[data-format="bold"]') as HTMLElement | null)?.click();
    expect(JSON.stringify(v.state.doc.toJSON())).not.toContain('"bold"');
    p.handle.destroy();
  });

  it("items_that_insert_something_are_not_offered_for_a_whole_element", async () => {
    const { p, v } = await open();
    expect(p.handle.format(v.state.doc.child(0).attrs.blockId).map((f: any) => f.id)).not.toContain("add");
    p.handle.destroy();
  });

  it("the_selection_bar_hides_when_the_page_scrolls_or_the_editor_loses_focus", async () => {
    const { p, v } = await open({ pref: (k: string) => k === "editor.selection_bar" });
    const shown = () => document.querySelector(".nuah-selection-bar:not([hidden])");
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
    expect(shown()).toBeTruthy();
    document.dispatchEvent(new Event("scroll"));
    expect(shown()).toBeNull();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 5)));
    expect(shown()).toBeTruthy();
    v.dom.dispatchEvent(new FocusEvent("blur"));
    expect(shown()).toBeNull();
    p.handle.destroy();
  });
});
