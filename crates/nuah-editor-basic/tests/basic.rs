// SPDX-License-Identifier: Apache-2.0
use nuah_adapters::*;
use nuah_editor::Editor;
use nuah_editor_basic::EditorBasic;
use nuah_kernel::*;
use serde_json::json;
use std::sync::Arc;

#[test]
fn basic_kinds_listed_by_editor() {
    let list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyRoles), Arc::new(StdClock), Arc::new(StdIds), Arc::new(Editor), Arc::new(EditorBasic)];
    let enabled = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-roles", "@nuah/clock-system", "@nuah/ids-random", "@nuah/editor", "@nuah/editor-basic"].map(String::from).to_vec();
    let core = Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile: Profile { name: "t".into(), enabled, ..Default::default() } }).unwrap_or_else(|p| panic!("{p:#?}"));
    let out = core.call_as(&Identity::new("p", "p", &["member"]), "editor.elements", json!({}), None).unwrap().output;
    let kinds: Vec<&str> = out["kinds"].as_array().unwrap().iter().map(|k| k["kind"].as_str().unwrap()).collect();
    for k in ["@nuah/editor-basic/paragraph", "@nuah/editor-basic/heading", "@nuah/editor-basic/callout", "@nuah/editor-basic/hard-break"] {
        assert!(kinds.contains(&k), "{k} in {kinds:?}");
    }
    assert!(out["kinds"][0]["module"].as_str().unwrap().starts_with("/plugins/nuah/editor-basic/index.js?v="));
    let (bytes, _) = core.browser_file("@nuah/editor-basic", "index.js").unwrap();
    assert!(bytes.len() > 1000);
}

#[test]
fn it_is_a_data_plugin_the_owner_may_switch() {
    let m = EditorBasic.manifest();
    assert_eq!(m.runtime, Runtime::Data);
    assert_eq!(m.class().class, PluginClass::Feature, "{:?}", m.class().reasons);
}
