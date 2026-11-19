import { describe, expect, it, vi } from "vitest";
import type { LoroText } from "loro-crdt";
import { runElementCompliance, openPage, BASIC, tick } from "@nuah/editor/testing";
import register, { DECL, KIND } from "../src/index";

const mod = { default: register };
runElementCompliance({
  plugin: "@nuah/notebook", module: mod, kinds: [DECL],
  samples: { [KIND]: { data: { language: "python" }, fill: (t) => (t as LoroText).insert(0, "print(1)"), other: { data: { view: "code" }, fill: (t) => (t as LoroText).insert(0, "# note\n") } } },
}, { describe, it, expect });

const runner = (result: Record<string, unknown>) => ({ plugin: "@t/py", kinds: [], languages: ["python"], module: { default: (api: any) => api.runner(["python"], vi.fn(async (_req: unknown, report: any) => { report({ stage: "running" }); return { ok: true, stdout: "", stderr: "", files: [], ms: 5, ...result }; })) } });
async function cellPage(mods: any[], editable = true, files = vi.fn(async () => "/files/f1")) {
  const m = await openPage([BASIC, { plugin: "@nuah/notebook", module: mod, kinds: [DECL] }, ...mods], { editable, hooks: { files: { upload: files } } as never });
  const v = m.engine.view;
  if (editable) {
    v.dispatch(v.state.tr.insert(v.state.doc.content.size, v.state.schema.nodes.element!.create({ blockId: "c1", kind: KIND, plugin: "@nuah/notebook", v: 1, data: { language: "python" } })));
    (m.doc.getMap("elements").ensureMergeableText("c1") as LoroText).insert(0, "print(6 * 7)");
    m.doc.commit();
  }
  await tick(20);
  return { m, files };
}
const attrsOf = (m: any) => { let a: any; m.engine.view.state.doc.descendants((n: any) => { if (n.attrs.blockId === "c1") a = n.attrs; }); return a; };

describe("code cells", () => {
  it("run_stores_output_and_hash", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const { m, files } = await cellPage([runner({ stdout: "42\n", files: [{ name: "figure-1.png", type: "image/png", bytes: png }] })]);
    (m.place.querySelector(".nuah-cell-run") as HTMLButtonElement).click();
    await tick(50);
    const out = attrsOf(m).data.output;
    expect(out.text).toBe("42\n");
    expect(out.ok).toBe(true);
    expect(out.files).toEqual(["/files/f1"]);
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(files).toHaveBeenCalledTimes(1);
    expect(m.place.querySelector(".nuah-cell-output")?.textContent).toContain("42");
    m.handle.destroy();
  });

  it("viewer_has_no_run_button", async () => {
    const seed = await cellPage([runner({ stdout: "42\n" })]);
    (seed.m.place.querySelector(".nuah-cell-run") as HTMLButtonElement).click();
    await tick(50);
    const { copyOf } = await import("@nuah/editor/testing");
    const viewer = await openPage([BASIC, { plugin: "@nuah/notebook", module: mod, kinds: [DECL] }, runner({})], { doc: copyOf(seed.m.doc), editable: false });
    await tick(20);
    expect(viewer.place.querySelector(".nuah-cell-run")).toBeNull();
    expect(viewer.place.querySelector(".nuah-cell-output")?.textContent).toContain("42");
    seed.m.handle.destroy(); viewer.handle.destroy();
  });

  it("no_runner_says_so", async () => {
    const { m } = await cellPage([]);
    (m.place.querySelector(".nuah-cell-run") as HTMLButtonElement).click();
    await tick(50);
    expect(m.place.querySelector(".nuah-cell-status")?.textContent).toContain("needs a runner");
    m.handle.destroy();
  });
});
