// SPDX-License-Identifier: Apache-2.0
use nuah_adapters::*;
use nuah_editor::{check_elements, Editor};
use nuah_kernel::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

/// An element plugin that is only its Manifest and its module.
struct El(Value);
impl Plugin for El {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(self.0.clone()).unwrap()
    }
    fn browser_files(&self) -> &'static [(&'static str, &'static [u8])] {
        &[("index.js", b"export default function register() {}")]
    }
}
fn element_plugin(id: &str, kinds: Value) -> El {
    let ns = id.split('/').nth(1).unwrap().replace('-', "");
    El(json!({"id": id, "version": "1.0.0", "namespaces": [ns], "requires": {"extension_points": ["editor.element@^1"]},
        "provides": [{"extension_point": "editor.element", "data": {"kinds": kinds}}], "browser": {"editor.element": "index.js"}}))
}
fn decl(kind: &str, extra: Value) -> Value {
    let mut d = json!({"kind": kind, "version": 1, "shape": "card", "placement": "block", "label": {"en": kind}});
    for (k, v) in extra.as_object().unwrap() {
        d[k] = v.clone();
    }
    d
}
fn start(extra: Vec<Arc<dyn Plugin>>, on: &[&str]) -> Core {
    let mut list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyRoles), Arc::new(StdClock), Arc::new(StdIds)];
    list.extend(extra);
    let mut enabled: Vec<String> = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-roles", "@nuah/clock-system", "@nuah/ids-random"].map(String::from).to_vec();
    enabled.extend(on.iter().map(|s| s.to_string()));
    Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile: Profile { name: "t".into(), enabled, ..Default::default() } }).unwrap_or_else(|p| panic!("{p:#?}"))
}
fn who(roles: &[&str]) -> Identity {
    Identity::new("p1", "p1", roles)
}

#[test]
fn elements_lists_kinds_from_provides_data() {
    let core = start(vec![
        Arc::new(Editor),
        Arc::new(element_plugin("@t/mermaid", json!([decl("@t/mermaid/diagram", json!({"state": "text", "accepts": [".mmd"]}))]))),
        Arc::new(element_plugin("@t/live", json!([decl("@t/live/chart", json!({"opens": ["@t/mermaid/diagram@1"]}))]))),
    ], &["@nuah/editor", "@t/mermaid", "@t/live"]);
    let out = core.call_as(&who(&["member"]), "editor.elements", json!({}), None).unwrap().output;
    let kinds = out["kinds"].as_array().unwrap();
    let d = kinds.iter().find(|k| k["kind"] == "@t/mermaid/diagram").unwrap();
    assert_eq!(d["plugin"], "@t/mermaid");
    assert!(d["module"].as_str().unwrap().starts_with("/plugins/t/mermaid/index.js?v="));
    assert_eq!(d["openers"], json!(["@t/mermaid", "@t/live"]));
    assert_eq!(d["default"], Value::Null);
    assert_eq!(d["accepts"], json!([".mmd"]));
    assert_eq!(out["runners"], json!([]));
}

#[test]
fn opener_default_set_by_owner_only() {
    let core = start(vec![
        Arc::new(Editor),
        Arc::new(element_plugin("@t/mermaid", json!([decl("@t/mermaid/diagram", json!({}))]))),
        Arc::new(element_plugin("@t/live", json!([decl("@t/live/chart", json!({"opens": ["@t/mermaid/diagram@1"]}))]))),
    ], &["@nuah/editor", "@t/mermaid", "@t/live"]);
    let set = |roles: &[&str], plugin: Value| core.call_as(&who(roles), "editor.opener.set", json!({"kind": "@t/mermaid/diagram", "plugin": plugin}), None);
    assert!(set(&["member"], json!("@t/live")).is_err());
    set(&["owner"], json!("@t/live")).unwrap();
    let out = core.call_as(&who(&["member"]), "editor.elements", json!({}), None).unwrap().output;
    let d = out["kinds"].as_array().unwrap().iter().find(|k| k["kind"] == "@t/mermaid/diagram").unwrap().clone();
    assert_eq!(d["default"], "@t/live");
    // a plugin that cannot open the kind is refused
    assert!(set(&["owner"], json!("@t/nobody")).is_err());
    set(&["admin"], Value::Null).unwrap();
    let out = core.call_as(&who(&["member"]), "editor.elements", json!({}), None).unwrap().output;
    assert_eq!(out["kinds"].as_array().unwrap().iter().find(|k| k["kind"] == "@t/mermaid/diagram").unwrap()["default"], Value::Null);
}

fn kinds() -> BTreeMap<String, Value> {
    BTreeMap::from([("@t/mermaid/diagram".to_string(), decl("@t/mermaid/diagram", json!({"schema": {"type": "object", "properties": {"theme": {"enum": ["default", "dark"]}}, "additionalProperties": false}})))])
}
fn body(attrs: Value) -> Value {
    json!({"type": "doc", "content": [{"type": "paragraph"}, {"type": "element", "attrs": attrs}]})
}

#[test]
fn check_elements_accepts_unknown_kind() {
    check_elements(&body(json!({"kind": "@x/y/z", "plugin": "@x/y", "data": {"anything": [1, 2]}})), &kinds()).unwrap();
}

#[test]
fn check_elements_refuses_bad_data() {
    check_elements(&body(json!({"kind": "@t/mermaid/diagram", "plugin": "@t/mermaid", "data": {"theme": "dark", "x:@other/p": {"kept": true}}})), &kinds()).unwrap();
    let e = check_elements(&body(json!({"kind": "@t/mermaid/diagram", "plugin": "@t/mermaid", "data": {"theme": "neon"}})), &kinds()).unwrap_err();
    assert_eq!(e.category, Category::Invalid);
}

#[test]
fn check_elements_refuses_kind_plugin_mismatch() {
    assert!(check_elements(&body(json!({"kind": "@t/mermaid/diagram", "plugin": "@evil/p", "data": {}})), &kinds()).is_err());
    assert!(check_elements(&body(json!({"kind": "not a kind", "plugin": "", "data": {}})), &kinds()).is_err());
}

#[test]
fn reimplementation_satisfies_element_plugins() {
    // another editor that defines the same point at a version the element plugins accept
    struct Other;
    impl Plugin for Other {
        fn manifest(&self) -> Manifest {
            serde_json::from_value(json!({"id": "@t/editor", "version": "1.0.0", "namespaces": ["editor"],
                "defines": {"extension_points": {"editor.element": {"policy": "many", "browser": true, "version": "1.2.0", "input": {}}}}})).unwrap()
        }
    }
    let el = || Arc::new(element_plugin("@t/mermaid", json!([decl("@t/mermaid/diagram", json!({}))])));
    start(vec![Arc::new(Other), el()], &["@t/editor", "@t/mermaid"]);
    start(vec![Arc::new(Editor), el()], &["@nuah/editor", "@t/mermaid"]);
}

#[test]
fn plugins_with_a_module_and_no_kinds_are_listed_too() {
    let core = start(vec![Arc::new(Editor), Arc::new(element_plugin("@t/talk", json!([])))], &["@nuah/editor", "@t/talk"]);
    let out = core.call_as(&who(&["member"]), "editor.elements", json!({}), None).unwrap().output;
    assert_eq!(out["kinds"], json!([]));
    assert_eq!(out["modules"][0]["plugin"], "@t/talk");
    assert!(out["modules"][0]["module"].as_str().unwrap().starts_with("/plugins/t/talk/index.js?v="));
}
