import { describe, expect, it, vi } from "vitest";
import { openPage, BASIC, tick } from "../src/testing";
import { insertCard, kind, listWith, page } from "./helpers";

const json = (text: string) => ({ type: "doc", content: [{ type: "paragraph", attrs: { blockId: "b1" }, content: [{ type: "text", text }] }] });

describe("the handle, without a Live document (a task's description)", () => {
  it("opens_json_and_reports_changes", async () => {
    const onChange = vi.fn();
    const m = await openPage([BASIC], { hooks: { live: undefined, content: json("hello"), onChange } });
    expect(m.engine.text()).toBe("hello");
    m.engine.view.dispatch(m.engine.view.state.tr.insertText("!", 6));
    expect(onChange).toHaveBeenCalled();
    expect(JSON.stringify(onChange.mock.calls.at(-1)![0])).toContain("hello!");
    m.handle.destroy();
  });

  it("set_replaces_the_document", async () => {
    const m = await openPage([BASIC], { hooks: { live: undefined, content: json("old") } });
    m.handle.set(json("new"));
    expect(m.engine.text()).toBe("new");
    m.handle.destroy();
  });
});

describe("the page's defaults for elements", () => {
  it("card_options_take_the_pages_default", async () => {
    const seen: unknown[] = [];
    const mod = { default: (api: any) => api.element({ kind: "@t/d/chart", options: [{ id: "theme", type: "choice", inherit: true, default: "plain", label: { en: "Theme" } }], views: { card: (_p: HTMLElement, c: any) => { seen.push(c.options.theme); return { update: (x: any) => seen.push(x.options.theme), destroy() {} }; } } }) };
    const p = await page({ list: listWith(kind("@t/d/chart", "@t/d")), modules: { "@t/d": mod } });
    p.handle.setDefaults({ "@t/d/chart": { theme: "dark" } });
    insertCard(p.engine.view, { blockId: "e1", kind: "@t/d/chart", plugin: "@t/d" });
    await tick(20);
    expect(seen.at(-1)).toBe("dark");
    p.handle.destroy();
  });
});
