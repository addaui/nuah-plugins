// SPDX-License-Identifier: Apache-2.0
//! Per-person preferences. A plugin that owns a preference declares it by providing `prefs.item`; this plugin
//! stores and checks the choices. It knows no product: the items it declares itself are the common ones
//! (language, calendar, avatar colour, confirm before deleting).

use nuah_kernel::*;
use serde_json::{json, Value};

fn manifest(v: Value) -> Manifest {
    serde_json::from_value(v).expect("a valid manifest")
}

// ADR 0021: the plugin knows no preference itself. Every plugin that owns one provides `prefs.item`
// (optionally, so it still runs when this plugin is off); this plugin stores and checks the choices.

pub const PREFS: &str = "prefs.prefs";

pub fn lbl(en: &str, ar: &str) -> Value {
    json!({"en": en, "ar": ar})
}

pub fn choices(list: &[(&str, &str, &str)]) -> Value {
    Value::Array(list.iter().map(|(v, en, ar)| json!({"value": v, "label": lbl(en, ar)})).collect())
}

/// What a plugin answers when `prefs.item` is called.
pub fn pref_answer(items: Vec<Value>) -> Value {
    json!({ "items": items })
}

pub struct Prefs;
impl Plugin for Prefs {
    fn manifest(&self) -> Manifest {
        manifest(json!({
            "id": "@nuah/prefs", "version": "0.3.0", "name": "Preferences", "namespaces": ["prefs"],
            "description": "Per-person choices; each plugin declares its own (prefs.item) and this one stores and checks them",
            "requires": {"capabilities": ["emit"], "extension_points": ["prefs.item"]},
            "defines": {"extension_points": {"prefs.item": {"policy": "many",
                "description": "A plugin answers with the preferences it owns: {items: [{key, label, group, type, default, choices?, min?, max?}]}",
                "input": {"type":"object"}}}},
            "provides": [{"extension_point": "prefs.item"}],
            "data": {"collections": [PREFS], "version": 1},
            "events": {"prefs.changed": {}},
            "operations": {
                "prefs.schema": {"kind": "query", "description": "Every preference the enabled plugins declare, to build a settings window",
                    "output": {"type":"object","required":["items"]}},
                "prefs.get": {"kind": "query", "description": "Your preferences: every declared key with your value or its default", "output": {"type":"object","required":["language"]}},
                "prefs.set": {"kind": "command", "description": "Change some of your preferences; each key must be declared and its value valid",
                    "input": {"type":"object","maxProperties":40},
                    "output": {"type":"object","required":["language"]}}
            }
        }))
    }
    fn bind(&self, b: &mut Bindings) {
        b.provide("prefs.item", |_tx, _i| {
            Ok(pref_answer(vec![
                json!({"key": "language", "group": "appearance", "type": "choice", "default": "en", "label": lbl("Language", "اللغة"), "choices": choices(&[("en", "English", "English"), ("ar", "Arabic", "العربية")])}),
                json!({"key": "calendar", "group": "appearance", "type": "choice", "default": "gregorian", "label": lbl("Calendar", "التقويم"), "choices": choices(&[("gregorian", "Gregorian", "ميلادي"), ("hijri", "Hijri", "هجري"), ("both", "Both", "كلاهما")])}),
                json!({"key": "avatar_color", "group": "account", "type": "color", "default": "", "label": lbl("Avatar colour", "لون الصورة الرمزية")}),
                json!({"key": "confirm_before_delete", "group": "behaviour", "type": "boolean", "default": true, "label": lbl("Confirm before deleting", "تأكيد قبل الحذف")}),
            ]))
        });
        /// All declared items, flattened; a provider that failed is skipped.
        fn declared(tx: &mut Tx) -> Result<Vec<Value>> {
            let answers = tx.extension_call("prefs.item", json!({}))?;
            let mut items = vec![];
            for a in answers.as_array().cloned().unwrap_or_default() {
                if a["ok"] == true {
                    items.extend(a["output"]["items"].as_array().cloned().unwrap_or_default());
                }
            }
            Ok(items)
        }
        fn check(item: &Value, v: &Value) -> Result<()> {
            let key = item["key"].as_str().unwrap_or("");
            let bad = |why: &str| Err(Error::invalid(key, why));
            match item["type"].as_str().unwrap_or("string") {
                "boolean" if !v.is_boolean() => bad("must be true or false"),
                "integer" => match v.as_i64() {
                    Some(n) if n >= item["min"].as_i64().unwrap_or(i64::MIN) && n <= item["max"].as_i64().unwrap_or(i64::MAX) => Ok(()),
                    _ => bad("must be a whole number in range"),
                },
                "choice" if !item["choices"].as_array().is_some_and(|c| c.iter().any(|x| &x["value"] == v)) => bad("is not one of the choices"),
                "color" => match v.as_str() {
                    Some("") => Ok(()),
                    Some(s) if s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit()) => Ok(()),
                    _ => bad("must be empty or a colour like #1a2b3c"),
                },
                "string" if v.as_str().map_or(true, |s| s.is_empty() || s.len() > 60) => bad("must be 1 to 60 characters"),
                _ => Ok(()),
            }
        }
        b.op("prefs.schema", |tx, _| Ok(json!({"items": declared(tx)?})));
        b.op("prefs.get", |tx, _| {
            let items = declared(tx)?;
            let mine = tx.get(PREFS, &tx.who().subject)?.map(|d| d.body).unwrap_or(json!({}));
            let mut out = serde_json::Map::new();
            for it in &items {
                let k = it["key"].as_str().unwrap_or("");
                // a stored value that no longer passes (its plugin changed) falls back to the default
                let v = mine.get(k).filter(|v| check(it, v).is_ok()).unwrap_or(&it["default"]);
                out.insert(k.to_string(), v.clone());
            }
            Ok(Value::Object(out))
        });
        b.op("prefs.set", |tx, i| {
            let items = declared(tx)?;
            let me = tx.who().subject.clone();
            let cur = tx.get(PREFS, &me)?;
            let mut body = cur.as_ref().map(|d| d.body.clone()).unwrap_or(json!({}));
            for (k, v) in i.as_object().cloned().unwrap_or_default() {
                let Some(it) = items.iter().find(|x| x["key"] == k.as_str()) else { return Err(Error::invalid(&k, "is not a preference")) };
                check(it, &v)?;
                body[&k] = v;
            }
            tx.put(PREFS, &me, body, cur.map(|d| Expect::Rev(d.rev)).unwrap_or(Expect::Absent))?;
            let mut out = serde_json::Map::new();
            let mine = tx.get(PREFS, &me)?.map(|d| d.body).unwrap_or(json!({}));
            for it in &items {
                let k = it["key"].as_str().unwrap_or("");
                out.insert(k.to_string(), mine.get(k).cloned().unwrap_or_else(|| it["default"].clone()));
            }
            let out = Value::Object(out);
            tx.emit("prefs.changed", Audience::subject(&me), out.clone())?;
            Ok(out)
        });
    }
}

