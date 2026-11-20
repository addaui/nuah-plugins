import { describe, expect, it } from "vitest";
import { runElementCompliance, openPage, tick } from "@nuah/editor/testing";
import basic, { KINDS } from "../src/index";

const mod = { default: basic };
const p = (text: string, extra: Record<string, unknown> = {}) => ({ type: "paragraph", attrs: { blockId: null, ...extra }, content: text ? [{ type: "text", text }] : undefined });
const samples: Record<string, { node: unknown }> = {
  "@nuah/editor-basic/paragraph": { node: p("plain words") },
  "@nuah/editor-basic/heading": { node: { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "A title" }] } },
  "@nuah/editor-basic/bullet-list": { node: { type: "bulletList", content: [{ type: "listItem", content: [p("one")] }] } },
  "@nuah/editor-basic/ordered-list": { node: { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [p("three")] }] } },
  "@nuah/editor-basic/checklist": { node: { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p("done")] }] } },
  "@nuah/editor-basic/quote": { node: { type: "blockquote", content: [p("said")] } },
  "@nuah/editor-basic/divider": { node: { type: "horizontalRule" } },
  "@nuah/editor-basic/code": { node: { type: "codeBlock", attrs: { language: "python" }, content: [{ type: "text", text: "print(1)" }] } },
  "@nuah/editor-basic/callout": { node: { type: "callout", attrs: { tone: "tip" }, content: [p("Title"), p("body")] } },
  "@nuah/editor-basic/toggle": { node: { type: "toggle", attrs: { open: false }, content: [p("Summary"), p("hidden")] } },
};
runElementCompliance({ plugin: "@nuah/editor-basic", module: mod, kinds: KINDS, samples }, { describe, it, expect });

const opened = (lang = "en") => openPage([{ plugin: "@nuah/editor-basic", module: mod, kinds: KINDS }], { lang });
const type = (v: any, text: string) => { for (const ch of text) { const s = v.state; if (!v.someProp("handleTextInput", (f: any) => f(v, s.selection.from, s.selection.to, ch))) v.dispatch(v.state.tr.insertText(ch)); } };
const first = (m: any) => m.engine.view.state.doc.child(0);

describe("the basic elements", () => {
  it("markdown_shortcuts_make_blocks", async () => {
    const cases: [string, (n: any) => boolean][] = [
      ["# ", (n) => n.type.name === "heading" && n.attrs.level === 1],
      ["### ", (n) => n.type.name === "heading" && n.attrs.level === 3],
      ["- ", (n) => n.type.name === "bulletList"],
      ["1. ", (n) => n.type.name === "orderedList"],
      ["[] ", (n) => n.type.name === "taskList"],
      ["> ", (n) => n.type.name === "blockquote"],
      ["``` ", (n) => n.type.name === "codeBlock"],
      ["---", (n) => n.type.name === "horizontalRule"],
    ];
    for (const [typed, ok] of cases) {
      const m = await opened();
      m.engine.view.focus();
      type(m.engine.view, typed);
      expect(ok(first(m)), `${JSON.stringify(typed)} made ${first(m).type.name}`).toBe(true);
      m.handle.destroy();
    }
  });

  it("content_nodes_name_their_plugin", async () => {
    const m = await opened();
    expect(first(m).attrs.plugin).toBe("@nuah/editor-basic");
    expect(first(m).attrs.v).toBe(1);
    m.handle.destroy();
  });

  it("link_refuses_javascript_url", async () => {
    const m = await opened();
    const s = m.engine.view.state.schema;
    const out = s.marks.link!.spec.toDOM!(s.marks.link!.create({ href: "javascript:alert(1)" }), true) as [string, Record<string, string>];
    expect(out[1].href).toBe("#");
    const parse = (s.marks.link!.spec.parseDOM![0] as any).getAttrs;
    const a = document.createElement("a"); a.setAttribute("href", "javascript:alert(1)");
    expect(parse(a)).toBe(false);
    a.setAttribute("href", "https://example.com");
    expect(parse(a)).toEqual({ href: "https://example.com" });
    m.handle.destroy();
  });

  it("arabic_paragraph_gets_rtl", async () => {
    document.documentElement.dir = "rtl";
    const m = await opened("ar");
    const p0 = () => m.place.querySelector("p")!;
    expect(p0().getAttribute("dir")).toBe("rtl"); // empty: the page's direction
    type(m.engine.view, "مرحبا");
    await tick();
    expect(p0().getAttribute("dir")).toBe("auto");
    document.documentElement.dir = "";
    m.handle.destroy();
  });

  it("slash_lists_the_basic_items_in_arabic", async () => {
    const m = await opened("ar");
    type(m.engine.view, "/");
    const menu = document.querySelector(".nuah-slash")!;
    for (const w of ["عنوان ١", "قائمة نقطية", "تنبيه", "نص"]) expect(menu.textContent).toContain(w);
    m.handle.destroy();
  });
});

describe("paragraph", () => {
  it("is the default block, so Enter never makes another plugin's block", () => {
    const defs: any[] = [];
    basic({ element: (d: any) => defs.push(d), format() {}, lang: () => "en" } as never);
    const p = defs.find((d) => d.kind.endsWith("/paragraph"));
    expect(p.nodes.find((n: any) => n.id === "paragraph")).toMatchObject({ defaultBlock: true });
  });
});

describe("Format items (ADR 0097)", () => {
  it("adds_marks_blocks_lists_and_alignment_and_bold_formats_a_whole_paragraph", async () => {
    const m = await opened();
    const v = m.engine.view;
    v.dispatch(v.state.tr.insertText("hello", 1));
    const id = v.state.doc.child(0).attrs.blockId;
    const ids = m.handle.format(id).map((f: any) => f.id);
    for (const x of ["bold", "italic", "underline", "strike", "code", "highlight", "link", "paragraph", "heading-1", "quote", "bullet-list", "ordered-list", "checklist", "align-center"]) expect(ids).toContain(x);
    await m.handle.applyFormat(id, "bold");
    expect(v.state.doc.child(0).firstChild!.marks.map((x) => x.type.name)).toEqual(["bold"]);
    await m.handle.applyFormat(id, "heading-1");
    expect(v.state.doc.child(0).type.name).toBe("heading");
    await m.handle.applyFormat(v.state.doc.child(0).attrs.blockId, "align-center");
    expect(v.state.doc.child(0).attrs.align).toBe("center");
    await m.handle.applyFormat(v.state.doc.child(0).attrs.blockId, "align-start");
    expect(v.state.doc.child(0).attrs.align).toBe("start");
    // the cursor stays in the same text when the element is wrapped (positions shift)
    v.dispatch(v.state.tr.setSelection((v.state.selection.constructor as any).create(v.state.doc, 3)));
    await m.handle.applyFormat(v.state.doc.child(0).attrs.blockId, "quote");
    expect(v.state.doc.child(0).type.name).toBe("blockquote");
    expect(v.state.selection.$from.parent.textContent).toBe("hello");
    expect(v.state.selection.$from.parentOffset).toBe(2);
    m.handle.destroy();
  });
});
