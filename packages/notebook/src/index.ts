// SPDX-License-Identifier: Apache-2.0
/**
 * @nuah/notebook (ADR 0096): a code cell. The source is the element's own Loro text (people typing in it merge); Run sends it to the
 * Runner for its language and keeps what came back with the element: the text it printed, and its pictures stored as Files, with the
 * hash of the source that made them. Someone who can only read the page sees the last output and no Run button.
 */
import type { EditorApi, ElementCtx, View } from "@nuah/editor-api";
import { textEdit, type ElementKindDecl } from "@nuah/editor-core";
import type { LoroText } from "loro-crdt";

import { DECL, KIND } from "./decl";
export { DECL, KIND };
type Output = { text: string; files: string[]; hash: string; at: number; ok: boolean };
const W = (lang: string, en: string, ar: string) => (lang === "ar" ? ar : en);
const source = (ctx: ElementCtx) => (ctx.state as LoroText | null)?.toString() ?? "";

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function card(place: HTMLElement, ctx: ElementCtx): View {
  let cur = ctx;
  const root = document.createElement("div");
  root.className = "nuah-cell";
  const area = document.createElement("textarea");
  area.className = "nuah-cell-source";
  area.dir = "ltr";
  area.spellcheck = false;
  area.rows = Math.max(2, source(ctx).split("\n").length);
  const bar = document.createElement("div");
  bar.className = "nuah-cell-bar";
  const status = document.createElement("span");
  status.className = "nuah-cell-status";
  status.setAttribute("role", "status");
  const out = document.createElement("div");
  out.className = "nuah-cell-output";
  out.dir = "ltr";
  let run: HTMLButtonElement | null = null;
  if (ctx.editable) {
    run = document.createElement("button");
    run.type = "button";
    run.className = "nuah-cell-run";
    run.textContent = W(ctx.lang, "Run", "تشغيل");
    run.title = "Ctrl+Enter";
    run.addEventListener("click", () => void go());
    bar.append(run);
  }
  bar.append(status);
  root.append(area, bar, out);
  place.append(root);

  area.addEventListener("input", () => {
    const t = cur.state as LoroText | null;
    if (!t || !cur.editable) return;
    const e = textEdit(t.toString(), area.value);
    if (!e) return;
    if (e.remove) t.delete(e.at, e.remove);
    if (e.insert) t.insert(e.at, e.insert);
    cur.commit();
  });
  area.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void go(); } });

  const showOutput = (o: Output | undefined) => {
    out.replaceChildren();
    if (!o) return;
    if (o.text) { const pre = document.createElement("pre"); pre.textContent = o.text; if (!o.ok) pre.className = "is-error"; out.append(pre); }
    for (const f of o.files) { const img = document.createElement("img"); img.src = f; img.alt = W(cur.lang, "Output picture", "صورة الناتج"); out.append(img); }
  };
  const show = (c: ElementCtx) => {
    cur = c;
    area.readOnly = !c.editable;
    const s = source(c);
    if (area.value !== s) { const at = area.selectionStart; area.value = s; area.selectionStart = area.selectionEnd = Math.min(at, s.length); }
    const view = String(c.data.view ?? "both");
    area.hidden = view === "output";
    out.hidden = view === "code";
    showOutput(c.data.output as Output | undefined);
  };

  async function go() {
    if (!run || run.disabled) return;
    run.disabled = true;
    status.textContent = "";
    const src = source(cur), language = String(cur.data.language ?? "python");
    try {
      const r = await cur.run(language, src, (p) => { status.textContent = p.stage === "loading" ? W(cur.lang, "Loading Python…", "جارٍ تحميل بايثون…") : W(cur.lang, "Running…", "جارٍ التشغيل…"); });
      const files: string[] = [];
      for (const f of r.files) files.push(await cur.files.upload(new Blob([f.bytes as BlobPart], { type: f.type }), f.name));
      cur.set({ output: { text: r.stdout + r.stderr, files, hash: await sha256(src), at: Date.now(), ok: r.ok } satisfies Output });
      status.textContent = r.ok ? W(cur.lang, `Done in ${r.ms} ms`, `انتهى خلال ${r.ms} م.ث`) : W(cur.lang, "It failed", "فشل التشغيل");
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      run.disabled = false;
    }
  }
  show(ctx);
  return { update: show, destroy() {} };
}

export default function register(api: EditorApi) {
  api.element({
    kind: KIND,
    options: [
      { id: "view", type: "choice", pinned: true, default: "both", label: { en: "Show", ar: "عرض" }, choices: [
        { value: "both", label: { en: "Code and output", ar: "الشيفرة والناتج" } }, { value: "code", label: { en: "Code", ar: "الشيفرة" } }, { value: "output", label: { en: "Output", ar: "الناتج" } }] },
    ],
    views: { card },
    ways: {
      slash: [{ label: DECL.label, init: () => ({ data: { language: "python" } }) }],
      shortcuts: [{ match: "```python", init: () => ({ data: { language: "python" } }) }],
      files: [{ accept: DECL.accepts!, make: async (f) => { const src = await f.text(); return { data: { language: "python" }, fill: (t) => (t as LoroText).insert(0, src) }; } }],
    },
    fallback: (ctx) => {
      const first = source(ctx).split("\n").find((l) => l.trim()) ?? "";
      const o = ctx.data.output as Output | undefined;
      const said = o?.text.split("\n").find((l) => l.trim()) ?? "";
      return { text: [first, said].filter(Boolean).join(" → "), ...(o?.files[0] ? { picture: o.files[0] } : {}) };
    },
    markdown: { to: (ctx) => "```" + String(ctx.data.language ?? "python") + "\n" + source(ctx) + "\n```" + ((ctx.data.output as Output | undefined)?.text ? "\n\n```\n" + (ctx.data.output as Output).text + "```" : "") },
  });
}
