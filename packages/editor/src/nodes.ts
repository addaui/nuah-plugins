// SPDX-License-Identifier: Apache-2.0
/**
 * The two nodes the host always has (ADR 0094): every card element is one of them, whatever its kind. The editor never looks
 * inside; the plugin that opens the kind draws it.
 */
import type { NodeSpec } from "prosemirror-model";

const elementAttrs = { blockId: { default: null }, kind: { default: "" }, v: { default: 1 }, plugin: { default: "" }, data: { default: {} }, fallback: { default: null } };

export const elementNodes: Record<string, NodeSpec> = {
  element: {
    group: "block", atom: true, selectable: true, draggable: true, attrs: elementAttrs,
    toDOM: (n) => ["div", { class: "nuah-element", "data-kind": n.attrs.kind, "data-bid": n.attrs.blockId ?? undefined }],
    parseDOM: [{ tag: "div.nuah-element", getAttrs: () => false }],
  },
  elementInline: {
    group: "inline", inline: true, atom: true, selectable: true, attrs: elementAttrs,
    toDOM: (n) => ["span", { class: "nuah-element nuah-element-inline", "data-kind": n.attrs.kind }],
    parseDOM: [{ tag: "span.nuah-element", getAttrs: () => false }],
  },
};
/** Node types whose blocks carry ids besides the registry's `ids` ones. */
export const ELEMENT_TYPES = new Set(Object.keys(elementNodes));
