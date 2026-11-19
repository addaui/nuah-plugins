import { describe, expect, it } from "vitest";
import type { LoroText } from "loro-crdt";
import { runElementCompliance } from "../src/testing";

// a small card plugin, as a third party would write one
const sketch = {
  default: (api: any) => api.element({
    kind: "@t/sketch/canvas",
    upgrade: { 1: (d: any) => ({ ...d, ink: d.ink ?? "black" }) },
    fallback: (ctx: any) => ({ text: (ctx.state as LoroText).toString() }),
    views: { card: (place: HTMLElement, ctx: any) => { place.textContent = (ctx.state as LoroText).toString(); return { update: (c: any) => { place.textContent = (c.state as LoroText).toString(); }, destroy() {} }; } },
  }),
};
runElementCompliance({
  plugin: "@t/sketch", module: sketch,
  kinds: [{ kind: "@t/sketch/canvas", version: 2, shape: "card", placement: "block", label: { en: "Sketch" }, state: "text" }],
  samples: { "@t/sketch/canvas": { data: { ink: "blue" }, fill: (t) => (t as LoroText).insert(0, "a circle"), other: { data: { size: 3 }, fill: (t) => (t as LoroText).insert(0, "a square ") } } },
}, { describe, it, expect });
