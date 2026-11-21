// SPDX-License-Identifier: Apache-2.0
//! One top-level block of a Live document at a time (ADR 0103), as changes that merge with what others type.

use nuah_live::*;
use serde_json::{json, Value};

fn doc(content: Value) -> loro::LoroDoc {
    let d = new_doc(&TextStyles::default());
    write_json(&d, &json!({"type": "doc", "content": content})).unwrap();
    d
}
fn p(id: Option<&str>, text: &str) -> Value {
    match id {
        Some(id) => json!({"type": "paragraph", "attrs": {"blockId": id}, "content": [{"type": "text", "text": text}]}),
        None => json!({"type": "paragraph", "content": [{"type": "text", "text": text}]}),
    }
}
fn texts(d: &loro::LoroDoc) -> Vec<String> {
    to_json(d)["content"].as_array().unwrap().iter().map(|n| n["content"][0]["text"].as_str().unwrap_or("").to_string()).collect()
}

#[test]
fn the_outline_names_each_block_by_its_block_id_or_its_container() {
    let d = doc(json!([p(Some("a"), "one"), p(None, "two")]));
    let o = blocks::outline(&d);
    assert_eq!(o.len(), 2);
    assert_eq!(o[0].id, "a");
    assert!(o[1].id.starts_with("cid:"), "{}", o[1].id);
    assert_eq!(o[1].node["content"][0]["text"], "two");
    // a block found by its container id is the same block
    assert_eq!(blocks::position(&d, &o[1].id).unwrap(), 1);
    assert_eq!(blocks::position(&d, "nope").unwrap_err().reason.as_deref(), Some("live.no_block"));
}

#[test]
fn a_block_is_inserted_replaced_moved_and_removed() {
    let d = doc(json!([p(Some("a"), "one"), p(Some("b"), "two")]));
    blocks::insert(&d, 1, &p(Some("c"), "mid")).unwrap();
    assert_eq!(texts(&d), ["one", "mid", "two"]);
    blocks::replace(&d, "c", &json!({"type": "heading", "attrs": {"blockId": "c", "level": 2}, "content": [{"type": "text", "text": "Mid"}]})).unwrap();
    assert_eq!(to_json(&d)["content"][1]["type"], "heading");
    blocks::move_to(&d, "a", 3).unwrap();
    assert_eq!(texts(&d), ["Mid", "two", "one"]);
    blocks::move_to(&d, "a", 0).unwrap();
    assert_eq!(texts(&d), ["one", "Mid", "two"]);
    blocks::remove(&d, "c").unwrap();
    assert_eq!(texts(&d), ["one", "two"]);
}

#[test]
fn a_replaced_content_block_keeps_its_container_so_its_name_still_finds_it() {
    let d = doc(json!([p(None, "code")]));
    let id = blocks::outline(&d)[0].id.clone();
    blocks::replace(&d, &id, &json!({"type": "element", "attrs": {"blockId": "m1", "kind": "@t/m/d"}})).unwrap();
    assert_eq!(blocks::position(&d, &id).unwrap(), 0);
    assert_eq!(blocks::position(&d, "m1").unwrap(), 0);
}

#[test]
fn an_elements_content_is_written_and_read_by_its_state_type() {
    let d = doc(json!([{"type": "element", "attrs": {"blockId": "m1", "kind": "@t/m/d"}}]));
    blocks::set_content(&d, "m1", "text", &json!("graph TD")).unwrap();
    assert_eq!(blocks::content(&d, "m1"), Some(json!("graph TD")));
    blocks::set_content(&d, "m1", "text", &json!("graph LR")).unwrap();
    assert_eq!(blocks::content(&d, "m1"), Some(json!("graph LR")));
    blocks::set_content(&d, "s1", "map", &json!({"elements": [1], "x": "y"})).unwrap();
    blocks::set_content(&d, "s1", "map", &json!({"x": "z"})).unwrap();
    assert_eq!(blocks::content(&d, "s1"), Some(json!({"x": "z"})));
    blocks::set_content(&d, "l1", "list", &json!([1, 2])).unwrap();
    assert_eq!(blocks::content(&d, "l1"), Some(json!([1, 2])));
    // the content of a removed element goes with it
    blocks::remove(&d, "m1").unwrap();
    assert_eq!(blocks::content(&d, "m1"), None);
}

#[test]
fn an_edit_merges_with_a_concurrent_edit_elsewhere_in_the_document() {
    let a = doc(json!([p(Some("a"), "one"), p(Some("b"), "two")]));
    let b = loro::LoroDoc::new();
    b.import(&a.export(loro::ExportMode::Snapshot).unwrap()).unwrap();
    blocks::replace(&a, "a", &p(Some("a"), "ONE")).unwrap();
    a.commit();
    write_json(&b, &json!({"type": "doc", "content": [p(Some("a"), "one"), p(Some("b"), "two!")]})).unwrap();
    a.import(&b.export(loro::ExportMode::all_updates()).unwrap()).unwrap();
    assert_eq!(texts(&a), ["ONE", "two!"]);
}
