import { describe, expect, it, vi } from "vitest";
import { NodeSelection } from "prosemirror-state";
import { elementsOf, insertCard, kind, listWith, page, tick } from "./helpers";

const A = "@t/a/chart", B = "@t/b/chart";
const drawn: string[] = [];
const mod = (k: string, extra: any = {}) => ({ default: (api: any) => api.element({ kind: k, views: { card: (p: HTMLElement) => { drawn.push(k + ":" + (extra.who ?? k)); p.textContent = extra.who ?? k; return { update() {}, destroy() {} }; } }, ...extra.def }) });
const at = (v: any, id: string) => { let p = -1; v.state.doc.descendants((n: any, pos: number) => { if (n.attrs.blockId === id) p = pos; }); return p; };

describe("surfaces", () => {
  it("open_with_switches_without_changing_document", async () => {
    const list = listWith({ ...kind(A, "@t/a"), openers: ["@t/a", "@t/b"] } as never, kind(B, "@t/b"));
    const p = await page({ list, modules: { "@t/a": mod(A), "@t/b": mod(B, { who: "b-opens-a", def: { opens: [`${A}@1`] } }) } });
    insertCard(p.engine.view, { blockId: "e1", kind: A, plugin: "@t/a" });
    await tick(10);
    expect(p.place.textContent).toContain(A);
    p.doc.commit();
    const before = JSON.stringify(p.doc.oplogVersion().toJSON());
    await p.host.openWith!("e1", "@t/b");
    await tick(10);
    expect(p.place.textContent).toContain("b-opens-a");
    p.doc.commit();
    expect(JSON.stringify(p.doc.oplogVersion().toJSON())).toBe(before);
    p.handle.destroy();
  });

  it("opener_order_person_owner_declarer", async () => {
    const base = { ...kind(A, "@t/a"), openers: ["@t/a", "@t/b", "@t/c"] };
    const order = async (owner: string | null, person: string | null) => {
      const p = await page({ list: listWith({ ...base, default: owner } as never), modules: {}, hooks: { pref: (k: string) => (k === `editor.opener.${A}` ? person : null) } as never });
      const o = p.host.openerFor(A);
      p.handle.destroy();
      return o;
    };
    expect(await order(null, null)).toBe("@t/a");
    expect(await order("@t/b", null)).toBe("@t/b");
    expect(await order("@t/b", "@t/c")).toBe("@t/c");
    expect(await order("@t/b", "@t/gone")).toBe("@t/b");
  });

  it("context_lists_pinned_options_first", async () => {
    const onContext = vi.fn();
    const options = [{ id: "size", type: "number", label: { en: "Size" } }, { id: "theme", type: "choice", label: { en: "Theme" }, pinned: true }];
    const p = await page({ list: listWith(kind(A, "@t/a")), modules: { "@t/a": mod(A, { def: { options } }) }, hooks: { onContext } as never });
    insertCard(p.engine.view, { blockId: "e1", kind: A, plugin: "@t/a", data: { size: 3 } });
    await p.loader.loadFor(new Set([A]));
    const v = p.engine.view;
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, at(v, "e1"))));
    const ctx = onContext.mock.calls.at(-1)![0];
    expect(ctx.selected).toBe(true);
    expect(ctx.chain[0].kind).toBe(A);
    expect(ctx.chain[0].options.map((o: any) => o.id)).toEqual(["theme", "size"]);
    p.handle.setOption("e1", "theme", "dark");
    expect(elementsOf(p.doc)[0].attributes.data).toEqual({ size: 3, theme: "dark" });
    p.handle.destroy();
  });

  it("turn_into_and_back_round_trips", async () => {
    const aDef = { convert: { to: [{ kind: B, make: (c: any) => ({ data: { x: c.data.x } }) }] } };
    const bDef = { convert: { to: [{ kind: A, make: (c: any) => ({ data: { x: c.data.x } }) }] } };
    const p = await page({ list: listWith(kind(A, "@t/a"), kind(B, "@t/b")), modules: { "@t/a": mod(A, { def: aDef }), "@t/b": mod(B, { def: bDef }) } });
    insertCard(p.engine.view, { blockId: "e1", kind: A, plugin: "@t/a", data: { x: 7 } });
    await p.loader.loadFor(new Set([A, B]));
    const id = await p.host.turnInto!("e1", B);
    expect(elementsOf(p.doc).map((e) => [e.attributes.kind, e.attributes.data])).toEqual([[B, { x: 7 }]]);
    await p.host.turnInto!(id!, A);
    expect(elementsOf(p.doc).map((e) => [e.attributes.kind, e.attributes.data])).toEqual([[A, { x: 7 }]]);
    p.handle.destroy();
  });

  it("margin_mirrors_in_rtl", async () => {
    const run = vi.fn();
    const comments = { default: (api: any) => { api.element({ kind: "@t/talk/none" }); api.margin({ id: "comments", icon: "chat", label: { en: "Comments" }, count: () => 2, run }); } };
    const p = await page({ list: listWith(kind("@t/talk/none", "@t/talk")), modules: { "@t/talk": comments }, hooks: { lang: "ar" } as never });
    await p.loader.loadFor(new Set(["@t/talk/none"]));
    const v = p.engine.view;
    v.dispatch(v.state.tr.insertText("نص", 1));
    const id = v.state.doc.child(0).attrs.blockId;
    const g = p.host.gutterFor!(id)!;
    expect(g.dir).toBe("rtl");
    expect(g.className).toContain("nuah-gutter");
    expect(g.style.insetInlineStart).not.toBe("");
    expect(g.style.left).toBe("");
    const btn = g.querySelector('[data-action="comments"]') as HTMLButtonElement;
    expect(btn.textContent).toContain("2");
    btn.click();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ blockId: id }), btn);
    p.handle.destroy();
  });
});
