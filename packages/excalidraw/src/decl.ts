// SPDX-License-Identifier: Apache-2.0
/** What @nuah/excalidraw declares to editor.element (also written to the crate's kinds.json by the build). */
import type { ElementKindDecl } from "@nuah/editor-core";

export const KIND = "@nuah/excalidraw/sketch";
export const DECL: ElementKindDecl = {
  kind: KIND, version: 1, shape: "card", placement: "block", label: { en: "Sketch", ar: "رسم" }, icon: "pen", group: "media",
  keywords: "excalidraw drawing whiteboard sketch canvas", state: "map", accepts: [".excalidraw", "application/vnd.excalidraw+json"],
  schema: { type: "object", properties: { height: { type: "number", minimum: 120, maximum: 1200 }, picture: { type: "string", maxLength: 300 } } },
};

