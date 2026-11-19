/**
 * The compliance suite every editor plugin must pass (ADR 0078). A plugin that declares a block (and, with it, options) calls
 * `runEditorPluginCompliance` from its own tests; it needs vitest and nothing else, and no browser.
 *
 *   runEditorPluginCompliance({ name: "task", node: taskSpec, base, fixtures: { valid: [...], invalid: [...] } }, { describe, it, expect })
 *
 * `base` builds the registry the node lives in (the kinds its content refers to). `roundtrip` lets an engine adapter prove its own
 * model-to-engine-and-back (the PM spike passes `schema.nodeFromJSON(x).toJSON()`); without it the model's own JSON is checked.
 * `agrees` lets the host prove another implementation (Madar's Rust `richtext::check`) accepts and rejects the same fixtures.
 */
import type { describe as Describe, expect as Expect, it as It } from "vitest";

/** The test runner, handed in so the suite uses the caller's vitest (a plugin repo has its own copy) and needs none of its own. */
export interface Harness { describe: typeof Describe; it: typeof It; expect: typeof Expect }
import { assignIds, idOf, nodeAt, replaceAt, walk, type Node } from "./doc";
import { Registry, validate, type NodeSpec } from "./registry";
import { resolveOption, type OptionDecl } from "./options";

export interface Fixtures {
  /** Documents the plugin must accept and carry through unchanged. */
  valid: Node[];
  /** Documents it must refuse (or that the shared server check must refuse). */
  invalid?: Node[];
}
export interface Compliance {
  name: string;
  node: NodeSpec;
  /** A registry holding the kinds the node's content and the fixtures refer to, but not the node itself. */
  base: () => Registry;
  fixtures: Fixtures;
  /** Attributes that may hold a remote address on purpose (an embed's `src`, ADR 0077 point 8). */
  remoteOk?: string[];
  /** The engine's own trip: a document in, the document the engine gives back. */
  roundtrip?: (doc: Node, registry: Registry) => Node;
  /** Another implementation of "is this document acceptable" (the Rust check). Called for every fixture; must say what the model says. */
  agrees?: (doc: Node) => boolean | Promise<boolean>;
}

const OPTION_TYPES = ["choice", "toggle", "number", "text", "color"] as const;

/** Every remote address (an `https:` value in an attribute whose name says it is loaded) a document holds: ADR 0077 forbids them in what a viewer loads. */
export function remoteAddresses(doc: Node, loaded = ["src", "image", "icon", "poster", "thumb"], allowed: string[] = []): string[] {
  const out: string[] = [];
  const check = (attrs?: Record<string, unknown>) => { for (const [k, v] of Object.entries(attrs ?? {})) if (loaded.includes(k) && !allowed.includes(k) && typeof v === "string" && /^(https?:)?\/\//i.test(v)) out.push(`${k}=${v}`); };
  for (const [n] of walk(doc)) check(n.attrs);
  const stickers = doc.attrs?.stickers;
  if (Array.isArray(stickers)) for (const s of stickers as Record<string, unknown>[]) if (s.kind !== "gif" && typeof s.value === "string" && /^https?:/i.test(s.value)) out.push(`sticker=${s.value}`);
  return out;
}

export function runEditorPluginCompliance(c: Compliance, t: Harness): void {
  const { describe, it, expect } = t;
  const registry = () => c.base().addNode(structuredClone(c.node));
  const own = (d: Node) => [...walk(d)].map(([n]) => n).filter((n) => n.type === c.node.id);

  describe(`editor plugin compliance: ${c.name}`, () => {
    describe("the declaration", () => {
      it("is accepted by a registry, once, and a second declaration is refused", () => {
        const r = registry();
        expect(r.has(c.node.id)).toBe(true);
        expect(() => r.addNode(structuredClone(c.node))).toThrow(/already declared/);
      });
      it("has a namespaced or plain identifier and a group", () => {
        expect(c.node.id).toMatch(/^[A-Za-z][\w.-]*$/);
        expect(["block", "inline"]).toContain(c.node.group);
      });
      it("gives every attribute a default, so a document that lacks it still loads", () => {
        for (const [k, a] of Object.entries(c.node.attrs ?? {})) expect(a, `attribute ${k}`).toHaveProperty("default");
      });
      it("declares options that are well formed", () => {
        const seen = new Set<string>();
        for (const o of c.node.options ?? []) {
          expect(OPTION_TYPES, `option ${o.id}`).toContain(o.type);
          expect(seen.has(o.id), `option ${o.id} twice`).toBe(false);
          seen.add(o.id);
          expect(o.label.en, `option ${o.id} label`).toBeTruthy();
          const attr = o.attr ?? o.id;
          expect(attr in (c.node.attrs ?? {}) || attr === "align" || attr === "blockId", `option ${o.id} names attribute "${attr}" the node does not have`).toBe(true);
          if (o.type === "choice") {
            expect(o.choices?.length, `option ${o.id} choices`).toBeGreaterThan(0);
            if (o.default !== undefined && o.default !== null) expect(o.choices!.map((x) => x.value), `option ${o.id} default`).toContain(o.default);
          }
          if (o.type === "number" && o.min !== undefined && o.max !== undefined) expect(o.min).toBeLessThanOrEqual(o.max);
          if (o.type === "toggle" && o.default !== undefined && o.default !== null) expect(typeof o.default).toBe("boolean");
        }
      });
    });

    describe("documents", () => {
      it("every valid fixture is valid under the registry and has the node in it", () => {
        for (const [i, d] of c.fixtures.valid.entries()) {
          expect(validate(d, registry()), `valid[${i}]`).toEqual([]);
          expect(own(d).length, `valid[${i}] holds a "${c.node.id}"`).toBeGreaterThan(0);
        }
      });
      it("every valid fixture comes back from the engine unchanged", () => {
        const r = registry();
        for (const [i, d] of c.fixtures.valid.entries()) {
          const back = c.roundtrip ? c.roundtrip(structuredClone(d), r) : JSON.parse(JSON.stringify(d));
          expect(back, `valid[${i}]`).toEqual(d);
        }
      });
      it("every invalid fixture is refused", () => {
        for (const [i, d] of (c.fixtures.invalid ?? []).entries()) expect(validate(d, registry()).length, `invalid[${i}]`).toBeGreaterThan(0);
      });
      it("agrees with the server's check on every fixture", async () => {
        if (!c.agrees) return;
        for (const [i, d] of c.fixtures.valid.entries()) expect(await c.agrees(d), `valid[${i}] accepted by the server`).toBe(true);
        for (const [i, d] of (c.fixtures.invalid ?? []).entries()) expect(await c.agrees(d), `invalid[${i}] refused by the server`).toBe(false);
      });
      it("a missing or unknown attribute falls back to the default and does not throw", () => {
        const r = registry();
        for (const d of c.fixtures.valid) {
          const bare = structuredClone(d);
          for (const n of own(bare)) n.attrs = undefined;
          expect(() => validate(bare, r)).not.toThrow();
          expect(validate(bare, r), "a node with no attributes at all is still valid").toEqual([]);
        }
      });
      it("ids are kept, and a copy that repeats one gets a new one (ADR 0043)", () => {
        if (!c.node.ids) return;
        const r = registry();
        for (const d of c.fixtures.valid) {
          const twice: Node = { type: "doc", content: [...(d.content ?? []), ...structuredClone(d.content ?? [])] };
          let n = 0;
          const fixed = assignIds(twice, (t) => r.idTypes().has(t), () => `new${++n}`);
          const ids = [...walk(fixed)].map(([x]) => idOf(x)).filter(Boolean) as string[];
          expect(new Set(ids).size, "ids are unique after a paste of the same blocks").toBe(ids.length);
        }
      });
      it("loads no remote address (ADR 0077)", () => {
        for (const [i, d] of c.fixtures.valid.entries()) expect(remoteAddresses(d, undefined, c.remoteOk), `valid[${i}]`).toEqual([]);
      });
    });

    describe("options", () => {
      const options = c.node.options ?? [];
      it("each changes the attribute it names and nothing else", () => {
        const d = c.fixtures.valid[0];
        if (!d || options.length === 0) return;
        for (const o of options) {
          const path = [...walk(d)].find(([n]) => n.type === c.node.id)![1];
          const attr = o.attr ?? o.id;
          const value = sample(o);
          const doc = d;
          const changed = replaceAt(doc, path, (n) => ({ ...n, attrs: { ...n.attrs, [attr]: value } }));
          const after = nodeAt(changed, path)!;
          expect(after.attrs?.[attr], `option ${o.id}`).toEqual(value);
          const before = nodeAt(doc, path)!;
          for (const k of new Set([...Object.keys(before.attrs ?? {}), ...Object.keys(after.attrs ?? {})])) if (k !== attr) expect(after.attrs?.[k], `option ${o.id} left "${k}" alone`).toEqual(before.attrs?.[k]);
        }
      });
      it("resolve in the order element, page, default (ADR 0073)", () => {
        for (const o of options) {
          const attr = o.attr ?? o.id, v = sample(o), page = { [c.node.id]: { [o.id]: sample(o, true) as string | number | boolean } };
          expect(resolveOption(o, c.node.id, { [attr]: v }, page).source, `${o.id} set on the element`).toBe("element");
          if (o.inherit) {
            expect(resolveOption(o, c.node.id, {}, page), `${o.id} from the page`).toMatchObject({ source: "page", value: page[c.node.id]![o.id] });
          }
          expect(resolveOption(o, c.node.id, {}).source, `${o.id} untouched`).toBe("default");
        }
      });
    });

    describe("editing", () => {
      // undo and merging are the Live document's (ADR 0093): the editor's own suite (@nuah/editor/testing) checks them on Loro.
      it("a copy keeps every attribute", () => {
        for (const d of c.fixtures.valid) for (const n of own(d)) expect(JSON.parse(JSON.stringify(n)).attrs).toEqual(n.attrs);
      });
    });
  });
}

/** A value of the option's own kind that is not its default, or (`other`) a second different one. */
function sample(o: OptionDecl, other = false): unknown {
  const pick = <T,>(xs: T[]) => xs[other ? Math.min(1, xs.length - 1) : 0]!;
  switch (o.type) {
    case "choice": { const vs = (o.choices ?? []).map((x) => x.value).filter((v) => v !== o.default); return pick(vs.length ? vs : (o.choices ?? []).map((x) => x.value)); }
    case "toggle": return o.default !== true;
    case "number": { const lo = o.min ?? 0, hi = o.max ?? lo + 10; const v = other ? hi : lo + (hi - lo) / 2; return v === o.default ? hi : v; }
    case "color": return other ? "#112233" : "#aabbcc";
    case "text": return other ? "other" : "text";
  }
}
