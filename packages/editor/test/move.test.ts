import { describe, expect, it } from "vitest";
import { NodeSelection } from "prosemirror-state";
import { insertCard, kind, listWith, page, tick } from "./helpers";

const S = "@t/sketch/canvas";
const card = { default: (api: any) => api.element({ kind: S, views: { card: (p: HTMLElement) => { p.textContent = "card"; return { update() {}, destroy() {} }; } } }) };

/** jsdom lays nothing out: each top-level block gets a 40px-high row, one under the other. */
function layOut(v: any) {
  v.state.doc.forEach((_n: any, offset: number, i: number) => {
    const dom = v.nodeDOM(offset) as HTMLElement;
    dom.getBoundingClientRect = () => ({ top: i * 40, bottom: i * 40 + 30, left: 0, right: 600, width: 600, height: 30, x: 0, y: i * 40, toJSON() {} }) as DOMRect;
  });
}
const names = (v: any) => { const n: string[] = []; v.state.doc.forEach((c: any) => n.push(c.type.name === "element" ? c.attrs.blockId : c.textContent)); return n; };
const drag = (v: any, id: string) => {
  let at = -1; v.state.doc.descendants((n: any, pos: number) => { if (n.attrs.blockId === id) at = pos; });
  const sel = NodeSelection.create(v.state.doc, at);
  v.dispatch(v.state.tr.setSelection(sel));
  v.dragging = { slice: sel.content(), move: true, node: sel };
};
const event = (type: string, y: number, types: string[] = []) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clientX: 100, clientY: y, dataTransfer: { dropEffect: "move", getData: () => "", types } });

describe("moving a block by dragging it (between blocks only)", () => {
  it("drops_the_card_in_the_gap_nearest_the_pointer_and_keeps_its_id", async () => {
    const p = await page({ list: listWith(kind(S, "@t/sketch")), modules: { "@t/sketch": card } });
    const v = p.engine.view;
    v.dispatch(v.state.tr.insertText("first", 1));
    insertCard(v, { blockId: "e1", kind: S, plugin: "@t/sketch" });
    v.dispatch(v.state.tr.insert(v.state.doc.content.size, v.state.schema.nodes.paragraph.create(null, v.state.schema.text("last"))));
    await tick();
    expect(names(v)).toEqual(["first", "e1", "last"]);
    layOut(v);
    drag(v, "e1");
    // the pointer over the lower half of "last": the gap after it
    v.dom.dispatchEvent(event("dragover", 105));
    const line = p.place.ownerDocument.querySelector(".nuah-drop-line") as HTMLElement;
    expect(line && !line.hidden).toBe(true);
    v.dom.dispatchEvent(event("drop", 105));
    expect(names(v)).toEqual(["first", "last", "e1"]);
    expect(line.hidden).toBe(true);
    // and back to the top: the pointer over the upper half of "first"
    layOut(v);
    drag(v, "e1");
    v.dom.dispatchEvent(event("drop", 5));
    expect(names(v)).toEqual(["e1", "first", "last"]);
    p.handle.destroy();
  });

  it("dragging_the_handle_in_the_margin_carries_its_block", async () => {
    const p = await page({ list: listWith(kind(S, "@t/sketch")), modules: { "@t/sketch": card } });
    const v = p.engine.view;
    insertCard(v, { blockId: "e1", kind: S, plugin: "@t/sketch" });
    await tick();
    const g = p.host.gutterFor!("e1")!;
    const handle = g.querySelector(".nuah-gutter-handle")!;
    const data: Record<string, string> = {};
    const e = Object.assign(new Event("dragstart", { bubbles: true }), { dataTransfer: { setData: (k: string, x: string) => { data[k] = x; }, setDragImage() {}, effectAllowed: "" } });
    handle.dispatchEvent(e);
    const d = (v as any).dragging;
    expect(d?.move).toBe(true);
    expect(d?.node?.node?.attrs.blockId).toBe("e1");
    expect(data["text/html"]).toContain("nuah-element");
    handle.dispatchEvent(new Event("dragend", { bubbles: true }));
    expect((v as any).dragging).toBeNull();
    p.handle.destroy();
  });

  const three = async () => {
    const p = await page({ list: listWith(kind(S, "@t/sketch")), modules: { "@t/sketch": card } });
    const v = p.engine.view;
    v.dispatch(v.state.tr.insertText("first", 1));
    insertCard(v, { blockId: "e1", kind: S, plugin: "@t/sketch" });
    v.dispatch(v.state.tr.insert(v.state.doc.content.size, v.state.schema.nodes.paragraph.create(null, v.state.schema.text("last"))));
    await tick();
    return { p, v };
  };

  it("a_change_someone_else_makes_during_the_drag_moves_the_right_block", async () => {
    const { p, v } = await three();
    drag(v, "e1");
    // someone types at the top while the card is being dragged: positions shift
    v.dispatch(v.state.tr.insert(0, v.state.schema.nodes.paragraph.create(null, v.state.schema.text("new"))));
    layOut(v);
    v.dom.dispatchEvent(event("drop", 145)); // the lower half of "last"
    expect(names(v)).toEqual(["new", "first", "last", "e1"]);
    p.handle.destroy();
  });

  it("nothing_moves_on_a_page_that_cannot_be_written_or_when_a_file_is_dropped", async () => {
    const { p, v } = await three();
    layOut(v);
    p.handle.setEditable(false);
    drag(v, "e1");
    v.dom.dispatchEvent(event("drop", 105));
    expect(names(v)).toEqual(["first", "e1", "last"]);
    p.handle.setEditable(true);
    drag(v, "e1"); // a drag left over, then a file from the desktop
    v.dom.dispatchEvent(event("drop", 105, ["Files"]));
    expect(names(v)).toEqual(["first", "e1", "last"]);
    p.handle.destroy();
  });
});
