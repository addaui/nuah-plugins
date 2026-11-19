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
