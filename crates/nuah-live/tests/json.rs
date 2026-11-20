// SPDX-License-Identifier: Apache-2.0
//! The layout of loro-prosemirror 0.4, read and written from the server (ADR 0093).

use nuah_live::*;
use serde_json::{json, Value};

fn styles() -> TextStyles {
    TextStyles::from([("link", Expand::None)])
}

/// ProseMirror JSON with marks in name order, so two copies that differ only in mark order compare equal.
fn norm(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut out = serde_json::Map::new();
            for (k, x) in m {
                if k == "marks" {
                    let mut ms: Vec<Value> = x.as_array().unwrap().iter().map(norm).collect();
                    ms.sort_by(|a, b| a["type"].as_str().cmp(&b["type"].as_str()));
                    out.insert(k.clone(), Value::Array(ms));
                } else {
                    out.insert(k.clone(), norm(x));
                }
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        x => x.clone(),
    }
}

fn fixtures() -> Vec<(String, Value)> {
    let f: Value = serde_json::from_str(include_str!("richtext.json")).unwrap();
    f["documents"].as_array().unwrap().iter().filter(|d| d["server"] == true && d["doc"]["type"] == "doc").map(|d| (d["name"].as_str().unwrap().to_string(), d["doc"].clone())).collect()
}

fn para(id: &str, text: &str) -> Value {
    json!({"type": "paragraph", "attrs": {"blockId": id}, "content": [{"type": "text", "text": text}]})
}

fn page(n: usize) -> Value {
    json!({"type": "doc", "content": (0..n).map(|i| para(&format!("b{i}"), &format!("Paragraph number {i} with a few words in it."))).collect::<Vec<_>>()})
}

#[test]
fn every_fixture_survives_json_to_loro_to_json() {
    let list = fixtures();
    assert!(list.len() > 10);
    for (name, doc) in list {
        let d = new_doc(&styles());
        write_json(&d, &doc).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(norm(&to_json(&d)), norm(&doc), "{name}");
    }
}

#[test]
fn writing_an_equal_body_changes_nothing() {
    let d = new_doc(&styles());
    let doc = page(20);
    write_json(&d, &doc).unwrap();
    let before = d.oplog_vv();
    write_json(&d, &doc).unwrap();
    assert_eq!(d.oplog_vv(), before);
}

#[test]
fn a_one_word_edit_is_a_small_update() {
    let d = new_doc(&styles());
    let mut doc = page(50);
    write_json(&d, &doc).unwrap();
    let before = d.oplog_vv();
    doc["content"][25]["content"][0]["text"] = json!("Paragraph number 25 with a few new words in it.");
    write_json(&d, &doc).unwrap();
    let update = d.export(loro::ExportMode::updates(&before)).unwrap();
    assert!(update.len() < 200, "{} bytes", update.len());
    assert_eq!(to_json(&d), doc);
}

#[test]
fn marks_change_without_rewriting_the_text() {
    let d = new_doc(&styles());
    let mut doc = json!({"type": "doc", "content": [para("a", "make this bold")]});
    write_json(&d, &doc).unwrap();
    doc["content"][0]["content"] = json!([{"type": "text", "text": "make this "}, {"type": "text", "text": "bold", "marks": [{"type": "bold"}]}]);
    write_json(&d, &doc).unwrap();
    assert_eq!(norm(&to_json(&d)), norm(&doc));
    doc["content"][0]["content"] = json!([{"type": "text", "text": "make "}, {"type": "text", "text": "this bold", "marks": [{"type": "link", "attrs": {"href": "https://example.com"}}]}]);
    write_json(&d, &doc).unwrap();
    assert_eq!(norm(&to_json(&d)), norm(&doc));
}

#[test]
fn arabic_emoji_and_combining_marks_survive_a_diff() {
    let d = new_doc(&styles());
    let mut doc = json!({"type": "doc", "content": [para("a", "مَرْحَبًا بالعالم 👋🏽 e\u{301}")]});
    write_json(&d, &doc).unwrap();
    assert_eq!(to_json(&d), doc);
    doc["content"][0]["content"][0]["text"] = json!("مَرْحَبًا يا عالم 👋🏽👍 é e\u{301}");
    write_json(&d, &doc).unwrap();
    assert_eq!(to_json(&d), doc);
    doc["content"][0]["content"] = json!([{"type": "text", "text": "مَرْحَبًا ", "marks": [{"type": "bold"}]}, {"type": "text", "text": "يا عالم 👋🏽👍 é e\u{301}"}]);
    write_json(&d, &doc).unwrap();
    assert_eq!(norm(&to_json(&d)), norm(&doc));
}

#[test]
fn a_moved_block_keeps_its_id_and_inline_nodes_stay_in_place() {
    let d = new_doc(&styles());
    let mut doc = json!({"type": "doc", "content": [para("a", "first"), para("b", "second"), {"type": "paragraph", "attrs": {"blockId": "c"},
        "content": [{"type": "text", "text": "line"}, {"type": "hardBreak"}, {"type": "text", "text": "next"}]}]});
    write_json(&d, &doc).unwrap();
    assert_eq!(to_json(&d), doc);
    let moved = doc["content"][0].clone();
    doc["content"].as_array_mut().unwrap().remove(0);
    doc["content"].as_array_mut().unwrap().push(moved);
    write_json(&d, &doc).unwrap();
    assert_eq!(to_json(&d), doc);
}

#[test]
fn two_peers_editing_one_paragraph_keep_both_edits() {
    let a = new_doc(&styles());
    write_json(&a, &json!({"type": "doc", "content": [para("a", "hello world")]})).unwrap();
    let b = new_doc(&styles());
    b.import(&a.export(loro::ExportMode::Snapshot).unwrap()).unwrap();
    write_json(&a, &json!({"type": "doc", "content": [para("a", "hello big world")]})).unwrap();
    write_json(&b, &json!({"type": "doc", "content": [para("a", "hello world!")]})).unwrap();
    a.import(&b.export(loro::ExportMode::Snapshot).unwrap()).unwrap();
    b.import(&a.export(loro::ExportMode::Snapshot).unwrap()).unwrap();
    assert_eq!(to_json(&a), to_json(&b));
    assert_eq!(to_json(&a)["content"][0]["content"][0]["text"], "hello big world!");
}

#[test]
fn something_that_is_not_a_document_is_refused() {
    let d = new_doc(&styles());
    assert!(write_json(&d, &json!({"type": "paragraph"})).is_err());
    assert!(write_json(&d, &json!([1, 2])).is_err());
}

/// An element written with `state` (an import, an agent) gets that as its own content, kept where the editor keeps it (the root map
/// `elements`, by block id); the attribute itself is not stored, and a later write never replaces content that is there (ADR 0094).
#[test]
fn an_element_written_with_state_keeps_it_as_its_own_content() {
    let d = new_doc(&styles());
    let body = |state: &str| json!({"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Flow:"}]},
        {"type": "element", "attrs": {"blockId": "e1", "kind": "@nuah/mermaid/diagram", "plugin": "@nuah/mermaid", "v": 1, "data": {}, "fallback": {"text": state}, "state": state}},
    ]});
    write_json(&d, &body("flowchart LR\n  A --> B")).unwrap();
    let text = d.get_map("elements").get("e1").and_then(|v| v.into_container().ok()).and_then(|c| c.into_text().ok()).expect("a text of its own");
    assert_eq!(text.to_string(), "flowchart LR\n  A --> B");
    let out = to_json(&d);
    assert!(out["content"][1]["attrs"].get("state").is_none(), "{out}");
    assert_eq!(out["content"][1]["attrs"]["kind"], "@nuah/mermaid/diagram");
    // written again with other state: what the element holds stays (someone may have edited it)
    write_json(&d, &body("flowchart LR\n  X --> Y")).unwrap();
    assert_eq!(text.to_string(), "flowchart LR\n  A --> B");
    // a map for an element whose state is a map
    write_json(&d, &json!({"type": "doc", "content": [{"type": "element", "attrs": {"blockId": "s1", "kind": "@t/x/y", "plugin": "@t/x", "state": {"ink": "blue"}}}]})).unwrap();
    let m = d.get_map("elements").get("s1").and_then(|v| v.into_container().ok()).and_then(|c| c.into_map().ok()).expect("a map of its own");
    assert_eq!(serde_json::to_value(m.get_deep_value()).unwrap(), json!({"ink": "blue"}));
    // state without a block id has nowhere to go
    assert!(write_json(&d, &json!({"type": "doc", "content": [{"type": "element", "attrs": {"kind": "@t/x/y", "state": "x"}}]})).is_err());
}
