// SPDX-License-Identifier: Apache-2.0
/**
 * @nuah/editor-basic (ADR 0094): the basic elements as a plugin like any other. The editor knows none of them; this module declares
 * their nodes and marks, their options, their slash items, Markdown shortcuts and keys. Node names and attributes are the ones Madar
 * already stores, so a page's JSON keeps its shape. ProseMirror's libraries come from the editor (`prosemirror(pm)`), never bundled.
 */
import type { EditorApi, ElementDef, EditorCommands, FormatItem } from "@nuah/editor-api";
import type { ElementKindDecl, OptionDecl, NodeSpec } from "@nuah/editor-core";
import { common, createLowlight } from "lowlight";

const P = "@nuah/editor-basic";
const L = (en: string, ar: string) => ({ en, ar });
const kind = (name: string, label: { en: string; ar: string }, group: string, icon: string, keywords: string, nodes: string[], options: OptionDecl[] = [], placement: "block" | "inline" = "block"): ElementKindDecl =>
  ({ kind: `${P}/${name}`, version: 1, shape: "content", placement, label, group, icon, keywords, nodes, ...(options.length ? { options } : {}) });

const align: OptionDecl = { id: "align", type: "choice", attr: "align", label: L("Alignment", "المحاذاة"), choices: ["start", "center", "end", "justify"].map((v) => ({ value: v, label: { en: v } })) };
const TONES = ["info", "tip", "warning", "danger"] as const;
const TONE_LABEL: Record<string, { en: string; ar: string }> = { info: L("Info", "معلومة"), tip: L("Tip", "نصيحة"), warning: L("Warning", "تحذير"), danger: L("Danger", "خطر") };
const OPTIONS: Record<string, OptionDecl[]> = {
  paragraph: [align],
  heading: [{ id: "level", type: "choice", attr: "level", label: L("Level", "المستوى"), pinned: true, default: 1, choices: [1, 2, 3].map((v) => ({ value: v, label: { en: `H${v}` } })) }, align],
  "ordered-list": [{ id: "start", type: "number", attr: "start", label: L("Starts at", "يبدأ من"), min: 1, max: 9999, default: 1 }],
  quote: [align],
  code: [{ id: "language", type: "text", attr: "language", label: L("Language", "اللغة"), pinned: true }],
  callout: [{ id: "tone", type: "choice", attr: "tone", pinned: true, label: L("Kind", "النوع"), default: "info", choices: TONES.map((t) => ({ value: t, label: TONE_LABEL[t]! })) }],
};

export const KINDS: ElementKindDecl[] = [
  kind("paragraph", L("Text", "نص"), "text", "type", "plain paragraph", ["paragraph"], OPTIONS.paragraph),
  kind("heading", L("Heading", "عنوان"), "text", "heading-1", "title h1 h2 h3", ["heading"], OPTIONS.heading),
  kind("bullet-list", L("Bullet list", "قائمة نقطية"), "list", "list-bullet", "ul unordered", ["bulletList", "listItem"]),
  kind("ordered-list", L("Numbered list", "قائمة مرقمة"), "list", "list-ordered", "ol ordered", ["orderedList"], OPTIONS["ordered-list"]),
  kind("checklist", L("Checklist", "قائمة مهام"), "list", "list-check", "todo check task", ["taskList", "taskItem"]),
  kind("quote", L("Quote", "اقتباس"), "text", "quote", "blockquote cite", ["blockquote"], OPTIONS.quote),
  kind("divider", L("Divider", "فاصل"), "text", "divider", "line hr separator", ["horizontalRule"]),
  kind("code", L("Code block", "كتلة شيفرة"), "text", "code", "code snippet", ["codeBlock"], OPTIONS.code),
  kind("callout", L("Callout", "تنبيه"), "layout", "callout", "note highlight box", ["callout"], OPTIONS.callout),
  kind("toggle", L("Toggle", "قسم قابل للطي"), "layout", "toggle", "collapse fold details", ["toggle"]),
  kind("hard-break", L("Line break", "سطر جديد"), "text", "type", "br", ["hardBreak"], [], "inline"),
];

/** Addresses a link may have: web, the instance's own, an anchor, mail. Anything else (javascript:, data:) is refused. */
export const safeUrl = (u: string) => /^(https?:\/\/|\/|#|mailto:)/i.test(u || "");

const node = (id: string, s: Omit<NodeSpec, "id">): NodeSpec => ({ id, ids: s.group === "block", ...s });
const lowlight = createLowlight(common);

type Pm = Record<string, any>;

/** Each element of this plugin. */
function defs(): ElementDef[] {
  const slash = (label: { en: string; ar: string }, icon: string, group: string, keywords: string, apply: (c: EditorCommands) => void, id: string) => ({ id, label, icon, group, keywords, apply });
  return [
    {
      kind: `${P}/paragraph`, options: OPTIONS.paragraph,
      nodes: [node("paragraph", { group: "block", content: "inline*", attrs: { align: { default: null } }, dom: { tag: "p" }, defaultBlock: true }), node("text", { group: "text" })],
      marks: ["bold", "italic", "underline", "strike", "code", "highlight"].map((id) => ({ id })).concat([{ id: "link", attrs: { href: { default: "" } } } as never]),
      ways: { slash: [slash(L("Text", "نص"), "type", "text", "plain paragraph", (c) => c.setBlock("paragraph"), "text")] },
    },
    {
      kind: `${P}/heading`,
      options: OPTIONS.heading,
      nodes: [node("heading", { group: "block", content: "inline*", attrs: { level: { default: 1 }, align: { default: null } } })],
      ways: { slash: [1, 2, 3].map((l) => slash(L(`Heading ${l}`, `عنوان ${"١٢٣"[l - 1]}`), `heading-${l}`, "text", `title h${l}`, (c) => c.setBlock("heading", { level: l }), `h${l}`)) },
    },
    { kind: `${P}/bullet-list`, nodes: [node("bulletList", { group: "block", content: "listItem+" }), node("listItem", { group: "", content: "paragraph block*" } as never)],
      ways: { slash: [slash(L("Bullet list", "قائمة نقطية"), "list-bullet", "list", "ul unordered", (c) => c.toggleList("bulletList", "listItem"), "ul")] } },
    { kind: `${P}/ordered-list`, options: OPTIONS["ordered-list"],
      nodes: [node("orderedList", { group: "block", content: "listItem+", attrs: { start: { default: 1 } } })],
      ways: { slash: [slash(L("Numbered list", "قائمة مرقمة"), "list-ordered", "list", "ol ordered", (c) => c.toggleList("orderedList", "listItem"), "ol")] } },
    { kind: `${P}/checklist`, nodes: [node("taskList", { group: "block", content: "taskItem+" }), node("taskItem", { group: "", content: "paragraph block*", attrs: { checked: { default: false } } } as never)],
      ways: { slash: [slash(L("Checklist", "قائمة مهام"), "list-check", "list", "todo check task", (c) => c.toggleList("taskList", "taskItem"), "todo")] } },
    { kind: `${P}/quote`, options: OPTIONS.quote, nodes: [node("blockquote", { group: "block", content: "block+", attrs: { align: { default: null } } })],
      ways: { slash: [slash(L("Quote", "اقتباس"), "quote", "text", "blockquote cite", (c) => c.wrapIn("blockquote"), "quote")] } },
    { kind: `${P}/divider`, nodes: [node("horizontalRule", { group: "block", atom: true })],
      ways: { slash: [slash(L("Divider", "فاصل"), "divider", "text", "line hr separator", (c) => c.insertNode({ type: "horizontalRule" }), "hr")] } },
    { kind: `${P}/code`, options: OPTIONS.code,
      nodes: [node("codeBlock", { group: "block", content: "text*", attrs: { language: { default: null } } })],
      ways: { slash: [slash(L("Code block", "كتلة شيفرة"), "code", "text", "code snippet", (c) => c.setBlock("codeBlock"), "code")] } },
    { kind: `${P}/callout`, options: OPTIONS.callout,
      nodes: [node("callout", { group: "block", content: "block+", attrs: { tone: { default: "info" } } })],
      ways: { slash: TONES.map((t) => slash({ en: `Callout: ${TONE_LABEL[t]!.en}`, ar: `تنبيه: ${TONE_LABEL[t]!.ar}` }, t, "layout", `callout note ${t}`, (c) => c.insertNode({ type: "callout", attrs: { tone: t }, content: [{ type: "paragraph" }] }), `callout-${t}`)) } },
    { kind: `${P}/toggle`, nodes: [node("toggle", { group: "block", content: "paragraph block*", attrs: { open: { default: true } } })],
      ways: { slash: [slash(L("Toggle", "قسم قابل للطي"), "toggle", "layout", "collapse fold details", (c) => c.insertNode({ type: "toggle", content: [{ type: "paragraph" }, { type: "paragraph" }] }), "toggle")] } },
    { kind: `${P}/hard-break`, nodes: [node("hardBreak", { group: "inline", atom: false })] },
  ];
}

const alignAttr = (n: { attrs: { align?: string | null } }) => (n.attrs.align && ["start", "center", "end", "justify"].includes(n.attrs.align) ? { "data-align": n.attrs.align } : {});
const bid = (n: { attrs: { blockId?: string | null } }) => (n.attrs.blockId ? { "data-bid": n.attrs.blockId } : {});

/** What only a ProseMirror engine needs: DOM forms, input rules, keys, node views and code colouring. */
function prosemirror(pm: Pm, lang: () => string) {
  const { inputrules: ir, keymap: km, commands: cmd, schemaList: sl, state: st, view: vw } = pm;
  const nodes: Record<string, Record<string, unknown>> = {
    paragraph: { toDOM: (n: any) => ["p", { dir: "auto", ...alignAttr(n), ...bid(n) }, 0], parseDOM: [{ tag: "p" }] },
    heading: { defining: true, toDOM: (n: any) => [`h${n.attrs.level}`, { dir: "auto", ...alignAttr(n), ...bid(n) }, 0], parseDOM: [1, 2, 3].map((l) => ({ tag: `h${l}`, attrs: { level: l } })) },
    blockquote: { defining: true, toDOM: (n: any) => ["blockquote", { ...alignAttr(n), ...bid(n) }, 0], parseDOM: [{ tag: "blockquote" }] },
    bulletList: { toDOM: (n: any) => ["ul", bid(n), 0], parseDOM: [{ tag: "ul:not([data-type])" }] },
    orderedList: { toDOM: (n: any) => ["ol", { ...(n.attrs.start !== 1 ? { start: n.attrs.start } : {}), ...bid(n) }, 0], parseDOM: [{ tag: "ol", getAttrs: (d: HTMLElement) => ({ start: Number(d.getAttribute("start") ?? 1) }) }] },
    listItem: { defining: true, toDOM: (n: any) => ["li", bid(n), 0], parseDOM: [{ tag: "li:not([data-checked])" }] },
    taskList: { toDOM: (n: any) => ["ul", { "data-type": "taskList", ...bid(n) }, 0], parseDOM: [{ tag: 'ul[data-type="taskList"]' }] },
    taskItem: { defining: true, toDOM: (n: any) => ["li", { "data-checked": String(n.attrs.checked), ...bid(n) }, 0], parseDOM: [{ tag: "li[data-checked]", getAttrs: (d: HTMLElement) => ({ checked: d.getAttribute("data-checked") === "true" }) }] },
    horizontalRule: { toDOM: (n: any) => ["div", { class: "nuah-hr", ...bid(n) }, ["hr"]], parseDOM: [{ tag: "hr" }] },
    codeBlock: { code: true, defining: true, marks: "", toDOM: (n: any) => ["pre", { dir: "ltr", ...bid(n), ...(n.attrs.language ? { "data-language": n.attrs.language } : {}) }, ["code", 0]], parseDOM: [{ tag: "pre", preserveWhitespace: "full" }] },
    callout: { defining: true, toDOM: (n: any) => ["div", { class: "callout", "data-tone": n.attrs.tone, ...bid(n) }, 0], parseDOM: [{ tag: "div.callout", getAttrs: (d: HTMLElement) => ({ tone: d.getAttribute("data-tone") ?? "info" }) }] },
    toggle: { defining: true, toDOM: (n: any) => ["div", { class: "toggle", "data-open": String(n.attrs.open), ...bid(n) }, 0], parseDOM: [{ tag: "div.toggle" }] },
    hardBreak: { inline: true, selectable: false, toDOM: () => ["br"], parseDOM: [{ tag: "br" }] },
  };
  const marks: Record<string, Record<string, unknown>> = {
    bold: { toDOM: () => ["strong", 0], parseDOM: [{ tag: "strong" }, { tag: "b" }] },
    italic: { toDOM: () => ["em", 0], parseDOM: [{ tag: "em" }, { tag: "i" }] },
    underline: { toDOM: () => ["u", 0], parseDOM: [{ tag: "u" }] },
    strike: { toDOM: () => ["s", 0], parseDOM: [{ tag: "s" }, { tag: "del" }] },
    code: { excludes: "_", toDOM: () => ["code", 0], parseDOM: [{ tag: "code" }] },
    highlight: { toDOM: () => ["mark", 0], parseDOM: [{ tag: "mark" }] },
    link: {
      inclusive: false,
      toDOM: (m: any) => ["a", { href: safeUrl(m.attrs.href) ? m.attrs.href : "#", rel: "noopener noreferrer", target: "_blank" }, 0],
      parseDOM: [{ tag: "a[href]", getAttrs: (d: HTMLElement) => { const href = d.getAttribute("href") ?? ""; return safeUrl(href) ? { href } : false; } }],
    },
  };
  const plugins = (schema: any) => {
    const n = schema.nodes, m = schema.marks;
    const markRule = (re: RegExp, type: any) => new ir.InputRule(re, (state: any, match: string[], start: number, end: number) => {
      const text = match[1]!, tr = state.tr;
      tr.replaceWith(start, end, schema.text(text, [type.create()]));
      return tr.removeStoredMark(type);
    });
    const rules = [
      n.heading && ir.textblockTypeInputRule(/^(#{1,3})\s$/, n.heading, (mt: string[]) => ({ level: mt[1]!.length })),
      n.bulletList && ir.wrappingInputRule(/^\s*([-+*])\s$/, n.bulletList),
      n.orderedList && ir.wrappingInputRule(/^(\d+)\.\s$/, n.orderedList, (mt: string[]) => ({ start: +mt[1]! }), (mt: string[], x: any) => x.childCount + x.attrs.start === +mt[1]!),
      n.taskList && ir.wrappingInputRule(/^\s*\[( |x)?\]\s$/, n.taskList),
      n.blockquote && ir.wrappingInputRule(/^\s*>\s$/, n.blockquote),
      n.codeBlock && ir.textblockTypeInputRule(/^```([a-z0-9+#-]*)\s$/, n.codeBlock, (mt: string[]) => ({ language: mt[1] || null })),
      n.horizontalRule && new ir.InputRule(/^(?:---|—-|___\s|\*\*\*\s)$/, (state: any, _m: unknown, start: number) => {
        const $s = state.doc.resolve(start), from = $s.before(), to = $s.after();
        const tr = state.tr.replaceWith(from, to, [n.horizontalRule.create(), n.paragraph.create()]);
        return tr.setSelection(st.TextSelection.create(tr.doc, from + 2));
      }),
      m.bold && markRule(/\*\*([^*]+)\*\*$/, m.bold),
      m.italic && markRule(/(?<!\*)\*([^*]+)\*$/, m.italic),
      m.code && markRule(/`([^`]+)`$/, m.code),
      m.strike && markRule(/~~([^~]+)~~$/, m.strike),
    ].filter(Boolean);
    const item = n.taskItem ?? n.listItem;
    const keys = km.keymap({
      ...(m.bold ? { "Mod-b": cmd.toggleMark(m.bold) } : {}),
      ...(m.italic ? { "Mod-i": cmd.toggleMark(m.italic) } : {}),
      ...(m.underline ? { "Mod-u": cmd.toggleMark(m.underline) } : {}),
      ...(m.strike ? { "Mod-Shift-s": cmd.toggleMark(m.strike) } : {}),
      ...(m.code ? { "Mod-e": cmd.toggleMark(m.code) } : {}),
      ...(m.highlight ? { "Mod-Shift-h": cmd.toggleMark(m.highlight) } : {}),
      ...(n.hardBreak ? { "Shift-Enter": (s: any, d: any) => { d?.(s.tr.replaceSelectionWith(n.hardBreak.create()).scrollIntoView()); return true; } } : {}),
      Enter: cmd.chainCommands(...[n.listItem, n.taskItem].filter(Boolean).map((t: any) => sl.splitListItem(t))),
      Tab: cmd.chainCommands(...[n.listItem, n.taskItem].filter(Boolean).map((t: any) => sl.sinkListItem(t))),
      "Shift-Tab": cmd.chainCommands(...[n.listItem, n.taskItem].filter(Boolean).map((t: any) => sl.liftListItem(t))),
    });
    void item;
    const code = new st.Plugin({
      key: new st.PluginKey("nuahCodeColours"),
      props: {
        decorations(state: any) {
          const out: unknown[] = [];
          state.doc.descendants((nd: any, pos: number) => {
            if (nd.type.name !== "codeBlock") return;
            const language = nd.attrs.language;
            let tree;
            try { tree = language && lowlight.registered(language) ? lowlight.highlight(language, nd.textContent) : lowlight.highlightAuto(nd.textContent); } catch { return false; }
            let at = pos + 1;
            const walk = (kids: any[], classes: string[]) => {
              for (const k of kids) {
                if (k.type === "text") { const len = k.value.length; if (classes.length) out.push(vw.Decoration.inline(at, at + len, { class: classes.join(" ") })); at += len; }
                else if (k.children) walk(k.children, [...classes, ...((k.properties?.className as string[]) ?? [])]);
              }
            };
            walk(tree.children, []);
            return false;
          });
          return vw.DecorationSet.create(state.doc, out);
        },
      },
    });
    const calloutTitle = new st.Plugin({
      key: new st.PluginKey("nuahCalloutTitle"),
      props: {
        decorations(state: any) {
          const out: unknown[] = [];
          state.doc.descendants((nd: any, pos: number) => {
            if (nd.type.name === "callout" && nd.firstChild?.content.size === 0) out.push(vw.Decoration.node(pos + 1, pos + 1 + nd.firstChild.nodeSize, { class: "is-empty", "data-placeholder": lang() === "ar" ? "العنوان" : "Title" }));
          });
          return vw.DecorationSet.create(state.doc, out);
        },
      },
    });
    return [ir.inputRules({ rules }), keys, code, calloutTitle];
  };
  const toggleView = (nd: any, view: any, getPos: () => number) => {
    const dom = document.createElement("div"); dom.className = "toggle"; dom.dataset.open = String(nd.attrs.open);
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "toggle-btn"; btn.contentEditable = "false"; btn.setAttribute("aria-label", lang() === "ar" ? "طي" : "Toggle");
    btn.addEventListener("click", () => { const p = getPos(); const cur = view.state.doc.nodeAt(p); view.dispatch(view.state.tr.setNodeMarkup(p, undefined, { ...cur.attrs, open: !cur.attrs.open })); });
    const body = document.createElement("div"); body.className = "toggle-body";
    dom.append(btn, body);
    return { dom, contentDOM: body, update: (x: any) => { if (x.type.name !== "toggle") return false; dom.dataset.open = String(x.attrs.open); return true; } };
  };
  const taskView = (nd: any, view: any, getPos: () => number) => {
    const dom = document.createElement("li"); dom.dataset.checked = String(nd.attrs.checked);
    const box = document.createElement("input"); box.type = "checkbox"; box.checked = nd.attrs.checked; box.contentEditable = "false";
    box.addEventListener("change", () => { const p = getPos(); const cur = view.state.doc.nodeAt(p); view.dispatch(view.state.tr.setNodeMarkup(p, undefined, { ...cur.attrs, checked: box.checked })); });
    const label = document.createElement("label"); label.contentEditable = "false"; label.append(box);
    const body = document.createElement("div");
    dom.append(label, body);
    return { dom, contentDOM: body, update: (x: any) => { if (x.type.name !== "taskItem") return false; dom.dataset.checked = String(x.attrs.checked); box.checked = x.attrs.checked; return true; } };
  };
  return { nodes, marks, plugins, nodeViews: { toggle: toggleView, taskItem: taskView } };
}

/** The Format items of text (ADR 0097): marks and the link (basic: also in the Selection bar), block types, lists, alignment. */
function formats(api: EditorApi): FormatItem[] {
  const G = { marks: L("Text effects", "تأثيرات النص"), level: L("Level", "المستوى"), blocks: L("Block", "الكتلة"), lists: L("Lists", "القوائم"), align: L("Alignment", "المحاذاة") };
  const mark = (id: string, en: string, ar: string, icon = id): FormatItem => ({ id, label: L(en, ar), icon, group: "marks", groupLabel: G.marks, basic: true, applies: "text", isActive: (c) => c.markActive(id), run: (c) => { c.toggleMark(id); } });
  const level = (id: string, en: string, ar: string, icon: string, type: string, attrs?: Record<string, unknown>): FormatItem => ({ id, label: L(en, ar), icon, group: "level", groupLabel: G.level, attr: "level", applies: "block", isActive: (c) => c.blockActive(type, attrs), run: (c) => { c.setBlock(type, attrs); } });
  const list = (id: string, en: string, ar: string, icon: string, l: string, item: string): FormatItem => ({ id, label: L(en, ar), icon, group: "lists", groupLabel: G.lists, applies: "block", run: (c) => { c.toggleList(l, item); } });
  const align = (v: string, en: string, ar: string): FormatItem => ({ id: `align-${v}`, label: L(en, ar), icon: `align-${v}`, group: "align", groupLabel: G.align, attr: "align", applies: "block", isActive: (c) => ["paragraph", "heading"].some((t) => c.blockActive(t, { align: v })), run: (c) => { c.setAlign(v); } });
  return [
    mark("bold", "Bold", "عريض"), mark("italic", "Italic", "مائل"), mark("underline", "Underline", "تسطير"), mark("strike", "Strikethrough", "يتوسطه خط"),
    mark("code", "Code", "شيفرة"), mark("highlight", "Highlight", "تظليل"),
    { id: "link", label: L("Link", "رابط"), icon: "link", group: "marks", groupLabel: G.marks, basic: true, applies: "text", isActive: (c) => c.markActive("link"),
      run: async (c) => {
        if (c.markActive("link")) { c.toggleMark("link"); return; }
        const href = await api.ui.askUrl(api.lang() === "ar" ? "الرابط" : "Link");
        if (href && safeUrl(href)) c.toggleMark("link", { href });
      } },
    level("paragraph", "Text", "نص", "type", "paragraph"),
    level("heading-1", "Heading 1", "عنوان 1", "heading-1", "heading", { level: 1 }), level("heading-2", "Heading 2", "عنوان 2", "heading-2", "heading", { level: 2 }), level("heading-3", "Heading 3", "عنوان 3", "heading-3", "heading", { level: 3 }),
    { id: "quote", label: L("Quote", "اقتباس"), icon: "quote", group: "blocks", groupLabel: G.blocks, applies: "block", run: (c) => { c.wrapIn("blockquote"); } },
    { id: "code-block", label: L("Code block", "كتلة شيفرة"), icon: "code", group: "blocks", groupLabel: G.blocks, applies: "block", isActive: (c) => c.blockActive("codeBlock"), run: (c) => { c.setBlock("codeBlock"); } },
    list("bullet-list", "Bullet list", "قائمة نقطية", "list-bullet", "bulletList", "listItem"), list("ordered-list", "Numbered list", "قائمة مرقمة", "list-ordered", "orderedList", "listItem"), list("checklist", "Checklist", "قائمة مهام", "list-check", "taskList", "taskItem"),
    align("start", "Align to start", "محاذاة للبداية"), align("center", "Center", "توسيط"), align("end", "Align to end", "محاذاة للنهاية"), align("justify", "Justify", "ضبط"),
  ];
}

export default function register(api: EditorApi) {
  // an editor before API 1.1 has no Format items: the elements still register
  for (const f of formats(api)) api.format?.(f);
  let pmExtras: ReturnType<typeof prosemirror> | null = null;
  for (const def of defs()) {
    // the extras are made once and handed to the first definition; the engine merges every definition's
    const extras = def.kind === `${P}/paragraph`
      ? (pm: Pm) => {
          pmExtras ??= prosemirror(pm, () => api.lang());
          return { nodes: pmExtras.nodes, marks: pmExtras.marks, nodeViews: pmExtras.nodeViews, plugins: pmExtras.plugins };
        }
      : undefined;
    api.element({ ...def, ...(extras ? { prosemirror: extras as never } : {}) });
  }
}
