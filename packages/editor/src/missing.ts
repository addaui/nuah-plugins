// SPDX-License-Identifier: Apache-2.0
/**
 * An element no enabled plugin opens (ADR 0094): a bar that says so and what can be done, with the element's Fallback under it. The
 * element is never changed. Raw data opens in a modal, never in the page.
 */
import type { Ui } from "@nuah/editor-api";
import { msg } from "./messages";

export interface MissingInfo {
  plugin: string;
  attrs: Record<string, unknown>;
  state: unknown;
  lang: string;
  ui: Ui;
  needsPlugin?: (plugin: string) => { known: boolean; canEnable: boolean; enable(): Promise<void> };
}

const button = (label: string, onclick: () => void) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => { e.preventDefault(); onclick(); });
  return b;
};

export function rawData(attrs: Record<string, unknown>, state: unknown): string {
  return JSON.stringify({ ...attrs, state }, null, 2);
}

export function showRaw(ui: Ui, lang: string, attrs: Record<string, unknown>, state: unknown) {
  ui.modal(msg(lang, "rawTitle"), (el) => {
    const pre = document.createElement("pre");
    pre.className = "nuah-raw";
    pre.dir = "ltr";
    pre.textContent = rawData(attrs, state);
    el.append(pre);
  });
}

export function missingBar(i: MissingInfo): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "nuah-missing";
  bar.setAttribute("role", "note");
  const text = document.createElement("span");
  bar.append(text);
  const known = i.needsPlugin?.(i.plugin);
  if (known?.known) {
    text.textContent = msg(i.lang, "needs", { plugin: i.plugin });
    if (known.canEnable) bar.append(button(msg(i.lang, "enable"), () => void known.enable()));
    else bar.append(button(msg(i.lang, "ask"), () => i.ui.toast(msg(i.lang, "needs", { plugin: i.plugin }))));
  } else {
    text.textContent = msg(i.lang, "unknown");
  }
  bar.append(button(msg(i.lang, "viewRaw"), () => showRaw(i.ui, i.lang, i.attrs, i.state)));
  return bar;
}

/** The Fallback's text and picture, as a quiet stand-in. */
export function fallbackView(fb: unknown): HTMLElement {
  const box = document.createElement("div");
  box.className = "nuah-fallback";
  const f = fb as { text?: string; picture?: string } | null;
  if (f?.picture) { const img = document.createElement("img"); img.src = f.picture; img.alt = f.text ?? ""; box.append(img); }
  if (f?.text) { const p = document.createElement("div"); p.textContent = f.text; box.append(p); }
  return box;
}
