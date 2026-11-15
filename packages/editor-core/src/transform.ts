import { nodeAt, replaceAt, type Node, type Path } from "./doc";

/**
 * Changes to a document, as data. Each can be applied and each says how to undo it, so history, collaboration and engines share one vocabulary and an
 * engine can be swapped without losing either. (A text-range step is not here: that is what an engine's own input handling produces, and the adapter turns
 * it into `setText` on the block it touched.)
 */
export type Step =
  | { kind: "setAttr"; path: Path; name: string; value: unknown }
  | { kind: "insert"; path: Path; index: number; node: Node }
  | { kind: "remove"; path: Path; index: number }
  | { kind: "setContent"; path: Path; content: Node[] };

export interface Applied { doc: Node; inverse: Step }

export function applyStep(doc: Node, s: Step): Applied {
  switch (s.kind) {
    case "setAttr": {
      const old = nodeAt(doc, s.path)?.attrs?.[s.name];
      const next = replaceAt(doc, s.path, (n) => {
        const attrs = { ...n.attrs };
        if (s.value === undefined) delete attrs[s.name]; else attrs[s.name] = s.value;
        return { ...n, attrs };
      });
      return { doc: next, inverse: { kind: "setAttr", path: s.path, name: s.name, value: old } };
    }
    case "insert": {
      const parent = nodeAt(doc, s.path);
      if (!parent) throw new RangeError("no parent to insert into");
      if (s.index < 0 || s.index > (parent.content?.length ?? 0)) throw new RangeError("index out of range");
      return { doc: replaceAt(doc, s.path, (n) => ({ ...n, content: [...(n.content ?? []).slice(0, s.index), s.node, ...(n.content ?? []).slice(s.index)] })), inverse: { kind: "remove", path: s.path, index: s.index } };
    }
    case "remove": {
      const parent = nodeAt(doc, s.path), gone = parent?.content?.[s.index];
      if (!gone) throw new RangeError("nothing to remove");
      return { doc: replaceAt(doc, s.path, (n) => ({ ...n, content: (n.content ?? []).filter((_, i) => i !== s.index) })), inverse: { kind: "insert", path: s.path, index: s.index, node: gone } };
    }
    case "setContent": {
      const old = nodeAt(doc, s.path)?.content ?? [];
      return { doc: replaceAt(doc, s.path, (n) => ({ ...n, content: s.content })), inverse: { kind: "setContent", path: s.path, content: old } };
    }
  }
}

/** A group of steps that happen together (one keystroke, one command). */
export interface Transaction { steps: Step[]; /** Transactions with the same group close together in time are one undo. */ group?: string }

export function applyTransaction(doc: Node, tr: Transaction): { doc: Node; inverse: Transaction } {
  const inverse: Step[] = [];
  let cur = doc;
  for (const s of tr.steps) { const a = applyStep(cur, s); cur = a.doc; inverse.unshift(a.inverse); }
  return { doc: cur, inverse: { steps: inverse, group: tr.group } };
}
