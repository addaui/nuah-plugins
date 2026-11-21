// SPDX-License-Identifier: Apache-2.0
//! One top-level block of a Live document at a time ([ADR 0103]): the outline, and inserting, replacing, moving and removing a block,
//! and writing an element's own content (in the root map `elements`, by block id, as the editor keeps it). Each is an ordinary change
//! in the history, so it merges with what others type at the same time. Nothing here commits: the caller does (`LiveStore::edit`).
//!
//! A block is named by its `blockId`, or by its Loro container id when it has none (a block written before the editor gave it one);
//! replacing a block keeps its container, so either name still finds it.
//!
//! [ADR 0103]: https://madar.addaui.com/#/p/c732d1c1f2a8405da02ddc3cf964557c?tab=knowledge&page=b987ca7d600b41699f21fc5d589f7c34

use crate::diff::update_node;
use crate::json::{loro_value, node, value};
use crate::{ATTRIBUTES, CHILDREN, ROOT};
use loro::{Container, ContainerTrait, LoroDoc, LoroList, LoroMap, LoroValue, ValueOrContainer};
use nuah_kernel::{Category, Error, Result};
use serde_json::Value;

/// The root map where elements keep their own content, by block id (ADR 0094).
pub const ELEMENTS: &str = "elements";

fn lerr(e: impl std::fmt::Display) -> Error {
    Error::internal(format!("live document: {e}"))
}

/// A top-level block: its name and its ProseMirror JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub id: String,
    pub node: Value,
}

#[allow(deprecated)]
fn children(doc: &LoroDoc) -> Result<LoroList> {
    doc.get_map(ROOT).get_or_create_container(CHILDREN, LoroList::new()).map_err(lerr)
}

fn block_id(m: &LoroMap) -> Option<String> {
    match m.get(ATTRIBUTES) {
        Some(ValueOrContainer::Container(Container::Map(a))) => match a.get("blockId") {
            Some(ValueOrContainer::Value(LoroValue::String(s))) if !s.is_empty() => Some(s.to_string()),
            _ => None,
        },
        _ => None,
    }
}

/// The top-level blocks, in order: (index in the list, the block's map).
fn maps(doc: &LoroDoc) -> Result<Vec<(usize, LoroMap)>> {
    let list = children(doc)?;
    Ok((0..list.len()).filter_map(|i| match list.get(i) {
        Some(ValueOrContainer::Container(Container::Map(m))) => Some((i, m)),
        _ => None,
    }).collect())
}

/// Every top-level block, in order.
pub fn outline(doc: &LoroDoc) -> Vec<Block> {
    maps(doc).unwrap_or_default().into_iter().map(|(_, m)| Block { id: block_id(&m).unwrap_or_else(|| m.id().to_string()), node: node(&m) }).collect()
}

/// Where the block named `id` is among the top-level blocks. Not found: `live.no_block`.
pub fn position(doc: &LoroDoc, id: &str) -> Result<usize> {
    maps(doc)?.into_iter().position(|(_, m)| block_id(&m).as_deref() == Some(id) || m.id().to_string() == id)
        .ok_or_else(|| Error::reason(Category::NotFound, "live.no_block", "There is no such block on the page"))
}

fn find(doc: &LoroDoc, id: &str) -> Result<(usize, LoroMap)> {
    let at = position(doc, id)?;
    Ok(maps(doc)?.swap_remove(at))
}

/// Puts `node` as the top-level block at `at` (the end when past it), and gives its name.
pub fn insert(doc: &LoroDoc, at: usize, node: &Value) -> Result<String> {
    let list = children(doc)?;
    let all = maps(doc)?;
    let index = all.get(at).map(|(i, _)| *i).unwrap_or(list.len());
    let m = list.insert_container(index, LoroMap::new()).map_err(lerr)?;
    update_node(&m, node)?;
    Ok(block_id(&m).unwrap_or_else(|| m.id().to_string()))
}

/// Makes the block named `id` hold `node`, changing only what differs (its container stays).
pub fn replace(doc: &LoroDoc, id: &str, node: &Value) -> Result<()> {
    let (_, m) = find(doc, id)?;
    update_node(&m, node)
}

/// Takes the block named `id` away, with an element's own content.
pub fn remove(doc: &LoroDoc, id: &str) -> Result<()> {
    let (index, m) = find(doc, id)?;
    let bid = block_id(&m);
    children(doc)?.delete(index, 1).map_err(lerr)?;
    if let Some(b) = bid {
        let elements = doc.get_map(ELEMENTS);
        if elements.get(&b).is_some() {
            elements.delete(&b).map_err(lerr)?;
        }
    }
    Ok(())
}

/// Moves the block named `id` so it stands before the block now at `at` (the end when past it), and gives its name (a block without
/// a block id gets a new container, so a new name).
pub fn move_to(doc: &LoroDoc, id: &str, at: usize) -> Result<String> {
    let from = position(doc, id)?;
    let (index, m) = find(doc, id)?;
    let json = node(&m);
    children(doc)?.delete(index, 1).map_err(lerr)?;
    insert(doc, if at > from { at - 1 } else { at }, &json)
}

/// An element's own content as JSON: a text is a string, a map an object, a list an array. None when it has none.
pub fn content(doc: &LoroDoc, block_id: &str) -> Option<Value> {
    match doc.get_map(ELEMENTS).get(block_id)? {
        ValueOrContainer::Container(Container::Text(t)) => Some(Value::String(t.to_string())),
        ValueOrContainer::Container(Container::Map(m)) => Some(value(&m.get_deep_value())),
        ValueOrContainer::Container(Container::List(l)) => Some(value(&l.get_deep_value())),
        _ => None,
    }
}

/// Makes an element's own content (in a container of `state`: text, map or list) hold `content`, changing only what differs.
pub fn set_content(doc: &LoroDoc, block_id: &str, state: &str, content: &Value) -> Result<()> {
    let elements = doc.get_map(ELEMENTS);
    let same_type = matches!((elements.get(block_id), state),
        (Some(ValueOrContainer::Container(Container::Text(_))), "text") | (Some(ValueOrContainer::Container(Container::Map(_))), "map")
        | (Some(ValueOrContainer::Container(Container::List(_))), "list") | (None, _));
    if !same_type {
        elements.delete(block_id).map_err(lerr)?;
    }
    match state {
        "text" => {
            let want: Vec<char> = content.as_str().ok_or_else(|| Error::invalid("input", "this element's content is a text"))?.chars().collect();
            let t = elements.ensure_mergeable_text(block_id).map_err(lerr)?;
            let have: Vec<char> = t.to_string().chars().collect();
            let pre = have.iter().zip(&want).take_while(|(a, b)| a == b).count();
            let suf = have[pre..].iter().rev().zip(want[pre..].iter().rev()).take_while(|(a, b)| a == b).count();
            if have.len() - pre - suf > 0 {
                t.delete(pre, have.len() - pre - suf).map_err(lerr)?;
            }
            if want.len() - pre - suf > 0 {
                t.insert(pre, &want[pre..want.len() - suf].iter().collect::<String>()).map_err(lerr)?;
            }
        }
        "map" => {
            let o = content.as_object().ok_or_else(|| Error::invalid("input", "this element's content is an object"))?;
            let m = elements.ensure_mergeable_map(block_id).map_err(lerr)?;
            let have: Vec<String> = m.keys().map(|k| k.to_string()).collect();
            for k in have.iter().filter(|k| !o.contains_key(k.as_str())) {
                m.delete(k).map_err(lerr)?;
            }
            for (k, v) in o {
                let lv = loro_value(v);
                if !matches!(m.get(k), Some(ValueOrContainer::Value(ref cur)) if *cur == lv) {
                    m.insert(k, lv).map_err(lerr)?;
                }
            }
        }
        "list" => {
            let a = content.as_array().ok_or_else(|| Error::invalid("input", "this element's content is a list"))?;
            let l = elements.ensure_mergeable_list(block_id).map_err(lerr)?;
            if value(&l.get_deep_value()) != *content {
                if !l.is_empty() {
                    l.delete(0, l.len()).map_err(lerr)?;
                }
                for (i, v) in a.iter().enumerate() {
                    l.insert(i, loro_value(v)).map_err(lerr)?;
                }
            }
        }
        other => return Err(Error::invalid("kind", &format!("an element's content cannot be written in a {other} yet"))),
    }
    Ok(())
}
