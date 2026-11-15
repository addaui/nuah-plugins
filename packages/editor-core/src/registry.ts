import type { Node } from "./doc";
import type { OptionDecl } from "./options";

/**
 * What a plugin says about a kind of node. The Core declares the same block once (id, label, options: ADR 0020, 0073) and the Face implements it once;
 * this is the Face side's part that the model needs: what it holds, which attributes it has, and how a browser draws it.
 */
export interface NodeSpec {
  id: string;
  /** `block` and `inline` nodes live in a parent's content; `text` is the leaf of text. */
  group: "block" | "inline" | "text";
  /** What it may contain, as a list of names or groups with `*`, `+` or `?`: `"inline*"`, `"block+"`, `"listItem+"`, `"paragraph block*"`. Empty: a leaf. */
  content?: string;
  attrs?: Record<string, { default: unknown }>;
  /** An atom is one thing for the cursor (an image, a card). */
  atom?: boolean;
  /** The block carries an id (ADR 0043). */
  ids?: boolean;
  /** How an engine draws it, for an engine that needs the markup: a tag and a class. */
  dom?: { tag: string; class?: string };
  options?: OptionDecl[];
}
export interface MarkSpec { id: string; attrs?: Record<string, { default: unknown }>; dom?: { tag: string } }

/** A command a plugin adds: a name, the keys that run it, and what it does to a context the engine supplies. */
export interface CommandSpec<Ctx = unknown> { id: string; label?: string; keys?: string[]; run: (ctx: Ctx) => boolean }

/** Plugins add node kinds, marks and commands; this is where they meet. Adding what is already there is refused, so two plugins cannot silently fight. */
export class Registry {
  readonly nodes = new Map<string, NodeSpec>();
  readonly marks = new Map<string, MarkSpec>();
  readonly commands = new Map<string, CommandSpec>();

  constructor() {
    // the two kinds every document has
    this.addNode({ id: "doc", group: "block", content: "block+" });
    this.addNode({ id: "text", group: "text" });
  }
  addNode(s: NodeSpec): this { if (this.nodes.has(s.id)) throw new Error(`node "${s.id}" is already declared`); this.nodes.set(s.id, s); return this; }
  addMark(s: MarkSpec): this { if (this.marks.has(s.id)) throw new Error(`mark "${s.id}" is already declared`); this.marks.set(s.id, s); return this; }
  addCommand(c: CommandSpec): this { if (this.commands.has(c.id)) throw new Error(`command "${c.id}" is already declared`); this.commands.set(c.id, c); return this; }

  /** Adds options to a node that another plugin declared (ADR 0073): an id already there is refused. */
  addOption(node: string, o: OptionDecl): this {
    const spec = this.nodes.get(node);
    if (!spec) throw new Error(`no node "${node}" to add an option to`);
    if (spec.options?.some((x) => x.id === o.id)) throw new Error(`"${node}" already has an option "${o.id}"`);
    spec.options = [...(spec.options ?? []), o];
    return this;
  }

  /** The keys that commands claim, and any key two of them claim (a conflict the plugin author must settle). */
  keymap(): { bindings: Map<string, string>; conflicts: [string, string, string][] } {
    const bindings = new Map<string, string>(), conflicts: [string, string, string][] = [];
    for (const c of this.commands.values()) for (const k of c.keys ?? []) {
      const have = bindings.get(k);
      if (have) conflicts.push([k, have, c.id]); else bindings.set(k, c.id);
    }
    return { bindings, conflicts };
  }
  /** The nodes that carry ids. */
  idTypes = (): Set<string> => new Set([...this.nodes.values()].filter((n) => n.ids).map((n) => n.id));
  has = (type: string) => this.nodes.has(type);
}

// ---- content expressions: "heading paragraph* block+" ----
interface Part { names: string[]; min: number; max: number }
export function parseContent(expr: string, r: Registry): Part[] {
  return expr.trim() === "" ? [] : expr.trim().split(/\s+/).map((tok) => {
    const m = /^([\w|]+)([*+?])?$/.exec(tok);
    if (!m) throw new Error(`bad content expression "${expr}"`);
    const names = m[1]!.split("|").flatMap((n) => (n === "block" ? [...r.nodes.values()].filter((s) => s.group === "block").map((s) => s.id) : n === "inline" ? [...r.nodes.values()].filter((s) => s.group === "inline" || s.group === "text").map((s) => s.id) : [n]));
    const q = m[2];
    return { names, min: q === "+" || !q ? 1 : 0, max: q === "*" || q === "+" ? Infinity : 1 };
  });
}

/** Whether a list of child types fits an expression (greedy, which is enough for the shapes plugins use). */
export function fits(children: string[], parts: Part[]): boolean {
  let i = 0;
  for (const p of parts) {
    let n = 0;
    while (i < children.length && n < p.max && p.names.includes(children[i]!)) { i++; n++; }
    if (n < p.min) return false;
  }
  return i === children.length;
}

export interface Problem { path: number[]; message: string }

/**
 * What is wrong with a document under a registry. A node of an unknown type is not a problem when `keepUnknown` is set (a plugin may be switched off and its
 * content must survive), and what is inside it is not looked into.
 */
export function validate(doc: Node, r: Registry, opts: { keepUnknown?: boolean } = {}): Problem[] {
  const out: Problem[] = [];
  const go = (n: Node, path: number[]) => {
    const spec = r.nodes.get(n.type);
    if (!spec) { if (!opts.keepUnknown) out.push({ path, message: `unknown node "${n.type}"` }); return; }
    for (const m of n.marks ?? []) if (!r.marks.has(m.type)) out.push({ path, message: `unknown mark "${m.type}"` });
    for (const k of Object.keys(n.attrs ?? {})) if (!(k in (spec.attrs ?? {})) && k !== "blockId" && k !== "stickers") out.push({ path, message: `"${n.type}" has no attribute "${k}"` });
    const kids = n.content ?? [];
    if (!fits(kids.map((k) => k.type), parseContent(spec.content ?? "", r)) && !(opts.keepUnknown && kids.some((k) => !r.has(k.type)))) out.push({ path, message: `"${n.type}" cannot hold [${kids.map((k) => k.type).join(", ")}]` });
    kids.forEach((k, i) => go(k, [...path, i]));
  };
  go(doc, []);
  return out;
}
