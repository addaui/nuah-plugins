import { describe, expect, it, vi } from "vitest";
import { LoroDoc } from "loro-crdt";
import { openPage, BASIC, tick, copyOf } from "../src/testing";

describe("the floating layer", () => {
  it("floating_list_is_kept_in_the_document", async () => {
    const onList = vi.fn(), onLayers = vi.fn();
    const a = await openPage([BASIC], { hooks: { floating: { onList, onLayers, onLayout: vi.fn() } } as never });
    expect(onLayers).toHaveBeenCalledWith(expect.objectContaining({ back: expect.any(HTMLElement), front: expect.any(HTMLElement) }));
    a.handle.setFloating([{ id: "s1", kind: "emoji", value: "🌟", anchor: null, x: 0.1, y: 1, w: 0.1 }]);
    await tick();
    expect(a.handle.floating()).toEqual([{ id: "s1", kind: "emoji", value: "🌟", anchor: null, x: 0.1, y: 1, w: 0.1 }]);
    expect(onList).toHaveBeenLastCalledWith([expect.objectContaining({ id: "s1" })]);
    // another copy of the page opens with it
    const b = await openPage([BASIC], { doc: copyOf(a.doc) });
    expect(b.handle.floating().map((s: any) => s.id)).toEqual(["s1"]);
    a.handle.destroy(); b.handle.destroy();
  });

  it("an_empty_page_has_no_floating_elements", async () => {
    const a = await openPage([BASIC], { doc: new LoroDoc() });
    expect(a.handle.floating()).toEqual([]);
    a.handle.destroy();
  });
});

describe("text around floating elements", () => {
  it("a_wrap_is_a_shaped_float_at_the_start_of_its_block", async () => {
    const a = await openPage([BASIC]);
    const v = a.engine.view;
    v.dispatch(v.state.tr.insertText("text that flows around a sticker", 1));
    const id = v.state.doc.child(0).attrs.blockId;
    a.handle.setWraps([{ anchor: id, side: "end", width: 80, height: 60, inset: 4, top: 2, margin: 6, shape: "oval" }]);
    await tick();
    const w = a.place.querySelector(".sticker-wrap") as HTMLElement;
    expect(w).not.toBeNull();
    expect(w.style.getPropertyValue("float")).toBe("inline-end");
    expect(w.style.width).toBe("80px");
    expect(w.style.getPropertyValue("shape-outside")).toBe("ellipse(50% 50%)");
    a.handle.setWraps([]);
    await tick();
    expect(a.place.querySelector(".sticker-wrap")).toBeNull();
    // a wrap never enters the document
    expect(JSON.stringify(a.handle.json())).not.toContain("sticker-wrap");
    a.handle.destroy();
  });
});
