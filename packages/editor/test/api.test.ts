import { describe, expect, it, vi } from "vitest";
import { LoroDoc } from "loro-crdt";
import { Elements, apiFor } from "../src/api";
import { mount } from "../src/face";
import { resetSharedForTests } from "@nuah/browser-kit";

const ui = { menu: vi.fn(), popover: vi.fn(), modal: vi.fn(), toast: vi.fn(), loading: vi.fn(() => () => {}), askText: vi.fn(), askUrl: vi.fn(), icon: () => null };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the element api", () => {
  it("element_kind_must_be_the_plugins", () => {
    const els = new Elements();
    const api = apiFor("@nuah/mermaid", els, { ui } as never);
    expect(() => api.element({ kind: "@other/x/diagram" })).toThrow(/@nuah\/mermaid may only declare its own kinds/);
    api.element({ kind: "@nuah/mermaid/diagram" });
    expect(els.get("@nuah/mermaid/diagram")?.plugin).toBe("@nuah/mermaid");
  });

  it("content_nodes_reach_the_registry", () => {
    const els = new Elements();
    apiFor("@nuah/editor-basic", els, { ui } as never).element({ kind: "@nuah/editor-basic/paragraph", nodes: [{ id: "paragraph", group: "block", content: "inline*", ids: true, dom: { tag: "p" } }] });
    expect(els.registry().has("paragraph")).toBe(true);
  });
});

describe("mount (face.editor@1)", () => {
  it("loads_content_plugins_then_opens_the_live_document", async () => {
    resetSharedForTests();
    const basic = { default: (api: any) => api.element({ kind: "@nuah/editor-basic/paragraph", nodes: [{ id: "paragraph", group: "block", content: "inline*", ids: true, dom: { tag: "p" } }] }) };
    const importer = vi.fn(async () => basic);
    const doc = new LoroDoc();
    const place = document.createElement("div");
    const h = await mount(place, {
      ui, lang: "en", editable: true, live: { doc },
      elements: async () => ({ kinds: [{ kind: "@nuah/editor-basic/paragraph", version: 1, shape: "content", placement: "block", label: { en: "Text" }, plugin: "@nuah/editor-basic", module: "/plugins/nuah/editor-basic/index.js?v=1", openers: ["@nuah/editor-basic"], default: null }], runners: [] }),
      importer,
    } as never);
    await tick();
    expect(importer).toHaveBeenCalledWith("/plugins/nuah/editor-basic/index.js?v=1");
    expect(place.querySelector("p")).not.toBeNull();
    expect(h.live()).toBe(true);
    expect(h.isEmpty()).toBe(true);
    h.destroy();
  });

  it("shares_the_engine_libraries_with_element_modules", async () => {
    resetSharedForTests();
    const h = await mount(document.createElement("div"), { ui, lang: "en", editable: true, live: { doc: new LoroDoc() }, elements: async () => ({ kinds: [], runners: [] }), importer: vi.fn() } as never);
    const t = (globalThis as any).__nuahShared;
    for (const n of ["prosemirror-model", "prosemirror-state", "prosemirror-view", "prosemirror-transform", "prosemirror-keymap", "prosemirror-commands", "prosemirror-inputrules", "loro-prosemirror"]) expect(t[n], n).toBeTruthy();
    h.destroy();
  });
});
