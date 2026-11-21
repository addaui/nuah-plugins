// SPDX-License-Identifier: Apache-2.0
/** What @nuah/previews declares to editor.element (written to its kinds.json by the build). Only types are imported. */
import type { ElementKindDecl } from "@nuah/editor-core";

const L = (en: string, ar: string) => ({ en, ar });
export const KINDS: ElementKindDecl[] = [
  { kind: "@nuah/previews/link-card", version: 1, shape: "content", placement: "block", label: L("Link preview", "معاينة رابط"), icon: "bookmark", group: "embed",
    keywords: "url bookmark link card", nodes: ["linkPreview"],
    input: { schema: { type: "object", required: ["url"], additionalProperties: false, properties: { url: { type: "string", maxLength: 2000, description: "The web address" },
      title: { type: "string", maxLength: 300 }, description: { type: "string", maxLength: 1000 }, mode: { enum: ["card", "compact", "stack", "side"] } } },
      node: { type: "linkPreview", attrs: { url: { $: "url" }, title: { $: "title" }, description: { $: "description" }, mode: { $: "mode", default: "card" } } } },
    options: [{ id: "mode", type: "choice", attr: "mode", pinned: true, default: "card", label: L("Layout", "التخطيط"), choices: ["card", "compact", "stack", "side"].map((v) => ({ value: v, label: { en: v } })) }] },
  { kind: "@nuah/previews/youtube", version: 1, shape: "content", placement: "block", label: L("YouTube", "يوتيوب"), icon: "video", group: "embed",
    keywords: "video youtube", nodes: ["youtube"],
    input: { schema: { type: "object", required: ["url"], additionalProperties: false, properties: { url: { type: "string", maxLength: 2000, description: "The YouTube address" },
      start: { type: "number", minimum: 0, maximum: 86400, description: "Where it starts, in seconds" } } },
      node: { type: "youtube", attrs: { src: { $: "url" }, start: { $: "start", default: 0 } } } },
    options: [
      { id: "size", type: "choice", attr: "size", inherit: true, pinned: true, label: L("Size", "الحجم"), choices: ["small", "medium", "wide", "full"].map((v) => ({ value: v, label: { en: v } })) },
      { id: "ratio", type: "choice", attr: "ratio", inherit: true, label: L("Shape", "الشكل"), choices: ["16-9", "4-3", "1-1"].map((v) => ({ value: v, label: { en: v } })) },
      { id: "start", type: "number", attr: "start", min: 0, max: 86400, unit: "s", label: L("Starts at", "يبدأ عند"), default: 0 },
    ] },
];
