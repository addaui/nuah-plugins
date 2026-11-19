// SPDX-License-Identifier: Apache-2.0
use nuah_adapters::*;
use nuah_editor::Editor;
use nuah_kernel::*;
use nuah_python::Python;
use serde_json::json;
use std::sync::Arc;

#[test]
fn the_editor_lists_python_as_a_runner() {
    let m = Python.manifest();
    assert_eq!(m.connect, vec!["https://cdn.jsdelivr.net".to_string()]);
    assert_eq!(m.class().class, PluginClass::Feature, "{:?}", m.class().reasons);
    let list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyRoles), Arc::new(StdClock), Arc::new(StdIds), Arc::new(Editor), Arc::new(Python)];
    let enabled = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-roles", "@nuah/clock-system", "@nuah/ids-random", "@nuah/editor", "@nuah/python"].map(String::from).to_vec();
    let core = Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile: Profile { name: "t".into(), enabled, ..Default::default() } }).unwrap_or_else(|p| panic!("{p:#?}"));
    let out = core.call_as(&Identity::new("p", "p", &["member"]), "editor.elements", json!({}), None).unwrap().output;
    assert_eq!(out["runners"][0]["plugin"], "@nuah/python");
    assert_eq!(out["runners"][0]["languages"], json!(["python"]));
    assert!(core.browser_file("@nuah/python", "pyodide.asm.wasm").is_some());
    assert!(core.browser_file("@nuah/python", "worker.js").is_some());
    assert!(core.connect_origins().contains(&"https://cdn.jsdelivr.net".to_string()));
}
