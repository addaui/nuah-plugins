// SPDX-License-Identifier: Apache-2.0
//! A kind's input becomes a block ([ADR 0103]): what an element kind declares as `input` (the schema callers see, and how the input
//! becomes the block) turns a caller's `{kind, input}` into a ProseMirror node and, for a card, its own content. Callers never learn
//! how an element keeps itself; a later change inside an element changes only its declaration.
//!
//! A card's `input` names the field that becomes its own content (`content`) and the field shown as its fallback text (`fallback`);
//! the other fields its settings schema names go into its settings (`data`). A content kind's `input.node` is a node template:
//! - an attribute `{"$": "field", "default": v}` takes the field's value (left out when missing and no default);
//! - in content, `{"$text": "field"}` is inline Markdown (bold, italic, strike, code, links; a new line is a line break),
//!   `{"$plain": "field"}` is text as it is, `{"$each": "field", "as": template}` repeats the template for each item of a list;
//! - the field `.` is the value itself (an item of a list that is a string).
//!
//! [ADR 0103]: https://madar.addaui.com/#/p/c732d1c1f2a8405da02ddc3cf964557c?tab=knowledge&page=b987ca7d600b41699f21fc5d589f7c34

use crate::plugin_of;
use nuah_kernel::{schema, Error, Result};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// A block made from an input: its node, and a card's own content (kept in the kind's `state` container).
#[derive(Debug, Clone, PartialEq)]
pub struct Built {
    pub node: Value,
    pub content: Option<Value>,
}

fn bad(kind: &str, why: &str, decl: &Value) -> Error {
    Error::invalid("input", &format!("a {kind} takes {}: {why}", decl["input"]["schema"])).with_reason("editor.bad_input")
}

/// Turns `input` into a block of the kind `decl` declares, with the block id `id`. Refused (`editor.no_input`) for a kind that
/// declares no input, and (`editor.bad_input`, naming the schema expected) for an input that does not fit.
pub fn build(decl: &Value, input: &Value, id: &str) -> Result<Built> {
    let kind = decl["kind"].as_str().unwrap_or("");
    let spec = &decl["input"];
    if !spec.is_object() {
        return Err(Error::invalid("kind", &format!("a {kind} cannot be written as a block (it declares no input)")).with_reason("editor.no_input"));
    }
    schema::validate(&spec["schema"], input).map_err(|e| bad(kind, &e.message, decl))?;
    if decl["shape"] == "card" {
        let mut data = Map::new();
        for k in decl["schema"]["properties"].as_object().into_iter().flat_map(|p| p.keys()) {
            if let Some(v) = input.get(k).filter(|v| !v.is_null()) {
                data.insert(k.clone(), v.clone());
            }
        }
        let field = |n: &str| spec[n].as_str().and_then(|f| input.get(f)).filter(|v| !v.is_null()).cloned();
        let fallback = field("fallback").map(|f| json!({"text": f.as_str().map(String::from).unwrap_or_else(|| f.to_string())})).unwrap_or(Value::Null);
        let node_type = if decl["placement"] == "inline" { "elementInline" } else { "element" };
        let node = json!({"type": node_type, "attrs": {"blockId": id, "kind": kind, "v": decl["version"].as_u64().unwrap_or(1),
            "plugin": plugin_of(kind).unwrap_or(""), "data": data, "fallback": fallback}});
        return Ok(Built { node, content: field("content") });
    }
    let mut node = fill(&spec["node"], input).into_iter().next().ok_or_else(|| bad(kind, "its template made no node", decl))?;
    node["attrs"]["blockId"] = json!(id);
    Ok(Built { node, content: None })
}

fn field<'a>(input: &'a Value, name: &str) -> Option<&'a Value> {
    if name == "." { Some(input) } else { input.get(name) }.filter(|v| !v.is_null())
}

/// A template filled from `input`: the nodes it stands for (none, one, or one per item).
fn fill(t: &Value, input: &Value) -> Vec<Value> {
    let Some(o) = t.as_object() else { return vec![] };
    if let Some(f) = o.get("$text").and_then(|f| f.as_str()) {
        return field(input, f).and_then(|v| v.as_str()).map(inline).unwrap_or_default();
    }
    if let Some(f) = o.get("$plain").and_then(|f| f.as_str()) {
        return field(input, f).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| vec![json!({"type": "text", "text": s})]).unwrap_or_default();
    }
    if let Some(f) = o.get("$each").and_then(|f| f.as_str()) {
        return field(input, f).and_then(|v| v.as_array()).into_iter().flatten().flat_map(|item| fill(&o["as"], item)).collect();
    }
    let mut out = Map::new();
    out.insert("type".into(), o.get("type").cloned().unwrap_or(Value::Null));
    if let Some(attrs) = o.get("attrs").and_then(|a| a.as_object()) {
        let mut a = Map::new();
        for (k, v) in attrs {
            let value = match v.get("$").and_then(|f| f.as_str()) {
                Some(f) => field(input, f).cloned().or_else(|| v.get("default").cloned()),
                None => Some(v.clone()),
            };
            if let Some(value) = value {
                a.insert(k.clone(), value);
            }
        }
        if !a.is_empty() {
            out.insert("attrs".into(), Value::Object(a));
        }
    }
    let content: Vec<Value> = o.get("content").and_then(|c| c.as_array()).into_iter().flatten().flat_map(|c| fill(c, input)).collect();
    if !content.is_empty() {
        out.insert("content".into(), Value::Array(content));
    }
    vec![Value::Object(out)]
}

/// What a block holds, as its kind's input where it can be read back (a card: its content and settings); otherwise `{text}`, the
/// block's plain text.
pub fn read(decl: &Value, node: &Value, content: Option<&Value>) -> Value {
    let spec = &decl["input"];
    if decl["shape"] == "card" && spec.is_object() {
        let mut out = node["attrs"]["data"].as_object().cloned().unwrap_or_default();
        out.retain(|k, _| !k.starts_with("x:"));
        if let (Some(f), Some(c)) = (spec["content"].as_str(), content) {
            out.insert(f.to_string(), c.clone());
        }
        return Value::Object(out);
    }
    json!({"text": text_of(node)})
}

/// A node's plain text, its blocks a line each.
pub fn text_of(n: &Value) -> String {
    match n["type"].as_str() {
        Some("text") => n["text"].as_str().unwrap_or("").to_string(),
        Some("hardBreak") => "\n".to_string(),
        _ => {
            let parts: Vec<String> = n["content"].as_array().into_iter().flatten().map(text_of).collect();
            let inline = n["content"].as_array().is_some_and(|c| c.iter().all(|x| matches!(x["type"].as_str(), Some("text" | "hardBreak" | "elementInline"))));
            parts.join(if inline { "" } else { "\n" })
        }
    }
}

/// The kind a node belongs to: an element's own kind, or the content kind that declares its node type.
pub fn kind_of(node: &Value, kinds: &BTreeMap<String, Value>) -> Option<String> {
    let t = node["type"].as_str()?;
    if t == "element" || t == "elementInline" {
        return node["attrs"]["kind"].as_str().map(String::from);
    }
    kinds.values().find(|k| k["nodes"].as_array().is_some_and(|n| n.first().and_then(|x| x.as_str()) == Some(t))).and_then(|k| k["kind"].as_str().map(String::from))
}

/// Every kind that can be written as a block, with its label and the input it takes (`editor.inputs`).
pub fn inputs(kinds: &BTreeMap<String, Value>) -> Value {
    let list: Vec<Value> = kinds.values().filter(|k| k["input"].is_object() && k["placement"] != "floating")
        .map(|k| json!({"kind": k["kind"], "label": k["label"]["en"], "shape": k["shape"], "input": k["input"]["schema"]}))
        .collect();
    json!({"kinds": list})
}

/// Addresses a link may have: web, the instance's own, an anchor, mail (as the editor's `safeUrl`).
fn safe_url(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    l.starts_with("http://") || l.starts_with("https://") || l.starts_with('/') || l.starts_with('#') || l.starts_with("mailto:")
}

/// Inline Markdown as ProseMirror text nodes: `**bold**`, `*italic*` or `_italic_`, `~~strike~~`, `` `code` ``, `[text](address)`,
/// a backslash escapes the next character, a new line is a line break. Marks come in name order.
pub fn inline(s: &str) -> Vec<Value> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = vec![];
    run(&chars, &[], &mut out);
    // adjacent text with the same marks is one node
    let mut merged: Vec<Value> = vec![];
    for n in out {
        if let Some(last) = merged.last_mut() {
            if last["type"] == "text" && n["type"] == "text" && last.get("marks") == n.get("marks") {
                let joined = format!("{}{}", last["text"].as_str().unwrap_or(""), n["text"].as_str().unwrap_or(""));
                last["text"] = json!(joined);
                continue;
            }
        }
        merged.push(n);
    }
    merged
}

fn push_text(out: &mut Vec<Value>, text: &str, marks: &[Value]) {
    if text.is_empty() {
        return;
    }
    let mut n = json!({"type": "text", "text": text});
    if !marks.is_empty() {
        let mut m = marks.to_vec();
        m.sort_by(|a, b| a["type"].as_str().cmp(&b["type"].as_str()));
        n["marks"] = Value::Array(m);
    }
    out.push(n);
}

fn find(c: &[char], from: usize, pat: &[char]) -> Option<usize> {
    (from..c.len().saturating_sub(pat.len() - 1)).find(|&i| c[i..].starts_with(pat) && (i == 0 || c[i - 1] != '\\'))
}

fn run(c: &[char], marks: &[Value], out: &mut Vec<Value>) {
    let mut buf = String::new();
    let mut i = 0;
    let with = |m: &str| -> Vec<Value> {
        let mut v = marks.to_vec();
        if !v.iter().any(|x| x["type"] == m) {
            v.push(json!({"type": m}));
        }
        v
    };
    while i < c.len() {
        let ch = c[i];
        if ch == '\\' && i + 1 < c.len() {
            buf.push(c[i + 1]);
            i += 2;
            continue;
        }
        if ch == '\n' {
            push_text(out, &buf, marks);
            buf.clear();
            out.push(json!({"type": "hardBreak"}));
            i += 1;
            continue;
        }
        if ch == '`' {
            if let Some(end) = find(c, i + 1, &['`']) {
                push_text(out, &buf, marks);
                buf.clear();
                let code: String = c[i + 1..end].iter().collect();
                push_text(out, &code, &with("code"));
                i = end + 1;
                continue;
            }
        }
        if ch == '[' {
            if let Some(close) = find(c, i + 1, &[']']) {
                if c.get(close + 1) == Some(&'(') {
                    if let Some(end) = find(c, close + 2, &[')']) {
                        // the address runs to the last `)` that balances its own parentheses
                        let mut depth = 0;
                        let mut stop = None;
                        for (k, &x) in c.iter().enumerate().skip(close + 2) {
                            match x {
                                '(' => depth += 1,
                                ')' if depth == 0 => { stop = Some(k); break; }
                                ')' => depth -= 1,
                                _ => {}
                            }
                        }
                        let end = stop.unwrap_or(end);
                        let href: String = c[close + 2..end].iter().collect();
                        push_text(out, &buf, marks);
                        buf.clear();
                        let label = &c[i + 1..close];
                        if safe_url(href.trim()) {
                            let mut m = marks.to_vec();
                            m.push(json!({"type": "link", "attrs": {"href": href.trim()}}));
                            run(label, &m, out);
                        } else {
                            run(label, marks, out);
                        }
                        i = end + 1;
                        continue;
                    }
                }
            }
        }
        let delims: [(&[char], &str); 4] = [(&['*', '*'], "bold"), (&['~', '~'], "strike"), (&['*'], "italic"), (&['_'], "italic")];
        let mut matched = false;
        for (d, mark) in delims {
            if c[i..].starts_with(d) && c.get(i + d.len()).is_some_and(|x| !x.is_whitespace()) {
                if mark == "italic" && d[0] == '_' && i > 0 && c[i - 1].is_alphanumeric() {
                    continue; // snake_case is not emphasis
                }
                let mut end = find(c, i + d.len() + 1, d);
                if d.len() == 1 && d[0] == '*' {
                    // a single `*` never closes on a `**`
                    while let Some(e) = end {
                        if c.get(e + 1) != Some(&'*') {
                            break;
                        }
                        end = find(c, e + 2, d);
                    }
                } else if let Some(mut e) = end {
                    // `**a *b***`: a longer closing run closes at its end
                    while c.get(e + d.len()) == Some(&d[0]) {
                        e += 1;
                    }
                    end = Some(e);
                }
                if let Some(e) = end.filter(|&e| e > i + d.len()) {
                    push_text(out, &buf, marks);
                    buf.clear();
                    run(&c[i + d.len()..e], &with(mark), out);
                    i = e + d.len();
                    matched = true;
                    break;
                }
            }
        }
        if matched {
            continue;
        }
        buf.push(ch);
        i += 1;
    }
    push_text(out, &buf, marks);
}
