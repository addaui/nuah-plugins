// SPDX-License-Identifier: Apache-2.0
//! A kind's input becomes a block (ADR 0103): cards keep their content apart, content kinds fill a node template.

use nuah_editor::blocks::*;
use serde_json::{json, Value};

fn mermaid() -> Value {
    json!({"kind": "@nuah/mermaid/diagram", "version": 1, "shape": "card", "placement": "block", "state": "text",
        "schema": {"type": "object", "properties": {"theme": {"enum": ["default", "dark"]}}},
        "input": {"schema": {"type": "object", "required": ["source"], "additionalProperties": false, "properties": {
            "source": {"type": "string", "maxLength": 100000}, "theme": {"enum": ["default", "dark"]}}},
            "content": "source", "fallback": "source"}})
}

fn heading() -> Value {
    json!({"kind": "@nuah/editor-basic/heading", "version": 1, "shape": "content", "placement": "block", "nodes": ["heading"],
        "input": {"schema": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}, "level": {"enum": [1, 2, 3]}}},
            "node": {"type": "heading", "attrs": {"level": {"$": "level", "default": 1}}, "content": [{"$text": "text"}]}}})
}

fn bullets() -> Value {
    json!({"kind": "@nuah/editor-basic/bullet-list", "version": 1, "shape": "content", "placement": "block", "nodes": ["bulletList", "listItem"],
        "input": {"schema": {"type": "object", "required": ["items"], "properties": {"items": {"type": "array", "items": {"type": "string"}}}},
            "node": {"type": "bulletList", "content": [{"$each": "items", "as": {"type": "listItem", "content": [{"type": "paragraph", "content": [{"$text": "."}]}]}}]}}})
}

fn code() -> Value {
    json!({"kind": "@nuah/editor-basic/code", "version": 1, "shape": "content", "placement": "block", "nodes": ["codeBlock"],
        "input": {"schema": {"type": "object", "required": ["code"], "properties": {"code": {"type": "string"}, "language": {"type": "string"}}},
            "node": {"type": "codeBlock", "attrs": {"language": {"$": "language"}}, "content": [{"$plain": "code"}]}}})
}

#[test]
fn a_card_keeps_its_content_apart_and_its_settings_in_data() {
    let b = build(&mermaid(), &json!({"source": "graph TD; A-->B", "theme": "dark"}), "b1").unwrap();
    assert_eq!(b.node, json!({"type": "element", "attrs": {"blockId": "b1", "kind": "@nuah/mermaid/diagram", "v": 1, "plugin": "@nuah/mermaid",
        "data": {"theme": "dark"}, "fallback": {"text": "graph TD; A-->B"}}}));
    assert_eq!(b.content, Some(json!("graph TD; A-->B")));
}

#[test]
fn a_cards_input_reads_back_from_its_node_and_content() {
    let b = build(&mermaid(), &json!({"source": "graph LR", "theme": "dark"}), "b1").unwrap();
    assert_eq!(read(&mermaid(), &b.node, b.content.as_ref()), json!({"source": "graph LR", "theme": "dark"}));
}

#[test]
fn an_input_that_does_not_fit_is_refused_with_the_schema_it_expected() {
    let e = build(&mermaid(), &json!({"diagram": "x"}), "b1").unwrap_err();
    assert_eq!(e.reason.as_deref(), Some("editor.bad_input"));
    assert!(e.message.contains("source"), "{}", e.message);
}

#[test]
fn a_kind_without_input_cannot_be_built() {
    let mut d = mermaid();
    d.as_object_mut().unwrap().remove("input");
    assert_eq!(build(&d, &json!({"source": "x"}), "b1").unwrap_err().reason.as_deref(), Some("editor.no_input"));
}

#[test]
fn a_content_kind_fills_its_template_with_inline_markdown() {
    let b = build(&heading(), &json!({"text": "Hello **big** world", "level": 2}), "h1").unwrap();
    assert_eq!(b.node, json!({"type": "heading", "attrs": {"blockId": "h1", "level": 2}, "content": [
        {"type": "text", "text": "Hello "}, {"type": "text", "text": "big", "marks": [{"type": "bold"}]}, {"type": "text", "text": " world"}]}));
    assert_eq!(b.content, None);
    // a missing field takes the template's default
    assert_eq!(build(&heading(), &json!({"text": "x"}), "h2").unwrap().node["attrs"]["level"], json!(1));
}

#[test]
fn each_item_of_a_list_becomes_a_node() {
    let b = build(&bullets(), &json!({"items": ["one", "two"]}), "l1").unwrap();
    assert_eq!(b.node["content"].as_array().unwrap().len(), 2);
    assert_eq!(b.node["content"][1], json!({"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "two"}]}]}));
}

#[test]
fn plain_text_is_kept_as_it_is_and_a_missing_attribute_is_left_out() {
    let b = build(&code(), &json!({"code": "a **b**\nc"}), "c1").unwrap();
    assert_eq!(b.node, json!({"type": "codeBlock", "attrs": {"blockId": "c1"}, "content": [{"type": "text", "text": "a **b**\nc"}]}));
    // empty text gives no text node
    assert_eq!(build(&code(), &json!({"code": ""}), "c2").unwrap().node.get("content"), None);
}

#[test]
fn inline_markdown_gives_marks_links_and_line_breaks() {
    assert_eq!(inline("a *i* `c` ~~s~~ [t](https://x.y) \\*no\\*\nz"), vec![
        json!({"type": "text", "text": "a "}), json!({"type": "text", "text": "i", "marks": [{"type": "italic"}]}),
        json!({"type": "text", "text": " "}), json!({"type": "text", "text": "c", "marks": [{"type": "code"}]}),
        json!({"type": "text", "text": " "}), json!({"type": "text", "text": "s", "marks": [{"type": "strike"}]}),
        json!({"type": "text", "text": " "}), json!({"type": "text", "text": "t", "marks": [{"type": "link", "attrs": {"href": "https://x.y"}}]}),
        json!({"type": "text", "text": " *no*"}), json!({"type": "hardBreak"}), json!({"type": "text", "text": "z"})]);
    // an unsafe address is not a link; nesting keeps both marks
    assert_eq!(inline("[t](javascript:alert(1))")[0]["marks"], Value::Null);
    assert_eq!(inline("**a *b***")[1], json!({"type": "text", "text": "b", "marks": [{"type": "bold"}, {"type": "italic"}]}));
}

#[test]
fn a_node_is_matched_to_its_kind() {
    let kinds = [heading(), mermaid(), bullets()].into_iter().map(|k| (k["kind"].as_str().unwrap().to_string(), k)).collect();
    assert_eq!(kind_of(&json!({"type": "heading"}), &kinds).as_deref(), Some("@nuah/editor-basic/heading"));
    assert_eq!(kind_of(&json!({"type": "element", "attrs": {"kind": "@nuah/mermaid/diagram"}}), &kinds).as_deref(), Some("@nuah/mermaid/diagram"));
    assert_eq!(kind_of(&json!({"type": "nothing"}), &kinds), None);
}

/// A value that fits a schema: its first choice, or a small value of its type with every property filled.
fn sample(s: &Value) -> Value {
    if let Some(e) = s["enum"].as_array() {
        return e[0].clone();
    }
    match s["type"].as_str() {
        Some("string") => json!("x **y**"),
        Some("integer") => json!(s["minimum"].as_i64().unwrap_or(1)),
        Some("number") => json!(s["minimum"].as_f64().unwrap_or(1.0)),
        Some("boolean") => json!(true),
        Some("array") => json!([sample(&s["items"])]),
        _ => Value::Object(s["properties"].as_object().into_iter().flatten().map(|(k, v)| (k.clone(), sample(v))).collect()),
    }
}

#[test]
fn every_first_party_kind_with_an_input_builds_a_block_its_own_checks_accept() {
    let files = [include_str!("../../nuah-editor-basic/browser/kinds.json"), include_str!("../../nuah-mermaid/browser/kinds.json"),
        include_str!("../../nuah-excalidraw/browser/kinds.json"), include_str!("../../nuah-notebook/browser/kinds.json"), include_str!("../../nuah-previews/browser/kinds.json")];
    let kinds: std::collections::BTreeMap<String, Value> = files.iter().flat_map(|f| serde_json::from_str::<Value>(f).unwrap()["kinds"].as_array().unwrap().clone())
        .map(|k| (k["kind"].as_str().unwrap().to_string(), k)).collect();
    let mut built = 0;
    for (name, k) in &kinds {
        if !k["input"].is_object() {
            continue;
        }
        let input = sample(&k["input"]["schema"]);
        let b = build(k, &input, "b1").unwrap_or_else(|e| panic!("{name}: {}", e.message));
        nuah_editor::check_elements(&json!({"type": "doc", "content": [b.node.clone()]}), &kinds).unwrap_or_else(|e| panic!("{name}: {}", e.message));
        assert_eq!(kind_of(&b.node, &kinds).as_deref(), Some(name.as_str()), "{name}");
        if k["shape"] == "card" {
            assert!(b.content.is_some(), "{name} keeps its content");
            assert_eq!(read(k, &b.node, b.content.as_ref()), input, "{name} reads back");
        }
        built += 1;
    }
    assert!(built >= 14, "{built}");
}
