// SPDX-License-Identifier: Apache-2.0
/**
 * @nuah/excalidraw (ADR 0094): a sketch as a card element. The card shows the drawing; clicking it opens Excalidraw full size in a
 * modal, with Excalidraw's own undo (its changes are committed as the element's own, so the page's undo skips them). Every shape is an
 * entry of the element's Loro map: people drawing at once merge, and the card is current when the full view closes. Client only;
 * the fonts come from the plugin, so nothing leaves the instance.
 */
import type { EditorApi, ElementCtx, View } from "@nuah/editor-api";
import type { LoroMap } from "loro-crdt";
import { applyDiff, diffScene, readScene, textOf, versions, type Shape } from "./scene";

import { DECL, KIND } from "./decl";
export { DECL, KIND };

const map = (ctx: ElementCtx) => ctx.state as LoroMap | null;
const live = (shapes: Shape[]) => shapes.filter((s) => !s.isDeleted);
/** Where this module was served from: Excalidraw's fonts and stylesheet are next to it. */
const base = () => new URL("./", import.meta.url).href;

type X = typeof import("@excalidraw/excalidraw");
let lib: Promise<X> | null = null;
const excalidraw = () => {
  (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = base();
  return (lib ??= import("@excalidraw/excalidraw"));
};
function stylesheet() {
  if (document.querySelector("link[data-nuah-excalidraw]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = new URL("./index.css", import.meta.url).href;
  l.dataset.nuahExcalidraw = "";
  document.head.append(l);
}

/** The card: the sketch as a picture (from its shapes), its words when it cannot be drawn; a click opens the full view. */
function card(place: HTMLElement, ctx: ElementCtx): View {
  const box = document.createElement("div");
  box.className = "nuah-sketch";
  box.tabIndex = 0;
  box.setAttribute("role", "button");
  box.setAttribute("aria-label", ctx.lang === "ar" ? "فتح الرسم" : "Open the sketch");
  place.append(box);
  let cur = ctx, last = "";
  const draw = async (c: ElementCtx) => {
    cur = c;
    const shapes = live(readScene(map(c)));
    const key = JSON.stringify([c.data.height, [...versions(shapes)]]);
    if (key === last) return;
    last = key;
    box.style.height = `${Number(c.data.height ?? 360)}px`;
    if (!shapes.length) { box.textContent = c.lang === "ar" ? "رسم فارغ: انقر للرسم" : "An empty sketch: click to draw"; return; }
    try {
      const { exportToSvg } = await excalidraw();
      const svg = await exportToSvg({ elements: shapes as never, appState: { exportBackground: false, exportWithDarkMode: false } as never, files: null });
      const img = document.createElement("img");
      img.alt = textOf(shapes);
      img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(svg))));
      box.replaceChildren(img);
    } catch {
      box.textContent = textOf(shapes) || (c.lang === "ar" ? "رسم" : "Sketch");
    }
  };
  const open = () => cur.openFull();
  box.addEventListener("click", open);
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  void draw(ctx);
  return { update: (c) => void draw(c), destroy() {} };
}

/** Excalidraw full size. Its changes go into the map shape by shape, committed as the element's own; others' come in without entering its undo. */
function full(place: HTMLElement, ctx: ElementCtx): View {
  stylesheet();
  let cur = ctx, written = versions(readScene(map(ctx))), changed = false, unmount = () => {};
  let api: { updateScene(s: Record<string, unknown>): void; getSceneElements(): readonly Shape[] } | null = null;
  const holder = document.createElement("div");
  holder.className = "nuah-sketch-full";
  holder.style.height = "100%";
  place.append(holder);
  let x: X | null = null;
  void (async () => {
    x = await excalidraw();
    const react = await import("react");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(holder);
    unmount = () => root.unmount();
    root.render(react.createElement(x.Excalidraw as never, {
      // the full view is Excalidraw's own canvas, background included; only the card's preview follows the page
      initialData: { elements: readScene(map(cur)) },
      viewModeEnabled: !cur.editable,
      // the full view is opened to draw: its shortcuts work at once
      autoFocus: true,
      langCode: cur.lang === "ar" ? "ar-SA" : "en",
      excalidrawAPI: (a: typeof api) => { api = a; },
      onChange: (els: readonly Shape[]) => {
        const m = map(cur);
        if (!cur.editable || !m) return;
        const d = diffScene(written, els);
        if (!d.put.length && !d.remove.length) return;
        applyDiff(m, d);
        written = versions(readScene(m));
        changed = true;
        cur.commit();
      },
    }));
  })();
  return {
    update(c) {
      cur = c;
      const shapes = readScene(map(c)), v = versions(shapes);
      if (JSON.stringify([...v]) === JSON.stringify([...written])) return;
      written = v;
      api?.updateScene({ elements: shapes, captureUpdate: (x as unknown as { CaptureUpdateAction?: { NEVER: unknown } })?.CaptureUpdateAction?.NEVER ?? "NEVER" });
    },
    destroy() {
      unmount();
      // a picture of the sketch for its Fallback (readers and exports without this plugin)
      if (!changed || !cur.editable || !x) return;
      const shapes = live(readScene(map(cur)));
      void x.exportToBlob({ elements: shapes as never, mimeType: "image/png", appState: { exportBackground: true } as never, files: null })
        .then((b: Blob) => cur.files.upload(b, "sketch.png"))
        .then((url: string) => cur.set({ picture: url }))
        .catch(() => undefined);
    },
  };
}

export default function register(api: EditorApi) {
  api.element({
    kind: KIND,
    options: [{ id: "height", type: "number", pinned: true, min: 120, max: 1200, step: 20, unit: "px", default: 360, label: { en: "Height", ar: "الارتفاع" } }],
    views: { card, full },
    ways: {
      slash: [{ label: DECL.label, init: () => ({}) }],
      files: [{
        accept: DECL.accepts!,
        make: async (f) => {
          const json = JSON.parse(await f.text()) as { elements?: Shape[] };
          const shapes = (json.elements ?? []).filter((s) => s && typeof s.id === "string");
          return { fill: (m) => applyDiff(m as LoroMap, { put: shapes, remove: [] }) };
        },
      }],
    },
    fallback: (ctx) => ({ text: textOf(readScene(map(ctx))), ...(typeof ctx.data.picture === "string" ? { picture: ctx.data.picture } : {}) }),
    markdown: { to: (ctx) => (typeof ctx.data.picture === "string" ? `![${textOf(readScene(map(ctx)))}](${ctx.data.picture})` : textOf(readScene(map(ctx)))) },
  });
}
