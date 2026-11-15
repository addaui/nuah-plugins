import { describe, expect, it } from "vitest";
import { applyStep, type Step, applyTransaction, assignIds, emptyDoc, History, nodeAt, Registry, resolveOption, textOf, toProseMirrorSpec, validate, walk, type Node } from "../src";

/** What the basic-blocks plugin and the core plugins say, in one registry: the same kinds Madar's pages hold today. */
function madar(): Registry {
  const r = new Registry();
  r.addNode({ id: "paragraph", group: "block", content: "inline*", ids: true, dom: { tag: "p" }, options: [{ id: "align", type: "choice", label: { en: "Alignment" }, default: "start", inherit: true }] });
  r.addNode({ id: "heading", group: "block", content: "inline*", ids: true, attrs: { level: { default: 1 } }, dom: { tag: "h1" } });
  r.addNode({ id: "bulletList", group: "block", content: "listItem+", ids: true });
  r.addNode({ id: "listItem", group: "block", content: "paragraph block*", ids: true });
  r.addNode({ id: "callout", group: "block", content: "block+", ids: true, attrs: { tone: { default: "info" } } });
  r.addNode({ id: "image", group: "block", atom: true, ids: true, attrs: { src: { default: "" }, alt: { default: "" }, size: { default: null } } });
  r.addNode({ id: "entityRef", group: "inline", atom: true, attrs: { kind: { default: "" }, id: { default: "" }, title: { default: "" } } });
  r.addNode({ id: "hardBreak", group: "inline" });
  r.addMark({ id: "bold" }).addMark({ id: "link", attrs: { href: { default: "" } } });
  return r;
}
const p = (t: string, id?: string): Node => ({ type: "paragraph", ...(id ? { attrs: { blockId: id } } : {}), content: t ? [{ type: "text", text: t }] : [] });
const page = (): Node => ({ type: "doc", content: [{ type: "heading", attrs: { level: 1, blockId: "h1" }, content: [{ type: "text", text: "Title" }] }, p("Hello ", "p1"),
  { type: "bulletList", attrs: { blockId: "l1" }, content: [{ type: "listItem", attrs: { blockId: "i1" }, content: [p("one", "p2")] }] },
  { type: "callout", attrs: { tone: "tip", blockId: "c1" }, content: [p("careful", "p3")] }, { type: "image", attrs: { src: "/files/a", blockId: "m1" } }] });

describe("the registry", () => {
  it("refuses a second plugin that declares what is already there", () => {
    const r = madar();
    expect(() => r.addNode({ id: "paragraph", group: "block" })).toThrow(/already declared/);
    expect(() => r.addMark({ id: "bold" })).toThrow();
    expect(() => r.addOption("paragraph", { id: "align", type: "choice", label: { en: "x" } })).toThrow(/already has/);
  });
  it("lets another plugin add an option to a block it does not own", () => {
    const r = madar().addOption("image", { id: "caption", type: "text", label: { en: "Caption" } });
    expect(r.nodes.get("image")!.options!.map((o) => o.id)).toEqual(["caption"]);
    expect(() => madar().addOption("nothing", { id: "x", type: "text", label: { en: "" } })).toThrow(/no node/);
  });
  it("finds two commands that claim one key", () => {
    const r = madar().addCommand({ id: "bold", keys: ["Mod-b"], run: () => true }).addCommand({ id: "boldish", keys: ["Mod-b", "Mod-g"], run: () => true });
    expect(r.keymap().conflicts).toEqual([["Mod-b", "bold", "boldish"]]);
  });
});

describe("validate", () => {
  it("accepts a real page", () => { expect(validate(page(), madar())).toEqual([]); });
  it("says where and why a document is wrong", () => {
    const bad: Node = { type: "doc", content: [{ type: "bulletList", content: [p("not an item")] }, { type: "paragraph", attrs: { colour: "red" } }] };
    const ps = validate(bad, madar());
    expect(ps.map((x) => x.message)).toEqual(['"bulletList" cannot hold [paragraph]', '"paragraph" has no attribute "colour"']);
    expect(ps[0]!.path).toEqual([0]);
  });
  it("keeps what a switched-off plugin made, and does not look inside it", () => {
    const d: Node = { type: "doc", content: [p("x"), { type: "kanban", attrs: { cards: 3 }, content: [{ type: "weird" }] }] };
    expect(validate(d, madar()).length).toBeGreaterThan(0);
    expect(validate(d, madar(), { keepUnknown: true })).toEqual([]);
  });
});

describe("ids", () => {
  it("are given to blocks that lack one, and to the later of two that share one", () => {
    let n = 0;
    const d: Node = { type: "doc", content: [p("a"), p("b", "x"), p("c", "x")] };
    const out = assignIds(d, madar().idTypes().has.bind(madar().idTypes()), () => "n" + ++n);
    expect(out.content!.map((b) => b.attrs?.blockId)).toEqual(["n1", "x", "n2"]);
  });
});

describe("transactions", () => {
  it("every step can be undone exactly", () => {
    const d = page();
    const steps = [
      { kind: "setAttr", path: [3], name: "tone", value: "danger" },
      { kind: "insert", path: [], index: 1, node: p("new", "p9") },
      { kind: "remove", path: [3], index: 0 },
      { kind: "setContent", path: [1], content: [{ type: "text", text: "Hi" }] },
    ] as Step[];
    for (const s of steps) { const a = applyStep(d, s); expect(a.doc).not.toEqual(d); expect(applyStep(a.doc, a.inverse).doc).toEqual(d); }
  });
  it("a transaction is undone by its inverse, whatever it did", () => {
    const d = page();
    const r = applyTransaction(d, { steps: [{ kind: "setAttr", path: [3], name: "tone", value: "danger" }, { kind: "insert", path: [], index: 0, node: p("top") }, { kind: "remove", path: [], index: 2 }] });
    expect(textOf(r.doc)).not.toBe(textOf(d));
    expect(applyTransaction(r.doc, r.inverse).doc).toEqual(d);
  });
  it("does not change the document it was given", () => {
    const d = page(), snap = JSON.stringify(d);
    applyStep(d, { kind: "setAttr", path: [1], name: "align", value: "center" });
    expect(JSON.stringify(d)).toBe(snap);
  });
  it("refuses a place that is not there", () => {
    expect(() => applyStep(page(), { kind: "remove", path: [], index: 99 })).toThrow(RangeError);
    expect(() => applyStep(page(), { kind: "insert", path: [99], index: 0, node: p("x") })).toThrow();
  });
});

describe("history", () => {
  it("undoes and redoes, and joins typing of the same group", () => {
    const h = new History(500);
    let d = emptyDoc();
    const type = (text: string, at: number) => { const r = applyTransaction(d, { group: "typing", steps: [{ kind: "setContent", path: [0], content: [{ type: "text", text }] }] }); d = r.doc; h.push(r.inverse, at); };
    type("a", 0); type("ab", 100); type("abc", 200);
    const other = applyTransaction(d, { steps: [{ kind: "setAttr", path: [0], name: "align", value: "end" }] }); d = other.doc; h.push(other.inverse, 300);
    d = h.undo(d);
    expect(nodeAt(d, [0])!.attrs?.align).toBeUndefined();
    expect(textOf(d)).toBe("abc");
    d = h.undo(d);   // the three keystrokes are one undo
    expect(textOf(d)).toBe("");
    d = h.redo(d);
    expect(textOf(d)).toBe("abc");
    expect(h.canRedo).toBe(true);
    h.push({ steps: [] }, 999);   // a new change ends the redo line
    expect(h.canRedo).toBe(false);
  });
});

describe("options", () => {
  it("a value is the element's, else the page's, else the default (the Element tab's rule, with no Face)", () => {
    const o = madar().nodes.get("paragraph")!.options![0]!;
    expect(resolveOption(o, "paragraph", { align: "end" }, { paragraph: { align: "center" } }).source).toBe("element");
    expect(resolveOption(o, "paragraph", {}, { paragraph: { align: "center" } })).toEqual({ value: "center", source: "page" });
    expect(resolveOption(o, "paragraph", {}).value).toBe("start");
  });
});

describe("the engine spec", () => {
  it("is made from the registry, so a plugin's block reaches the engine without the engine knowing it", () => {
    const spec = toProseMirrorSpec(madar().addNode({ id: "kanban", group: "block", content: "card+", ids: true, attrs: { cols: { default: 3 } } }).addNode({ id: "card", group: "block", content: "inline*" }));
    expect(spec.nodes.kanban).toMatchObject({ group: "block", content: "card+", attrs: { cols: { default: 3 }, blockId: { default: null } } });
    expect(spec.nodes.image).toMatchObject({ atom: true, selectable: true });
    expect(spec.nodes.text).toEqual({ group: "inline" });
    expect(spec.marks.link).toEqual({ attrs: { href: { default: "" } } });
  });
});

describe("walking", () => { it("visits every node with its path", () => { const n = [...walk(page())].filter(([x]) => x.type === "paragraph").map(([, path]) => path.join("/")); expect(n).toEqual(["1", "2/0/0", "3/0"]); }); });
