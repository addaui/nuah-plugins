import { describe, expect, it } from "vitest";
import { LoroDoc, LoroMap } from "loro-crdt";
import { diffScene, applyDiff, readScene, textOf } from "../src/scene";

const shape = (id: string, version: number, extra: Record<string, unknown> = {}) => ({ id, version, type: "rectangle", x: 0, y: 0, isDeleted: false, ...extra });
const mapOf = (d: LoroDoc) => d.getMap("elements").ensureMergeableMap("s1") as LoroMap;
const sync = (a: LoroDoc, b: LoroDoc) => { a.commit(); b.commit(); b.import(a.export({ mode: "update", from: b.oplogVersion() })); a.import(b.export({ mode: "update", from: a.oplogVersion() })); };

describe("the scene", () => {
  it("diff_scene_only_changed_shapes", () => {
    const prev = new Map([["a", 1], ["b", 2], ["c", 1]]);
    const d = diffScene(prev, [shape("a", 1), shape("b", 3), shape("d", 1)] as never);
    expect(d.put.map((s) => s.id)).toEqual(["b", "d"]);
    expect(d.remove).toEqual(["c"]);
  });

  it("two_people_drawing_different_shapes_both_kept", () => {
    const a = new LoroDoc(), b = new LoroDoc();
    applyDiff(mapOf(a), { put: [shape("x", 1)] as never, remove: [] });
    applyDiff(mapOf(b), { put: [shape("y", 1)] as never, remove: [] });
    sync(a, b);
    expect(readScene(mapOf(a)).map((s) => s.id).sort()).toEqual(["x", "y"]);
    expect(readScene(mapOf(b)).map((s) => s.id).sort()).toEqual(["x", "y"]);
  });

  it("same_shape_last_version_wins", () => {
    const a = new LoroDoc(), b = new LoroDoc();
    applyDiff(mapOf(a), { put: [shape("x", 1)] as never, remove: [] });
    sync(a, b);
    applyDiff(mapOf(a), { put: [shape("x", 2, { x: 10 })] as never, remove: [] });
    applyDiff(mapOf(b), { put: [shape("x", 5, { x: 50 })] as never, remove: [] });
    sync(a, b);
    // both copies agree, on one whole shape (never half of each)
    const sa = readScene(mapOf(a)).find((s) => s.id === "x")!, sb = readScene(mapOf(b)).find((s) => s.id === "x")!;
    expect(sa).toEqual(sb);
    expect([2, 5]).toContain(sa.version);
    expect(sa.x).toBe(sa.version === 2 ? 10 : 50);
  });

  it("text_labels_make_the_fallback", () => {
    expect(textOf([shape("t1", 1, { type: "text", text: "Login" }), shape("r", 1), shape("t2", 1, { type: "text", text: "Home" })] as never)).toBe("Login · Home");
  });
});

import { runElementCompliance } from "@nuah/editor/testing";
import register, { DECL, KIND } from "../src/index";
runElementCompliance({
  plugin: "@nuah/excalidraw", module: { default: register }, kinds: [DECL],
  samples: { [KIND]: { data: { height: 300 }, fill: (m) => (m as LoroMap).set("a", { id: "a", version: 1, type: "text", text: "Login", isDeleted: false }), other: { data: {}, fill: (m) => (m as LoroMap).set("b", { id: "b", version: 1, type: "rectangle", isDeleted: false }) } } },
}, { describe, it, expect });
