import { describe, expect, it } from "vitest";
import { LoroDoc, LoroMap } from "loro-crdt";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { updateLoroToPmState } from "loro-prosemirror";
import { Registry } from "@nuah/editor-core";
import { createEngine } from "../src/engine";

/** A registry knowing only paragraphs and bold, as if no other plugin were on. */
function basic(): Registry {
  const r = new Registry();
  r.addNode({ id: "paragraph", group: "block", content: "inline*", ids: true, dom: { tag: "p" } });
  r.addMark({ id: "bold", dom: { tag: "strong" } });
  return r;
}
/** The whole page as another person's editor (with a callout plugin and a "glow" mark) wrote it into Loro. */
function writtenByOther(): { doc: LoroDoc; json: unknown } {
  const full = new Schema({
    nodes: {
      doc: { content: "block+" }, text: { group: "inline" },
      paragraph: { group: "block", content: "inline*", attrs: { blockId: { default: null } } },
      callout: { group: "block", content: "block+", attrs: { blockId: { default: null }, tone: { default: "info" }, plugin: { default: null }, v: { default: 1 } } },
    },
    marks: { bold: {}, glow: { attrs: { color: { default: "gold" } } } },
  });
  const json = { type: "doc", content: [
    { type: "paragraph", attrs: { blockId: "b1" }, content: [{ type: "text", text: "hello " }, { type: "text", text: "shine", marks: [{ type: "glow", attrs: { color: "red" } }] }] },
    { type: "callout", attrs: { blockId: "b2", tone: "tip", plugin: "@acme/callout", v: 1 }, content: [{ type: "paragraph", attrs: { blockId: "b3" }, content: [{ type: "text", text: "inside" }] }] },
  ] };
  const doc = new LoroDoc();
  doc.configTextStyle({ bold: { expand: "after" }, glow: { expand: "after" } });
  const state = EditorState.create({ schema: full, doc: full.nodeFromJSON(json) });
  updateLoroToPmState(doc as never, new Map() as never, state);
  doc.commit();
  return { doc, json };
}
const loroJson = (d: LoroDoc) => JSON.stringify((d.toJSON() as Record<string, unknown>).doc);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the engine", () => {
  it("loads_and_round_trips_unknown_element", async () => {
    const { doc, json } = writtenByOther();
    const place = document.createElement("div");
    const e = createEngine({ place, registry: basic(), live: { doc } });
    await tick();
    expect(place.querySelector('[data-unknown="callout"]')).not.toBeNull();
    expect(e.json()).toEqual(json);
    e.destroy();
  });

  it("unknown_element_untouched_by_typing_elsewhere", async () => {
    const { doc } = writtenByOther();
    const callout = () => JSON.stringify(((doc.toJSON() as any).doc.children as any[])[1]);
    const before = callout();
    const e = createEngine({ place: document.createElement("div"), registry: basic(), live: { doc } });
    await tick();
    e.view.dispatch(e.view.state.tr.insertText("X", 1));
    await tick();
    expect(callout()).toBe(before);
    e.destroy();
  });

  it("unknown_mark_kept_in_loro", async () => {
    const { doc } = writtenByOther();
    const before = loroJson(doc);
    const e = createEngine({ place: document.createElement("div"), registry: basic(), live: { doc } });
    await tick();
    e.view.dispatch(e.view.state.tr.insertText("Y", e.view.state.doc.child(0).nodeSize - 1));
    await tick();
    const text = (doc.getMap("doc").get("children") as any).get(0).get("children").get(0);
    expect(JSON.stringify(text.toDelta())).toContain('"glow":{"color":"red"}');
    expect(before).not.toBe(loroJson(doc));
    e.destroy();
  });

  it("typing_writes_into_loro", async () => {
    const doc = new LoroDoc();
    const e = createEngine({ place: document.createElement("div"), registry: basic(), live: { doc } });
    await tick();
    e.view.dispatch(e.view.state.tr.insertText("abc", 1));
    await tick();
    expect(loroJson(doc)).toContain("abc");
    e.destroy();
  });

  it("ids_given_to_new_blocks", async () => {
    const doc = new LoroDoc();
    const e = createEngine({ place: document.createElement("div"), registry: basic(), live: { doc } });
    await tick();
    const s = e.view.state;
    e.view.dispatch(s.tr.insert(s.doc.content.size, s.schema.nodes.paragraph!.create()));
    const ids = (e.json() as any).content.map((p: any) => p.attrs.blockId);
    expect(ids.every((x: unknown) => typeof x === "string" && /^b[0-9a-z]{8}$/.test(x as string))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    e.destroy();
  });

  it("undo_takes_back_only_local_changes", async () => {
    // the page exists already (the server made it): one empty paragraph
    const a = new LoroDoc(), b = new LoroDoc();
    const plain = new Schema({ nodes: { doc: { content: "block+" }, text: { group: "inline" }, paragraph: { group: "block", content: "inline*", attrs: { blockId: { default: null } } } } });
    updateLoroToPmState(a as never, new Map() as never, EditorState.create({ schema: plain, doc: plain.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", attrs: { blockId: "b1" }, content: [{ type: "text", text: "." }] }] }) }));
    a.commit();
    const ea = createEngine({ place: document.createElement("div"), registry: basic(), live: { doc: a } });
    await tick();
    ea.view.dispatch(ea.view.state.tr.insertText("mine", 1));
    a.commit();
    b.import(a.export({ mode: "snapshot" }));
    const eb = createEngine({ place: document.createElement("div"), registry: basic(), live: { doc: b } });
    await tick();
    eb.view.dispatch(eb.view.state.tr.insertText("theirs ", 1));
    b.commit();
    a.import(b.export({ mode: "update", from: a.oplogVersion() }));
    await tick();
    expect(ea.text()).toBe("theirs mine.");
    ea.undo();
    await tick();
    expect(ea.text()).toBe("theirs .");
    ea.destroy(); eb.destroy();
  });
});
