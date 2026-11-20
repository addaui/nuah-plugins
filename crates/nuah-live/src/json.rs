// SPDX-License-Identifier: Apache-2.0
//! Reading a Live document as ProseMirror JSON, and turning JSON values into Loro values.

use crate::{ATTRIBUTES, CHILDREN, NODE_NAME, ROOT};
use loro::{Container, LoroDoc, LoroMap, LoroText, LoroValue, TextDelta, ValueOrContainer};
use serde_json::{json, Map, Value};

/// The document as ProseMirror JSON: what the owning plugin keeps as its plain copy. Marks come in name order; an empty text run gives nothing.
pub fn to_json(doc: &LoroDoc) -> Value {
    let mut out = node(&doc.get_map(ROOT));
    // the floating layer (stickers) lives beside the body, one entry per element (ADR 0094); readers of the JSON copy get it as the
    // document's `floating` attribute, in its stacking order
    let floating = value(&doc.get_map(FLOATING).get_deep_value());
    if let Some(m) = floating.as_object().filter(|m| !m.is_empty()) {
        let mut list: Vec<Value> = m.values().cloned().collect();
        list.sort_by(|a, b| (a["z"].as_str().unwrap_or(""), a["id"].as_str().unwrap_or("")).cmp(&(b["z"].as_str().unwrap_or(""), b["id"].as_str().unwrap_or(""))));
        out["attrs"]["floating"] = Value::Array(list);
    }
    out
}

/// The root map of the floating layer.
pub const FLOATING: &str = "floating";

pub(crate) fn node(m: &LoroMap) -> Value {
    let name = match m.get(NODE_NAME) {
        Some(ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
        _ => "doc".to_string(),
    };
    let mut out = Map::new();
    out.insert("type".into(), json!(name));
    if let Some(ValueOrContainer::Container(Container::Map(a))) = m.get(ATTRIBUTES) {
        let attrs = value(&a.get_deep_value());
        if attrs.as_object().is_some_and(|o| !o.is_empty()) {
            out.insert("attrs".into(), attrs);
        }
    }
    if let Some(ValueOrContainer::Container(Container::List(list))) = m.get(CHILDREN) {
        let mut content = vec![];
        for i in 0..list.len() {
            match list.get(i) {
                Some(ValueOrContainer::Container(Container::Map(c))) => content.push(node(&c)),
                Some(ValueOrContainer::Container(Container::Text(t))) => content.extend(text_nodes(&t)),
                _ => {}
            }
        }
        if !content.is_empty() {
            out.insert("content".into(), Value::Array(content));
        }
    }
    Value::Object(out)
}

pub(crate) fn text_nodes(t: &LoroText) -> Vec<Value> {
    t.to_delta()
        .into_iter()
        .filter_map(|d| match d {
            TextDelta::Insert { insert, attributes } if !insert.is_empty() => {
                let mut n = json!({"type": "text", "text": insert});
                let mut marks: Vec<(String, Value)> = attributes.unwrap_or_default().into_iter().filter(|(_, v)| !matches!(v, LoroValue::Null)).map(|(k, v)| (k, value(&v))).collect();
                marks.sort_by(|a, b| a.0.cmp(&b.0));
                if !marks.is_empty() {
                    n["marks"] = Value::Array(marks.into_iter().map(|(k, a)| if a.as_object().is_some_and(|o| !o.is_empty()) { json!({"type": k, "attrs": a}) } else { json!({"type": k}) }).collect());
                }
                Some(n)
            }
            _ => None,
        })
        .collect()
}

/// A Loro value as JSON (containers do not occur in attributes).
pub(crate) fn value(v: &LoroValue) -> Value {
    match v {
        LoroValue::Null | LoroValue::Container(_) | LoroValue::Binary(_) => Value::Null,
        LoroValue::Bool(b) => json!(b),
        LoroValue::Double(f) => json!(f),
        LoroValue::I64(i) => json!(i),
        LoroValue::String(s) => json!(s.to_string()),
        LoroValue::List(l) => Value::Array(l.iter().map(value).collect()),
        LoroValue::Map(m) => {
            let mut keys: Vec<_> = m.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|k| (k.to_string(), value(&m[k]))).collect())
        }
    }
}

/// A JSON value as a Loro value.
pub(crate) fn loro_value(v: &Value) -> LoroValue {
    match v {
        Value::Null => LoroValue::Null,
        Value::Bool(b) => LoroValue::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => LoroValue::I64(i),
            None => LoroValue::Double(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => LoroValue::from(s.as_str()),
        Value::Array(a) => LoroValue::from(a.iter().map(loro_value).collect::<Vec<_>>()),
        Value::Object(o) => {
            let m: std::collections::HashMap<String, LoroValue> = o.iter().map(|(k, x)| (k.clone(), loro_value(x))).collect();
            LoroValue::from(m)
        }
    }
}
