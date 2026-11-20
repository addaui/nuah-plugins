// SPDX-License-Identifier: Apache-2.0
//! Changing a Live document to match a whole JSON body with the fewest operations, so a write from the API, an import or a restore
//! becomes an ordinary change in the history that merges with what others type at the same time.

use crate::json::loro_value;
use crate::{ATTRIBUTES, CHILDREN, NODE_NAME, ROOT};
use loro::{Container, LoroDoc, LoroList, LoroMap, LoroText, LoroValue, TextDelta, ValueOrContainer};
use nuah_kernel::{Error, Result};
use serde_json::Value;
use similar::{capture_diff_slices, Algorithm, DiffOp};
use std::collections::BTreeMap;

fn lerr(e: impl std::fmt::Display) -> Error {
    Error::internal(format!("live document: {e}"))
}

/// Make the document hold `json` (ProseMirror JSON with `type: "doc"`). Children are matched by type and `attrs.blockId`, text by
/// characters, attributes and marks by key; nothing that is already equal is written. Commits.
pub fn write_json(doc: &LoroDoc, json: &Value) -> Result<()> {
    if json["type"] != "doc" {
        return Err(Error::invalid("body", "must be a document: {\"type\":\"doc\",\"content\":[..]}"));
    }
    // an element's own content given with it (an import, an agent): kept where the editor keeps it, never as an attribute
    let mut body = json.clone();
    let mut states = vec![];
    take_states(&mut body, &mut states)?;
    update_node(&doc.get_map(ROOT), &body)?;
    let elements = doc.get_map(ELEMENTS);
    for (id, state) in states {
        if elements.get(&id).is_some() {
            continue; // only a first value: what the element holds may have been edited since
        }
        match &state {
            Value::String(s) => {
                let t = elements.ensure_mergeable_text(&id).map_err(lerr)?;
                t.insert(0, s).map_err(lerr)?;
            }
            Value::Object(o) => {
                let m = elements.ensure_mergeable_map(&id).map_err(lerr)?;
                for (k, v) in o {
                    m.insert(k, loro_value(v)).map_err(lerr)?;
                }
            }
            Value::Array(a) => {
                let l = elements.ensure_mergeable_list(&id).map_err(lerr)?;
                for (i, v) in a.iter().enumerate() {
                    l.insert(i, loro_value(v)).map_err(lerr)?;
                }
            }
            _ => {}
        }
    }
    doc.commit();
    Ok(())
}

/// The root map where elements keep their own content, by block id (ADR 0094).
pub const ELEMENTS: &str = "elements";

/// Takes `attrs.state` out of every element node, with its block id: (block id, state).
fn take_states(n: &mut Value, out: &mut Vec<(String, Value)>) -> Result<()> {
    let is_element = matches!(n["type"].as_str(), Some("element" | "elementInline"));
    if is_element {
        if let Some(attrs) = n.get_mut("attrs").and_then(|a| a.as_object_mut()) {
            if let Some(state) = attrs.remove("state").filter(|s| !s.is_null()) {
                let Some(id) = attrs.get("blockId").and_then(|b| b.as_str()).filter(|b| !b.is_empty()) else {
                    return Err(Error::invalid("body", "an element given its own content (state) needs a blockId"));
                };
                out.push((id.to_string(), state));
            }
        }
    }
    if let Some(children) = n.get_mut("content").and_then(|c| c.as_array_mut()) {
        for c in children {
            take_states(c, out)?;
        }
    }
    Ok(())
}

enum Want<'a> {
    Node(&'a Value),
    Text(Vec<&'a Value>),
}

fn key_of_json(n: &Value) -> String {
    format!("{}|{}", n["type"].as_str().unwrap_or(""), n["attrs"]["blockId"].as_str().unwrap_or(""))
}

fn key_of_map(m: &LoroMap) -> String {
    let name = match m.get(NODE_NAME) {
        Some(ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
        _ => String::new(),
    };
    let id = match m.get(ATTRIBUTES) {
        Some(ValueOrContainer::Container(Container::Map(a))) => match a.get("blockId") {
            Some(ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
            _ => String::new(),
        },
        _ => String::new(),
    };
    format!("{name}|{id}")
}

const TEXT_KEY: &str = "#text";

// The browser binding creates these children with getOrCreateContainer too, so both sides make the same kind of child.
#[allow(deprecated)]
fn update_node(m: &LoroMap, j: &Value) -> Result<()> {
    let name = j["type"].as_str().ok_or_else(|| Error::invalid("body", "has a node without a type"))?;
    let same_name = matches!(m.get(NODE_NAME), Some(ValueOrContainer::Value(LoroValue::String(s))) if s.as_str() == name);
    if !same_name {
        m.insert(NODE_NAME, name).map_err(lerr)?;
    }
    let attrs = m.get_or_create_container(ATTRIBUTES, LoroMap::new()).map_err(lerr)?;
    let empty = serde_json::Map::new();
    let want = j["attrs"].as_object().unwrap_or(&empty);
    let have: Vec<String> = attrs.keys().map(|k| k.to_string()).collect();
    for k in have.iter().filter(|k| !want.contains_key(k.as_str())) {
        attrs.delete(k).map_err(lerr)?;
    }
    for (k, v) in want {
        let lv = loro_value(v);
        let same = matches!(attrs.get(k), Some(ValueOrContainer::Value(ref cur)) if *cur == lv);
        if !same {
            attrs.insert(k, lv).map_err(lerr)?;
        }
    }
    let list = m.get_or_create_container(CHILDREN, LoroList::new()).map_err(lerr)?;
    let mut wants: Vec<Want> = vec![];
    for c in j["content"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        if c["type"] == "text" {
            match wants.last_mut() {
                Some(Want::Text(run)) => run.push(c),
                _ => wants.push(Want::Text(vec![c])),
            }
        } else {
            wants.push(Want::Node(c));
        }
    }
    update_children(&list, &wants)
}

fn update_children(list: &LoroList, wants: &[Want]) -> Result<()> {
    let old: Vec<String> = (0..list.len())
        .map(|i| match list.get(i) {
            Some(ValueOrContainer::Container(Container::Map(m))) => key_of_map(&m),
            Some(ValueOrContainer::Container(Container::Text(_))) => TEXT_KEY.to_string(),
            _ => "?".to_string(),
        })
        .collect();
    let new: Vec<String> = wants.iter().map(|w| match w { Want::Node(n) => key_of_json(n), Want::Text(_) => TEXT_KEY.to_string() }).collect();
    for op in capture_diff_slices(Algorithm::Myers, &old, &new) {
        // Every op before this one has made the list's start equal to the wanted start, so positions are the new indexes.
        match op {
            DiffOp::Equal { new_index, len, .. } => {
                for k in new_index..new_index + len {
                    match (list.get(k), &wants[k]) {
                        (Some(ValueOrContainer::Container(Container::Map(m))), Want::Node(n)) => update_node(&m, n)?,
                        (Some(ValueOrContainer::Container(Container::Text(t))), Want::Text(run)) => update_text(&t, run)?,
                        _ => return Err(Error::internal("live document: children out of step")),
                    }
                }
            }
            DiffOp::Delete { old_len, new_index, .. } => list.delete(new_index, old_len).map_err(lerr)?,
            DiffOp::Insert { new_index, new_len, .. } => insert(list, wants, new_index, new_len)?,
            DiffOp::Replace { old_len, new_index, new_len, .. } => {
                list.delete(new_index, old_len).map_err(lerr)?;
                insert(list, wants, new_index, new_len)?;
            }
        }
    }
    Ok(())
}

fn insert(list: &LoroList, wants: &[Want], at: usize, len: usize) -> Result<()> {
    for k in at..at + len {
        match &wants[k] {
            Want::Node(n) => update_node(&list.insert_container(k, LoroMap::new()).map_err(lerr)?, n)?,
            Want::Text(run) => update_text(&list.insert_container(k, LoroText::new()).map_err(lerr)?, run)?,
        }
    }
    Ok(())
}

type Marks = BTreeMap<String, LoroValue>;

fn current_marks(t: &LoroText) -> Vec<Marks> {
    let mut out = vec![];
    for d in t.to_delta() {
        if let TextDelta::Insert { insert, attributes } = d {
            let m: Marks = attributes.unwrap_or_default().into_iter().filter(|(_, v)| !matches!(v, LoroValue::Null)).collect();
            out.extend(std::iter::repeat_n(m, insert.chars().count()));
        }
    }
    out
}

fn update_text(t: &LoroText, run: &[&Value]) -> Result<()> {
    let mut want_chars: Vec<char> = vec![];
    let mut want_marks: Vec<Marks> = vec![];
    for n in run {
        let s = n["text"].as_str().unwrap_or("");
        let m: Marks = n["marks"].as_array().map(|a| a.as_slice()).unwrap_or(&[]).iter().filter_map(|mk| {
            let name = mk["type"].as_str()?;
            let attrs = if mk["attrs"].is_object() { mk["attrs"].clone() } else { Value::Object(Default::default()) };
            Some((name.to_string(), loro_value(&attrs)))
        }).collect();
        for c in s.chars() {
            want_chars.push(c);
            want_marks.push(m.clone());
        }
    }
    let old_chars: Vec<char> = t.to_string().chars().collect();
    if old_chars != want_chars {
        for op in capture_diff_slices(Algorithm::Myers, &old_chars, &want_chars) {
            match op {
                DiffOp::Equal { .. } => {}
                DiffOp::Delete { old_len, new_index, .. } => t.delete(new_index, old_len).map_err(lerr)?,
                DiffOp::Insert { new_index, new_len, .. } => t.insert(new_index, &want_chars[new_index..new_index + new_len].iter().collect::<String>()).map_err(lerr)?,
                DiffOp::Replace { old_len, new_index, new_len, .. } => {
                    t.delete(new_index, old_len).map_err(lerr)?;
                    t.insert(new_index, &want_chars[new_index..new_index + new_len].iter().collect::<String>()).map_err(lerr)?;
                }
            }
        }
    }
    let have = current_marks(t);
    let mut keys: Vec<String> = have.iter().chain(want_marks.iter()).flat_map(|m| m.keys().cloned()).collect();
    keys.sort();
    keys.dedup();
    for k in keys {
        let mut i = 0;
        while i < want_marks.len() {
            let w = want_marks[i].get(&k);
            if have.get(i).and_then(|h| h.get(&k)) == w {
                i += 1;
                continue;
            }
            // the longest stretch from here that wants the same value and does not have it yet
            let mut j = i + 1;
            while j < want_marks.len() && want_marks[j].get(&k) == w && have.get(j).and_then(|h| h.get(&k)) != w {
                j += 1;
            }
            match w {
                Some(v) => t.mark(i..j, &k, v.clone()).map_err(lerr)?,
                None => t.unmark(i..j, &k).map_err(lerr)?,
            }
            i = j;
        }
    }
    Ok(())
}
