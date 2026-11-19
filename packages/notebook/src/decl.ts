// SPDX-License-Identifier: Apache-2.0
/** What this plugin declares to editor.element (also written to its crate's kinds.json by the build). Only types are imported, so the build can read it. */
import type { ElementKindDecl } from "@nuah/editor-core";

export const KIND = "@nuah/notebook/cell";
export const DECL: ElementKindDecl = {
  kind: KIND, version: 1, shape: "card", placement: "block", label: { en: "Code cell", ar: "خلية شيفرة" }, icon: "code", group: "code",
  keywords: "python notebook run code cell jupyter", state: "text", accepts: [".py", "text/x-python"],
  schema: { type: "object", properties: {
    language: { enum: ["python"] }, view: { enum: ["both", "code", "output"] },
    output: { type: "object", properties: { text: { type: "string", maxLength: 100000 }, files: { type: "array", maxItems: 20, items: { type: "string" } }, hash: { type: "string" }, at: { type: "number" }, ok: { type: "boolean" } } },
  } },
};
