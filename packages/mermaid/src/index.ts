// SPDX-License-Identifier: Apache-2.0
/**
 * @nuah/mermaid (ADR 0094): a Mermaid diagram as a card element. The source is the element's own Loro text, so two people editing it
 * merge; the diagram is drawn as a picture (an SVG image), which keeps the page's security policy as it is. A client-only plugin: no
 * server code, nothing leaves the instance. Mermaid itself loads only when a diagram is drawn.
 */
import type { EditorApi, ElementCtx, View } from "@nuah/editor-api";
import { textEdit, type ElementKindDecl } from "@nuah/editor-core";
import type { LoroText } from "loro-crdt";

import { DECL, KIND } from "./decl";
export { DECL, KIND };
const SAMPLE = "flowchart LR\n  A[Start] --> B[End]";

/** The first line that says something (comments and blank lines skipped): the diagram's Fallback. */
export function firstLine(src: string): string {
  return src.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("%%")) ?? "";
}

/** Turns `before` into `after` in the text with one delete and one insert where they differ, so others' edits elsewhere merge. */
export function applyEdit(t: LoroText, before: string, after: string) {
  const e = textEdit(before, after);
  if (!e) return;
  if (e.remove) t.delete(e.at, e.remove);
  if (e.insert) t.insert(e.at, e.insert);
}

const text = (ctx: ElementCtx) => (ctx.state as LoroText | null)?.toString() ?? "";
let seq = 0;

type Mermaid = { initialize(c: Record<string, unknown>): void; render(id: string, src: string): Promise<{ svg: string }> };
let loading: Promise<Mermaid> | null = null;
const mermaid = () => (loading ??= import("mermaid").then((m) => m.default as unknown as Mermaid));

/** Draws the source into `box` as a picture, or says what is wrong with it. Never throws. */
async function draw(box: HTMLElement, src: string, theme: string, lang: string): Promise<void> {
  const err = (msg: string) => { const e = document.createElement("div"); e.className = "nuah-mermaid-error"; e.dir = "ltr"; e.textContent = msg; box.replaceChildren(e); };
  if (!src.trim()) { box.replaceChildren(); return; }
  try {
    const m = await mermaid();
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme, flowchart: { htmlLabels: false }, htmlLabels: false });
    const { svg } = await m.render(`nuah-mermaid-${++seq}`, src);
    const img = document.createElement("img");
    img.className = "nuah-mermaid-svg";
    img.alt = firstLine(src);
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
    box.replaceChildren(img);
  } catch (e) {
    err((lang === "ar" ? "لا يمكن رسم المخطط: " : "The diagram cannot be drawn: ") + (e instanceof Error ? e.message : String(e)).split("\n")[0]);
  }
}

/** The card: the drawing, redrawn a moment after the source or the theme changes; a double click (or Edit) opens the full view. */
function card(place: HTMLElement, ctx: ElementCtx): View {
  const box = document.createElement("div");
  box.className = "nuah-mermaid";
  place.append(box);
  let last = "", timer: ReturnType<typeof setTimeout> | undefined, cur = ctx;
  const redraw = (c: ElementCtx) => {
    cur = c;
    const key = `${c.options.theme}\n${text(c)}`;
    if (key === last) return;
    last = key;
    clearTimeout(timer);
    timer = setTimeout(() => void draw(box, text(c), String(c.options.theme ?? "default"), c.lang), 300);
  };
  if (ctx.editable) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "nuah-mermaid-edit";
    edit.textContent = ctx.lang === "ar" ? "تعديل" : "Edit";
    edit.addEventListener("click", () => cur.openFull());
    place.append(edit);
  }
  box.addEventListener("dblclick", () => cur.openFull());
  redraw(ctx);
  return { update: redraw, destroy: () => clearTimeout(timer) };
}

/** The source in a text area bound to the element's Loro text (each change is one edit, committed as the element's own). */
function editor(place: HTMLElement, ctx: ElementCtx, withPreview: boolean): View {
  const wrap = document.createElement("div");
  wrap.className = "nuah-mermaid-full";
  const area = document.createElement("textarea");
  area.dir = "ltr";
  area.spellcheck = false;
  area.className = "nuah-mermaid-source";
  area.value = text(ctx);
  area.readOnly = !ctx.editable;
  wrap.append(area);
  let preview: View | null = null;
  if (withPreview) { const p = document.createElement("div"); wrap.append(p); preview = card(p, ctx); }
  let cur = ctx;
  area.addEventListener("input", () => {
    const t = cur.state as LoroText | null;
    if (!t || !cur.editable) return;
    applyEdit(t, t.toString(), area.value);
    cur.commit();
  });
  place.append(wrap);
  return {
    update(c) {
      cur = c;
      const now = text(c);
      if (area.value !== now) { const at = area.selectionStart; area.value = now; area.selectionStart = area.selectionEnd = Math.min(at, now.length); }
      preview?.update(c);
    },
    destroy() { preview?.destroy(); },
  };
}

export default function register(api: EditorApi) {
  api.element({
    kind: KIND,
    options: DECL.options,
    views: { card, full: (p, c) => editor(p, c, true), raw: (p, c) => editor(p, c, false) },
    ways: {
      slash: [{ label: DECL.label, init: () => ({ fill: (t) => (t as LoroText).insert(0, SAMPLE) }) }],
      shortcuts: [{ match: "```mermaid", init: () => ({ fill: (t) => (t as LoroText).insert(0, SAMPLE) }) }],
      files: [{ accept: DECL.accepts!, make: async (f) => { const src = await f.text(); return { fill: (t) => (t as LoroText).insert(0, src) }; } }],
    },
    fallback: (ctx) => ({ text: firstLine(text(ctx)) }),
    markdown: { to: (ctx) => "```mermaid\n" + text(ctx) + "\n```" },
  });
}
