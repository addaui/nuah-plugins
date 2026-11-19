// SPDX-License-Identifier: Apache-2.0
/** What this plugin declares to editor.element (also written to its crate's kinds.json by the build). Only types are imported, so the build can read it. */
import type { ElementKindDecl } from "@nuah/editor-core";

export const KIND = "@nuah/mermaid/diagram";
export const THEMES = ["default", "dark", "neutral", "forest"] as const;
export const DECL: ElementKindDecl = {
  kind: KIND, version: 1, shape: "card", placement: "block", label: { en: "Diagram", ar: "مخطط" }, icon: "flow", group: "media",
  keywords: "mermaid flowchart sequence chart graph", state: "text", accepts: [".mmd", ".mermaid", "text/vnd.mermaid"],
  schema: { type: "object", properties: { theme: { enum: [...THEMES] } } },
  options: [{ id: "theme", type: "choice", pinned: true, inherit: true, default: "default", label: { en: "Theme", ar: "النمط" }, choices: THEMES.map((t) => ({ value: t, label: { en: t } })) }],
};
