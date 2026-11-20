// SPDX-License-Identifier: Apache-2.0
//! `@nuah/editor` ([ADR 0094], [ADR 0095]): the editor, as a plugin that knows no feature. It defines the browser Extension point
//! `editor.element` (every element plugin fills it: basic text included) and `editor.runner`, provides the Face's `face.editor` with its
//! host module, lists what the enabled element plugins declared (`editor.elements`), keeps the Owner's default Opener per kind, and gives
//! the plugins that store pages `check_elements`, the check of an element's settings against its kind.
//!
//! [ADR 0094]: https://docs.addaui.com/nuah/adr/0094-the-editor-is-a-host-that-knows-no-feature-plugins-bring-elements-with-their-own-data-views-options-and-capabilities-an-element-names-its-plugin-and-keeps-a-fallback-another-plugin-may-open-it/
//! [ADR 0095]: https://docs.addaui.com/nuah/adr/0095-plugins-ship-browser-modules-for-another-plugins-host-and-require-an-extension-point-at-a-version-never-a-plugin-by-id/

use nuah_kernel::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const OPENERS: &str = "editor.openers";
const HOST: &[u8] = include_bytes!("../browser/host.js");

/// What an element plugin declares to `editor.element` (its `provides` data).
fn kinds_schema() -> Value {
    json!({"type": "object", "properties": {"kinds": {"type": "array", "maxItems": 200, "items": {"type": "object",
        "required": ["kind", "version", "shape", "placement", "label"],
        "properties": {
            "kind": {"type": "string", "maxLength": 200}, "version": {"type": "integer", "minimum": 1},
            "shape": {"enum": ["card", "content"]}, "placement": {"enum": ["block", "inline", "floating"]},
            "label": {"type": "object", "required": ["en"]}, "icon": {"type": "string"}, "group": {"type": "string"}, "keywords": {"type": "string"},
            "schema": {"type": "object"}, "state": {"enum": ["text", "map", "list", "movableList", "tree"]},
            "accepts": {"type": "array", "items": {"type": "string"}}, "opens": {"type": "array", "items": {"type": "string"}},
            "options": {"type": "array"}}}}}})
}

/// `@scope/plugin/name`: the plugin part, or None when it is not a kind.
pub fn plugin_of(kind: &str) -> Option<&str> {
    let mut parts = kind.splitn(3, '/');
    let (scope, plugin, name) = (parts.next()?, parts.next()?, parts.next()?);
    let word = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.');
    if !scope.starts_with('@') || !word(&scope[1..]) || !word(plugin) || !word(name) || name.contains('.') {
        return None;
    }
    Some(&kind[..scope.len() + 1 + plugin.len()])
}

/// Checks the elements of a stored body: every element's kind names its plugin; the settings of a kind an enabled plugin declares
/// fit its schema (keys under another plugin's name, `x:@…`, are that plugin's and are kept). A kind no enabled plugin declares is
/// left as it is: its plugin may be switched off, and its content must survive.
pub fn check_elements(body: &Value, kinds: &BTreeMap<String, Value>) -> Result<()> {
    fn walk(n: &Value, kinds: &BTreeMap<String, Value>) -> Result<()> {
        let t = n["type"].as_str().unwrap_or("");
        if t == "element" || t == "elementInline" {
            let a = &n["attrs"];
            let kind = a["kind"].as_str().unwrap_or("");
            let Some(owner) = plugin_of(kind) else { return Err(Error::invalid("body", &format!("\"{kind}\" is not an element kind (@scope/plugin/name)"))) };
            if let Some(p) = a["plugin"].as_str().filter(|p| !p.is_empty()) {
                if p != owner {
                    return Err(Error::invalid("body", &format!("an element of {kind} says it belongs to {p}")));
                }
            }
            if let Some(schema) = kinds.get(kind).and_then(|d| d.get("schema")) {
                let mut data = a["data"].as_object().cloned().unwrap_or_default();
                data.retain(|k, _| !k.starts_with("x:"));
                schema::validate(schema, &Value::Object(data)).map_err(|e| Error::invalid("body", &format!("the settings of a {kind}: {}", e.message)))?;
            }
        }
        for c in n["content"].as_array().into_iter().flatten() {
            walk(c, kinds)?;
        }
        Ok(())
    }
    walk(body, kinds)
}

/// The enabled kinds by name (for `check_elements`), read through the Core by any plugin that requires `editor.element`.
pub fn kinds_of(elements: &Value) -> BTreeMap<String, Value> {
    elements["kinds"].as_array().into_iter().flatten().filter_map(|k| k["kind"].as_str().map(|n| (n.to_string(), k.clone()))).collect()
}

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

/// Every kind with its plugin, module, Openers and the Owner's default; every Runner.
fn elements(tx: &mut Tx) -> Result<Value> {
    let providers = tx.provided("editor.element")?;
    let mut kinds: Vec<Value> = vec![];
    for p in &providers {
        for k in p["data"]["kinds"].as_array().into_iter().flatten() {
            let mut k = k.clone();
            k["plugin"] = p["plugin"].clone();
            k["module"] = p["module"].clone();
            kinds.push(k);
        }
    }
    // a kind is opened by the plugin that declares it, then by every plugin with a kind that `opens` it
    let opens = |k: &Value, kind: &str| k["opens"].as_array().is_some_and(|o| o.iter().any(|x| x.as_str().is_some_and(|x| x == kind || x.starts_with(&format!("{kind}@")))));
    let snapshot = kinds.clone();
    for k in kinds.iter_mut() {
        let kind = k["kind"].as_str().unwrap_or("").to_string();
        let mut openers = vec![k["plugin"].clone()];
        for o in &snapshot {
            if opens(o, &kind) && !openers.contains(&o["plugin"]) {
                openers.push(o["plugin"].clone());
            }
        }
        let default = tx.get(OPENERS, &hex(&kind))?.map(|d| d.body["plugin"].clone()).filter(|p| openers.contains(p)).unwrap_or(Value::Null);
        k["openers"] = Value::Array(openers);
        k["default"] = default;
    }
    // a plugin with a module and no kinds (margin actions, block menus) still loads with the page
    let modules: Vec<Value> = providers.iter().filter(|p| p["data"]["kinds"].as_array().is_none_or(|k| k.is_empty()) && p["module"].is_string()).map(|p| json!({"plugin": p["plugin"], "module": p["module"]})).collect();
    let runners: Vec<Value> = tx.provided("editor.runner")?.into_iter().map(|p| json!({"plugin": p["plugin"], "module": p["module"], "languages": p["data"]["languages"]})).collect();
    Ok(json!({"kinds": kinds, "runners": runners, "modules": modules}))
}

pub struct Editor;
impl Plugin for Editor {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({
            "id": "@nuah/editor", "version": "0.1.0", "name": "Editor", "namespaces": ["editor"],
            "description": "The editor: a host that knows no feature; element plugins bring every element as a Browser module",
            "defines": {"extension_points": {
                "editor.element": {"policy": "many", "browser": true, "version": "1.0.0", "input": {"type": "object"}, "data": kinds_schema(),
                    "description": "An element plugin: its kinds as data ({kinds: [{kind, version, shape, placement, label, schema?, state?, accepts?, opens?}]}) and a Browser module whose default export is register(api)"},
                "editor.runner": {"policy": "many", "browser": true, "version": "1.0.0", "input": {"type": "object"},
                    "data": {"type": "object", "required": ["languages"], "properties": {"languages": {"type": "array", "items": {"type": "string"}}}},
                    "description": "Runs code for elements that ask (ADR 0096): the languages as data, and a Browser module that registers its run function"}}},
            "provides": [{"extension_point": "face.editor", "optional": true}, {"extension_point": "prefs.item", "optional": true}],
            "browser": {"face.editor": "host.js"},
            "data": {"schema": serde_json::from_str::<Value>(include_str!("../schema/editor.json")).expect("the schema file is JSON")},
            "permissions": {"editor.manage": {"description": "Choose which plugin opens each kind of element", "default": ["admin", "owner"]}},
            "operations": {
                "editor.elements": {"kind": "query", "description": "Every element kind the enabled plugins bring, with its plugin, module address, Openers and the Owner's default; every Runner",
                    "output": {"type": "object", "required": ["kinds", "runners", "modules"]}},
                "editor.opener.set": {"kind": "command", "permission": "editor.manage", "description": "Set (or clear, with null) the plugin that opens a kind by default",
                    "input": {"type": "object", "required": ["kind", "plugin"], "properties": {"kind": {"type": "string", "maxLength": 200}, "plugin": {"type": ["string", "null"], "maxLength": 120}}},
                    "output": {"type": "object"},
                    "reasons": {"editor.not_an_opener": "That plugin cannot open this kind of element"}}
            }
        }))
        .expect("the editor's manifest")
    }

    fn bind(&self, b: &mut Bindings) {
        b.op("editor.elements", |tx, _| elements(tx));
        b.op("editor.opener.set", |tx, i| {
            let kind = i["kind"].as_str().unwrap_or("").to_string();
            let id = hex(&kind);
            match i["plugin"].as_str() {
                None => {
                    tx.delete(OPENERS, &id)?;
                }
                Some(p) => {
                    let all = elements(tx)?;
                    let can = all["kinds"].as_array().into_iter().flatten().any(|k| k["kind"] == kind.as_str() && k["openers"].as_array().is_some_and(|o| o.iter().any(|x| x == p)));
                    if !can {
                        return Err(Error::invalid("plugin", "That plugin cannot open this kind of element").with_reason("editor.not_an_opener"));
                    }
                    let cur = tx.get(OPENERS, &id)?;
                    tx.put(OPENERS, &id, json!({"kind": kind, "plugin": p}), cur.map(|d| Expect::Rev(d.rev)).unwrap_or(Expect::Absent))?;
                }
            }
            Ok(json!({}))
        });
        b.provide("prefs.item", |tx, _| {
            let all = elements(tx)?;
            let mut items = vec![json!({"key": "editor.element_type_in_tab", "group": "appearance", "type": "boolean", "default": false,
                "label": {"en": "Show the element's type under the Element tab's name", "ar": "إظهار نوع العنصر تحت اسم تبويب العنصر"}})];
            for k in all["kinds"].as_array().into_iter().flatten() {
                let openers = k["openers"].as_array().cloned().unwrap_or_default();
                if openers.len() < 2 {
                    continue;
                }
                let choices: Vec<Value> = std::iter::once(json!({"value": "", "label": {"en": "The Owner's choice", "ar": "اختيار المالك"}}))
                    .chain(openers.iter().map(|p| json!({"value": p, "label": {"en": p, "ar": p}})))
                    .collect();
                items.push(json!({"key": format!("editor.opener.{}", k["kind"].as_str().unwrap_or("")), "group": "editor", "type": "choice", "default": "",
                    "label": {"en": format!("Open {} with", k["label"]["en"].as_str().unwrap_or("")), "ar": format!("فتح {} باستخدام", k["label"]["ar"].as_str().or(k["label"]["en"].as_str()).unwrap_or(""))},
                    "choices": choices}));
            }
            Ok(json!({"items": items}))
        });
    }

    fn browser_files(&self) -> &'static [(&'static str, &'static [u8])] {
        &[("host.js", HOST)]
    }
}
