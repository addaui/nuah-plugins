import { Registry, type Node } from "../src";
import { runEditorPluginCompliance, remoteAddresses } from "../src/testing";
import { describe, expect, it } from "vitest";
const H = { describe, it, expect };

const base = () => {
  const r = new Registry();
  r.addNode({ id: "paragraph", group: "block", content: "inline*", ids: true });
  return r;
};
const p = (t = ""): Node => ({ type: "paragraph", content: t ? [{ type: "text", text: t }] : [] });

// A made-up plugin block that follows the rules: it is the suite's own check that a good plugin passes.
runEditorPluginCompliance({
  name: "a well-behaved callout",
  node: { id: "callout", group: "block", content: "block+", ids: true, attrs: { tone: { default: "info" }, round: { default: 8 } },
    options: [{ id: "tone", type: "choice", label: { en: "Tone" }, default: "info", choices: [{ value: "info", label: { en: "Info" } }, { value: "tip", label: { en: "Tip" } }], inherit: true },
      { id: "round", type: "number", label: { en: "Round" }, default: 8, min: 0, max: 24 }] },
  base,
  fixtures: {
    valid: [{ type: "doc", content: [{ type: "callout", attrs: { tone: "tip", round: 8, blockId: "c1" }, content: [p("hi")] }] }],
    invalid: [{ type: "doc", content: [{ type: "callout", content: [] }] }, { type: "doc", content: [{ type: "callout", attrs: { shade: 1 }, content: [p()] }] }],
  },
}, H);

describe("the suite catches a plugin that breaks the rules", () => {
  it("sees a remote picture", () => {
    expect(remoteAddresses({ type: "doc", content: [{ type: "image", attrs: { src: "https://tracker.example/p.gif" } }] })).toEqual(["src=https://tracker.example/p.gif"]);
    expect(remoteAddresses({ type: "doc", content: [{ type: "image", attrs: { src: "/files/abc" } }] })).toEqual([]);
  });
  it("sees a remote sticker, except a gif", () => {
    const d = (kind: string): Node => ({ type: "doc", attrs: { stickers: [{ kind, value: "https://x.example/a.gif" }] }, content: [p()] });
    expect(remoteAddresses(d("image"))).toHaveLength(1);
    expect(remoteAddresses(d("gif"))).toEqual([]);
  });
});

/** Runs the suite with a harness that records which checks fail instead of failing, so a bad plugin can be shown to be caught. */
function failures(c: Parameters<typeof runEditorPluginCompliance>[0]): string[] {
  const failed: string[] = [], path: string[] = [], later: Promise<void>[] = [];
  const h = {
    describe: ((name: string, f: () => void) => { path.push(name); f(); path.pop(); }) as unknown as typeof describe,
    it: ((name: string, f: () => unknown) => { const at = [...path, name].join(" > "); try { const r = f(); if (r instanceof Promise) later.push(r.catch(() => { failed.push(at); })); } catch { failed.push(at); } }) as unknown as typeof it,
    expect,
  };
  runEditorPluginCompliance(c, h);
  return failed;
}
describe("a plugin that breaks the rules fails the suite", () => {
  const ok = { type: "doc", content: [{ type: "note", attrs: { tone: "a" }, content: [p("x")] }] } as Node;
  const spec = { id: "note", group: "block" as const, content: "block+", ids: true, attrs: { tone: { default: "a" } }, options: [{ id: "tone", type: "choice" as const, label: { en: "Tone" }, default: "a", choices: [{ value: "a", label: { en: "A" } }, { value: "b", label: { en: "B" } }] }] };
  it("passes when it follows them", () => { expect(failures({ name: "n", node: spec, base, fixtures: { valid: [ok] } })).toEqual([]); });
  it("fails an option that names an attribute the node lacks", () => {
    const bad = { ...spec, options: [{ ...spec.options[0]!, attr: "missing" }] };
    expect(failures({ name: "n", node: bad, base, fixtures: { valid: [ok] } }).join()).toMatch(/well formed/);
  });
  it("fails a choice default that is not among its choices", () => {
    const bad = { ...spec, options: [{ ...spec.options[0]!, default: "zzz" }] };
    expect(failures({ name: "n", node: bad, base, fixtures: { valid: [ok] } }).join()).toMatch(/well formed/);
  });
  it("fails an attribute without a default", () => {
    const bad = { ...spec, attrs: { tone: {} as { default: unknown } } };
    expect(failures({ name: "n", node: bad, base, fixtures: { valid: [ok] } }).join()).toMatch(/default/);
  });
  it("fails a fixture that loads a remote picture", () => {
    const remote = { type: "doc", content: [{ type: "note", attrs: { tone: "a", src: "https://t.example/x.gif" }, content: [p("x")] }] } as Node;
    expect(failures({ name: "n", node: { ...spec, attrs: { ...spec.attrs, src: { default: "" } } }, base, fixtures: { valid: [remote] } }).join()).toMatch(/remote/);
  });
  it("fails an engine that changes a document on the way back", () => {
    expect(failures({ name: "n", node: spec, base, fixtures: { valid: [ok] }, roundtrip: (d) => ({ ...d, content: [] }) }).join()).toMatch(/comes back/);
  });
  it("fails an invalid fixture that the model accepts", () => {
    expect(failures({ name: "n", node: spec, base, fixtures: { valid: [ok], invalid: [ok] } }).join()).toMatch(/refused/);
  });
  it("fails when the server's check disagrees", async () => {
    const f = failures({ name: "n", node: spec, base, fixtures: { valid: [ok] }, agrees: () => false });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.join()).toMatch(/server/);
  });
});
