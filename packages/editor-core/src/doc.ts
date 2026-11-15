/**
 * The document: a tree of nodes in the JSON that Madar already stores (type, attrs, content, text, marks). Nothing here knows a browser or an engine.
 * Nodes are treated as immutable; every change makes new nodes along the path and shares the rest.
 */
export interface Mark { type: string; attrs?: Record<string, unknown> }
export interface Node { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: Mark[] }
/** The place of a node: the index at each level from the document down. */
export type Path = readonly number[];

export const emptyDoc = (): Node => ({ type: "doc", content: [{ type: "paragraph" }] });
export const isText = (n: Node) => n.type === "text";

export function nodeAt(doc: Node, path: Path): Node | undefined {
  let n: Node | undefined = doc;
  for (const i of path) n = n?.content?.[i];
  return n;
}

/** A copy of `doc` with the node at `path` replaced (or, with `undefined`, none: that is for `replaceChildren`). */
export function replaceAt(doc: Node, path: Path, f: (n: Node) => Node): Node {
  if (path.length === 0) return f(doc);
  const [i, ...rest] = path;
  const kids = doc.content ?? [];
  if (i === undefined || i < 0 || i >= kids.length) throw new RangeError(`no node at ${path.join("/")}`);
  return { ...doc, content: kids.map((k, j) => (j === i ? replaceAt(k, rest, f) : k)) };
}

/** Every node with its path, in document order. */
export function* walk(n: Node, path: Path = []): Generator<[Node, Path]> {
  yield [n, path];
  for (const [i, k] of (n.content ?? []).entries()) yield* walk(k, [...path, i]);
}

/** The id of a block (ADR 0043): an attribute like any other, so it travels with copy, history and versions. */
export const idOf = (n: Node): string | undefined => (typeof n.attrs?.blockId === "string" ? (n.attrs.blockId as string) : undefined);

/** Gives every node that should have an id one, and a new one to a node that repeats an id (the first keeps it). `which` says which types carry ids. */
export function assignIds(doc: Node, which: (type: string) => boolean, make: () => string): Node {
  const seen = new Set<string>();
  const go = (n: Node): Node => {
    let out = n;
    if (which(n.type)) {
      const id = idOf(n);
      if (!id || seen.has(id)) out = { ...n, attrs: { ...n.attrs, blockId: make() } };
      seen.add(idOf(out)!);
    }
    return out.content ? { ...out, content: out.content.map(go) } : out;
  };
  return go(doc);
}

/** The text of a document, blocks separated by newlines (search, previews, word count). */
export function textOf(n: Node): string {
  const parts: string[] = [];
  const go = (x: Node) => { if (x.text) parts.push(x.text); (x.content ?? []).forEach(go); if (x.type !== "text" && x.type !== "doc" && x.content) parts.push("\n"); };
  go(n);
  return parts.join("").replace(/\n+/g, "\n").trim();
}
