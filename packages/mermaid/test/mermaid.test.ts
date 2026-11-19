import { describe, expect, it } from "vitest";
import { LoroDoc, LoroText } from "loro-crdt";
import { runElementCompliance, openPage, BASIC, tick } from "@nuah/editor/testing";
import register, { KIND, DECL, applyEdit, firstLine } from "../src/index";

const mod = { default: register };
runElementCompliance({
  plugin: "@nuah/mermaid", module: mod, kinds: [DECL],
  samples: { [KIND]: { data: { theme: "dark" }, fill: (t) => (t as LoroText).insert(0, "flowchart LR\n  A --> B"), other: { data: {}, fill: (t) => (t as LoroText).insert(0, "%% a note\n") } } },
}, { describe, it, expect });

describe("mermaid", () => {
  it("source_edits_merge", () => {
    const a = new LoroDoc(), b = new LoroDoc();
    const ta = a.getMap("elements").ensureMergeableText("d1") as LoroText;
    ta.insert(0, "flowchart LR\n  A --> B");
    a.commit();
    b.import(a.export({ mode: "snapshot" }));
    const tb = b.getMap("elements").get("d1") as LoroText;
    applyEdit(ta, ta.toString(), "flowchart LR\n  A --> B\n  B --> C");
    applyEdit(tb, tb.toString(), "flowchart TD\n  A --> B");
    a.commit(); b.commit();
    a.import(b.export({ mode: "update", from: a.oplogVersion() }));
    b.import(a.export({ mode: "update", from: b.oplogVersion() }));
    expect(ta.toString()).toBe(tb.toString());
    expect(ta.toString()).toContain("TD");
    expect(ta.toString()).toContain("B --> C");
  });

  it("bad_source_shows_error_not_throw", async () => {
    const m = await openPage([BASIC, { plugin: "@nuah/mermaid", module: mod, kinds: [DECL] }]);
    const v = m.engine.view;
    v.dispatch(v.state.tr.insert(v.state.doc.content.size, v.state.schema.nodes.element!.create({ blockId: "d1", kind: KIND, plugin: "@nuah/mermaid", v: 1, data: {} })));
    (m.doc.getMap("elements").ensureMergeableText("d1") as LoroText).insert(0, "this is not a diagram ((");
    m.doc.commit();
    await tick(800);
    expect(m.place.querySelector(".nuah-mermaid-error")?.textContent?.length).toBeGreaterThan(0);
    m.handle.destroy();
  });

  it("theme_option_pinned", () => {
    let def: any;
    register({ element: (d: any) => (def = d) } as never);
    expect(def.options.find((o: any) => o.id === "theme").pinned).toBe(true);
  });

  it("fallback_is_the_first_line", () => {
    expect(firstLine("\n%% comment\nflowchart LR\n A-->B")).toBe("flowchart LR");
  });
});
